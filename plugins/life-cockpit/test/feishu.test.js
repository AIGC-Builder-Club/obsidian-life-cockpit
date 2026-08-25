'use strict';

// 飞书金字塔表格的快照层。**插件不连飞书 API**，只读一份导出好的 JSON，
// 所以这里断言的全是「读得动、日期对得上、汇总不撒谎」。

const test = require('node:test');
const assert = require('node:assert');
const core = require('./.build/core.js');

/** 照导出管线（GA 的 feishu_daily_tasks_report）真实产物的字段名来。 */
function task(patch = {}) {
  return {
    sheet: '2026年07月02日 周四',
    row: 2,
    column: 'I',
    coordinate: 'I2',
    difficulty: '中难',
    side: '个人兴趣',
    status: '完全没去做',
    text: '看完一整本书吧？',
    ...patch,
  };
}

test('直接吃导出管线的 all_tasks.json，一个字节都不用改', () => {
  const snapshot = core.parseFeishuSnapshot(
    JSON.stringify({
      source_xlsx: '/somewhere/daily_tasks_latest.xlsx',
      generated_at: '2026-07-27T14:34:24+08:00',
      rules: { marker_col: 'F' },
      all_tasks: [task(), task({ status: '已完成', text: 'XMind 思维导图' })],
      ignored_cells: [],
    }),
  );
  assert.ok(snapshot);
  assert.strictEqual(snapshot.generatedAt, '2026-07-27T14:34:24+08:00');
  assert.strictEqual(snapshot.tasks.length, 2);
  assert.strictEqual(snapshot.tasks[0].day, '2026-07-02');
});

test('{tasks:[...]} 和裸数组也认——约定复杂了就没人遵守', () => {
  assert.strictEqual(core.parseFeishuSnapshot(JSON.stringify({ tasks: [task()] })).tasks.length, 1);
  assert.strictEqual(core.parseFeishuSnapshot(JSON.stringify([task()])).tasks.length, 1);
});

test('读不动返回 null，不抛', () => {
  assert.strictEqual(core.parseFeishuSnapshot('不是 JSON'), null);
  assert.strictEqual(core.parseFeishuSnapshot(JSON.stringify({ 别的: 1 })), null);
});

test('空正文的格子不是任务', () => {
  const snapshot = core.parseFeishuSnapshot(JSON.stringify([task({ text: '   ' }), task()]));
  assert.strictEqual(snapshot.tasks.length, 1);
});

test('认不出来的状态一律落到「未知状态」，不假装已完成', () => {
  const snapshot = core.parseFeishuSnapshot(JSON.stringify([task({ status: '紫色？' })]));
  assert.strictEqual(snapshot.tasks[0].status, '未知状态');
});

// --- sheet 名 → 日期 ---------------------------------------------------------

test('sheet 名的各种尾巴都解得出日期', () => {
  assert.strictEqual(core.sheetDay('2026年07月02日 周四'), '2026-07-02');
  assert.strictEqual(core.sheetDay('2026年05月07日 周四 3^'), '2026-05-07');
  assert.strictEqual(core.sheetDay('2026年5月7日'), '2026-05-07');
  assert.strictEqual(core.sheetDay('2026-05-07 随便写点'), '2026-05-07');
});

test('模板页没有日期，那不是错误', () => {
  assert.strictEqual(core.sheetDay('模板(直接创建副本)'), '');
  const snapshot = core.parseFeishuSnapshot(
    JSON.stringify([task({ sheet: '模板(直接创建副本)' }), task()]),
  );
  // 没有日期的永远不算进任何一天。
  assert.strictEqual(core.feishuTasksFor(snapshot, '2026-07-02').length, 1);
});

test('最近有记录的那一天：可以卡上界，也可以不卡', () => {
  const snapshot = core.parseFeishuSnapshot(
    JSON.stringify([
      task({ sheet: '2026年07月02日 周四' }),
      task({ sheet: '2026年08月17日 周日' }),
      task({ sheet: '模板(直接创建副本)' }),
    ]),
  );
  assert.strictEqual(core.latestFeishuDay(snapshot), '2026-08-17');
  assert.strictEqual(core.latestFeishuDay(snapshot, '2026-07-31'), '2026-07-02');
});

// --- 汇总 --------------------------------------------------------------------

test('四种状态各数各的，难度按高中低排而不是按条数', () => {
  const tasks = [
    task({ status: '已完成', difficulty: '低难', side: '工作内容' }),
    task({ status: '已完成', difficulty: '低难', side: '工作内容' }),
    task({ status: '完成了一部分', difficulty: '高难', side: '工作内容' }),
    task({ status: '完全没去做', difficulty: '中难', side: '个人兴趣' }),
    task({ status: '未知状态', difficulty: '', side: '' }),
  ];
  const summary = core.summarizeFeishu(tasks);
  assert.strictEqual(summary.total, 5);
  assert.strictEqual(summary.done, 2);
  assert.strictEqual(summary.partial, 1);
  assert.strictEqual(summary.notStarted, 1);
  assert.strictEqual(summary.unknown, 1);
  assert.deepStrictEqual(
    summary.byDifficulty.map((slice) => slice.label),
    ['高难', '中难', '低难', '没标难度'],
  );
  assert.strictEqual(summary.byDifficulty.find((s) => s.label === '低难').done, 2);
});

test('一条都没有时那句话也说得通', () => {
  assert.match(core.feishuHeadline('2026-08-18', core.summarizeFeishu([])), /没有条目/);
});

// --- 渲染：没做完的排前面 ------------------------------------------------------

test('强提醒页上先看到还欠什么，不是先看到今天真棒', () => {
  const markdown = core.describeFeishuTasks('2026-07-02', [
    task({ status: '已完成', text: '做完的那件' }),
    task({ status: '完全没去做', text: '还没动的那件' }),
  ]);
  assert.ok(
    markdown.indexOf('还没动的那件') < markdown.indexOf('做完的那件'),
    '没做完的应该排在前面',
  );
  assert.match(markdown, /\[x\] 做完的那件/);
});

test('超出上限的折成一句，不把整张表铺到遮罩上', () => {
  const many = Array.from({ length: 30 }, (_, i) => task({ text: `第 ${i} 条` }));
  const markdown = core.describeFeishuTasks('2026-07-02', many, { limit: 5 });
  assert.match(markdown, /还有 25 条/);
});

// --- 进复盘素材包 -------------------------------------------------------------

test('素材切片带原句——「我在做什么事情」只有原句答得了', () => {
  const slice = core.feishuReviewSlice('2026-07-02', [
    task({ status: '已完成', text: '做完的那件' }),
    task({ status: '完成了一部分', text: '做了一半的那件' }),
  ]);
  assert.strictEqual(slice.done, 1);
  assert.deepStrictEqual(slice.finished, ['做完的那件']);
  assert.deepStrictEqual(slice.pending, ['做了一半的那件（完成了一部分）']);
});

test('没有飞书快照的那一天，素材包里连这个键都不写', () => {
  const material = core.collectReview({
    day: '2026-08-18',
    generator: 'test',
    ledger: null,
    book: { entries: [] },
    roots: [],
    progress: new Map(),
  });
  assert.strictEqual(material.feishu, null);
  const json = JSON.parse(core.serializeReviewMaterial(material));
  // 多写一个恒定的 null 会让所有旧素材包在升级当天集体重写一遍。
  assert.ok(!('feishu' in json), 'feishu 这个键不该出现在没有快照的素材包里');
});

test('有快照时素材包里带上它，日期是快照自己那一天', () => {
  const slice = core.feishuReviewSlice('2026-08-16', [task({ status: '已完成', text: '甲' })]);
  const material = core.collectReview({
    day: '2026-08-18',
    generator: 'test',
    ledger: null,
    book: { entries: [] },
    roots: [],
    progress: new Map(),
    feishu: slice,
  });
  const json = JSON.parse(core.serializeReviewMaterial(material));
  assert.strictEqual(json.feishu.day, '2026-08-16');
  assert.deepStrictEqual(json.feishu.finished, ['甲']);
  // 复盘正文要把「这不是今天」说出来，否则数字会被读成今天的。
  assert.match(core.describeReviewMaterial(material), /表上最近有记录的一天/);
});

// ---------------------------------------------------------------------------
// 和目标树的结合（AME-258 第 22.2 条第 1 点）
// ---------------------------------------------------------------------------

test('目标项上的关键词决定表上哪条算在它名下', () => {
  const tasks = [
    task({ text: '量化：把赛马跑一轮', status: '已完成' }),
    task({ text: '量化：因子清洗' }),
    task({ text: '陪家人吃饭', status: '已完成' }),
  ];
  const rollup = core.rollupFeishuByGoal(
    [{ id: 'g-7', title: '量化研究', keywords: ['量化'] }],
    tasks,
  );
  assert.strictEqual(rollup.slices.length, 1);
  assert.strictEqual(rollup.slices[0].total, 2);
  assert.strictEqual(rollup.slices[0].done, 1);
  assert.strictEqual(rollup.unmatched.length, 1);
  assert.strictEqual(rollup.unmatched[0].text, '陪家人吃饭');
});

test('一条同时推进两支目标就两边都算——不强行判给其中一支', () => {
  const tasks = [task({ text: '量化研究的知识库整理' })];
  const rollup = core.rollupFeishuByGoal(
    [
      { id: 'g-1', title: '量化', keywords: ['量化'] },
      { id: 'g-2', title: '知识库', keywords: ['知识库'] },
    ],
    tasks,
  );
  assert.strictEqual(rollup.slices[0].total, 1);
  assert.strictEqual(rollup.slices[1].total, 1);
  // 但「挂上了目标的条目数」只算一条，不重复计数。
  assert.strictEqual(rollup.matched, 1);
  assert.strictEqual(rollup.unmatched.length, 0);
});

test('大小写不敏感：AI 和 ai 是同一个词', () => {
  assert.ok(core.feishuTaskMatches(task({ text: '写 AI 史书' }), ['ai']));
  assert.ok(core.feishuTaskMatches(task({ text: '写 ai 史书' }), ['AI']));
});

test('一个关键词都没填的目标不参与分组', () => {
  const rollup = core.rollupFeishuByGoal([{ id: 'g-1', title: '空的', keywords: [] }], [task()]);
  assert.strictEqual(rollup.slices.length, 0);
  assert.strictEqual(rollup.unmatched.length, 1);
});

test('挂不上目标的那几条一定被列出来——这一栏问的就是「今天做的事在不在目标上」', () => {
  const rollup = core.rollupFeishuByGoal(
    [{ id: 'g-1', title: '量化', keywords: ['量化'] }],
    [task({ text: '刷了一下午视频' })],
  );
  const text = core.describeFeishuByGoal('2026-08-18', rollup);
  assert.ok(text.includes('没挂到目标上'));
  assert.ok(text.includes('刷了一下午视频'));
});

// ---------------------------------------------------------------------------
// 拉快照那条链（AME-258 第 22.2 条第 2 点）
// ---------------------------------------------------------------------------

test('完成信号是「快照变新了」，不是 webhook 回话', () => {
  const started = core.startFeishuPull('2026-08-17|旧|12', 1000);
  assert.strictEqual(started.phase, 'waiting');

  const still = core.tickFeishuPull(started, {
    now: 20_000,
    currentKey: '2026-08-17|旧|12',
    waitMs: 180_000,
  });
  assert.strictEqual(still.phase, 'waiting');

  const arrived = core.tickFeishuPull(started, {
    now: 40_000,
    currentKey: '2026-08-18|新|14',
    waitMs: 180_000,
  });
  assert.strictEqual(arrived.phase, 'arrived');
  assert.ok(arrived.detail.includes('39 秒'));
});

test('等不到只是「还没等到」，不是失败——对面可能还在跑', () => {
  const started = core.startFeishuPull('base', 0);
  const out = core.tickFeishuPull(started, { now: 200_000, currentKey: 'base', waitMs: 180_000 });
  assert.strictEqual(out.phase, 'timeout');
  assert.ok(!out.detail.includes('失败'));
});

test('盘上一份快照都没有的时候不会被误判成「来了新的」', () => {
  const started = core.startFeishuPull('', 0);
  const out = core.tickFeishuPull(started, { now: 10_000, currentKey: '', waitMs: 180_000 });
  assert.strictEqual(out.phase, 'waiting');
});

test('快照身份不看文件时间——Easy Git 拉一次 mtime 就变，那个信号是废的', () => {
  const key = core.feishuSnapshotKey({ day: '2026-08-18', generatedAt: 'T1', taskCount: 12 });
  assert.strictEqual(key, core.feishuSnapshotKey({ day: '2026-08-18', generatedAt: 'T1', taskCount: 12 }));
  assert.notStrictEqual(key, core.feishuSnapshotKey({ day: '2026-08-18', generatedAt: 'T2', taskCount: 12 }));
  assert.strictEqual(core.feishuSnapshotKey(null), '');
});

test('喊不动的时候是 failed，和「等不到」分得开', () => {
  const failed = core.failFeishuPull('喊不动：HTTP 404。地址对不对？');
  assert.strictEqual(failed.phase, 'failed');
  assert.strictEqual(core.describeFeishuPull(core.createFeishuPullState()), '');
});

test('拉取地址默认是空的——插件不编造地址（和推动器同一套规矩）', () => {
  assert.strictEqual(core.DEFAULT_SETTINGS.feishuPullWebhook, '');
  // 拉仓库这一步默认交给 Easy Git 的命令，凭据不进插件。
  assert.strictEqual(core.DEFAULT_SETTINGS.feishuPullCommandId, 'easy-git:sync-all');
});

test('等待时间有下限：比拉一次仓库还短的等待只会次次「没等到」', () => {
  assert.strictEqual(core.normalizeSettings({ feishuPullWaitSeconds: 1 }).feishuPullWaitSeconds, 10);
});

test('拉仓库这一步可以整个不要（留空 = 你自己拉）', () => {
  assert.strictEqual(core.normalizeSettings({ feishuPullCommandId: '' }).feishuPullCommandId, '');
});
