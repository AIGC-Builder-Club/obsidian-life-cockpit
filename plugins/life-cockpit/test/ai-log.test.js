'use strict';

// AI 调用留痕（AME-258 第 22.1 条）。「看不到请求和返回」是这一层要解决的事，
// 所以这里断言的是三件：**密钥永远不进日志**、过期的那几天真的会被点名删掉、
// 长正文被裁的时候看得出来它被裁过。

const test = require('node:test');
const assert = require('node:assert');
const core = require('./.build/core.js');

function entry(patch = {}) {
  return {
    id: '20260818-153012-1',
    at: '2026-08-18T15:30:12.000Z',
    profile: 'OpenCode Go · DeepSeek v4 Flash',
    model: 'deepseek-v4-flash',
    purpose: '睡前复盘草稿',
    url: 'https://opencode.ai/zen/go/v1/chat/completions',
    ok: true,
    status: 200,
    durationMs: 4200,
    detail: 'deepseek-v4-flash · 用量 3200 tokens',
    promptTokens: 1200,
    completionTokens: 2000,
    totalTokens: 3200,
    request: '【user】今天跑了 6 个番茄',
    response: '{"body":"..."}',
    ...patch,
  };
}

// --- 密钥 -------------------------------------------------------------------

test('Authorization 整条不进日志——不是打码，是根本不写', () => {
  const headers = core.redactHeaders({
    'Content-Type': 'application/json',
    Authorization: 'Bearer sk-pKjMYbqqp0123456789',
  });
  assert.deepStrictEqual(headers, { 'Content-Type': 'application/json' });
  assert.ok(!JSON.stringify(headers).includes('sk-'));
});

test('别的花样的密钥头也一样摘掉', () => {
  const headers = core.redactHeaders({
    'x-api-key': 'sk-secret',
    'X-Api_Key': 'sk-secret',
    Accept: 'application/json',
  });
  assert.deepStrictEqual(headers, { Accept: 'application/json' });
});

// --- 保留几天 ---------------------------------------------------------------

test('留 7 天 = 今天连同前面 6 天，更早的点名删', () => {
  const days = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-17', '2026-08-18'];
  const expired = core.expiredAiLogDays(days, '2026-08-18', 7);
  assert.deepStrictEqual(expired, ['2026-08-10', '2026-08-11']);
});

test('留 1 天就只留今天', () => {
  const days = ['2026-08-17', '2026-08-18'];
  assert.deepStrictEqual(core.expiredAiLogDays(days, '2026-08-18', 1), ['2026-08-17']);
});

test('跨月倒数不会算错', () => {
  assert.strictEqual(core.shiftDay('2026-09-02', -6), '2026-08-27');
  assert.strictEqual(core.shiftDay('2026-03-01', -1), '2026-02-28');
});

// --- 攒与裁 -----------------------------------------------------------------

test('新的排最前面，超过上限丢最老的', () => {
  let list = [];
  for (let index = 0; index < 5; index += 1) {
    list = core.appendAiLogEntry(list, entry({ id: `e-${index}` }), 3);
  }
  assert.deepStrictEqual(
    list.map((item) => item.id),
    ['e-4', 'e-3', 'e-2'],
  );
});

test('长正文裁过之后，正文里看得出它被裁过', () => {
  const clipped = core.clipForLog('x'.repeat(1000), 200);
  assert.ok(clipped.startsWith('x'.repeat(200)));
  assert.ok(clipped.includes('裁掉了'));
});

test('没超长就一个字都不动', () => {
  assert.strictEqual(core.clipForLog('短的', 200), '短的');
});

test('messages 拼成人读得下去的样子，不是一坨转义 JSON', () => {
  const text = core.formatAiMessages([
    { role: 'system', content: '你是复盘助手' },
    { role: 'user', content: '今天跑了 6 个番茄' },
  ]);
  assert.ok(text.includes('【system】'));
  assert.ok(text.includes('今天跑了 6 个番茄'));
  assert.ok(!text.includes('\\n'));
});

// --- 读写 -------------------------------------------------------------------

test('写出去再读回来还是同一条', () => {
  const list = [entry()];
  const back = core.parseAiLog(core.serializeAiLog(list));
  assert.deepStrictEqual(back, list);
});

test('文件被人改坏了就当成没有记录，不炸', () => {
  assert.deepStrictEqual(core.parseAiLog('{ 半截'), []);
  assert.deepStrictEqual(core.parseAiLog(''), []);
});

test('缺字段的旧记录补齐而不是整份丢掉', () => {
  const [one] = core.parseAiLog(JSON.stringify([{ at: '2026-08-18T10:00:00.000Z' }]));
  assert.strictEqual(one.at, '2026-08-18T10:00:00.000Z');
  assert.strictEqual(one.ok, false);
  assert.strictEqual(one.status, null);
  assert.strictEqual(one.totalTokens, 0);
});

// --- 一行怎么写 -------------------------------------------------------------

test('一行先说成没成，再说花了多久', () => {
  assert.ok(core.describeAiLogEntry(entry()).startsWith('✓'));
  assert.ok(core.describeAiLogEntry(entry({ ok: false })).startsWith('✗'));
  assert.ok(core.describeAiLogEntry(entry()).includes('睡前复盘草稿'));
});

test('汇总把失败条数单独说出来——那才是打开这个开关的理由', () => {
  const line = core.summarizeAiLog([entry(), entry({ ok: false })]);
  assert.ok(line.includes('2 条'));
  assert.ok(line.includes('1 条没成'));
});

test('一条都没有的时候告诉人怎么才会有', () => {
  assert.ok(core.summarizeAiLog([]).includes('测一次连接'));
});
