'use strict';

// 强制休息与系统级锁屏：平台命令表、什么时候提议、倒计时 / 推迟 / 今天豁免。
// 这里一条子进程都不真的起——命令表本身是纯数据，spawn 那一下在 main.ts。

const test = require('node:test');
const assert = require('node:assert');
const core = require('./.build/core.js');

const DAY = '2026-08-11';
const NOW = 1_700_000_000_000;

function settings(patch = {}) {
  return {
    lockEnabled: true,
    lockTrigger: 'long-break',
    lockCountdownSeconds: 20,
    lockMethod: 'auto',
    lockDeferMinutes: 10,
    ...patch,
  };
}

function offer(patch = {}) {
  return {
    settings: settings(patch.settings),
    state: patch.state ?? core.createLockState(),
    kind: patch.kind ?? 'long-break',
    segmentKey: patch.segmentKey ?? 'long-break-4-1700000000000',
    day: patch.day ?? DAY,
    now: patch.now ?? NOW,
    supported: patch.supported ?? true,
  };
}

// ---------------------------------------------------------------------------
// 平台分支
// ---------------------------------------------------------------------------

test('macOS 默认走 CGSession，参数是数组不是拼出来的 shell 串', () => {
  const command = core.lockCommandFor('darwin');
  assert.strictEqual(command.id, 'mac-cgsession');
  assert.match(command.file, /CGSession$/);
  assert.deepStrictEqual(command.args, ['-suspend']);
  assert.ok(command.file.includes(' '), '路径里本来就有空格，正是不能拼 shell 串的原因');
});

test('Windows 走 rundll32 LockWorkStation', () => {
  const command = core.lockCommandFor('win32');
  assert.strictEqual(command.id, 'win-lockworkstation');
  assert.strictEqual(command.file, 'rundll32.exe');
  assert.deepStrictEqual(command.args, ['user32.dll,LockWorkStation']);
});

test('Linux 与不认识的平台：给不出命令，且明说做不到', () => {
  assert.strictEqual(core.lockCommandFor('linux'), null);
  assert.strictEqual(core.lockCommandFor('freebsd'), null);

  const linux = core.lockSupport('linux');
  assert.strictEqual(linux.supported, false);
  assert.match(linux.detail, /做不到/);

  const unknown = core.lockSupport('freebsd');
  assert.strictEqual(unknown.supported, false);
  assert.match(unknown.detail, /freebsd/);
});

test('挑了别的平台的命令不硬跑，按不支持处理', () => {
  assert.strictEqual(core.lockCommandFor('win32', 'mac-cgsession'), null);
  assert.strictEqual(core.lockCommandFor('darwin', 'win-lockworkstation'), null);
  const support = core.lockSupport('win32', 'mac-cgsession');
  assert.strictEqual(support.supported, false);
  assert.match(support.detail, /按平台自动选/);
});

test('macOS 的两条路都能显式挑', () => {
  assert.strictEqual(core.lockCommandFor('darwin', 'mac-cgsession').id, 'mac-cgsession');
  const sleep = core.lockCommandFor('darwin', 'mac-displaysleep');
  assert.strictEqual(sleep.file, '/usr/bin/pmset');
  assert.deepStrictEqual(sleep.args, ['displaysleepnow']);
  assert.strictEqual(core.lockSupport('darwin', 'mac-displaysleep').supported, true);
});

// ---------------------------------------------------------------------------
// 什么时候提议锁
// ---------------------------------------------------------------------------

test('默认关：不开就永远不提', () => {
  assert.strictEqual(core.DEFAULT_SETTINGS.lockEnabled, false, '锁屏是不可逆动作，默认必须是关');
  assert.strictEqual(core.shouldOfferLock(offer({ settings: { lockEnabled: false } })), false);
});

test('锁不动的机器上不提——提了也执行不了，纯噪音', () => {
  assert.strictEqual(core.shouldOfferLock(offer({ supported: false })), false);
});

test('工作段永远不锁', () => {
  assert.strictEqual(core.shouldOfferLock(offer({ kind: 'work' })), false);
});

test('默认只在长休息锁；改成每个休息段都锁才管短休息', () => {
  assert.strictEqual(core.shouldOfferLock(offer({ kind: 'long-break' })), true);
  assert.strictEqual(core.shouldOfferLock(offer({ kind: 'break' })), false);
  assert.strictEqual(
    core.shouldOfferLock(offer({ kind: 'break', settings: { lockTrigger: 'any-break' } })),
    true,
  );
});

test('同一段只提一次', () => {
  const state = core.startCountdown(core.createLockState(), settings(), {
    segmentKey: 'long-break-4-1',
    now: NOW,
  });
  const done = core.finishCountdown(state);
  assert.strictEqual(
    core.shouldOfferLock(offer({ state: done, segmentKey: 'long-break-4-1' })),
    false,
  );
  assert.strictEqual(
    core.shouldOfferLock(offer({ state: done, segmentKey: 'long-break-8-2' })),
    true,
    '下一个长休息是新的一段，照提',
  );
});

test('倒计时正开着时不再叠一层', () => {
  const state = core.startCountdown(core.createLockState(), settings(), {
    segmentKey: 'long-break-4-1',
    now: NOW,
  });
  assert.strictEqual(core.shouldOfferLock(offer({ state, segmentKey: 'long-break-8-2' })), false);
});

// ---------------------------------------------------------------------------
// 倒计时 / 推迟 / 豁免
// ---------------------------------------------------------------------------

test('倒计时按秒数走，到点才算 due', () => {
  const state = core.startCountdown(core.createLockState(), settings(), {
    segmentKey: 'long-break-4-1',
    now: NOW,
  });
  assert.strictEqual(core.countdownRemainingMs(state, NOW), 20_000);
  assert.strictEqual(core.countdownDue(state, NOW), false);
  assert.strictEqual(core.countdownDue(state, NOW + 19_999), false);
  assert.strictEqual(core.countdownDue(state, NOW + 20_000), true);
  assert.strictEqual(core.countdownRemainingMs(state, NOW + 30_000), 0);
});

test('没在倒计时的时候，剩余是 0 且不 due——别把「没开始」当成「到点了」', () => {
  const empty = core.createLockState();
  assert.strictEqual(core.countdownRemainingMs(empty, NOW), 0);
  assert.strictEqual(core.countdownDue(empty, NOW), false);
});

test('推迟一次：倒计时收掉，往后推 lockDeferMinutes 内不再提', () => {
  const running = core.startCountdown(core.createLockState(), settings(), {
    segmentKey: 'long-break-4-1',
    now: NOW,
  });
  const deferred = core.deferLock(running, settings(), NOW);
  assert.strictEqual(deferred.countdown, null);
  assert.strictEqual(deferred.deferUntil, NOW + 10 * 60_000);

  const soon = offer({ state: deferred, segmentKey: 'long-break-8-2', now: NOW + 5 * 60_000 });
  assert.strictEqual(core.shouldOfferLock(soon), false);
  const later = offer({ state: deferred, segmentKey: 'long-break-8-2', now: NOW + 11 * 60_000 });
  assert.strictEqual(core.shouldOfferLock(later), true);
});

test('今天豁免：今天不再问第二遍，换天自动失效', () => {
  const exempt = core.exemptLockToday(core.createLockState(), DAY);
  assert.strictEqual(exempt.countdown, null);
  assert.strictEqual(
    core.shouldOfferLock(offer({ state: exempt, segmentKey: 'long-break-8-2' })),
    false,
  );

  const tomorrow = core.rolloverLock(exempt, '2026-08-12');
  assert.strictEqual(tomorrow.exemptDay, null);
  assert.strictEqual(tomorrow.deferUntil, null);
  assert.strictEqual(
    core.shouldOfferLock(offer({ state: tomorrow, day: '2026-08-12', segmentKey: 'x' })),
    true,
  );
});

test('还是同一天时，换天清理什么都不动', () => {
  const exempt = core.exemptLockToday(core.createLockState(), DAY);
  assert.strictEqual(core.rolloverLock(exempt, DAY), exempt);
  const fresh = core.createLockState();
  assert.strictEqual(core.rolloverLock(fresh, DAY), fresh);
});

test('normalizeSettings 认得锁屏这几项，写坏了退回默认', () => {
  const normalized = core.normalizeSettings({
    lockMethod: 'osascript-kill-everything',
    lockTrigger: '随时',
    lockCountdownSeconds: 0,
  });
  assert.strictEqual(normalized.lockMethod, 'auto');
  assert.strictEqual(normalized.lockTrigger, 'long-break');
  assert.strictEqual(
    normalized.lockCountdownSeconds,
    core.DEFAULT_SETTINGS.lockCountdownSeconds,
    '0 秒 = 弹一下就锁、来不及反悔，不接受，退回默认',
  );
});

test('倒计时秒数即使被手改成 0，startCountdown 也至少留 1 秒', () => {
  const state = core.startCountdown(core.createLockState(), settings({ lockCountdownSeconds: 0 }), {
    segmentKey: 'long-break-4-1',
    now: NOW,
  });
  assert.strictEqual(core.countdownRemainingMs(state, NOW), 1000);
});
