'use strict';

// 落盘链路的测试。PointsStore 的文件访问全部走注入的 VaultIo，
// 所以这里用一个内存 vault 就能把「写盘幂等 / 日档镜像 / 撤销留痕」跑成真的。

const test = require('node:test');
const assert = require('node:assert');
const core = require('./.build/core.js');

const GENERATOR = 'life-cockpit@0.2.0';
const POINTS_FOLDER = 'Root/每日Journal/积分账本';
const LEDGER_FOLDER = 'Root/每日Journal/番茄流水';

function at(year, month, day, hour = 9, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

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
    pointsFolder: POINTS_FOLDER,
    pointsTaskNote: `${POINTS_FOLDER}/积分任务表.md`,
    ledgerFolder: LEDGER_FOLDER,
    ...overrides,
  };
  const store = new core.PointsStore({
    io,
    generator: GENERATOR,
    settings: () => settings,
    dayLedgerPath: (day) => `${LEDGER_FOLDER}/${day}.json`,
  });
  return { store, io, settings };
}

function monthPath(month) {
  return `${POINTS_FOLDER}/${month}.md`;
}

function dayPath(day) {
  return `${LEDGER_FOLDER}/${day}.json`;
}

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

function dayFileWith(day, sessions) {
  let ledger = core.createDayLedger(day, {
    targetMinutes: 560,
    windowHours: 14,
    generator: 'life-cockpit@0.1.0',
  });
  for (const record of sessions) ledger = core.upsertSession(ledger, record);
  return core.serializeDayLedger(ledger);
}

// ---------------------------------------------------------------------------
// 载入
// ---------------------------------------------------------------------------

test('任务表笔记不存在时用默认表兜底，并标出「还没建」', async () => {
  const { store } = makeStore();
  await store.load();
  assert.strictEqual(store.hasTaskNote, false);
  assert.ok(store.earnTasks().length > 0);
  assert.ok(store.spendTasks().length > 0);
});

test('建任务表笔记：第一次写盘，第二次内容没变就不写', async () => {
  const { store, io } = makeStore();
  await store.load();

  assert.strictEqual(await store.writeTaskNote(), true);
  assert.strictEqual(store.hasTaskNote, true);
  assert.strictEqual(await store.writeTaskNote(), false, '内容没变不该再写一次');
  assert.match(io.text(`${POINTS_FOLDER}/积分任务表.md`), /# 积分任务表/);
});

test('任务表改过分值，载入之后按人写的算', async () => {
  const tasks = core.defaultTasks().map((task) =>
    task.id === 'pomodoro' ? { ...task, points: 5 } : task,
  );
  const { store } = makeStore({ [`${POINTS_FOLDER}/积分任务表.md`]: core.serializeTaskTable(tasks) });
  await store.load();
  assert.strictEqual(core.findTask(store.tasks, 'pomodoro').points, 5);
});

test('账本目录里的月账文件全部读进内存，跨月余额连得上', async () => {
  const july = core.serializeMonth(
    '2026-07',
    [
      core.canonicalEntry({
        id: '20260731-0900-aaaaaa',
        at: '2026-07-31T09:00',
        day: '2026-07-31',
        direction: 'earn',
        amount: 30,
        reason: '七月结余',
        source: 'manual',
        taskId: null,
        ref: null,
      }),
    ],
    { opening: 0, generator: GENERATOR },
  );
  const { store } = makeStore({ [monthPath('2026-07')]: july });
  await store.load();

  assert.strictEqual(core.currentBalance(store.book), 30);
  await store.record({ direction: 'spend', amount: 12, reason: '八月享乐', at: at(2026, 8, 9, 21, 0) });
  assert.strictEqual(core.currentBalance(store.book), 18);
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

function seededVault() {
  const tasks = core.defaultTasks().map((task) =>
    task.id === 'pomodoro' ? { ...task, points: 5 } : task,
  );
  const july = core.serializeMonth(
    '2026-07',
    [
      core.canonicalEntry({
        id: '20260731-0900-aaaaaa',
        at: '2026-07-31T09:00',
        day: '2026-07-31',
        direction: 'earn',
        amount: 30,
        reason: '七月结余',
        source: 'manual',
        taskId: null,
        ref: null,
      }),
    ],
    { opening: 0, generator: GENERATOR },
  );
  return {
    [`${POINTS_FOLDER}/积分任务表.md`]: core.serializeTaskTable(tasks),
    [monthPath('2026-07')]: july,
  };
}

test('索引没建好时读空了，就不许拿默认表盖掉盘上的积分任务表', async () => {
  const seed = seededVault();
  const { store, io } = makeStore(seed);

  const seeAgain = blindfold(io);
  await store.load();
  assert.strictEqual(store.hasTaskNote, false, '误判成「任务表还没建」：正是用户看到的那句提示');
  seeAgain();

  await assert.rejects(() => store.writeTaskNote(), core.StaleMissingError);
  assert.strictEqual(
    io.text(`${POINTS_FOLDER}/积分任务表.md`),
    seed[`${POINTS_FOLDER}/积分任务表.md`],
    '人改过的分值必须原封不动',
  );
});

test('索引没建好时列了个空目录，记账不许把旧月账顶掉', async () => {
  const seed = seededVault();
  const { store, io } = makeStore(seed);

  const seeAgain = blindfold(io);
  await store.load();
  assert.strictEqual(core.currentBalance(store.book), 0, '读空了：余额会显示成 0');
  seeAgain();

  await assert.rejects(
    () => store.record({ direction: 'earn', amount: 3, reason: '七月补记', at: at(2026, 7, 31, 22, 0) }),
    core.StaleMissingError,
  );
  assert.strictEqual(io.text(monthPath('2026-07')), seed[monthPath('2026-07')], '七月账必须原封不动');
});

test('索引正常时，新月份照样开得出新账', async () => {
  const seed = seededVault();
  const { store, io } = makeStore(seed);
  await store.load();

  await store.record({ direction: 'spend', amount: 12, reason: '八月享乐', at: at(2026, 8, 9, 21, 0) });
  assert.ok(io.text(monthPath('2026-08')), '八月盘上本来就没有，守卫不该拦它');
  assert.strictEqual(core.currentBalance(store.book), 18);
});

// ---------------------------------------------------------------------------
// 记账与落盘
// ---------------------------------------------------------------------------

test('记一笔就落进当月账本，再记一样的内容不会覆盖掉前一笔', async () => {
  const { store, io } = makeStore();
  await store.load();

  await store.record({ direction: 'earn', amount: 8, reason: '写 300 字', taskId: 'writing', at: at(2026, 8, 9, 10, 0) });
  const text = io.text(monthPath('2026-08'));
  assert.match(text, /写 300 字/);
  assert.match(text, /\| writing \|/);

  await store.record({ direction: 'earn', amount: 8, reason: '写 300 字', taskId: 'writing', at: at(2026, 8, 9, 10, 0) });
  assert.strictEqual(store.book.entries.length, 2, '同一分钟真记两笔就是两笔');
  assert.strictEqual(new Set(store.book.entries.map((entry) => entry.id)).size, 2);
});

test('重新载入之后账还是那本账', async () => {
  const { store, io, settings } = makeStore();
  await store.load();
  await store.record({ direction: 'earn', amount: 10, reason: 'a', at: at(2026, 8, 9, 9, 0) });
  await store.record({ direction: 'spend', amount: 4, reason: 'b', taskId: 'snack', at: at(2026, 8, 9, 21, 0) });
  const before = store.book.entries;

  const reopened = new core.PointsStore({
    io,
    generator: GENERATOR,
    settings: () => settings,
    dayLedgerPath: (day) => dayPath(day),
  });
  await reopened.load();
  assert.deepStrictEqual(reopened.book.entries, before);
  assert.strictEqual(core.currentBalance(reopened.book), 6);
});

test('落盘幂等：把同一本账再写一遍，一个字节都不动', async () => {
  const { store, io } = makeStore();
  await store.load();
  await store.record({ direction: 'earn', amount: 10, reason: 'a', at: at(2026, 8, 9, 9, 0) });
  await store.record({ direction: 'spend', amount: 4, reason: 'b', at: at(2026, 8, 9, 21, 0) });

  io.writes.length = 0;
  await store.rewriteAll();
  assert.deepStrictEqual(io.writes, [], '内容没变不该产生任何写入');
});

test('补记一笔早于既有流水的账，后面月份的余额跟着重算', async () => {
  const { store, io } = makeStore();
  await store.load();
  await store.record({ direction: 'earn', amount: 10, reason: '九月', at: at(2026, 9, 1, 9, 0) });
  assert.match(io.text(monthPath('2026-09')), /\nopeningBalance: 0\n/);

  await store.record({ direction: 'earn', amount: 25, reason: '八月补记', at: at(2026, 8, 20, 9, 0) });
  assert.match(io.text(monthPath('2026-09')), /\nopeningBalance: 25\n/);
  assert.match(io.text(monthPath('2026-09')), /\nclosingBalance: 35\n/);
});

test('手工把某行挪到别的月账文件里，下次写盘会各归各位', async () => {
  const { store, io } = makeStore();
  await store.load();
  await store.record({ direction: 'earn', amount: 9, reason: '七月那一笔', at: at(2026, 7, 20, 9, 0) });

  // 人手工把七月那一行剪进了八月的文件（八月文件此时还不存在，顺手造一份）
  const july = io.text(monthPath('2026-07'));
  const stray = july.split('\n').find((line) => line.includes('七月那一笔'));
  io.files.set(monthPath('2026-08'), july.replace('month: 2026-07', 'month: 2026-08'));
  io.files.set(monthPath('2026-07'), july.replace(`${stray}\n`, ''));

  const reopened = new core.PointsStore({
    io,
    generator: GENERATOR,
    settings: () => ({ ...core.DEFAULT_SETTINGS, pointsFolder: POINTS_FOLDER, ledgerFolder: LEDGER_FOLDER }),
    dayLedgerPath: (day) => dayPath(day),
  });
  await reopened.load();
  assert.strictEqual(reopened.book.entries.length, 1, '两份文件里是同一笔，按 id 去重');

  await reopened.rewriteAll();
  assert.match(io.text(monthPath('2026-07')), /七月那一笔/, '按账本日应该回到七月');
  assert.doesNotMatch(io.text(monthPath('2026-08')), /七月那一笔/, '八月那份要被清干净');
  assert.match(io.text(monthPath('2026-08')), /本月还没有流水/);
});

test('全量重写不会给没发生过的月份凭空造账本', async () => {
  const { store, io } = makeStore();
  await store.load();
  await store.record({ direction: 'earn', amount: 5, reason: 'a', at: at(2026, 8, 9, 9, 0) });
  const months = [...io.files.keys()].filter((path) => /\d{4}-\d{2}\.md$/.test(path));
  assert.deepStrictEqual(months, [monthPath('2026-08')]);
});

// ---------------------------------------------------------------------------
// 和 R1 打通
// ---------------------------------------------------------------------------

test('番茄跑完自动入账，同一段重复触发只入一次', async () => {
  const { store } = makeStore();
  await store.load();

  const first = await store.awardPomodoro({
    sessionId: 'work-1-1000',
    endedAt: at(2026, 8, 9, 9, 25),
    fallbackReason: '写 PRD',
  });
  assert.ok(first);
  assert.strictEqual(first.source, 'pomodoro');
  assert.strictEqual(first.taskId, 'pomodoro');
  assert.strictEqual(first.ref, 'work-1-1000');
  assert.match(first.reason, /完成番茄/);

  const again = await store.awardPomodoro({
    sessionId: 'work-1-1000',
    endedAt: at(2026, 8, 9, 9, 25),
    fallbackReason: '写 PRD',
  });
  assert.strictEqual(again, null, '同一个番茄段不能入账两次');
  assert.strictEqual(store.book.entries.length, 1);
});

test('番茄选了具体任务就按那一项计分', async () => {
  const { store } = makeStore();
  await store.load();
  const entry = await store.awardPomodoro({
    sessionId: 'work-2-2000',
    endedAt: at(2026, 8, 9, 10, 0),
    taskId: 'deep-work',
    fallbackReason: '',
  });
  assert.strictEqual(entry.taskId, 'deep-work');
  assert.strictEqual(entry.amount, core.findTask(store.tasks, 'deep-work').points);
});

test('番茄选到享乐项会退回默认任务，绝不倒扣', async () => {
  const { store } = makeStore();
  await store.load();
  const entry = await store.awardPomodoro({
    sessionId: 'work-3-3000',
    endedAt: at(2026, 8, 9, 11, 0),
    taskId: 'game',
    fallbackReason: '',
  });
  assert.strictEqual(entry.direction, 'earn');
  assert.strictEqual(entry.taskId, 'pomodoro');
});

test('关掉自动入账就不入账', async () => {
  const { store } = makeStore({}, { pomodoroAutoAward: false });
  await store.load();
  const entry = await store.awardPomodoro({
    sessionId: 'work-1-1000',
    endedAt: at(2026, 8, 9, 9, 25),
    fallbackReason: '',
  });
  assert.strictEqual(entry, null);
  assert.strictEqual(store.book.entries.length, 0);
});

// ---------------------------------------------------------------------------
// 日档镜像（给 R5 复盘一次读全）
// ---------------------------------------------------------------------------

test('日档 JSON 的积分位被填上：当日汇总 + 当日流水 + 每段到手的分', async () => {
  const { store, io } = makeStore({ [dayPath('2026-08-09')]: dayFileWith('2026-08-09', [session()]) });
  await store.load();

  await store.awardPomodoro({
    sessionId: 'work-1-1000',
    endedAt: at(2026, 8, 9, 9, 25),
    fallbackReason: '写 PRD',
  });
  await store.record({ direction: 'spend', amount: 12, reason: '刷视频', taskId: 'video', at: at(2026, 8, 9, 21, 0) });

  const day = JSON.parse(io.text(dayPath('2026-08-09')));
  assert.strictEqual(day.points.earned, 2);
  assert.strictEqual(day.points.spent, 12);
  assert.strictEqual(day.points.balance, -10);
  assert.strictEqual(day.points.entries.length, 2);
  assert.strictEqual(day.sessions[0].points, 2, '番茄段要指回它挣到的分');
  assert.strictEqual(day.sessions[0].pointsRule, 'pomodoro');
  assert.strictEqual(day.totals.completedPomodoros, 1, 'R1 的汇总不能被动过');
});

test('那天没跑番茄、只花了分，也会留下日档给 R5 看', async () => {
  const { store, io } = makeStore();
  await store.load();
  await store.record({ direction: 'spend', amount: 15, reason: '打游戏', taskId: 'game', at: at(2026, 8, 9, 21, 0) });

  const day = JSON.parse(io.text(dayPath('2026-08-09')));
  assert.strictEqual(day.date, '2026-08-09');
  assert.deepStrictEqual(day.sessions, []);
  assert.strictEqual(day.points.spent, 15);
});

test('撤销之后日档镜像跟着回退，番茄段的分归零', async () => {
  const { store, io } = makeStore({ [dayPath('2026-08-09')]: dayFileWith('2026-08-09', [session()]) });
  await store.load();
  const entry = await store.awardPomodoro({
    sessionId: 'work-1-1000',
    endedAt: at(2026, 8, 9, 9, 25),
    fallbackReason: '',
  });

  const result = await store.reverse(entry.id, '其实没跑满', at(2026, 8, 9, 9, 40));
  assert.strictEqual(result.ok, true);

  const day = JSON.parse(io.text(dayPath('2026-08-09')));
  assert.strictEqual(day.points.earned, 0);
  assert.strictEqual(day.points.spent, 0);
  assert.strictEqual(day.points.balance, 0);
  assert.strictEqual(day.points.entries.length, 2, '原笔和撤销单都留在日档里');
  assert.strictEqual(day.sessions[0].points, 0, '撤销之后这一段不再算分');

  const month = io.text(monthPath('2026-08'));
  assert.match(month, /撤销：完成番茄/);
  assert.match(month, /其实没跑满/);
});

test('撤销一笔早几天的账，那天的日档也会被刷新', async () => {
  const { store, io } = makeStore();
  await store.load();
  await store.record({ direction: 'earn', amount: 20, reason: '记错了', at: at(2026, 8, 5, 9, 0) });
  const wrong = store.book.entries[0];

  await store.reverse(wrong.id, undefined, at(2026, 8, 9, 9, 0));

  assert.strictEqual(JSON.parse(io.text(dayPath('2026-08-05'))).points.earned, 0);
  assert.strictEqual(JSON.parse(io.text(dayPath('2026-08-09'))).points.entries.length, 1);
});

test('日档读不动就跳过，不拿镜像去盖人的文件', async () => {
  const broken = '{ 这不是 JSON';
  const { store, io } = makeStore({ [dayPath('2026-08-09')]: broken });
  await store.load();
  await store.record({ direction: 'earn', amount: 3, reason: 'a', at: at(2026, 8, 9, 9, 0) });

  assert.strictEqual(io.text(dayPath('2026-08-09')), broken, '坏文件要原样留着');
  assert.match(io.text(monthPath('2026-08')), /\| a \|/, '账本本身照常写');
});

test('关掉镜像就不碰日档', async () => {
  const original = dayFileWith('2026-08-09', [session()]);
  const { store, io } = makeStore(
    { [dayPath('2026-08-09')]: original },
    { mirrorPointsIntoDayLedger: false },
  );
  await store.load();
  await store.record({ direction: 'earn', amount: 3, reason: 'a', at: at(2026, 8, 9, 9, 0) });
  assert.strictEqual(io.text(dayPath('2026-08-09')), original);
});

test('日档镜像也是幂等的：重算一遍不写盘', async () => {
  const { store, io } = makeStore({ [dayPath('2026-08-09')]: dayFileWith('2026-08-09', [session()]) });
  await store.load();
  await store.awardPomodoro({ sessionId: 'work-1-1000', endedAt: at(2026, 8, 9, 9, 25), fallbackReason: '' });

  io.writes.length = 0;
  await store.rewriteAll();
  assert.deepStrictEqual(io.writes, []);
});

test('applyMirror 是幂等的：插件侧和 store 侧算出同一份字节', async () => {
  const { store } = makeStore();
  await store.load();
  await store.record({ direction: 'earn', amount: 5, reason: 'a', at: at(2026, 8, 9, 9, 0) });

  const day = core.upsertSession(
    core.createDayLedger('2026-08-09', { targetMinutes: 560, windowHours: 14, generator: GENERATOR }),
    session(),
  );
  const once = core.serializeDayLedger(store.applyMirror(day));
  const twice = core.serializeDayLedger(store.applyMirror(store.applyMirror(day)));
  assert.strictEqual(twice, once);
  assert.strictEqual(core.serializeDayLedger(store.applyMirror(core.parseDayLedger(once))), once);
});
