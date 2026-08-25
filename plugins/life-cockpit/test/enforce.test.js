'use strict';

// 强制干扰的阶梯（AME-238）：什么时候连击、什么时候锁屏、催几轮、什么时候收手。
//
// 这一层动的是不可逆的东西（锁屏、闪屏），所以每一条分支都要在这里被钉死——
// 靠手工在真机上点一晚上验不出「第 7 轮会不会还在锁」这种事。

const test = require('node:test');
const assert = require('node:assert');
const core = require('./.build/core.js');

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

function settings(patch = {}) {
  return {
    enforceEnabled: true,
    enforcePreEndSeconds: 180,
    enforceBurstSeconds: 2,
    enforceBeep: true,
    enforceFlicker: true,
    enforceFlickerLow: 0,
    enforceFlickerHigh: 100,
    enforceFlickerStepMs: 400,
    enforceLockAtBreakStart: true,
    enforceBreakLockSeconds: 5,
    enforceAwaitGraceSeconds: 60,
    enforceCheckSeconds: 60,
    enforceAwaitAlarmSeconds: 20,
    enforceIdleSeconds: 60,
    enforceAwaitLock: true,
    enforceDisciplineUrl: '',
    // AME-239：默认不收手。开着时限的那几条测试自己把它打开。
    enforceGiveUpEnabled: false,
    enforceStopAfterMinutes: 60,
    enforceRespectMute: true,
    ...patch,
  };
}

function attention({ atKeyboard = true, attending = true, idleMs = 0 } = {}) {
  return { atKeyboard, attending, idleMs, reason: attending ? null : 'blurred' };
}

function input(patch = {}) {
  return {
    settings: settings(patch.settings),
    state: patch.state ?? core.createEnforceState(),
    now: patch.now ?? NOW,
    timer: {
      kind: 'work',
      status: 'running',
      remainingMs: 10 * MINUTE,
      segmentKey: 'work-3-1',
      ...patch.timer,
    },
    awaitingSince: patch.awaitingSince ?? null,
    attention: patch.attention ?? attention(),
    lockSupported: patch.lockSupported ?? true,
    muted: patch.muted ?? false,
  };
}

const types = (actions) => actions.map((action) => action.type);
const pick = (actions, type) => actions.find((action) => action.type === type);

// ---------------------------------------------------------------------------
// 临近收工：3 分钟的连击
// ---------------------------------------------------------------------------

test('工作段中段什么都不做', () => {
  const out = core.stepEnforce(input());
  assert.deepStrictEqual(out.actions, []);
  assert.strictEqual(out.state.phase, 'off');
});

test('进入最后三分钟就开始连击，响到这一段跑完为止', () => {
  const out = core.stepEnforce(input({ timer: { remainingMs: 3 * MINUTE } }));
  assert.deepStrictEqual(types(out.actions), ['alarm-start']);
  const alarm = pick(out.actions, 'alarm-start');
  assert.strictEqual(alarm.reason, 'pre-end');
  assert.strictEqual(alarm.durationMs, 3 * MINUTE);
  assert.strictEqual(alarm.silent, false);
  assert.strictEqual(out.state.phase, 'pre-end');
  assert.strictEqual(out.state.alarm, true);
});

test('已经在响的那一段不重开：连击的节奏由执行侧自己打', () => {
  const first = core.stepEnforce(input({ timer: { remainingMs: 3 * MINUTE } }));
  const again = core.stepEnforce(
    input({ state: first.state, now: NOW + 5000, timer: { remainingMs: 3 * MINUTE - 5000 } }),
  );
  assert.deepStrictEqual(again.actions, []);
  assert.strictEqual(again.state.alarm, true);
});

test('换了一段就重开一次：上一段的连击不该被当成这一段的', () => {
  const first = core.stepEnforce(input({ timer: { remainingMs: 3 * MINUTE } }));
  const next = core.stepEnforce(
    input({
      state: first.state,
      timer: { remainingMs: 2 * MINUTE, segmentKey: 'work-4-2' },
    }),
  );
  assert.deepStrictEqual(types(next.actions), ['alarm-start']);
});

test('段跑完 / 暂停 / 关掉总开关，连击都要收摊', () => {
  const running = core.stepEnforce(input({ timer: { remainingMs: 2 * MINUTE } })).state;

  const paused = core.stepEnforce(
    input({ state: running, timer: { status: 'paused', remainingMs: 2 * MINUTE } }),
  );
  assert.deepStrictEqual(types(paused.actions), ['alarm-stop']);

  const off = core.stepEnforce(
    input({ state: running, settings: { enforceEnabled: false }, timer: { remainingMs: MINUTE } }),
  );
  assert.deepStrictEqual(types(off.actions), ['alarm-stop']);
  assert.strictEqual(off.state.phase, 'off');
});

test('提前量设成 0 = 不做这一段', () => {
  const out = core.stepEnforce(
    input({ settings: { enforcePreEndSeconds: 0 }, timer: { remainingMs: 1000 } }),
  );
  assert.deepStrictEqual(out.actions, []);
});

test('静音只是不出声，闪烁照旧——静音管的是「别吵」，不是「别管我」', () => {
  const out = core.stepEnforce(input({ muted: true, timer: { remainingMs: MINUTE } }));
  assert.strictEqual(pick(out.actions, 'alarm-start').silent, true);
});

// ---------------------------------------------------------------------------
// 进入休息：先强制锁屏
// ---------------------------------------------------------------------------

test('进入休息先锁屏，留几秒反悔', () => {
  const actions = core.breakStartActions(settings(), {
    kind: 'break',
    lockSupported: true,
    muted: false,
  });
  assert.deepStrictEqual(types(actions), ['alarm-stop', 'lock']);
  const lock = pick(actions, 'lock');
  assert.strictEqual(lock.seconds, 5);
  assert.strictEqual(lock.reason, 'break-start');
});

test('留 0 秒 = 立刻锁', () => {
  const actions = core.breakStartActions(settings({ enforceBreakLockSeconds: 0 }), {
    kind: 'long-break',
    lockSupported: true,
    muted: false,
  });
  assert.strictEqual(pick(actions, 'lock').seconds, 0);
});

test('锁不动的机器上明说锁不动，不假装', () => {
  const actions = core.breakStartActions(settings(), {
    kind: 'break',
    lockSupported: false,
    muted: false,
  });
  assert.deepStrictEqual(types(actions), ['alarm-stop', 'notify']);
  assert.match(pick(actions, 'notify').title, /锁不了屏/);
});

test('关掉这一条就只收连击，不锁', () => {
  const actions = core.breakStartActions(settings({ enforceLockAtBreakStart: false }), {
    kind: 'break',
    lockSupported: true,
    muted: false,
  });
  assert.deepStrictEqual(types(actions), ['alarm-stop']);
});

test('总开关关着时一个动作都不发', () => {
  assert.deepStrictEqual(
    core.breakStartActions(settings({ enforceEnabled: false }), {
      kind: 'break',
      lockSupported: true,
      muted: false,
    }),
    [],
  );
});

// ---------------------------------------------------------------------------
// 休息结束还没复工：每分钟催一轮
// ---------------------------------------------------------------------------

const awaiting = (patch = {}) =>
  input({
    awaitingSince: NOW,
    timer: { status: 'paused', remainingMs: 25 * MINUTE },
    ...patch,
  });

test('宽限期内先不催', () => {
  const out = core.stepEnforce(awaiting({ now: NOW + 59_000 }));
  assert.deepStrictEqual(out.actions, []);
  assert.strictEqual(out.state.rounds, 0);
});

test('【空闲 + 未复工】：闪 + 通知 + 锁屏 + 督促页，一样不少', () => {
  const out = core.stepEnforce(
    awaiting({ now: NOW + 60_000, attention: attention({ atKeyboard: false, attending: false }) }),
  );
  assert.deepStrictEqual(types(out.actions), [
    'alarm-start',
    'notify',
    'lock',
    'open-discipline',
  ]);
  assert.strictEqual(pick(out.actions, 'lock').seconds, 0, '人都不在了，倒计时给谁看');
  assert.strictEqual(pick(out.actions, 'notify').level, 'hard');
  assert.strictEqual(out.state.rounds, 1);
});

test('人在电脑前但没复工：拽窗口、连击，但不锁屏', () => {
  const out = core.stepEnforce(
    awaiting({ now: NOW + 60_000, attention: attention({ atKeyboard: true, attending: false }) }),
  );
  assert.deepStrictEqual(types(out.actions), ['alarm-start', 'notify', 'focus-window']);
  assert.strictEqual(pick(out.actions, 'lock'), undefined, '锁掉的会是人正在做的事');
});

test('之后每隔一分钟催一轮，轮数一路往上数', () => {
  let state = core.createEnforceState();
  const away = attention({ atKeyboard: false, attending: false });
  const rounds = [];
  for (let minute = 1; minute <= 5; minute += 1) {
    const out = core.stepEnforce(awaiting({ state, now: NOW + minute * MINUTE, attention: away }));
    state = out.state;
    if (out.actions.length) rounds.push(state.rounds);
  }
  assert.deepStrictEqual(rounds, [1, 2, 3, 4, 5]);
});

test('两轮之间不重复发动作', () => {
  const first = core.stepEnforce(
    awaiting({ now: NOW + 60_000, attention: attention({ atKeyboard: false, attending: false }) }),
  );
  const between = core.stepEnforce(
    awaiting({
      state: first.state,
      now: NOW + 90_000,
      attention: attention({ atKeyboard: false, attending: false }),
    }),
  );
  assert.deepStrictEqual(between.actions, []);
  assert.strictEqual(between.state.rounds, 1);
});

test('锁不动的机器上照样催，只是不发锁屏', () => {
  const out = core.stepEnforce(
    awaiting({
      now: NOW + 60_000,
      lockSupported: false,
      attention: attention({ atKeyboard: false, attending: false }),
    }),
  );
  assert.deepStrictEqual(types(out.actions), ['alarm-start', 'notify', 'open-discipline']);
});

test('关掉「空闲就锁屏」之后，催照旧、锁没了', () => {
  const out = core.stepEnforce(
    awaiting({
      settings: { enforceAwaitLock: false },
      now: NOW + 60_000,
      attention: attention({ atKeyboard: false, attending: false }),
    }),
  );
  assert.strictEqual(pick(out.actions, 'lock'), undefined);
  assert.ok(pick(out.actions, 'alarm-start'));
});

test('人回来复工（awaitingSince 清掉）：干扰当场收摊', () => {
  const nagging = core.stepEnforce(
    awaiting({ now: NOW + 60_000, attention: attention({ atKeyboard: false, attending: false }) }),
  ).state;
  const back = core.stepEnforce(
    input({ state: nagging, now: NOW + 61_000, timer: { status: 'running' } }),
  );
  assert.deepStrictEqual(types(back.actions), ['alarm-stop']);
  assert.strictEqual(back.state.phase, 'off');
});

// ---------------------------------------------------------------------------
// 收手：默认不收手（AME-239），想收手要自己打开那个开关
// ---------------------------------------------------------------------------

// 「如果 “应该开工而没有开工” 则应该 永远是提示！！！」——所以默认这一条：
// 催到天亮也不停。0.7.0 默认催满一小时收手，那是插件替人决定「可以放过自己了」。
test('默认不收手：催两个小时照样一轮不落', () => {
  let state = core.createEnforceState();
  const away = attention({ atKeyboard: false, attending: false });
  let last = null;
  for (let minute = 1; minute <= 120; minute += 1) {
    last = core.stepEnforce(awaiting({ state, now: NOW + minute * MINUTE, attention: away }));
    state = last.state;
  }
  assert.strictEqual(state.gaveUp, false);
  assert.strictEqual(state.rounds, 120);
  assert.deepStrictEqual(types(last.actions), ['alarm-start', 'notify', 'lock', 'open-discipline']);
});

test('打开开关之后，催满一小时就收手，并留一句话', () => {
  let state = core.createEnforceState();
  const away = attention({ atKeyboard: false, attending: false });
  const giveUp = { enforceGiveUpEnabled: true };
  let gaveUpAt = null;
  let final = null;
  for (let minute = 1; minute <= 61; minute += 1) {
    const out = core.stepEnforce(
      awaiting({ state, settings: giveUp, now: NOW + minute * MINUTE, attention: away }),
    );
    if (!state.gaveUp && out.state.gaveUp) {
      gaveUpAt = minute;
      final = out.actions;
    }
    state = out.state;
  }
  assert.strictEqual(gaveUpAt, 60, '第 60 分钟那一轮收手');
  assert.deepStrictEqual(types(final), ['alarm-stop', 'notify']);
  assert.match(pick(final, 'notify').title, /不催了/);
});

test('收手之后一声不吭，直到人回来', () => {
  let state = core.createEnforceState();
  const away = attention({ atKeyboard: false, attending: false });
  const giveUp = { enforceGiveUpEnabled: true };
  for (let minute = 1; minute <= 70; minute += 1) {
    state = core.stepEnforce(
      awaiting({ state, settings: giveUp, now: NOW + minute * MINUTE, attention: away }),
    ).state;
  }
  const later = core.stepEnforce(
    awaiting({ state, settings: giveUp, now: NOW + 120 * MINUTE, attention: away }),
  );
  assert.deepStrictEqual(later.actions, []);
});

test('开关开着但时限设成 0 = 还是永不收手', () => {
  let state = core.createEnforceState();
  const away = attention({ atKeyboard: false, attending: false });
  for (let minute = 1; minute <= 90; minute += 1) {
    state = core.stepEnforce(
      awaiting({
        state,
        settings: { enforceGiveUpEnabled: true, enforceStopAfterMinutes: 0 },
        now: NOW + minute * MINUTE,
        attention: away,
      }),
    ).state;
  }
  assert.strictEqual(state.gaveUp, false);
  assert.strictEqual(state.rounds, 90);
});

// ---------------------------------------------------------------------------
// 掉拍：后台节流下也要算得对
// ---------------------------------------------------------------------------

test('一拍跨了五分钟也只算一轮，不会补发五轮', () => {
  const out = core.stepEnforce(
    awaiting({ now: NOW + 5 * MINUTE, attention: attention({ atKeyboard: false, attending: false }) }),
  );
  assert.strictEqual(out.state.rounds, 1);
  assert.strictEqual(types(out.actions).filter((type) => type === 'lock').length, 1);
});

// ---------------------------------------------------------------------------
// 说给人听
// ---------------------------------------------------------------------------

test('下一轮什么时候催，面板要答得出来', () => {
  assert.strictEqual(
    core.nextEnforceCheckMs(settings(), core.createEnforceState(), NOW, NOW + 20_000),
    40_000,
  );
  const state = core.stepEnforce(
    awaiting({ now: NOW + 60_000, attention: attention({ atKeyboard: false, attending: false }) }),
  ).state;
  assert.strictEqual(core.nextEnforceCheckMs(settings(), state, NOW, NOW + 90_000), 30_000);
});

test('不在待命 / 关着 / 已收手时没有下一轮', () => {
  const state = core.createEnforceState();
  assert.strictEqual(core.nextEnforceCheckMs(settings(), state, null, NOW), null);
  assert.strictEqual(
    core.nextEnforceCheckMs(settings({ enforceEnabled: false }), state, NOW, NOW),
    null,
  );
  assert.strictEqual(
    core.nextEnforceCheckMs(settings(), { ...state, gaveUp: true }, NOW, NOW),
    null,
  );
});

test('一句话说清它会怎么动', () => {
  const text = core.describeEnforcePlan(settings());
  assert.match(text, /连击/);
  assert.match(text, /锁屏/);
  assert.match(text, /每 60 秒催一轮/);
  assert.match(core.describeEnforcePlan(settings({ enforceEnabled: false })), /已关/);
});
