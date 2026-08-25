const test = require("node:test");
const assert = require("node:assert");
const {
  emptyOutbox,
  enqueue,
  nextBatch,
  ackBatch,
  nackBatch,
  backoffMs,
  describe: describeOutbox,
  MAX_ITEMS,
} = require("./.build/core.js");

// 这一组守的是「番茄计时器绝不能因为没网就停表」那条约束的具体落点。
// 断网、离线三天、推一半失败——这几种情况在真机上很难制造，所以必须在这儿钉死。

const item = (key, kind = "session", at = 1000) => ({
  key,
  kind,
  payload: JSON.stringify({ key }),
  at,
});

test("入队：同一个自然键只留最新的一条", () => {
  let s = emptyOutbox();
  s = enqueue(s, item("work-1", "session", 1000));
  s = enqueue(s, { ...item("work-1", "session", 2000), payload: '{"v":2}' });
  assert.strictEqual(s.items.length, 1);
  assert.strictEqual(s.items[0].payload, '{"v":2}');
  assert.strictEqual(s.items[0].at, 2000);
});

test("取一批：按种类分组，不混着推", () => {
  let s = emptyOutbox();
  s = enqueue(s, item("work-1", "session"));
  s = enqueue(s, item("led-1", "ledger"));
  s = enqueue(s, item("work-2", "session"));

  const batch = nextBatch(s);
  assert.strictEqual(batch.kind, "session");
  assert.deepStrictEqual(batch.items.map((i) => i.key), ["work-1", "work-2"]);
});

test("取一批：尊重上限", () => {
  let s = emptyOutbox();
  for (let i = 0; i < 300; i++) s = enqueue(s, item(`work-${i}`));
  assert.strictEqual(nextBatch(s).items.length, 200);
  assert.strictEqual(nextBatch(s, 50).items.length, 50);
});

test("空队列取不出东西", () => {
  assert.strictEqual(nextBatch(emptyOutbox()), null);
});

test("推成功就出队，并记下同步时刻", () => {
  let s = emptyOutbox();
  s = enqueue(s, item("a"));
  s = enqueue(s, item("b"));
  s = ackBatch(s, ["a"], 5000);
  assert.deepStrictEqual(s.items.map((i) => i.key), ["b"]);
  assert.strictEqual(s.lastSyncedAt, 5000);
  assert.strictEqual(s.lastError, null);
});

test("推失败不丢数据，只加一次尝试", () => {
  let s = emptyOutbox();
  s = enqueue(s, item("a"));
  s = enqueue(s, item("b"));
  s = nackBatch(s, ["a", "b"], "网络不通");

  assert.strictEqual(s.items.length, 2, "一条都不许丢");
  assert.deepStrictEqual(s.items.map((i) => i.attempts), [1, 1]);
  assert.match(s.lastError, /网络不通/);
});

test("失败一百次也不丢——数据丢了补不回来，网络会被修好", () => {
  let s = emptyOutbox();
  s = enqueue(s, item("a"));
  for (let i = 0; i < 100; i++) s = nackBatch(s, ["a"], "还是不通");
  assert.strictEqual(s.items.length, 1);
  assert.strictEqual(s.items[0].attempts, 100);
});

test("离线太久：超过上限丢最老的，而且要说出来", () => {
  let s = emptyOutbox();
  for (let i = 0; i < MAX_ITEMS + 5; i++) s = enqueue(s, item(`k-${i}`, "session", i));
  assert.strictEqual(s.items.length, MAX_ITEMS);
  assert.strictEqual(s.items[0].key, "k-5", "丢的是最老的那几条");
  assert.match(s.lastError, /队列满了/);
});

test("退避：没失败过就立刻推，失败了翻倍，封顶 15 分钟", () => {
  let s = emptyOutbox();
  s = enqueue(s, item("a"));
  assert.strictEqual(backoffMs(s), 0);

  s = nackBatch(s, ["a"], "x");
  assert.strictEqual(backoffMs(s), 60_000);
  s = nackBatch(s, ["a"], "x");
  assert.strictEqual(backoffMs(s), 120_000);
  for (let i = 0; i < 20; i++) s = nackBatch(s, ["a"], "x");
  assert.strictEqual(backoffMs(s), 15 * 60_000);
});

test("空队列的退避是 0，不是封顶值", () => {
  assert.strictEqual(backoffMs(emptyOutbox()), 0);
});

test("状态那一行：一切正常也要说出来", () => {
  const fresh = emptyOutbox();
  assert.match(describeOutbox(fresh, 10_000), /还没同步过/);

  const synced = ackBatch(enqueue(fresh, item("a")), ["a"], 10_000);
  assert.match(describeOutbox(synced, 10_000), /刚刚同步过/);
  assert.match(describeOutbox(synced, 10_000 + 5 * 60_000), /5 分钟前同步过/);

  let backed = enqueue(fresh, item("a", "session", 0));
  backed = nackBatch(backed, ["a"], "没网");
  const line = describeOutbox(backed, 3 * 60_000);
  assert.match(line, /攒着 1 条/);
  assert.match(line, /没网/);
});

test("从 data.json 读回来：读不动就当空的，不抛", () => {
  const { normalizeOutbox } = require("./.build/core.js");
  assert.deepStrictEqual(normalizeOutbox(null), emptyOutbox());
  assert.deepStrictEqual(normalizeOutbox("坏了"), emptyOutbox());
  assert.deepStrictEqual(normalizeOutbox({}), emptyOutbox());
  assert.deepStrictEqual(normalizeOutbox({ items: "不是数组" }), emptyOutbox());
});

test("从 data.json 读回来：坏掉的条目跳过，好的留着", () => {
  const { normalizeOutbox } = require("./.build/core.js");
  const s = normalizeOutbox({
    items: [
      { key: "ok", kind: "session", payload: "{}", at: 5, attempts: 2 },
      { key: "", kind: "session", payload: "{}" },          // 没有 key
      { key: "x", kind: "不认识", payload: "{}" },            // 种类不认识
      { key: "y", kind: "ledger", payload: 123 },            // 载荷不是字符串
      null,
      { key: "z", kind: "goals", payload: "{}" },            // 缺 at/attempts，补默认
    ],
    lastSyncedAt: 99,
    lastError: "上次没通",
  });
  assert.deepStrictEqual(s.items.map((i) => i.key), ["ok", "z"]);
  assert.strictEqual(s.items[0].attempts, 2);
  assert.strictEqual(s.items[1].at, 0);
  assert.strictEqual(s.items[1].attempts, 0);
  assert.strictEqual(s.lastSyncedAt, 99);
  assert.strictEqual(s.lastError, "上次没通");
});

test("从 data.json 读回来：超长的队列截到上限", () => {
  const { normalizeOutbox } = require("./.build/core.js");
  const items = [];
  for (let i = 0; i < MAX_ITEMS + 50; i++) {
    items.push({ key: `k-${i}`, kind: "session", payload: "{}", at: i, attempts: 0 });
  }
  const s = normalizeOutbox({ items, lastSyncedAt: 0, lastError: null });
  assert.strictEqual(s.items.length, MAX_ITEMS);
  assert.strictEqual(s.items[s.items.length - 1].key, `k-${MAX_ITEMS + 49}`, "留的是最新的");
});
