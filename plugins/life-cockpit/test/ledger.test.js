'use strict';

const test = require('node:test');
const assert = require('node:assert');
const core = require('./.build/core.js');

const OPTIONS = { targetMinutes: 560, windowHours: 14, generator: 'life-cockpit@0.1.0' };

function session(overrides = {}) {
  return {
    id: 'work-1-1000',
    kind: 'work',
    startedAt: '2026-08-09T09:00:00+09:00',
    endedAt: '2026-08-09T09:25:00+09:00',
    plannedSeconds: 1500,
    actualSeconds: 1500,
    completed: true,
    task: '写 PRD',
    mode: 'accelerated-practice',
    pomodoroIndex: 1,
    phase: '土五',
    segment: '三小时工作日',
    points: null,
    pointsRule: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

test('空日档带上目标与 R2 积分预留位', () => {
  const day = core.createDayLedger('2026-08-09', OPTIONS);
  assert.strictEqual(day.schemaVersion, core.LEDGER_SCHEMA_VERSION);
  assert.strictEqual(day.totals.targetMinutes, 560);
  assert.strictEqual(day.totals.windowHours, 14);
  assert.deepStrictEqual(day.sessions, []);
  assert.deepStrictEqual(day.points, {
    schemaVersion: core.POINTS_SCHEMA_VERSION,
    earned: null,
    spent: null,
    balance: null,
    entries: [],
  });
});

test('每条流水都带够 R2 需要的字段', () => {
  const day = core.upsertSession(core.createDayLedger('2026-08-09', OPTIONS), session());
  const record = day.sessions[0];
  for (const key of [
    'startedAt', 'endedAt', 'actualSeconds', 'task', 'completed', 'mode',
    'points', 'pointsRule', 'phase', 'segment', 'pomodoroIndex',
  ]) {
    assert.ok(key in record, `缺字段 ${key}`);
  }
});

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

test('汇总只把工作段算进专注时间', () => {
  let day = core.createDayLedger('2026-08-09', OPTIONS);
  day = core.upsertSession(day, session());
  day = core.upsertSession(day, session({
    id: 'break-1-2500', kind: 'break', actualSeconds: 300, plannedSeconds: 300,
    startedAt: '2026-08-09T09:25:00+09:00', endedAt: '2026-08-09T09:30:00+09:00',
  }));
  day = core.upsertSession(day, session({
    id: 'work-2-3000', pomodoroIndex: 2, actualSeconds: 600, completed: false,
    startedAt: '2026-08-09T09:30:00+09:00', endedAt: '2026-08-09T09:40:00+09:00',
  }));

  assert.strictEqual(day.totals.workSeconds, 2100);
  assert.strictEqual(day.totals.breakSeconds, 300);
  assert.strictEqual(day.totals.completedPomodoros, 1);
  assert.strictEqual(day.totals.startedPomodoros, 2);
});

test('focusProgress 给出 560 分钟制的当日进度', () => {
  let day = core.createDayLedger('2026-08-09', OPTIONS);
  for (let i = 1; i <= 4; i += 1) {
    day = core.upsertSession(day, session({ id: `work-${i}-${i * 1000}`, pomodoroIndex: i }));
  }
  const progress = core.focusProgress(day);
  assert.strictEqual(progress.minutes, 100);
  assert.strictEqual(progress.targetMinutes, 560);
  assert.ok(Math.abs(progress.ratio - 100 / 560) < 1e-9);
});

test('超额完成时进度封顶 1', () => {
  let day = core.createDayLedger('2026-08-09', { ...OPTIONS, targetMinutes: 10 });
  day = core.upsertSession(day, session({ actualSeconds: 36_000 }));
  assert.strictEqual(core.focusProgress(day).ratio, 1);
});

// ---------------------------------------------------------------------------
// 读写幂等
// ---------------------------------------------------------------------------

test('同一份数据序列化两次字节完全一样', () => {
  let day = core.createDayLedger('2026-08-09', OPTIONS);
  day = core.upsertSession(day, session());
  assert.strictEqual(core.serializeDayLedger(day), core.serializeDayLedger(day));
});

test('序列化 → 解析 → 再序列化，结果不变', () => {
  let day = core.createDayLedger('2026-08-09', OPTIONS);
  day = core.upsertSession(day, session());
  day = core.upsertSession(day, session({
    id: 'break-1-2500', kind: 'break', actualSeconds: 300,
    startedAt: '2026-08-09T09:25:00+09:00',
  }));

  const once = core.serializeDayLedger(day);
  const twice = core.serializeDayLedger(core.parseDayLedger(once));
  assert.strictEqual(twice, once);
});

test('重复写同一条不会写出第二行，也不改字节', () => {
  let day = core.createDayLedger('2026-08-09', OPTIONS);
  day = core.upsertSession(day, session());
  const before = core.serializeDayLedger(day);

  day = core.upsertSession(day, session());
  assert.strictEqual(day.sessions.length, 1);
  assert.strictEqual(core.serializeDayLedger(day), before);
  assert.strictEqual(core.shouldWrite(before, core.serializeDayLedger(day)), false);
});

test('同 id 重放会覆盖旧值而不是叠加', () => {
  let day = core.createDayLedger('2026-08-09', OPTIONS);
  day = core.upsertSession(day, session({ actualSeconds: 600, completed: false }));
  day = core.upsertSession(day, session({ actualSeconds: 1500, completed: true }));
  assert.strictEqual(day.sessions.length, 1);
  assert.strictEqual(day.totals.workSeconds, 1500);
  assert.strictEqual(day.totals.completedPomodoros, 1);
});

test('乱序写入后顺序稳定，字节与顺序写入一致', () => {
  const a = session({ id: 'work-1-1000', startedAt: '2026-08-09T09:00:00+09:00' });
  const b = session({ id: 'work-2-2000', pomodoroIndex: 2, startedAt: '2026-08-09T10:00:00+09:00' });
  const c = session({ id: 'work-3-3000', pomodoroIndex: 3, startedAt: '2026-08-09T11:00:00+09:00' });

  let forward = core.createDayLedger('2026-08-09', OPTIONS);
  for (const s of [a, b, c]) forward = core.upsertSession(forward, s);

  let shuffled = core.createDayLedger('2026-08-09', OPTIONS);
  for (const s of [c, a, b]) shuffled = core.upsertSession(shuffled, s);

  assert.strictEqual(core.serializeDayLedger(shuffled), core.serializeDayLedger(forward));
});

test('内容变了才写', () => {
  const day = core.createDayLedger('2026-08-09', OPTIONS);
  const text = core.serializeDayLedger(day);
  assert.strictEqual(core.shouldWrite(text, text), false);
  assert.strictEqual(core.shouldWrite(null, text), true, '文件不存在要写');
  assert.strictEqual(
    core.shouldWrite(text, core.serializeDayLedger(core.upsertSession(day, session()))),
    true,
  );
});

test('结尾恰好一个换行', () => {
  const text = core.serializeDayLedger(core.createDayLedger('2026-08-09', OPTIONS));
  assert.ok(text.endsWith('}\n'));
  assert.ok(!text.endsWith('\n\n'));
});

// ---------------------------------------------------------------------------
// 解析容错
// ---------------------------------------------------------------------------

test('读坏文件返回 null 而不是抛异常', () => {
  assert.strictEqual(core.parseDayLedger('{ 不是 JSON'), null);
  assert.strictEqual(core.parseDayLedger('[]'), null);
  assert.strictEqual(core.parseDayLedger('null'), null);
  assert.strictEqual(core.parseDayLedger('{}'), null, '没有 date 就不算日档');
});

test('R2 之后写进来的积分不会被 R1 的重算抹掉', () => {
  let day = core.createDayLedger('2026-08-09', OPTIONS);
  day = core.upsertSession(day, session());

  const withPoints = JSON.parse(core.serializeDayLedger(day));
  withPoints.points = {
    schemaVersion: 1, earned: 12, spent: 4, balance: 8,
    entries: [{ id: 'e1', delta: 12, reason: '完成番茄' }],
  };
  withPoints.sessions[0].points = 12;
  withPoints.sessions[0].pointsRule = 'pomodoro-complete';

  const reparsed = core.parseDayLedger(JSON.stringify(withPoints));
  assert.strictEqual(reparsed.points.earned, 12);
  assert.strictEqual(reparsed.points.balance, 8);
  assert.strictEqual(reparsed.points.entries.length, 1);
  assert.strictEqual(reparsed.sessions[0].points, 12);
  assert.strictEqual(reparsed.sessions[0].pointsRule, 'pomodoro-complete');

  // 再追加一条 R1 的流水，积分段仍然原样保留
  const after = core.upsertSession(reparsed, session({ id: 'work-2-9000', pomodoroIndex: 2 }));
  assert.strictEqual(after.points.earned, 12);
});

test('没写全的旧流水会被丢掉，不污染汇总', () => {
  const raw = JSON.stringify({
    schemaVersion: 1,
    date: '2026-08-09',
    sessions: [session(), null, { kind: 'work' }],
  });
  const day = core.parseDayLedger(raw);
  assert.strictEqual(day.sessions.length, 1);
});

// ---------------------------------------------------------------------------
// 归日与时间格式
// ---------------------------------------------------------------------------

test('凌晨收工算前一天', () => {
  assert.strictEqual(core.dayKeyFor(new Date(2026, 7, 9, 23, 30), 4), '2026-08-09');
  assert.strictEqual(core.dayKeyFor(new Date(2026, 7, 10, 1, 30), 4), '2026-08-09');
  assert.strictEqual(core.dayKeyFor(new Date(2026, 7, 10, 3, 59), 4), '2026-08-09');
  assert.strictEqual(core.dayKeyFor(new Date(2026, 7, 10, 4, 0), 4), '2026-08-10');
});

test('归日翻月翻年都对', () => {
  assert.strictEqual(core.dayKeyFor(new Date(2026, 8, 1, 2, 0), 4), '2026-08-31');
  assert.strictEqual(core.dayKeyFor(new Date(2027, 0, 1, 2, 0), 4), '2026-12-31');
});

test('rolloverHour 设成 0 就是自然日', () => {
  assert.strictEqual(core.dayKeyFor(new Date(2026, 7, 10, 1, 30), 0), '2026-08-10');
});

test('formatLocalIso 带本地时区偏移，不是 UTC', () => {
  const iso = core.formatLocalIso(new Date(2026, 7, 9, 9, 5, 3));
  assert.match(iso, /^2026-08-09T09:05:03[+-]\d{2}:\d{2}$/);
});

test('makeSessionId 对同一段稳定', () => {
  assert.strictEqual(core.makeSessionId('work', 3, 1000), core.makeSessionId('work', 3, 1000));
  assert.notStrictEqual(core.makeSessionId('work', 3, 1000), core.makeSessionId('break', 3, 1000));
});
