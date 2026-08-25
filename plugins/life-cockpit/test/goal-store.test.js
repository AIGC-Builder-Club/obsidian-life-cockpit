'use strict';

// 目标树的落盘链路，以及它和 R1 番茄流水、R2 积分账本的两个接口。
// GoalStore 的文件访问全部走注入的 VaultIo，所以这里用一个内存 vault 就能跑成真的。

const test = require('node:test');
const assert = require('node:assert');
const core = require('./.build/core.js');

const GENERATOR = 'life-cockpit@0.3.0';
const GOAL_NOTE = 'Root/每日Journal/目标树.md';
const POINTS_FOLDER = 'Root/每日Journal/积分账本';
const LEDGER_FOLDER = 'Root/每日Journal/番茄流水';

function memoryVault(seed = {}) {
  const files = new Map(Object.entries(seed));
  const writes = [];
  return {
    files,
    writes,
    text(path) {
      return files.has(path) ? files.get(path) : null;
    },
    async read(path) {
      return files.has(path) ? files.get(path) : null;
    },
    async writeIfChanged(path, content) {
      if (files.get(path) === content) return false;
      files.set(path, content);
      writes.push(path);
      return true;
    },
    async listMarkdown(folder) {
      const prefix = folder ? `${folder}/` : '';
      return [...files.keys()]
        .filter((path) => path.startsWith(prefix) && path.endsWith('.md'))
        .map((path) => path.slice(prefix.length))
        .filter((name) => !name.includes('/'));
    },
  };
}

function makeStore(seed = {}, overrides = {}) {
  const io = memoryVault(seed);
  const settings = {
    ...core.DEFAULT_SETTINGS,
    goalTreeNote: GOAL_NOTE,
    pointsFolder: POINTS_FOLDER,
    pointsTaskNote: `${POINTS_FOLDER}/积分任务表.md`,
    ledgerFolder: LEDGER_FOLDER,
    ...overrides,
  };
  const goals = new core.GoalStore({ io, generator: GENERATOR, settings: () => settings });
  const points = new core.PointsStore({
    io,
    generator: GENERATOR,
    settings: () => settings,
    dayLedgerPath: (day) => `${LEDGER_FOLDER}/${day}.json`,
  });
  return { goals, points, io, settings };
}

function titles(store) {
  return core.walkGoals(store.roots).map((node) => node.title);
}

// ---------------------------------------------------------------------------
// 载入与落盘
// ---------------------------------------------------------------------------

test('笔记不存在时是一棵空树，并标出「还没建」', async () => {
  const { goals } = makeStore();
  await goals.load();
  assert.strictEqual(goals.hasNote, false);
  assert.strictEqual(goals.isEmpty, true);
  assert.strictEqual(goals.overall, 0);
});

test('写骨架：第一次落盘，第二次内容没变就不写', async () => {
  const { goals, io } = makeStore();
  await goals.load();

  assert.strictEqual(await goals.writeSkeleton(), true);
  assert.strictEqual(goals.hasNote, true);
  assert.strictEqual(core.walkGoals(goals.roots).length, 6);
  assert.strictEqual(await goals.save(), false, '内容没变不该再写一次');

  io.writes.length = 0;
  await goals.load();
  await goals.save();
  assert.deepStrictEqual(io.writes, [], '读回来再写一遍也不该落笔');
});

test('骨架已经有内容时不覆盖，只重写一遍', async () => {
  const { goals } = makeStore();
  await goals.load();
  await goals.create(null, { title: '我自己写的' });
  await goals.writeSkeleton();
  assert.deepStrictEqual(titles(goals), ['我自己写的']);
});

test('新建的子节点自动降一级，落盘之后读回来一样', async () => {
  const { goals, io } = makeStore();
  await goals.load();

  const root = await goals.create(null, { title: '宇宙' });
  const child = await goals.create(root.id, { title: '人生' });
  assert.strictEqual(child.level, 'life');

  const reopened = makeStore({ [GOAL_NOTE]: io.text(GOAL_NOTE) });
  await reopened.goals.load();
  assert.deepStrictEqual(titles(reopened.goals), ['宇宙', '人生']);
  assert.strictEqual(reopened.goals.find(child.id).level, 'life');
});

test('想跳级就传 level，父子关系照旧', async () => {
  const { goals } = makeStore();
  await goals.load();
  const root = await goals.create(null, { title: '人生', level: 'life' });
  const okr = await goals.create(root.id, { title: '今年', level: 'okr' });
  assert.strictEqual(okr.level, 'okr');

  const tooShallow = await goals.create(okr.id, { title: '倒挂的', level: 'universe' });
  assert.strictEqual(tooShallow.level, 'kpi', '再浅也不能浅过父节点');
});

test('改状态之后进度立刻回灌，并把新的进度写进盘', async () => {
  const { goals, io } = makeStore();
  await goals.load();
  const okr = await goals.create(null, { title: 'OKR', level: 'okr' });
  const a = await goals.create(okr.id, { title: 'KPI-A' });
  await goals.create(okr.id, { title: 'KPI-B' });

  await goals.setStatus(a.id, 'done');
  assert.strictEqual(goals.progressOf(okr.id).progress, 50);
  assert.match(io.text(GOAL_NOTE), /- \[ \] OKR \[层级:: OKR\] \[进度:: 50%\]/);
  assert.match(io.text(GOAL_NOTE), /\nprogress: 50\n/);
});

test('删除与同级挪动都会落盘', async () => {
  const { goals } = makeStore();
  await goals.load();
  const first = await goals.create(null, { title: '甲' });
  const second = await goals.create(null, { title: '乙' });

  await goals.move(second.id, -1);
  assert.deepStrictEqual(titles(goals), ['乙', '甲']);
  await goals.remove(first.id);
  assert.deepStrictEqual(titles(goals), ['乙']);
});

test('拆分建议要人确认才落盘，落下去的是子节点', async () => {
  const { goals, io } = makeStore();
  await goals.load();
  const okr = await goals.create(null, {
    title: '写完一本书',
    level: 'okr',
    metric: { current: 0, target: 12, unit: '章' },
  });

  const drafts = core.suggestBreakdown(goals.find(okr.id), {
    scheme: 'quarter',
    count: 4,
    from: new Date(2026, 0, 15, 12),
  });
  assert.strictEqual(io.text(GOAL_NOTE).includes('2026 Q1'), false, '只给建议，不自己落盘');

  const created = await goals.applyBreakdown(okr.id, drafts);
  assert.strictEqual(created.length, 4);
  assert.ok(created.every((node) => node.level === 'kpi'));
  assert.match(io.text(GOAL_NOTE), /写完一本书 · 2026 Q1/);

  await goals.setStatus(created[0].id, 'done');
  assert.strictEqual(goals.progressOf(okr.id).progress, 25, '第一季的 3 章 = 12 章的四分之一');
});

test('手工改坏的行读回来进《待修复》，重写不丢', async () => {
  const { goals, io } = makeStore();
  await goals.load();
  await goals.create(null, { title: '好的' });

  io.files.set(GOAL_NOTE, `${io.text(GOAL_NOTE)}- 这行忘了写记号\n`);
  await goals.load();
  assert.deepStrictEqual(goals.quarantine, ['- 这行忘了写记号']);

  await goals.save();
  assert.match(io.text(GOAL_NOTE), /## 待修复/);
  assert.match(io.text(GOAL_NOTE), /- 这行忘了写记号/);
});

test('直接在 vault 里手写一行，插件读得到并给它补号', async () => {
  const { goals, io } = makeStore();
  await goals.load();
  await goals.create(null, { title: '已有' });

  io.files.set(GOAL_NOTE, `${io.text(GOAL_NOTE)}- [/] 我在 Obsidian 里手写的\n`);
  await goals.load();
  assert.deepStrictEqual(titles(goals), ['已有', '我在 Obsidian 里手写的']);

  const handwritten = goals.roots[1];
  assert.strictEqual(handwritten.status, 'active');
  assert.match(handwritten.id, /^g-\d+$/);
});

// ---------------------------------------------------------------------------
// 冷启动竞态（AME-227）
// ---------------------------------------------------------------------------

/**
 * 蒙上眼睛：读回来一律 null、目录一律空——这就是冷启动时 vault 索引还没建好、
 * getAbstractFileByPath 对着真实存在的笔记返回 null 的那一小会儿。
 * 返回一个摘眼罩的函数：索引建好之后的那一刻。
 */
function blindfold(io) {
  const real = { read: io.read, listMarkdown: io.listMarkdown };
  io.read = async () => null;
  io.listMarkdown = async () => [];
  return () => Object.assign(io, real);
}

test('索引没建好时读空了，就不许拿空树盖掉盘上的目标树', async () => {
  const { goals, io } = makeStore();
  await goals.load();
  await goals.create(null, { title: '我的人生目标', level: 'life' });
  const onDisk = io.text(GOAL_NOTE);

  const seeAgain = blindfold(io);
  await goals.load();
  assert.strictEqual(goals.isEmpty, true, '读空了：这正是用户看到「下拉没有选项」的那一刻');
  assert.strictEqual(goals.hasNote, false);
  seeAgain();

  await assert.rejects(
    () => goals.create(null, { title: '这一笔不该落下去' }),
    core.StaleMissingError,
  );
  assert.strictEqual(io.text(GOAL_NOTE), onDisk, '盘上的目标树必须原封不动');
});

test('笔记是真的不在，写骨架照样落得下去', async () => {
  const { goals, io } = makeStore();
  await goals.load();
  assert.strictEqual(await goals.writeSkeleton(), true);
  assert.strictEqual(core.walkGoals(goals.roots).length, 6);
  assert.ok(io.text(GOAL_NOTE), '真空的时候不该被守卫拦住');
});

// ---------------------------------------------------------------------------
// 和 R1 番茄打通
// ---------------------------------------------------------------------------

test('能挂番茄的只有没完成的日内目标与 KPI', async () => {
  const { goals } = makeStore();
  await goals.load();
  const okr = await goals.create(null, { title: 'OKR', level: 'okr' });
  const kpi = await goals.create(okr.id, { title: 'KPI' });
  const daily = await goals.create(kpi.id, { title: '日内' });
  const finished = await goals.create(kpi.id, { title: '做完的', status: 'done' });
  await goals.create(kpi.id, { title: '放弃的', status: 'dropped' });

  const ids = goals.attachableGoals().map((node) => node.id);
  assert.deepStrictEqual(ids, [kpi.id, daily.id]);
  assert.strictEqual(ids.includes(okr.id), false, 'OKR 太高，不挂番茄');
  assert.strictEqual(ids.includes(finished.id), false);
});

test('番茄流水记得住这个番茄在推进哪个目标', () => {
  const day = core.upsertSession(
    core.createDayLedger('2026-08-10', { targetMinutes: 560, windowHours: 14, generator: GENERATOR }),
    {
      id: 'work-1-1000',
      kind: 'work',
      startedAt: '2026-08-10T09:00:00+09:00',
      endedAt: '2026-08-10T09:25:00+09:00',
      plannedSeconds: 1500,
      actualSeconds: 1500,
      completed: true,
      task: '写 R3',
      mode: 'accelerated-practice',
      pomodoroIndex: 1,
      phase: '金一',
      segment: '三小时工作日',
      points: null,
      pointsRule: null,
      goalId: 'g-7',
    },
  );

  const text = core.serializeDayLedger(day);
  assert.strictEqual(JSON.parse(text).sessions[0].goalId, 'g-7');
  assert.strictEqual(core.parseDayLedger(text).sessions[0].goalId, 'g-7');
  assert.strictEqual(core.serializeDayLedger(core.parseDayLedger(text)), text);
});

test('旧日档没有 goalId 那一位，读回来补成 null 而不是缺 key', () => {
  const old = JSON.parse(
    core.serializeDayLedger(
      core.upsertSession(
        core.createDayLedger('2026-08-10', { targetMinutes: 560, windowHours: 14, generator: GENERATOR }),
        {
          id: 'work-1-1000',
          kind: 'work',
          startedAt: '2026-08-10T09:00:00+09:00',
          endedAt: '2026-08-10T09:25:00+09:00',
          plannedSeconds: 1500,
          actualSeconds: 1500,
          completed: true,
          task: '写 R3',
          mode: 'accelerated-practice',
          pomodoroIndex: 1,
          phase: null,
          segment: null,
          points: null,
          pointsRule: null,
        },
      ),
    ),
  );
  delete old.sessions[0].goalId;

  const reparsed = JSON.parse(core.serializeDayLedger(core.parseDayLedger(JSON.stringify(old))));
  assert.strictEqual(reparsed.sessions[0].goalId, null);
});

// ---------------------------------------------------------------------------
// 和 R2 积分账本打通
// ---------------------------------------------------------------------------

test('挂了目标的番茄，入账那一笔指回目标树节点', async () => {
  const { goals, points, io } = makeStore();
  await goals.load();
  await points.load();
  const kpi = await goals.create(null, { title: 'KPI', level: 'kpi' });
  const daily = await goals.create(kpi.id, { title: '写 R3' });

  const entry = await points.awardPomodoro({
    sessionId: 'work-1-1000',
    endedAt: new Date(2026, 7, 10, 9, 25),
    taskId: 'pomodoro',
    goalId: daily.id,
    fallbackReason: '写 R3',
  });

  assert.strictEqual(entry.taskId, core.goalRef(daily.id));
  assert.strictEqual(core.goalIdOf(entry.taskId), daily.id);
  assert.match(entry.reason, /完成番茄：完成一个番茄/, '计分规则照旧写在事由里');
  assert.match(io.text(`${POINTS_FOLDER}/2026-08.md`), new RegExp(`goal:${daily.id}`));

  const summary = core.goalPoints(points.book, daily.id);
  assert.deepStrictEqual(summary, { earned: 2, spent: 0, net: 2, count: 1 });
});

test('随手记的一笔也能挂目标；撤销之后这个目标就不算它了', async () => {
  const { goals, points } = makeStore();
  await goals.load();
  await points.load();
  const goal = await goals.create(null, { title: 'KPI', level: 'kpi' });

  const entry = await points.record({
    direction: 'earn',
    amount: 5,
    reason: '临时帮忙也算推进',
    goalId: goal.id,
    at: new Date(2026, 7, 10, 14, 0),
  });
  assert.strictEqual(core.goalPoints(points.book, goal.id).net, 5);

  const reversed = await points.reverse(entry.id, '记错了', new Date(2026, 7, 10, 14, 5));
  assert.strictEqual(reversed.ok, true);
  assert.deepStrictEqual(core.goalPoints(points.book, goal.id), {
    earned: 0, spent: 0, net: 0, count: 0,
  });
});

test('关掉「按目标记账」之后还是按预设任务记', async () => {
  const { goals, points } = makeStore({}, { attributePointsToGoal: false });
  await goals.load();
  await points.load();
  const goal = await goals.create(null, { title: 'KPI', level: 'kpi' });

  const entry = await points.awardPomodoro({
    sessionId: 'work-1-1000',
    endedAt: new Date(2026, 7, 10, 9, 25),
    taskId: 'pomodoro',
    goalId: goal.id,
    fallbackReason: '写 R3',
  });
  assert.strictEqual(entry.taskId, 'pomodoro');
  assert.strictEqual(core.goalPoints(points.book, goal.id).count, 0);
});

test('goal: 前缀和预设任务 id 互不干扰', () => {
  assert.strictEqual(core.goalRef('g-7'), 'goal:g-7');
  assert.strictEqual(core.goalIdOf('goal:g-7'), 'g-7');
  assert.strictEqual(core.goalIdOf('pomodoro'), null);
  assert.strictEqual(core.goalIdOf(null), null);
  assert.strictEqual(core.goalIdOf('goal:'), null);
});
