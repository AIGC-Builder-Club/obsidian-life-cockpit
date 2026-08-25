import { Notice } from "obsidian";
import {
  BRIGHTNESS_PROBE_SCRIPT,
  brightnessScript,
  flickerScript,
  parseBrightnessProbe,
  planFlicker,
  powerShellArgs,
} from "./core/brightness";
import type { EnforceReason } from "./core/enforce";
import type { LifeCockpitSettings } from "./core/settings";
import {
  currentPlatform,
  flashTaskbar,
  runCommand,
  startCommand,
  type RunHandle,
} from "./desktop";

/**
 * 干扰的执行侧。**决定「什么时候吵」的是 core/enforce.ts，这里只管「怎么吵」。**
 *
 * 一次干扰同时开四路，缺一路都会被绕开：
 *
 * | 路 | 治的是什么 | 绕不过去的原因 |
 * | --- | --- | --- |
 * | 高频系统通知 | 人在别的窗口 | 通知中心里排着，切回来一眼看见 |
 * | 蜂鸣 | 人背对着屏幕 | 声音不挑视线方向 |
 * | 屏幕亮度缓速闪烁 | 人在看别的窗口 | 亮度是整块屏幕的，跟哪个窗口在前台无关 |
 * | 任务栏闪烁 + 遮罩闪烁 | 亮度调不动的机器（外接显示器） | 兜底，不让这台机器整条哑掉 |
 *
 * 三条实现上的硬约束：
 *
 * 1. **连击不走 PushHub。** 推动器那五道闸（冷却 10 分钟、每天 24 条）是为了
 *    「别把人吵到把功能关掉」，按每条消息算冷却——3 分钟的连击到它手里会被掐成 1 条。
 *    强制干扰是人自己点名要的吵闹，所以直接走 Notification，闸门只留一道：
 *    人明确按下的静音（`enforceRespectMute`）。
 * 2. **同一个 tag + renotify。** 90 条独立通知会把 Windows 通知中心刷成一整屏，
 *    第二天人就会去系统里把 Obsidian 的通知整个关掉——那才是真的失去这一路。
 *    同 tag 替换 + renotify 重新提示：每次都响、但只留一条。
 * 3. **亮度被打断必须还原。** 闪烁进程是被 kill 掉的，PowerShell 没机会跑到
 *    结尾那句还原——所以杀完由这边补一条还原命令。不补的话人会得到一块
 *    停在 20% 亮度的屏幕，而且完全不知道是谁干的。
 */
/**
 * 弹一条系统通知，弹不出来退回窗口内提示。**强制干扰和心跳提醒共用这一条**
 * （AME-239 的心跳同样绕开 PushHub，理由和上面第 1 条一样）。
 *
 * `tag` 决定「替换谁」：同一个 tag 的新通知会顶掉旧的，所以每一路各用各的 tag——
 * 心跳把干扰顶掉，或者反过来，都会让通知中心里少一条本该被看见的东西。
 */
export function systemNotify(title: string, body: string, tag: string): void {
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    try {
      new Notification(title, {
        body,
        // 同一个 tag：新的一条替换旧的，通知中心里始终只有一条。
        tag,
        // 替换的同时**重新提示**——不加这一条，替换是静默的，等于没响。
        renotify: true,
        silent: false,
      } as NotificationOptions);
      return;
    } catch {
      // 弹不出来就退回窗口内提示，别把这一拍丢了。
    }
  }
  new Notice(`${title}\n${body}`, 2000);
}

export interface AlarmSpec {
  reason: EnforceReason;
  durationMs: number;
  title: string;
  body: string;
  /** 静音：不弹通知、不响，只闪 */
  silent: boolean;
}

export interface AlarmDeps {
  settings: () => LifeCockpitSettings;
  /** 遮罩闪烁的开关。亮度调不动的机器上，这是唯一还看得见的干扰 */
  onFlash: (active: boolean) => void;
}

export class AlarmRunner {
  private deps: AlarmDeps;
  private timer: number | null = null;
  private stopAt = 0;
  private spec: AlarmSpec | null = null;
  private flicker: RunHandle | null = null;
  /** 闪烁开始前的亮度，被打断时还原到它 */
  private restoreLevel = 100;
  /**
   * 这台机器的亮度探测结果：`undefined` = 还没探过，`null` = 调不动。
   * 探一次就够——外接显示器的台式机上这条路永远不通，每次都探纯属浪费。
   */
  private brightness: number | null | undefined = undefined;
  /** 亮度调不动这件事只说一次，不要每一轮都念一遍 */
  private warnedNoBrightness = false;

  constructor(deps: AlarmDeps) {
    this.deps = deps;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** 正在响的这一轮是为什么开的；没响就是 null。面板上显示它 */
  get reason(): EnforceReason | null {
    return this.spec?.reason ?? null;
  }

  start(spec: AlarmSpec): void {
    this.stop();
    this.spec = spec;
    this.stopAt = Date.now() + Math.max(1000, spec.durationMs);

    const settings = this.deps.settings();
    const intervalMs = Math.max(1000, Math.round(settings.enforceBurstSeconds * 1000));

    // 第一声立刻响。等一个间隔再响的话，1 秒的番茄尾巴就什么都没赶上。
    this.beat();
    this.timer = window.setInterval(() => this.beat(), intervalMs);

    this.deps.onFlash(true);
    void this.startFlicker(spec.durationMs);
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.spec = null;
    this.deps.onFlash(false);
    flashTaskbar(false);
    this.stopFlicker();
  }

  /** 一拍：弹一条通知 + 闪一下任务栏。到点自己收摊。 */
  private beat(): void {
    const spec = this.spec;
    if (!spec) return;
    if (Date.now() >= this.stopAt) {
      this.stop();
      return;
    }
    if (spec.silent) return;

    flashTaskbar(true);
    this.notify(spec);
  }

  private notify(spec: AlarmSpec): void {
    systemNotify(`【强制干扰】${spec.title}`, spec.body, "life-cockpit-alarm");
  }

  // -------------------------------------------------------------------------
  // 屏幕亮度（Windows）
  // -------------------------------------------------------------------------

  private async startFlicker(durationMs: number): Promise<void> {
    const settings = this.deps.settings();
    if (!settings.enforceFlicker) return;
    // Win10 一端先做稳（AME-238 原话）。macOS 的亮度要走另一套（IOKit / 第三方
    // 命令行），没在真机上验过的命令不写进来充数——那一端就是「暂时做不到」。
    if (currentPlatform() !== "win32") return;

    const level = await this.probeBrightness();
    if (level === null) {
      if (!this.warnedNoBrightness) {
        this.warnedNoBrightness = true;
        new Notice(
          "这台机器的屏幕亮度调不动（WMI 只管内置显示器，外接屏走 DDC/CI）。" +
            "强制干扰改用遮罩闪烁 + 任务栏闪烁兜底。",
        );
      }
      return;
    }

    this.restoreLevel = level;
    const plan = planFlicker(settings, durationMs, level);
    plan.beep = settings.enforceBeep && !(this.spec?.silent ?? false);
    this.flicker = startCommand("powershell.exe", powerShellArgs(flickerScript(plan)));
  }

  private stopFlicker(): void {
    if (!this.flicker) return;
    const running = this.flicker.running;
    this.flicker.kill();
    this.flicker = null;
    // 被杀掉的进程跑不到脚本结尾那句还原，所以在这儿补一条。
    if (running && currentPlatform() === "win32") {
      void runCommand("powershell.exe", powerShellArgs(brightnessScript(this.restoreLevel)));
    }
  }

  /**
   * 探一次亮度，结果缓存。返回当前亮度，`null` = 这台机器调不动。
   *
   * **缓存不只是为了省一次进程**：还原要还原到「第一次闪之前」那一档。
   * 每轮重探的话，某一轮恰好在上一轮还没还原完时探到一个暗值，
   * 之后每次「还原」都会把屏幕还原成暗的——而且人根本不知道是谁干的。
   * 手动改过系统亮度想让它重新认一次的，按设置页里的「测一次亮度」。
   */
  async probeBrightness(force = false): Promise<number | null> {
    if (!force && this.brightness !== undefined) return this.brightness;
    if (currentPlatform() !== "win32") {
      this.brightness = null;
      return null;
    }
    const result = await runCommand("powershell.exe", powerShellArgs(BRIGHTNESS_PROBE_SCRIPT));
    this.brightness = result.ok ? parseBrightnessProbe(result.stdout) : null;
    return this.brightness;
  }

  /** 设置面板上那句「这台机器亮度调不调得动」。 */
  describeBrightness(): string {
    if (currentPlatform() !== "win32") {
      return "亮度闪烁目前只做了 Windows（WMI）。这台机器上走遮罩闪烁兜底。";
    }
    if (this.brightness === undefined) return "还没探过。按一下「测一次」当场看结果。";
    if (this.brightness === null) {
      return "调不动：WMI 只认内置显示器，外接屏要走 DDC/CI。改用遮罩 + 任务栏闪烁兜底。";
    }
    return `调得动，当前亮度 ${this.brightness}%。`;
  }
}
