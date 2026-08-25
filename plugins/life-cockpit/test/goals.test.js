'use strict';

// 目标树的纯逻辑：向下拆分、向上回灌、读写往返。
// 回灌那一组是本项的重点——只做单向拆分等于又造了一堆静态清单。

const test = require('node:test');
const assert = require('node:assert');
const core = require('./.build/core.js');

const GENERATOR = 'life-cockpit@0.3.0';

function serialize(tree) {
  return core.serializeGoalTree(tree, { generator: GENERATOR });
}

/** 造一棵树：nest([[title, [child...]]])，层级按嵌套深度自动排。 */
function build(spec) {
  let tree = core.createGoalTree();
  const add = (parentId, items) => {
    for (const item of items) {
      const taken = core.takeGoalId(tree);
      const parent = core.findGoal(taken.tree.roots, parentId);
      const level = parent ? core.childLevelOf(parent.level) : core.GOAL_LEVELS[0];
      const node = core.createGoalNode(taken.id, { ...item, level, children: [] });
      tree = { ...taken.tree, roots: core.insertGoal(taken.tree.roots, parentId, node) };
      if (item.children) add(node.id, item.children);
    }
  };
  add(null, spec);
  return tree;
}

function progressOf(tree, id) {
  return core.computeProgress(tree.roots).get(id).progress;
}

function idsByTitle(tree) {
  const map = new Map();
  for (const node of core.walkGoals(tree.roots)) map.set(node.title, node.id);
  return map;
}

// ---------------------------------------------------------------------------
// 树本体
// ---------------------------------------------------------------------------

test('六层骨架就是《知识库》那六层，顺序不乱', () => {
  const tree = core.defaultGoalSkeleton();
  const levels = core.walkGoals(tree.roots).map((node) => node.level);
  assert.deepStrictEqual(levels, core.GOAL_LEVELS);
  assert.strictEqual(tree.roots.length, 1, '六层是一条链，不是六个根');
  assert.strictEqual(core.walkGoals(tree.roots).at(-1).kind, 'Issue');
});

test('挂子节点自动降一级，最深停在日内目标', () => {
  assert.strictEqual(core.childLevelOf('okr'), 'kpi');
  assert.strictEqual(core.childLevelOf('kpi'), 'daily');
  assert.strictEqual(core.childLevelOf('daily'), 'daily', '更深的缩进照旧收下，层级名到此为止');
});

test('增删改与同级挪动', () => {
  let tree = build([{ title: '甲' }, { title: '乙' }]);
  const ids = idsByTitle(tree);

  tree = { ...tree, roots: core.updateGoal(tree.roots, ids.get('甲'), { status: 'active' }) };
  assert.strictEqual(core.findGoal(tree.roots, ids.get('甲')).status, 'active');

  tree = { ...tree, roots: core.moveGoal(tree.roots, ids.get('乙'), -1) };
  assert.deepStrictEqual(tree.roots.map((node) => node.title), ['乙', '甲']);

  tree = { ...tree, roots: core.moveGoal(tree.roots, ids.get('乙'), -1) };
  assert.deepStrictEqual(tree.roots.map((node) => node.title), ['乙', '甲'], '到头了就不动');

  tree = { ...tree, roots: core.removeGoal(tree.roots, ids.get('乙')) };
  assert.deepStrictEqual(tree.roots.map((node) => node.title), ['甲']);
});

test('删掉整支时子树一起走', () => {
  let tree = build([{ title: '父', children: [{ title: '子', children: [{ title: '孙' }] }] }]);
  const ids = idsByTitle(tree);
  tree = { ...tree, roots: core.removeGoal(tree.roots, ids.get('子')) };
  assert.deepStrictEqual(core.walkGoals(tree.roots).map((node) => node.title), ['父']);
});

test('goalPath 给出从根到该节点的整条面包屑', () => {
  const tree = build([{ title: '人生', children: [{ title: 'OKR', children: [{ title: 'KPI' }] }] }]);
  const ids = idsByTitle(tree);
  assert.deepStrictEqual(
    core.goalPath(tree.roots, ids.get('KPI')).map((node) => node.title),
    ['人生', 'OKR', 'KPI'],
  );
  assert.strictEqual(core.parentOfGoal(tree.roots, ids.get('KPI')).title, 'OKR');
  assert.deepStrictEqual(core.goalPath(tree.roots, '不存在'), []);
});

// ---------------------------------------------------------------------------
// 向上回灌
// ---------------------------------------------------------------------------

test('日内目标做完，进度一路回灌到 KPI 与 OKR', () => {
  let tree = build([
    {
      title: 'OKR',
      children: [
        { title: 'KPI-1', children: [{ title: '日内-1' }, { title: '日内-2' }] },
        { title: 'KPI-2', children: [{ title: '日内-3' }, { title: '日内-4' }] },
      ],
    },
  ]);
  const ids = idsByTitle(tree);
  assert.strictEqual(progressOf(tree, ids.get('OKR')), 0);

  tree = { ...tree, roots: core.updateGoal(tree.roots, ids.get('日内-1'), { status: 'done' }) };
  assert.strictEqual(progressOf(tree, ids.get('KPI-1')), 50);
  assert.strictEqual(progressOf(tree, ids.get('OKR')), 25, '两层平均一路收上来');

  tree = { ...tree, roots: core.updateGoal(tree.roots, ids.get('日内-2'), { status: 'done' }) };
  assert.strictEqual(progressOf(tree, ids.get('KPI-1')), 100);
  assert.strictEqual(progressOf(tree, ids.get('OKR')), 50);
});

test('回灌按权重加权，不是每个子目标一样重', () => {
  let tree = build([
    {
      title: 'OKR',
      children: [
        { title: '重', weight: 3 },
        { title: '轻', weight: 1 },
      ],
    },
  ]);
  const ids = idsByTitle(tree);

  tree = { ...tree, roots: core.updateGoal(tree.roots, ids.get('重'), { status: 'done' }) };
  assert.strictEqual(progressOf(tree, ids.get('OKR')), 75);
});

test('已放弃的整支退出上层汇总', () => {
  let tree = build([
    {
      title: 'OKR',
      children: [
        { title: '做完的', status: 'done' },
        { title: '放弃的' },
      ],
    },
  ]);
  const ids = idsByTitle(tree);
  assert.strictEqual(progressOf(tree, ids.get('OKR')), 50);

  tree = { ...tree, roots: core.updateGoal(tree.roots, ids.get('放弃的'), { status: 'dropped' }) };
  assert.strictEqual(progressOf(tree, ids.get('OKR')), 100, '放弃一支不该让父目标永远背着');
  assert.strictEqual(core.computeProgress(tree.roots).get(ids.get('OKR')).leaves, 1);
});

test('手动结项压过子节点，度量压过手写完成度', () => {
  const closed = build([{ title: '父', status: 'done', children: [{ title: '子' }] }]);
  assert.strictEqual(progressOf(closed, idsByTitle(closed).get('父')), 100);
  assert.strictEqual(
    core.computeProgress(closed.roots).get(idsByTitle(closed).get('父')).source,
    'closed',
  );

  const measured = build([
    { title: '有度量', metric: { current: 3, target: 10, unit: '篇' }, manualProgress: 80 },
  ]);
  assert.strictEqual(progressOf(measured, idsByTitle(measured).get('有度量')), 30);

  const claimed = build([{ title: '只有手写', manualProgress: 40 }]);
  assert.strictEqual(progressOf(claimed, idsByTitle(claimed).get('只有手写')), 40);
});

test('叶子计数只数没放弃的那些', () => {
  const tree = build([
    {
      title: 'OKR',
      children: [
        { title: 'A', status: 'done' },
        { title: 'B' },
        { title: 'C', status: 'dropped' },
      ],
    },
  ]);
  const stat = core.computeProgress(tree.roots).get(idsByTitle(tree).get('OKR'));
  assert.strictEqual(stat.leaves, 2);
  assert.strictEqual(stat.doneLeaves, 1);
  assert.strictEqual(stat.rolledChildren, 2);
});

test('整棵树的进度按顶层加权，空树是 0', () => {
  assert.strictEqual(core.treeProgress([], new Map()), 0);
  const tree = build([{ title: '甲', status: 'done' }, { title: '乙' }]);
  assert.strictEqual(core.treeProgress(tree.roots, core.computeProgress(tree.roots)), 50);
});

test('权重全是 0 时退回等权，不会把整层算成 0', () => {
  const tree = build([
    { title: 'OKR', children: [{ title: 'A', status: 'done', weight: 0 }, { title: 'B', weight: 0 }] },
  ]);
  assert.strictEqual(progressOf(tree, idsByTitle(tree).get('OKR')), 50);
});

// ---------------------------------------------------------------------------
// 向下拆分
// ---------------------------------------------------------------------------

test('摊量：整数摊成整数，余数给靠前的几段，各段之和等于总量', () => {
  assert.deepStrictEqual(core.splitEvenly(12, 4), [3, 3, 3, 3]);
  assert.deepStrictEqual(core.splitEvenly(10, 4), [3, 3, 2, 2]);
  assert.deepStrictEqual(core.splitEvenly(3, 5), [1, 1, 1, 0, 0]);
  for (const [total, count] of [[10, 4], [7, 3], [12, 5], [2.5, 4]]) {
    const parts = core.splitEvenly(total, count);
    assert.strictEqual(parts.length, count);
    assert.strictEqual(Math.round(parts.reduce((a, b) => a + b, 0) * 100) / 100, total);
  }
});

test('OKR 按季度拆成 KPI：量摊满、权重等于摊到的量、截止落在季末', () => {
  const tree = build([{ title: '写完一本书', metric: { current: 0, target: 12, unit: '章' } }]);
  const okr = tree.roots[0];
  const drafts = core.suggestBreakdown(okr, {
    scheme: 'quarter',
    count: 4,
    from: new Date(2026, 0, 15, 12),
    level: 'kpi',
  });

  assert.deepStrictEqual(drafts.map((draft) => draft.title), [
    '写完一本书 · 2026 Q1',
    '写完一本书 · 2026 Q2',
    '写完一本书 · 2026 Q3',
    '写完一本书 · 2026 Q4',
  ]);
  assert.deepStrictEqual(drafts.map((draft) => draft.metric.target), [3, 3, 3, 3]);
  assert.deepStrictEqual(drafts.map((draft) => draft.weight), [3, 3, 3, 3]);
  assert.deepStrictEqual(drafts.map((draft) => draft.due), [
    '2026-03-31', '2026-06-30', '2026-09-30', '2026-12-31',
  ]);
  assert.ok(drafts.every((draft) => draft.level === 'kpi' && draft.metric.unit === '章'));
});

test('拆出来的份额就是回灌的权重：做完第一段，父目标正好涨该涨的那一截', () => {
  let tree = build([{ title: 'OKR', metric: { current: 0, target: 10, unit: '篇' } }]);
  const okr = tree.roots[0];
  const drafts = core.suggestBreakdown(okr, {
    scheme: 'even',
    count: 4,
    from: new Date(2026, 7, 10, 12),
  });

  for (const draft of drafts) {
    const taken = core.takeGoalId(tree);
    const node = core.createGoalNode(taken.id, { ...draft, children: [] });
    tree = { ...taken.tree, roots: core.insertGoal(taken.tree.roots, okr.id, node) };
  }

  const first = tree.roots[0].children[0];
  assert.strictEqual(first.weight, 3, '10 摊 4 段，第一段拿 3');
  tree = { ...tree, roots: core.updateGoal(tree.roots, first.id, { status: 'done' }) };
  assert.strictEqual(progressOf(tree, okr.id), 30, '3/10 = 30%');
});

test('没有度量的目标只均分段数，权重一律 1', () => {
  const tree = build([{ title: 'KPI' }]);
  const drafts = core.suggestBreakdown(tree.roots[0], {
    scheme: 'even',
    count: 3,
    from: new Date(2026, 7, 10, 12),
  });
  assert.deepStrictEqual(drafts.map((draft) => draft.title), ['KPI · 第 1 段', 'KPI · 第 2 段', 'KPI · 第 3 段']);
  assert.ok(drafts.every((draft) => draft.metric === null && draft.weight === 1 && draft.due === null));
});

test('按周 / 按月 / 按天的段名与截止', () => {
  const tree = build([{ title: 'KPI' }]);
  const node = tree.roots[0];
  const week = core.suggestBreakdown(node, { scheme: 'week', count: 2, from: new Date(2026, 0, 8, 12) });
  assert.deepStrictEqual(week.map((draft) => draft.due), ['2026-01-11', '2026-01-18']);

  const month = core.suggestBreakdown(node, { scheme: 'month', count: 2, from: new Date(2026, 0, 20, 12) });
  assert.deepStrictEqual(month.map((draft) => draft.title), ['KPI · 2026-01', 'KPI · 2026-02']);
  assert.deepStrictEqual(month.map((draft) => draft.due), ['2026-01-31', '2026-02-28']);

  const day = core.suggestBreakdown(node, {
    scheme: 'day',
    count: 3,
    from: new Date(2026, 7, 10, 12),
    level: 'daily',
  });
  assert.deepStrictEqual(day.map((draft) => draft.title), [
    'KPI · 2026-08-10', 'KPI · 2026-08-11', 'KPI · 2026-08-12',
  ]);
  assert.ok(day.every((draft) => draft.kind === 'Issue'), '日内目标默认按 Issue 落');
});

test('子目标的截止不会越过父目标的截止', () => {
  const tree = build([{ title: 'OKR', due: '2026-05-31' }]);
  const drafts = core.suggestBreakdown(tree.roots[0], {
    scheme: 'quarter',
    count: 4,
    from: new Date(2026, 0, 15, 12),
  });
  assert.deepStrictEqual(drafts.map((draft) => draft.due), [
    '2026-03-31', '2026-05-31', '2026-05-31', '2026-05-31',
  ]);
});

test('每层有自己的默认切法', () => {
  const from = new Date(2026, 7, 10, 12);
  const okr = build([{ title: 'x', level: 'okr' }]);
  assert.strictEqual(core.defaultBreakdown({ ...okr.roots[0], level: 'okr' }, from).scheme, 'quarter');
  assert.strictEqual(core.defaultBreakdown({ ...okr.roots[0], level: 'kpi' }, from).count, 5);
});

// ---------------------------------------------------------------------------
// 读写往返
// ---------------------------------------------------------------------------

test('序列化 → 解析 → 再序列化，字节一模一样', () => {
  const tree = build([
    {
      title: '宇宙级',
      children: [
        {
          title: '人生级',
          status: 'active',
          children: [
            { title: '大阶段', due: '2030-12-31', weight: 2 },
            { title: '另一支', status: 'dropped' },
          ],
        },
      ],
    },
  ]);
  const once = serialize(tree);
  const twice = serialize(core.parseGoalTree(once));
  assert.strictEqual(twice, once);
  assert.strictEqual(serialize(tree), once, '同一棵树序列化两次也要一样');
});

test('四个记号原样往返，别的记号归一成未开始', () => {
  const tree = build([
    { title: '未开始' },
    { title: '进行中', status: 'active' },
    { title: '已完成', status: 'done' },
    { title: '已放弃', status: 'dropped' },
  ]);
  const text = serialize(tree);
  assert.match(text, /- \[ \] 未开始 /);
  assert.match(text, /- \[\/\] 进行中 /);
  assert.match(text, /- \[x\] 已完成 /);
  assert.match(text, /- \[-\] 已放弃 /);

  const back = core.parseGoalTree(text);
  assert.deepStrictEqual(
    core.walkGoals(back.roots).map((node) => node.status),
    ['planned', 'active', 'done', 'dropped'],
  );

  const odd = core.parseGoalTree('## 树\n\n- [>] 顺延了 ^g-9\n');
  assert.strictEqual(odd.roots[0].status, 'planned');
});

test('缩进决定层级，tab 和空格混用也排得出父子', () => {
  const text = [
    '## 树',
    '',
    '- [ ] 宇宙 ^g-1',
    '\t- [ ] 人生 ^g-2',
    '        - [ ] 大阶段 ^g-3',
    '- [ ] 另一个宇宙 ^g-4',
  ].join('\n');

  const tree = core.parseGoalTree(text);
  assert.deepStrictEqual(tree.roots.map((node) => node.title), ['宇宙', '另一个宇宙']);
  assert.strictEqual(tree.roots[0].children[0].title, '人生');
  assert.strictEqual(tree.roots[0].children[0].level, 'life');
  assert.strictEqual(tree.roots[0].children[0].children[0].level, 'stage');
});

test('跳级要写出 [层级:: OKR]，读回来还是 OKR', () => {
  let tree = build([{ title: '人生', children: [{ title: '今年' }] }]);
  const ids = idsByTitle(tree);
  tree = { ...tree, roots: core.updateGoal(tree.roots, ids.get('今年'), { level: 'okr' }) };

  const text = serialize(tree);
  assert.match(text, /\[层级:: OKR\]/);
  const back = core.parseGoalTree(text);
  assert.strictEqual(back.roots[0].children[0].level, 'okr');
  assert.strictEqual(serialize(back), text);
});

test('子节点的层级永远比父节点深一级，手写倒挂会被扳回来', () => {
  const text = '## 树\n\n- [ ] 甲 [层级:: KPI] ^g-1\n    - [ ] 乙 [层级:: 宇宙] ^g-2\n';
  const tree = core.parseGoalTree(text);
  assert.strictEqual(tree.roots[0].level, 'kpi');
  assert.strictEqual(tree.roots[0].children[0].level, 'daily');
});

test('进度是算出来的：写盘写出来，读盘直接扔', () => {
  const tree = build([{ title: 'OKR', children: [{ title: '子', status: 'done' }] }]);
  const text = serialize(tree);
  assert.match(text, /- \[ \] OKR \[进度:: 100%\]/);

  const tampered = text.replace('[进度:: 100%]', '[进度:: 3%]');
  const back = core.parseGoalTree(tampered);
  assert.strictEqual(progressOf(back, back.roots[0].id), 100, '改进度那一栏没有意义');
});

test('度量 / 完成 / 权重 / 类型 / 截止 都能往返', () => {
  const tree = build([
    {
      title: '日内',
      metric: { current: 3, target: 10, unit: '篇' },
      manualProgress: 40,
      weight: 2.5,
      kind: 'Spec',
      due: '2026-09-30',
    },
  ]);
  const text = serialize(tree);
  assert.match(text, /\[度量:: 3\/10 篇\]/);
  assert.match(text, /\[完成:: 40%\]/);
  assert.match(text, /\[权重:: 2\.5\]/);
  assert.match(text, /\[类型:: Spec\]/);
  assert.match(text, /\[截止:: 2026-09-30\]/);

  const node = core.parseGoalTree(text).roots[0];
  assert.deepStrictEqual(node.metric, { current: 3, target: 10, unit: '篇' });
  assert.strictEqual(node.manualProgress, 40);
  assert.strictEqual(node.weight, 2.5);
  assert.strictEqual(node.kind, 'Spec');
  assert.strictEqual(node.due, '2026-09-30');
});

test('认不出来的行搬到《待修复》，不丢；改好了自动归位', () => {
  const broken = '## 树\n\n- [ ] 好的 ^g-1\n- 这行忘了写记号\n';
  const tree = core.parseGoalTree(broken);
  assert.deepStrictEqual(tree.roots.map((node) => node.title), ['好的']);
  assert.deepStrictEqual(tree.quarantine, ['- 这行忘了写记号']);

  const rewritten = serialize(tree);
  assert.match(rewritten, /## 待修复/);
  assert.deepStrictEqual(core.parseGoalTree(rewritten).quarantine, tree.quarantine, '还是坏的就还在那儿');
  assert.strictEqual(serialize(core.parseGoalTree(rewritten)), rewritten);

  const fixed = core.parseGoalTree(rewritten.replace('- 这行忘了写记号', '- [ ] 这行改好了'));
  assert.deepStrictEqual(fixed.quarantine, []);
  assert.deepStrictEqual(fixed.roots.map((node) => node.title), ['好的', '这行改好了']);
});

test('不认识的行内字段原样带着走，不替人删', () => {
  const text = '## 树\n\n- [ ] 甲 [来源:: 飞书] ^g-1\n';
  const tree = core.parseGoalTree(text);
  assert.strictEqual(tree.roots[0].title, '甲');
  assert.deepStrictEqual(tree.roots[0].extras, ['[来源:: 飞书]']);
  assert.match(serialize(tree), /\[来源:: 飞书\]/);
});

test('手写的新行会被补上 id，同一份文件读两遍补出来的一样', () => {
  const text = '## 树\n\n- [ ] 已有 ^g-4\n- [ ] 手写新增的\n';
  const first = core.parseGoalTree(text);
  const second = core.parseGoalTree(text);
  assert.strictEqual(first.roots[1].id, 'g-5');
  assert.strictEqual(second.roots[1].id, first.roots[1].id);
  assert.strictEqual(first.nextId, 6);
});

test('复制粘贴出来的重号，后来的那个重新取号', () => {
  const tree = core.parseGoalTree('## 树\n\n- [ ] 甲 ^g-1\n- [ ] 乙 ^g-1\n');
  assert.strictEqual(tree.roots[0].id, 'g-1');
  assert.notStrictEqual(tree.roots[1].id, 'g-1');
});

test('id 不回收：删掉编号最大的节点，下一个还是往后取', () => {
  let tree = build([{ title: '甲' }, { title: '乙' }]);
  assert.strictEqual(tree.nextId, 3);
  tree = { ...tree, roots: core.removeGoal(tree.roots, 'g-2') };

  const back = core.parseGoalTree(serialize(tree));
  assert.strictEqual(back.nextId, 3, 'frontmatter 的 nextId 只增不减');
  assert.strictEqual(core.takeGoalId(back).id, 'g-3');
});

test('空树也写得出一份能读回来的文件', () => {
  const text = serialize(core.createGoalTree());
  const tree = core.parseGoalTree(text);
  assert.deepStrictEqual(tree.roots, []);
  assert.strictEqual(serialize(tree), text);
  assert.match(text, /^---\nschemaVersion: 1\n/);
  assert.match(text, /\nprogress: 0\n/);
});

test('说明段落里的例子不会被当成节点吃进去', () => {
  const text = serialize(core.defaultGoalSkeleton());
  const tree = core.parseGoalTree(text);
  assert.strictEqual(core.walkGoals(tree.roots).length, 6);
  assert.deepStrictEqual(tree.quarantine, []);
});

test('标题里的 wiki 链接不会被当成行内字段吃掉', () => {
  const tree = build([{ title: '读完 [[日记模板]] 这一篇' }]);
  const back = core.parseGoalTree(serialize(tree));
  assert.strictEqual(back.roots[0].title, '读完 [[日记模板]] 这一篇');
});

// ---------------------------------------------------------------------------
// 飞书关键词（AME-258 第 22.2 条第 1 点）
// ---------------------------------------------------------------------------

test('[飞书:: 关键词] 写得出去也读得回来', () => {
  let tree = core.createGoalTree();
  const taken = core.takeGoalId(tree);
  const node = core.createGoalNode(taken.id, {
    title: '量化研究',
    level: 'kpi',
    feishuMatch: '量化、赛马',
  });
  tree = { ...taken.tree, roots: core.insertGoal(taken.tree.roots, null, node) };

  const text = core.serializeGoalTree(tree, { generator: 'test' });
  assert.ok(text.includes('[飞书:: 量化、赛马]'));

  const back = core.parseGoalTree(text);
  assert.strictEqual(back.roots[0].feishuMatch, '量化、赛马');
});

test('关键词按顿号 / 逗号 / 空格拆——怎么顺手怎么写', () => {
  const node = core.createGoalNode('g-1', {
    title: 'x',
    level: 'daily',
    feishuMatch: '量化、赛马, 因子  知识库',
  });
  assert.deepStrictEqual(core.goalFeishuKeywords(node), ['量化', '赛马', '因子', '知识库']);
});

test('没填关键词就是一个都不认，不是「全都认」', () => {
  const node = core.createGoalNode('g-1', { title: 'x', level: 'daily' });
  assert.deepStrictEqual(core.goalFeishuKeywords(node), []);
});

test('老的目标树笔记里没有这个字段，读回来是空串而不是 undefined', () => {
  const tree = core.parseGoalTree('## 树\n\n- [ ] 老目标 [权重:: 2] ^g-3\n');
  assert.strictEqual(tree.roots[0].feishuMatch, '');
});

// ---------------------------------------------------------------------------
// 进度从飞书那张表来（AME-271 后续）
//
//   「最好目标的完成——也可以根据【飞书Excel】上面的来？免得我在【飞书Excel上
//    手动更改了目标完成程度】——本地OB插件还要手动来一次？」
//
// 所以绑了 `[飞书:: 关键词]` 的目标，进度以表为准；没绑的一条都不受影响。
// ---------------------------------------------------------------------------

test('飞书战绩：已完成算 1、完成了一部分算 0.5', () => {
  assert.strictEqual(core.feishuGoalProgress({ done: 2, partial: 0, total: 4 }), 50);
  assert.strictEqual(core.feishuGoalProgress({ done: 1, partial: 2, total: 4 }), 50);
  assert.strictEqual(core.feishuGoalProgress({ done: 4, partial: 0, total: 4 }), 100);
  // 一条都没有不算 0%，算「没有这一档」——调用方靠 total>0 判断，这里只兜底
  assert.strictEqual(core.feishuGoalProgress({ done: 0, partial: 0, total: 0 }), 0);
});

test('绑了飞书关键词的目标，进度以表为准（压过手写完成度与度量）', () => {
  const tree = build([{ title: '量化', manualProgress: 10, metric: { current: 1, target: 10, unit: '篇' } }]);
  const id = idsByTitle(tree).get('量化');
  // 不喂战绩时照旧走度量
  assert.strictEqual(core.computeProgress(tree.roots).get(id).source, 'metric');

  const tally = new Map([[id, { done: 3, partial: 0, total: 4 }]]);
  const withFeishu = core.computeProgress(tree.roots, tally).get(id);
  assert.strictEqual(withFeishu.source, 'feishu');
  assert.strictEqual(withFeishu.progress, 75);
});

test('表上没命中就安全降级，不把一支目标压成 0%', () => {
  const tree = build([{ title: '量化', manualProgress: 40 }]);
  const id = idsByTitle(tree).get('量化');
  const tally = new Map([[id, { done: 0, partial: 0, total: 0 }]]);
  const got = core.computeProgress(tree.roots, tally).get(id);
  assert.strictEqual(got.source, 'manual');
  assert.strictEqual(got.progress, 40);
});

test('有子节点时仍然走回灌 —— 树自己的语义优先于表', () => {
  const tree = build([
    { title: '父', children: [{ title: '子甲', manualProgress: 100 }, { title: '子乙', manualProgress: 0 }] },
  ]);
  const ids = idsByTitle(tree);
  const tally = new Map([[ids.get('父'), { done: 4, partial: 0, total: 4 }]]);
  const got = core.computeProgress(tree.roots, tally).get(ids.get('父'));
  assert.strictEqual(got.source, 'rollup');
  assert.strictEqual(got.progress, 50);
});

test('没绑关键词的目标一条都不受影响', () => {
  const tree = build([{ title: '甲', manualProgress: 30 }, { title: '乙', manualProgress: 60 }]);
  const ids = idsByTitle(tree);
  const tally = new Map([[ids.get('甲'), { done: 1, partial: 0, total: 1 }]]);
  const map = core.computeProgress(tree.roots, tally);
  assert.strictEqual(map.get(ids.get('甲')).source, 'feishu');
  assert.strictEqual(map.get(ids.get('乙')).source, 'manual');
  assert.strictEqual(map.get(ids.get('乙')).progress, 60);
});
