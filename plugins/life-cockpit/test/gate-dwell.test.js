'use strict';

// 强提醒页的停留倒计时**只在人真的看着的时候走**（AME-238）。
//
// 老的 gate.test.js 一个字没动：那些用例测的是「倒计时怎么算」，规则没变——
// 变的是「哪一段时间算数」，那是这一份的事。

const test = require('node:test');
const assert = require('node:assert');
const core = require('./.build/core.js');

const DAY = '2026-08-14';
const NOW = 1_700_000_000_000;
const DWELL_MS = 8000;

function settings(patch = {}) {
  return {
    gateEnabled: true,
    gateFrequency: 'every-resume',
    gateDwellSeconds: 8,
    gateAllowSkip: true,
    gateIdleMinutes: 20,
    gateRequireAttention: true,
    ...patch,
  };
}

function opened(now = NOW) {
  return core.openGate(core.createGateState(), {
    reason: 'after-break',
    segmentKey: 'work-3-1',
    now,
    resumeAfter: true,
  });
}

/** 按 1 秒一拍推进，present 决定这一拍算不算数。 */
function run(state, { from, seconds, present }) {
  let current = state;
  for (let index = 1; index <= seconds; index += 1) {
    current = core.advanceGateDwell(current, {
      now: from + index * 1000,
      present,
      requireAttention: true,
      dwellMs: DWELL_MS,
    });
  }
  return current;
}

// ---------------------------------------------------------------------------
// 这就是 AME-238 报的那一条
// ---------------------------------------------------------------------------

test('人不在的两个小时不算数：回来时这一页还是要看满 8 秒', () => {
  const away = run(opened(), { from: NOW, seconds: 7200, present: false });
  const at = NOW + 7200_000;

  assert.strictEqual(
    core.gateRemainingMs(away, settings(), at),
    DWELL_MS,
    '走开两小时回来，停留时间一秒都没走',
  );
  assert.strictEqual(core.canPassGate(away, settings(), at), false);
  assert.strictEqual(away.open.attendedMs, 0);
});

test('人看着的每一秒都算数，看满就能过', () => {
  const watched = run(opened(), { from: NOW, seconds: 8, present: true });
  const at = NOW + 8000;
  assert.strictEqual(core.gateRemainingMs(watched, settings(), at), 0);
  assert.strictEqual(core.canPassGate(watched, settings(), at), true);
  assert.strictEqual(watched.open.attendedMs, 8000);
});

test('看三秒、走开一分钟、再回来：还差五秒，不是「已经过了」', () => {
  let state = run(opened(), { from: NOW, seconds: 3, present: true });
  state = run(state, { from: NOW + 3000, seconds: 60, present: false });
  const at = NOW + 63_000;

  assert.strictEqual(core.gateRemainingMs(state, settings(), at), 5000);
  assert.strictEqual(core.canPassGate(state, settings(), at), false);

  const back = run(state, { from: at, seconds: 5, present: true });
  assert.strictEqual(core.canPassGate(back, settings(), at + 5000), true);
});

// ---------------------------------------------------------------------------
// 不能倒扣、不能被掉拍白送
// ---------------------------------------------------------------------------

test('看完了就定格：之后走开多久，按钮都还是「可以开工」', () => {
  const watched = run(opened(), { from: NOW, seconds: 8, present: true });
  const away = run(watched, { from: NOW + 8000, seconds: 600, present: false });
  const at = NOW + 608_000;
  assert.strictEqual(core.canPassGate(away, settings(), at), true, '看完了就是看完了，不倒扣');
});

test('掉拍不白送：后台节流跳了一分钟，人在也只按最大步长记一次', () => {
  // 一拍跨了 60 秒（Chromium 后台节流的典型值），停留时长是 8 秒——
  // 这一拍要是全算数，等于「离开一分钟反而看完了」。
  const jumped = core.advanceGateDwell(opened(), {
    now: NOW + 60_000,
    present: true,
    requireAttention: true,
    dwellMs: DWELL_MS,
    maxStepMs: 5000,
  });
  assert.strictEqual(jumped.open.attendedMs, 5000);
  assert.strictEqual(
    core.gateRemainingMs(jumped, settings(), NOW + 60_000),
    3000,
    '记进去几秒，就只少几秒——不许因为掉一拍白送一整段',
  );
});

test('人不在时掉拍：整段跳过的时间都不算，倒计时纹丝不动', () => {
  const jumped = core.advanceGateDwell(opened(), {
    now: NOW + 60_000,
    present: false,
    requireAttention: true,
    dwellMs: DWELL_MS,
    maxStepMs: 5000,
  });
  assert.strictEqual(core.gateRemainingMs(jumped, settings(), NOW + 60_000), DWELL_MS);
});

// ---------------------------------------------------------------------------
// 开关与边界
// ---------------------------------------------------------------------------

test('关掉「只在你看着时才走」就退回墙钟：人不在也照走', () => {
  let state = opened();
  for (let index = 1; index <= 8; index += 1) {
    state = core.advanceGateDwell(state, {
      now: NOW + index * 1000,
      present: false,
      requireAttention: false,
      dwellMs: DWELL_MS,
    });
  }
  assert.strictEqual(core.canPassGate(state, settings({ gateRequireAttention: false }), NOW + 8000), true);
});

test('没拦着的时候这一拍什么都不做', () => {
  const empty = core.createGateState();
  const stepped = core.advanceGateDwell(empty, {
    now: NOW,
    present: true,
    requireAttention: true,
    dwellMs: DWELL_MS,
  });
  assert.strictEqual(stepped, empty);
  assert.strictEqual(stepped.open, null);
});

test('时间没往前走的那一拍原样返回，不产生新对象', () => {
  const state = opened();
  assert.strictEqual(
    core.advanceGateDwell(state, {
      now: NOW,
      present: true,
      requireAttention: true,
      dwellMs: DWELL_MS,
    }),
    state,
  );
});

test('过闸之后照旧记下今天已经拦过——这一层没被动过', () => {
  const watched = run(opened(), { from: NOW, seconds: 8, present: true });
  const passed = core.passGate(watched, DAY);
  assert.strictEqual(passed.open, null);
  assert.strictEqual(passed.passedDay, DAY);
});
