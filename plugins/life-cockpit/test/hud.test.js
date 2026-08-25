'use strict';

// 存在感层（AME-239）：悬浮框上该显示什么、心跳什么时候响。
//
// 这一层看起来只是「画一块贴纸」，但它有两条不能错的判断：
//   1. **该开工却没开工**要认得出来，而且要一直认下去（原话：「则应该 永远是提示」）；
//   2. **停着的表不许继续走秒**——悬浮框上一块自己往前跑的倒计时，
//      恰恰会让人以为「番茄在跑」，而实际上它在等人。

const test = require('node:test');
const assert = require('node:assert');
const core = require('./.build/core.js');

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

function settings(patch = {}) {
  return {
    hudEnabled: true,
    hudDesktopWindow: true,
    hudCorner: 'top-right',
    hudOpacity: 0.92,
    taskbarProgressEnabled: true,
    heartbeatEnabled: true,
    heartbeatMinutes: 2,
    heartbeatNotify: true,
    heartbeatFlash: true,
    heartbeatWhileRunning: true,
    ...patch,
  };
}

function input(patch = {}) {
  return {
    now: patch.now ?? NOW,
    timer: {
      kind: 'work',
      status: 'running',
      pomodoroIndex: 3,
      remainingMs: 12 * MINUTE,
      plannedMs: 25 * MINUTE,
      task: '写 PRD',
      ...patch.timer,
    },
    awaitingSince: patch.awaitingSince ?? null,
    gateOpen: patch.gateOpen ?? false,
    goal: patch.goal ?? null,
    focusMinutes: patch.focusMinutes ?? 123.4,
    targetMinutes: patch.targetMinutes ?? 560,
  };
}

// ---------------------------------------------------------------------------
// 现在是哪一格
// ---------------------------------------------------------------------------

test('工作中：倒计时 + 第几个番茄 + 在做什么', () => {
  const snapshot = core.buildHudSnapshot(input({ goal: '打通资讯管线' }));
  assert.strictEqual(snapshot.state, 'work');
  assert.strictEqual(snapshot.headline, '12:00');
  assert.match(snapshot.detail, /第 3 个番茄/);
  assert.match(snapshot.detail, /写 PRD/);
  assert.match(snapshot.detail, /打通资讯管线/);
  assert.strictEqual(snapshot.daily, '今日 123 / 560 分钟');
  assert.strictEqual(snapshot.remainingMs, 12 * MINUTE);
  assert.strictEqual(snapshot.progress, 13 / 25);
  assert.strictEqual(snapshot.urgent, false);
});

test('休息中不摆任务名——休息页上不该再提活儿', () => {
  const snapshot = core.buildHudSnapshot(input({ timer: { kind: 'break', remainingMs: 4 * MINUTE, plannedMs: 5 * MINUTE } }));
  assert.strictEqual(snapshot.state, 'break');
  assert.doesNotMatch(snapshot.detail, /写 PRD/);
});

test('最后一分钟标红：这一分钟该收尾了', () => {
  const snapshot = core.buildHudSnapshot(input({ timer: { remainingMs: 45_000 } }));
  assert.strictEqual(snapshot.urgent, true);
});

test('未开始时不摆贴纸的内容，只留一句话', () => {
  const snapshot = core.buildHudSnapshot(input({ timer: { status: 'idle' } }));
  assert.strictEqual(snapshot.state, 'idle');
  assert.strictEqual(snapshot.remainingMs, null);
  assert.strictEqual(snapshot.urgent, false);
});

// 「停着」这一条是 AME-239 的正面修复：表停着的时候，
// 悬浮框上的秒表也必须停——不然它看上去和「番茄正在跑」一模一样。
test('停着等开工时不给倒计时终点，秒表不许自己往前跑', () => {
  const snapshot = core.buildHudSnapshot(input({ timer: { status: 'paused', remainingMs: 25 * MINUTE } }));
  assert.strictEqual(snapshot.remainingMs, null);
  assert.strictEqual(snapshot.urgent, true);
  assert.match(snapshot.detail, /停着/);
});

test('该开工没开工：状态是 await，已等多久要说出来', () => {
  const snapshot = core.buildHudSnapshot(
    input({
      now: NOW + 7 * MINUTE,
      awaitingSince: NOW,
      timer: { status: 'paused', remainingMs: 25 * MINUTE },
    }),
  );
  assert.strictEqual(snapshot.state, 'await');
  assert.strictEqual(snapshot.headline, '已等 7 分钟');
  assert.strictEqual(snapshot.waitedMs, 7 * MINUTE);
  assert.strictEqual(snapshot.urgent, true);
});

test('强提醒页拦着时是 gate，指的路也不一样', () => {
  const snapshot = core.buildHudSnapshot(
    input({ awaitingSince: NOW, gateOpen: true, timer: { status: 'paused' } }),
  );
  assert.strictEqual(snapshot.state, 'gate');
  assert.match(snapshot.detail, /看完了，开工/);
});

// ---------------------------------------------------------------------------
// 心跳
// ---------------------------------------------------------------------------

function beat(patch = {}) {
  return core.stepHeartbeat({
    settings: settings(patch.settings),
    state: patch.state ?? core.createHeartbeatState(),
    snapshot: patch.snapshot ?? core.buildHudSnapshot(input()),
    now: patch.now ?? NOW,
    alarmRunning: patch.alarmRunning ?? false,
  });
}

test('第一拍不在起点响：刚开工就挨一条只是噪音', () => {
  const first = beat();
  assert.strictEqual(first.beat, null);
  assert.strictEqual(first.state.lastAt, NOW);
});

test('一个间隔之后响一拍，然后重新起拍', () => {
  const first = beat();
  const early = beat({ state: first.state, now: NOW + 90_000 });
  assert.strictEqual(early.beat, null, '还没到 2 分钟');

  const due = beat({ state: first.state, now: NOW + 2 * MINUTE });
  assert.ok(due.beat, '到点了就该响');
  assert.match(due.beat.title, /工作中/);
  assert.match(due.beat.body, /第 3 个番茄/);
  assert.strictEqual(due.state.lastAt, NOW + 2 * MINUTE);
});

test('状态一变就重新起拍：换段不该立刻挨一条', () => {
  const first = beat();
  const next = core.buildHudSnapshot(input({ timer: { kind: 'break', pomodoroIndex: 3 } }));
  const out = beat({ state: first.state, snapshot: next, now: NOW + 5 * MINUTE });
  assert.strictEqual(out.beat, null);
  assert.strictEqual(out.state.key, next.key);
});

test('该开工没开工：一直响，而且不受「番茄跑着时也提醒」那个开关影响', () => {
  const owed = core.buildHudSnapshot(
    input({ awaitingSince: NOW, timer: { status: 'paused' }, now: NOW + MINUTE }),
  );
  const first = beat({ settings: { heartbeatWhileRunning: false }, snapshot: owed, now: NOW });
  const due = beat({
    settings: { heartbeatWhileRunning: false },
    state: first.state,
    snapshot: owed,
    now: NOW + 2 * MINUTE,
  });
  assert.ok(due.beat);
  assert.strictEqual(due.beat.urgent, true);
});

test('关掉「番茄跑着时也提醒」之后，正常跑着的番茄不响', () => {
  const first = beat({ settings: { heartbeatWhileRunning: false } });
  const due = beat({
    settings: { heartbeatWhileRunning: false },
    state: first.state,
    now: NOW + 10 * MINUTE,
  });
  assert.strictEqual(due.beat, null);
});

test('正在被强制干扰时让路：两层不叠', () => {
  const first = beat();
  const due = beat({ state: first.state, now: NOW + 10 * MINUTE, alarmRunning: true });
  assert.strictEqual(due.beat, null);
});

test('未开始时不响，状态也归零', () => {
  const idle = core.buildHudSnapshot(input({ timer: { status: 'idle' } }));
  const out = beat({ state: { lastAt: NOW - 10 * MINUTE, key: 'work:3:running' }, snapshot: idle });
  assert.strictEqual(out.beat, null);
  assert.strictEqual(out.state.lastAt, null);
});

test('整层关掉就一拍都不响', () => {
  const out = beat({ settings: { hudEnabled: false }, now: NOW + 60 * MINUTE });
  assert.strictEqual(out.beat, null);
  const off = beat({ settings: { heartbeatEnabled: false }, now: NOW + 60 * MINUTE });
  assert.strictEqual(off.beat, null);
});

// ---------------------------------------------------------------------------
// 说给人听
// ---------------------------------------------------------------------------

test('describeHudPlan 照实说这台机器上是哪一种形态', () => {
  assert.match(core.describeHudPlan(settings(), true), /桌面悬浮框/);
  assert.match(core.describeHudPlan(settings(), true), /每 2 分钟/);
  // 开不出桌面窗时必须说出来，不许粉饰成「一直在」。
  assert.match(core.describeHudPlan(settings(), false), /开不出桌面悬浮窗/);
  assert.match(core.describeHudPlan(settings({ hudDesktopWindow: false }), true), /Obsidian 窗口里/);
  assert.match(core.describeHudPlan(settings({ hudEnabled: false }), true), /已关/);
});

test('默认值就是原话要的那几个数', () => {
  assert.strictEqual(core.DEFAULT_SETTINGS.hudEnabled, true);
  assert.strictEqual(core.DEFAULT_SETTINGS.heartbeatMinutes, 2);
  assert.strictEqual(core.DEFAULT_SETTINGS.enforceGiveUpEnabled, false);
  assert.strictEqual(core.DEFAULT_SETTINGS.uiFontScale, 1.2);
});

test('字号缩放封在 0.6–2.5，坏值退回默认', () => {
  assert.strictEqual(core.normalizeSettings({ uiFontScale: 5 }).uiFontScale, 2.5);
  assert.strictEqual(core.normalizeSettings({ uiFontScale: 0.1 }).uiFontScale, 0.6);
  assert.strictEqual(core.normalizeSettings({ uiFontScale: '大' }).uiFontScale, 1.2);
  assert.strictEqual(core.normalizeSettings({ hudCorner: '天上' }).hudCorner, 'top-right');
  assert.strictEqual(core.normalizeSettings({ hudCorner: 'bottom-left' }).hudCorner, 'bottom-left');
});

// ---------------------------------------------------------------------------
// 那扇窗的身份（AME-273 第 3 条）
//
// 「退出 Obsidian 后悬浮窗还在，再打开就变成两个重叠」——收孤儿窗靠的就是这个记号。
// 收窗不可逆，所以这一组测试盯的是**不许误杀**这一头。
// ---------------------------------------------------------------------------

test('认得出自家的贴纸，也认得出老版本留下的孤儿', () => {
  assert.strictEqual(core.isHudWindowTitle(core.HUD_WINDOW_TITLE), true);
  assert.strictEqual(core.isHudWindowTitle('人生驾驶舱'), true, '0.16.0 及更早那几版');
  assert.strictEqual(core.isHudWindowTitle('  人生驾驶舱悬浮提示  '), true, '首尾空白不算数');
});

test('别人的窗一扇都不许碰', () => {
  // Obsidian 主窗、别的插件的窗、以及任何「像但不是」的标题。
  assert.strictEqual(core.isHudWindowTitle('某篇笔记 - 我的 Vault - Obsidian v1.9.0'), false);
  assert.strictEqual(core.isHudWindowTitle('人生驾驶舱面板'), false, '前缀相同也不算——只认全等');
  assert.strictEqual(core.isHudWindowTitle('关于人生驾驶舱'), false);
  assert.strictEqual(core.isHudWindowTitle(''), false);
  assert.strictEqual(core.isHudWindowTitle(undefined), false, '拿不到标题时不许当成自家的');
  assert.strictEqual(core.isHudWindowTitle(null), false);
  assert.strictEqual(core.isHudWindowTitle(123), false);
});

test('看门狗的余量要远大于心跳间隔', () => {
  // 后台节流会把插件那边的定时器压到每分钟一跳；差得太近就会在人正看着时把窗关掉。
  assert.ok(core.HUD_STALE_MS >= core.HUD_HEARTBEAT_MS * 5);
  assert.ok(core.HUD_STALE_MS >= 5 * 60_000, '至少要顶得住「一分钟一跳」的节流');
});
