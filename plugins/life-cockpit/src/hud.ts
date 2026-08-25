import { Component } from "obsidian";
import type { HudSettings, HudSnapshot } from "./core/hud";
import { HUD_HEARTBEAT_MS, HUD_STALE_MS, HUD_STATE_LABELS, HUD_WINDOW_TITLE } from "./core/hud";
import { closeStrayHudWindows, createHudWindow, setTaskbarProgress } from "./desktop";
import type { HudWindowHandle } from "./desktop";

/**
 * 悬浮提示的执行侧。**决定「说什么」的是 core/hud.ts，这里只管「摆在哪、怎么画」。**
 *
 * 两种活法，能用哪种就用哪种：
 *
 * | 形态 | 什么时候看得见 | 怎么来的 |
 * | --- | --- | --- |
 * | 桌面悬浮框 | 任何窗口在前台都看得见 | Electron 另开一扇置顶、点击穿透的小窗 |
 * | 窗口内浮层 | 只有 Obsidian 在前台时 | 一个 `position: fixed` 的 div |
 *
 * 第一种开不出来（拿不到 remote、或者人自己关了）才退到第二种，**而且退了要说出来**：
 * 「以为它一直在，其实切走就没了」比没有这个功能更坏。
 *
 * 两种形态都**绝不接受任何输入**：桌面窗 `setIgnoreMouseEvents`，窗口内浮层
 * `pointer-events: none`。原话就是这么要求的——「悬浮（不可点击、不可交互）的提示框」。
 */
export interface HudDeps {
  settings: () => HudSettings & { uiFontScale: number };
}

/** 推给悬浮框的一份状态。页面自己按 endsAt / sinceAt 走秒，不指望每秒都被推一次。 */
interface HudPayload {
  state: HudSnapshot["state"];
  stateLabel: string;
  headline: string;
  detail: string;
  daily: string;
  progress: number;
  urgent: boolean;
  /** 倒计时终点（毫秒时间戳）；null 表示不倒计时 */
  endsAt: number | null;
  /** 正计时起点（毫秒时间戳）；null 表示不正计时 */
  sinceAt: number | null;
  scale: number;
  opacity: number;
  /** 心跳的拍号。变了页面就闪一下——这是「每 2 分钟提醒一次」看得见的那一半 */
  pulse: number;
}

const BASE_WIDTH = 250;
const BASE_HEIGHT = 132;
const MARGIN = 18;

export class HudPresenter extends Component {
  private deps: HudDeps;
  private window: HudWindowHandle | null = null;
  /** 桌面窗开过一次就不再反复重试：开不出来的机器每秒试一次纯属浪费 */
  private desktopTried = false;
  private inlineEl: HTMLElement | null = null;
  private inlineParts: {
    state: HTMLElement;
    time: HTMLElement;
    detail: HTMLElement;
    bar: HTMLElement;
    daily: HTMLElement;
  } | null = null;
  private lastSignature = "";
  private lastPlacement = "";
  /** 上一次往贴纸里敲心跳的时刻。看门狗的另一半，见 core/hud.ts 的那段注释 */
  private lastPingAt = 0;
  private pulseCount = 0;
  private pulseTimer: number | null = null;
  private snapshot: HudSnapshot | null = null;

  constructor(deps: HudDeps) {
    super();
    this.deps = deps;
  }

  /** 桌面悬浮框现在到底开着没有。设置页和面板照实显示它，不许粉饰。 */
  get desktopActive(): boolean {
    return Boolean(this.window?.alive);
  }

  onload(): void {
    // **主窗要走时，这扇窗自己关**（AME-273 第 3 条）。
    //
    // 从前贴纸的寿命只挂在插件的 `onunload` 上，而「退出 Obsidian」根本不走那个钩子：
    // 主窗关了，贴纸还开着，于是 Electron 的「窗都关完了才退进程」永远等不到——
    // 进程留着，贴纸留着，下次打开再叠一张。`beforeunload` 是渲染进程被拆之前
    // 最后一个一定会跑到的地方，退出 / 重启 / 重载三条路都经过它。
    this.registerDomEvent(window, "beforeunload", () => this.teardown());
  }

  onunload(): void {
    this.teardown();
  }

  /**
   * 走一拍。每秒都会被叫一次，但只有**状态指纹变了**才真的往那扇窗里推——
   * 秒数由页面自己走，跨进程每秒喊一次纯属浪费。
   */
  sync(snapshot: HudSnapshot, now: number): void {
    this.snapshot = snapshot;
    const settings = this.deps.settings();
    const scale = settings.uiFontScale;

    this.syncTaskbar(settings, snapshot);

    // 未开始时不摆这块贴纸：没有正在跑的番茄、也没欠着的开工，它没有内容可说。
    const visible = settings.hudEnabled && snapshot.state !== "idle";
    if (!visible) {
      this.teardown();
      return;
    }

    const payload: HudPayload = {
      state: snapshot.state,
      stateLabel: HUD_STATE_LABELS[snapshot.state],
      headline: snapshot.headline,
      detail: snapshot.detail,
      daily: snapshot.daily,
      progress: snapshot.progress,
      urgent: snapshot.urgent,
      endsAt: snapshot.remainingMs === null ? null : now + snapshot.remainingMs,
      sinceAt: snapshot.waitedMs === null ? null : now - snapshot.waitedMs,
      scale,
      opacity: settings.hudOpacity,
      pulse: this.pulseCount,
    };

    if (settings.hudDesktopWindow) this.ensureWindow(payload, settings, scale);
    else this.closeWindow();

    if (this.window?.alive) {
      this.closeInline();
      this.placeWindow(settings, scale);
      this.push(payload);
      this.heartbeat(now);
      return;
    }

    // 退到窗口内浮层。看得见的前提弱一档，但总比整条哑掉强。
    this.ensureInline();
    this.paintInline(payload);
  }

  /** 心跳的那一拍：让贴纸闪一下。看不见的提醒不是提醒。 */
  pulse(): void {
    this.pulseCount += 1;
    if (this.snapshot) this.sync(this.snapshot, Date.now());
    if (!this.inlineEl) return;
    this.inlineEl.addClass("is-pulse");
    if (this.pulseTimer !== null) window.clearTimeout(this.pulseTimer);
    this.pulseTimer = window.setTimeout(() => {
      this.inlineEl?.removeClass("is-pulse");
      this.pulseTimer = null;
    }, 3000);
  }

  /** 设置页那颗「测一次」按钮：不改任何状态，只把当前这一格推出去闪一下。 */
  describe(): string {
    const settings = this.deps.settings();
    if (!settings.hudEnabled) return "已关。";
    if (!settings.hudDesktopWindow) return "画在 Obsidian 窗口里：切到别的窗口就看不见了。";
    if (this.desktopActive) return "桌面悬浮框开着：置顶、点击穿透，切到任何窗口都看得见。";
    return this.desktopTried
      ? "这台机器开不出桌面悬浮窗（拿不到 Electron 的 BrowserWindow），已退回画在 Obsidian 窗口里。"
      : "还没开过——开一个番茄，或者按一下「测一次悬浮提示」。";
  }

  // -------------------------------------------------------------------------
  // 桌面悬浮窗
  // -------------------------------------------------------------------------

  private ensureWindow(payload: HudPayload, settings: HudSettings, scale: number): void {
    if (this.window?.alive) return;
    // 上一扇窗被人从任务管理器里关掉之类：句柄留着也没用，先扔掉。
    this.window = null;
    if (this.desktopTried) return;
    this.desktopTried = true;
    this.lastPingAt = Date.now();
    this.window = createHudWindow({
      html: hudHtml(payload),
      width: Math.round(BASE_WIDTH * scale),
      height: Math.round(BASE_HEIGHT * scale),
      corner: settings.hudCorner,
      margin: MARGIN,
      opacity: settings.hudOpacity,
    });
    this.lastPlacement = "";
  }

  private placeWindow(settings: HudSettings, scale: number): void {
    const signature = `${settings.hudCorner}:${scale}:${settings.hudOpacity}`;
    if (signature === this.lastPlacement) return;
    this.lastPlacement = signature;
    this.window?.place({
      width: Math.round(BASE_WIDTH * scale),
      height: Math.round(BASE_HEIGHT * scale),
      corner: settings.hudCorner,
      margin: MARGIN,
    });
    this.window?.setOpacity(settings.hudOpacity);
  }

  /**
   * 告诉贴纸「插件还活着」。**状态没变也要敲**——看门狗认的是心跳，不是内容：
   * 一个跑着的番茄在整整 25 分钟里一个字都不会变，那正是最不该被误判成「死了」的时候。
   */
  private heartbeat(now: number): void {
    if (now - this.lastPingAt < HUD_HEARTBEAT_MS) return;
    this.lastPingAt = now;
    this.window?.ping();
  }

  private push(payload: HudPayload): void {
    const signature = signatureOf(payload);
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.window?.update(payload);
  }

  private closeWindow(): void {
    // 有没有东西要收。**没有就一次跨进程调用都不发**——这个方法在没开贴纸的时候
    // 每秒都会被叫一次（`sync` 里 `visible` 为假那一路）。
    const had = this.window !== null || this.desktopTried;
    this.window?.close();
    this.window = null;
    // 句柄没了不等于窗没了：句柄可能建了一半就丢了，也可能是上一条命留下的孤儿窗
    // 还在屏幕上。**收摊要按记号扫一遍**（AME-273 第 3 条）。
    if (had) closeStrayHudWindows();
    this.lastSignature = "";
    this.lastPlacement = "";
    this.lastPingAt = 0;
    // 关掉之后允许再开一次：人在设置里把开关拨回来，就该重新开一扇。
    this.desktopTried = false;
  }

  // -------------------------------------------------------------------------
  // 窗口内浮层（兜底）
  // -------------------------------------------------------------------------

  private ensureInline(): void {
    if (this.inlineEl) return;
    const root = document.body.createDiv({ cls: "life-cockpit-hud" });
    const state = root.createDiv({ cls: "life-cockpit-hud-state" });
    const time = root.createDiv({ cls: "life-cockpit-hud-time" });
    const detail = root.createDiv({ cls: "life-cockpit-hud-detail" });
    const track = root.createDiv({ cls: "life-cockpit-hud-track" });
    const bar = track.createDiv({ cls: "life-cockpit-hud-bar" });
    const daily = root.createDiv({ cls: "life-cockpit-hud-daily" });
    this.inlineEl = root;
    this.inlineParts = { state, time, detail, bar, daily };
  }

  private paintInline(payload: HudPayload): void {
    const root = this.inlineEl;
    const parts = this.inlineParts;
    if (!root || !parts) return;

    root.removeClass("is-top-left", "is-top-right", "is-bottom-left", "is-bottom-right");
    root.addClass(`is-${this.deps.settings().hudCorner}`);
    root.toggleClass("is-urgent", payload.urgent);
    root.style.setProperty("--life-cockpit-hud-scale", String(payload.scale));
    root.style.opacity = String(payload.opacity);

    parts.state.setText(payload.stateLabel);
    parts.time.setText(payload.headline);
    parts.detail.setText(payload.detail);
    parts.daily.setText(payload.daily);
    parts.bar.style.width = `${Math.round(payload.progress * 100)}%`;
  }

  private closeInline(): void {
    if (this.pulseTimer !== null) {
      window.clearTimeout(this.pulseTimer);
      this.pulseTimer = null;
    }
    this.inlineEl?.remove();
    this.inlineEl = null;
    this.inlineParts = null;
  }

  private syncTaskbar(settings: HudSettings, snapshot: HudSnapshot): void {
    if (!settings.hudEnabled || !settings.taskbarProgressEnabled) {
      setTaskbarProgress(null);
      return;
    }
    if (snapshot.state === "idle") {
      setTaskbarProgress(null);
      return;
    }
    // 待开工那一格用红的：任务栏上一条红杠，是「有件事欠着」最省电的一种说法。
    if (snapshot.state === "await" || snapshot.state === "gate") {
      setTaskbarProgress(1, "error");
      return;
    }
    setTaskbarProgress(snapshot.progress, snapshot.state === "break" ? "paused" : "normal");
  }

  private teardown(): void {
    this.closeWindow();
    this.closeInline();
    setTaskbarProgress(null);
  }
}

/** 秒数交给页面自己走，所以指纹里不放倒计时本身，只放它的终点（取整到秒）。 */
function signatureOf(payload: HudPayload): string {
  return [
    payload.state,
    payload.headline.replace(/\d+/g, "#"),
    payload.detail,
    payload.daily,
    payload.urgent ? 1 : 0,
    payload.endsAt === null ? "-" : Math.round(payload.endsAt / 1000),
    payload.sinceAt === null ? "-" : Math.round(payload.sinceAt / 60_000),
    payload.scale,
    payload.opacity,
    payload.pulse,
  ].join("#");
}

/**
 * 悬浮窗那一页。**整页自足**：内联样式 + 内联脚本，不引任何外部资源——
 * 它跑在一个 data: URL 里，没有 vault、没有 Obsidian、没有网络。
 *
 * 秒表由这一页自己走（`endsAt` / `sinceAt`），插件只在状态变了时推一次。
 * 这样即使插件那边被 Chromium 压到每分钟一跳，这块贴纸上的数字也是准的。
 */
function hudHtml(initial: HudPayload): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>${HUD_WINDOW_TITLE}</title>
<style>
  :root { --s: ${initial.scale}; }
  * { margin: 0; padding: 0; box-sizing: border-box; -webkit-user-select: none; user-select: none; }
  html, body { width: 100%; height: 100%; background: transparent; overflow: hidden; cursor: default; }
  body {
    font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    font-size: calc(13px * var(--s));
    color: #f2f4f8;
  }
  #box {
    width: 100%; height: 100%;
    display: flex; flex-direction: column; gap: calc(2px * var(--s));
    padding: calc(10px * var(--s)) calc(12px * var(--s));
    border-radius: calc(12px * var(--s));
    background: rgba(20, 22, 28, 0.86);
    border: 1px solid rgba(255, 255, 255, 0.14);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
  }
  #box.urgent { background: rgba(96, 18, 22, 0.9); border-color: rgba(255, 120, 120, 0.55); }
  #state { font-size: calc(11px * var(--s)); letter-spacing: 0.08em; opacity: 0.75; }
  #time { font-size: calc(30px * var(--s)); font-weight: 600; line-height: 1.1; font-variant-numeric: tabular-nums; }
  #detail { font-size: calc(11px * var(--s)); opacity: 0.86; overflow-wrap: anywhere; }
  #track { height: calc(3px * var(--s)); border-radius: 999px; background: rgba(255,255,255,0.16); overflow: hidden; }
  #bar { height: 100%; width: 0; background: #7aa2ff; transition: width 0.4s linear; }
  #box.urgent #bar { background: #ff8f8f; }
  #daily { font-size: calc(10px * var(--s)); opacity: 0.6; }
  #box.pulse { animation: lc-pulse 1.1s ease-in-out 3; }
  @keyframes lc-pulse {
    0%, 100% { transform: scale(1); box-shadow: 0 6px 24px rgba(0,0,0,0.35); }
    50% { transform: scale(1.04); box-shadow: 0 0 0 calc(3px * var(--s)) rgba(255,255,255,0.28); }
  }
</style>
</head>
<body>
<div id="box">
  <div id="state"></div>
  <div id="time"></div>
  <div id="detail"></div>
  <div id="track"><div id="bar"></div></div>
  <div id="daily"></div>
</div>
<script>
(function () {
  var data = null;
  var lastPulse = null;
  var box = document.getElementById('box');
  var el = {
    state: document.getElementById('state'),
    time: document.getElementById('time'),
    detail: document.getElementById('detail'),
    bar: document.getElementById('bar'),
    daily: document.getElementById('daily')
  };

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function clock(ms) {
    var total = Math.max(0, Math.round(ms / 1000));
    return pad(Math.floor(total / 60)) + ':' + pad(total % 60);
  }

  function render() {
    if (!data) return;
    var headline = data.headline;
    if (typeof data.endsAt === 'number') headline = clock(data.endsAt - Date.now());
    else if (typeof data.sinceAt === 'number') {
      var mins = Math.max(0, Math.round((Date.now() - data.sinceAt) / 60000));
      headline = mins > 0 ? '已等 ' + mins + ' 分钟' : '该开工了';
    }
    el.state.textContent = data.stateLabel || '';
    el.time.textContent = headline;
    el.detail.textContent = data.detail || '';
    el.daily.textContent = data.daily || '';
    el.bar.style.width = Math.round((data.progress || 0) * 100) + '%';
    box.classList.toggle('urgent', !!data.urgent);
  }

  window.__lifeCockpitHud = function (next) {
    // 推一次状态也算一次心跳：插件那边正在跟我们说话，就不必再单敲一下。
    if (window.__lifeCockpitAlive) window.__lifeCockpitAlive();
    data = next || null;
    if (!data) return;
    document.documentElement.style.setProperty('--s', String(data.scale || 1));
    if (lastPulse !== null && data.pulse !== lastPulse) {
      box.classList.remove('pulse');
      void box.offsetWidth;
      box.classList.add('pulse');
    }
    lastPulse = data.pulse;
    render();
  };

  // 看门狗（AME-273 第 3 条）。**这是这扇窗唯一能自己救自己的一条命**：
  // 插件被强杀、渲染进程崩掉时，没有任何人会来关它——而它是一扇置顶、点击穿透、
  // 不进任务栏的窗，人在系统里连关它的地方都找不到，只能去任务管理器。
  //
  // 判据是心跳，不是内容：一个跑着的番茄整整 25 分钟一个字都不变。
  // 机器睡一觉醒来那种「一跳几小时」不算数——那一跳里连这个定时器自己都停着，
  // 说明不了插件死没死，所以重新起算。
  var lastSeen = Date.now();
  var lastTick = Date.now();
  window.__lifeCockpitAlive = function () { lastSeen = Date.now(); };
  setInterval(function () {
    var now = Date.now();
    if (now - lastTick > 60000) lastSeen = now;
    lastTick = now;
    if (now - lastSeen > ${HUD_STALE_MS}) window.close();
  }, 5000);

  window.__lifeCockpitHud(${JSON.stringify(initial)});
  setInterval(render, 500);
})();
</script>
</body>
</html>`;
}
