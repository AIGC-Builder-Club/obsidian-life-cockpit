// 强制休息与系统级锁屏。R1 只做到插件内全屏遮罩（Esc 一按就退），这一层补上真锁。
//
// **锁屏是这整个插件里唯一不可逆的动作。** 遮罩关掉就没了，锁屏关掉要重新输密码；
// 锁在错的时刻（会议中、录屏中、跑长任务时）比不锁糟得多。所以三条硬规矩：
//   1. **默认关**；
//   2. **倒计时 + 可取消**——真锁之前给一段能反悔的时间，不是弹一下就锁；
//   3. **今天豁免**一按到底——今天不想被锁就别再问第二遍。
//
// 平台按分支给命令，**给不出来的就明说给不出来**，不假装支持：
//   - macOS：CGSession -suspend（快速用户切换的锁屏），或 pmset displaysleepnow；
//   - Windows：rundll32 user32.dll,LockWorkStation；
//   - 其它（含 Linux）：不支持。仓库主人两台机器是 macOS 与 Windows，Linux 没要求，
//     没实测过的命令不写进来充数。
//
// 命令表放在 core 里是为了能被测到；真正 spawn 子进程的那一下在 main.ts，
// core 一行 child_process 都不碰。

export type LockMethodId =
  | "auto"
  | "mac-cgsession"
  | "mac-displaysleep"
  | "win-lockworkstation";

export const LOCK_METHODS: LockMethodId[] = [
  "auto",
  "mac-cgsession",
  "mac-displaysleep",
  "win-lockworkstation",
];

export const LOCK_METHOD_LABELS: Record<LockMethodId, string> = {
  auto: "按平台自动选",
  "mac-cgsession": "macOS · CGSession（真锁屏）",
  "mac-displaysleep": "macOS · pmset 熄屏（要配合「唤醒时要求密码」）",
  "win-lockworkstation": "Windows · LockWorkStation",
};

export function isLockMethod(value: unknown): value is LockMethodId {
  return typeof value === "string" && LOCK_METHODS.includes(value as LockMethodId);
}

export interface LockCommand {
  id: Exclude<LockMethodId, "auto">;
  /** 可执行文件。一律走 execFile + 参数数组，不拼 shell 字符串——路径里有空格。 */
  file: string;
  args: string[];
  label: string;
}

/** CGSession 从 10.x 一路留到现在，是 macOS 上不需要辅助功能权限的那条锁屏路径。 */
const CGSESSION =
  "/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession";

const COMMANDS: Record<Exclude<LockMethodId, "auto">, LockCommand> = {
  "mac-cgsession": {
    id: "mac-cgsession",
    file: CGSESSION,
    args: ["-suspend"],
    label: LOCK_METHOD_LABELS["mac-cgsession"],
  },
  "mac-displaysleep": {
    id: "mac-displaysleep",
    file: "/usr/bin/pmset",
    args: ["displaysleepnow"],
    label: LOCK_METHOD_LABELS["mac-displaysleep"],
  },
  "win-lockworkstation": {
    id: "win-lockworkstation",
    file: "rundll32.exe",
    args: ["user32.dll,LockWorkStation"],
    label: LOCK_METHOD_LABELS["win-lockworkstation"],
  },
};

/**
 * 这台机器上锁屏该跑什么。**不支持就返回 null**，调用方负责把「做不到」说出来，
 * 不要退化成一条什么都不做的假命令——假装锁上了比明说锁不了危险得多。
 */
export function lockCommandFor(platform: string, method: LockMethodId = "auto"): LockCommand | null {
  if (method !== "auto") {
    const picked = COMMANDS[method];
    // 挑了跨平台的命令（比如在 Windows 上选了 CGSession）：不硬跑，按不支持处理。
    return picked && platformOf(picked.id) === platform ? picked : null;
  }
  if (platform === "darwin") return COMMANDS["mac-cgsession"];
  if (platform === "win32") return COMMANDS["win-lockworkstation"];
  return null;
}

function platformOf(id: Exclude<LockMethodId, "auto">): string {
  return id.startsWith("mac-") ? "darwin" : "win32";
}

export interface LockSupport {
  supported: boolean;
  /** 说给人听的一句话。不支持的时候这句就是「做不到」的原文 */
  detail: string;
}

export function lockSupport(platform: string, method: LockMethodId = "auto"): LockSupport {
  const command = lockCommandFor(platform, method);
  if (command) return { supported: true, detail: command.label };
  if (platform === "linux") {
    return {
      supported: false,
      detail:
        "Linux 上没做。桌面环境太杂（loginctl / xdg-screensaver / 各家自带命令各不相同），" +
        "没有在真机上验过的命令不写进来充数——这一条就是做不到。",
    };
  }
  if (platform === "darwin" || platform === "win32") {
    return {
      supported: false,
      detail: `当前选的锁屏方式不是这个平台的（${LOCK_METHOD_LABELS[method]}）。改回「按平台自动选」即可。`,
    };
  }
  return { supported: false, detail: `不认识的平台「${platform}」，锁屏做不到。` };
}

// ---------------------------------------------------------------------------
// 什么时候提议锁屏
// ---------------------------------------------------------------------------

/** 只在长休息锁，还是每个休息段都锁。 */
export type LockTrigger = "long-break" | "any-break";

export const LOCK_TRIGGERS: LockTrigger[] = ["long-break", "any-break"];

export const LOCK_TRIGGER_LABELS: Record<LockTrigger, string> = {
  "long-break": "只在长休息锁",
  "any-break": "每个休息段都锁",
};

export function isLockTrigger(value: unknown): value is LockTrigger {
  return typeof value === "string" && LOCK_TRIGGERS.includes(value as LockTrigger);
}

export interface LockSettings {
  lockEnabled: boolean;
  lockTrigger: LockTrigger;
  /** 倒计时秒数，这段时间里随时能取消 */
  lockCountdownSeconds: number;
  lockMethod: LockMethodId;
  /** 推迟一次往后推多少分钟 */
  lockDeferMinutes: number;
}

export interface LockState {
  /** 今天已经豁免了；豁免到换天为止 */
  exemptDay: string | null;
  /** 推迟到这个时刻之后才再提 */
  deferUntil: number | null;
  /** 已经为这一段提过了，同一段不重复提 */
  offeredFor: string | null;
  /** 倒计时正开着的那一段；null = 没在倒计时 */
  countdown: LockCountdown | null;
}

export interface LockCountdown {
  segmentKey: string;
  startedAt: number;
  /** 到点自动锁的时刻 */
  dueAt: number;
}

export function createLockState(): LockState {
  return { exemptDay: null, deferUntil: null, offeredFor: null, countdown: null };
}

export interface LockOfferInput {
  settings: LockSettings;
  state: LockState;
  /** 刚开始的这一段是什么 */
  kind: "work" | "break" | "long-break";
  segmentKey: string;
  day: string;
  now: number;
  /** 这台机器锁不锁得动。锁不动就别提——提了也执行不了，纯噪音 */
  supported: boolean;
}

export function shouldOfferLock(input: LockOfferInput): boolean {
  const { settings, state } = input;
  if (!settings.lockEnabled || !input.supported) return false;
  if (state.countdown) return false;
  if (state.exemptDay === input.day) return false;
  if (state.offeredFor === input.segmentKey) return false;
  if (state.deferUntil !== null && input.now < state.deferUntil) return false;
  if (input.kind === "work") return false;
  if (settings.lockTrigger === "long-break" && input.kind !== "long-break") return false;
  return true;
}

export function startCountdown(
  state: LockState,
  settings: LockSettings,
  /**
   * `seconds` 是给强制干扰层的口子（AME-238）：进入休息那一下的锁屏
   * 只留几秒反悔时间，和「休息段提议锁屏」那条路的 20 秒不是一回事。
   * 不传就照设置里的来。
   */
  input: { segmentKey: string; now: number; seconds?: number },
): LockState {
  const seconds = Math.max(1, Math.round(input.seconds ?? settings.lockCountdownSeconds));
  return {
    ...state,
    offeredFor: input.segmentKey,
    countdown: {
      segmentKey: input.segmentKey,
      startedAt: input.now,
      dueAt: input.now + seconds * 1000,
    },
  };
}

export function countdownRemainingMs(state: LockState, now: number): number {
  if (!state.countdown) return 0;
  return Math.max(0, state.countdown.dueAt - now);
}

export function countdownDue(state: LockState, now: number): boolean {
  return state.countdown !== null && now >= state.countdown.dueAt;
}

/** 锁上了（或人按了「立刻锁」）：收掉倒计时，其余不动。 */
export function finishCountdown(state: LockState): LockState {
  return { ...state, countdown: null };
}

/** 推迟一次。倒计时收掉，往后推 lockDeferMinutes 分钟内不再提。 */
export function deferLock(state: LockState, settings: LockSettings, now: number): LockState {
  const minutes = Math.max(1, settings.lockDeferMinutes);
  return { ...state, countdown: null, deferUntil: now + minutes * 60_000 };
}

/** 今天豁免。换天自动失效——豁免是今天的事，不是永久开关（永久开关在设置里）。 */
export function exemptLockToday(state: LockState, day: string): LockState {
  return { ...state, countdown: null, exemptDay: day };
}

/** 换天清豁免与推迟。offeredFor 不清：段 key 里带着开始时刻，本来就不会重复。 */
export function rolloverLock(state: LockState, day: string): LockState {
  if (state.exemptDay === null || state.exemptDay === day) return state;
  return { ...state, exemptDay: null, deferUntil: null };
}
