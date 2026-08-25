// 存在感层：桌面悬浮提示 + 每 N 分钟的心跳提醒。判断全在这里，画面和进程在 ../hud.ts。
//
// AME-239 原话，这一层就是照着它造的：
//
//   「得需要一些【托盘区的提示、展示】…… 或者，桌面上，有一个悬浮（不可点击、
//    不可交互）的提示框？——中间的提示太弱了，几乎没有存在感——我的预期，
//    每 2 分钟 得有一个提示、提醒？」
//
// 前面几轮把「说话」这件事全押在了两个地方：Obsidian 窗口里的遮罩，和出事时才
// 炸一轮的强制干扰。两者中间是空的——**人切到别的窗口去干活的那 25 分钟里，
// 这套系统在他视野里根本不存在**。于是番茄跑完了他不知道，卡在待开工他也不知道，
// 一直到自己想起来切回 Obsidian 才发现。
//
// 所以这一层的定位很窄，但要一直在：
//
//   | 手段 | 看得见的前提 | 强度 |
//   | --- | --- | --- |
//   | 桌面悬浮框 | 什么窗口在前台都看得见（置顶 + 点击穿透） | 常驻、弱 |
//   | 任务栏进度 / 闪烁 | 余光扫得到任务栏 | 常驻、更弱 |
//   | 心跳提醒（默认每 2 分钟） | 系统通知 | 周期、中 |
//   | 强制干扰（enforce.ts） | 亮度闪烁 / 锁屏 | 事件驱动、强 |
//
// **常驻的那两条一律不可交互**：悬浮框点击穿透、不抢焦点。一块能挡住鼠标的浮层
// 一天之内就会被关掉，而它的价值恰恰在于「一直在」。
//
// 心跳和强制干扰**不共用一条通道**：强制干扰是事件（番茄快跑完了、休息结束没复工），
// 心跳是节拍（现在是什么状态）。两者叠加时心跳让路——正在闪屏锁屏的时候再插一条
// 「工作中，还剩 12 分钟」只是噪音。

import { formatDuration, isBreak } from "./timer";
import type { SegmentKind, TimerStatus } from "./timer";

// ---------------------------------------------------------------------------
// 那扇窗的身份与寿命（AME-273 第 3 条）
//
//   「点击【退出Obsidian】后，插件的Electron悬浮窗还在（重新打开 Obsidian 后，
//    又会启动第二个Electron悬浮窗（此时，两个窗会重叠））」
//
// 病根：这块贴纸是**另一扇真窗户**，不是 Obsidian 窗口里的一个 div。它的生命周期
// 从前只挂在一个地方——插件的 `onunload`。而「退出 Obsidian」这条路上根本没人叫过
// 那个钩子：主窗关掉了，这扇窗还开着，于是 Electron 那句「窗都关完了才退进程」
// 永远等不到——**进程活着，贴纸留在屏幕上，下一次打开 Obsidian 再叠一张**。
// （「重启 Obsidian」那条路之所以正常，是因为它走的是另一套收尾。）
//
// 所以寿命改成三条腿，任何一条断了另外两条还在：
//
//   1. **主窗要走时自己关**（`beforeunload`）——正常退出、重启、重载都走这一条；
//   2. **开之前先扫一遍有没有前任**（`isHudWindowTitle`）——上一条没跑成、或者上一版
//      插件留下的孤儿窗，在这里被收掉，「两个窗重叠」从此不可能发生；
//   3. **贴纸自己有个看门狗**——超过一段时间收不到插件的心跳就自尽。插件被强杀、
//      渲染进程崩掉时只剩这一条，而这正是前两条都够不着的情况。
//
// 这个标题就是第 2 条认人的记号：页面 `<title>` 会盖掉建窗时给的 title，
// 所以两处必须是**同一个字符串**，而且要独特到不可能撞上 Obsidian 自己的窗。
// ---------------------------------------------------------------------------

/** 悬浮框那扇窗的标题 = 认领记号。改它要同时改 `hudHtml` 里的 `<title>`。 */
export const HUD_WINDOW_TITLE = "人生驾驶舱悬浮提示 · life-cockpit-hud";

/** 0.16.0 及更早留下的孤儿窗：那几版的页面标题是这一句。也要认，才收得掉。 */
const LEGACY_HUD_WINDOW_TITLES = ["人生驾驶舱", "人生驾驶舱悬浮提示"];

/**
 * 这扇窗是不是我们留下的贴纸。**只认全等的标题**——收窗是不可逆的动作，
 * 宁可漏收一扇孤儿窗，也不能误杀人家的 Obsidian 主窗。
 *
 * 这只是第一道判据。真正动手的 `closeStrayHudWindows`（`../desktop.ts`）还要再看一眼
 * 那扇窗跑的是不是 `data:` URL——老版本留下的标题是「人生驾驶舱」这种大路货，
 * 光靠它一条不够稳。
 */
export function isHudWindowTitle(title: unknown): boolean {
  if (typeof title !== "string") return false;
  const trimmed = title.trim();
  return trimmed === HUD_WINDOW_TITLE || LEGACY_HUD_WINDOW_TITLES.includes(trimmed);
}

/** 插件每隔这么久往贴纸里推一次心跳。 */
export const HUD_HEARTBEAT_MS = 20_000;

/**
 * 贴纸多久收不到心跳就自尽。
 *
 * 这个数字要**远大于**心跳间隔，因为 Obsidian 切到后台之后 Chromium 会把插件那边的
 * 定时器压到每分钟一跳（关掉后台节流只在强制干扰开着时才做）。5 分钟是「1 分钟一跳」
 * 的五倍余量：宁可让一扇孤儿窗多留几分钟，也不能在人正看着的时候把它关掉。
 */
export const HUD_STALE_MS = 300_000;

/** 悬浮框贴哪个角。默认右上：任务栏在下面，通知也从右下弹，右上是最不打架的一角。 */
export type HudCorner = "top-right" | "top-left" | "bottom-right" | "bottom-left";

export const HUD_CORNERS: HudCorner[] = ["top-right", "top-left", "bottom-right", "bottom-left"];

export const HUD_CORNER_LABELS: Record<HudCorner, string> = {
  "top-right": "右上",
  "top-left": "左上",
  "bottom-right": "右下",
  "bottom-left": "左下",
};

export function isHudCorner(value: unknown): value is HudCorner {
  return typeof value === "string" && HUD_CORNERS.includes(value as HudCorner);
}

export interface HudSettings {
  /** 总开关。关掉之后这一层一个像素都不画、一条提醒都不发 */
  hudEnabled: boolean;
  /**
   * 开一个真正的桌面悬浮窗（Electron 置顶 + 点击穿透）。
   * 关掉、或者这台机器开不出来时，退回「画在 Obsidian 窗口里」——
   * 那时只有 Obsidian 在前台才看得见，**强度差一大截，所以要说出来**。
   */
  hudDesktopWindow: boolean;
  hudCorner: HudCorner;
  /** 悬浮框不透明度 0.2–1 */
  hudOpacity: number;
  /** 任务栏进度条 / 闪烁（Windows）。这是「托盘区展示」够得着的那一半 */
  taskbarProgressEnabled: boolean;
  /** 心跳提醒总开关 */
  heartbeatEnabled: boolean;
  /** 多久一拍（分钟）。原话给的是 2 */
  heartbeatMinutes: number;
  /** 每一拍弹一条系统通知 */
  heartbeatNotify: boolean;
  /** 每一拍闪一下任务栏 */
  heartbeatFlash: boolean;
  /** 番茄正常跑着的时候也要心跳。关掉就只在「该开工却没开工」时才响 */
  heartbeatWhileRunning: boolean;
}

/**
 * 此刻这套系统处在哪一格。**`await` 是最重要的那一格**：
 * 该开工而没开工，也就是原话里「永远是提示」的那个状态。
 */
export type HudState = "idle" | "work" | "break" | "gate" | "await";

export const HUD_STATE_LABELS: Record<HudState, string> = {
  idle: "未开始",
  work: "工作中",
  break: "休息中",
  gate: "复工前，先过这一页",
  await: "还没开工",
};

export interface HudInput {
  now: number;
  timer: {
    kind: SegmentKind;
    status: TimerStatus;
    pomodoroIndex: number;
    remainingMs: number;
    plannedMs: number;
    task: string;
  };
  /** 复工待命起点；null = 不在待命。见 main.ts 的 awaitingSince */
  awaitingSince: number | null;
  /** 复工强提醒页正拦着 */
  gateOpen: boolean;
  /** 这个番茄在推进哪个目标；没挂就是 null */
  goal: string | null;
  focusMinutes: number;
  targetMinutes: number;
}

export interface HudSnapshot {
  state: HudState;
  /** 大字。倒计时或者「已等 N 分钟」 */
  headline: string;
  /** 一行说明：第几个番茄、在做什么 */
  detail: string;
  /** 当日累计那一行 */
  daily: string;
  /** 当前段进度 0..1；待命和未开始时为 0 */
  progress: number;
  /**
   * 这一段还剩多久；不在倒计时的状态为 null。
   * 悬浮框拿它换算成一个终点时刻，然后**自己走秒**——插件那边被节流也不影响。
   */
  remainingMs: number | null;
  /** 已经欠了多久（待开工）；不在待命时为 null */
  waitedMs: number | null;
  /** 红色警戒：该开工没开工，或者番茄只剩最后一分钟 */
  urgent: boolean;
  /** 状态指纹。变了就说明「情况变了」，心跳的节拍跟着重来 */
  key: string;
}

const MINUTE_MS = 60_000;

/** 把此刻的状态压成一块可显示的东西。纯函数，没有 DOM、没有 Electron。 */
export function buildHudSnapshot(input: HudInput): HudSnapshot {
  const { timer } = input;
  const daily = `今日 ${Math.floor(input.focusMinutes)} / ${input.targetMinutes} 分钟`;
  const task = timer.task.trim();
  const goal = input.goal?.trim() ?? "";

  if (input.awaitingSince !== null) {
    const waitedMs = Math.max(0, input.now - input.awaitingSince);
    const waited = Math.round(waitedMs / MINUTE_MS);
    return {
      state: input.gateOpen ? "gate" : "await",
      headline: waited > 0 ? `已等 ${waited} 分钟` : "该开工了",
      detail: input.gateOpen
        ? "回 Obsidian 看完那一页，点「看完了，开工」"
        : "回 Obsidian 点一下「开工」，下一个番茄才会跑",
      daily,
      progress: 0,
      remainingMs: null,
      waitedMs,
      urgent: true,
      key: `await:${input.awaitingSince}:${input.gateOpen ? 1 : 0}`,
    };
  }

  if (timer.status === "idle") {
    return {
      state: "idle",
      headline: "未开始",
      detail: "开一个番茄，这一天才开始记账",
      daily,
      progress: 0,
      remainingMs: null,
      waitedMs: null,
      urgent: false,
      key: "idle",
    };
  }

  const breaking = isBreak(timer.kind);
  const paused = timer.status === "paused";
  const progress =
    timer.plannedMs > 0 ? clamp01(1 - timer.remainingMs / timer.plannedMs) : 0;

  const detailParts = [`第 ${timer.pomodoroIndex} 个番茄`];
  if (!breaking && task) detailParts.push(task);
  if (!breaking && goal) detailParts.push(`推进「${goal}」`);
  if (paused) detailParts.push("停着，等你开工");

  return {
    state: breaking ? "break" : "work",
    headline: formatDuration(timer.remainingMs),
    detail: detailParts.join(" · "),
    daily,
    progress,
    // 停着的表不该在悬浮框上继续走秒——那正是「以为它在跑，其实它在等我」。
    remainingMs: paused ? null : timer.remainingMs,
    waitedMs: null,
    // 最后一分钟标红：这一分钟里人该收尾了，强制干扰的连击也正好在这一段。
    urgent: paused || (!breaking && timer.remainingMs <= MINUTE_MS),
    key: `${timer.kind}:${timer.pomodoroIndex}:${timer.status}`,
  };
}

// ---------------------------------------------------------------------------
// 心跳
// ---------------------------------------------------------------------------

export interface HeartbeatState {
  /** 上一拍的时刻；null = 这一轮还没响过 */
  lastAt: number | null;
  /** 上一次看见的状态指纹，变了就重新起拍 */
  key: string;
}

export interface HeartbeatBeat {
  title: string;
  body: string;
  /** 第几拍。写进正文——「催了多久」比「又响了一次」有用 */
  round: number;
  urgent: boolean;
}

export function createHeartbeatState(): HeartbeatState {
  return { lastAt: null, key: "" };
}

export interface HeartbeatInput {
  settings: HudSettings;
  state: HeartbeatState;
  snapshot: HudSnapshot;
  now: number;
  /** 强制干扰正响着：这一拍让路，两层不叠 */
  alarmRunning: boolean;
}

/**
 * 走一拍。**只看时间，不数拍子**——人切走之后 Chromium 会把定时器压到每分钟一次，
 * 靠数拍子的实现在最该说话的时候恰好会漏。
 *
 * 起拍点是**状态变化那一刻**，不是插件装载那一刻：刚点下开工就立刻挨一条
 * 「工作中」只是噪音，一个间隔之后再说才是节拍。
 */
export function stepHeartbeat(input: HeartbeatInput): {
  state: HeartbeatState;
  beat: HeartbeatBeat | null;
} {
  const { settings, snapshot, now } = input;
  if (!settings.hudEnabled || !settings.heartbeatEnabled) return { state: createHeartbeatState(), beat: null };
  if (snapshot.state === "idle") return { state: createHeartbeatState(), beat: null };
  // 正在被强制干扰的人不需要再收一条心跳。
  if (input.alarmRunning) return { state: { ...input.state, key: snapshot.key }, beat: null };
  // 「该开工没开工」永远心跳；番茄正常跑着的那一路可以单独关掉。
  const owed = snapshot.state === "await" || snapshot.state === "gate";
  if (!owed && !settings.heartbeatWhileRunning) {
    return { state: { ...input.state, key: snapshot.key }, beat: null };
  }

  const intervalMs = Math.max(1, settings.heartbeatMinutes) * MINUTE_MS;
  // 状态变了就重新起拍：换段、开工、被拦下来都算「情况变了」。
  if (input.state.key !== snapshot.key) {
    return { state: { lastAt: now, key: snapshot.key }, beat: null };
  }
  const since = input.state.lastAt ?? now;
  if (now - since < intervalMs) return { state: input.state, beat: null };

  const round = Math.max(1, Math.round((now - since) / intervalMs));
  return {
    state: { lastAt: now, key: snapshot.key },
    beat: {
      title: `${HUD_STATE_LABELS[snapshot.state]} · ${snapshot.headline}`,
      body: `${snapshot.detail}。${snapshot.daily}`,
      round,
      urgent: snapshot.urgent,
    },
  };
}

/** 设置页和面板共用的一句话：这一层现在会怎么动。 */
export function describeHudPlan(settings: HudSettings, desktopOk: boolean): string {
  if (!settings.hudEnabled) return "悬浮提示已关：番茄的状态只在 Obsidian 窗口里看得到。";
  const where = !settings.hudDesktopWindow
    ? "画在 Obsidian 窗口里（不置顶，切走就看不见）"
    : desktopOk
      ? `桌面悬浮框贴在${HUD_CORNER_LABELS[settings.hudCorner]}，置顶、点击穿透`
      : "这台机器开不出桌面悬浮窗，已退回画在 Obsidian 窗口里";
  const beat = !settings.heartbeatEnabled
    ? "心跳提醒已关"
    : `每 ${settings.heartbeatMinutes} 分钟提醒一次${settings.heartbeatWhileRunning ? "" : "（只在该开工没开工时）"}`;
  return `${where}；${beat}。`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
