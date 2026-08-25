'use strict';

const test = require('node:test');
const assert = require('node:assert');
const core = require('./.build/core.js');

const GENERATOR = 'life-cockpit@0.2.0';

function at(year, month, day, hour = 9, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

function book(...drafts) {
  let current = core.createBook();
  for (const draft of drafts) {
    current = core.addEntry(current, core.createEntry(current, { rolloverHour: 4, ...draft }));
  }
  return current;
}

function earn(date, amount, reason, extra = {}) {
  return { at: date, direction: 'earn', amount, reason, source: 'manual', ...extra };
}

function spend(date, amount, reason, extra = {}) {
  return { at: date, direction: 'spend', amount, reason, source: 'manual', ...extra };
}

// ---------------------------------------------------------------------------
// 计分：预设任务入账、享乐出账、临时任务当场记
// ---------------------------------------------------------------------------

test('默认任务表两个方向都有，且分值都是正数', () => {
  const tasks = core.defaultTasks();
  const earners = tasks.filter((task) => task.direction === 'earn');
  const spenders = tasks.filter((task) => task.direction === 'spend');
  assert.ok(earners.length > 0, '要有完成任务的入账项');
  assert.ok(spenders.length > 0, '要有享乐的出账项');
  for (const task of tasks) assert.ok(task.points > 0, `${task.id} 分值要是正数`);
  assert.ok(core.findTask(tasks, 'pomodoro'), '番茄默认项要在');
});

test('预设任务入账、享乐出账，余额是两者相减', () => {
  const tasks = core.defaultTasks();
  const pomodoro = core.findTask(tasks, 'pomodoro');
  const video = core.findTask(tasks, 'video');

  const current = book(
    earn(at(2026, 8, 9, 9, 25), pomodoro.points, pomodoro.label, { taskId: 'pomodoro' }),
    spend(at(2026, 8, 9, 21, 0), video.points, video.label, { taskId: 'video' }),
  );

  assert.strictEqual(core.currentBalance(current), pomodoro.points - video.points);
  const summary = core.summarize(current);
  assert.strictEqual(summary.earned, pomodoro.points);
  assert.strictEqual(summary.spent, video.points);
});

test('临时任务不用先在任务表里存在，taskId 为空照样记账', () => {
  const current = book(earn(at(2026, 8, 9, 14, 30), 7, '临时：帮同事看一份合同'));
  const entry = current.entries[0];
  assert.strictEqual(entry.taskId, null);
  assert.strictEqual(entry.source, 'manual');
  assert.strictEqual(core.currentBalance(current), 7);
  assert.strictEqual(core.summarize(current).byTask[0].key, '（临时任务）');
});

test('分值取绝对值，方向只由 direction 决定', () => {
  const current = book(spend(at(2026, 8, 9), -12, '手滑填了负数'));
  assert.strictEqual(current.entries[0].amount, 12);
  assert.strictEqual(core.currentBalance(current), -12);
});

test('凌晨记的一笔算前一天', () => {
  const current = book(earn(at(2026, 8, 10, 1, 30), 3, '收工前补一笔'));
  assert.strictEqual(current.entries[0].day, '2026-08-09');
  assert.strictEqual(current.entries[0].at, '2026-08-10T01:30');
});

// ---------------------------------------------------------------------------
// 流水与余额
// ---------------------------------------------------------------------------

test('每笔都带 时间 / 方向 / 分值 / 事由 / 来源', () => {
  const current = book(earn(at(2026, 8, 9, 9, 25), 2, '完成番茄', { source: 'pomodoro', ref: 'work-1-1000' }));
  const entry = current.entries[0];
  for (const key of ['id', 'at', 'day', 'direction', 'amount', 'reason', 'source', 'taskId', 'ref']) {
    assert.ok(key in entry, `缺字段 ${key}`);
  }
  assert.strictEqual(entry.source, 'pomodoro');
  assert.strictEqual(entry.ref, 'work-1-1000');
});

test('余额一列是逐笔累计出来的', () => {
  const current = book(
    earn(at(2026, 8, 9, 9, 0), 10, 'a'),
    spend(at(2026, 8, 9, 10, 0), 4, 'b'),
    earn(at(2026, 8, 9, 11, 0), 1, 'c'),
  );
  assert.deepStrictEqual(core.runningBalances(current.entries), [10, 6, 7]);
  assert.deepStrictEqual(core.runningBalances(current.entries, 100), [110, 106, 107]);
});

test('乱序写入后按时间排好，字节与顺序写入一致', () => {
  const a = earn(at(2026, 8, 9, 9, 0), 10, 'a');
  const b = spend(at(2026, 8, 9, 10, 0), 4, 'b');
  const c = earn(at(2026, 8, 9, 11, 0), 1, 'c');

  const forward = book(a, b, c);
  const shuffled = book(c, a, b);
  const options = { opening: 0, generator: GENERATOR };
  assert.strictEqual(
    core.serializeMonth('2026-08', shuffled.entries, options),
    core.serializeMonth('2026-08', forward.entries, options),
  );
});

// ---------------------------------------------------------------------------
// 区间汇总——R5 复盘要吃的那一份
// ---------------------------------------------------------------------------

test('区间汇总给出期初、入账、出账、净额、期末', () => {
  const current = book(
    earn(at(2026, 8, 1, 9, 0), 20, '八月一号'),
    earn(at(2026, 8, 5, 9, 0), 10, '五号入账'),
    spend(at(2026, 8, 6, 21, 0), 12, '六号享乐'),
    earn(at(2026, 8, 9, 9, 0), 5, '九号入账'),
  );

  const week = core.summarize(current, '2026-08-05', '2026-08-06');
  assert.strictEqual(week.opening, 20, '期初 = 区间之前的余额');
  assert.strictEqual(week.earned, 10);
  assert.strictEqual(week.spent, 12);
  assert.strictEqual(week.net, -2);
  assert.strictEqual(week.closing, 18);
  assert.strictEqual(week.count, 2);
});

test('区间边界是闭区间，按账本日不按自然日', () => {
  const current = book(
    earn(at(2026, 8, 10, 1, 0), 3, '凌晨补记，算 8-09'),
    earn(at(2026, 8, 10, 9, 0), 4, '早上，算 8-10'),
  );
  const ninth = core.summarize(current, '2026-08-09', '2026-08-09');
  assert.strictEqual(ninth.earned, 3);
  assert.strictEqual(ninth.count, 1);
});

test('汇总按任务分组，按净贡献排序', () => {
  const current = book(
    earn(at(2026, 8, 9, 9, 0), 2, '番茄', { taskId: 'pomodoro' }),
    earn(at(2026, 8, 9, 10, 0), 2, '番茄', { taskId: 'pomodoro' }),
    spend(at(2026, 8, 9, 21, 0), 15, '打游戏', { taskId: 'game' }),
  );
  const summary = core.summarize(current);
  assert.deepStrictEqual(
    summary.byTask.map((row) => [row.key, row.earned, row.spent, row.count]),
    [['pomodoro', 4, 0, 2], ['game', 0, 15, 1]],
  );
});

test('汇总按天切片，带每天的净额与收盘余额', () => {
  const current = book(
    earn(at(2026, 8, 8, 9, 0), 10, '八号'),
    earn(at(2026, 8, 9, 9, 0), 6, '九号入'),
    spend(at(2026, 8, 9, 21, 0), 4, '九号出'),
  );
  const summary = core.summarize(current, '2026-08-08', '2026-08-09');
  assert.deepStrictEqual(
    summary.byDay.map((slice) => [slice.day, slice.earned, slice.spent, slice.net, slice.closing]),
    [
      ['2026-08-08', 10, 0, 10, 10],
      ['2026-08-09', 6, 4, 2, 12],
    ],
  );
});

test('空区间也给得出期初与期末，不返回 NaN', () => {
  const current = book(earn(at(2026, 8, 1, 9, 0), 20, '八月一号'));
  const summary = core.summarize(current, '2026-09-01', '2026-09-30');
  assert.strictEqual(summary.opening, 20);
  assert.strictEqual(summary.earned, 0);
  assert.strictEqual(summary.closing, 20);
  assert.deepStrictEqual(summary.byDay, []);
});

test('区间快捷选项按账本日算', () => {
  // 2026-08-12 是周三；凌晨两点看到的还是 8-11 那一摊。
  assert.deepStrictEqual(core.presetRange('today', at(2026, 8, 12, 2, 0), 4), {
    from: '2026-08-11',
    to: '2026-08-11',
  });
  assert.deepStrictEqual(core.presetRange('today', at(2026, 8, 12, 9, 0), 4), {
    from: '2026-08-12',
    to: '2026-08-12',
  });
  assert.deepStrictEqual(core.presetRange('week', at(2026, 8, 12, 9, 0), 4), {
    from: '2026-08-10',
    to: '2026-08-12',
  });
  assert.deepStrictEqual(core.presetRange('month', at(2026, 8, 12, 9, 0), 4), {
    from: '2026-08-01',
    to: '2026-08-12',
  });
  assert.deepStrictEqual(core.presetRange('last30', at(2026, 8, 12, 9, 0), 4), {
    from: '2026-07-14',
    to: '2026-08-12',
  });
  assert.deepStrictEqual(core.presetRange('all', at(2026, 8, 12, 9, 0), 4), {});
});

test('周一起算：周日看到的是上一个周一到今天', () => {
  // 2026-08-16 是周日。
  assert.deepStrictEqual(core.presetRange('week', at(2026, 8, 16, 9, 0), 4), {
    from: '2026-08-10',
    to: '2026-08-16',
  });
});

// ---------------------------------------------------------------------------
// 撤销
// ---------------------------------------------------------------------------

test('撤销写一笔反向流水，原笔照旧留在账上', () => {
  const current = book(earn(at(2026, 8, 9, 9, 0), 10, '记错了'));
  const target = current.entries[0];
  const result = core.reverseEntry(current, target.id, { at: at(2026, 8, 9, 9, 30), rolloverHour: 4 });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.book.entries.length, 2, '原笔不能被删掉');
  assert.ok(result.book.entries.some((entry) => entry.id === target.id));
  assert.strictEqual(result.entry.direction, 'spend');
  assert.strictEqual(result.entry.amount, 10);
  assert.strictEqual(result.entry.source, 'reversal');
  assert.strictEqual(result.entry.ref, target.id);
  assert.match(result.entry.reason, /^撤销：记错了/);
  assert.strictEqual(core.currentBalance(result.book), 0, '撤销之后余额回到原点');
});

test('撤销带的那句话会写进事由', () => {
  const current = book(spend(at(2026, 8, 9, 21, 0), 15, '打游戏'));
  const result = core.reverseEntry(current, current.entries[0].id, {
    at: at(2026, 8, 9, 21, 5),
    rolloverHour: 4,
    note: '其实没打',
  });
  assert.strictEqual(result.entry.reason, '撤销：打游戏（其实没打）');
  assert.strictEqual(result.entry.direction, 'earn');
});

test('同一笔不能撤销两次，撤销单本身也不能再撤销', () => {
  const current = book(earn(at(2026, 8, 9, 9, 0), 10, '一笔'));
  const first = core.reverseEntry(current, current.entries[0].id, {
    at: at(2026, 8, 9, 9, 30),
    rolloverHour: 4,
  });

  const again = core.reverseEntry(first.book, current.entries[0].id, {
    at: at(2026, 8, 9, 10, 0),
    rolloverHour: 4,
  });
  assert.strictEqual(again.ok, false);
  assert.match(again.reason, /已经撤销/);

  const onReversal = core.reverseEntry(first.book, first.entry.id, {
    at: at(2026, 8, 9, 10, 0),
    rolloverHour: 4,
  });
  assert.strictEqual(onReversal.ok, false);
  assert.match(onReversal.reason, /撤销单/);
});

test('撤销不存在的一笔会被拒绝，不是静默成功', () => {
  const result = core.reverseEntry(core.createBook(), 'nope', { at: at(2026, 8, 9), rolloverHour: 4 });
  assert.strictEqual(result.ok, false);
});

test('汇总里撤销掉的原笔与撤销单都不计入入账 / 出账', () => {
  const current = book(
    earn(at(2026, 8, 9, 9, 0), 10, '算数的'),
    earn(at(2026, 8, 9, 10, 0), 30, '记错的'),
  );
  const wrong = current.entries[1];
  const after = core.reverseEntry(current, wrong.id, { at: at(2026, 8, 9, 11, 0), rolloverHour: 4 }).book;

  const summary = core.summarize(after, '2026-08-09', '2026-08-09');
  assert.strictEqual(summary.earned, 10, '撤销掉的 30 不该算进入账');
  assert.strictEqual(summary.spent, 0, '撤销单不是一次享乐，不该算进出账');
  assert.strictEqual(summary.net, 10);
  assert.strictEqual(summary.closing, 10);
  assert.strictEqual(summary.count, 3, '流水条数照旧是三条');
  assert.strictEqual(summary.voidedCount, 2);
  assert.deepStrictEqual(summary.byTask.map((row) => row.earned), [10]);
});

test('余额一列会走过去再走回来，账面留痕', () => {
  const current = book(earn(at(2026, 8, 9, 9, 0), 10, '一笔'));
  const after = core.reverseEntry(current, current.entries[0].id, {
    at: at(2026, 8, 9, 9, 30),
    rolloverHour: 4,
  }).book;
  assert.deepStrictEqual(core.runningBalances(after.entries), [10, 0]);
});

// ---------------------------------------------------------------------------
// 落盘：月账 Markdown
// ---------------------------------------------------------------------------

test('月账序列化两次字节完全一样', () => {
  const current = book(earn(at(2026, 8, 9, 9, 0), 10, 'a'), spend(at(2026, 8, 9, 21, 0), 4, 'b'));
  const options = { opening: 3, generator: GENERATOR };
  assert.strictEqual(
    core.serializeMonth('2026-08', current.entries, options),
    core.serializeMonth('2026-08', current.entries, options),
  );
});

test('序列化 → 解析 → 再序列化，结果不变', () => {
  const current = book(
    earn(at(2026, 8, 9, 9, 0), 10, '写 300 字', { taskId: 'writing' }),
    spend(at(2026, 8, 9, 21, 30), 12.5, '刷视频 | 带竖线的事由', { taskId: 'video' }),
    earn(at(2026, 8, 10, 2, 0), 3, '凌晨补记'),
  );
  const options = { opening: 7, generator: GENERATOR };
  const once = core.serializeMonth('2026-08', current.entries, options);
  const parsed = core.parseMonth(once);
  assert.strictEqual(parsed.entries.length, 3);
  assert.deepStrictEqual(parsed.entries, current.entries);
  assert.strictEqual(core.serializeMonth('2026-08', parsed.entries, options), once);
});

test('事由里的竖线不会把表格切坏', () => {
  const current = book(earn(at(2026, 8, 9, 9, 0), 1, 'a | b | c'));
  const parsed = core.parseMonth(core.serializeMonth('2026-08', current.entries, { opening: 0, generator: GENERATOR }));
  assert.strictEqual(parsed.entries[0].reason, 'a | b | c');
});

test('月账写出的是 Markdown 表格，人能直接读', () => {
  const current = book(earn(at(2026, 8, 9, 9, 25), 2, '完成番茄：写 PRD', { taskId: 'pomodoro' }));
  const text = core.serializeMonth('2026-08', current.entries, { opening: 0, generator: GENERATOR });
  assert.match(text, /^---\nschemaVersion: 1\nmonth: 2026-08\n/);
  assert.match(text, /\| 时间 \| 账本日 \| 方向 \| 分值 \| 余额 \| 事由 \| 任务 \| 来源 \| 关联 \| 状态 \| ID \|/);
  assert.match(text, /\| 2026-08-09 09:25 \| 2026-08-09 \| \+ \| 2 \| 2 \| 完成番茄：写 PRD \| pomodoro \| 番茄|手动 \|/);
  assert.ok(text.endsWith('\n'));
  assert.ok(!text.endsWith('\n\n'));
});

test('月账 frontmatter 的汇总把撤销对冲掉', () => {
  const current = book(earn(at(2026, 8, 9, 9, 0), 10, '算数的'), earn(at(2026, 8, 9, 10, 0), 30, '记错的'));
  const after = core.reverseEntry(current, current.entries[1].id, {
    at: at(2026, 8, 9, 11, 0),
    rolloverHour: 4,
  }).book;
  const text = core.serializeMonth('2026-08', after.entries, { opening: 0, generator: GENERATOR });
  assert.match(text, /\nearned: 10\n/);
  assert.match(text, /\nspent: 0\n/);
  assert.match(text, /\nclosingBalance: 10\n/);
  assert.match(text, /\| 已撤销 \|/);
  assert.match(text, /\| 撤销 \|/);
});

test('读不动的行搬到《待修复》，不静默删除', () => {
  const good = book(earn(at(2026, 8, 9, 9, 0), 10, '好行'));
  const text = core.serializeMonth('2026-08', good.entries, { opening: 0, generator: GENERATOR })
    .replace('## 流水', '## 流水\n\n| 我 | 手 | 改 | 坏 | 了 |\n');

  const parsed = core.parseMonth(text);
  assert.strictEqual(parsed.entries.length, 1, '好行照常读出来');
  assert.strictEqual(parsed.quarantine.length, 1, '坏行进待修复');

  const rewritten = core.serializeMonth('2026-08', parsed.entries, {
    opening: 0,
    generator: GENERATOR,
    quarantine: parsed.quarantine,
  });
  assert.match(rewritten, /## 待修复/);
  assert.match(rewritten, /\| 我 \| 手 \| 改 \| 坏 \| 了 \|/);
  // 再读一遍还在，来回不丢
  assert.deepStrictEqual(core.parseMonth(rewritten).quarantine, parsed.quarantine);
});

test('空月份也写得出合法文件', () => {
  const text = core.serializeMonth('2026-09', [], { opening: 42, generator: GENERATOR });
  assert.match(text, /\nopeningBalance: 42\n/);
  assert.match(text, /\nclosingBalance: 42\n/);
  assert.match(text, /本月还没有流水/);
  assert.deepStrictEqual(core.parseMonth(text).entries, []);
});

// ---------------------------------------------------------------------------
// 任务表
// ---------------------------------------------------------------------------

test('任务表序列化 → 解析 → 再序列化不变', () => {
  const once = core.serializeTaskTable(core.defaultTasks());
  const parsed = core.parseTaskTable(once);
  assert.strictEqual(parsed.tasks.length, core.defaultTasks().length);
  assert.strictEqual(core.serializeTaskTable(parsed.tasks), once);
});

test('任务表认得停用与出账方向', () => {
  const text = core.serializeTaskTable([
    { id: 'x', label: '停掉的项', direction: 'earn', points: 3, category: '诚', active: false },
    { id: 'y', label: '享乐项', direction: 'spend', points: 9, category: '享乐', active: true },
  ]);
  const parsed = core.parseTaskTable(text);
  assert.strictEqual(parsed.tasks.find((task) => task.id === 'x').active, false);
  assert.strictEqual(parsed.tasks.find((task) => task.id === 'y').direction, 'spend');
});

test('任务表里读不动的行进待修复，好行照读', () => {
  const text = `${core.serializeTaskTable(core.defaultTasks())}\n| 缺列 | 的行 |\n`;
  const parsed = core.parseTaskTable(text);
  assert.strictEqual(parsed.tasks.length, core.defaultTasks().length);
  assert.strictEqual(parsed.quarantine.length, 1);
});
