'use strict';

// 复工前的强提醒页：什么时候拦、拦多久才能过、今天该看哪一页。

const test = require('node:test');
const assert = require('node:assert');
const core = require('./.build/core.js');

const DAY = '2026-08-11';
const NOW = 1_700_000_000_000;

function settings(patch = {}) {
  return {
    gateEnabled: true,
    gateFrequency: 'every-resume',
    gateDwellSeconds: 8,
    gateAllowSkip: true,
    gateIdleMinutes: 20,
    ...patch,
  };
}

function trigger(patch = {}) {
  return {
    settings: settings(patch.settings),
    state: patch.state ?? core.createGateState(),
    reason: patch.reason ?? 'after-break',
    segmentKey: patch.segmentKey ?? 'work-3-1700000000000',
    day: patch.day ?? DAY,
    now: patch.now ?? NOW,
    idleMs: patch.idleMs ?? 0,
  };
}

// ---------------------------------------------------------------------------
// 拦不拦
// ---------------------------------------------------------------------------

test('休息结束复工，默认要拦', () => {
  assert.strictEqual(core.shouldOpenGate(trigger()), true);
});

test('关掉之后一次都不拦', () => {
  assert.strictEqual(core.shouldOpenGate(trigger({ settings: { gateEnabled: false } })), false);
});

test('已经拦着一次了就不叠第二层', () => {
  const open = core.openGate(core.createGateState(), {
    reason: 'after-break',
    segmentKey: 'work-2-1',
    now: NOW,
    resumeAfter: true,
  });
  assert.strictEqual(core.shouldOpenGate(trigger({ state: open })), false);
});

test('每次复工：拦过一次，下一段照拦', () => {
  const passed = core.passGate(core.createGateState(), DAY);
  assert.strictEqual(core.shouldOpenGate(trigger({ state: passed })), true);
});

test('每天第一次：同一天拦过就不再拦，换天恢复', () => {
  const passed = core.passGate(core.createGateState(), DAY);
  const daily = { settings: { gateFrequency: 'daily' }, state: passed };
  assert.strictEqual(core.shouldOpenGate(trigger(daily)), false);
  assert.strictEqual(core.shouldOpenGate(trigger({ ...daily, day: '2026-08-12' })), true);
});

test('离开一小会儿回来不拦，超过阈值才拦', () => {
  const idle = (minutes) =>
    core.shouldOpenGate(trigger({ reason: 'after-idle', idleMs: minutes * 60_000 }));
  assert.strictEqual(idle(5), false);
  assert.strictEqual(idle(19), false);
  assert.strictEqual(idle(20), true);
  assert.strictEqual(idle(180), true);
});

test('阈值设成 0 时，任何一次从头开始都拦', () => {
  assert.strictEqual(
    core.shouldOpenGate(trigger({ settings: { gateIdleMinutes: 0 }, reason: 'after-idle', idleMs: 0 })),
    true,
  );
});

// ---------------------------------------------------------------------------
// 停留时长
// ---------------------------------------------------------------------------

test('停留时间没到不许过，到了才放行', () => {
  const config = settings();
  const state = core.openGate(core.createGateState(), {
    reason: 'after-break',
    segmentKey: 'work-1-1',
    now: NOW,
    resumeAfter: true,
  });

  assert.strictEqual(core.canPassGate(state, config, NOW), false);
  assert.strictEqual(core.gateRemainingMs(state, config, NOW), 8000);
  assert.strictEqual(core.canPassGate(state, config, NOW + 7999), false);
  assert.strictEqual(core.gateRemainingMs(state, config, NOW + 7999), 1);
  assert.strictEqual(core.canPassGate(state, config, NOW + 8000), true);
  assert.strictEqual(core.gateRemainingMs(state, config, NOW + 8000), 0);
  assert.strictEqual(core.gateRemainingMs(state, config, NOW + 99_999), 0);
});

test('停留秒数设成 0 时立刻能过', () => {
  const config = settings({ gateDwellSeconds: 0 });
  const state = core.openGate(core.createGateState(), {
    reason: 'after-break',
    segmentKey: 'work-1-1',
    now: NOW,
    resumeAfter: true,
  });
  assert.strictEqual(core.canPassGate(state, config, NOW), true);
});

test('没拦着的时候，剩余时间是 0，也不能「过闸」', () => {
  const empty = core.createGateState();
  assert.strictEqual(core.gateRemainingMs(empty, settings(), NOW), 0);
  assert.strictEqual(core.canPassGate(empty, settings(), NOW), false);
});

test('过闸记下今天已经拦过；放弃只收遮罩，下一次照拦', () => {
  const state = core.openGate(core.createGateState(), {
    reason: 'after-break',
    segmentKey: 'work-1-1',
    now: NOW,
    resumeAfter: true,
  });

  const passed = core.passGate(state, DAY);
  assert.strictEqual(passed.open, null);
  assert.strictEqual(passed.passedDay, DAY);

  const abandoned = core.abandonGate(state);
  assert.strictEqual(abandoned.open, null);
  assert.strictEqual(abandoned.passedDay, null);
  assert.strictEqual(
    core.shouldOpenGate(trigger({ settings: { gateFrequency: 'daily' }, state: abandoned })),
    true,
  );
});

test('过闸时记着要不要把番茄接着跑起来', () => {
  const resume = core.openGate(core.createGateState(), {
    reason: 'after-break',
    segmentKey: 'work-1-1',
    now: NOW,
    resumeAfter: true,
  });
  const cold = core.openGate(core.createGateState(), {
    reason: 'after-idle',
    segmentKey: 'work-1-1',
    now: NOW,
    resumeAfter: false,
  });
  assert.strictEqual(resume.open.resumeAfter, true);
  assert.strictEqual(cold.open.resumeAfter, false);
  assert.strictEqual(cold.open.reason, 'after-idle');
});

// ---------------------------------------------------------------------------
// 今天看哪一页
// ---------------------------------------------------------------------------

const PAGES = [
  { id: 'a', label: '每日任务', notePath: 'Root/每日Journal/日记/日记模板.md' },
  { id: 'b', label: '不贰过', notePath: 'Root/错题本.md' },
  { id: 'c', label: '目标树', notePath: 'Root/每日Journal/目标树.md' },
];

test('同一天永远同一页，换一天必然换一页', () => {
  const first = core.pickGatePage(PAGES, '2026-08-11');
  assert.strictEqual(core.pickGatePage(PAGES, '2026-08-11').id, first.id);

  const days = ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14'];
  const picked = days.map((day) => core.pickGatePage(PAGES, day).id);
  for (let i = 1; i < picked.length; i += 1) {
    assert.notStrictEqual(picked[i], picked[i - 1], `${days[i]} 应当换一页`);
  }
  assert.strictEqual(picked[3], picked[0], '三页一轮，第四天转回第一页');
});

test('没填路径的页面不参与轮换', () => {
  const mixed = [
    { id: 'empty', label: '还没配', notePath: '' },
    { id: 'real', label: '配了的', notePath: 'Root/一页.md' },
  ];
  for (const day of ['2026-08-11', '2026-08-12', '2026-08-13']) {
    assert.strictEqual(core.pickGatePage(mixed, day).id, 'real');
  }
});

test('一页都没配时返回那一页本身 / 空表返回 null', () => {
  const blank = [{ id: 'empty', label: '还没配', notePath: '' }];
  assert.strictEqual(core.pickGatePage(blank, DAY).id, 'empty');
  assert.strictEqual(core.pickGatePage([], DAY), null);
});

test('dayIndex 对写坏的日期退回 0，不抛', () => {
  assert.strictEqual(core.dayIndex('明天', 3), 0);
  assert.strictEqual(core.dayIndex('', 3), 0);
  assert.strictEqual(core.dayIndex('2026-08-11', 0), 0);
  assert.strictEqual(core.dayIndex('2026-08-11', 1), 0);
});

test('normalizeSettings 认得强提醒页这几项', () => {
  const normalized = core.normalizeSettings({
    gateFrequency: '随缘',
    gateDwellSeconds: 0,
    gatePages: [],
  });
  assert.strictEqual(normalized.gateFrequency, 'every-resume');
  assert.strictEqual(normalized.gateDwellSeconds, 0, '0 秒是合法配置');
  assert.deepStrictEqual(normalized.gatePages, [], '整份清空是合法配置，不拿默认值顶回来');
});

// ---------------------------------------------------------------------------
// 「这次先跳过」（AME-273 第 1 条）
//
// 那颗按钮从前叫「今天先跳过」，做的却是 passGate：默认档下它一天都管不住，
// daily 档下又把一整天全豁免了——两种都不是那句话写的意思。
// ---------------------------------------------------------------------------

test('跳过只收这一次的遮罩，今天的账一笔不记', () => {
  const state = core.openGate(core.createGateState(), {
    reason: 'after-break',
    segmentKey: 'work-1-1',
    now: NOW,
    resumeAfter: true,
  });

  const skipped = core.skipGate(state);
  assert.strictEqual(skipped.open, null, '这一次的遮罩要收掉');
  assert.strictEqual(skipped.passedDay, null, '跳过 ≠ 看过：今天那一份还欠着');
});

test('跳过之后，两档频率下都是「下一次照拦」', () => {
  const opened = core.openGate(core.createGateState(), {
    reason: 'after-break',
    segmentKey: 'work-1-1',
    now: NOW,
    resumeAfter: true,
  });
  const skipped = core.skipGate(opened);

  assert.strictEqual(core.shouldOpenGate(trigger({ state: skipped })), true);
  assert.strictEqual(
    core.shouldOpenGate(trigger({ settings: { gateFrequency: 'daily' }, state: skipped })),
    true,
    'daily 档下跳过也不该把一整天豁免掉——那是「今天先跳过」在骗人的那一半',
  );
});

test('看完了才算今天看过：daily 档下 passGate 收口，skipGate 不收', () => {
  const daily = { settings: { gateFrequency: 'daily' } };
  const passed = core.passGate(core.createGateState(), DAY);
  const skipped = core.skipGate(core.createGateState());

  assert.strictEqual(core.shouldOpenGate(trigger({ ...daily, state: passed })), false);
  assert.strictEqual(core.shouldOpenGate(trigger({ ...daily, state: skipped })), true);
});

test('跳过不会抹掉之前已经看完的那一天', () => {
  const passed = core.passGate(core.createGateState(), DAY);
  const opened = core.openGate(passed, {
    reason: 'after-idle',
    segmentKey: 'work-9-1',
    now: NOW,
    resumeAfter: true,
  });
  assert.strictEqual(core.skipGate(opened).passedDay, DAY);
});
