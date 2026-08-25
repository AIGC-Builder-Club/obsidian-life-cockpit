'use strict';

// 人在不在：两种「在」分得开吗，探测不到时会不会把人判成在。

const test = require('node:test');
const assert = require('node:assert');
const core = require('./.build/core.js');

const NOW = 1_700_000_000_000;

function settings(patch = {}) {
  return { enforceIdleSeconds: 60, gateRequireAttention: true, ...patch };
}

function sample(patch = {}) {
  return {
    now: NOW,
    focused: true,
    visible: true,
    lastInputAt: NOW - 1000,
    systemIdleMs: 1000,
    ...patch,
  };
}

// ---------------------------------------------------------------------------
// 两种「在」
// ---------------------------------------------------------------------------

test('窗口在前台、刚有输入：既在电脑前，也在看这一页', () => {
  const verdict = core.evaluateAttention(sample(), settings());
  assert.strictEqual(verdict.atKeyboard, true);
  assert.strictEqual(verdict.attending, true);
  assert.strictEqual(verdict.reason, null);
});

test('人在别的窗口里敲字：在电脑前，但不在看这一页', () => {
  const verdict = core.evaluateAttention(
    sample({ focused: false, lastInputAt: NOW - 600_000, systemIdleMs: 2000 }),
    settings(),
  );
  assert.strictEqual(verdict.atKeyboard, true, '系统刚有输入，人就在电脑前');
  assert.strictEqual(verdict.attending, false);
  assert.strictEqual(verdict.reason, 'blurred');
});

test('窗口最小化：不在看，理由是被遮住', () => {
  const verdict = core.evaluateAttention(sample({ visible: false }), settings());
  assert.strictEqual(verdict.attending, false);
  assert.strictEqual(verdict.reason, 'hidden');
});

test('AME-238 那两个小时：Obsidian 停在前台，但人早就走了', () => {
  // 窗口一直是前台、一直可见——0.6.x 只看这两样，于是把人判成「在看」。
  const verdict = core.evaluateAttention(
    sample({ lastInputAt: NOW - 2 * 3600_000, systemIdleMs: 2 * 3600_000 }),
    settings(),
  );
  assert.strictEqual(verdict.atKeyboard, false);
  assert.strictEqual(verdict.attending, false);
  assert.strictEqual(verdict.reason, 'system-idle');
  assert.strictEqual(verdict.idleMs, 2 * 3600_000);
});

test('空闲阈值就是分界线：差一毫秒还算在，到了就不算', () => {
  const config = settings({ enforceIdleSeconds: 60 });
  const almost = core.evaluateAttention(sample({ systemIdleMs: 59_999 }), config);
  const over = core.evaluateAttention(sample({ systemIdleMs: 60_000 }), config);
  assert.strictEqual(almost.atKeyboard, true);
  assert.strictEqual(over.atKeyboard, false);
});

// ---------------------------------------------------------------------------
// 探测不到系统空闲时
// ---------------------------------------------------------------------------

test('系统探测拿不到就退回窗口内输入，理由说的是「这个窗口里没输入」', () => {
  const verdict = core.evaluateAttention(
    sample({ systemIdleMs: null, lastInputAt: NOW - 300_000 }),
    settings(),
  );
  assert.strictEqual(verdict.idleMs, 300_000);
  assert.strictEqual(verdict.attending, false);
  assert.strictEqual(verdict.reason, 'no-input');
});

test('从没输入过 = 空闲无穷大，不会被当成「刚刚还在动」', () => {
  const verdict = core.evaluateAttention(
    sample({ systemIdleMs: null, lastInputAt: null }),
    settings(),
  );
  assert.strictEqual(verdict.atKeyboard, false);
  assert.strictEqual(verdict.idleMs, Number.POSITIVE_INFINITY);
});

test('系统探测优先于窗口输入：窗口里半天没动，但人在别处敲着', () => {
  const verdict = core.evaluateAttention(
    sample({ lastInputAt: NOW - 600_000, systemIdleMs: 500 }),
    settings(),
  );
  assert.strictEqual(verdict.idleMs, 500);
  assert.strictEqual(verdict.atKeyboard, true);
  assert.strictEqual(verdict.attending, true, '窗口在前台 + 系统刚有输入 = 在看');
});

// ---------------------------------------------------------------------------
// 兜底探测脚本
// ---------------------------------------------------------------------------

test('空闲探测脚本读的是 GetLastInputInfo，出岔子输出 -1', () => {
  assert.match(core.IDLE_PROBE_SCRIPT, /GetLastInputInfo/);
  assert.match(core.IDLE_PROBE_SCRIPT, /user32\.dll/);
  assert.match(core.IDLE_PROBE_SCRIPT, /catch \{ -1 \}/);
});

test('探测输出：数字照收，-1 和乱码都是 null——不能读成 0', () => {
  assert.strictEqual(core.parseIdleProbe('12345\r\n'), 12345);
  assert.strictEqual(core.parseIdleProbe('  0 '), 0);
  assert.strictEqual(core.parseIdleProbe('-1'), null);
  assert.strictEqual(core.parseIdleProbe('Add-Type : 无法加载'), null);
  assert.strictEqual(core.parseIdleProbe(''), null);
});

test('多行输出取最后一行：PowerShell 的警告不该被读成空闲时间', () => {
  assert.strictEqual(core.parseIdleProbe('WARNING: something\n4200\n'), 4200);
});

// ---------------------------------------------------------------------------
// 说给人听
// ---------------------------------------------------------------------------

test('三种状态各有各的说法', () => {
  const here = core.describeAttention(core.evaluateAttention(sample(), settings()));
  const elsewhere = core.describeAttention(
    core.evaluateAttention(sample({ focused: false }), settings()),
  );
  const gone = core.describeAttention(
    core.evaluateAttention(sample({ systemIdleMs: 7200_000, lastInputAt: NOW - 7200_000 }), settings()),
  );
  assert.match(here, /在看这一页/);
  assert.match(elsewhere, /人在电脑前/);
  assert.match(gone, /不在电脑前/);
});
