'use strict';

// 秒哒「5 分钟写作」拉取层（AME-272 第 26 条）。
//
// 这里断言的是三件真会出事的事：
//   1. **分桶按「开始写」那一刻**——远端做过一次批量迁移，拿 updated_at 分桶会把
//      七月的记录整片扔进八月；
//   2. **重复拉不写盘**——落点在 2A-META 仓库里，假写入 = 给 Easy-Git 造空 commit；
//   3. **搬走的不补写**——他明说了会手动把内容整理去飞书，落地区必须是可以清空的。
//
// 造数据一律照实测出来的真实行状（15 个字段、UTC 时间戳、空正文那 27 条也在内）。

const test = require('node:test');
const assert = require('node:assert');
const core = require('./.build/core.js');

/** 本地时间 → 远端那种 UTC ISO。这样断言不依赖跑测试的机器在哪个时区。 */
function utc(year, month, day, hour, minute) {
  return new Date(year, month - 1, day, hour, minute, 0).toISOString();
}

function row(patch = {}) {
  return {
    id: 'b3195eed-c282-4002-8219-66bfe4810d86',
    title: '这个游泳啊 今天发现',
    content: '这个游泳啊\n\n今天发现\n\n前期，在适应  果冻、胶体',
    mode: 'quick',
    status: 'interrupted',
    countdown_seconds: 12,
    char_count: 287,
    started_at: utc(2026, 8, 20, 11, 56),
    updated_at: utc(2026, 8, 21, 16, 47),
    ended_at: utc(2026, 8, 20, 12, 0),
    copied_to_clipboard: true,
    shared_count: 0,
    last_save_reason: 'manual_end_copy',
    created_at: utc(2026, 8, 20, 11, 56),
    target_achieved: false,
    ...patch,
  };
}

function sessionOf(patch = {}) {
  return core.normalizeMiaodaSession(row(patch));
}

const OPTIONS = { rolloverHour: 4, includeEmpty: false };
const RENDER = { rolloverHour: 4 };

// ---------------------------------------------------------------------------
// 读远端
// ---------------------------------------------------------------------------

test('照实测的行状读，15 个字段一个不丢', () => {
  const sessions = core.parseMiaodaRows(JSON.stringify([row()]));
  assert.ok(sessions);
  assert.strictEqual(sessions.length, 1);
  const one = sessions[0];
  assert.strictEqual(one.id, 'b3195eed-c282-4002-8219-66bfe4810d86');
  assert.strictEqual(one.mode, 'quick');
  assert.strictEqual(one.countdownSeconds, 12);
  assert.strictEqual(one.charCount, 287);
  assert.strictEqual(one.copiedToClipboard, true);
  assert.strictEqual(one.lastSaveReason, 'manual_end_copy');
});

test('PostgREST 报错时返回的是对象不是数组，那不叫「零条」', () => {
  assert.strictEqual(core.parseMiaodaRows('{"message":"JWT expired","code":"PGRST301"}'), null);
  assert.strictEqual(core.parseMiaodaRows('这不是 JSON'), null);
  assert.deepStrictEqual(core.parseMiaodaRows('[]'), []);
});

test('远端加了没见过的 mode / status，原样显示，不吞成空白', () => {
  assert.strictEqual(core.miaodaModeLabel('voice'), '语音');
  assert.strictEqual(core.miaodaStatusLabel('failed_saved'), '没撑住（内容仍存下来了）');
  assert.strictEqual(core.miaodaModeLabel('handwriting'), 'handwriting');
  assert.strictEqual(core.miaodaSaveReasonLabel('brand_new_reason'), 'brand_new_reason');
});

test('char_count 缺了就现数一遍，不在面板上留个 0', () => {
  const one = core.normalizeMiaodaSession({ id: 'x', content: '一二三四五', char_count: null });
  assert.strictEqual(one.charCount, 5);
});

// ---------------------------------------------------------------------------
// 分桶
// ---------------------------------------------------------------------------

test('按「开始写」那一刻分桶，不按 updated_at——批量迁移过的记录不许整片挪窝', () => {
  // 实测就是这样：8-20 写的那一批，updated_at 全被推到了 8-21。
  const one = sessionOf({ started_at: utc(2026, 8, 20, 11, 56), updated_at: utc(2026, 8, 21, 16, 47) });
  assert.strictEqual(core.miaodaDayOf(one, 4), '2026-08-20');
});

test('换日点跟着账本日走：凌晨 2 点写的算前一天', () => {
  const late = sessionOf({ started_at: utc(2026, 8, 21, 2, 30) });
  assert.strictEqual(core.miaodaDayOf(late, 4), '2026-08-20');
  assert.strictEqual(core.miaodaDayOf(late, 0), '2026-08-21');
});

test('时间戳坏掉的那一条不猜日期，单独报数', () => {
  const broken = sessionOf({ id: 'broken', started_at: '', created_at: '' });
  assert.strictEqual(core.miaodaDayOf(broken, 4), '');
  const plan = core.planMiaodaSync([broken], core.createMiaodaIndex('t'), OPTIONS);
  assert.strictEqual(plan.skippedUndated, 1);
  assert.strictEqual(plan.byDay.length, 0);
});

// ---------------------------------------------------------------------------
// 拉回来之后怎么落
// ---------------------------------------------------------------------------

test('空白记录默认不落盘，但要报数——不能让人以为丢了', () => {
  const sessions = [sessionOf(), sessionOf({ id: 'empty-1', content: '', title: '', char_count: 0 })];
  const skipped = core.planMiaodaSync(sessions, core.createMiaodaIndex('t'), OPTIONS);
  assert.strictEqual(skipped.skippedEmpty, 1);
  assert.strictEqual(skipped.byDay[0].items.length, 1);

  const kept = core.planMiaodaSync(sessions, core.createMiaodaIndex('t'), {
    ...OPTIONS,
    includeEmpty: true,
  });
  assert.strictEqual(kept.skippedEmpty, 0);
  assert.strictEqual(kept.byDay[0].items.length, 2);
});

test('跳过的空白记录不进索引，所以开关一打开还补得回来', () => {
  const empty = sessionOf({ id: 'empty-1', content: '', char_count: 0 });
  const index = core.createMiaodaIndex('t');
  const plan = core.planMiaodaSync([empty], index, OPTIONS);
  assert.strictEqual(plan.skippedEmpty, 1);
  assert.strictEqual(Object.keys(index.sessions).length, 0);
});

test('天内按开始时间升序，天与天之间也按日期升序', () => {
  const sessions = [
    sessionOf({ id: 'c', started_at: utc(2026, 8, 21, 9, 0) }),
    sessionOf({ id: 'a', started_at: utc(2026, 8, 20, 20, 0) }),
    sessionOf({ id: 'b', started_at: utc(2026, 8, 20, 8, 0) }),
  ];
  const plan = core.planMiaodaSync(sessions, core.createMiaodaIndex('t'), OPTIONS);
  assert.deepStrictEqual(plan.byDay.map((bucket) => bucket.day), ['2026-08-20', '2026-08-21']);
  assert.deepStrictEqual(plan.byDay[0].items.map((item) => item.session.id), ['b', 'a']);
});

// ---------------------------------------------------------------------------
// 一天一页的 Markdown
// ---------------------------------------------------------------------------

test('一段写作一个大标题，正文一个字不改', () => {
  const text = core.renderMiaodaSection(sessionOf({ mode: 'voice' }));
  assert.match(text, /^## \d{2}:\d{2} · 语音 · /);
  assert.match(text, /- 秒哒ID：`b3195eed-c282-4002-8219-66bfe4810d86`/);
  assert.ok(text.includes('这个游泳啊\n\n今天发现\n\n前期，在适应  果冻、胶体'));
});

test('那个「不写就擦」的机制要写在段落上：倒计时几秒、这一段有没有撑住', () => {
  const text = core.renderMiaodaSection(
    sessionOf({ status: 'failed_saved', last_save_reason: 'countdown_failed', countdown_seconds: 5 }),
  );
  assert.ok(text.includes('擦除倒计时 5 秒'));
  assert.ok(text.includes('没撑住（内容仍存下来了）'));
  assert.ok(text.includes('保存于「倒计时归零」'));
});

test('页首不带「拉取于」这类每次都变的东西，否则每拉一次都是一次假写入', () => {
  const preamble = core.renderMiaodaPreamble('2026-08-20', RENDER);
  assert.strictEqual(preamble, core.renderMiaodaPreamble('2026-08-20', RENDER));
  assert.ok(!/\d{2}:\d{2}:\d{2}/.test(preamble));
});

test('段落的边界是「后面跟着秒哒ID 的大标题」，正文里的 ## 不会把一段劈成两半', () => {
  const tricky = sessionOf({ content: '想到一个标题：\n\n## 这行是正文，不是新段落\n\n后面还有。' });
  const page = core.mergeMiaodaDay('2026-08-20', null, [
    { session: tricky, change: 'new', day: '2026-08-20', previousDay: '' },
  ], RENDER);
  const parsed = core.parseMiaodaDay(page.text);
  assert.strictEqual(parsed.sections.length, 1);
  assert.ok(parsed.sections[0].text.includes('## 这行是正文，不是新段落'));
});

// ---------------------------------------------------------------------------
// 幂等与「不打架」
// ---------------------------------------------------------------------------

function items(sessions, change = 'new', day = '2026-08-20') {
  return sessions.map((session) => ({ session, change, day, previousDay: '' }));
}

test('同一批并两次，第二次一个字节都不变', () => {
  const batch = items([sessionOf({ id: 'a' }), sessionOf({ id: 'b', started_at: utc(2026, 8, 20, 15, 0) })]);
  const first = core.mergeMiaodaDay('2026-08-20', null, batch, RENDER);
  const second = core.mergeMiaodaDay('2026-08-20', first.text, batch, RENDER);
  assert.strictEqual(second.text, first.text);
  assert.strictEqual(second.added, 0);
  assert.strictEqual(second.updated, 0);
});

test('新的一段追加在末尾，已有的那几段原地不动', () => {
  const first = core.mergeMiaodaDay('2026-08-20', null, items([sessionOf({ id: 'a' })]), RENDER);
  const second = core.mergeMiaodaDay(
    '2026-08-20',
    first.text,
    items([sessionOf({ id: 'b', started_at: utc(2026, 8, 20, 18, 0) })]),
    RENDER,
  );
  assert.strictEqual(second.added, 1);
  assert.ok(second.text.startsWith(first.text.trimEnd()));
  assert.deepStrictEqual(core.parseMiaodaDay(second.text).sections.map((s) => s.id), ['a', 'b']);
});

test('远端又动过的那一段原地换掉，不追加第二份', () => {
  const before = core.mergeMiaodaDay('2026-08-20', null, items([sessionOf({ id: 'a' })]), RENDER);
  const after = core.mergeMiaodaDay(
    '2026-08-20',
    before.text,
    items([sessionOf({ id: 'a', content: '改过的正文' })], 'updated'),
    RENDER,
  );
  const sections = core.parseMiaodaDay(after.text).sections;
  assert.strictEqual(sections.length, 1);
  assert.strictEqual(after.updated, 1);
  assert.ok(after.text.includes('改过的正文'));
});

test('他搬走的那一段不补写——落地区必须是可以清空的', () => {
  const page = core.mergeMiaodaDay('2026-08-20', null, items([sessionOf({ id: 'a' })]), RENDER);
  // 人把这一段剪去飞书了，页面上只剩页首。
  const emptied = core.removeMiaodaSections(page.text, new Set(['a']));
  assert.strictEqual(emptied.removed, 1);
  assert.strictEqual(emptied.empty, true);

  const again = core.mergeMiaodaDay(
    '2026-08-20',
    '> 页首还在，段落被我搬走了。',
    items([sessionOf({ id: 'a', content: '远端又动了一下' })], 'updated'),
    RENDER,
  );
  assert.strictEqual(again.vanished, 1);
  assert.strictEqual(again.added, 0);
  assert.ok(!again.text.includes('远端又动了一下'));
});

test('他自己手写的段落一个字都不碰', () => {
  const mine = '> 页首\n\n## 我自己写的一段\n\n这一段没有秒哒ID，是我加的。';
  const merged = core.mergeMiaodaDay('2026-08-20', mine, items([sessionOf({ id: 'a' })]), RENDER);
  assert.ok(merged.text.includes('## 我自己写的一段'));
  assert.ok(merged.text.includes('这一段没有秒哒ID，是我加的。'));
  assert.strictEqual(merged.added, 1);
});

test('页首被人改过就照他改的留着', () => {
  const mine = '> 我把说明改成了自己的话。\n\n';
  const merged = core.mergeMiaodaDay('2026-08-20', mine, items([sessionOf({ id: 'a' })]), RENDER);
  assert.ok(merged.text.startsWith('> 我把说明改成了自己的话。'));
});

// ---------------------------------------------------------------------------
// 同步索引
// ---------------------------------------------------------------------------

test('索引序列化按 id 排序——顺序飘一下就是一次空 commit', () => {
  const index = core.createMiaodaIndex('life-cockpit@test');
  index.sessions.zzz = { day: '2026-08-20', updatedAt: 'u2' };
  index.sessions.aaa = { day: '2026-08-19', updatedAt: 'u1' };
  index.lastUpdatedAt = 'u2';
  const text = core.serializeMiaodaIndex(index);
  assert.ok(text.indexOf('"aaa"') < text.indexOf('"zzz"'));
  assert.strictEqual(core.serializeMiaodaIndex(core.parseMiaodaIndex(text, 'life-cockpit@test')), text);
});

test('索引读不动就当没有：大不了整份重拉一次，写盘幂等', () => {
  const index = core.parseMiaodaIndex('{ 坏掉的 JSON', 'life-cockpit@test');
  assert.strictEqual(index.lastUpdatedAt, '');
  assert.deepStrictEqual(index.sessions, {});
});

test('索引里一模一样的那几条一个字节都不用动', () => {
  const one = sessionOf({ id: 'a' });
  const index = core.createMiaodaIndex('t');
  index.sessions.a = { day: '2026-08-20', updatedAt: one.updatedAt };
  const plan = core.planMiaodaSync([one], index, OPTIONS);
  assert.strictEqual(plan.unchanged, 1);
  assert.strictEqual(plan.byDay.length, 0);
});

test('远端动过的那一条要重新落，并且认得出它是「更新」不是「新的」', () => {
  const one = sessionOf({ id: 'a', updated_at: utc(2026, 8, 22, 10, 0) });
  const index = core.createMiaodaIndex('t');
  index.sessions.a = { day: '2026-08-20', updatedAt: utc(2026, 8, 21, 16, 47) };
  const plan = core.planMiaodaSync([one], index, OPTIONS);
  assert.strictEqual(plan.byDay[0].items[0].change, 'updated');
  assert.strictEqual(plan.latestUpdatedAt, one.updatedAt);
});

test('换日点改了 → 那一段换天了，plan 记得住旧落点', () => {
  const late = sessionOf({ id: 'a', started_at: utc(2026, 8, 21, 2, 30) });
  const index = core.createMiaodaIndex('t');
  index.sessions.a = { day: '2026-08-20', updatedAt: late.updatedAt };
  const plan = core.planMiaodaSync([late], index, { rolloverHour: 0, includeEmpty: false });
  assert.strictEqual(plan.byDay[0].day, '2026-08-21');
  assert.strictEqual(plan.byDay[0].items[0].previousDay, '2026-08-20');
});

// ---------------------------------------------------------------------------
// 地址。测试用自己的假地址——**core 不再导出预置地址**（AME-315 审查 S2：
// 地址路径里嵌着秒哒项目 ID，公开仓库不预置它）。
// ---------------------------------------------------------------------------

const ENDPOINT = 'https://miaoda.example.com/rest/v1/writing_sessions';

test('预置地址不再进源码：core 没有这个导出，默认设置里也是空串', () => {
  assert.strictEqual(core.MIAODA_ENDPOINT, undefined);
  assert.strictEqual(core.DEFAULT_SETTINGS.miaodaEndpoint, '');
  // 空串是合法状态＝「还没配」，归一化不许拿别的值顶回来。
  assert.strictEqual(core.normalizeSettings({ miaodaEndpoint: '' }).miaodaEndpoint, '');
});

test('分页按 updated_at 升序——降序 + offset 在拉的过程中来新记录会漏条', () => {
  const url = core.miaodaPullUrl(ENDPOINT, { limit: 200, offset: 0 });
  assert.ok(url.includes('order=updated_at.asc'));
  assert.ok(url.includes('limit=200'));
  assert.ok(url.includes('offset=0'));
  assert.ok(!url.includes('updated_at=gte'));
});

test('增量靠 updated_at=gte，而不是把 limit 调大', () => {
  const url = core.miaodaPullUrl(ENDPOINT, {
    since: '2026-08-21T08:47:24.559027+00:00',
    limit: 200,
    offset: 400,
  });
  assert.ok(url.includes('updated_at=gte.2026-08-21T08%3A47%3A24.559027%2B00%3A00'));
  assert.ok(url.includes('offset=400'));
});

test('地址上原本带的查询串不参与拼接，免得拼出两个 select', () => {
  const url = core.miaodaPullUrl(`${ENDPOINT}?select=*&limit=200`, { limit: 50, offset: 0 });
  assert.strictEqual(url.split('select=').length - 1, 1);
  assert.ok(url.startsWith(`${ENDPOINT}?`));
});

// ---------------------------------------------------------------------------
// 报给人的那一行
// ---------------------------------------------------------------------------

test('什么都没变的时候说人话，不报一串 0', () => {
  assert.strictEqual(
    core.describeMiaodaReport({ added: 0, updated: 0, unchanged: 0, vanished: 0, skippedEmpty: 0, days: [] }),
    '秒哒：远端没有新东西。',
  );
});

test('搬走没补回去这件事要说出来', () => {
  const line = core.describeMiaodaReport({
    added: 2,
    updated: 1,
    unchanged: 180,
    vanished: 3,
    skippedEmpty: 27,
    days: ['2026-08-19', '2026-08-20'],
  });
  assert.ok(line.includes('新写 2 段'));
  assert.ok(line.includes('3 段你已经搬走了，没有补回去'));
  assert.ok(line.includes('跳过 27 条空白记录'));
});

test('存进 data.json 之前先洗一遍：脏的那一份一秒都不该存下来（AME-273 第 2 条）', () => {
  const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.K_11TLRso66ZGcd2Bng';
  assert.strictEqual(core.normalizeSettings({ miaodaApiKey: `${key}\n` }).miaodaApiKey, key);
  assert.strictEqual(core.normalizeSettings({ miaodaApiKey: `Bearer ${key}` }).miaodaApiKey, key);
  assert.strictEqual(core.normalizeSettings({ miaodaApiKey: 7 }).miaodaApiKey, '');
});
