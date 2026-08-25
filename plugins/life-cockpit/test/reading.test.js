'use strict';

// 每日推荐读物：从候选区的夜班总结、休息页、读物池、复盘素材四处挑，按天轮换。
// 候选项用 serialize / parse 走一遍真的，保证挑的是真读得出来的东西。

const test = require('node:test');
const assert = require('node:assert');
const core = require('./.build/core.js');

const DAY = '2026-08-11';

function digest(day, name, summary, coverage) {
  const candidate = core.parseCandidate(
    core.serializeCandidate({
      id: `${day}-${name}`,
      source: 'agent:资讯夜班',
      generatedAt: `${day}T02:00:00`,
      target: '',
      summary,
      status: core.CANDIDATE_PENDING,
      type: 'news-digest',
      level: 2,
      coverage: coverage ?? null,
      trace: [],
      decisions: [],
      extras: {},
      extraOrder: [],
      body: `## ${summary}\n\n正文。`,
    }),
  );
  return { day, path: `Root/候选区/${day}/${name}.md`, candidate };
}

function source(patch = {}) {
  return {
    digests: patch.digests ?? [],
    breakPages: patch.breakPages ?? [],
    pool: patch.pool ?? [],
    material: patch.material ?? null,
    materialPath: patch.materialPath ?? '',
  };
}

const PAGES = [
  { id: 'meditation', label: '冥想', notePath: 'Root/休息页/冥想.md' },
  { id: 'reading', label: '精品阅读', notePath: 'Root/休息页/精品阅读.md' },
  { id: 'health', label: '健康养生', notePath: '' },
];

function material(patch = {}) {
  return {
    schemaVersion: 1,
    day: '2026-08-10',
    generator: 'life-cockpit@0.6.0',
    focus: {
      minutes: 320,
      targetMinutes: 560,
      ratio: 57.14,
      completed: 12,
      started: 14,
      breakMinutes: 60,
      onGoal: 9,
      byTask: [],
    },
    points: {
      opening: 0,
      earned: 0,
      spent: 0,
      net: 0,
      closing: 0,
      count: 0,
      voidedCount: 0,
      byTask: [],
    },
    goals: { overall: 30, touched: [] },
    rejections: [],
    dimensions: [],
    ...patch,
  };
}

// ---------------------------------------------------------------------------
// 挑什么
// ---------------------------------------------------------------------------

test('四类轮着取，不让资讯把别的挤没', () => {
  const picks = core.buildReadingList(
    DAY,
    source({
      digests: [
        digest('2026-08-11', 'a', '今天的总结'),
        digest('2026-08-10', 'b', '昨天的总结'),
        digest('2026-08-09', 'c', '前天的总结'),
      ],
      breakPages: PAGES,
      pool: ['Root/读物/一本书.md'],
    }),
    3,
  );
  assert.deepStrictEqual(
    picks.map((pick) => pick.kind),
    ['资讯', '精品阅读', '读物池'],
  );
});

test('资讯按日期新的排前面，不做轮换', () => {
  const digests = [
    digest('2026-08-09', 'c', '前天'),
    digest('2026-08-11', 'a', '今天'),
    digest('2026-08-10', 'b', '昨天'),
  ];
  const picks = core.buildReadingList(DAY, source({ digests }), 3);
  assert.deepStrictEqual(
    picks.map((pick) => pick.title),
    ['今天', '昨天', '前天'],
  );
  assert.deepStrictEqual(
    core.buildReadingList('2026-08-20', source({ digests }), 3).map((pick) => pick.title),
    ['今天', '昨天', '前天'],
    '换一天，资讯的顺序不变',
  );
});

test('推荐理由带上覆盖了多少条原始条目', () => {
  const picks = core.buildReadingList(DAY, source({ digests: [digest(DAY, 'a', '总结', 17)] }), 1);
  assert.match(picks[0].reason, /夜班的 N 次方总结/);
  assert.match(picks[0].reason, /覆盖 17 条/);

  const noCoverage = core.buildReadingList(DAY, source({ digests: [digest(DAY, 'a', '总结')] }), 1);
  assert.doesNotMatch(noCoverage[0].reason, /覆盖/);
});

test('常青的那几类按天转一格，换一天必然换一篇', () => {
  const pool = ['Root/读物/一.md', 'Root/读物/二.md', 'Root/读物/三.md'];
  const first = core.buildReadingList('2026-08-11', source({ pool }), 1)[0].path;
  const second = core.buildReadingList('2026-08-12', source({ pool }), 1)[0].path;
  const third = core.buildReadingList('2026-08-13', source({ pool }), 1)[0].path;
  const fourth = core.buildReadingList('2026-08-14', source({ pool }), 1)[0].path;

  assert.notStrictEqual(first, second);
  assert.notStrictEqual(second, third);
  assert.strictEqual(fourth, first, '三篇一轮');
  assert.strictEqual(core.buildReadingList('2026-08-11', source({ pool }), 1)[0].path, first);
});

test('休息页没填路径的不推', () => {
  const picks = core.buildReadingList(DAY, source({ breakPages: PAGES }), 5);
  assert.strictEqual(picks.length, 2);
  assert.ok(picks.every((pick) => pick.path !== ''));
});

test('同一篇笔记同时在读物池和休息页里，只推一次', () => {
  const shared = 'Root/休息页/精品阅读.md';
  const picks = core.buildReadingList(
    DAY,
    source({ breakPages: [{ id: 'r', label: '精品阅读', notePath: shared }], pool: [shared] }),
    5,
  );
  assert.strictEqual(picks.length, 1);
  assert.strictEqual(picks[0].kind, '精品阅读', '先轮到哪一类就算哪一类');
});

test('复盘素材有内容才推，空的一天不推', () => {
  const withContent = core.buildReadingList(
    DAY,
    source({ material: material(), materialPath: 'Root/复盘素材/2026-08-10.json' }),
    3,
  );
  assert.strictEqual(withContent.length, 1);
  assert.strictEqual(withContent[0].kind, '复盘回看');
  assert.match(withContent[0].reason, /专注 320 分钟/);

  const empty = core.buildReadingList(
    DAY,
    source({
      material: material({ focus: { ...material().focus, started: 0, minutes: 0 } }),
      materialPath: 'Root/复盘素材/2026-08-10.json',
    }),
    3,
  );
  assert.strictEqual(empty.length, 0, '一个番茄都没跑的一天，推出来是噪音');
});

test('复盘理由把上一轮打回的话数出来', () => {
  const picks = core.buildReadingList(
    DAY,
    source({
      material: material({
        rejections: [{ at: '2026-08-10T22:30:00', reason: '太笼统', from: '睡前复盘-复盘正文.md' }],
      }),
      materialPath: 'Root/复盘素材/2026-08-10.json',
    }),
    3,
  );
  assert.match(picks[0].reason, /还有 1 条打回的话/);
});

test('没有 materialPath 就不推复盘那一条——推荐必须点得开', () => {
  const picks = core.buildReadingList(DAY, source({ material: material(), materialPath: '' }), 3);
  assert.strictEqual(picks.length, 0);
});

test('条数上限说到做到，0 条就是一条不推', () => {
  const digests = Array.from({ length: 9 }, (_, i) => digest(DAY, `d${i}`, `总结 ${i}`));
  assert.strictEqual(core.buildReadingList(DAY, source({ digests }), 4).length, 4);
  assert.strictEqual(core.buildReadingList(DAY, source({ digests }), 0).length, 0);
  assert.strictEqual(core.buildReadingList(DAY, source({ digests }), 99).length, 9, '料不够就少推');
});

test('四处全空时推出来是空表，不编内容', () => {
  assert.deepStrictEqual(core.buildReadingList(DAY, source(), 3), []);
});

// ---------------------------------------------------------------------------
// 怎么写出来
// ---------------------------------------------------------------------------

test('Markdown 版是可点的内链，去掉扩展名', () => {
  const picks = core.buildReadingList(DAY, source({ pool: ['Root/读物/一本书.md'] }), 1);
  const text = core.describeReadingList(DAY, picks);
  assert.match(text, /## 2026-08-11 今日推荐/);
  assert.match(text, /\[\[Root\/读物\/一本书\|一本书\]\]/);
  assert.match(text, /读物池里轮到的一篇/);
});

test('一条都没有时，正文说清楚该去哪儿补', () => {
  const text = core.describeReadingList(DAY, []);
  assert.match(text, /没挑出东西可推/);
  assert.match(text, /设置/);
});

test('推送正文一行一条，不带 Markdown 语法', () => {
  const picks = core.buildReadingList(
    DAY,
    source({ digests: [digest(DAY, 'a', '今天的总结')], pool: ['Root/读物/一本书.md'] }),
    2,
  );
  const text = core.summarizeReadingList(picks);
  assert.strictEqual(text, '资讯：今天的总结\n读物池：一本书');
  assert.doesNotMatch(text, /\[\[/);
  assert.strictEqual(core.summarizeReadingList([]), '今天没挑出可推的读物。');
});

test('normalizeSettings 认得每日推荐这几项', () => {
  const normalized = core.normalizeSettings({ readingPool: ['a.md', 42, 'b.md'], readingCount: 0 });
  assert.deepStrictEqual(normalized.readingPool, ['a.md', 'b.md'], '写坏的一项丢掉，其余留着');
  assert.strictEqual(normalized.readingCount, 0, '0 条是合法配置');
  assert.deepStrictEqual(core.DEFAULT_SETTINGS.readingPool, [], '读物池默认空，不预置任何内容');
});
