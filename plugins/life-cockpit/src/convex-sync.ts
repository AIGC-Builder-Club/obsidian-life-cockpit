// 和 Convex 说话的那一层。**整个插件只有这个文件 import "convex/browser"。**
//
// 这条边界和 `src/desktop.ts`（唯一碰 `window.require` 的文件）是同一条规矩：
// 队列语义、退避、幂等全在 `core/outbox.ts` 里是纯的、被 `node --test` 钉住的；
// 这里只负责把它接到网络上。
//
// **它是同步层，不是运行时依赖。** 这个文件整个抛异常，番茄照跑——
// 调用方（main.ts）对它的每一次调用都要能吞掉失败。

import { ConvexClient } from "convex/browser";
import {
  OutboxState,
  OutboxKind,
  emptyOutbox,
  nextBatch,
  ackBatch,
  nackBatch,
  backoffMs,
} from "./core/outbox";

export interface ConvexConfig {
  /** 形如 https://<部署名>.convex.cloud。空 = 这一层整个不启用 */
  url: string;
  /** 设备令牌。**只从设置项或环境变量取**，照抄推动器那一层的两处来源规矩 */
  token: string;
}

export type ConvexPhase = "disabled" | "missing-config" | "connecting" | "ready" | "error";

export interface ConvexStatus {
  phase: ConvexPhase;
  /** 给人看的一句话。缺配置时**把缺的那一项名字写出来** */
  detail: string;
}

/** `jobs:watch` 的最小公共形状。只把状态带到 UI，不把 payload 带出来。 */
export interface ConvexJobSnapshot {
  _id: string;
  kind: string;
  day: string | null;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  progress: string;
  lastError: string | null;
  attempt: number;
  maxAttempts: number;
}

/**
 * 每种活推到哪个 mutation，以及怎么把队列里那一批装成参数。
 *
 * **为什么是 `pack` 而不是一个字段名**：目标树那条是**整树替换**，
 * 队列里它只有一条（载荷本身就是整棵树），直接按批摊平会变成
 * `nodes: [[node, node, ...]]`。更要命的是，如果哪天真按节点拆成多条，
 * 半批推上去等于把不在这一批里的节点全删了——所以这条必须显式写死。
 */
const ROUTES: Record<
  OutboxKind,
  { fn: string; pack: (rows: unknown[]) => Record<string, unknown> }
> = {
  session: { fn: "sessions:pushBatch", pack: (rows) => ({ sessions: rows }) },
  ledger: { fn: "ledger:pushBatch", pack: (rows) => ({ entries: rows }) },
  goals: {
    fn: "goals:replaceTree",
    pack: (rows) => ({ nodes: (rows[0] as { nodes?: unknown[] })?.nodes ?? [] }),
  },
  runtimeEvent: { fn: "runtime:pushBatch", pack: (rows) => ({ events: rows }) },
};

/**
 * 日志。**一个一声不吭的同步层是没法诊断的**——
 * 仓库主人报「状态停在正在连、F12 里什么都没有」，那不是他没找到，
 * 是这一层从头到尾一句话都没说过。
 *
 * 前缀统一，方便在 F12 里按 `life-cockpit:convex` 过滤。
 * **不打印令牌，也不打印载荷正文**，只打印形状和数量。
 */
const TAG = "[life-cockpit:convex]";
function log(...args: unknown[]): void {
  console.log(TAG, ...args);
}
function warn(...args: unknown[]): void {
  console.warn(TAG, ...args);
}

export class ConvexSync {
  private client: ConvexClient | null = null;
  private config: ConvexConfig = { url: "", token: "" };
  private status: ConvexStatus = { phase: "disabled", detail: "没启用。" };
  private nextAttemptAt = 0;
  private subscriptions: Array<() => void> = [];

  getStatus(): ConvexStatus {
    return this.status;
  }

  getClient(): ConvexClient | null {
    return this.client;
  }

  /**
   * 配置变了就重连。**缺配置是一种状态，不是错误**——
   * 面板上把缺的那一项名字写出来，等人去填，别弹报错。
   */
  configure(config: ConvexConfig, enabled: boolean): void {
    this.dispose();
    this.config = config;

    if (!enabled) {
      this.status = { phase: "disabled", detail: "Convex 同步没开。" };
      log("没开，不连。");
      return;
    }
    const missing = [
      config.url ? "" : "服务地址（CONVEX_URL）",
      config.token ? "" : "设备令牌（LIFE_COCKPIT_CONVEX_TOKEN）",
    ].filter(Boolean);
    if (missing.length) {
      this.status = { phase: "missing-config", detail: `还缺：${missing.join("、")}` };
      warn("缺配置：", missing.join("、"));
      return;
    }

    try {
      this.client = new ConvexClient(config.url);
      // **不写「正在连……」**：`new ConvexClient()` 是懒的，没有订阅它根本不会去连，
      // 于是那句话会一直挂在那儿，让人以为卡住了。实话是「配好了，还没握过手」。
      this.status = { phase: "connecting", detail: "配好了，等第一次同步。" };
      log("已配置：", config.url);
    } catch (err) {
      this.status = { phase: "error", detail: `连不上：${String(err).slice(0, 200)}` };
      warn("建客户端就失败了：", err);
    }
  }

  /**
   * 订阅一条 query。返回退订函数。
   *
   * **拿不到 client 时返回一个空的退订函数**，而不是抛——
   * 调用方是 UI，它不该为「同步层没开」写一遍 try/catch。
   */
  subscribe<T>(
    fn: string,
    args: Record<string, unknown>,
    onUpdate: (value: T) => void,
  ): () => void {
    if (!this.client) return () => {};
    try {
      const unsub = this.client.onUpdate(
        fn as never,
        { ...args, token: this.config.token } as never,
        (value: unknown) => {
          this.status = { phase: "ready", detail: "连上了。" };
          onUpdate(value as T);
        },
        (err: unknown) => {
          this.status = { phase: "error", detail: String(err).slice(0, 200) };
          warn(`订阅 ${fn} 出错：`, err);
        },
      );
      this.subscriptions.push(unsub);
      return unsub;
    } catch (err) {
      this.status = { phase: "error", detail: String(err).slice(0, 200) };
      return () => {};
    }
  }

  /** 调一个 mutation。失败照实抛，让调用方决定要不要重试。 */
  async mutate(fn: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) throw new Error("Convex 同步没开或没配好。");
    return await this.client.mutation(
      fn as never,
      { ...args, token: this.config.token } as never,
    );
  }

  /**
   * 请求一次飞书主链刷新。
   *
   * `feishu:requestPull` 这个名字沿用后端的公开 mutation，但它派出的 job
   * 现在跑的是完整的 `refresh_feishu_summary.sh`：拉最新表、推快照、更新【总结】页。
   * `force` 由手动“更新”按钮传 true；点击期间 UI 会禁用按钮，避免重复派活。
   */
  async requestFeishuSummaryRefresh(day: string, force = true): Promise<string> {
    const result = await this.mutate("feishu:requestPull", { day, force });
    if (typeof result !== "string" || result.trim() === "") {
      throw new Error("Convex 没返回飞书刷新 job id。");
    }
    return result;
  }

  /** 订阅一个异步 job；首次回调就是当前状态。 */
  watchJob(jobId: string, onUpdate: (job: ConvexJobSnapshot | null) => void): () => void {
    return this.subscribe<ConvexJobSnapshot | null>("jobs:watch", { jobId }, onUpdate);
  }

  /** 订阅全部活动 job；调用方只挑当前账本日的飞书刷新。用于重启后接回现场。 */
  watchActiveJobs(onUpdate: (jobs: ConvexJobSnapshot[]) => void): () => void {
    return this.subscribe<ConvexJobSnapshot[]>("jobs:active", {}, onUpdate);
  }

  /**
   * 推一轮队列。**返回新的队列状态，自己不持有状态**——
   * 队列住在 `data.json` 里，由 main.ts 负责存，这样重启接得上。
   *
   * 一轮只推一批：一次 tick 把两千条全推上去会卡住 UI 线程，
   * 而这一层的价值恰恰在于「人感觉不到它在跑」。
   */
  async flushOnce(state: OutboxState, now: number): Promise<OutboxState> {
    if (!this.client) return state;
    if (now < this.nextAttemptAt) return state;

    const batch = nextBatch(state);
    if (!batch) return state;

    const route = ROUTES[batch.kind];
    const keys = batch.items.map((i) => i.key);
    const rows = batch.items.map((i) => JSON.parse(i.payload));

    try {
      const result = await this.mutate(route.fn, route.pack(rows));
      this.nextAttemptAt = 0;
      this.status = {
        phase: "ready",
        detail: `连上了。上一批：${batch.kind} × ${rows.length}。`,
      };
      log(`推了 ${batch.kind} × ${rows.length} →`, result);
      return ackBatch(state, keys, now);
    } catch (err) {
      const next = nackBatch(state, keys, String(err));
      this.nextAttemptAt = now + backoffMs(next);
      this.status = { phase: "error", detail: String(err).slice(0, 200) };
      // **推不上去必须喊出来。** 这一层不打断人，但不代表它该沉默——
      // 「悄悄地一直没同步」是最难发现的一种坏法
      warn(`推 ${batch.kind} × ${rows.length} 失败：`, err);
      return next;
    }
  }

  /**
   * 主动握一次手。给设置页那颗【测一次连接】用。
   *
   * **为什么需要它**：客户端是懒的，没有订阅就不会去连，于是
   * 「填完了但不知道通没通」这个状态可以一直持续到第一个番茄跑完。
   * 一颗按钮当场给答案，比让人等半小时强。
   */
  async probe(): Promise<{ ok: boolean; detail: string }> {
    if (!this.client) {
      return { ok: false, detail: this.status.detail };
    }
    try {
      const today = new Date().toISOString().slice(0, 10);
      const snap = (await this.client.query(
        "today:snapshot" as never,
        { token: this.config.token, day: today } as never,
      )) as { focus?: { focusMinutes?: number } } | null;
      this.status = { phase: "ready", detail: "连上了。" };
      const minutes = snap?.focus?.focusMinutes ?? 0;
      log("探活通过，今天专注", minutes, "分钟");
      return { ok: true, detail: `通了。今天专注 ${Math.round(minutes)} 分钟。` };
    } catch (err) {
      const detail = String(err).slice(0, 300);
      this.status = { phase: "error", detail };
      warn("探活失败：", err);
      return { ok: false, detail };
    }
  }

  dispose(): void {
    for (const unsub of this.subscriptions) {
      try {
        unsub();
      } catch {
        // 退订失败不该拦住卸载
      }
    }
    this.subscriptions = [];
    if (this.client) {
      try {
        void this.client.close();
      } catch {
        // 同上
      }
      this.client = null;
    }
  }
}

/** 没配 Convex 时的空状态，给首次加载用。 */
export function initialOutbox(): OutboxState {
  return emptyOutbox();
}
