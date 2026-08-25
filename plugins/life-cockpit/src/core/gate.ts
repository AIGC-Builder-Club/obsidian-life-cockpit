// 复工前的强提醒页。语音转录原话：
//
//   「你可能每次恢复工作之前，它可能有一个提示让你去什么页面去每天去看，做一个强提醒」
//
// 「强」体现在两件事上，缺一件就退化成又一条弹窗：
//   1. **拦在工作段前面**——遮罩起来的时候番茄是暂停的，过了闸才继续走。
//      不暂停的话，人盯着这一页发呆的三分钟会被记成专注时间，账立刻就假了；
//   2. **有最短停留时间**——按钮在停留时间到之前是灰的。秒过等于没看。
//
// 「强」不体现在**不许退出**上。锁死的界面第二天就会被关掉整个插件，
// 所以留了「这次先跳过」（可在设置里禁掉）——推不动人的推送等于噪音，推太多会被整个关掉。
// 注意那颗按钮**只跳过这一次**：见 `skipGate`，它一天的账都不记。
//
// 遮罩本身复用 R1 的禅定遮罩，不另起一套：同一块屏幕上不该有两套盖法。

import type { BreakPageSetting } from "./settings";

/** 每次复工都拦，还是一天只拦第一次。 */
export type GateFrequency = "every-resume" | "daily";

export const GATE_FREQUENCIES: GateFrequency[] = ["every-resume", "daily"];

export const GATE_FREQUENCY_LABELS: Record<GateFrequency, string> = {
  "every-resume": "每次复工",
  daily: "每天第一次复工",
};

export function isGateFrequency(value: unknown): value is GateFrequency {
  return typeof value === "string" && GATE_FREQUENCIES.includes(value as GateFrequency);
}

export interface GateSettings {
  gateEnabled: boolean;
  gateFrequency: GateFrequency;
  /** 最短停留秒数，按钮在这之前是灰的 */
  gateDwellSeconds: number;
  /** 允许「跳过」。关掉之后只能等停留时间到 */
  gateAllowSkip: boolean;
  /** 从 idle 重新开始时，离上一次收工超过这么久才拦 */
  gateIdleMinutes: number;
  /**
   * 停留倒计时只在**人真的看着这一页**的时候走。见 `advanceGateDwell`。
   * 关掉就退回 0.6.x 的墙钟计时——那正是 AME-238 报的那条 bug。
   */
  gateRequireAttention: boolean;
}

/** 为什么拦这一次。写进遮罩副标题——被拦的人有权知道原因。 */
export type GateReason = "after-break" | "after-idle";

export const GATE_REASON_LABELS: Record<GateReason, string> = {
  "after-break": "休息结束，复工前先过这一页",
  "after-idle": "离开了一段时间，复工前先过这一页",
};

export interface GateState {
  /** 正开着的那一次；null = 没拦着 */
  open: OpenGate | null;
  /** 已经拦过的账本日，`daily` 频率下靠它判 */
  passedDay: string | null;
}

export interface OpenGate {
  reason: GateReason;
  /** 拦的是哪一段。同一段不重复拦 */
  segmentKey: string;
  /**
   * 停留倒计时的起点。**它会往后飘**——人不在看的每一毫秒都加到它头上，
   * 于是「还差多久能过闸」始终等于 `openedAt + 停留时长 - now`，
   * 而中间那些没人看的时间等于没发生过。见 `advanceGateDwell`。
   */
  openedAt: number;
  /** 上一次采样的时刻，两次采样之间的那一段算不算数由 `present` 决定 */
  lastSampleAt: number;
  /** 累计有人看着的毫秒数。只给面板显示用，判定走 openedAt */
  attendedMs: number;
  /** 过闸之后要不要把番茄接着跑起来 */
  resumeAfter: boolean;
}

export function createGateState(): GateState {
  return { open: null, passedDay: null };
}

export interface GateTriggerInput {
  settings: GateSettings;
  state: GateState;
  reason: GateReason;
  segmentKey: string;
  day: string;
  now: number;
  /** 距上一次收工的毫秒数；after-break 用不上，传 0 即可 */
  idleMs: number;
}

/**
 * 这一次该不该拦。**只回答该不该，不改状态**——改状态的是 `openGate`，
 * 分开是为了让「拦不拦」这件事能被单独测，也能被面板拿去做预告。
 */
export function shouldOpenGate(input: GateTriggerInput): boolean {
  const { settings, state } = input;
  if (!settings.gateEnabled) return false;
  // 已经拦着一次了就别叠第二层。
  if (state.open) return false;
  if (settings.gateFrequency === "daily" && state.passedDay === input.day) return false;
  if (input.reason === "after-idle") {
    const threshold = Math.max(0, settings.gateIdleMinutes) * 60_000;
    if (input.idleMs < threshold) return false;
  }
  return true;
}

export function openGate(
  state: GateState,
  gate: { reason: GateReason; segmentKey: string; now: number; resumeAfter: boolean },
): GateState {
  return {
    ...state,
    open: {
      reason: gate.reason,
      segmentKey: gate.segmentKey,
      openedAt: gate.now,
      lastSampleAt: gate.now,
      attendedMs: 0,
      resumeAfter: gate.resumeAfter,
    },
  };
}

/**
 * 让停留倒计时走一拍——**只在人真的看着这一页的时候走**。
 *
 * AME-238 报的就是这里：0.6.x 的倒计时认的是墙上的钟，人去做家务、睡了两个多小时，
 * 回来时这一页已经自己变成「看完了，开工」了。**「最短停留时间」量的必须是
 * 人看了多久，不是这一页开着多久**——否则「强提醒」退化成一块会自己走完的表。
 *
 * 实现上不另记一个 `attendedMs` 去判定，而是**把 `openedAt` 往后推**：
 * 人不在的那一段时间，从计时的角度等于没发生。这样 `gateRemainingMs` 那条
 * 「openedAt + 停留时长 - now」的算式一个字都不用改，面板、按钮、进度条全都跟着对。
 *
 * `maxStepMs` 兜的是**掉拍**：Obsidian 切到后台之后 Chromium 会把定时器压到
 * 每分钟一次，合盖休眠更是能一跳几小时。人不在时跳多少都无所谓（本来就要往后推），
 * 但人在时不该因为一次掉拍就白送几分钟停留，所以按最大步长截断。
 */
export function advanceGateDwell(
  state: GateState,
  input: {
    now: number;
    present: boolean;
    requireAttention: boolean;
    /** 停留时长。够了就冻住，不再往后推——看完了就是看完了 */
    dwellMs: number;
    maxStepMs?: number;
  },
): GateState {
  const open = state.open;
  if (!open) return state;

  const elapsed = Math.max(0, input.now - open.lastSampleAt);
  if (elapsed === 0) return state;

  // 已经看够了：这一页就此定格在「可以开工」，人中途离开也不倒扣。
  // 不冻的话，看完了走开一分钟再回来，按钮又变灰——那读起来只会像个 bug。
  // 判据取的是**上一次采样**那一刻：这一拍还没记账，用 now 判会把「刚跳过来的
  // 一大段空白」误读成「看够了」。
  if (open.lastSampleAt - open.openedAt >= Math.max(0, input.dwellMs)) {
    return { ...state, open: { ...open, lastSampleAt: input.now } };
  }

  // 不要求「人在看」时退回墙钟：这一拍全算数。
  const present = input.requireAttention ? input.present : true;
  const maxStep = Math.max(1000, input.maxStepMs ?? 5000);
  const credited = present ? Math.min(elapsed, maxStep) : 0;

  return {
    ...state,
    open: {
      ...open,
      // 没算数的那一段（人不在，或者掉拍超过最大步长）原样加到起点上，
      // 于是「还差多久」永远等于「停留时长 − 已经看进去的时间」。
      openedAt: open.openedAt + (elapsed - credited),
      lastSampleAt: input.now,
      attendedMs: open.attendedMs + credited,
    },
  };
}

/** 还差多少毫秒才能过闸。已经够了返回 0，没拦着也返回 0。 */
export function gateRemainingMs(state: GateState, settings: GateSettings, now: number): number {
  if (!state.open) return 0;
  const dwellMs = Math.max(0, settings.gateDwellSeconds) * 1000;
  return Math.max(0, state.open.openedAt + dwellMs - now);
}

export function canPassGate(state: GateState, settings: GateSettings, now: number): boolean {
  if (!state.open) return false;
  return gateRemainingMs(state, settings, now) === 0;
}

/**
 * 过闸——**看完了**那一种。停留时间等够了才走得到这里，所以今天这一份算看过了：
 * `daily` 频率下今天不再拦。
 */
export function passGate(state: GateState, day: string): GateState {
  return { open: null, passedDay: day };
}

/**
 * 跳过——**没看**那一种（AME-273 第 1 条）。
 *
 * 这颗按钮从前叫「今天先跳过」，做的却是 `passGate`：`every-resume`（默认那一档）
 * 下它连一天都管不住——下一段休息完照样拦；`daily` 下它反倒把一整天都豁免了，
 * 而**「今天一整天都跳过」这种事根本没人要**。一颗按钮，两档设置，两种都不是它写的意思。
 *
 * 所以拆开：跳过只收这一次的遮罩，**今天的账一笔不记**。
 * 于是两档设置下它是同一句话——「这次先跳过，下一次照拦」：
 *
 * - `every-resume`：本来就每段都拦，跳过一次不影响下一段；
 * - `daily`：今天那一份还欠着，下一段接着拦，直到人真的把它看完。
 *   想整天不被拦，路是设置里那个开关，不是这颗按钮——**豁免要显式，不能是跳过的副作用**。
 */
export function skipGate(state: GateState): GateState {
  // 和 `abandonGate` 落点相同，是因为「没看」这件事在状态上就是同一件事。
  // 分两个名字是因为来意不同：一个是人按的，一个是插件卸载时收摊的。
  return abandonGate(state);
}

/** 遮罩被强行关掉（比如插件卸载）：只收遮罩，不算过闸，下一次照拦。 */
export function abandonGate(state: GateState): GateState {
  return { ...state, open: null };
}

/**
 * 今天该看哪一页。**按天轮换而不是随机**：同一天里反复被拦看到的是同一页，
 * 换一天才换一页。随机的话「每天去看」这句话就落不成——今天看没看过都说不清。
 */
export function pickGatePage(pages: BreakPageSetting[], day: string): BreakPageSetting | null {
  const usable = pages.filter((page) => page.notePath.trim() !== "");
  const pool = usable.length ? usable : pages;
  if (!pool.length) return null;
  return pool[dayIndex(day, pool.length)];
}

/** `YYYY-MM-DD` → 稳定的下标。用天数而不是哈希，保证换一天一定换一页。 */
export function dayIndex(day: string, length: number): number {
  if (length <= 0) return 0;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!match) return 0;
  const days = Math.floor(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000,
  );
  return ((days % length) + length) % length;
}
