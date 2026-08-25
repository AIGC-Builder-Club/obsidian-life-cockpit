'use strict';

// 亮度闪烁：波形对不对、脚本会不会还原、PowerShell 编码对不对。

const test = require('node:test');
const assert = require('node:assert');
const core = require('./.build/core.js');

function settings(patch = {}) {
  return {
    enforceFlicker: true,
    enforceFlickerLow: 0,
    enforceFlickerHigh: 100,
    enforceFlickerStepMs: 400,
    ...patch,
  };
}

// ---------------------------------------------------------------------------
// 波形
// ---------------------------------------------------------------------------

test('默认波形就是原话里那一串：100 → 0 → 回头', () => {
  assert.deepStrictEqual(
    core.flickerLevels(100, 0, 20),
    [100, 80, 60, 40, 20, 0, 20, 40, 60, 80],
  );
});

test('末尾不重复波峰：循环时下一圈的第一档就是它', () => {
  const levels = core.flickerLevels(100, 0, 20);
  assert.notStrictEqual(levels[levels.length - 1], levels[0]);
});

test('步长除不尽时谷底照样到底', () => {
  const levels = core.flickerLevels(100, 0, 30);
  assert.strictEqual(levels[0], 100);
  assert.ok(levels.includes(0), '不管怎么除，最暗那一档必须真的到 0');
});

test('波峰不高于波谷时退化成一档，不产生负数亮度', () => {
  assert.deepStrictEqual(core.flickerLevels(30, 60), [30]);
  assert.deepStrictEqual(core.flickerLevels(50, 50), [50]);
});

test('超出 0–100 的输入被夹住', () => {
  const levels = core.flickerLevels(500, -20, 20);
  assert.strictEqual(levels[0], 100);
  assert.ok(levels.every((level) => level >= 0 && level <= 100));
});

// ---------------------------------------------------------------------------
// 排期
// ---------------------------------------------------------------------------

test('按整周期取整：三分钟的连击排满整圈，不停在半途的暗档上', () => {
  const plan = core.planFlicker(settings(), 180_000, 70);
  // 一圈 10 档 × 400 毫秒 = 4 秒；180 秒 = 45 圈。
  assert.strictEqual(plan.cycles, 45);
  assert.strictEqual(plan.stepMs, 400);
  assert.strictEqual(plan.restoreLevel, 70);
});

test('再短的时长也至少跑一圈', () => {
  assert.strictEqual(core.planFlicker(settings(), 0, 100).cycles, 1);
  assert.strictEqual(core.planFlicker(settings(), -5, 100).cycles, 1);
});

test('每档停留有下限：不许把屏幕搞成频闪', () => {
  assert.strictEqual(core.planFlicker(settings({ enforceFlickerStepMs: 5 }), 10_000, 100).stepMs, 60);
});

// ---------------------------------------------------------------------------
// 脚本
// ---------------------------------------------------------------------------

test('闪烁脚本：走 WMI、逐块显示器设、跑完还原到开始前那一档', () => {
  const script = core.flickerScript(core.planFlicker(settings(), 8000, 65));
  assert.match(script, /WmiMonitorBrightnessMethods/);
  assert.match(script, /WmiSetBrightness\(1, \$level\)/);
  assert.match(script, /WmiSetBrightness\(1, 65\)/, '结尾必须还原');
  assert.match(script, /Start-Sleep -Milliseconds 400/);
  assert.match(script, /foreach \(\$monitor in \$monitors\)/, '多显示器要逐块设');
});

test('蜂鸣是可选的，默认不响', () => {
  const plan = core.planFlicker(settings(), 8000, 100);
  assert.doesNotMatch(core.flickerScript(plan), /console\]::beep/);
  assert.match(core.flickerScript({ ...plan, beep: true }), /console\]::beep/);
});

test('还原脚本只设一次，不带循环', () => {
  const script = core.brightnessScript(42);
  assert.match(script, /WmiSetBrightness\(1, 42\)/);
  assert.doesNotMatch(script, /Start-Sleep/);
});

test('探测脚本：读不到显示器就输出 LC-NONE', () => {
  assert.match(core.BRIGHTNESS_PROBE_SCRIPT, /WmiMonitorBrightness\b/);
  assert.match(core.BRIGHTNESS_PROBE_SCRIPT, /LC-NONE/);
});

test('探测输出：数字是当前亮度，LC-NONE 和乱码都是「调不动」', () => {
  assert.strictEqual(core.parseBrightnessProbe('75\r\n'), 75);
  assert.strictEqual(core.parseBrightnessProbe('LC-NONE'), null);
  assert.strictEqual(core.parseBrightnessProbe(''), null);
  assert.strictEqual(core.parseBrightnessProbe('Get-WmiObject : 不支持'), null);
});

// ---------------------------------------------------------------------------
// PowerShell 命令行
// ---------------------------------------------------------------------------

test('参数表走 -EncodedCommand，不拼引号', () => {
  const args = core.powerShellArgs("Write-Output 'hi'");
  assert.ok(args.includes('-EncodedCommand'));
  assert.ok(args.includes('-NoProfile'));
  assert.ok(args.includes('-NonInteractive'));
  // 编码之后整条命令是一个没有空格的 token，不会被哪一层再解释一次。
  const encoded = args[args.length - 1];
  assert.doesNotMatch(encoded, /\s/);
});

test('编码就是 PowerShell 要的 UTF-16LE + base64', () => {
  const encoded = core.encodePowerShellCommand("Write-Output 'hi'");
  assert.strictEqual(
    Buffer.from(encoded, 'base64').toString('utf16le'),
    "Write-Output 'hi'",
  );
});

test('长度不是 3 的倍数时补等号补得对', () => {
  for (const text of ['a', 'ab', 'abc', 'abcd', '亮度']) {
    assert.strictEqual(
      Buffer.from(core.encodePowerShellCommand(text), 'base64').toString('utf16le'),
      text,
      `${text} 编解码要能对上`,
    );
  }
});

test('整段闪烁脚本编码后能原样解回来', () => {
  const script = core.flickerScript(core.planFlicker(settings(), 60_000, 80));
  assert.strictEqual(
    Buffer.from(core.encodePowerShellCommand(script), 'base64').toString('utf16le'),
    script,
  );
});
