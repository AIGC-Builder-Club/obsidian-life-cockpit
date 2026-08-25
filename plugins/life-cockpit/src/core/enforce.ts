// 强制干扰。R6 的推动器负责「说话」，这一层负责**人不听的时候怎么办**。
//
// AME-238 原话，这一层就是照着它造的：
//
//   临近番茄钟执行完时，会有 3 分钟的高频次系统通知（每 1 秒到每 2 秒一次）
//   + 系统亮度渐变切换调整（缓速闪烁的干扰效果）。
//   进入休息时间之后——先强制锁屏——然后给预先设定的正常休息时间。
//   如果休息过后人没有点击【恢复 继续番茄】——则每 1 分钟检查一次，
//   如果仍然是【空闲 + 未恢复工作】，则【强制锁屏 + 弹出通知 + 弹出督促自律网页
//   + 屏幕亮度缓速闪烁】，强制干扰、强制打断，逼人手动点一下继续下一个番茄。
//
// 0.6.x 缺的就是这一层，缺的后果在同一条 issue 里：强提醒页拦下来了，人去做家务、
// 睡了两个多小时，回到电脑前**手动切到 Obsidian** 才发现番茄卡在那儿。
// 拦是拦住了，但拦这件事本身没有任何人知道——**「强约束」不发声就等于没有约束。**
//
// 这一层为什么单独一个纯模块：
//   1. 它决定的是**不可逆的动作**（锁屏、闪屏），什么时候做、做几轮必须能被测到，
//      不能藏在 main.ts 的定时器回调里靠手工点一晚上验；
//   2. 它只输出**动作清单**，不自己执行。执行那一侧（起 PowerShell、弹通知、
//      拉窗口）全在 main.ts / alarm.ts，core 一行 child_process 都不碰。
//
// 三条硬规矩，写在算法前面：
//   - **锁屏只锁空闲的机器**。人在别的窗口里干活时锁屏，锁掉的是别人正在做的事，
//     这种插件第二天就会被卸载。人在电脑前但没复工，走的是「拉窗口 + 连击」那一路。
//   - **催一小时就收手**。人真的去睡了，凌晨三点还在闪屏不是自律，是灾难。
//   - **每一轮都留痕**：催了第几轮、为什么催、下一轮什么时候，面板上要答得出来。

import type { SegmentKind, TimerStatus } from "./timer";
import type { NudgeLevel } from "./nudge";
import type { AttentionVerdict } from "./attention";
import type { FlickerSettings } from "./brightness";

/** 这一轮干扰是为什么开的。写进通知正文，也写进面板。 */
export type EnforceReason = "pre-end" | "break-start" | "await-idle" | "await-ignored";

export const ENFORCE_REASON_LABELS: Record<EnforceReason, string> = {
  "pre-end": "番茄快跑完了",
  "break-start": "休息开始，先锁屏",
  "await-idle": "休息结束了，人不在",
  "await-ignored": "休息结束了，人在但没复工",
};

export interface EnforceSettings extends FlickerSettings {
  /** 总开关。关掉之后这一层一个动作都不发 */
  enforceEnabled: boolean;
  /** 收工前多少秒开始连击 */
  enforcePreEndSeconds: number;
  /** 连击间隔秒数（1–2 秒是原话里的口径） */
  enforceBurstSeconds: number;
  /** 连击时顺带响一声 */
  enforceBeep: boolean;
  /** 进入休息先强制锁屏 */
  enforceLockAtBreakStart: boolean;
  /** 锁之前留几秒反悔；0 = 立刻锁 */
  enforceBreakLockSeconds: number;
  /** 休息结束后先宽限多少秒再开始催 */
  enforceAwaitGraceSeconds: number;
  /** 之后每隔多少秒复查一轮 */
  enforceCheckSeconds: number;
  /** 每一轮的干扰持续多少秒 */
  enforceAwaitAlarmSeconds: number;
  /** 多久没有任何输入算「空闲」 */
  enforceIdleSeconds: number;
  /** 空闲且未复工时强制锁屏 */
  enforceAwaitLock: boolean;
  /** 督促自律网页；留空则改为把 Obsidian 拉到前台 */
  enforceDisciplineUrl: string;
  /**
   * 催到某个时限就收手。**默认关**（AME-239）：
   *
   *   「如果 “应该开工而没有开工” 则应该 永远是提示！！！
   *    如果 设置里面设为 无次数限制，则应该永远强提示！！！」
   *
   * 0.7.0 默认催满一小时就收手，理由是「凌晨三点还在闪屏不是自律」。那条理由
   * 本身没错，但它替人做了决定：**该不该放过自己，是人的事，不是插件的事**。
   * 所以这一层改成一颗单独的开关，默认永不收手；真要留退路，自己打开它。
   *
   * 单独一个新键而不是把 `enforceStopAfterMinutes` 改成 0：老机器的 data.json
   * 里那个 60 早就存下来了，改默认值对它一点作用都没有——新键才吃得到新默认值。
   */
  enforceGiveUpEnabled: boolean;
  /** 收手的时限（分钟）。只在 `enforceGiveUpEnabled` 打开时才算数 */
  enforceStopAfterMinutes: number;
  /** 推送静音时连通知和响声一起停（亮度闪烁与锁屏照旧） */
  enforceRespectMute: boolean;
}

export type EnforcePhase = "off" | "pre-end" | "await";

export interface EnforceState {
  phase: EnforcePhase;
  /** 当前这一轮盯的是哪一段；换段就重新开始 */
  segmentKey: string | null;
  /** 进入当前阶段的时刻 */
  since: number;
  /** await 阶段上一次催的时刻 */
  lastCheckAt: number;
  /** await 阶段已经催了几轮 */
  rounds: number;
  /** 已经收手了：催过 enforceStopAfterMinutes 分钟还没人回来 */
  gaveUp: boolean;
  /** 干扰正响着。用来决定要不要补一条 alarm-stop */
  alarm: boolean;
}

export function createEnforceState(): EnforceState {
  return {
    phase: "off",
    segmentKey: null,
    since: 0,
    lastCheckAt: 0,
    rounds: 0,
    gaveUp: false,
    alarm: false,
  };
}

/**
 * 动作清单。**每一条都是「做什么」，不带「怎么做」**——
 * 弹通知还是发飞书、起 PowerShell 还是闪遮罩，是执行侧的事。
 */
export type EnforceAction =
  | {
      type: "alarm-start";
      reason: EnforceReason;
      /** 至少响这么久。pre-end 那一路就是「响到这一段跑完为止」 */
      durationMs: number;
      title: string;
      body: string;
      /** 静音：只闪不响、不弹通知 */
      silent: boolean;
    }
  | { type: "alarm-stop" }
  | { type: "notify"; level: NudgeLevel; key: string; title: string; body: string }
  | { type: "lock"; seconds: number; reason: EnforceReason }
  /** 打开督促自律网页；地址没配时执行侧改成把 Obsidian 拉到前台 */
  | { type: "open-discipline" }
  | { type: "focus-window"; reason: EnforceReason };

export interface EnforceInput {
  settings: EnforceSettings;
  state: EnforceState;
  now: number;
  timer: {
    kind: SegmentKind;
    status: TimerStatus;
    /** 当前段还剩多少毫秒 */
    remainingMs: number;
    segmentKey: string;
  };
  /**
   * 复工待命起点：休息已经结束、工作段却没跑起来（强提醒页拦着，或者人自己停着）。
   * `null` = 不在待命。**这就是「人没有点击恢复继续番茄」那个状态的机器读法。**
   */
  awaitingSince: number | null;
  attention: AttentionVerdict;
  /** 这台机器锁不锁得动。锁不动就不发锁屏动作——发了也执行不了，纯噪音 */
  lockSupported: boolean;
  /** 人把推送静音了 */
  muted: boolean;
}

export interface EnforceOutput {
  state: EnforceState;
  actions: EnforceAction[];
}

/**
 * 走一拍。**幂等且只看时间**：两拍之间隔了 1 秒还是隔了 1 分钟都算得对——
 * 人切走之后 Chromium 会把后台窗口的定时器压到每分钟一次，
 * 靠数拍子的实现在最该干活的时候恰好会失灵。
 */
export function stepEnforce(input: EnforceInput): EnforceOutput {
  const { settings, state, now } = input;
  if (!settings.enforceEnabled) return leave(state, "off");

  // 待命优先于收工连击：待命意味着这一段已经停了，连击对着一段停着的表没有意义。
  if (input.awaitingSince !== null) return stepAwait(input, input.awaitingSince);

  const preEndMs = Math.max(0, Math.round(settings.enforcePreEndSeconds)) * 1000;
  const inPreEnd =
    preEndMs > 0 &&
    input.timer.kind === "work" &&
    input.timer.status === "running" &&
    input.timer.remainingMs > 0 &&
    input.timer.remainingMs <= preEndMs;

  if (!inPreEnd) return leave(state, "off");
  if (state.phase === "pre-end" && state.segmentKey === input.timer.segmentKey) {
    // 已经在响了。连击的节奏由执行侧那一个进程自己打，这里不每秒重开一次。
    return { state, actions: [] };
  }

  const seconds = Math.ceil(input.timer.remainingMs / 1000);
  const silent = settings.enforceRespectMute && input.muted;
  return {
    state: {
      phase: "pre-end",
      segmentKey: input.timer.segmentKey,
      since: now,
      lastCheckAt: now,
      rounds: 0,
      gaveUp: false,
      alarm: true,
    },
    actions: [
      {
        type: "alarm-start",
        reason: "pre-end",
        durationMs: input.timer.remainingMs,
        title: "番茄快跑完了",
        body: `还剩 ${seconds} 秒。收个尾，准备起身。`,
        silent,
      },
    ],
  };
}

function stepAwait(input: EnforceInput, awaitingSince: number): EnforceOutput {
  const { settings, state, now } = input;
  const graceMs = Math.max(0, Math.round(settings.enforceAwaitGraceSeconds)) * 1000;
  const checkMs = Math.max(5, Math.round(settings.enforceCheckSeconds)) * 1000;
  // 开关关着 = 永不收手。见 EnforceSettings.enforceGiveUpEnabled。
  const stopMs = settings.enforceGiveUpEnabled
    ? Math.max(0, Math.round(settings.enforceStopAfterMinutes)) * 60_000
    : 0;

  // 进入待命：把计数归零。同一次待命内不重置，否则每一拍都是「第一轮」。
  const base: EnforceState =
    state.phase === "await" && state.since === awaitingSince
      ? state
      : {
          phase: "await",
          segmentKey: input.timer.segmentKey,
          since: awaitingSince,
          lastCheckAt: awaitingSince,
          rounds: 0,
          gaveUp: false,
          alarm: false,
        };

  const actions: EnforceAction[] = [];
  // 从连击切进待命：先把上一段的干扰收掉，两种干扰不叠。
  if (state.alarm && base !== state) actions.push({ type: "alarm-stop" });

  if (base.gaveUp) return { state: base, actions };

  // 催了一小时还没人回来：那就不是走神，是今天结束了。收手，留一条话。
  if (stopMs > 0 && now - awaitingSince >= stopMs && base.rounds > 0) {
    const stopActions: EnforceAction[] = [...actions];
    if (base.alarm) stopActions.push({ type: "alarm-stop" });
    stopActions.push({
      type: "notify",
      level: "nudge",
      key: "enforce-give-up",
      title: "不催了",
      body: `催了 ${Math.round(stopMs / 60_000)} 分钟没等到人。番茄还停在原地，回来点一下就接着跑。`,
    });
    return { state: { ...base, alarm: false, gaveUp: true }, actions: stopActions };
  }

  const dueAt = base.rounds === 0 ? awaitingSince + graceMs : base.lastCheckAt + checkMs;
  if (now < dueAt) return { state: base, actions };

  const rounds = base.rounds + 1;
  const alarmMs = Math.max(3, Math.round(settings.enforceAwaitAlarmSeconds)) * 1000;
  const silent = settings.enforceRespectMute && input.muted;
  const waitedMinutes = Math.max(1, Math.round((now - awaitingSince) / 60_000));

  if (!input.attention.atKeyboard) {
    // 【空闲 + 未复工】——原话里唯一那条能动用不可逆动作的分支。
    actions.push({
      type: "alarm-start",
      reason: "await-idle",
      durationMs: alarmMs,
      title: "休息结束了",
      body: `已经等了 ${waitedMinutes} 分钟。回来点一下「看完了，开工」，下一个番茄才会跑。`,
      silent,
    });
    actions.push({
      type: "notify",
      level: "hard",
      key: "enforce-await",
      title: "休息结束了，番茄停在原地",
      body: `第 ${rounds} 轮催促 · 已等 ${waitedMinutes} 分钟。回到 Obsidian 点「看完了，开工」。`,
    });
    if (settings.enforceAwaitLock && input.lockSupported) {
      actions.push({ type: "lock", seconds: 0, reason: "await-idle" });
    }
    actions.push({ type: "open-discipline" });
  } else {
    // 人在电脑前，只是没回来复工。**这一路不锁屏**：锁掉的会是人手上正在做的事。
    actions.push({
      type: "alarm-start",
      reason: "await-ignored",
      durationMs: alarmMs,
      title: "番茄还停着",
      body: `休息已经结束 ${waitedMinutes} 分钟了。回 Obsidian 点一下「看完了，开工」。`,
      silent,
    });
    actions.push({
      type: "notify",
      level: "hard",
      key: "enforce-await",
      title: "番茄还停着",
      body: `第 ${rounds} 轮催促 · 人在电脑前但没复工，已等 ${waitedMinutes} 分钟。`,
    });
    actions.push({ type: "focus-window", reason: "await-ignored" });
  }

  return {
    state: { ...base, phase: "await", rounds, lastCheckAt: now, alarm: true },
    actions,
  };
}

/** 离开当前阶段：该收的干扰收掉，状态归零。 */
function leave(state: EnforceState, phase: "off"): EnforceOutput {
  if (state.phase === phase && !state.alarm) return { state, actions: [] };
  const actions: EnforceAction[] = state.alarm ? [{ type: "alarm-stop" }] : [];
  return { state: { ...createEnforceState(), phase }, actions };
}

/**
 * 进入休息那一下要做的事。**这是事件，不是状态**——「刚刚跨进休息段」这件事
 * 靠每秒采样是判不准的（一拍可能隔了一分钟），所以由段开始的那个事件直接调。
 */
export function breakStartActions(
  settings: EnforceSettings,
  input: { kind: SegmentKind; lockSupported: boolean; muted: boolean },
): EnforceAction[] {
  if (!settings.enforceEnabled) return [];
  const actions: EnforceAction[] = [{ type: "alarm-stop" }];
  if (!settings.enforceLockAtBreakStart) return actions;
  if (input.kind === "work") return actions;
  if (!input.lockSupported) {
    // 锁不动就明说锁不动。默默跳过的话，人会以为「强制休息」在生效。
    actions.push({
      type: "notify",
      level: "nudge",
      key: "enforce-lock-unsupported",
      title: "锁不了屏",
      body: "这台机器上的锁屏方式不可用，休息段只能靠遮罩挡一下。见设置 → 强提醒 · 锁屏。",
    });
    return actions;
  }
  const seconds = Math.max(0, Math.round(settings.enforceBreakLockSeconds));
  actions.push({ type: "lock", seconds, reason: "break-start" });
  return actions;
}

// ---------------------------------------------------------------------------
// 说给人听
// ---------------------------------------------------------------------------

/** 下一轮什么时候催。面板上显示它——「它什么时候会动」比「它开着」有用得多。 */
export function nextEnforceCheckMs(
  settings: EnforceSettings,
  state: EnforceState,
  awaitingSince: number | null,
  now: number,
): number | null {
  if (!settings.enforceEnabled || awaitingSince === null || state.gaveUp) return null;
  const graceMs = Math.max(0, Math.round(settings.enforceAwaitGraceSeconds)) * 1000;
  const checkMs = Math.max(5, Math.round(settings.enforceCheckSeconds)) * 1000;
  const dueAt =
    state.phase === "await" && state.rounds > 0
      ? state.lastCheckAt + checkMs
      : awaitingSince + graceMs;
  return Math.max(0, dueAt - now);
}

/** 一句话说清这套干扰会怎么动。设置页和面板共用同一句，免得两处说法不一致。 */
export function describeEnforcePlan(settings: EnforceSettings): string {
  if (!settings.enforceEnabled) return "强制干扰已关：番茄跑完只有一条普通通知。";
  const parts = [
    `收工前 ${Math.round(settings.enforcePreEndSeconds / 60) || 1} 分钟起连击（每 ${settings.enforceBurstSeconds} 秒一次${settings.enforceFlicker ? " + 亮度闪烁" : ""}）`,
  ];
  if (settings.enforceLockAtBreakStart) {
    parts.push(
      settings.enforceBreakLockSeconds > 0
        ? `进入休息 ${settings.enforceBreakLockSeconds} 秒后锁屏`
        : "进入休息立刻锁屏",
    );
  }
  parts.push(
    `休息结束 ${settings.enforceAwaitGraceSeconds} 秒未复工起，每 ${settings.enforceCheckSeconds} 秒催一轮` +
      (settings.enforceAwaitLock ? "（空闲则连锁屏）" : ""),
  );
  parts.push(
    settings.enforceGiveUpEnabled && settings.enforceStopAfterMinutes > 0
      ? `催满 ${settings.enforceStopAfterMinutes} 分钟收手`
      : "不收手：没开工就一直催",
  );
  return `${parts.join("；")}。`;
}
