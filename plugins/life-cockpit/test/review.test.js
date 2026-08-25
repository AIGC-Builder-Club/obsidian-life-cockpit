'use strict';

// 睡前复盘：取数汇总、兜底草稿、投候选区、以及经由 R4 采纳之后的回写。
// ReviewStore 的文件访问全部走注入的 VaultIo，所以这里用一个内存 vault 就能跑成真的——
// 「取数 → 落素材包 → 投候选区 → 人拍板 → 回写日记 / 目标树 / 错题本」整条链路都是真的走了一遍。

const test = require('node:test');
const assert = require('node:assert');
const core = require('./.build/core.js');

const GENERATOR = 'life-cockpit@0.5.0';
const CANDIDATES = 'Root/候选区';
const GOAL_NOTE = 'Root/每日Journal/目标树.md';
const POINTS_FOLDER = 'Root/每日Journal/积分账本';
const LEDGER_FOLDER = 'Root/每日Journal/番茄流水';
const JOURNAL_FOLDER = 'Root/每日Journal/日记';
const MATERIAL_FOLDER = 'Root/每日Journal/复盘素材';
const MISTAKE_NOTE = 'Root/AI时代错题本-不贰过.md';

const DAY = '2026-08-09';
const JOURNAL = `${JOURNAL_FOLDER}/${DAY}.md`;
const MATERIAL = `${MATERIAL_FOLDER}/${DAY}.json`;
const AT = new Date('2026-08-09T22:00:00');

const JOURNAL_CANDIDATE = `${CANDIDATES}/${DAY}/睡前复盘-复盘正文.md`;
const PLAN_CANDIDATE = `${CANDIDATES}/${DAY}/睡前复盘-明日计划-1.md`;
const MISTAKE_CANDIDATE = `${CANDIDATES}/${DAY}/睡前复盘-不贰过-1.md`;

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
    async listFolders(folder) {
      const prefix = folder ? `${folder}/` : '';
      const names = new Set();
      for (const path of files.keys()) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash > 0) names.add(rest.slice(0, slash));
      }
      return [...names];
    },
    async remove(path) {
      if (!files.has(path)) return false;
      files.delete(path);
      return true;
    },
  };
}

/** 一天的番茄流水：两个挂在 g-6 上的整番茄、一个没挂目标也没跑满的，外加一段休息。 */
function dayLedger() {
  let day = core.createDayLedger(DAY, {
    targetMinutes: 560,
    windowHours: 14,
    generator: GENERATOR,
  });
  const sessions = [
    { id: 'work-1', kind: 'work', minutes: 25, completed: true, task: '写 PRD', goalId: 'g-6' },
    { id: 'work-2', kind: 'work', minutes: 25, completed: true, task: '写 PRD', goalId: 'g-6' },
    { id: 'work-3', kind: 'work', minutes: 10, completed: false, task: '看书', goalId: null },
    { id: 'break-1', kind: 'break', minutes: 5, completed: true, task: '', goalId: null },
  ];
  for (const [index, item] of sessions.entries()) {
    day = core.upsertSession(day, {
      id: item.id,
      kind: item.kind,
      startedAt: `2026-08-09T09:${String(index * 10).padStart(2, '0')}:00+09:00`,
      endedAt: `2026-08-09T09:${String(index * 10 + 5).padStart(2, '0')}:00+09:00`,
      plannedSeconds: 1500,
      actualSeconds: item.minutes * 60,
      completed: item.completed,
      task: item.task,
      mode: 'accelerated-practice',
      pomodoroIndex: index + 1,
      phase: '土五',
      segment: '三小时工作日',
      points: null,
      pointsRule: null,
      goalId: item.goalId,
    });
  }
  return core.serializeDayLedger(day);
}

function makeStore(seed = {}, overrides = {}) {
  const io = memoryVault(seed);
  const settings = {
    ...core.DEFAULT_SETTINGS,
    candidatesFolder: CANDIDATES,
    goalTreeNote: GOAL_NOTE,
    pointsFolder: POINTS_FOLDER,
    pointsTaskNote: `${POINTS_FOLDER}/积分任务表.md`,
    ledgerFolder: LEDGER_FOLDER,
    reviewJournalFolder: JOURNAL_FOLDER,
    reviewMaterialFolder: MATERIAL_FOLDER,
    reviewMistakeNote: MISTAKE_NOTE,
    mirrorPointsIntoDayLedger: false,
    ...overrides,
  };
  const dayLedgerPath = (day) => `${LEDGER_FOLDER}/${day}.json`;
  const goals = new core.GoalStore({ io, generator: GENERATOR, settings: () => settings });
  const points = new core.PointsStore({
    io,
    generator: GENERATOR,
    settings: () => settings,
    dayLedgerPath,
  });
  const candidates = new core.CandidateStore({
    io,
    generator: GENERATOR,
    settings: () => settings,
    goals,
    points,
  });
  const review = new core.ReviewStore({
    io,
    generator: GENERATOR,
    settings: () => settings,
    points,
    goals,
    candidates,
    dayLedgerPath,
  });
  return { review, candidates, goals, points, io, settings };
}

/** 骨架 g-1..g-6（宇宙 → 日内），两个番茄和一笔入账都挂在最底下那个 g-6 上。 */
async function seeded(overrides = {}) {
  const store = makeStore({ [`${LEDGER_FOLDER}/${DAY}.json`]: dayLedger() }, overrides);
  await store.goals.load();
  await store.goals.writeSkeleton();
  await store.points.load();
  await store.points.record({
    at: new Date('2026-08-09T10:00:00'),
    direction: 'earn',
    amount: 6,
    reason: '写完第一节',
    goalId: 'g-6',
  });
  await store.points.record({
    at: new Date('2026-08-09T21:00:00'),
    direction: 'spend',
    amount: 12,
    reason: '刷视频 30 分钟',
    taskId: 'video',
  });
  await store.candidates.load();
  return store;
}

const DRAFT = {
  day: DAY,
  author: 'agent:夜班复盘',
  body: '## 睡前复盘 · 2026-08-09\n\n今天专注不够，晚上漏了。\n',
  plans: [
    {
      title: '把第二节写完',
      parent: 'goal:g-5',
      level: '日内目标',
      kind: 'Spec',
      due: '2026-08-10',
      note: '今天卡在第一节，明天先把第二节的骨架搭出来。',
    },
  ],
  mistakes: [
    {
      title: '晚上八点之后开新任务，结果两头都没做完',
      harm: '大半天',
      odds: '中等',
      cause: '白天的番茄没跑满，晚上想补',
      lesson: '晚上只收尾，不开新题',
    },
  ],
};

// ---------------------------------------------------------------------------
// 取数汇总
// ---------------------------------------------------------------------------

test('取数：番茄、积分、目标树三处汇到一处，人不用自己翻', async () => {
  const { review } = await seeded();
  const material = await review.collect(DAY);

  assert.strictEqual(material.day, DAY);
  assert.strictEqual(material.focus.minutes, 60);
  assert.strictEqual(material.focus.targetMinutes, 560);
  assert.strictEqual(material.focus.completed, 2);
  assert.strictEqual(material.focus.started, 3);
  assert.strictEqual(material.focus.breakMinutes, 5);
  assert.strictEqual(material.focus.onGoal, 2);
  assert.deepStrictEqual(
    material.focus.byTask,
    [
      { task: '写 PRD', minutes: 50, completed: 2 },
      { task: '看书', minutes: 10, completed: 0 },
    ],
  );

  assert.strictEqual(material.points.earned, 6);
  assert.strictEqual(material.points.spent, 12);
  assert.strictEqual(material.points.net, -6);
  assert.strictEqual(material.points.closing, -6);

  // `goal:g-6` 在给人看的那一栏里摊成整条路径，不留一个裸 id
  const scored = material.points.byTask.find((slice) => slice.key === 'goal:g-6');
  assert.ok(scored, '按目标记的那一笔在');
  assert.match(scored.label, /日内目标/);

  assert.strictEqual(material.goals.touched.length, 1);
  assert.strictEqual(material.goals.touched[0].id, 'g-6');
  assert.strictEqual(material.goals.touched[0].pomodoros, 2);
  assert.strictEqual(material.goals.touched[0].earned, 6);
  assert.match(material.goals.touched[0].path, /宇宙级目标/);
});

test('取数：目标树那一栏只列今天真动过的，光记过分也算动过', async () => {
  const { review, points } = await seeded();
  await points.record({
    at: new Date('2026-08-09T15:00:00'),
    direction: 'earn',
    amount: 3,
    reason: '顺手推了一下',
    goalId: 'g-5',
  });

  const material = await review.collect(DAY);
  assert.deepStrictEqual(
    material.goals.touched.map((goal) => goal.id),
    ['g-6', 'g-5'],
  );
  const kpi = material.goals.touched.find((goal) => goal.id === 'g-5');
  assert.strictEqual(kpi.pomodoros, 0);
  assert.strictEqual(kpi.earned, 3);
});

test('取数：挂着的目标被删了也如实列出来，不把那几个番茄悄悄丢掉', async () => {
  const { review, goals } = await seeded();
  await goals.remove('g-6');

  const material = await review.collect(DAY);
  const gone = material.goals.touched.find((goal) => goal.id === 'g-6');
  assert.strictEqual(gone.title, '（已不在树上）');
  assert.strictEqual(gone.pomodoros, 2);
  assert.match(
    material.points.byTask.find((slice) => slice.key === 'goal:g-6').label,
    /已不在树上/,
  );
});

test('取数：当天一个番茄都没跑也能取数，不当错误处理', async () => {
  const { review } = makeStore();
  const material = await review.collect(DAY);
  assert.strictEqual(material.focus.minutes, 0);
  assert.strictEqual(material.focus.started, 0);
  // 日档还没建起来，但目标分钟数是设置里的事，不该跟着一起消失
  assert.strictEqual(material.focus.targetMinutes, 560);
  assert.deepStrictEqual(material.goals.touched, []);

  const body = core.describeReviewMaterial(material);
  assert.match(body, /今天一个番茄都没开始/);
  assert.match(body, /今天一笔账都没记/);
  assert.match(body, /专注离目标差 560 分钟/);
});

test('素材包写盘幂等：同样的一天序列化出同样的字节', async () => {
  const { review, io } = await seeded();
  await review.run(DAY, { at: AT });
  const first = io.text(MATERIAL);
  assert.ok(first, '素材包落盘了');

  await review.run(DAY, { at: AT });
  assert.strictEqual(io.text(MATERIAL), first);
  assert.strictEqual(await io.writeIfChanged(MATERIAL, first), false);

  const parsed = core.parseReviewMaterial(first);
  assert.strictEqual(parsed.day, DAY);
  assert.strictEqual(core.serializeReviewMaterial(parsed), first);
});

// ---------------------------------------------------------------------------
// 兜底草稿
// ---------------------------------------------------------------------------

test('兜底草稿：把算得出来的都算出来，六维照日记模板的原句排', async () => {
  const { review } = await seeded();
  const draft = core.fallbackReviewDraft(await review.collect(DAY));

  assert.match(draft.body, /## 睡前复盘 · 2026-08-09/);
  assert.match(draft.body, /完成 2 个 \/ 开始 3 个，专注 60 分钟（目标 560，达成 10\.71%）/);
  assert.match(draft.body, /入账 6、出账 12、净 -6/);
  assert.match(draft.body, /### 完成度判断/);
  assert.match(draft.body, /### 偏差在哪/);
  for (const dimension of core.SIX_DIMENSIONS) {
    assert.match(draft.body, new RegExp(`#### ${escapeRe(dimension)}`));
  }
});

test('兜底草稿：偏差只报数得出来的那几种', async () => {
  const { review } = await seeded();
  const draft = core.fallbackReviewDraft(await review.collect(DAY));

  assert.match(draft.body, /专注离目标差 500 分钟/);
  assert.match(draft.body, /有 1 个番茄没跑满/);
  assert.match(draft.body, /3 个番茄里只有 2 个挂了目标/);
  assert.match(draft.body, /出账 12 高过入账 6/);
});

test('兜底草稿不猜「明天该改什么」，也不往错题本灌流水账', async () => {
  const { review } = await seeded();
  const draft = core.fallbackReviewDraft(await review.collect(DAY));

  assert.deepStrictEqual(draft.plans, []);
  assert.deepStrictEqual(draft.mistakes, []);
  assert.match(draft.body, /### 明天该改什么/);
  assert.match(draft.body, /它是判断，不是计算/);
});

test('AI 交回来的草稿读得进来；读不动返回 null，不静默降级', () => {
  const parsed = core.parseReviewDraft(JSON.stringify(DRAFT));
  assert.strictEqual(parsed.author, 'agent:夜班复盘');
  assert.strictEqual(parsed.plans.length, 1);
  assert.strictEqual(parsed.plans[0].title, '把第二节写完');
  assert.strictEqual(parsed.mistakes[0].harm, '大半天');

  assert.strictEqual(core.parseReviewDraft('不是 JSON'), null);
  assert.strictEqual(core.parseReviewDraft('{"body":"  "}'), null);
  // 没写标题的计划 / 教训直接丢掉，不投一条空候选项出去
  const thin = core.parseReviewDraft(
    JSON.stringify({ body: '正文', plans: [{ title: ' ' }], mistakes: [{}] }),
  );
  assert.deepStrictEqual(thin.plans, []);
  assert.deepStrictEqual(thin.mistakes, []);
});

// ---------------------------------------------------------------------------
// 投递：回写只走 R4 的候选区
// ---------------------------------------------------------------------------

test('投递：三个去处三条候选项，类型全是 R4 已有的处理器', async () => {
  const { review, io } = await seeded();
  const run = await review.run(DAY, { at: AT, draft: DRAFT });

  assert.deepStrictEqual(
    run.delivered.map((item) => [item.slot, item.state]),
    [['journal', 'written'], ['plan', 'written'], ['mistake', 'written']],
  );

  const journal = core.parseCandidate(io.text(JOURNAL_CANDIDATE));
  assert.strictEqual(journal.type, 'note');
  assert.strictEqual(journal.target, JOURNAL);
  assert.strictEqual(journal.status, '待拍板');
  assert.strictEqual(journal.source, 'agent:夜班复盘');
  assert.strictEqual(journal.id, '2026-08-09-review-journal');

  const plan = core.parseCandidate(io.text(PLAN_CANDIDATE));
  assert.strictEqual(plan.type, 'goal-node');
  assert.strictEqual(plan.target, 'goal:g-5');
  assert.strictEqual(plan.extras['目标层级'], '日内目标');
  assert.strictEqual(plan.extras['目标类型'], 'Spec');
  assert.strictEqual(plan.extras['截止'], '2026-08-10');

  const mistake = core.parseCandidate(io.text(MISTAKE_CANDIDATE));
  assert.strictEqual(mistake.type, 'note');
  assert.strictEqual(mistake.target, MISTAKE_NOTE);
  assert.match(mistake.body, /（危害时长：大半天。发生概率：中等）/);
  assert.match(mistake.body, /晚上只收尾，不开新题/);
});

test('复盘不投账本条目：分怎么记是当场的事，隔一天补记只会让账和事实对不上', () => {
  const files = core.reviewCandidates(DRAFT, {
    day: DAY,
    at: AT,
    journalNote: JOURNAL,
    mistakeNote: MISTAKE_NOTE,
  });
  assert.ok(files.every((file) => file.candidate.type !== 'ledger-entry'));
});

// ---------------------------------------------------------------------------
// 回写：人在 R4 面板上采纳之后，东西真的落到了主干
// ---------------------------------------------------------------------------

test('回写日记：采纳复盘正文就追加进当日日记，人自己写的那段不动', async () => {
  const { review, candidates, io } = await seeded();
  io.files.set(JOURNAL, '# 2026-08-09\n\n人自己先写的一段。\n');
  await review.run(DAY, { at: AT, draft: DRAFT });
  await candidates.load();

  const result = await candidates.adopt(JOURNAL_CANDIDATE, { at: AT });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.landing, JOURNAL);

  const landed = io.text(JOURNAL);
  assert.match(landed, /人自己先写的一段。/);
  assert.match(landed, /## 睡前复盘 · 2026-08-09/);
  assert.match(landed, /采纳自候选区 · `2026-08-09-review-journal`/);
});

test('回写目标树：采纳明日计划就在树上长一个节点，落点写成块引用', async () => {
  const { review, candidates, goals, io } = await seeded();
  await review.run(DAY, { at: AT, draft: DRAFT });
  await candidates.load();

  const result = await candidates.adopt(PLAN_CANDIDATE, { at: AT });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.landing, '[[目标树#^g-7]]');

  const node = goals.find('g-7');
  assert.strictEqual(node.title, '把第二节写完');
  assert.strictEqual(node.level, 'daily');
  assert.strictEqual(node.kind, 'Spec');
  assert.strictEqual(node.due, '2026-08-10');
  assert.strictEqual(goals.find('g-5').children.at(-1).id, 'g-7');
  assert.match(io.text(GOAL_NOTE), /\^g-7/);
});

test('回写错题本：采纳「不贰过」追加进错题本，同一条采纳两次不写两份', async () => {
  const { review, candidates, io } = await seeded();
  io.files.set(MISTAKE_NOTE, '# AI时代错题本-不贰过\n\n## 交给AI去读的【不贰过】错误\n');
  await review.run(DAY, { at: AT, draft: DRAFT });
  await candidates.load();

  const first = await candidates.adopt(MISTAKE_CANDIDATE, { at: AT });
  assert.strictEqual(first.landing, MISTAKE_NOTE);
  assert.match(io.text(MISTAKE_NOTE), /晚上八点之后开新任务/);

  // 夜班又投了一模一样的一条，人手滑再采纳一次
  await review.run(DAY, { at: AT, draft: DRAFT });
  await candidates.load();
  await candidates.adopt(MISTAKE_CANDIDATE, { at: AT });
  assert.strictEqual(
    io.text(MISTAKE_NOTE).match(/晚上八点之后开新任务/g).length,
    1,
    '错题本里只有一条',
  );
});

// ---------------------------------------------------------------------------
// 重跑安全
// ---------------------------------------------------------------------------

test('重跑：同一天再投一次不落笔，不给 Easy-Git 刷空 commit', async () => {
  const { review, io } = await seeded();
  await review.run(DAY, { at: AT, draft: DRAFT });
  io.writes.length = 0;

  const again = await review.run(DAY, { at: AT, draft: DRAFT });
  assert.deepStrictEqual(io.writes, []);
  assert.ok(again.delivered.every((item) => item.state === 'unchanged'));
});

test('重跑：人已经打回的那条不覆盖，理由留在原地', async () => {
  const { review, candidates, io } = await seeded();
  await review.run(DAY, { at: AT, draft: DRAFT });
  await candidates.load();
  await candidates.reject(JOURNAL_CANDIDATE, {
    at: new Date('2026-08-09T22:30:00'),
    reason: '完成度判断太宽了，60 分钟不叫「往前走」',
  });

  const again = await review.run(DAY, { at: AT, draft: DRAFT });
  const journal = again.delivered.find((item) => item.slot === 'journal');
  assert.strictEqual(journal.state, 'skipped');
  assert.match(journal.reason, /已打回/);

  const kept = core.parseCandidate(io.text(JOURNAL_CANDIDATE));
  assert.strictEqual(kept.status, '已打回');
  assert.strictEqual(kept.decisions.at(-1).reason, '完成度判断太宽了，60 分钟不叫「往前走」');
});

test('重跑：已经采纳过的那条不复活成一条新待办', async () => {
  const { review, candidates, io } = await seeded();
  await review.run(DAY, { at: AT, draft: DRAFT });
  await candidates.load();
  const adopted = await candidates.adopt(JOURNAL_CANDIDATE, { at: AT });
  assert.strictEqual(adopted.ok, true);

  const again = await review.run(DAY, { at: AT, draft: DRAFT });
  const journal = again.delivered.find((item) => item.slot === 'journal');
  assert.strictEqual(journal.state, 'skipped');
  assert.match(journal.reason, /已经采纳过了/);
  assert.strictEqual(io.text(JOURNAL_CANDIDATE), null, '原地没被刷出一条新的');
  assert.strictEqual(io.text(JOURNAL).match(/## 睡前复盘 · 2026-08-09/g).length, 1);
});

// ---------------------------------------------------------------------------
// 打回的理由读回来——别在同一个地方栽第二次
// ---------------------------------------------------------------------------

test('下一轮取数读得到上一轮的打回理由，且只认复盘自己投出去的那几条', async () => {
  const { review, candidates, io } = await seeded();
  await review.run(DAY, { at: AT, draft: DRAFT });
  // 别人的候选项也被打回过：这条不该混进复盘的素材包
  io.files.set(
    `${CANDIDATES}/${DAY}/资讯N次方总结-L2.md`,
    core.serializeCandidate({
      ...core.parseCandidate('---\n候选ID: 20260809-news-digest-L2\n状态: 待拍板\n---\n\n正文\n'),
    }),
  );
  await candidates.load();
  await candidates.reject(JOURNAL_CANDIDATE, {
    at: new Date('2026-08-09T22:30:00'),
    reason: '完成度判断太宽了',
  });
  await candidates.reject(`${CANDIDATES}/${DAY}/资讯N次方总结-L2.md`, {
    at: new Date('2026-08-09T22:40:00'),
    reason: '主题二并得太粗',
  });

  const material = await review.collect(DAY);
  assert.deepStrictEqual(
    material.rejections.map((item) => item.reason),
    ['完成度判断太宽了'],
  );
  assert.strictEqual(material.rejections[0].from, '睡前复盘-复盘正文.md');
  // 下一轮的草稿正文里就带着这句，写草稿的人 / Agent 一眼看得到
  assert.match(core.describeReviewMaterial(material), /别在同一个地方栽第二次/);
  assert.match(core.describeReviewMaterial(material), /完成度判断太宽了/);
});

test('复盘投出去的候选项认得出来，别人的认不出来', () => {
  const mine = core.parseCandidate('---\n候选ID: 2026-08-09-review-plan-2\n---\n\n正文\n');
  const theirs = core.parseCandidate('---\n候选ID: 20260809-news-digest-L2\n---\n\n正文\n');
  assert.strictEqual(core.isReviewCandidate(mine), true);
  assert.strictEqual(core.isReviewCandidate(theirs), false);
  assert.strictEqual(core.reviewCandidateId(DAY, 'journal'), '2026-08-09-review-journal');
  assert.strictEqual(core.reviewCandidateId(DAY, 'mistake', 3), '2026-08-09-review-mistake-3');
});

// ---------------------------------------------------------------------------
// 睡前触发
// ---------------------------------------------------------------------------

test('睡前触发：到点提醒一次，同一个账本日不再提醒第二次', () => {
  const input = { day: DAY, atMinute: 22 * 60, rolloverHour: 4 };

  let state = core.createBedtimeState();
  let result = core.tickBedtime(state, { ...input, minute: 21 * 60 + 59 });
  assert.strictEqual(result.due, false);

  result = core.tickBedtime(result.state, { ...input, minute: 22 * 60 });
  assert.strictEqual(result.due, true);

  result = core.tickBedtime(result.state, { ...input, minute: 23 * 60 });
  assert.strictEqual(result.due, false, '一天只提醒一次');

  // 换天重置：第二天照旧提醒
  result = core.tickBedtime(result.state, { ...input, day: '2026-08-10', minute: 22 * 60 });
  assert.strictEqual(result.due, true);
});

test('睡前触发：凌晨还没睡的，进门补提醒一次', () => {
  // 01:30 按 dayRolloverHour=4 还算前一天，睡点早就过了
  assert.strictEqual(core.bedtimeDue(90, 22 * 60, 4), true);
  // 05:00 已经翻到新的一天，那是新一天的开头，不是昨天的睡点
  assert.strictEqual(core.bedtimeDue(300, 22 * 60, 4), false);
  // 换天点设成 0 点（自然日）时不存在「凌晨还算前一天」，只认到点
  assert.strictEqual(core.bedtimeDue(90, 22 * 60, 0), false);

  const result = core.tickBedtime(core.createBedtimeState(), {
    day: DAY,
    minute: 90,
    atMinute: 22 * 60,
    rolloverHour: 4,
  });
  assert.strictEqual(result.due, true);
});

test('手动发起过就不再提醒——人已经在做这件事了', () => {
  const state = core.markBedtimeFired(DAY);
  const result = core.tickBedtime(state, {
    day: DAY,
    minute: 23 * 60,
    atMinute: 22 * 60,
    rolloverHour: 4,
  });
  assert.strictEqual(result.due, false);
});

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
