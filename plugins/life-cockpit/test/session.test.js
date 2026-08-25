'use strict';

// 跨重启的现场（AME-244）。**这一套用例守的是同一条线**：
// 离开的那段时间，要么真的属于你，要么一秒都不算。

const test = require('node:test');
const assert = require('node:assert');
const core = require('./.build/core.js');

const MIN = 60_000;
const DAY = '2026-08-15';

function config(overrides = {}) {
  return {
    workMs: 25 * MIN,
    breakMs: 5 * MIN,
    longBreakMs: 15 * MIN,
    pomodorosPerLongBreak: 4,
    alternateEnabled: false,
    alternateRatio: 0.5,
    ...overrides,
  };
}

function settings(overrides = {}) {
  return { sessionRestoreEnabled: true, sessionGraceMinutes: 5, ...overrides };
}

/** 存下一份「工作段跑到一半」的现场。`at` 是关掉 Obsidian 的时刻。 */
function running(kind = 'work', startedAt = 0, savedAt = 10 * MIN, extra = {}) {
  const cfg = config();
  let state = core.reduce(cfg, core.createInitialState(), { type: 'start', at: startedAt }).state;
  if (kind !== 'work') {
    state = { ...state, kind, plannedMs: core.plannedMsFor(cfg, kind, state.pomodoroIndex) };
  }
  return core.createSessionSnapshot({
    now: savedAt,
    day: DAY,
    timer: state,
    taskId: 'writing',
    goalId: 'goal-7',
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// 存下来 / 读回去
// ---------------------------------------------------------------------------

test('存下来的是绝对时刻，读回去一字不差', () => {
  const snapshot = running();
  const parsed = core.normalizeSession(JSON.parse(JSON.stringify(snapshot)));
  assert.deepStrictEqual(parsed, snapshot);
});

test('半份 / 坏掉的现场一律当没存过', () => {
  assert.strictEqual(core.normalizeSession(null), null);
  assert.strictEqual(core.normalizeSession('nope'), null);
  assert.strictEqual(core.normalizeSession({ savedAt: 1 }), null);
  // 时间戳缺了就没法算「离开多久」，整份作废——半份状态比没有更危险。
  const noSavedAt = { ...running(), savedAt: 'now' };
  assert.strictEqual(core.normalizeSession(noSavedAt), null);
  // 状态机里不存在的段类型同理。
  const badKind = running();
  assert.strictEqual(
    core.normalizeSession({ ...badKind, timer: { ...badKind.timer, kind: 'nap' } }),
    null,
  );
});

test('挂着的任务与目标原样带回来', () => {
  const parsed = core.normalizeSession(running());
  assert.strictEqual(parsed.taskId, 'writing');
  assert.strictEqual(parsed.goalId, 'goal-7');
  // 没挂就是 null，不是 undefined——写进 data.json 的东西要长得稳定。
  const bare = core.normalizeSession({ ...running(), taskId: 7, goalId: undefined });
  assert.strictEqual(bare.taskId, null);
  assert.strictEqual(bare.goalId, null);
});

// ---------------------------------------------------------------------------
// 接不接得回来
// ---------------------------------------------------------------------------

test('没存过 / 关掉了 / 存的时候本来就没在跑：什么都不接', () => {
  const base = { settings: settings(), config: config(), now: 20 * MIN, day: DAY };
  assert.strictEqual(core.restoreSession({ ...base, session: null }).kind, 'none');
  assert.strictEqual(
    core.restoreSession({ ...base, session: running(), settings: settings({ sessionRestoreEnabled: false }) })
      .kind,
    'none',
  );
  const idle = core.createSessionSnapshot({
    now: 10 * MIN,
    day: DAY,
    timer: core.createInitialState(),
    taskId: null,
    goalId: null,
  });
  assert.strictEqual(core.restoreSession({ ...base, session: idle }).kind, 'none');
});

test('重启 20 秒回来：原样接着跑，中间那 20 秒照算', () => {
  const session = running('work', 0, 10 * MIN);
  const restore = core.restoreSession({
    session,
    settings: settings(),
    config: config(),
    now: 10 * MIN + 20_000,
    day: DAY,
  });
  assert.strictEqual(restore.kind, 'resumed');
  assert.strictEqual(restore.state.status, 'running');
  // 起点没被挪过，所以墙上时钟走了多久就是跑了多久。
  assert.strictEqual(core.elapsedMs(restore.state, 10 * MIN + 20_000), 10 * MIN + 20_000);
});

test('走开两小时回来：番茄冻在关掉那一刻，一秒都不多算', () => {
  const session = running('work', 0, 10 * MIN);
  const now = 130 * MIN;
  const restore = core.restoreSession({
    session,
    settings: settings(),
    config: config(),
    now,
    day: DAY,
  });
  assert.strictEqual(restore.kind, 'held');
  assert.strictEqual(restore.frozen, true);
  assert.strictEqual(restore.state.status, 'paused');
  // 关掉时跑了 10 分钟，现在还是 10 分钟——离开的两小时一秒没进专注。
  assert.strictEqual(core.elapsedMs(restore.state, now), 10 * MIN);
  assert.strictEqual(core.remainingMs(restore.state, now), 15 * MIN);
  assert.strictEqual(restore.state.pomodoroIndex, 1);
});

test('宽限期是边界，不是建议：卡在点上算接得回来，超一秒就冻住', () => {
  const session = running('work', 0, 10 * MIN);
  const base = { session, settings: settings(), config: config(), day: DAY };
  assert.strictEqual(core.restoreSession({ ...base, now: 15 * MIN }).kind, 'resumed');
  assert.strictEqual(core.restoreSession({ ...base, now: 15 * MIN + 1000 }).kind, 'held');
  // 宽限期改成 0 = 一切离开都不算数。
  const strict = { ...base, settings: settings({ sessionGraceMinutes: 0 }) };
  assert.strictEqual(core.restoreSession({ ...strict, now: 10 * MIN + 1000 }).kind, 'held');
});

test('本来就停着等人开工：接回来还是停着，且不算「冻住的」', () => {
  const cfg = config();
  let state = core.reduce(cfg, core.createInitialState(), { type: 'start', at: 0 }).state;
  state = core.reduce(cfg, state, { type: 'pause', at: 4 * MIN }).state;
  const session = core.createSessionSnapshot({
    now: 4 * MIN,
    day: DAY,
    timer: state,
    taskId: null,
    goalId: null,
  });
  const restore = core.restoreSession({
    session,
    settings: settings(),
    config: cfg,
    now: 300 * MIN,
    day: DAY,
  });
  assert.strictEqual(restore.kind, 'held');
  assert.strictEqual(restore.frozen, false);
  assert.strictEqual(core.elapsedMs(restore.state, 300 * MIN), 4 * MIN);
});

// ---------------------------------------------------------------------------
// 休息段：按墙上的钟走
// ---------------------------------------------------------------------------

test('休息还没到点：接着跑，宽限期管不着它', () => {
  const session = running('break', 0, 1 * MIN);
  const restore = core.restoreSession({
    session,
    settings: settings(),
    config: config(),
    // 离开了 3 分钟，远超工作段的口径也不影响休息——人不在正好是在休息。
    now: 4 * MIN,
    day: DAY,
  });
  assert.strictEqual(restore.kind, 'resumed');
  assert.strictEqual(restore.state.kind, 'break');
  assert.strictEqual(core.remainingMs(restore.state, 4 * MIN), 1 * MIN);
});

test('离开期间休息跑完了：补记那一段，然后停在「等你开工」', () => {
  const session = running('break', 0, 1 * MIN);
  const restore = core.restoreSession({
    session,
    settings: settings(),
    config: config(),
    now: 90 * MIN,
    day: DAY,
  });
  assert.strictEqual(restore.kind, 'handoff');

  const done = restore.events.find((event) => event.type === 'segment-completed').segment;
  assert.strictEqual(done.kind, 'break');
  assert.strictEqual(done.completed, true);
  // 记的是它**当时**真的跑完的那一刻，不是现在。
  assert.strictEqual(done.endedAt, 5 * MIN);
  assert.strictEqual(done.actualMs, 5 * MIN);

  // 下一段是工作段，而且**停着**：开工永远是人手动的（AME-239）。
  assert.strictEqual(restore.state.kind, 'work');
  assert.strictEqual(restore.state.status, 'paused');
  assert.strictEqual(restore.state.pomodoroIndex, 2);
  assert.strictEqual(core.elapsedMs(restore.state, 90 * MIN), 0);
});

test('补记那一段用的是存下来的计划时长，不是现在设置里的', () => {
  const session = running('break', 0, 1 * MIN);
  // 人在关掉之后把休息改成了 20 分钟——已经跑过的那一段不该跟着变。
  const restore = core.restoreSession({
    session,
    settings: settings(),
    config: config({ breakMs: 20 * MIN }),
    now: 90 * MIN,
    day: DAY,
  });
  const done = restore.events.find((event) => event.type === 'segment-completed').segment;
  assert.strictEqual(done.plannedMs, 5 * MIN);
  assert.strictEqual(done.endedAt, 5 * MIN);
  // 而接下来那一段用的是新配置。
  assert.strictEqual(restore.state.plannedMs, 25 * MIN);
});

// ---------------------------------------------------------------------------
// 换天
// ---------------------------------------------------------------------------

test('跨过归日点的那一段整段作废，不往新的一天搬', () => {
  const session = running('work', 0, 10 * MIN);
  const restore = core.restoreSession({
    session,
    settings: settings(),
    config: config(),
    now: 600 * MIN,
    day: '2026-08-16',
  });
  assert.strictEqual(restore.kind, 'dropped');
  assert.strictEqual('state' in restore, false);
  assert.match(core.describeRestore(restore, session), /没有补记进任何一天的账/);
});

test('describeRestore 每一种情况都说得出「离开了多久、算不算」', () => {
  const session = running('work', 0, 10 * MIN);
  const base = { session, settings: settings(), config: config(), day: DAY };
  assert.match(core.describeRestore(core.restoreSession({ ...base, now: 11 * MIN }), session), /接着上次/);

  const frozen = core.restoreSession({ ...base, now: 130 * MIN });
  const text = core.describeRestore(frozen, session);
  assert.match(text, /2 小时/);
  assert.match(text, /一秒没算进专注/);

  const handoff = core.restoreSession({
    ...base,
    session: running('break', 0, 1 * MIN),
    now: 40 * MIN,
  });
  assert.match(core.describeRestore(handoff, session), /停着等你按开工/);
});
