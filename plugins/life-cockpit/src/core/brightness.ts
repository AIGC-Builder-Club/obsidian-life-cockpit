// 屏幕亮度的缓速闪烁——强制干扰里唯一「屏幕本身」参与的一环。
//
// 出处是仓库主人自己古法手搓的那一套（AME-238）：
//
//   临近番茄钟执行完时，3 分钟的高频系统通知 + 系统亮度渐变切换调整
//   （形成一种缓速闪烁的干扰效果，比如 100 - 80 - 60 - 40 - 20 - 0 - 20 - 40 - 60 - 80 - 100）
//
// 为什么是亮度而不是又一个弹窗：**弹窗是可以不看的，屏幕暗下去是躲不开的。**
// 人切到浏览器、切到微信，通知全在通知中心里排队；而整块屏幕一亮一暗，
// 不管人当时在看哪个窗口都会被拽一下。这就是「强制干扰」四个字的物理落点。
//
// Windows 10 的落点是 WMI：
//   (Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1, 60)
// 它只管**内置显示器**（笔记本屏、一体机）。外接显示器走的是 DDC/CI，WMI 够不着——
// 那种机器上这一路会直接报「不支持」，由调用方退回遮罩闪烁，不假装成功。
//
// 命令一律走 `-EncodedCommand`（UTF-16LE + base64），不拼引号：
// PowerShell 脚本里到处是 `$`、`@'`、括号和引号，拼进命令行迟早被某一层再解释一次。
// 编码之后整条命令就是一个没有空格的 token，谁都不会再动它。

export interface FlickerSettings {
  enforceFlicker: boolean;
  /** 波谷亮度（%）。0 = 全黑，最刺眼也最有效 */
  enforceFlickerLow: number;
  /** 波峰亮度（%） */
  enforceFlickerHigh: number;
  /** 每一档停留多少毫秒。太快像坏了，太慢没有干扰感 */
  enforceFlickerStepMs: number;
}

export interface FlickerPlan {
  /** 一个完整周期的亮度序列（不含回到波峰那一下，循环时它就是下一圈的第一档） */
  levels: number[];
  stepMs: number;
  /** 跑几圈。由总时长除以一圈的时长算出来，至少 1 圈 */
  cycles: number;
  /** 跑完 / 被打断后把亮度还原到哪一档 */
  restoreLevel: number;
  /** 每一档要不要顺带响一声 */
  beep: boolean;
}

const MIN_STEP_MS = 60;

/**
 * 一个周期的亮度序列：波峰 → 波谷 → 回到波峰前一档。
 *
 * 例：high=100, low=0, step=20 → `[100, 80, 60, 40, 20, 0, 20, 40, 60, 80]`。
 * **末尾不重复波峰**——循环播放时下一圈的第一档就是它，重复一下会在最亮处卡两拍，
 * 波形立刻就不匀了。
 */
export function flickerLevels(high: number, low: number, step = 20): number[] {
  const top = clampPercent(high);
  const bottom = clampPercent(low);
  if (top <= bottom) return [top];
  const stride = Math.max(1, Math.round(Math.abs(step)));

  const down: number[] = [];
  for (let level = top; level > bottom; level -= stride) down.push(level);
  down.push(bottom);

  const up: number[] = [];
  for (let index = down.length - 2; index >= 1; index -= 1) up.push(down[index]);
  return [...down, ...up];
}

/**
 * 排一次闪烁。`durationMs` 是「至少闪这么久」——按整周期取整，
 * 宁可多闪半圈也不要停在半途的暗档上。
 */
export function planFlicker(
  settings: FlickerSettings,
  durationMs: number,
  restoreLevel: number,
): FlickerPlan {
  const levels = flickerLevels(settings.enforceFlickerHigh, settings.enforceFlickerLow);
  const stepMs = Math.max(MIN_STEP_MS, Math.round(settings.enforceFlickerStepMs));
  const cycleMs = Math.max(1, levels.length * stepMs);
  const cycles = Math.max(1, Math.ceil(Math.max(0, durationMs) / cycleMs));
  return { levels, stepMs, cycles, restoreLevel: clampPercent(restoreLevel), beep: false };
}

/**
 * 闪烁脚本。**一个 PowerShell 进程跑完整段闪烁**，而不是每一档起一个进程：
 *
 *   1. 起一次 PowerShell 要 200–400 毫秒，每 400 毫秒一档的话根本排不上；
 *   2. 更要紧的是**扛得住 Chromium 的后台节流**。人切走之后 Obsidian 窗口是隐藏的，
 *      渲染进程里的 setInterval 会被压到每秒一次、五分钟后压到每分钟一次——
 *      而「人切走了」恰恰是最需要这段干扰的时刻。脚本自己带着 Start-Sleep 跑，
 *      不看 JS 那边的脸色。
 *
 * 被中途叫停时进程会被杀掉，**亮度就停在当时那一档**——所以调用方杀完必须补一条
 * 还原命令（`brightnessScript`）。脚本自己也在结尾还原一次，管的是正常跑完那一路。
 */
export function flickerScript(plan: FlickerPlan): string {
  const levels = plan.levels.join(",");
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    // 多显示器时 Get-WmiObject 给的是一组；逐个设，能设几块设几块。
    "$monitors = @(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods)",
    `$levels = @(${levels})`,
    `for ($cycle = 0; $cycle -lt ${plan.cycles}; $cycle++) {`,
    "  foreach ($level in $levels) {",
    "    foreach ($monitor in $monitors) { try { $monitor.WmiSetBrightness(1, $level) | Out-Null } catch { } }",
    plan.beep ? "    try { [console]::beep(880, 120) } catch { }" : "",
    `    Start-Sleep -Milliseconds ${plan.stepMs}`,
    "  }",
    "}",
    `foreach ($monitor in $monitors) { try { $monitor.WmiSetBrightness(1, ${plan.restoreLevel}) | Out-Null } catch { } }`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** 把亮度一次性设到某一档。中途叫停之后的还原走的就是它。 */
export function brightnessScript(level: number): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$monitors = @(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods)",
    `foreach ($monitor in $monitors) { try { $monitor.WmiSetBrightness(1, ${clampPercent(level)}) | Out-Null } catch { } }`,
  ].join("\n");
}

/**
 * 探一次：这台机器的亮度调不调得动、现在是多少。
 *
 * 只探一次、结果缓存起来：外接显示器的台式机上这条路永远不通，
 * 每次闪烁前都探一遍纯属浪费。探不到就输出 `LC-NONE`，由调用方退回遮罩闪烁——
 * **不支持要当场说出来**，比闪了半天屏幕纹丝不动强。
 */
export const BRIGHTNESS_PROBE_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$current = @(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightness)",
  "if ($current.Count -eq 0) { 'LC-NONE' } else { $current[0].CurrentBrightness }",
].join("\n");

/** 解析探测输出：数字 = 当前亮度，null = 这台机器调不动。 */
export function parseBrightnessProbe(stdout: string): number | null {
  const line = stdout.trim().split(/\r?\n/).pop() ?? "";
  if (!/^\d+$/.test(line.trim())) return null;
  return clampPercent(Number(line.trim()));
}

// ---------------------------------------------------------------------------
// PowerShell 命令行
// ---------------------------------------------------------------------------

/** 一条 `-EncodedCommand` 的完整参数表。execFile 的第二个参数直接用它。 */
export function powerShellArgs(script: string): string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    "-EncodedCommand",
    encodePowerShellCommand(script),
  ];
}

/**
 * `-EncodedCommand` 要的是 **UTF-16LE 的 base64**，不是 UTF-8 的。
 *
 * 自己写而不是用 `Buffer`：core 下不许碰 node 内建模块（`node --test` 里
 * 打的是浏览器目标的包），而且这样这段编码本身也能被测——编码错了的表现是
 * PowerShell 报一句看不懂的语法错，排查起来比多写二十行贵得多。
 */
export function encodePowerShellCommand(script: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < script.length; index += 1) {
    const unit = script.charCodeAt(index);
    bytes.push(unit & 0xff, (unit >> 8) & 0xff);
  }
  return base64(bytes);
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64(bytes: number[]): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index];
    const b1 = bytes[index + 1];
    const b2 = bytes[index + 2];
    out += BASE64_ALPHABET[b0 >> 2];
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : BASE64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : BASE64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}
