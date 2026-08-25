// 积分账本。不是计数器：每一笔都有时间、方向、分值、事由、来源，可回溯、可撤销。
//
// 落盘选 Markdown 而不是 JSON，理由写在 README《为什么账本是 Markdown》一节：
// 番茄流水是机器遥测（秒级、只给插件看），积分账本是给人看的账——人要在 Obsidian 里
// 直接翻、直接搜、必要时直接改。JSON 在 Obsidian 里是一坨纯文本，Markdown 表格是表格。
//
// 两条硬要求和 R1 一样：
//   1. 写盘幂等——同样的账序列化出同样的字节，key 顺序、数字格式、行顺序全部钉死；
//   2. 不静默丢东西——解析不动的行原样搬到《待修复》，手工改坏也不会消失。

import { dayKeyFor } from "./ledger";

export const POINTS_BOOK_SCHEMA_VERSION = 1;
export const TASK_TABLE_SCHEMA_VERSION = 1;

export type PointsDirection = "earn" | "spend";
/** manual = 随手记；pomodoro = 番茄完成自动入账；reversal = 撤销单 */
export type PointsSource = "manual" | "pomodoro" | "reversal";

export interface PointsTask {
  id: string;
  label: string;
  direction: PointsDirection;
  points: number;
  category: string;
  active: boolean;
}

export interface PointsEntry {
  id: string;
  /** 本地墙钟 `YYYY-MM-DDTHH:MM`。账本到分钟就够，不留秒和时区，人读起来才干净。 */
  at: string;
  /** 账本日 `YYYY-MM-DD`，按 dayRolloverHour 归日，凌晨记的一笔算前一天 */
  day: string;
  direction: PointsDirection;
  amount: number;
  reason: string;
  source: PointsSource;
  /**
   * 这一笔挂在哪一项上。两个命名空间共用这一个位（R3 没有另起字段）：
   *   - 裸 id（`pomodoro` / `video`…）= 积分任务表里的预设任务；
   *   - `goal:g-7` = 目标树节点，见 `goalRef` / `goalIdOf`；
   *   - null = 临时任务，当场记的，谁也不挂。
   * 挂了目标的番茄按目标记：R5 复盘要问的是「分都花在哪个目标上」，
   * 计分规则本身照旧写在 reason 里（「完成番茄：完成一个番茄 · 写 PRD」）。
   */
  taskId: string | null;
  /** source=pomodoro 时是番茄段 id；source=reversal 时是被撤销的那一笔 id */
  ref: string | null;
}

export interface PointsBook {
  schemaVersion: number;
  /** 按 at、再按 id 排序 */
  entries: PointsEntry[];
  /** 解析不动的原始行，按月保留，序列化时原样写回 */
  quarantine: Record<string, string[]>;
}

export interface EntryDraft {
  at: Date;
  direction: PointsDirection;
  amount: number;
  reason: string;
  source: PointsSource;
  taskId?: string | null;
  ref?: string | null;
  rolloverHour: number;
}

// ---------------------------------------------------------------------------
// 预设任务表
// ---------------------------------------------------------------------------

/**
 * 默认任务与分值。取自日记模板《今日每日任务》的六维（诚 / 爱 / 当 / 意 / 体）
 * 与早晚流程，不是凭空编的。享乐项对应「而享乐就要消耗积分」那一句。
 */
export const DEFAULT_TASKS: PointsTask[] = [
  { id: "pomodoro", label: "完成一个番茄", direction: "earn", points: 2, category: "诚", active: true },
  { id: "deep-work", label: "深工作 60-120 分钟", direction: "earn", points: 12, category: "诚", active: true },
  { id: "morning-out", label: "早起出门（刷牙·洗澡·早餐·出门）", direction: "earn", points: 8, category: "体", active: true },
  { id: "workout", label: "举一次哑铃（左右手各 20 个）", direction: "earn", points: 6, category: "体", active: true },
  { id: "reading", label: "读完一本（观其大略）", direction: "earn", points: 6, category: "爱", active: true },
  { id: "writing", label: "写 300 字", direction: "earn", points: 8, category: "爱", active: true },
  { id: "presence", label: "10 分钟无输入临在", direction: "earn", points: 5, category: "当", active: true },
  { id: "anti-inertia", label: "5 分钟反惯性行动", direction: "earn", points: 3, category: "意", active: true },
  { id: "review", label: "睡前复盘", direction: "earn", points: 10, category: "诚", active: true },
  { id: "video", label: "刷视频 30 分钟", direction: "spend", points: 12, category: "享乐", active: true },
  { id: "game", label: "打游戏 30 分钟", direction: "spend", points: 15, category: "享乐", active: true },
  { id: "feed", label: "刷信息流 15 分钟", direction: "spend", points: 8, category: "享乐", active: true },
  { id: "snack", label: "零食", direction: "spend", points: 5, category: "享乐", active: true },
  { id: "late-night", label: "熬夜 30 分钟", direction: "spend", points: 20, category: "享乐", active: true },
];

export function defaultTasks(): PointsTask[] {
  return DEFAULT_TASKS.map((task) => ({ ...task }));
}

export function findTask(tasks: PointsTask[], id: string | null): PointsTask | null {
  if (!id) return null;
  return tasks.find((task) => task.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// 指回目标树（R3）
// ---------------------------------------------------------------------------

/** 账本里指向目标树节点的写法：`goal:g-7`。 */
export const GOAL_REF_PREFIX = "goal:";

export function goalRef(goalId: string): string {
  return `${GOAL_REF_PREFIX}${goalId}`;
}

/** taskId 指的是目标树节点就返回节点 id，否则 null（预设任务或临时任务）。 */
export function goalIdOf(taskId: string | null): string | null {
  if (!taskId || !taskId.startsWith(GOAL_REF_PREFIX)) return null;
  return taskId.slice(GOAL_REF_PREFIX.length) || null;
}

export interface GoalPointsSummary {
  earned: number;
  spent: number;
  net: number;
  count: number;
}

/** 某个目标树节点累计吃进 / 花掉多少分。撤销相关的两笔都不计入。 */
export function goalPoints(book: PointsBook, goalId: string): GoalPointsSummary {
  const ref = goalRef(goalId);
  const voided = voidedIds(book);
  let earned = 0;
  let spent = 0;
  let count = 0;
  for (const entry of book.entries) {
    if (entry.taskId !== ref) continue;
    if (entry.source === "reversal" || voided.has(entry.id)) continue;
    if (entry.direction === "earn") earned = round2(earned + entry.amount);
    else spent = round2(spent + entry.amount);
    count += 1;
  }
  return { earned, spent, net: round2(earned - spent), count };
}

const TASK_HEADER = "| ID | 名称 | 方向 | 分值 | 分类 | 启用 |";
const TASK_DIVIDER = "| --- | --- | --- | --- | --- | --- |";

export function serializeTaskTable(tasks: PointsTask[], quarantine: string[] = []): string {
  const lines: string[] = [
    "---",
    `schemaVersion: ${TASK_TABLE_SCHEMA_VERSION}`,
    "---",
    "",
    "# 积分任务表",
    "",
    "完成任务入账、享乐出账。这张表是人生驾驶舱的计分依据，改完保存即刻生效。",
    "",
    "- **ID** 一旦用过就不要改：账本里的每一笔按 ID 指回这里。",
    "- **方向** 只认 `入账` / `出账`；**启用** 只认 `是` / `否`。",
    "- 认不出来的行不会被删，会被搬到文末《待修复》。",
    "",
    TASK_HEADER,
    TASK_DIVIDER,
  ];

  for (const task of sortTasks(tasks)) {
    lines.push(
      row([
        task.id,
        task.label,
        task.direction === "earn" ? "入账" : "出账",
        formatPoints(task.points),
        task.category,
        task.active ? "是" : "否",
      ]),
    );
  }

  lines.push(...quarantineBlock(quarantine));
  return `${lines.join("\n")}\n`;
}

export function parseTaskTable(text: string): { tasks: PointsTask[]; quarantine: string[] } {
  const tasks: PointsTask[] = [];
  const quarantine: string[] = [];
  const seen = new Set<string>();

  for (const line of tableRows(text)) {
    const cells = splitRow(line);
    if (cells.length !== 6) {
      quarantine.push(line);
      continue;
    }
    const [id, label, direction, points, category, active] = cells;
    const amount = parseAmount(points);
    const dir = parseDirection(direction);
    if (!id || !label || dir === null || amount === null || seen.has(id)) {
      quarantine.push(line);
      continue;
    }
    seen.add(id);
    tasks.push({
      id,
      label,
      direction: dir,
      points: amount,
      category,
      active: active !== "否" && active.toLowerCase() !== "false",
    });
  }

  return { tasks, quarantine };
}

/** 入账在前、出账在后，各自按 id。人翻表时两组不会串在一起。 */
function sortTasks(tasks: PointsTask[]): PointsTask[] {
  return [...tasks].sort((a, b) => {
    if (a.direction !== b.direction) return a.direction === "earn" ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// 账本
// ---------------------------------------------------------------------------

export function createBook(): PointsBook {
  return { schemaVersion: POINTS_BOOK_SCHEMA_VERSION, entries: [], quarantine: {} };
}

/** key 顺序钉死，序列化到日档 JSON 时才有稳定字节。 */
export function canonicalEntry(entry: PointsEntry): PointsEntry {
  return {
    id: entry.id,
    at: entry.at,
    day: entry.day,
    direction: entry.direction,
    amount: entry.amount,
    reason: entry.reason,
    source: entry.source,
    taskId: entry.taskId ?? null,
    ref: entry.ref ?? null,
  };
}

export function sortEntries(entries: PointsEntry[]): PointsEntry[] {
  return [...entries].sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** 按 id 覆盖或追加。重放同一笔不会写出第二行。 */
export function addEntry(book: PointsBook, entry: PointsEntry): PointsBook {
  const kept = book.entries.filter((existing) => existing.id !== entry.id);
  kept.push(canonicalEntry(entry));
  return { ...book, entries: sortEntries(kept) };
}

/**
 * 造一笔。id 由内容推导：同样的内容重放得到同样的 id，因此重放不会重复入账；
 * 真的同一分钟记了两笔一模一样的，再加 `-2` 后缀区分，不静默合并。
 */
export function createEntry(book: PointsBook, draft: EntryDraft): PointsEntry {
  const at = formatLocalMinute(draft.at);
  const day = dayKeyFor(draft.at, draft.rolloverHour);
  const amount = normalizeAmount(draft.amount);
  const reason = draft.reason.trim() || "（未填事由）";
  const base: Omit<PointsEntry, "id"> = {
    at,
    day,
    direction: draft.direction,
    amount,
    reason,
    source: draft.source,
    taskId: draft.taskId ?? null,
    ref: draft.ref ?? null,
  };

  const taken = new Set(book.entries.map((entry) => entry.id));
  const stamp = at.replace(/[-:]/g, "").replace("T", "-");
  const digest = hash6(
    [base.direction, base.amount, base.reason, base.source, base.taskId ?? "", base.ref ?? ""].join(" "),
  );
  let id = `${stamp}-${digest}`;
  let suffix = 2;
  while (taken.has(id)) {
    id = `${stamp}-${digest}-${suffix}`;
    suffix += 1;
  }

  return canonicalEntry({ id, ...base });
}

export type ReverseResult =
  | { ok: true; book: PointsBook; entry: PointsEntry }
  | { ok: false; reason: string };

/**
 * 撤销一笔。撤销本身是一笔新的流水（方向相反、source=reversal、ref 指回原笔），
 * 原笔原样留在账上——不做静默删除。
 */
export function reverseEntry(
  book: PointsBook,
  targetId: string,
  options: { at: Date; rolloverHour: number; note?: string },
): ReverseResult {
  const target = book.entries.find((entry) => entry.id === targetId);
  if (!target) return { ok: false, reason: "账上没有这一笔。" };
  if (target.source === "reversal") return { ok: false, reason: "撤销单不能再撤销。" };
  if (voidedIds(book).has(targetId)) return { ok: false, reason: "这一笔已经撤销过了。" };

  const note = options.note?.trim();
  const entry = createEntry(book, {
    at: options.at,
    rolloverHour: options.rolloverHour,
    direction: target.direction === "earn" ? "spend" : "earn",
    amount: target.amount,
    reason: `撤销：${target.reason}${note ? `（${note}）` : ""}`,
    source: "reversal",
    taskId: target.taskId,
    ref: target.id,
  });

  return { ok: true, book: addEntry(book, entry), entry };
}

/** 被撤销掉的原始笔的 id 集合。 */
export function voidedIds(book: PointsBook): Set<string> {
  const ids = new Set<string>();
  for (const entry of book.entries) {
    if (entry.source === "reversal" && entry.ref) ids.add(entry.ref);
  }
  return ids;
}

export function signedAmount(entry: PointsEntry): number {
  return entry.direction === "earn" ? entry.amount : -entry.amount;
}

/** 账上每一笔之后的余额。撤销单照常参与，所以余额会动过去、再动回来。 */
export function runningBalances(entries: PointsEntry[], opening = 0): number[] {
  const balances: number[] = [];
  let balance = opening;
  for (const entry of entries) {
    balance = round2(balance + signedAmount(entry));
    balances.push(balance);
  }
  return balances;
}

export function balanceAfterDay(book: PointsBook, day: string): number {
  let balance = 0;
  for (const entry of book.entries) {
    if (entry.day <= day) balance = round2(balance + signedAmount(entry));
  }
  return balance;
}

export function balanceBeforeDay(book: PointsBook, day: string): number {
  let balance = 0;
  for (const entry of book.entries) {
    if (entry.day < day) balance = round2(balance + signedAmount(entry));
  }
  return balance;
}

export function currentBalance(book: PointsBook): number {
  return round2(book.entries.reduce((sum, entry) => round2(sum + signedAmount(entry)), 0));
}

export function entriesForDay(book: PointsBook, day: string): PointsEntry[] {
  return book.entries.filter((entry) => entry.day === day);
}

/** from / to 是账本日，闭区间；留空表示不设边界。 */
export function entriesInRange(book: PointsBook, from?: string, to?: string): PointsEntry[] {
  return book.entries.filter((entry) => {
    if (from && entry.day < from) return false;
    if (to && entry.day > to) return false;
    return true;
  });
}

export interface TaskBreakdown {
  key: string;
  earned: number;
  spent: number;
  count: number;
}

export interface DaySlice {
  day: string;
  earned: number;
  spent: number;
  net: number;
  closing: number;
}

export interface RangeSummary {
  from: string | null;
  to: string | null;
  opening: number;
  /** 已撤销的原始笔与撤销单本身都不计入，两者相抵为零 */
  earned: number;
  spent: number;
  net: number;
  closing: number;
  count: number;
  voidedCount: number;
  entries: PointsEntry[];
  byTask: TaskBreakdown[];
  byDay: DaySlice[];
}

/**
 * 区间汇总。这是 R5 睡前复盘唯一要吃的入口——它要问的是
 * 「这段时间的分怎么来的、怎么没的、净剩多少、都花在哪了」。
 */
export function summarize(book: PointsBook, from?: string, to?: string): RangeSummary {
  const entries = entriesInRange(book, from, to);
  const voided = voidedIds(book);
  const opening = from ? balanceBeforeDay(book, from) : 0;

  let earned = 0;
  let spent = 0;
  let voidedCount = 0;
  const tasks = new Map<string, TaskBreakdown>();
  const days = new Map<string, DaySlice>();

  for (const entry of entries) {
    const cancelled = entry.source === "reversal" || voided.has(entry.id);
    if (cancelled) {
      voidedCount += 1;
      continue;
    }

    const key = entry.taskId ?? "（临时任务）";
    const task = tasks.get(key) ?? { key, earned: 0, spent: 0, count: 0 };
    const slice = days.get(entry.day) ?? { day: entry.day, earned: 0, spent: 0, net: 0, closing: 0 };

    if (entry.direction === "earn") {
      earned = round2(earned + entry.amount);
      task.earned = round2(task.earned + entry.amount);
      slice.earned = round2(slice.earned + entry.amount);
    } else {
      spent = round2(spent + entry.amount);
      task.spent = round2(task.spent + entry.amount);
      slice.spent = round2(slice.spent + entry.amount);
    }
    task.count += 1;
    tasks.set(key, task);
    days.set(entry.day, slice);
  }

  const byDay = [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  let rolling = opening;
  for (const slice of byDay) {
    slice.net = round2(slice.earned - slice.spent);
    rolling = round2(rolling + slice.net);
    slice.closing = rolling;
  }

  const net = round2(earned - spent);
  return {
    from: from ?? null,
    to: to ?? null,
    opening,
    earned,
    spent,
    net,
    closing: round2(opening + net),
    count: entries.length,
    voidedCount,
    entries,
    byTask: [...tasks.values()].sort((a, b) => {
      const left = a.earned - a.spent;
      const right = b.earned - b.spent;
      if (left !== right) return right - left;
      return a.key < b.key ? -1 : 1;
    }),
    byDay,
  };
}

export type RangePreset = "today" | "week" | "month" | "last30" | "all";

export const RANGE_PRESET_LABELS: Record<RangePreset, string> = {
  today: "今日",
  week: "本周",
  month: "本月",
  last30: "近 30 天",
  all: "全部",
};

/** 区间快捷选项。一律按账本日算，所以凌晨两点看「今日」看到的还是昨天那一摊。 */
export function presetRange(
  preset: RangePreset,
  now: Date,
  rolloverHour: number,
): { from?: string; to?: string } {
  if (preset === "all") return {};
  const today = dayKeyFor(now, rolloverHour);
  if (preset === "today") return { from: today, to: today };
  if (preset === "month") return { from: `${today.slice(0, 7)}-01`, to: today };

  const anchor = dayToDate(today);
  if (preset === "week") {
    // 周一起算：getDay() 里周日是 0，先折算成 6。
    const offset = (anchor.getDay() + 6) % 7;
    anchor.setDate(anchor.getDate() - offset);
  } else {
    anchor.setDate(anchor.getDate() - 29);
  }
  return { from: dateToDay(anchor), to: today };
}

function dayToDate(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date, 12, 0, 0, 0);
}

function dateToDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ---------------------------------------------------------------------------
// 月账文件
// ---------------------------------------------------------------------------

const LEDGER_HEADER = "| 时间 | 账本日 | 方向 | 分值 | 余额 | 事由 | 任务 | 来源 | 关联 | 状态 | ID |";
const LEDGER_DIVIDER = "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";

export function monthOf(day: string): string {
  return day.slice(0, 7);
}

export function monthsIn(book: PointsBook): string[] {
  const months = new Set<string>();
  for (const entry of book.entries) months.add(monthOf(entry.day));
  for (const month of Object.keys(book.quarantine)) months.add(month);
  return [...months].sort();
}

export function entriesForMonth(book: PointsBook, month: string): PointsEntry[] {
  return book.entries.filter((entry) => monthOf(entry.day) === month);
}

export function monthFileName(month: string): string {
  return `${month}.md`;
}

export function serializeMonth(
  month: string,
  entries: PointsEntry[],
  options: { opening: number; generator: string; quarantine?: string[] },
): string {
  const ordered = sortEntries(entries);
  const balances = runningBalances(ordered, options.opening);
  const voided = new Set<string>();
  for (const entry of ordered) {
    if (entry.source === "reversal" && entry.ref) voided.add(entry.ref);
  }

  let earned = 0;
  let spent = 0;
  for (const entry of ordered) {
    if (entry.source === "reversal" || voided.has(entry.id)) continue;
    if (entry.direction === "earn") earned = round2(earned + entry.amount);
    else spent = round2(spent + entry.amount);
  }

  const closing = balances.length ? balances[balances.length - 1] : options.opening;

  const lines: string[] = [
    "---",
    `schemaVersion: ${POINTS_BOOK_SCHEMA_VERSION}`,
    `month: ${month}`,
    `generator: ${options.generator}`,
    `openingBalance: ${formatPoints(options.opening)}`,
    `earned: ${formatPoints(earned)}`,
    `spent: ${formatPoints(spent)}`,
    `closingBalance: ${formatPoints(closing)}`,
    `entryCount: ${ordered.length}`,
    "---",
    "",
    `# 积分账本 ${month}`,
    "",
    "由「人生驾驶舱」维护。可以手工改，但请保持表头列不变；改坏的行不会被丢弃，会搬到文末《待修复》。",
    "余额一列是算出来的，改它没有意义。撤销请用插件，撤销会留下一笔反向流水，原笔照旧留在账上。",
    "",
    "## 流水",
    "",
    LEDGER_HEADER,
    LEDGER_DIVIDER,
  ];

  ordered.forEach((entry, index) => {
    const status = entry.source === "reversal" ? "撤销" : voided.has(entry.id) ? "已撤销" : "有效";
    lines.push(
      row([
        entry.at.replace("T", " "),
        entry.day,
        entry.direction === "earn" ? "+" : "-",
        formatPoints(entry.amount),
        formatPoints(balances[index]),
        entry.reason,
        entry.taskId ?? "-",
        sourceLabel(entry.source),
        entry.ref ?? "-",
        status,
        entry.id,
      ]),
    );
  });

  if (!ordered.length) {
    lines.push("", "本月还没有流水。");
  }

  lines.push(...quarantineBlock(options.quarantine ?? []));
  return `${lines.join("\n")}\n`;
}

export function parseMonth(text: string): { entries: PointsEntry[]; quarantine: string[] } {
  const entries: PointsEntry[] = [];
  const quarantine: string[] = [];
  const seen = new Set<string>();

  for (const line of tableRows(text)) {
    const cells = splitRow(line);
    // 余额与状态是算出来的，读回来直接忽略。
    if (cells.length !== 11) {
      quarantine.push(line);
      continue;
    }
    const [at, day, direction, amount, , reason, taskId, source, ref, , id] = cells;
    const parsedAt = normalizeMinuteText(at);
    const parsedAmount = parseAmount(amount);
    const parsedDirection = parseDirection(direction);
    const parsedSource = parseSource(source);

    if (
      !id ||
      seen.has(id) ||
      parsedAt === null ||
      parsedAmount === null ||
      parsedDirection === null ||
      parsedSource === null ||
      !/^\d{4}-\d{2}-\d{2}$/.test(day)
    ) {
      quarantine.push(line);
      continue;
    }

    seen.add(id);
    entries.push(
      canonicalEntry({
        id,
        at: parsedAt,
        day,
        direction: parsedDirection,
        amount: parsedAmount,
        reason,
        source: parsedSource,
        taskId: blankToNull(taskId),
        ref: blankToNull(ref),
      }),
    );
  }

  return { entries: sortEntries(entries), quarantine };
}

// ---------------------------------------------------------------------------
// 日档镜像（给 R5 用）
// ---------------------------------------------------------------------------

export interface DayPointsMirror {
  schemaVersion: number;
  earned: number;
  spent: number;
  balance: number;
  entries: PointsEntry[];
}

/**
 * 当日积分快照，写进 R1 日档 JSON 的 points 位。
 *
 * 这是**派生数据**，源头永远是月账 Markdown。之所以还要镜像一份：R5 睡前复盘
 * 打开当天一个文件就能同时拿到番茄流水和积分出入账，不用自己去拼两套存储。
 * 每次重算，所以不会和源头长期漂移。
 */
export function dayPointsMirror(book: PointsBook, day: string): DayPointsMirror {
  const entries = entriesForDay(book, day);
  const voided = voidedIds(book);
  let earned = 0;
  let spent = 0;
  for (const entry of entries) {
    if (entry.source === "reversal" || voided.has(entry.id)) continue;
    if (entry.direction === "earn") earned = round2(earned + entry.amount);
    else spent = round2(spent + entry.amount);
  }
  return {
    schemaVersion: POINTS_BOOK_SCHEMA_VERSION,
    earned,
    spent,
    balance: balanceAfterDay(book, day),
    entries: entries.map(canonicalEntry),
  };
}

/** 某个番茄段实际到手的分：被撤销的不算。 */
export function sessionPoints(
  book: PointsBook,
  sessionId: string,
): { points: number | null; rule: string | null } {
  const voided = voidedIds(book);
  const own = book.entries.filter(
    (entry) => entry.source === "pomodoro" && entry.ref === sessionId,
  );
  if (!own.length) return { points: null, rule: null };

  let points = 0;
  let rule: string | null = null;
  for (const entry of own) {
    if (voided.has(entry.id)) continue;
    points = round2(points + signedAmount(entry));
    rule = entry.taskId ?? rule;
  }
  return { points, rule };
}

/** 番茄段是否已经入过账。重复调用不会重复计分。 */
export function hasPomodoroEntry(book: PointsBook, sessionId: string): boolean {
  return book.entries.some((entry) => entry.source === "pomodoro" && entry.ref === sessionId);
}

// ---------------------------------------------------------------------------
// 格式与工具
// ---------------------------------------------------------------------------

export function formatLocalMinute(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** 分值最多两位小数，整数不带小数点——保证同一个数永远打出同一串字符。 */
export function formatPoints(value: number): string {
  return String(round2(value));
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function normalizeAmount(value: number): number {
  const amount = round2(Math.abs(value));
  return amount > 0 ? amount : 0;
}

export function sourceLabel(source: PointsSource): string {
  if (source === "pomodoro") return "番茄";
  if (source === "reversal") return "撤销";
  return "手动";
}

export function directionLabel(direction: PointsDirection): string {
  return direction === "earn" ? "入账" : "出账";
}

function parseSource(text: string): PointsSource | null {
  const value = text.trim();
  if (value === "番茄" || value === "pomodoro") return "pomodoro";
  if (value === "撤销" || value === "reversal") return "reversal";
  if (value === "手动" || value === "manual") return "manual";
  return null;
}

function parseDirection(text: string): PointsDirection | null {
  const value = text.trim();
  if (value === "+" || value === "入账" || value === "earn") return "earn";
  if (value === "-" || value === "出账" || value === "spend") return "spend";
  return null;
}

function parseAmount(text: string): number | null {
  const value = Number(text.trim());
  if (!Number.isFinite(value) || value <= 0) return null;
  return round2(value);
}

/** 接受 `YYYY-MM-DD HH:MM` 与 `YYYY-MM-DDTHH:MM` 两种写法，统一成后者。 */
function normalizeMinuteText(text: string): string | null {
  const value = text.trim().replace(" ", "T");
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? value : null;
}

function blankToNull(text: string): string | null {
  const value = text.trim();
  return value && value !== "-" ? value : null;
}

const QUARANTINE_TITLE = "## 待修复";

function quarantineBlock(lines: string[]): string[] {
  if (!lines.length) return [];
  return [
    "",
    QUARANTINE_TITLE,
    "",
    "下面这些行读不动（多半是手工改的时候列数或格式对不上）。它们不参与计分，也不会被删除，",
    "改好之后把它们挪回上面的表格即可。",
    "",
    ...lines,
  ];
}

/**
 * 表格行：以 `|` 开头，排除表头与分隔行。
 * 《待修复》段落里的行也一起收上来重走解析——人改好了就自动归位，
 * 还是读不动就再落回《待修复》，来回都不会丢。
 */
function tableRows(text: string): string[] {
  const rows: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    if (/^\|[\s|:-]+\|$/.test(line)) continue;
    if (line === TASK_HEADER || line === LEDGER_HEADER) continue;
    rows.push(line);
  }
  return rows;
}

function row(cells: string[]): string {
  return `| ${cells.map(escapeCell).join(" | ")} |`;
}

function escapeCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
}

/** 按未转义的 `|` 切分，两端的空单元格丢掉。 */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const char of line) {
    if (escaped) {
      current += char === "|" || char === "\\" ? char : `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "|") {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  cells.push(current);

  if (cells.length && cells[0].trim() === "") cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === "") cells.pop();
  return cells.map((cell) => cell.trim());
}

/** 内容寻址的短摘要，只用来给同一分钟内的不同流水区分 id。 */
function hash6(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(6, "0").slice(-6);
}
