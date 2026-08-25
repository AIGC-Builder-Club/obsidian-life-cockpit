// 通往 Electron / Node 的那一小扇门，整个插件只在这一个文件里开。
//
// Obsidian 桌面端的渲染进程是 Electron，`window.require` 拿得到 node 内建模块。
// 但这条路有两个坑，都在这里一次性堵掉：
//   1. **不能顶层 require**——拿不到的时候整个插件会加载失败。一律懒加载 + 兜异常；
//   2. **不能假装成功**——拿不到就返回 null，由调用方把「做不到」说出来。
//      锁屏尤其如此：假装锁上了比明说锁不了危险得多。
//
// 也因此 esbuild 的 external 一行都不用改：`window.require` 是运行时查表，
// 打包器根本看不见它。

import { isHudWindowTitle, HUD_WINDOW_TITLE } from "./core/hud";

/** 拿一个 node 内建模块；不是 Electron 环境就返回 null。 */
function nodeRequire<T>(id: string): T | null {
  try {
    const bridge = window as unknown as { require?: (name: string) => unknown };
    if (typeof bridge.require !== "function") return null;
    return (bridge.require(id) as T) ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Electron 那一侧（AME-238）
//
// 强制干扰要三件渲染进程自己给不了的东西：**系统空闲时间**、**把窗口拽到人脸前**、
// 以及**别让 Chromium 把后台定时器掐了**。三件都在主进程的 API 上，渲染进程要走
// remote。Obsidian 各版本给的门不一样（`electron.remote` / `@electron/remote`），
// 所以按顺序试，一个都拿不到就退回没有它们的活法——**不假装拿到了**。
// ---------------------------------------------------------------------------

interface RemoteBridge {
  powerMonitor?: { getSystemIdleTime?: () => number };
  getCurrentWindow?: () => ElectronWindow | null;
  /**
   * 桌面悬浮框要自己开一扇窗，走的就是它（AME-239）。
   * `getAllWindows` 是收孤儿窗要用的那一半（AME-273 第 3 条）。
   */
  BrowserWindow?: (new (options: Record<string, unknown>) => ElectronWindow) & {
    getAllWindows?: () => ElectronWindow[];
  };
  screen?: { getPrimaryDisplay?: () => { workArea?: DisplayRect } | null };
}

export interface DisplayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ElectronWindow {
  id?: number;
  getTitle?: () => string;
  isDestroyed?: () => boolean;
  isMinimized?: () => boolean;
  restore?: () => void;
  show?: () => void;
  showInactive?: () => void;
  hide?: () => void;
  close?: () => void;
  destroy?: () => void;
  focus?: () => void;
  moveTop?: () => void;
  flashFrame?: (flag: boolean) => void;
  setAlwaysOnTop?: (flag: boolean, level?: string) => void;
  setIgnoreMouseEvents?: (ignore: boolean, options?: Record<string, unknown>) => void;
  setOpacity?: (value: number) => void;
  setBounds?: (bounds: DisplayRect) => void;
  setVisibleOnAllWorkspaces?: (visible: boolean, options?: Record<string, unknown>) => void;
  setProgressBar?: (progress: number, options?: { mode?: string }) => void;
  loadURL?: (url: string) => Promise<void>;
  webContents?: {
    setBackgroundThrottling?: (allowed: boolean) => void;
    executeJavaScript?: (code: string) => Promise<unknown>;
    /** 收孤儿窗时的第二道判据：贴纸跑在 data: URL 上，Obsidian 自己的窗不是（AME-273 第 3 条） */
    getURL?: () => string;
  };
}

/** 查表结果缓存：这一段每秒都要走一次（判人在不在），没必要每次重新找门。 */
let cachedBridge: RemoteBridge | null | undefined;

function remoteBridge(): RemoteBridge | null {
  if (cachedBridge !== undefined) return cachedBridge;
  cachedBridge = resolveBridge();
  return cachedBridge;
}

function resolveBridge(): RemoteBridge | null {
  const direct = nodeRequire<{ remote?: RemoteBridge }>("electron");
  if (direct?.remote?.getCurrentWindow) return direct.remote;
  const detached = nodeRequire<RemoteBridge>("@electron/remote");
  if (detached?.getCurrentWindow) return detached;
  // powerMonitor 有可能单独拿得到（老版本的 electron.remote 结构）。
  if (direct?.remote) return direct.remote;
  return null;
}

function currentWindow(): ElectronWindow | null {
  try {
    const window_ = remoteBridge()?.getCurrentWindow?.() ?? null;
    if (!window_ || window_.isDestroyed?.()) return null;
    return window_;
  } catch {
    return null;
  }
}

/**
 * 全系统空闲毫秒数。**这是「人在不在电脑前」唯一跨窗口的信号**，
 * 拿不到就返回 null，由 attention 那一层退回窗口内的输入时间（保守，只会高估空闲）。
 */
export function systemIdleMs(): number | null {
  try {
    const seconds = remoteBridge()?.powerMonitor?.getSystemIdleTime?.();
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
    return Math.round(seconds * 1000);
  } catch {
    return null;
  }
}

/**
 * 把 Obsidian 拽到人脸前：最小化的先还原，然后抢焦点、置顶一下、闪任务栏。
 *
 * AME-238 那句「我一直到手动切换到 Obsidian 才知道这里卡了一个番茄时钟」——
 * 治的就是这一条：该由插件把自己送到人眼前，不该由人想起来去找它。
 *
 * `setAlwaysOnTop` 只借一下就还：常驻置顶会挡住人接下来要干的活，
 * 那是把「提醒」做成「妨碍」。
 */
export function focusMainWindow(): boolean {
  const window_ = currentWindow();
  if (!window_) return false;
  try {
    if (window_.isMinimized?.()) window_.restore?.();
    window_.show?.();
    window_.setAlwaysOnTop?.(true);
    window_.moveTop?.();
    window_.focus?.();
    window_.setAlwaysOnTop?.(false);
    return true;
  } catch {
    return false;
  }
}

/** 闪任务栏图标。人在别的全屏窗口里时，这是唯一还能被余光扫到的东西。 */
export function flashTaskbar(on: boolean): void {
  try {
    currentWindow()?.flashFrame?.(on);
  } catch {
    // 平台不支持就算了，闪不动不影响其它几路。
  }
}

/**
 * 任务栏按钮上的进度条。**这是「托盘区的提示、展示」这条诉求够得着的那一半**
 * （AME-239）：Electron 给不了插件一个真正的托盘图标——`Tray` 要在主进程里建、
 * 要一张 nativeImage，还得有人在主进程里管它的生命周期，而插件跑在渲染进程里。
 * 任务栏按钮不用这些，Windows 上一眼就看得见。
 *
 * `fraction` 传 null 表示撤掉。`mode` 走 Electron 那套：`normal` / `paused`
 * （黄）/ `error`（红）——待开工那一格用红的。
 */
export function setTaskbarProgress(fraction: number | null, mode: "normal" | "paused" | "error" = "normal"): boolean {
  const window_ = currentWindow();
  if (!window_?.setProgressBar) return false;
  try {
    if (fraction === null) {
      window_.setProgressBar(-1);
      return true;
    }
    window_.setProgressBar(Math.min(1, Math.max(0, fraction)), { mode });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 桌面悬浮框（AME-239）
//
//   「桌面上，有一个悬浮（不可点击、不可交互）的提示框？」
//
// 三条硬约束，缺一条这东西就会在一天之内被人关掉：
//   1. **点击穿透**（`setIgnoreMouseEvents`）——它盖在别人干活的地方上面，
//      挡住鼠标就是妨碍，不是提醒；
//   2. **不抢焦点**（`focusable: false` + `showInactive`）——正在打字的时候被抢焦点，
//      比没有提示还糟；
//   3. **不进任务栏、不进 Alt-Tab**（`skipTaskbar`）——它是一块贴纸，不是一个窗口。
//
// 开不出来就返回 null，由调用方退回「画在 Obsidian 窗口里」那条弱一档的路，
// 并且**把这件事说出来**——假装有存在感比没有存在感更糟。
// ---------------------------------------------------------------------------

export interface HudWindowOptions {
  html: string;
  width: number;
  height: number;
  corner: "top-right" | "top-left" | "bottom-right" | "bottom-left";
  margin: number;
  opacity: number;
}

export interface HudWindowHandle {
  readonly alive: boolean;
  /** 往那扇窗里推一份状态。页面自己会按 endsAt 走秒，所以这里只在状态变了时推 */
  update(payload: unknown): void;
  place(options: Pick<HudWindowOptions, "width" | "height" | "corner" | "margin">): void;
  setOpacity(value: number): void;
  /** 心跳：告诉贴纸「插件还活着」。停了它就会自己关掉（AME-273 第 3 条） */
  ping(): void;
  close(): void;
}

export function createHudWindow(options: HudWindowOptions): HudWindowHandle | null {
  const bridge = remoteBridge();
  const Ctor = bridge?.BrowserWindow;
  if (!Ctor) return null;

  // 开新的之前先把前任收掉：上一次退出 Obsidian 没收干净的那一扇就在这儿（AME-273 第 3 条）。
  // 不收的话这一扇会**叠在它上面**——两张贴纸，一张还停在昨天的秒数上。
  closeStrayHudWindows();

  let win: ElectronWindow | null = null;
  try {
    win = new Ctor({
      width: options.width,
      height: options.height,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      alwaysOnTop: true,
      acceptFirstMouse: false,
      title: HUD_WINDOW_TITLE,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // 这扇窗一直在后台（永远不获得焦点），不关节流的话它的秒表会被压到每分钟一跳。
        backgroundThrottling: false,
      },
    });
  } catch {
    return null;
  }
  if (!win) return null;

  const target = win;
  let alive = true;
  const dead = (): boolean => {
    if (!alive) return true;
    try {
      if (target.isDestroyed?.()) {
        alive = false;
        return true;
      }
    } catch {
      alive = false;
      return true;
    }
    return false;
  };

  try {
    target.setIgnoreMouseEvents?.(true, { forward: false });
    // screen-saver 这一级压得过全屏视频和大多数游戏——「什么窗口在前台都看得见」
    // 是这块贴纸唯一的价值。
    target.setAlwaysOnTop?.(true, "screen-saver");
    target.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
    target.setOpacity?.(clampOpacity(options.opacity));
    void target.loadURL?.(`data:text/html;charset=utf-8,${encodeURIComponent(options.html)}`);
    target.showInactive?.();
  } catch {
    try {
      target.destroy?.();
    } catch {
      // 建了一半的窗，能拆就拆，拆不掉也别把异常抛给调用方。
    }
    return null;
  }

  const handle: HudWindowHandle = {
    get alive() {
      return !dead();
    },
    update(payload: unknown): void {
      if (dead()) return;
      const code = `window.__lifeCockpitHud && window.__lifeCockpitHud(${JSON.stringify(payload)})`;
      try {
        // 页面还没加载完那几拍会失败；下一次状态变化会再推一遍，没必要重试。
        void target.webContents?.executeJavaScript?.(code)?.catch?.(() => undefined);
      } catch {
        // 窗口正在被销毁。
      }
    },
    place(place): void {
      if (dead()) return;
      const area = workArea();
      if (!area) return;
      const x =
        place.corner === "top-left" || place.corner === "bottom-left"
          ? area.x + place.margin
          : area.x + area.width - place.width - place.margin;
      const y =
        place.corner === "top-left" || place.corner === "top-right"
          ? area.y + place.margin
          : area.y + area.height - place.height - place.margin;
      try {
        target.setBounds?.({ x: Math.round(x), y: Math.round(y), width: place.width, height: place.height });
      } catch {
        // 位置摆不上就让它待在默认位置，总比没有强。
      }
    },
    setOpacity(value: number): void {
      if (dead()) return;
      try {
        target.setOpacity?.(clampOpacity(value));
      } catch {
        // 同上。
      }
    },
    ping(): void {
      if (dead()) return;
      try {
        void target.webContents
          ?.executeJavaScript?.("window.__lifeCockpitAlive && window.__lifeCockpitAlive()")
          ?.catch?.(() => undefined);
      } catch {
        // 页面还没加载完 / 窗口正在销毁。下一拍会再敲一次。
      }
    },
    close(): void {
      if (dead()) return;
      alive = false;
      try {
        target.destroy?.();
      } catch {
        // 已经没了。
      }
    },
  };

  handle.place(options);
  return handle;
}

/**
 * 把散在系统里的孤儿贴纸收掉，返回收了几扇（AME-273 第 3 条）。
 *
 * 「退出 Obsidian 之后贴纸还在、再打开就变成两张」——那一张就是孤儿：进程没退，
 * 窗还在，而认领它的那个插件实例早没了。**认记号、且只认全等的标题**：
 * 收窗不可逆，宁可漏收也不能误杀人家的主窗，所以这里既不做前缀匹配，
 * 也绝不碰当前这扇窗（`getCurrentWindow`）——那是 Obsidian 自己。
 */
export function closeStrayHudWindows(): number {
  const bridge = remoteBridge();
  const all = bridge?.BrowserWindow?.getAllWindows?.();
  if (!all || !Array.isArray(all)) return 0;

  const selfId = (() => {
    try {
      return currentWindow()?.id ?? null;
    } catch {
      return null;
    }
  })();

  let closed = 0;
  for (const win of all) {
    try {
      if (win.isDestroyed?.()) continue;
      if (selfId !== null && win.id === selfId) continue;
      if (!isHudWindowTitle(win.getTitle?.())) continue;
      // 第二道判据：贴纸整页跑在一个 `data:` URL 上，Obsidian 自己的窗不可能是。
      // 老版本留下的孤儿窗标题是「人生驾驶舱」这种大路货，光靠标题万一撞上
      // 人家改过标题的笔记窗就糟了；拿不到 URL 时（老版本 remote）退回只认标题。
      const url = win.webContents?.getURL?.();
      if (typeof url === "string" && url && !url.startsWith("data:")) continue;
      win.destroy?.();
      closed += 1;
    } catch {
      // 拆不掉就算了：一扇拆不掉的窗不该拦住后面几扇。
    }
  }
  return closed;
}

/** 主屏的可用区域（去掉任务栏）。拿不到就返回 null，悬浮框留在默认位置。 */
function workArea(): DisplayRect | null {
  try {
    const area = remoteBridge()?.screen?.getPrimaryDisplay?.()?.workArea;
    if (!area || typeof area.width !== "number" || typeof area.height !== "number") return null;
    return area;
  } catch {
    return null;
  }
}

function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0.2, value));
}

/**
 * 关掉后台节流。**这一条不做，整个强制干扰在最需要它的时刻就是哑的。**
 *
 * Chromium 对隐藏页面的定时器有两级节流：先压到每秒一次，五分钟后进入
 * intensive throttling——每分钟一次。而「人切走了、Obsidian 在后台」正是
 * 连击和催促要跑的场景。关掉之后这个窗口的定时器照常走。
 *
 * 代价是这个窗口在后台也照常耗电。只在强制干扰开着时关，插件卸载时还回去。
 */
export function setBackgroundThrottling(allowed: boolean): boolean {
  const window_ = currentWindow();
  if (!window_?.webContents?.setBackgroundThrottling) return false;
  try {
    window_.webContents.setBackgroundThrottling(allowed);
    return true;
  } catch {
    return false;
  }
}

/** 用系统默认浏览器打开一个地址。督促自律网页走的就是它。 */
export async function openExternal(url: string): Promise<boolean> {
  const shell = nodeRequire<{ shell?: { openExternal?: (target: string) => Promise<void> } }>(
    "electron",
  )?.shell;
  try {
    if (shell?.openExternal) {
      await shell.openExternal(url);
      return true;
    }
  } catch {
    // 往下退到 window.open。
  }
  try {
    window.open(url, "_blank");
    return true;
  } catch {
    return false;
  }
}

/** 这台机器上强制干扰能用到哪一步。设置面板原样显示，别让人猜。 */
export function describeDesktopBridge(): string {
  const parts: string[] = [];
  parts.push(systemIdleMs() === null ? "系统空闲探测：PowerShell 兜底" : "系统空闲探测：Electron");
  parts.push(currentWindow() ? "窗口置顶 / 闪烁：可用" : "窗口置顶 / 闪烁：拿不到窗口");
  parts.push(
    currentWindow()?.setProgressBar ? "任务栏进度：可用" : "任务栏进度：不可用",
  );
  parts.push(remoteBridge()?.BrowserWindow ? "桌面悬浮框：可用" : "桌面悬浮框：开不出来");
  return parts.join(" · ");
}

/** `darwin` / `win32` / `linux`；认不出来时返回 `unknown`，锁屏那边按不支持处理。 */
export function currentPlatform(): string {
  try {
    if (typeof process !== "undefined" && typeof process.platform === "string") {
      return process.platform;
    }
  } catch {
    // 非 Electron 环境下 process 可能整个不存在。
  }
  return "unknown";
}

export interface RunResult {
  ok: boolean;
  detail: string;
  /** 命令的标准输出。空闲探测、亮度探测靠它读数 */
  stdout: string;
}

/**
 * 跑一条外部命令。**execFile 而不是 exec**：参数按数组传，
 * macOS 那条 CGSession 路径里带空格，拼 shell 串迟早出事。
 */
export async function runCommand(file: string, args: string[]): Promise<RunResult> {
  const child = nodeRequire<ChildProcessModule>("child_process");
  if (!child) {
    return { ok: false, detail: "这个环境里拿不到 child_process，跑不了外部命令。", stdout: "" };
  }

  return new Promise<RunResult>((resolve) => {
    try {
      child.execFile(file, args, (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, detail: stderr.trim() || error.message, stdout: stdout ?? "" });
          return;
        }
        resolve({ ok: true, detail: "", stdout: stdout ?? "" });
      });
    } catch (error) {
      resolve({
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        stdout: "",
      });
    }
  });
}

interface ChildProcessModule {
  execFile: (
    file: string,
    args: string[],
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => { kill?: (signal?: string) => void };
  spawn?: (
    file: string,
    args: string[],
    options: Record<string, unknown>,
  ) => { kill?: (signal?: string) => void; on?: (event: string, listener: () => void) => void };
}

/** 一条还在跑的命令。强制干扰随时要能把它掐掉，所以句柄要拿在手上。 */
export interface RunHandle {
  kill(): void;
  readonly running: boolean;
}

/**
 * 起一条**长命令**并把句柄交出来。亮度闪烁的那段 PowerShell 会跑上几分钟，
 * 人一旦复工就得当场停——所以不能用 `runCommand` 那种等它跑完的形状。
 *
 * 拿不到 child_process 时返回 null，调用方按「这台机器上做不到」处理。
 */
export function startCommand(file: string, args: string[]): RunHandle | null {
  const child = nodeRequire<ChildProcessModule>("child_process");
  if (!child?.spawn) return null;
  try {
    const proc = child.spawn(file, args, { windowsHide: true, stdio: "ignore" });
    let alive = true;
    proc.on?.("exit", () => {
      alive = false;
    });
    proc.on?.("error", () => {
      alive = false;
    });
    return {
      kill: () => {
        if (!alive) return;
        alive = false;
        try {
          proc.kill?.();
        } catch {
          // 已经退了就算了。
        }
      },
      get running() {
        return alive;
      },
    };
  } catch {
    return null;
  }
}

/**
 * 飞书签名用的 HMAC-SHA256（base64）。密钥当 key、空串当消息，是飞书那边的规矩。
 *
 * 算不出来就返回 null——**宁可不发，也不发一条签名是空的请求**：
 * 那种请求会被飞书拒掉，然后在日志里留下一条看不懂的 19021。
 */
export function hmacSha256Base64(key: string): string | null {
  const crypto = nodeRequire<{
    createHmac: (algorithm: string, key: string) => { update(data: string): { digest(encoding: string): string } };
  }>("crypto");
  if (!crypto) return null;
  try {
    return crypto.createHmac("sha256", key).update("").digest("base64");
  } catch {
    return null;
  }
}
