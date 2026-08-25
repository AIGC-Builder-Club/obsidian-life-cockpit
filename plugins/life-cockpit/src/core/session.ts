// 跨重启的状态延续：番茄跑到一半、挂着的任务与目标，Obsidian 重启之后接得回来。
//
// AME-244 原话：
//
//   「似乎，在 Obsidian 应用，重新启动后，各个【当前选择的番茄下拉任务】、
//    【目标树指定的目标】会丢失？……也能够方便我，不用每次启动 Obsidian 都要去选；
//    而是【能沿用状态】。」
//   「然后，有时候 我一个【番茄时钟】进行到一半，可能 Obsidian 是需要重启的——
//    这种你也要考虑【状态的一个保留和延续】的。因为，我是一个会经常折腾 Obsidian、
//    包括重启 Obsidian 来让各种插件调整和生效的人；所以【Obsidian】重启，
//    是像家常便饭一样的事情。」
//
// 之前这几样都只活在内存里（`src/core/.frac.md` 那条「挂在番茄上的目标只是当前选择，
// 不落 data.json」就是当时的判断）。**这一版把那条规矩推翻了**：重启是家常便饭，
// 那么「重启就清空」就不是简洁，是每天丢好几次状态。
//
// ---------------------------------------------------------------------------
// 恢复的口径：**时间要么真的属于你，要么一秒都不算**
// ---------------------------------------------------------------------------
//
// 恢复一段跑到一半的番茄，难的不是存下来，是决定**离开的那段时间算不算专注**。
// 两头都是错的：
//
//   - 全算：Obsidian 关了三小时，回来白得三小时专注——账当场就假了。
//     AME-239 判过一次同类的事（「人还在厨房，表已经在替你计专注时间」）。
//   - 全不算：重启一次 20 秒，回来番茄从头开始——那正是这条 issue 在抱怨的。
//
// 所以按段的性质分开处理：
//
//   | 存的时候 | 回来之后 |
//   | --- | --- |
//   | 工作段在跑，离开 ≤ 宽限期 | 原样接着跑，中间那点时间照算（重启就是十几秒的事） |
//   | 工作段在跑，离开 > 宽限期 | **就地冻住**：进度停在关掉那一刻，离开的时间一秒不算，回来自己按开工 |
//   | 工作段停着等人 | 原样停着等人（本来就不在计时） |
//   | 休息段在跑，还没到点 | 原样接着跑——休息按墙上的钟走，人不在正好是在休息 |
//   | 休息段在跑，已经过点 | 补记这一段休息，然后停在「休息结束，等你开工」 |
//   | 存的是**昨天**的段 | 整段作废，今天从零开始（跨天的账不补记，宁可少记也不猜） |
//
// 最后一格额外解释一句：**离开太久回来，工作段是「停着等你」而不是「继续跑」。**
// 开工永远是人手动的（AME-239），而「刚从三小时之外回来」和「休息结束还没复工」
// 是同一种状态——所以它也一样进待命、一样会被催。

import { elapsedMs, isBreak, reduce } from "./timer";
import type { TimerConfig, TimerEvent, TimerState } from "./timer";

export interface SessionSettings {
  /**
   * 重启之后接不接得回来。**默认开**——不开的话这条 issue 等于没做。
   * 留这颗开关是给「我就想每天从一张干净的表开始」的用法。
   */
  sessionRestoreEnabled: boolean;
  /**
   * 宽限期（分钟）：工作段在跑的时候关掉 Obsidian，离开多久之内还算数。
   *
   * 默认 5 分钟。重启一次 Obsidian 通常十几秒，插件多的机器慢一点也就一两分钟，
   * 这段时间人就坐在屏幕前等着——算给他不冤。超过就一秒都不算：那已经不是
   * 「重启一下」，是「走开了」。
   */
  sessionGraceMinutes: number;
}

/** 落进 data.json 的那一份。时间全是绝对毫秒——重启之后才对得上。 */
export interface PersistedSession {
  /** 存下这份状态的时刻。**离开多久是拿它和现在比出来的** */
  savedAt: number;
  /** 存的时候算的是哪一天（归日键）。换天了就不续 */
  day: string;
  timer: TimerState;
  /** 番茄挂的预设任务（积分任务表里的 id） */
  taskId: string | null;
  /** 番茄挂的目标树节点 */
  goalId: string | null;
}

export type SessionRestore =
  /** 没什么可接的：没存过、关掉了、或者存的时候本来就没在跑 */
  | { kind: "none" }
  /** 原样接着跑 */
  | { kind: "resumed"; state: TimerState; awayMs: number }
  /** 接回来了，但停着等人按开工。`awayMs` 是这次离开了多久 */
  | { kind: "held"; state: TimerState; awayMs: number; frozen: boolean }
  /** 离开期间休息跑完了：`events` 里有那一段要补记的休息 */
  | { kind: "handoff"; state: TimerState; events: TimerEvent[]; awayMs: number }
  /** 存的是昨天的段，整段作废 */
  | { kind: "dropped"; awayMs: number };

const MINUTE_MS = 60_000;

export function createSessionSnapshot(input: {
  now: number;
  day: string;
  timer: TimerState;
  taskId: string | null;
  goalId: string | null;
}): PersistedSession {
  return {
    savedAt: input.now,
    day: input.day,
    timer: input.timer,
    taskId: input.taskId,
    goalId: input.goalId,
  };
}

/** data.json 里那一坨可能来自旧版本、也可能被手工改坏；读不成形就当没存过。 */
export function normalizeSession(raw: unknown): PersistedSession | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Partial<PersistedSession>;
  const timer = normalizeTimer(source.timer);
  if (!timer) return null;
  if (typeof source.savedAt !== "number" || !Number.isFinite(source.savedAt)) return null;
  return {
    savedAt: source.savedAt,
    day: typeof source.day === "string" ? source.day : "",
    timer,
    taskId: typeof source.taskId === "string" ? source.taskId : null,
    goalId: typeof source.goalId === "string" ? source.goalId : null,
  };
}

export interface RestoreInput {
  session: PersistedSession | null;
  settings: SessionSettings;
  /** 现在的计时配置。补记的那一段用存下来的 plannedMs，之后的段才用它 */
  config: TimerConfig;
  now: number;
  /** 现在算哪一天（归日键） */
  day: string;
}

/**
 * 接回上一次的状态。纯函数：怎么写盘、怎么弹提示全在 main.ts。
 *
 * 口径见本文件抬头那张表。这里只做判断，不碰任何 I/O。
 */
export function restoreSession(input: RestoreInput): SessionRestore {
  const { session, settings, now } = input;
  if (!session || !settings.sessionRestoreEnabled) return { kind: "none" };

  const timer = session.timer;
  if (timer.status === "idle") return { kind: "none" };

  const awayMs = Math.max(0, now - session.savedAt);
  // 跨天：昨天没收工的那一段不往今天搬，也不回头补记昨天的账——
  // 昨天的日档已经落盘了，为了一段没人知道跑没跑完的番茄去重写它，得不偿失。
  if (session.day && session.day !== input.day) return { kind: "dropped", awayMs };

  // 本来就停着等人：离开多久都一样，它一秒都没在计时。
  if (timer.status === "paused") {
    return { kind: "held", state: timer, awayMs, frozen: false };
  }

  if (isBreak(timer.kind)) {
    const endsAt = segmentEndsAt(timer, session.savedAt);
    // 休息还没跑完：接着跑。休息是墙上的钟，人不在正好是在休息。
    if (now < endsAt) return { kind: "resumed", state: timer, awayMs };
    // 休息在离开期间跑完了：补记它，然后停在「休息结束，等你开工」。
    // 直接把状态机的 tick 喂到那一刻，走的和没关 Obsidian 时同一条路径。
    const result = reduce(input.config, timer, { type: "tick", at: endsAt });
    return { kind: "handoff", state: result.state, events: result.events, awayMs };
  }

  // 工作段：宽限期之内当作没断过，之后由 tick 自己收尾（跑过点的话）。
  const graceMs = Math.max(0, settings.sessionGraceMinutes) * MINUTE_MS;
  if (awayMs <= graceMs) return { kind: "resumed", state: timer, awayMs };

  // 离开太久：就地冻住。**这段时间一秒都不算进专注**，人回来自己按开工接着跑。
  const frozen: TimerState = {
    ...timer,
    status: "paused",
    accumulatedMs: elapsedMs(timer, session.savedAt),
    legStartedAt: null,
  };
  return { kind: "held", state: frozen, awayMs, frozen: true };
}

/** 一段在跑的段什么时候到点。停着的段没有「到点」这回事，别拿它问。 */
function segmentEndsAt(timer: TimerState, at: number): number {
  return at + Math.max(0, timer.plannedMs - elapsedMs(timer, at));
}

/** 存下来的那份计时状态。字段缺一个、类型错一个，整份作废——半份状态比没有更危险。 */
function normalizeTimer(raw: unknown): TimerState | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Partial<TimerState>;
  if (source.status !== "idle" && source.status !== "running" && source.status !== "paused") {
    return null;
  }
  if (source.kind !== "work" && source.kind !== "break" && source.kind !== "long-break") return null;
  const index = finite(source.pomodoroIndex);
  const planned = finite(source.plannedMs);
  const accumulated = finite(source.accumulatedMs);
  if (index === null || planned === null || accumulated === null) return null;
  return {
    status: source.status,
    kind: source.kind,
    pomodoroIndex: Math.max(0, Math.round(index)),
    plannedMs: Math.max(0, planned),
    accumulatedMs: Math.max(0, accumulated),
    legStartedAt: finite(source.legStartedAt),
    segmentStartedAt: finite(source.segmentStartedAt),
    task: typeof source.task === "string" ? source.task : "",
  };
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 弹给人看的那一句：这次接回来的是什么、离开了多久。 */
export function describeRestore(restore: SessionRestore, session: PersistedSession | null): string {
  const away = (ms: number): string => {
    const minutes = Math.round(ms / MINUTE_MS);
    if (minutes < 1) return "刚才";
    if (minutes < 60) return `${minutes} 分钟`;
    const hours = Math.floor(minutes / 60);
    return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ""}`;
  };
  switch (restore.kind) {
    case "resumed":
      return `接着上次：第 ${restore.state.pomodoroIndex} 个${isBreak(restore.state.kind) ? "休息" : "番茄"}还在跑。`;
    case "handoff":
      return `离开的 ${away(restore.awayMs)} 里休息已经跑完了。第 ${restore.state.pomodoroIndex} 个番茄停着等你按开工。`;
    case "held":
      return restore.frozen
        ? `上次退出时第 ${restore.state.pomodoroIndex} 个番茄没跑完。离开的 ${away(restore.awayMs)} 一秒没算进专注，进度停在原地——按「开工」接着跑。`
        : `第 ${restore.state.pomodoroIndex} 个番茄还停着等你按开工。`;
    case "dropped":
      return `上次退出时还有第 ${session?.timer.pomodoroIndex ?? 0} 个番茄没收工，那是上一个记账日的事了——今天从零开始，没有补记进任何一天的账。`;
    default:
      return "";
  }
}
