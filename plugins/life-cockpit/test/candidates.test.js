'use strict';

// 夜班候选区的解析，以及采纳 / 打回 / 改写三个动作的落盘结果。
// CandidateStore 的文件访问全部走注入的 VaultIo，所以这里用一个内存 vault 就能跑成真的：
// 采纳到目标树、采纳成账本一笔这两条也接的是真的 GoalStore / PointsStore。

const test = require('node:test');
const assert = require('node:assert');
const core = require('./.build/core.js');

const GENERATOR = 'life-cockpit@0.4.0';
const CANDIDATES = 'Root/候选区';
const GOAL_NOTE = 'Root/每日Journal/目标树.md';
const POINTS_FOLDER = 'Root/每日Journal/积分账本';
const LEDGER_FOLDER = 'Root/每日Journal/番茄流水';
const DAY = '2026-08-09';

function memoryVault(seed = {}) {
  const files = new Map(Object.entries(seed));
  const writes = [];
  const removed = [];
  return {
    files,
    writes,
    removed,
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
      removed.push(path);
      return true;
    },
  };
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
    mirrorPointsIntoDayLedger: false,
    ...overrides,
  };
  const goals = new core.GoalStore({ io, generator: GENERATOR, settings: () => settings });
  const points = new core.PointsStore({
    io,
    generator: GENERATOR,
    settings: () => settings,
    dayLedgerPath: (day) => `${LEDGER_FOLDER}/${day}.json`,
  });
  const candidates = new core.CandidateStore({
    io,
    generator: GENERATOR,
    settings: () => settings,
    goals,
    points,
  });
  return { candidates, goals, points, io, settings };
}

/** S1（tools/news-inbox）落下来的那份长这样，逐字节照约定 v1 的例子写。 */
const DIGEST = `---
候选ID: 20260809-news-digest-L2
来源: news-inbox@0.1.0
生成时间: 2026-08-09T03:10:00+09:00
目标落点: Root/资讯/日报/2026-08-09.md
一句话说明: 8 月 9 日 42 条资讯的二次总结，聚成 3 个主题
状态: 待拍板
类型: news-digest
层级: 2
覆盖条目: 42
溯源:
  - Root/候选区/2026-08-09/资讯N次方总结-L1.md
裁决: []
---

## 主题一：模型价格战

- 又降价了 [原文](Root/资讯收件箱/2026-08-09/0808-linuxdo-tg-471228.md)
`;

function digestPath(day = DAY, name = '资讯N次方总结-L2.md') {
  return `${CANDIDATES}/${day}/${name}`;
}

function candidateNote({
  id = 'c-1',
  target = '',
  summary = '一句话',
  type = 'note',
  status = '待拍板',
  extra = '',
  body = '正文一行',
} = {}) {
  return `---
候选ID: ${id}
来源: agent:夜班
生成时间: 2026-08-09T03:10:00+09:00
目标落点: ${target === '' ? '""' : target}
一句话说明: ${summary}
状态: ${status}
类型: ${type}
${extra}裁决: []
---

${body}
`;
}

const AT = new Date('2026-08-10T09:12:00');

// ---------------------------------------------------------------------------
// 解析与序列化
// ---------------------------------------------------------------------------

test('读得懂 S1 落下来的候选项', () => {
  const candidate = core.parseCandidate(DIGEST);
  assert.strictEqual(candidate.id, '20260809-news-digest-L2');
  assert.strictEqual(candidate.source, 'news-inbox@0.1.0');
  assert.strictEqual(candidate.generatedAt, '2026-08-09T03:10:00+09:00');
  assert.strictEqual(candidate.target, 'Root/资讯/日报/2026-08-09.md');
  assert.strictEqual(candidate.summary, '8 月 9 日 42 条资讯的二次总结，聚成 3 个主题');
  assert.strictEqual(candidate.status, '待拍板');
  assert.strictEqual(candidate.type, 'news-digest');
  assert.strictEqual(candidate.level, 2);
  assert.strictEqual(candidate.coverage, 42);
  assert.deepStrictEqual(candidate.trace, ['Root/候选区/2026-08-09/资讯N次方总结-L1.md']);
  assert.deepStrictEqual(candidate.decisions, []);
  assert.match(candidate.body, /^## 主题一：模型价格战/);
});

test('原样写回：读进来再写出去，和 S1 写的一个字节都不差', () => {
  assert.strictEqual(core.serializeCandidate(core.parseCandidate(DIGEST)), DIGEST);
});

test('连 frontmatter 都没有的裸 md 也是合法候选项', () => {
  const candidate = core.parseCandidate('随手粘的一段话\n\n第二行\n');
  assert.strictEqual(candidate.id, '');
  assert.strictEqual(candidate.status, '待拍板');
  assert.strictEqual(candidate.target, '');
  assert.strictEqual(candidate.body, '随手粘的一段话\n\n第二行');
});

test('约定之外的 frontmatter 键原样带着走，不替夜班删', () => {
  const text = candidateNote({ extra: '方向: 入账\n分值: 8\n心情: 好\n' });
  const candidate = core.parseCandidate(text);
  assert.strictEqual(candidate.extras['方向'], '入账');
  assert.strictEqual(candidate.extras['分值'], 8);
  assert.strictEqual(candidate.extras['心情'], '好');
  const written = core.serializeCandidate(candidate);
  assert.match(written, /^方向: 入账$/m);
  assert.match(written, /^分值: 8$/m);
  assert.match(written, /^心情: 好$/m);
});

test('已有的裁决读得回来，拍板是追加不是覆盖', () => {
  const text = `---
候选ID: c-9
来源: agent:夜班
生成时间: 2026-08-09T03:10:00+09:00
目标落点: ""
一句话说明: 旧的一条
状态: 已打回
裁决:
  - 动作: 打回
    时间: 2026-08-09T09:12:00+09:00
    操作者: 人
    理由: 主题二把两件不相干的事并到一起了
---

正文
`;
  const candidate = core.parseCandidate(text);
  assert.strictEqual(candidate.decisions.length, 1);
  assert.strictEqual(candidate.decisions[0].action, '打回');
  assert.strictEqual(candidate.decisions[0].reason, '主题二把两件不相干的事并到一起了');

  const next = core.rejectCandidate(candidate, { at: AT, actor: '人', reason: '还是不行' });
  assert.strictEqual(next.decisions.length, 2);
  assert.strictEqual(next.decisions[0].reason, '主题二把两件不相干的事并到一起了');
  assert.strictEqual(next.decisions[1].reason, '还是不行');
  assert.strictEqual(core.serializeCandidate(next), core.serializeCandidate(core.parseCandidate(core.serializeCandidate(next))));
});

// ---------------------------------------------------------------------------
// 扫候选区
// ---------------------------------------------------------------------------

test('扫候选区：按日期目录读，`_` 开头的工具区跳过', async () => {
  const { candidates } = makeStore({
    [digestPath()]: DIGEST,
    [digestPath('2026-08-10', '资讯N次方总结-L1.md')]: candidateNote({ id: 'c-2' }),
    [`${CANDIDATES}/_归档/2026-08-01/旧的.md`]: candidateNote({ id: 'c-old' }),
  });
  await candidates.load();
  assert.deepStrictEqual(
    candidates.files.map((file) => file.path),
    [digestPath('2026-08-10', '资讯N次方总结-L1.md'), digestPath()],
  );
  assert.strictEqual(candidates.hasFolder, true);
  assert.strictEqual(candidates.pending.length, 2);
});

test('候选区还没建起来时是空的，也不报错', async () => {
  const { candidates } = makeStore();
  await candidates.load();
  assert.strictEqual(candidates.files.length, 0);
  assert.strictEqual(candidates.hasFolder, false);
});

// ---------------------------------------------------------------------------
// 采纳
// ---------------------------------------------------------------------------

test('采纳：写进落点、原件带着裁决移进归档、原地不再留副本', async () => {
  const { candidates, io } = makeStore({ [digestPath()]: DIGEST });
  await candidates.load();

  const result = await candidates.adopt(digestPath(), { at: AT });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.landing, 'Root/资讯/日报/2026-08-09.md');
  assert.strictEqual(result.archived, `${CANDIDATES}/_归档/${DAY}/资讯N次方总结-L2.md`);

  // 落点里有正文，并且留了一行指回归档原件
  const landed = io.text('Root/资讯/日报/2026-08-09.md');
  assert.match(landed, /## 主题一：模型价格战/);
  assert.match(landed, /采纳自候选区 · `20260809-news-digest-L2`/);
  assert.match(landed, /\[归档\]\(Root\/候选区\/_归档\/2026-08-09\/资讯N次方总结-L2\.md\)/);

  // 原件没了，归档里有，且带着裁决
  assert.strictEqual(io.text(digestPath()), null);
  const archived = core.parseCandidate(io.text(result.archived));
  assert.strictEqual(archived.status, '已采纳');
  assert.strictEqual(archived.decisions.length, 1);
  assert.strictEqual(archived.decisions[0].action, '采纳');
  assert.strictEqual(archived.decisions[0].actor, '人');
  assert.strictEqual(archived.decisions[0].landing, 'Root/资讯/日报/2026-08-09.md');
  assert.match(archived.decisions[0].at, /^2026-08-10T09:12:00/);
  assert.match(io.text(result.archived), /^ {2}- 动作: 采纳$/m);
  assert.strictEqual(candidates.files.length, 0);
});

test('采纳：落点笔记已经有东西时是追加，不是覆盖', async () => {
  const { candidates, io } = makeStore({
    [digestPath()]: DIGEST,
    'Root/资讯/日报/2026-08-09.md': '# 8 月 9 日\n\n人自己先写的一段。\n',
  });
  await candidates.load();
  await candidates.adopt(digestPath(), { at: AT });

  const landed = io.text('Root/资讯/日报/2026-08-09.md');
  assert.match(landed, /人自己先写的一段。/);
  assert.match(landed, /## 主题一：模型价格战/);
});

test('采纳：没有落点的候选项只归档，不凭空造文件', async () => {
  const { candidates, io } = makeStore({
    [digestPath(DAY, '只给人看.md')]: candidateNote({ id: 'c-3', target: '' }),
  });
  await candidates.load();

  const result = await candidates.adopt(digestPath(DAY, '只给人看.md'), { at: AT });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.landing, '');
  assert.strictEqual(io.files.size, 1);
  const archived = core.parseCandidate(io.text(result.archived));
  assert.strictEqual(archived.decisions[0].landing, '');
});

test('采纳：视图里改过的落点盖过 frontmatter 写的那个', async () => {
  const { candidates, io } = makeStore({ [digestPath()]: DIGEST });
  await candidates.load();

  const result = await candidates.adopt(digestPath(), { at: AT, target: 'Root/资讯/周报.md' });
  assert.strictEqual(result.landing, 'Root/资讯/周报.md');
  assert.strictEqual(io.text('Root/资讯/日报/2026-08-09.md'), null);
  assert.match(io.text('Root/资讯/周报.md'), /## 主题一：模型价格战/);
});

test('采纳：同一条再落一次不会在落点里写出两份，归档也不覆盖旧的', async () => {
  const { candidates, io } = makeStore({ [digestPath()]: DIGEST });
  await candidates.load();
  const first = await candidates.adopt(digestPath(), { at: AT });

  // 夜班又出了一份同名同 ID 的产物
  io.files.set(digestPath(), DIGEST);
  await candidates.load();
  const second = await candidates.adopt(digestPath(), { at: AT });

  assert.strictEqual(second.ok, true);
  assert.notStrictEqual(second.archived, first.archived);
  assert.strictEqual(second.archived, `${CANDIDATES}/_归档/${DAY}/资讯N次方总结-L2-2.md`);
  assert.ok(io.text(first.archived), '第一份归档还在，没被盖掉');
  const landed = io.text('Root/资讯/日报/2026-08-09.md');
  assert.strictEqual(landed.match(/## 主题一：模型价格战/g).length, 1);
});

test('采纳到目标树：树上多一个节点，落点写成块引用', async () => {
  const { candidates, goals, io } = makeStore({
    [digestPath(DAY, '新目标.md')]: candidateNote({
      id: 'c-goal',
      type: 'goal-node',
      summary: '把资讯投喂口接上夜班',
      target: '',
      extra: '目标层级: okr\n截止: 2026-09-30\n',
    }),
  });
  await goals.load();
  await goals.writeSkeleton();
  await candidates.load();

  const result = await candidates.adopt(digestPath(DAY, '新目标.md'), { at: AT });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.landing, '[[目标树#^g-7]]');

  const node = goals.find('g-7');
  assert.strictEqual(node.title, '把资讯投喂口接上夜班');
  assert.strictEqual(node.level, 'okr');
  assert.strictEqual(node.due, '2026-09-30');
  assert.match(io.text(GOAL_NOTE), /\^g-7/);
});

test('采纳到目标树：落点指到某个节点就挂在它下面', async () => {
  const { candidates, goals } = makeStore({
    [digestPath(DAY, '新目标.md')]: candidateNote({
      id: 'c-goal',
      type: 'goal-node',
      summary: '写一篇 PRD',
      target: '[[目标树#^g-4]]',
    }),
  });
  await goals.load();
  await goals.writeSkeleton();
  await candidates.load();

  const result = await candidates.adopt(digestPath(DAY, '新目标.md'), { at: AT });
  assert.strictEqual(result.ok, true);
  const added = goals.find('g-7');
  assert.strictEqual(added.title, '写一篇 PRD');
  assert.strictEqual(goals.find('g-4').children.at(-1).id, 'g-7');
  // 没写目标层级就交给 GoalStore 按父节点定：OKR 底下是 KPI
  assert.strictEqual(added.level, 'kpi');
});

test('采纳到目标树：落点指到不存在的节点就不落地，原件一动不动', async () => {
  const path = digestPath(DAY, '新目标.md');
  const { candidates, goals, io } = makeStore({
    [path]: candidateNote({ id: 'c-goal', type: 'goal-node', target: 'goal:g-99' }),
  });
  await goals.load();
  await goals.writeSkeleton();
  await candidates.load();

  const result = await candidates.adopt(path, { at: AT });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /g-99/);
  assert.ok(io.text(path), '原件还在');
  assert.strictEqual(core.parseCandidate(io.text(path)).status, '待拍板');
  assert.strictEqual(io.text(`${CANDIDATES}/_归档/${DAY}/新目标.md`), null);
});

test('采纳成账本一笔：账上多一笔，挂在落点指的目标上', async () => {
  const { candidates, goals, points, io } = makeStore({
    [digestPath(DAY, '记一笔.md')]: candidateNote({
      id: 'c-ledger',
      type: 'ledger-entry',
      summary: '读完《卡片笔记法》',
      target: 'goal:g-4',
      extra: '方向: 入账\n分值: 6\n事由: 读完一本（观其大略）\n',
    }),
  });
  await goals.load();
  await goals.writeSkeleton();
  await points.load();
  await candidates.load();

  const result = await candidates.adopt(digestPath(DAY, '记一笔.md'), { at: AT });
  assert.strictEqual(result.ok, true);

  const entry = points.book.entries.at(-1);
  assert.strictEqual(entry.direction, 'earn');
  assert.strictEqual(entry.amount, 6);
  assert.strictEqual(entry.reason, '读完一本（观其大略）');
  assert.strictEqual(entry.taskId, 'goal:g-4');
  // 记在拍板那一刻，落点指得到具体是哪一笔
  assert.strictEqual(entry.day, '2026-08-10');
  assert.strictEqual(result.landing, `${POINTS_FOLDER}/2026-08.md#${entry.id}`);
  assert.match(io.text(`${POINTS_FOLDER}/2026-08.md`), /读完一本/);
});

test('采纳成账本一笔：缺方向或分值就不记，账目宁可不落也不猜', async () => {
  const path = digestPath(DAY, '记一笔.md');
  const { candidates, points, io } = makeStore({
    [path]: candidateNote({ id: 'c-ledger', type: 'ledger-entry', extra: '分值: 6\n' }),
  });
  await points.load();
  await candidates.load();

  const result = await candidates.adopt(path, { at: AT });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /方向/);
  assert.strictEqual(points.book.entries.length, 0);
  assert.ok(io.text(path), '原件还在');
});

// ---------------------------------------------------------------------------
// 打回
// ---------------------------------------------------------------------------

test('打回：理由落进裁决，文件留在原地等下一轮夜班读', async () => {
  const { candidates, io } = makeStore({ [digestPath()]: DIGEST });
  await candidates.load();

  const result = await candidates.reject(digestPath(), {
    at: AT,
    reason: '主题二把两件不相干的事并到一起了，下次分开',
  });
  assert.strictEqual(result.ok, true);

  const text = io.text(digestPath());
  assert.ok(text, '打回不归档：文件还在原地');
  assert.strictEqual(io.text(`${CANDIDATES}/_归档/${DAY}/资讯N次方总结-L2.md`), null);

  const candidate = core.parseCandidate(text);
  assert.strictEqual(candidate.status, '已打回');
  assert.strictEqual(candidate.decisions[0].action, '打回');
  assert.strictEqual(candidate.decisions[0].actor, '人');
  assert.strictEqual(candidate.decisions[0].reason, '主题二把两件不相干的事并到一起了，下次分开');
  // 正文没被动过
  assert.match(candidate.body, /## 主题一：模型价格战/);
});

test('打回：重读之后理由还在，最近的打回理由能一把捞出来', async () => {
  const { candidates, io } = makeStore({ [digestPath()]: DIGEST });
  await candidates.load();
  await candidates.reject(digestPath(), { at: AT, reason: '并得太粗' });

  const reread = new core.CandidateStore({
    io,
    generator: GENERATOR,
    settings: () => ({ ...core.DEFAULT_SETTINGS, candidatesFolder: CANDIDATES }),
  });
  await reread.load();
  const recent = reread.recentRejections();
  assert.strictEqual(recent.length, 1);
  assert.strictEqual(recent[0].decision.reason, '并得太粗');
  assert.strictEqual(recent[0].file.path, digestPath());
});

test('打回：不写理由就打不回去', async () => {
  const { candidates, io } = makeStore({ [digestPath()]: DIGEST });
  await candidates.load();

  const result = await candidates.reject(digestPath(), { at: AT, reason: '   ' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(io.text(digestPath()), DIGEST);
});

// ---------------------------------------------------------------------------
// 改写
// ---------------------------------------------------------------------------

test('改写：新正文写回本文件，原正文进文末《原始产物》', async () => {
  const { candidates, io } = makeStore({ [digestPath()]: DIGEST });
  await candidates.load();

  const result = await candidates.rewrite(digestPath(), { at: AT, body: '## 主题一：降价\n\n- 就这一句\n' });
  assert.strictEqual(result.ok, true);

  const candidate = core.parseCandidate(io.text(digestPath()));
  assert.strictEqual(candidate.status, '已改写');
  assert.strictEqual(candidate.decisions[0].action, '改写');
  assert.match(candidate.body, /^## 主题一：降价/);
  assert.match(candidate.body, /## 原始产物/);
  assert.match(candidate.body, /### 改写前 · 2026-08-10T09:12:00/);
  assert.match(candidate.body, /## 主题一：模型价格战/);
});

test('改写：改第二遍不会把第一遍的原文冲掉', async () => {
  const { candidates, io } = makeStore({ [digestPath()]: DIGEST });
  await candidates.load();

  await candidates.rewrite(digestPath(), { at: AT, body: '第一次改写' });
  await candidates.rewrite(digestPath(), {
    at: new Date('2026-08-11T10:00:00'),
    body: '第二次改写',
  });

  const candidate = core.parseCandidate(io.text(digestPath()));
  assert.match(candidate.body, /^第二次改写/);
  assert.strictEqual(candidate.body.match(/## 原始产物/g).length, 1, '原始产物只有一节');
  assert.match(candidate.body, /### 改写前 · 2026-08-10T09:12:00/);
  assert.match(candidate.body, /### 改写前 · 2026-08-11T10:00:00/);
  assert.match(candidate.body, /## 主题一：模型价格战/);
  assert.match(candidate.body, /第一次改写/);
  assert.strictEqual(candidate.decisions.length, 2);
});

test('改写过的还在待拍板列表里——改写不是终局，改完还得采纳或打回', async () => {
  const { candidates, io } = makeStore({ [digestPath()]: DIGEST });
  await candidates.load();
  await candidates.rewrite(digestPath(), { at: AT, body: '改过的正文' });

  assert.strictEqual(candidates.pending.length, 1);
  const adopted = await candidates.adopt(digestPath(), { at: AT });
  assert.strictEqual(adopted.ok, true);
  assert.strictEqual(candidates.pending.length, 0);

  // 改写那一笔和采纳那一笔都留在归档件里
  const archived = core.parseCandidate(io.text(adopted.archived));
  assert.strictEqual(archived.status, '已采纳');
  assert.deepStrictEqual(archived.decisions.map((item) => item.action), ['改写', '采纳']);
  assert.match(archived.body, /## 原始产物/);

  // 进主干的只有改写后的正文：《原始产物》是候选项里的历史，不该跟着落进主干
  const landed = io.text('Root/资讯/日报/2026-08-09.md');
  assert.match(landed, /改过的正文/);
  assert.doesNotMatch(landed, /## 原始产物/);
  assert.doesNotMatch(landed, /## 主题一：模型价格战/);
});

test('改写：正文改成空的会被挡住', async () => {
  const { candidates, io } = makeStore({ [digestPath()]: DIGEST });
  await candidates.load();

  const result = await candidates.rewrite(digestPath(), { at: AT, body: '  \n ' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(io.text(digestPath()), DIGEST);
});

// ---------------------------------------------------------------------------
// 写盘幂等 / 兜底
// ---------------------------------------------------------------------------

test('拍板动作只落一次盘，同样的内容不重复写', async () => {
  const { candidates, io } = makeStore({ [digestPath()]: DIGEST });
  await candidates.load();
  io.writes.length = 0;

  await candidates.reject(digestPath(), { at: AT, reason: '再改改' });
  assert.deepStrictEqual(io.writes, [digestPath()]);

  const written = io.text(digestPath());
  assert.strictEqual(await io.writeIfChanged(digestPath(), written), false);
});

test('已经被拍过的那条再点一次，只会告诉你它不在了', async () => {
  const { candidates } = makeStore({ [digestPath()]: DIGEST });
  await candidates.load();
  await candidates.adopt(digestPath(), { at: AT });

  const again = await candidates.adopt(digestPath(), { at: AT });
  assert.strictEqual(again.ok, false);
  assert.match(again.message, /重读/);
});
