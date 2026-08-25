// 人在不在。整个强制干扰层都压在这一个判断上，所以它单独成一块、单独被测。
//
// AME-238 的那条 bug 就是没有这一层：复工强提醒页拦下来了，**停留倒计时照着墙上的
// 钟自己走完**，人去做家务睡了两个多小时回来，看到的是一页「看完了，开工」——
// 那一页根本没人看过。倒计时量的是「墙上过了多久」，而强提醒要量的是「人看了多久」。
// 这两件事只有在人一直坐在屏幕前时才碰巧相等。
//
// 所以这里把「在」拆成两种，**不要混成一个布尔**——它们触发的动作完全不同：
//
// | 概念 | 意思 | 谁用它 |
// | --- | --- | --- |
// | `atKeyboard` | 人在这台电脑前（任何窗口里有输入） | 强制锁屏：只锁**空闲**的机器 |
// | `attending` | 人正看着 Obsidian 这一页 | 强提醒页的停留倒计时：只有这时才走 |
//
// 混成一个的下场：要么人在浏览器里刷得正欢却被判成「不在」而挨一次锁屏（锁的是
// 工作台，放过了玩具，还打断了别人正在做的事），要么人已经离开两小时了，
// 只因为 Obsidian 窗口还开着就被判成「在看」——也就是 AME-238 报的这一条。

/** 判「在不在」要读的设置。整份 LifeCockpitSettings 不进这一层，测试里好造。 */
export interface AttentionSettings {
  /** 多久没有任何输入算「空闲」。锁屏那一路只认这个口径 */
  enforceIdleSeconds: number;
  /** 停留倒计时是否要求人真的在看。关掉就退回 0.6.x 的墙钟行为 */
  gateRequireAttention: boolean;
}

/**
 * 一次采样。四个来源各有各的盲区，所以要一起看：
 *
 * - `focused` / `visible`：Obsidian 自己知道的事，免费、每秒都能问；
 *   但人把手放在键盘上刷别的窗口时，这两个都是 false——它俩答不了「人在不在电脑前」。
 * - `lastInputAt`：Obsidian 窗口内最后一次输入。窗口外的输入它看不见。
 * - `systemIdleMs`：全系统最后一次输入到现在（Electron powerMonitor 或 PowerShell
 *   兜底）。这是唯一能跨窗口回答「人在不在电脑前」的信号，拿不到时为 null。
 */
export interface AttentionSample {
  now: number;
  /** Obsidian 窗口有没有系统焦点 */
  focused: boolean;
  /** 页面可见（没最小化、没被完全遮住） */
  visible: boolean;
  /** 窗口内最后一次输入的时刻；从没输入过为 null */
  lastInputAt: number | null;
  /** 全系统空闲毫秒数；探测不到为 null */
  systemIdleMs: number | null;
}

/** 判成「不在」时的理由。要能对人说清楚，所以是枚举不是布尔。 */
export type AbsenceReason = "blurred" | "hidden" | "no-input" | "system-idle";

export const ABSENCE_LABELS: Record<AbsenceReason, string> = {
  blurred: "Obsidian 不在前台",
  hidden: "窗口被最小化或遮住了",
  "no-input": "这个窗口里一直没有输入",
  "system-idle": "这台机器一直没人动",
};

export interface AttentionVerdict {
  /** 人在这台电脑前。锁屏只认它 */
  atKeyboard: boolean;
  /** 人正看着 Obsidian 这一页。停留倒计时只认它 */
  attending: boolean;
  /**
   * 空闲了多久。系统探测拿得到就用系统的（跨窗口，准）；
   * 拿不到退回窗口内输入（保守：窗口外的输入看不见，只会高估空闲，不会低估）。
   */
  idleMs: number;
  /** `attending` 为假时的理由；在看就是 null */
  reason: AbsenceReason | null;
}

/**
 * 判一次。**纯函数**：所有环境相关的东西（DOM 焦点、powerMonitor、PowerShell）
 * 都在采样那一侧读完再传进来，这里只做判断，所以能被完整测到。
 */
export function evaluateAttention(
  sample: AttentionSample,
  settings: AttentionSettings,
): AttentionVerdict {
  const idleThreshold = Math.max(1, Math.round(settings.enforceIdleSeconds)) * 1000;
  const windowIdleMs =
    sample.lastInputAt === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, sample.now - sample.lastInputAt);
  // 系统探测优先：它是唯一看得见「人在别的窗口里敲字」的信号。
  const idleMs = sample.systemIdleMs === null ? windowIdleMs : Math.max(0, sample.systemIdleMs);
  const atKeyboard = idleMs < idleThreshold;

  if (!sample.visible) return { atKeyboard, attending: false, idleMs, reason: "hidden" };
  if (!sample.focused) return { atKeyboard, attending: false, idleMs, reason: "blurred" };

  // 窗口在前台、也可见：这时候还要不要求输入？要。
  // 「盯着屏幕读一页笔记」确实可以几分钟不碰鼠标，但「人已经走了、Obsidian
  // 恰好停在前台」长得一模一样。两者只能靠输入区分，而读一页笔记的人随手滚一下
  // 页面就够了——代价是偶尔多滚一下，收益是 AME-238 那两个小时不会再发生。
  //
  // 系统探测拿得到时用系统口径：人在前台窗口里动鼠标，systemIdleMs 自然会小。
  if (idleMs >= idleThreshold) {
    return {
      atKeyboard,
      attending: false,
      idleMs,
      reason: sample.systemIdleMs === null ? "no-input" : "system-idle",
    };
  }
  return { atKeyboard: true, attending: true, idleMs, reason: null };
}

/**
 * 兜底的系统空闲探测：PowerShell 调 user32 的 `GetLastInputInfo`，返回毫秒数。
 *
 * **首选不是它**，是 Electron 的 `powerMonitor.getSystemIdleTime()`——那条路
 * 在渲染进程里同步就能拿到，不用起进程。这段脚本是 remote 模块拿不到时的兜底，
 * 所以调用频率被 `enforceCheckSeconds`（默认 60 秒）压着，起一次进程无所谓。
 *
 * 输出只有一行数字，好解析；出任何岔子输出 `-1`，由调用方按「探测不到」处理，
 * 不假装成 0——把探测失败读成「人刚刚还在动」正好会把该锁的屏放过去。
 */
export const IDLE_PROBE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "try {",
  "Add-Type -TypeDefinition @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public static class LifeCockpitIdle {",
  "  [StructLayout(LayoutKind.Sequential)]",
  "  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }",
  "  [DllImport(\"user32.dll\")]",
  "  private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);",
  "  public static long IdleMs() {",
  "    LASTINPUTINFO info = new LASTINPUTINFO();",
  "    info.cbSize = (uint)Marshal.SizeOf(info);",
  "    if (!GetLastInputInfo(ref info)) return -1;",
  "    return (long)((uint)Environment.TickCount - info.dwTime);",
  "  }",
  "}",
  "'@",
  "[LifeCockpitIdle]::IdleMs()",
  "} catch { -1 }",
].join("\n");

/** 解析上面那段脚本的输出。拿不到数就是 null——「探测不到」和「0 毫秒」不是一回事。 */
export function parseIdleProbe(stdout: string): number | null {
  const line = (stdout.trim().split(/\r?\n/).pop() ?? "").trim();
  // 只认纯数字。空串走 Number() 会变成 0——把「什么都没输出」读成「刚刚还在动」，
  // 正好会把该锁的那次屏放过去，是这里最贵的一种错。
  if (!/^\d+$/.test(line)) return null;
  return Number(line);
}

/** 说给人听的一句话。设置面板上直接显示，用来回答「它现在觉得我在不在」。 */
export function describeAttention(verdict: AttentionVerdict): string {
  const idle = `空闲 ${Math.round(verdict.idleMs / 1000)} 秒`;
  if (verdict.attending) return `在看这一页（${idle}）`;
  const reason = verdict.reason ? ABSENCE_LABELS[verdict.reason] : "不在看";
  return verdict.atKeyboard ? `人在电脑前，但${reason}（${idle}）` : `不在电脑前：${reason}（${idle}）`;
}
