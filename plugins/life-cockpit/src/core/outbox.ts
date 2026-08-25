// 出站队列。**这是整套 Convex 方案里唯一一条不能破的架构约束的落点。**
//
// 番茄计时器跑在一台 Win10 上，`isDesktopOnly: true`。它**绝不能因为没网就停表**——
// 所以插件的写路径一个字都不改（照旧 `writeIfChanged` 落盘、照旧幂等），
// Convex 挂在旁边收。这个文件就是「旁边」那一层。
//
//   插件写盘（同步、幂等、不看网络）
//      └─→ 同时往 outbox 追加一条待同步项
//                │ 后台 tick
//                ▼
//          upsert 进 Convex（自然键幂等）
//                ├─ 成功 → 出队
//                └─ 失败 → 留着，下次重试，不报错、不打断人
//
// **自然键就是幂等键**：`work-1-1787099476086`、`20260810-1153-82yqdm` 这些 id
// 本来是为了让重复落盘「覆盖而不是追加」，拿到这里正好保证断网三天回来补齐也不会重复。
// 这一条是白捡的，不是设计出来的。
//
// 纯逻辑，不 import "obsidian"、不碰网络——所以整条队列语义能在 `node --test` 里跑真的。

/** 队列里认得的几种活。和后端的表一一对应。 */
export type OutboxKind = "session" | "ledger" | "goals" | "runtimeEvent";

export interface OutboxItem {
  /** 自然键。同一个键在队列里只留最新的一条 */
  key: string;
  kind: OutboxKind;
  /** 已经序列化好的载荷。存字符串是为了让整个队列能直接 JSON 落盘 */
  payload: string;
  /** 入队时刻，用来排序和算年龄 */
  at: number;
  /** 试过几次。只用来退避和给人看，不用来丢弃——**队列里的东西永远不主动丢** */
  attempts: number;
}

export interface OutboxState {
  items: OutboxItem[];
  /** 上一次成功推上去的时刻；0 = 从来没成功过 */
  lastSyncedAt: number;
  /** 上一次失败的原因，给设置页那一行状态用 */
  lastError: string | null;
}

export function emptyOutbox(): OutboxState {
  return { items: [], lastSyncedAt: 0, lastError: null };
}

/**
 * 队列上限。**超了丢最老的，而且要说出来。**
 *
 * 不设上限的话，一台长期离线的机器会把 `data.json` 撑到几十 MB，
 * 而 Obsidian 每次 `saveData` 是整份覆盖——那会变成每 15 秒写一次几十 MB。
 * 2000 条大约是三个月的量（实测一天 4–32 条 session）。
 */
export const MAX_ITEMS = 2000;

/**
 * 入队。**同一个自然键只留最新的一条**——一个番茄跑到一半改了任务名，
 * 队列里不该攒下同一条 session 的五个版本，最后那一版才是真的。
 */
export function enqueue(
  state: OutboxState,
  item: Omit<OutboxItem, "attempts">,
): OutboxState {
  const items = state.items.filter((i) => i.key !== item.key);
  items.push({ ...item, attempts: 0 });

  let dropped = 0;
  while (items.length > MAX_ITEMS) {
    items.shift();
    dropped++;
  }
  return {
    ...state,
    items,
    lastError: dropped
      ? `队列满了，丢掉最老的 ${dropped} 条（离线太久？）`
      : state.lastError,
  };
}

/**
 * 取一批要推的。**按种类分组**，因为后端每种是一个 mutation。
 *
 * 一次最多 200 条，和后端 `pushBatch` 的上限对齐。
 */
export function nextBatch(
  state: OutboxState,
  limit = 200,
): { kind: OutboxKind; items: OutboxItem[] } | null {
  if (state.items.length === 0) return null;
  const kind = state.items[0].kind;
  const items = state.items.filter((i) => i.kind === kind).slice(0, limit);
  return { kind, items };
}

/** 推成功了，把这一批出队。 */
export function ackBatch(
  state: OutboxState,
  keys: string[],
  now: number,
): OutboxState {
  const done = new Set(keys);
  return {
    items: state.items.filter((i) => !done.has(i.key)),
    lastSyncedAt: now,
    lastError: null,
  };
}

/**
 * 推失败了。**留着，加一次尝试，不丢。**
 *
 * 这里故意不做「试了 N 次就丢掉」：队列里的东西是已经发生过的事实，
 * 丢了就再也补不回来了（本地文件那一份还在，但没人会想起来去手工重推）。
 * 推不上去是网络或配置的问题，那两样都会被修好；数据被丢掉不会。
 */
export function nackBatch(
  state: OutboxState,
  keys: string[],
  error: string,
): OutboxState {
  const failed = new Set(keys);
  return {
    ...state,
    items: state.items.map((i) =>
      failed.has(i.key) ? { ...i, attempts: i.attempts + 1 } : i,
    ),
    lastError: error.slice(0, 300),
  };
}

/**
 * 下一次该等多久。按队首那一条试过几次算，1 分钟起步翻倍，封顶 15 分钟。
 *
 * 封顶比后端那条（30 分钟）短，因为这一侧是**人在电脑前**的场景：
 * 人刚把网连上，不该还要再等半小时才看到数据同步。
 */
export function backoffMs(state: OutboxState): number {
  const attempts = state.items[0]?.attempts ?? 0;
  if (attempts === 0) return 0;
  return Math.min(60_000 * Math.pow(2, attempts - 1), 15 * 60_000);
}

/** 给设置页那一行状态用的一句话。**「一切正常」也要说出来**，否则人不知道它在不在跑。 */
export function describe(state: OutboxState, now: number): string {
  if (state.items.length === 0) {
    if (state.lastSyncedAt === 0) return "还没同步过。";
    const mins = Math.round((now - state.lastSyncedAt) / 60_000);
    return mins < 1 ? "刚刚同步过，队列是空的。" : `队列是空的，${mins} 分钟前同步过。`;
  }
  const oldest = Math.min(...state.items.map((i) => i.at));
  const mins = Math.round((now - oldest) / 60_000);
  const tail = state.lastError ? `上次没推上去：${state.lastError}` : "等着推……";
  return `队列里攒着 ${state.items.length} 条（最老的 ${mins} 分钟前），${tail}`;
}

/**
 * 从 `data.json` 读回来的队列。**读不动就当空的，不抛**——
 * 一份读坏的队列不该让整个插件起不来；大不了少推几条，
 * 而本地那份落盘数据始终是完整的（这正是本地优先的意义）。
 */
export function normalizeOutbox(raw: unknown): OutboxState {
  if (!raw || typeof raw !== "object") return emptyOutbox();
  const source = raw as Partial<OutboxState>;
  const items = Array.isArray(source.items) ? source.items : [];
  const clean: OutboxItem[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const i = item as Partial<OutboxItem>;
    if (typeof i.key !== "string" || !i.key) continue;
    if (typeof i.payload !== "string") continue;
    if (i.kind !== "session" && i.kind !== "ledger" && i.kind !== "goals"
      && i.kind !== "runtimeEvent") continue;
    clean.push({
      key: i.key,
      kind: i.kind,
      payload: i.payload,
      at: typeof i.at === "number" && Number.isFinite(i.at) ? i.at : 0,
      attempts: typeof i.attempts === "number" && i.attempts >= 0 ? i.attempts : 0,
    });
  }
  return {
    items: clean.slice(-MAX_ITEMS),
    lastSyncedAt:
      typeof source.lastSyncedAt === "number" && Number.isFinite(source.lastSyncedAt)
        ? source.lastSyncedAt
        : 0,
    lastError: typeof source.lastError === "string" ? source.lastError : null,
  };
}
