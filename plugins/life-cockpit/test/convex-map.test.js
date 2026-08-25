const test = require("node:test");
const assert = require("node:assert");
const {
  toConvexSession,
  toConvexLedgerEntry,
  toConvexGoalNodes,
  fingerprint,
} = require("./.build/core.js");

// 这一组守的是**字段对不对得上后端**。上一版的教训是：上行链路整条没接，
// 而且不通的时候一声不吭——所以映射这一层宁可测得啰嗦一点。

const session = (over = {}) => ({
  id: "work-1-1787099476086",
  kind: "work",
  startedAt: "2026-08-19T08:31:16+08:00",
  endedAt: "2026-08-19T08:56:16+08:00",
  plannedSeconds: 1500,
  actualSeconds: 1500,
  completed: true,
  task: "完成一个番茄",
  mode: "thinking-first",
  pomodoroIndex: 1,
  phase: "水三",
  segment: "早起",
  points: 2,
  pointsRule: "goal:g-6",
  goalId: "g-6",
  ...over,
});

test("番茄流水：字段一一对上，day 由外面带进来", () => {
  const out = toConvexSession(session(), "2026-08-19", "life-cockpit@0.14.0");
  assert.strictEqual(out.sessionId, "work-1-1787099476086");
  assert.strictEqual(out.day, "2026-08-19");
  assert.strictEqual(out.kind, "work");
  assert.strictEqual(out.actualSeconds, 1500);
  assert.strictEqual(out.completed, true);
  assert.strictEqual(out.goalId, "g-6");
  assert.strictEqual(out.generator, "life-cockpit@0.14.0");
});

test("番茄流水：跑着的那一段 endedAt 是空串，要变成 null", () => {
  // 后端 validator 只认 string | null，空串会被当成合法字符串存进去，
  // 于是「还没结束」和「结束于空字符串」就分不出来了
  const out = toConvexSession(session({ endedAt: "" }), "2026-08-19", "g");
  assert.strictEqual(out.endedAt, null);
});

test("番茄流水：长休息这种 kind 也要过", () => {
  // 0.12.0 那一版漏了 long-break，是靠真实数据撞出来的
  assert.strictEqual(toConvexSession(session({ kind: "long-break" }), "d", "g").kind, "long-break");
  assert.strictEqual(toConvexSession(session({ kind: "break" }), "d", "g").kind, "break");
});

test("番茄流水：可空字段一律落 null，不落 undefined", () => {
  const out = toConvexSession(
    session({ phase: null, segment: null, points: null, pointsRule: null, goalId: undefined }),
    "2026-08-19",
    "g",
  );
  for (const key of ["phase", "segment", "points", "pointsRule", "goalId"]) {
    assert.strictEqual(out[key], null, `${key} 应当是 null`);
  }
});

// ---------------------------------------------------------------------------

const entry = (over = {}) => ({
  id: "20260810-1153-82yqdm",
  at: "2026-08-10T11:53",
  day: "2026-08-10",
  direction: "earn",
  amount: 2,
  reason: "完成番茄：完成一个番茄",
  source: "pomodoro",
  taskId: "goal:g-6",
  ref: "work-1-1786332465945",
  ...over,
});

test("积分：方向从 earn/spend 换成 +/-", () => {
  assert.strictEqual(toConvexLedgerEntry(entry(), new Set()).direction, "+");
  assert.strictEqual(
    toConvexLedgerEntry(entry({ direction: "spend" }), new Set()).direction,
    "-",
  );
});

test("积分：来源翻成账本上那几个中文词", () => {
  assert.strictEqual(toConvexLedgerEntry(entry(), new Set()).source, "番茄");
  assert.strictEqual(toConvexLedgerEntry(entry({ source: "manual" }), new Set()).source, "手动");
  assert.strictEqual(toConvexLedgerEntry(entry({ source: "reversal" }), new Set()).source, "撤销");
});

test("积分：撤销状态和月账 Markdown 那一处是同一套判定", () => {
  // 三种状态各测一遍——两处各写一套的下场是「账本显示已撤销、库里显示有效」，
  // 而那种不一致只会在某天对不上账时才发现
  assert.strictEqual(toConvexLedgerEntry(entry(), new Set()).status, "有效");
  assert.strictEqual(
    toConvexLedgerEntry(entry(), new Set(["20260810-1153-82yqdm"])).status,
    "已撤销",
  );
  assert.strictEqual(
    toConvexLedgerEntry(entry({ source: "reversal" }), new Set()).status,
    "撤销",
  );
});

test("积分：撤销单本身即使也在 voided 里，仍然算「撤销」不算「已撤销」", () => {
  assert.strictEqual(
    toConvexLedgerEntry(entry({ source: "reversal" }), new Set(["20260810-1153-82yqdm"])).status,
    "撤销",
  );
});

test("积分：没挂任务的一笔落 null，不落空串", () => {
  assert.strictEqual(toConvexLedgerEntry(entry({ taskId: null }), new Set()).task, null);
  assert.strictEqual(toConvexLedgerEntry(entry({ ref: null }), new Set()).relatedId, null);
});

// ---------------------------------------------------------------------------

const goal = (id, over = {}) => ({
  id,
  level: "daily",
  title: `目标 ${id}`,
  status: "planned",
  manualProgress: null,
  metric: null,
  weight: 1,
  due: null,
  kind: null,
  feishuMatch: "",
  extras: [],
  children: [],
  ...over,
});

test("目标树：摊平成 parentId + depth + order，父节点不存子 id 数组", () => {
  const tree = {
    roots: [
      goal("g-1", {
        children: [goal("g-2", { children: [goal("g-3")] }), goal("g-4")],
      }),
    ],
  };
  const nodes = toConvexGoalNodes(tree);
  assert.deepStrictEqual(nodes.map((n) => n.goalId), ["g-1", "g-2", "g-3", "g-4"]);
  assert.deepStrictEqual(nodes.map((n) => n.parentId), [null, "g-1", "g-2", "g-1"]);
  assert.deepStrictEqual(nodes.map((n) => n.depth), [0, 1, 2, 1]);
  assert.deepStrictEqual(nodes.map((n) => n.order), [0, 1, 2, 3]);
  // 没有任何一条带着 children——那正是「父节点不存子 id 数组」的意思
  for (const n of nodes) assert.strictEqual("children" in n, false);
});

test("目标树：四种记号都映射得上", () => {
  const tree = {
    roots: [
      goal("g-1", { status: "planned" }),
      goal("g-2", { status: "active" }),
      goal("g-3", { status: "done" }),
      goal("g-4", { status: "dropped" }),
    ],
  };
  assert.deepStrictEqual(
    toConvexGoalNodes(tree).map((n) => n.mark),
    ["todo", "doing", "done", "abandoned"],
  );
});

test("目标树：认不出来的状态退回 todo，不抛", () => {
  const tree = { roots: [goal("g-1", { status: "乱写的" })] };
  assert.strictEqual(toConvexGoalNodes(tree)[0].mark, "todo");
});

test("目标树：度量落成一行字，进度一个字都不传", () => {
  const tree = {
    roots: [goal("g-1", { metric: { current: 3, target: 10, unit: "篇" } })],
  };
  const n = toConvexGoalNodes(tree)[0];
  assert.strictEqual(n.metric, "3/10 篇");
  // 进度在后端按权重现算——传上去就有两个真相了
  assert.strictEqual("progress" in n, false);
});

test("目标树：飞书关键词留空时落 null", () => {
  assert.strictEqual(toConvexGoalNodes({ roots: [goal("g-1")] })[0].feishuKeyword, null);
  assert.strictEqual(
    toConvexGoalNodes({ roots: [goal("g-1", { feishuMatch: "PRD、设计" })] })[0].feishuKeyword,
    "PRD、设计",
  );
});

test("目标树：空树不炸", () => {
  assert.deepStrictEqual(toConvexGoalNodes({ roots: [] }), []);
  assert.deepStrictEqual(toConvexGoalNodes({}), []);
});

// ---------------------------------------------------------------------------

test("指纹：同样的内容给同样的值，不同的内容给不同的值", () => {
  assert.strictEqual(fingerprint({ a: 1 }), fingerprint({ a: 1 }));
  assert.notStrictEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }));
  assert.notStrictEqual(fingerprint({ a: 1 }), fingerprint({ b: 1 }));
});

test("指纹：能认出真实载荷里的细微变化——这才是「变了要重推」成立的前提", () => {
  const base = toConvexSession(session(), "2026-08-19", "g");
  assert.strictEqual(fingerprint(base), fingerprint(toConvexSession(session(), "2026-08-19", "g")));
  // 秒数变一秒也要认出来，否则跑着的那一段永远不会被重推
  assert.notStrictEqual(
    fingerprint(base),
    fingerprint(toConvexSession(session({ actualSeconds: 1501 }), "2026-08-19", "g")),
  );
  // 完成状态翻转必须认出来
  assert.notStrictEqual(
    fingerprint(base),
    fingerprint(toConvexSession(session({ completed: false }), "2026-08-19", "g")),
  );
});
