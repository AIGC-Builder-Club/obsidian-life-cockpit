'use strict';

const test = require('node:test');
const assert = require('node:assert');
const core = require('./.build/core.js');

const MIN = 60_000;

function config(overrides = {}) {
  return {
    workMs: 25 * MIN,
    breakMs: 5 * MIN,
    longBreakMs: 15 * MIN,
    pomodorosPerLongBreak: 4,
    ...overrides,
  };
}

/** 休息跑完之后工作段停着等人（AME-239），所以跨段推进时要替「人」按一下开工。 */
function resumeIfWaiting(cfg, state, at) {
  if (state.status !== 'paused') return state;
  return core.reduce(cfg, state, { type: 'resume', at }).state;
}

/** 依次施加动作，返回最后的 state 和沿途所有事件。 */
function run(cfg, actions, initial = core.createInitialState()) {
  let state = initial;
  const events = [];
  for (const action of actions) {
    const result = core.reduce(cfg, state, action);
    state = result.state;
    events.push(...result.events);
  }
  return { state, events };
}

// ---------------------------------------------------------------------------
// 开始 / 暂停 / 继续
// ---------------------------------------------------------------------------

test('start 从 idle 进入第 1 个番茄的工作段', () => {
  const { state, events } = run(config(), [{ type: 'start', at: 0, task: '写 PRD' }]);
  assert.strictEqual(state.status, 'running');
  assert.strictEqual(state.kind, 'work');
  assert.strictEqual(state.pomodoroIndex, 1);
  assert.strictEqual(state.plannedMs, 25 * MIN);
  assert.strictEqual(state.task, '写 PRD');
  assert.deepStrictEqual(events, [
    { type: 'segment-started', kind: 'work', pomodoroIndex: 1, plannedMs: 25 * MIN },
  ]);
});

test('已经在跑时再 start 不会重开一段', () => {
  const first = run(config(), [{ type: 'start', at: 0 }]);
  const second = core.reduce(config(), first.state, { type: 'start', at: 5 * MIN });
  assert.deepStrictEqual(second.state, first.state);
  assert.deepStrictEqual(second.events, []);
});

test('暂停不计时，继续之后接着算', () => {
  const cfg = config();
  const { state } = run(cfg, [
    { type: 'start', at: 0 },
    { type: 'pause', at: 10 * MIN },
  ]);
  assert.strictEqual(state.status, 'paused');
  assert.strictEqual(state.accumulatedMs, 10 * MIN);

  // 暂停期间时间流逝不算数
  assert.strictEqual(core.elapsedMs(state, 40 * MIN), 10 * MIN);
  assert.strictEqual(core.remainingMs(state, 40 * MIN), 15 * MIN);

  const resumed = core.reduce(cfg, state, { type: 'resume', at: 40 * MIN }).state;
  assert.strictEqual(resumed.status, 'running');
  assert.strictEqual(core.elapsedMs(resumed, 45 * MIN), 15 * MIN);
});

test('暂停中的 tick 不会推进也不会完成', () => {
  const cfg = config();
  const { state } = run(cfg, [
    { type: 'start', at: 0 },
    { type: 'pause', at: 1 * MIN },
  ]);
  const ticked = core.reduce(cfg, state, { type: 'tick', at: 999 * MIN });
  assert.deepStrictEqual(ticked.events, []);
  assert.strictEqual(ticked.state.kind, 'work');
});

// ---------------------------------------------------------------------------
// 跑满 / 轮转
// ---------------------------------------------------------------------------

test('工作段跑满转休息段，番茄序号不变', () => {
  const cfg = config();
  const { state, events } = run(cfg, [
    { type: 'start', at: 0 },
    { type: 'tick', at: 24 * MIN },
    { type: 'tick', at: 25 * MIN },
  ]);

  const completed = events.filter((e) => e.type === 'segment-completed');
  assert.strictEqual(completed.length, 1);
  assert.strictEqual(completed[0].segment.kind, 'work');
  assert.strictEqual(completed[0].segment.completed, true);
  assert.strictEqual(completed[0].segment.actualMs, 25 * MIN);
  assert.strictEqual(completed[0].segment.pomodoroIndex, 1);

  assert.strictEqual(state.kind, 'break');
  assert.strictEqual(state.pomodoroIndex, 1);
  assert.strictEqual(state.plannedMs, 5 * MIN);
  assert.strictEqual(state.status, 'running');
});

test('休息段跑满回到工作段，番茄序号 +1', () => {
  const cfg = config();
  const { state } = run(cfg, [
    { type: 'start', at: 0 },
    { type: 'tick', at: 25 * MIN },
    { type: 'tick', at: 30 * MIN },
  ]);
  assert.strictEqual(state.kind, 'work');
  assert.strictEqual(state.pomodoroIndex, 2);
});

test('每 4 个番茄之后是长休息', () => {
  const cfg = config();
  let state = core.createInitialState();
  let at = 0;
  const kinds = [];

  state = core.reduce(cfg, state, { type: 'start', at }).state;
  for (let i = 0; i < 8; i += 1) {
    at += state.plannedMs;
    const result = core.reduce(cfg, state, { type: 'tick', at });
    // 每一次进入工作段都得有人按一下开工——这一版里没有别的走法。
    state = resumeIfWaiting(cfg, result.state, at);
    kinds.push(state.kind);
  }

  assert.deepStrictEqual(kinds, [
    'break', 'work',
    'break', 'work',
    'break', 'work',
    'long-break', 'work',
  ]);
});

// AME-231：休息段一律自跑。从前休息段也吃 autoStartNext 这个开关，关掉之后
// 遮罩弹出来、表停在 05:00 一动不动，而状态栏那个「⏸」恰好被遮罩盖住——
// 看上去就是「倒计时坏了」。
test('休息段一律自跑：休息立刻开始走', () => {
  const cfg = config();
  const { state } = run(cfg, [
    { type: 'start', at: 0 },
    { type: 'tick', at: 25 * MIN },
  ]);
  assert.strictEqual(state.status, 'running');
  assert.strictEqual(state.kind, 'break');
  assert.strictEqual(state.segmentStartedAt, 25 * MIN);
  assert.strictEqual(core.remainingMs(state, 25 * MIN + 60_000), 4 * MIN);
});

test('长休息同样自跑', () => {
  const cfg = config({ pomodorosPerLongBreak: 1 });
  const { state } = run(cfg, [
    { type: 'start', at: 0 },
    { type: 'tick', at: 25 * MIN },
  ]);
  assert.strictEqual(state.kind, 'long-break');
  assert.strictEqual(state.status, 'running');
});

// AME-239：「【开工】永远是 人类手动的行为（【自动开工】永远是无法被接受的！）」
// 从前这一侧看 autoStartNext，而它默认开着——休息一结束工作段就自己跑起来了，
// 人还没回到电脑前，表已经在替他计专注时间。那个开关整个删了，不是改默认值。
test('工作段永不自跑：休息跑完停在整段时长上等人开工', () => {
  const cfg = config();
  const { state } = run(cfg, [
    { type: 'start', at: 0 },
    { type: 'tick', at: 25 * MIN },
    { type: 'tick', at: 30 * MIN },
  ]);
  assert.strictEqual(state.status, 'paused', '休息之后一定停着等人');
  assert.strictEqual(state.kind, 'work');
  assert.strictEqual(state.accumulatedMs, 0);
  assert.strictEqual(state.segmentStartedAt, null);
  // 停着的时候剩余时间就是整段时长，不是 0——界面上得说清楚它在等人。
  assert.strictEqual(core.remainingMs(state, 99 * MIN), 25 * MIN);

  const resumed = core.reduce(cfg, state, { type: 'resume', at: 100 * MIN }).state;
  assert.strictEqual(resumed.segmentStartedAt, 100 * MIN);
  assert.strictEqual(resumed.status, 'running');
});

test('人不点开工，表就一直停着——tick 多久都不会自己跑起来', () => {
  const cfg = config();
  let { state } = run(cfg, [
    { type: 'start', at: 0 },
    { type: 'tick', at: 25 * MIN },
    { type: 'tick', at: 30 * MIN },
  ]);
  // 两个小时的 tick：一次都不许把它推成 running，也不许多记一段流水。
  const events = [];
  for (let minute = 31; minute <= 150; minute += 1) {
    const out = core.reduce(cfg, state, { type: 'tick', at: minute * MIN });
    state = out.state;
    events.push(...out.events);
  }
  assert.strictEqual(state.status, 'paused');
  assert.strictEqual(state.kind, 'work');
  assert.deepStrictEqual(events, []);
  assert.strictEqual(core.elapsedMs(state, 150 * MIN), 0, '停着的段一毫秒专注时间都不该记');
});

test('电脑休眠导致 tick 迟到，只记计划内的时长', () => {
  const cfg = config();
  const { events } = run(cfg, [
    { type: 'start', at: 0 },
    { type: 'tick', at: 300 * MIN },
  ]);
  const segment = events.find((e) => e.type === 'segment-completed').segment;
  assert.strictEqual(segment.actualMs, 25 * MIN);
  assert.strictEqual(segment.completed, true);
  assert.strictEqual(segment.endedAt, 300 * MIN);
});

// ---------------------------------------------------------------------------
// 结束（「跳过本段」已经整层拿掉）
// ---------------------------------------------------------------------------

// AME-239：「【跳过本段】…完全是【不明所以】…这和我们的强制性干预的原则，
// 是完全违反的。」按钮拿掉不够——动作本身也从状态机里删了，
// 否则下一个人迟早把它再接回某个界面上去。
test('skip 动作已经不存在：喂给状态机也什么都不会发生', () => {
  const cfg = config();
  const started = run(cfg, [{ type: 'start', at: 0 }]);
  const after = core.reduce(cfg, started.state, { type: 'skip', at: 7 * MIN });
  assert.deepStrictEqual(after.state, started.state, '状态一个字节都不该变');
  assert.deepStrictEqual(after.events, [], '也不该记一段未完成的流水');
});

// AME-258 第 18 条：「不管是自然完成还是结束；强干扰和提示 仍然会照规则存在的。」
//
// 这一条改掉了 0.9.0 及以前的行为——那时 `stop` 直接回 idle，于是 main.ts 一路收摊：
// 待命清掉、强提醒页作废、干扰归零。**一颗看着只像「这个番茄提前结束」的按钮，
// 把整套强约束关掉了。** 所以下面这几条断言是有意改的，不是漏改。
test('结束本段：照实记成未完成，但接着进休息，不回 idle', () => {
  const cfg = config();
  const { state, events } = run(cfg, [
    { type: 'start', at: 0 },
    { type: 'stop', at: 3 * MIN },
  ]);
  assert.strictEqual(state.status, 'running', '休息的钟当场就该开始走');
  assert.strictEqual(state.kind, 'break');
  assert.strictEqual(state.pomodoroIndex, 1, '休息跟着它前面那个番茄的序号');
  assert.strictEqual(events.filter((e) => e.type === 'stopped').length, 0, '这不是收工');

  const segment = events.find((e) => e.type === 'segment-completed').segment;
  assert.strictEqual(segment.completed, false, '提前结束就是未完成，账上不许美化');
  assert.strictEqual(segment.actualMs, 3 * MIN);
});

test('结束休息段：停在工作段等人开工，也就是进入待命', () => {
  const cfg = config();
  const { state } = run(cfg, [
    { type: 'start', at: 0 },
    { type: 'stop', at: 3 * MIN },
    { type: 'stop', at: 4 * MIN },
  ]);
  // 「开工永远是人类手动的行为」（AME-239）——所以这里是 paused 不是 running。
  assert.strictEqual(state.status, 'paused');
  assert.strictEqual(state.kind, 'work');
  assert.strictEqual(state.pomodoroIndex, 2);
});

test('一秒没跑过的段结束不了——那等于把「跳过本段」从后门放回来', () => {
  const cfg = config();
  // 休息跑完，工作段停着等人：这一刻按结束，不该换来一段休息。
  const waiting = run(cfg, [
    { type: 'start', at: 0 },
    { type: 'tick', at: 25 * MIN },
    { type: 'tick', at: 30 * MIN },
  ]).state;
  assert.strictEqual(waiting.kind, 'work');
  assert.strictEqual(waiting.segmentStartedAt, null);

  const after = core.reduce(cfg, waiting, { type: 'stop', at: 31 * MIN });
  assert.deepStrictEqual(after.state, waiting, '状态一个字节都不该变');
  assert.deepStrictEqual(after.events, [], '也不该记一段 0 秒的流水');
});

test('今天收工才回 idle——那是一个得专门说出口的决定', () => {
  const cfg = config();
  const { state, events } = run(cfg, [
    { type: 'start', at: 0 },
    { type: 'close-day', at: 3 * MIN },
  ]);
  assert.strictEqual(state.status, 'idle');
  assert.strictEqual(state.pomodoroIndex, 1, '当日序号保留，供状态栏显示');
  assert.strictEqual(events.filter((e) => e.type === 'stopped').length, 1);

  const segment = events.find((e) => e.type === 'segment-completed').segment;
  assert.strictEqual(segment.completed, false);
  assert.strictEqual(segment.actualMs, 3 * MIN);
});

test('idle 状态下 pause / resume / skip / stop / close-day 都是空操作', () => {
  const cfg = config();
  const idle = core.createInitialState();
  for (const type of ['pause', 'resume', 'skip', 'stop', 'close-day', 'tick']) {
    const result = core.reduce(cfg, idle, { type, at: 5 * MIN });
    assert.deepStrictEqual(result.state, idle, `${type} 不该改状态`);
    assert.deepStrictEqual(result.events, [], `${type} 不该发事件`);
  }
});

test('暂停后结束，只算暂停之前跑过的时间', () => {
  const cfg = config();
  const { events } = run(cfg, [
    { type: 'start', at: 0 },
    { type: 'pause', at: 4 * MIN },
    { type: 'stop', at: 90 * MIN },
  ]);
  const segment = events.find((e) => e.type === 'segment-completed').segment;
  assert.strictEqual(segment.actualMs, 4 * MIN);
});

// ---------------------------------------------------------------------------
// 显示与配置
// ---------------------------------------------------------------------------

test('formatDuration 补零到 mm:ss', () => {
  assert.strictEqual(core.formatDuration(0), '00:00');
  assert.strictEqual(core.formatDuration(65_000), '01:05');
  assert.strictEqual(core.formatDuration(25 * MIN), '25:00');
  assert.strictEqual(core.formatDuration(-5), '00:00');
});

test('progress 在 0..1 之间且跑满封顶', () => {
  const cfg = config();
  const { state } = run(cfg, [{ type: 'start', at: 0 }]);
  assert.strictEqual(core.progress(state, 0), 0);
  assert.strictEqual(core.progress(state, 12.5 * MIN), 0.5);
  assert.strictEqual(core.progress(state, 999 * MIN), 1);
});

// 0.9.0 起两种模式的基准时长对调（AME-244）：「【思考优先】应该是 25 分钟的时长基准；
// 而【加速实践】应该是 45 分钟的时长基准。」老断言写死的正是被推翻的那两个数。
test('configFromMode 把两种模式的分钟数换成毫秒', () => {
  const settings = core.DEFAULT_SETTINGS;
  const fast = core.configFromMode(settings.modes['accelerated-practice']);
  assert.strictEqual(fast.workMs, 45 * MIN);
  assert.strictEqual(fast.breakMs, 10 * MIN);

  const slow = core.configFromMode(settings.modes['thinking-first']);
  assert.strictEqual(slow.workMs, 25 * MIN);
  assert.strictEqual(slow.breakMs, 5 * MIN);
  // 自动开工那个开关不该再存在——留着就迟早会被打开。
  assert.strictEqual('autoStartNext' in slow, false);
  assert.strictEqual('autoStartNext' in core.DEFAULT_SETTINGS, false);
});

// ---------------------------------------------------------------------------
// 间歇节奏（AME-244）
// ---------------------------------------------------------------------------

function alternating(overrides = {}) {
  return config({ alternateEnabled: true, alternateRatio: 0.5, ...overrides });
}

test('间歇节奏关着时每一段都是基准时长', () => {
  const cfg = config();
  assert.strictEqual(core.cycleRatio(cfg, 1), 1);
  assert.strictEqual(core.cycleRatio(cfg, 2), 1);
  assert.strictEqual(core.plannedMsFor(cfg, 'work', 2), 25 * MIN);
});

test('间歇节奏开着：单数番茄基准、双数番茄减半，长休息不缩', () => {
  const cfg = alternating();
  assert.strictEqual(core.plannedMsFor(cfg, 'work', 1), 25 * MIN);
  assert.strictEqual(core.plannedMsFor(cfg, 'work', 2), 12.5 * MIN);
  assert.strictEqual(core.plannedMsFor(cfg, 'work', 3), 25 * MIN);
  // 跟着的那一小段休息一起缩——原话要的是「节奏和间歇」都换。
  assert.strictEqual(core.plannedMsFor(cfg, 'break', 2), 2.5 * MIN);
  // 「此处，为了简化 和长休息的轮数无关」：长休息一律原长。
  assert.strictEqual(core.plannedMsFor(cfg, 'long-break', 2), 15 * MIN);
});

test('间歇节奏跑起来：第 1 个 25 分钟，第 2 个 12.5 分钟', () => {
  const cfg = alternating();
  let state = core.reduce(cfg, core.createInitialState(), { type: 'start', at: 0 }).state;
  assert.strictEqual(state.plannedMs, 25 * MIN);

  // 第 1 个番茄跑完 → 休息（跟着第 1 个，不缩）
  state = core.reduce(cfg, state, { type: 'tick', at: 25 * MIN }).state;
  assert.strictEqual(state.kind, 'break');
  assert.strictEqual(state.plannedMs, 5 * MIN);

  // 休息跑完 → 第 2 个番茄，停着等人开工，且计划时长减半
  state = core.reduce(cfg, state, { type: 'tick', at: 30 * MIN }).state;
  assert.strictEqual(state.kind, 'work');
  assert.strictEqual(state.pomodoroIndex, 2);
  assert.strictEqual(state.status, 'paused');
  assert.strictEqual(state.plannedMs, 12.5 * MIN);

  // 第 2 个跑完 → 它后面那段休息也减半
  state = core.reduce(cfg, state, { type: 'resume', at: 30 * MIN }).state;
  state = core.reduce(cfg, state, { type: 'tick', at: 42.5 * MIN }).state;
  assert.strictEqual(state.kind, 'break');
  assert.strictEqual(state.plannedMs, 2.5 * MIN);
});

test('倍数封在 0.1–1：0 或负数会造出一段立刻跑完的番茄', () => {
  const mode = core.DEFAULT_SETTINGS.modes['thinking-first'];
  assert.strictEqual(core.configFromMode(mode, { enabled: true, ratio: 0 }).alternateRatio, 0.1);
  assert.strictEqual(core.configFromMode(mode, { enabled: true, ratio: 9 }).alternateRatio, 1);
  assert.strictEqual(
    core.configFromMode(mode, { enabled: true, ratio: 'half' }).alternateRatio,
    0.5,
  );
  // 不传第二个参数 = 老调用方，节奏一律不变。
  assert.strictEqual(core.configFromMode(mode).alternateEnabled, false);
});

test('describeAlternatePlan 把两档节奏说成人话', () => {
  const mode = core.DEFAULT_SETTINGS.modes['thinking-first'];
  const off = core.describeAlternatePlan(mode, { enabled: false, ratio: 0.5 });
  assert.match(off, /每个番茄都是 25 \+ 5 分钟/);
  const on = core.describeAlternatePlan(mode, { enabled: true, ratio: 0.5 });
  assert.match(on, /单数番茄 25 \+ 5 分钟/);
  assert.match(on, /双数番茄 12\.5 \+ 2\.5 分钟/);
  assert.match(on, /长休息 15 分钟不缩/);
});

test('切模式改的是工作 / 休息时长与提醒节律', () => {
  const fast = core.DEFAULT_SETTINGS.modes['accelerated-practice'];
  const slow = core.DEFAULT_SETTINGS.modes['thinking-first'];
  assert.notStrictEqual(fast.workMinutes, slow.workMinutes);
  assert.notStrictEqual(fast.breakMinutes, slow.breakMinutes);
  assert.notStrictEqual(fast.reminderIntervalMinutes, slow.reminderIntervalMinutes);
  assert.notDeepStrictEqual(fast.themeCycle, slow.themeCycle);
});

test('resetDayCounter 在 idle 时归零，在跑的时候回到 1', () => {
  const cfg = config();
  const stopped = run(cfg, [
    { type: 'start', at: 0 },
    { type: 'close-day', at: 1 * MIN },
  ]).state;
  assert.strictEqual(core.resetDayCounter(stopped).pomodoroIndex, 0);

  const running = run(cfg, [{ type: 'start', at: 0 }]).state;
  assert.strictEqual(core.resetDayCounter(running).pomodoroIndex, 1);
});
