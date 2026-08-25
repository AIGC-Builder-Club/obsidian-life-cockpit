// 番茄计时状态机。纯函数：给定 (config, state, action) 得到新 state 和事件列表。
// 时间一律由调用方以 wall clock 毫秒传进来，方便测试里直接喂假时间。

import type { ModeSetting } from "./settings";

export type SegmentKind = "work" | "break" | "long-break";
export type TimerStatus = "idle" | "running" | "paused";

export interface TimerState {
  status: TimerStatus;
  kind: SegmentKind;
  /** 今日第几个番茄（只在 work 段递增，1 起）。idle 时是已经跑到的序号。 */
  pomodoroIndex: number;
  plannedMs: number;
  /** 已累计运行毫秒，不含暂停的时间 */
  accumulatedMs: number;
  /** 本次「跑起来」的起点；暂停或 idle 时为 null */
  legStartedAt: number | null;
  /** 本段第一次真正开始跑的时刻；还没跑过为 null */
  segmentStartedAt: number | null;
  task: string;
}

export interface TimerConfig {
  workMs: number;
  breakMs: number;
  longBreakMs: number;
  pomodorosPerLongBreak: number;
  /** 间歇节奏：单数番茄跑基准时长，双数番茄按 `alternateRatio` 缩短。见 `cycleRatio` */
  alternateEnabled: boolean;
  /** 双数番茄的倍数。原话是「一半」，所以默认 0.5 */
  alternateRatio: number;
}

/** 间歇节奏的两个参数。settings 那边拼好了递进来，timer 不认识 LifeCockpitSettings。 */
export interface AlternateOption {
  enabled: boolean;
  ratio: number;
}

export interface CompletedSegment {
  kind: SegmentKind;
  pomodoroIndex: number;
  startedAt: number;
  endedAt: number;
  plannedMs: number;
  actualMs: number;
  /** 跑满计划时长才算完成；手动结束算未完成 */
  completed: boolean;
  task: string;
}

export type TimerEvent =
  | { type: "segment-started"; kind: SegmentKind; pomodoroIndex: number; plannedMs: number }
  | { type: "segment-completed"; segment: CompletedSegment }
  | { type: "stopped" };

/**
 * 能对这台表做的事。**「跳过本段」不在里面**（AME-239）：
 *
 *   「【跳过本段】————这个，完全是【不明所以】…………这和我们的强制性干预的原则，
 *    是完全违反的。」
 *
 * 一个允许跳过的强制干预不是强制干预，是一颗写着「我不想被打断」的按钮。
 * 整层拿掉——包括状态机里这个动作本身，不只是界面上那颗按钮：留着它，下一个人
 * 迟早会把它再接回某个界面上去。
 *
 * `stop`（结束本段）与 `close-day`（今天收工）是**两件事**，分开的理由见 `reduce`
 * 里 `stop` 那一段（AME-258 第 18 条）。
 *
 * `pause` / `resume` 留着，但**不再有任何人类入口**：它们是复工强提醒页拦人时
 * 停表、以及一段跑完之后等人手动开工用的内部动作。
 */
export type TimerAction =
  | { type: "start"; at: number; task?: string }
  | { type: "pause"; at: number }
  | { type: "resume"; at: number }
  | { type: "stop"; at: number }
  | { type: "close-day"; at: number }
  | { type: "tick"; at: number }
  | { type: "set-task"; task: string };

const MINUTE_MS = 60_000;

export function createInitialState(): TimerState {
  return {
    status: "idle",
    kind: "work",
    pomodoroIndex: 0,
    plannedMs: 0,
    accumulatedMs: 0,
    legStartedAt: null,
    segmentStartedAt: null,
    task: "",
  };
}

export function configFromMode(mode: ModeSetting, alternate?: AlternateOption): TimerConfig {
  return {
    workMs: Math.round(mode.workMinutes * MINUTE_MS),
    breakMs: Math.round(mode.breakMinutes * MINUTE_MS),
    longBreakMs: Math.round(mode.longBreakMinutes * MINUTE_MS),
    pomodorosPerLongBreak: Math.max(1, Math.round(mode.pomodorosPerLongBreak)),
    alternateEnabled: alternate?.enabled ?? false,
    // 0 或负数会造出一段长度为 0 的番茄，那是一颗立刻自己跑完的定时炸弹。
    alternateRatio: clampRatio(alternate?.ratio),
  };
}

/**
 * 这一轮该按几折算。**间歇节奏**（AME-244）：
 *
 *   「番茄时钟————可以 间歇性的节奏、间歇间隔。比如 思考优先模式——第一次 45 分钟。
 *    第二次一半的分钟数。第三次、第四次，等等。（此处，为了简化 和长休息的轮数无关，
 *    就是每天 第一次 45 分钟，之后第二次减半，第三次又是 45 分钟 这种）」
 *
 * 所以口径就是**单双数**：第 1、3、5 个跑基准时长，第 2、4、6 个减半。
 * 原话点名「和长休息的轮数无关」，所以它不看 `pomodorosPerLongBreak`，
 * 长休息本身也不参与缩放（见 `plannedMsFor`）——那一段是给身体的，不是给节奏的。
 */
export function cycleRatio(config: TimerConfig, pomodoroIndex: number): number {
  if (!config.alternateEnabled) return 1;
  return pomodoroIndex > 0 && pomodoroIndex % 2 === 0 ? config.alternateRatio : 1;
}

/**
 * 这一段计划跑多久。工作段和它后面那一小段休息一起缩放——原话要的是
 * 「自动切换 **节奏和间歇**」，缩了工作却不缩休息，等于把节奏换成了另一种。
 */
export function plannedMsFor(
  config: TimerConfig,
  kind: SegmentKind,
  pomodoroIndex: number,
): number {
  if (kind === "long-break") return config.longBreakMs;
  const base = kind === "work" ? config.workMs : config.breakMs;
  return Math.round(base * cycleRatio(config, pomodoroIndex));
}

/** 设置页和面板共用的一句话：这一档节奏接下来会怎么跑。 */
export function describeAlternatePlan(mode: ModeSetting, alternate: AlternateOption): string {
  const base = `${trimNumber(mode.workMinutes)} + ${trimNumber(mode.breakMinutes)} 分钟`;
  if (!alternate.enabled) {
    return `每个番茄都是 ${base}，每 ${mode.pomodorosPerLongBreak} 个之后长休息 ${trimNumber(mode.longBreakMinutes)} 分钟。`;
  }
  const ratio = clampRatio(alternate.ratio);
  const short = `${trimNumber(mode.workMinutes * ratio)} + ${trimNumber(mode.breakMinutes * ratio)} 分钟`;
  return (
    `单数番茄 ${base}，双数番茄 ${short}（${Math.round(ratio * 100)}%）；` +
    `长休息 ${trimNumber(mode.longBreakMinutes)} 分钟不缩，和轮数无关。`
  );
}

/** 12.5 要显示成 12.5，25.0 要显示成 25——设置页上那一行是给人读的。 */
function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function clampRatio(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0.1, value));
}

export function elapsedMs(state: TimerState, now: number): number {
  const running = state.status === "running" && state.legStartedAt !== null;
  const leg = running ? Math.max(0, now - (state.legStartedAt as number)) : 0;
  return state.accumulatedMs + leg;
}

export function remainingMs(state: TimerState, now: number): number {
  if (state.status === "idle") return 0;
  return Math.max(0, state.plannedMs - elapsedMs(state, now));
}

/** 0..1，供进度环 / 进度条用 */
export function progress(state: TimerState, now: number): number {
  if (state.status === "idle" || state.plannedMs <= 0) return 0;
  return Math.min(1, elapsedMs(state, now) / state.plannedMs);
}

export function isBreak(kind: SegmentKind): boolean {
  return kind === "break" || kind === "long-break";
}

export function reduce(
  config: TimerConfig,
  state: TimerState,
  action: TimerAction,
): { state: TimerState; events: TimerEvent[] } {
  switch (action.type) {
    case "set-task":
      return { state: { ...state, task: action.task }, events: [] };

    case "start": {
      if (state.status !== "idle") return { state, events: [] };
      const index = state.pomodoroIndex + 1;
      const next: TimerState = {
        status: "running",
        kind: "work",
        pomodoroIndex: index,
        plannedMs: plannedMsFor(config, "work", index),
        accumulatedMs: 0,
        legStartedAt: action.at,
        segmentStartedAt: action.at,
        task: action.task ?? state.task,
      };
      return { state: next, events: [started(next)] };
    }

    case "pause": {
      if (state.status !== "running") return { state, events: [] };
      return {
        state: {
          ...state,
          status: "paused",
          accumulatedMs: elapsedMs(state, action.at),
          legStartedAt: null,
        },
        events: [],
      };
    }

    case "resume": {
      if (state.status !== "paused") return { state, events: [] };
      return {
        state: {
          ...state,
          status: "running",
          legStartedAt: action.at,
          segmentStartedAt: state.segmentStartedAt ?? action.at,
        },
        events: [],
      };
    }

    case "tick": {
      if (state.status !== "running") return { state, events: [] };
      if (elapsedMs(state, action.at) < state.plannedMs) return { state, events: [] };
      return advance(config, state, action.at);
    }

    // **结束本段 ≠ 今天不干了**（AME-258 第 18 条）：
    //
    //   「我发现，在【手动结束一个番茄】之后，不会有后续的【提醒、介入】什么之类的
    //    ————ta 就那么一直停在那儿了？这个不符合我的预期，我的预期是【不管是自然完成
    //    还是结束；强干扰和提示 仍然会照规则存在的。】」
    //
    // 0.9.0 以前 `stop` 直接把表推回 idle，于是 main.ts 那边一路收摊：待命清掉、
    // 强提醒页作废、干扰归零——**一颗按钮就把整套强约束关掉了**，而它长得只像
    // 「这个番茄我提前结束」。
    //
    // 所以 `stop` 改成走和跑满一样的那条路（`advance`）：工作段结束就进休息，
    // 休息段结束就停在工作段等人开工，后面的锁屏、连击、催促照旧。区别只在
    // 账上——`snapshot` 按实际跑了多久算 `completed`，提前结束照实记成未完成。
    //
    // 真要「今天到此为止」的，走 `close-day`：那是一个**得专门说出口**的决定，
    // 不是一颗顺手按的按钮。
    case "stop": {
      if (state.status === "idle") return { state, events: [] };
      // 一秒都没跑过的段没有「结束」可言（休息刚完、工作段停着等人的那一刻就是这种）。
      // 放行的话就等于把「跳过本段」从后门放回来了：按一下 `结束`，
      // 这个番茄没跑就换来一段休息。**不动，让待命和催促接着走。**
      if (state.segmentStartedAt === null) return { state, events: [] };
      return advance(config, state, action.at);
    }

    case "close-day": {
      if (state.status === "idle") return { state, events: [] };
      const segment = snapshot(state, action.at);
      const next = createInitialState();
      next.pomodoroIndex = state.pomodoroIndex;
      next.task = state.task;
      return {
        state: next,
        events: [{ type: "segment-completed", segment }, { type: "stopped" }],
      };
    }

    default:
      return { state, events: [] };
  }
}

/** 换一天：番茄序号归零，不影响正在跑的段。 */
export function resetDayCounter(state: TimerState): TimerState {
  return { ...state, pomodoroIndex: state.status === "idle" ? 0 : 1 };
}

function advance(
  config: TimerConfig,
  state: TimerState,
  at: number,
): { state: TimerState; events: TimerEvent[] } {
  const segment = snapshot(state, at);
  const nextKind = nextKindAfter(config, state.kind, state.pomodoroIndex);
  const nextIndex = isBreak(state.kind) ? state.pomodoroIndex + 1 : state.pomodoroIndex;
  // 休息跟着**它前面那个番茄**的序号缩放：第 2 个番茄减半，它后面那段休息也减半。
  // （序号在休息跑完时才 +1，所以这里的 nextIndex 正是那个番茄的序号。）
  const planned = plannedMsFor(config, nextKind, nextIndex);

  // **休息自跑，开工永远等人。** 这一行是 AME-239 的核心判决：
  //
  //   「【开工】永远是 人类手动的行为（【自动开工】永远是无法被接受的！）」
  //
  // 以前这一侧看 `autoStartNext`，而它默认是开的——于是休息一结束，工作段就自己
  // 跑起来了：人还在厨房，表已经在替他计专注时间，账当场就假了。那个开关整个删掉，
  // 不是改默认值：默认值改了也救不回已经把 `true` 存进 data.json 的那台机器。
  //
  // 休息这一侧反过来：休息的钟在工作结束那一刻就已经开始走了，等人点一下才走的
  // 休息不是休息，是一块停在 05:00 不动的表（AME-231）。
  const autoStart = isBreak(nextKind);

  const next: TimerState = {
    status: autoStart ? "running" : "paused",
    kind: nextKind,
    pomodoroIndex: nextIndex,
    plannedMs: planned,
    accumulatedMs: 0,
    legStartedAt: autoStart ? at : null,
    segmentStartedAt: autoStart ? at : null,
    task: state.task,
  };

  return {
    state: next,
    events: [{ type: "segment-completed", segment }, started(next)],
  };
}

function nextKindAfter(
  config: TimerConfig,
  kind: SegmentKind,
  pomodoroIndex: number,
): SegmentKind {
  if (isBreak(kind)) return "work";
  const per = Math.max(1, config.pomodorosPerLongBreak);
  return pomodoroIndex > 0 && pomodoroIndex % per === 0 ? "long-break" : "break";
}

function snapshot(state: TimerState, at: number): CompletedSegment {
  const elapsed = elapsedMs(state, at);
  return {
    kind: state.kind,
    pomodoroIndex: state.pomodoroIndex,
    startedAt: state.segmentStartedAt ?? at,
    endedAt: at,
    plannedMs: state.plannedMs,
    // tick 触发时 elapsed 可能因为休眠/掉帧远超计划；记账只记计划内的部分。
    actualMs: Math.min(elapsed, state.plannedMs),
    completed: elapsed >= state.plannedMs,
    task: state.task,
  };
}

function started(state: TimerState): TimerEvent {
  return {
    type: "segment-started",
    kind: state.kind,
    pomodoroIndex: state.pomodoroIndex,
    plannedMs: state.plannedMs,
  };
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export const SEGMENT_LABELS: Record<SegmentKind, string> = {
  work: "工作",
  break: "休息",
  "long-break": "长休息",
};
