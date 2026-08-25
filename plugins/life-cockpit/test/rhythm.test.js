'use strict';

const test = require('node:test');
const assert = require('node:assert');
const core = require('./.build/core.js');

const SEGMENTS = core.resolveSegments(core.DEFAULT_SETTINGS.rhythmSegments);

function at(hour, minute = 0) {
  return hour * 60 + minute;
}

function labelAt(hour, minute = 0) {
  const segment = core.segmentAt(SEGMENTS, at(hour, minute));
  return segment ? segment.label : null;
}

// ---------------------------------------------------------------------------
// 时段判定
// ---------------------------------------------------------------------------

test('parseClock 接受 HH:MM 与 24:00，拒绝垃圾输入', () => {
  assert.strictEqual(core.parseClock('09:00'), 540);
  assert.strictEqual(core.parseClock('9:05'), 545);
  assert.strictEqual(core.parseClock('00:00'), 0);
  assert.strictEqual(core.parseClock('24:00'), 1440);
  assert.strictEqual(core.parseClock(' 22:00 '), 1320);
  assert.strictEqual(core.parseClock('24:01'), null);
  assert.strictEqual(core.parseClock('25:00'), null);
  assert.strictEqual(core.parseClock('09:60'), null);
  assert.strictEqual(core.parseClock('九点'), null);
  assert.strictEqual(core.parseClock(''), null);
});

test('formatClock 是 parseClock 的逆', () => {
  for (const value of ['00:00', '05:00', '09:30', '13:00', '22:00', '23:59']) {
    assert.strictEqual(core.formatClock(core.parseClock(value)), value);
  }
});

test('默认时段表就是日记模板那五行', () => {
  assert.deepStrictEqual(
    SEGMENTS.map((s) => s.label),
    ['早起', '三小时工作日', '双数日', '单数日', '睡觉'],
  );
});

test('表里画的时段能判定出来', () => {
  assert.strictEqual(labelAt(6), '早起');
  assert.strictEqual(labelAt(9), '三小时工作日');
  assert.strictEqual(labelAt(11, 59), '三小时工作日');
  assert.strictEqual(labelAt(13), '双数日');
  assert.strictEqual(labelAt(16, 30), '双数日');
  assert.strictEqual(labelAt(18), '单数日');
  assert.strictEqual(labelAt(21, 59), '单数日');
});

test('时段左闭右开，边界不重叠', () => {
  assert.strictEqual(labelAt(9, 0), '三小时工作日');
  assert.strictEqual(labelAt(8, 59), '早起');
  assert.strictEqual(labelAt(12, 0), null);
  assert.strictEqual(labelAt(17, 0), null);
});

test('原表 12-13 与 17-18 是空的，这里也保持空档', () => {
  assert.strictEqual(labelAt(12, 30), null);
  assert.strictEqual(labelAt(17, 30), null);
});

test('睡觉段跨零点', () => {
  assert.strictEqual(labelAt(22), '睡觉');
  assert.strictEqual(labelAt(23, 59), '睡觉');
  assert.strictEqual(labelAt(0), '睡觉');
  assert.strictEqual(labelAt(3), '睡觉');
  assert.strictEqual(labelAt(4, 59), '睡觉');
  assert.strictEqual(labelAt(5), '早起');
});

test('时间解析不了或首尾相同的行会被丢掉，不参与判定', () => {
  const resolved = core.resolveSegments([
    { id: 'ok', label: '好的', start: '09:00', end: '10:00' },
    { id: 'bad-clock', label: '写坏了', start: '嗯', end: '10:00' },
    { id: 'zero', label: '零长度', start: '11:00', end: '11:00' },
  ]);
  assert.deepStrictEqual(resolved.map((s) => s.id), ['ok']);
});

test('时段重叠时取表里靠前的那个', () => {
  const resolved = core.resolveSegments([
    { id: 'first', label: '前', start: '09:00', end: '12:00' },
    { id: 'second', label: '后', start: '10:00', end: '11:00' },
  ]);
  assert.strictEqual(core.segmentAt(resolved, at(10, 30)).id, 'first');
});

// ---------------------------------------------------------------------------
// 进入 / 离开提醒
// ---------------------------------------------------------------------------

test('时段没变时不产生提醒', () => {
  const morning = core.segmentAt(SEGMENTS, at(9, 10));
  assert.strictEqual(core.segmentTransition(morning, morning), null);
  assert.strictEqual(core.segmentTransition(null, null), null);
});

test('跨段时同时给出离开和进入', () => {
  const before = core.segmentAt(SEGMENTS, at(11, 59));
  const after = core.segmentAt(SEGMENTS, at(13, 0));
  const transition = core.segmentTransition(before, after);
  assert.strictEqual(transition.left.label, '三小时工作日');
  assert.strictEqual(transition.entered.label, '双数日');
  assert.strictEqual(core.describeTransition(transition), '离开【三小时工作日】，进入【双数日】');
});

test('走进空档只报离开，走出空档只报进入', () => {
  const working = core.segmentAt(SEGMENTS, at(11, 59));
  const gap = core.segmentAt(SEGMENTS, at(12, 30));
  assert.strictEqual(gap, null);

  assert.strictEqual(core.describeTransition(core.segmentTransition(working, gap)), '离开【三小时工作日】');

  const afternoon = core.segmentAt(SEGMENTS, at(13, 0));
  assert.strictEqual(core.describeTransition(core.segmentTransition(gap, afternoon)), '进入【双数日】');
});

// ---------------------------------------------------------------------------
// 五行列
// ---------------------------------------------------------------------------

test('weekday 映射：周一到周五对应金一到土五', () => {
  const settings = { phaseMapping: 'weekday', cycleAnchorDate: '2026-01-01', cycleAnchorPhase: 0 };
  // 2026-08-10 是周一
  const expected = ['金一', '木二', '水三', '火四', '土五'];
  for (let i = 0; i < 5; i += 1) {
    const date = new Date(2026, 7, 10 + i, 10, 0, 0);
    assert.strictEqual(core.phaseForDate(date, settings).label, expected[i]);
  }
});

test('weekday 映射下周末没有对应列', () => {
  const settings = { phaseMapping: 'weekday', cycleAnchorDate: '2026-01-01', cycleAnchorPhase: 0 };
  assert.strictEqual(core.phaseForDate(new Date(2026, 7, 15, 10, 0, 0), settings), null); // 周六
  assert.strictEqual(core.phaseForDate(new Date(2026, 7, 16, 10, 0, 0), settings), null); // 周日
});

test('cycle5 映射：五天一轮，不管星期', () => {
  const settings = { phaseMapping: 'cycle5', cycleAnchorDate: '2026-08-10', cycleAnchorPhase: 0 };
  const labels = [];
  for (let i = 0; i < 7; i += 1) {
    labels.push(core.phaseForDate(new Date(2026, 7, 10 + i, 10, 0, 0), settings).label);
  }
  assert.deepStrictEqual(labels, ['金一', '木二', '水三', '火四', '土五', '金一', '木二']);
});

test('cycle5 锚点之前的日期也能算，不会算成负数下标', () => {
  const settings = { phaseMapping: 'cycle5', cycleAnchorDate: '2026-08-10', cycleAnchorPhase: 0 };
  assert.strictEqual(core.phaseForDate(new Date(2026, 7, 9, 10, 0, 0), settings).label, '土五');
  assert.strictEqual(core.phaseForDate(new Date(2026, 7, 6, 10, 0, 0), settings).label, '木二');
  assert.strictEqual(core.phaseForDate(new Date(2026, 7, 5, 10, 0, 0), settings).label, '金一');
});

test('cycleAnchorPhase 能把锚点那天挪到别的列', () => {
  const settings = { phaseMapping: 'cycle5', cycleAnchorDate: '2026-08-10', cycleAnchorPhase: 2 };
  assert.strictEqual(core.phaseForDate(new Date(2026, 7, 10, 10, 0, 0), settings).label, '水三');
});

test('锚点日期写坏时退回第一列，不崩', () => {
  const settings = { phaseMapping: 'cycle5', cycleAnchorDate: '不是日期', cycleAnchorPhase: 0 };
  assert.strictEqual(core.phaseForDate(new Date(2026, 7, 10, 10, 0, 0), settings).label, '金一');
});

// ---------------------------------------------------------------------------
// 当前格
// ---------------------------------------------------------------------------

test('currentCell 给出「列 · 时段」，周末与空档都有说法', () => {
  const settings = {
    rhythmSegments: core.DEFAULT_SETTINGS.rhythmSegments,
    phaseMapping: 'weekday',
    cycleAnchorDate: '2026-01-01',
    cycleAnchorPhase: 0,
  };

  // 周一上午
  assert.strictEqual(
    core.describeCell(core.currentCell(new Date(2026, 7, 10, 10, 0, 0), settings)),
    '金一 · 三小时工作日',
  );
  // 周一午间空档
  assert.strictEqual(
    core.describeCell(core.currentCell(new Date(2026, 7, 10, 12, 30, 0), settings)),
    '金一 · 空档',
  );
  // 周六下午
  assert.strictEqual(
    core.describeCell(core.currentCell(new Date(2026, 7, 15, 14, 0, 0), settings)),
    '无对应列 · 双数日',
  );
});

// ---------------------------------------------------------------------------
// 提醒主题节律
// ---------------------------------------------------------------------------

test('第一次 tick 只对表不弹提醒', () => {
  const mode = core.DEFAULT_SETTINGS.modes['accelerated-practice'];
  const result = core.tickReminder(mode, core.createReminderState(), 1_000);
  assert.strictEqual(result.theme, null);
  assert.strictEqual(result.state.lastFiredAt, 1_000);
});

test('到点弹一条，主题按 themeCycle 轮换', () => {
  const mode = core.DEFAULT_SETTINGS.modes['accelerated-practice'];
  const interval = mode.reminderIntervalMinutes * 60_000;
  let state = core.tickReminder(mode, core.createReminderState(), 0).state;
  const fired = [];

  for (let i = 1; i <= mode.themeCycle.length + 1; i += 1) {
    const result = core.tickReminder(mode, state, i * interval);
    state = result.state;
    if (result.theme) fired.push(result.theme);
  }

  assert.deepStrictEqual(fired.slice(0, mode.themeCycle.length), mode.themeCycle);
  assert.strictEqual(fired[mode.themeCycle.length], mode.themeCycle[0], '轮完一圈回到第一条');
});

test('没到点不弹', () => {
  const mode = core.DEFAULT_SETTINGS.modes['accelerated-practice'];
  const state = core.tickReminder(mode, core.createReminderState(), 0).state;
  const interval = mode.reminderIntervalMinutes * 60_000;
  assert.strictEqual(core.tickReminder(mode, state, interval - 1).theme, null);
  assert.notStrictEqual(core.tickReminder(mode, state, interval).theme, null);
});

test('离开很久回来只补一条，不把攒的全倒出来', () => {
  const mode = core.DEFAULT_SETTINGS.modes['accelerated-practice'];
  const interval = mode.reminderIntervalMinutes * 60_000;
  let state = core.tickReminder(mode, core.createReminderState(), 0).state;

  const first = core.tickReminder(mode, state, 100 * interval);
  assert.notStrictEqual(first.theme, null);
  state = first.state;

  // 紧接着再 tick 一次，不该继续补
  assert.strictEqual(core.tickReminder(mode, state, 100 * interval + 1).theme, null);
});

test('切模式后重新对表，主题回到第一条', () => {
  const slow = core.DEFAULT_SETTINGS.modes['thinking-first'];
  const state = core.resetReminderState(10_000);
  assert.strictEqual(state.cursor, 0);
  assert.strictEqual(state.lastFiredAt, 10_000);
  assert.strictEqual(
    core.nextReminderAt(slow, state),
    10_000 + slow.reminderIntervalMinutes * 60_000,
  );
});
