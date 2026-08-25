'use strict';

// AI 接口层：档位表、凭据取值、请求拼装、响应解析。
//
// 网络那一段不在这里——`src/ai-client.ts` 才发请求，这一层只拼和只读，
// 所以整套判断都能在 node --test 里跑真的。

const test = require('node:test');
const assert = require('node:assert');
const core = require('./.build/core.js');

function profile(patch = {}) {
  return {
    id: 'p1',
    label: '测试档',
    baseUrl: 'https://example.test/v1',
    model: 'some-model',
    apiKey: '',
    apiKeyEnv: 'TEST_AI_KEY',
    temperature: null,
    maxTokens: 0,
    timeoutSeconds: 30,
    ...patch,
  };
}

function settings(patch = {}) {
  const profiles = patch.aiProfiles ?? [profile()];
  return {
    aiEnabled: true,
    aiActiveProfile: profiles[0] ? profiles[0].id : '',
    aiProfiles: profiles,
    aiReviewDraft: true,
    ...patch,
  };
}

// --- 仓库里不许留真实凭据 -----------------------------------------------------

test('预置档位一个都不带密钥', () => {
  for (const preset of core.AI_PRESETS) {
    assert.strictEqual(preset.apiKey, '', `${preset.id} 带着密钥进仓库了`);
  }
  for (const preset of core.DEFAULT_SETTINGS.aiProfiles) {
    assert.strictEqual(preset.apiKey, '');
  }
});

test('AI 接口默认关着', () => {
  // 要花钱、要密钥，两样都该由人明确点头。
  assert.strictEqual(core.DEFAULT_SETTINGS.aiEnabled, false);
});

test('预置的 OpenCode Go 档用的是端点自报的模型 id', () => {
  const preset = core.AI_PRESETS.find((item) => item.id === 'opencode-go-deepseek-v4-flash');
  assert.ok(preset);
  assert.strictEqual(preset.baseUrl, 'https://opencode.ai/zen/go/v1');
  // issue 里写的是「DeepSeek v4 0731 Flash」，端点上没有这个 id。
  assert.strictEqual(preset.model, 'deepseek-v4-flash');
});

// --- 凭据：设置项 → 环境变量，没有第三处 ---------------------------------------

test('密钥先看设置项，设置项空了才读环境变量', () => {
  assert.strictEqual(core.resolveAiKey(profile({ apiKey: 'from-settings' }), {}), 'from-settings');
  assert.strictEqual(core.resolveAiKey(profile(), { TEST_AI_KEY: 'from-env' }), 'from-env');
  assert.strictEqual(core.resolveAiKey(profile(), {}), '');
});

test('没写环境变量名的那一档只认设置项', () => {
  const only = profile({ apiKeyEnv: '' });
  assert.strictEqual(core.resolveAiKey(only, { TEST_AI_KEY: 'from-env' }), '');
});

// --- 状态：四种「不能用」要分得开 ----------------------------------------------

test('关掉、档位选串、缺地址、缺密钥各说各的', () => {
  assert.strictEqual(core.aiStatus(settings({ aiEnabled: false }), {}).state, 'disabled');

  const missing = core.aiStatus(settings({ aiActiveProfile: '不存在' }), {});
  assert.strictEqual(missing.state, 'missing-config');
  assert.match(missing.detail, /不在档位表里/);

  const noUrl = core.aiStatus(settings({ aiProfiles: [profile({ baseUrl: '' })] }), {});
  assert.strictEqual(noUrl.state, 'missing-config');
  assert.match(noUrl.detail, /base URL/);

  const noKey = core.aiStatus(settings(), {});
  assert.strictEqual(noKey.state, 'missing-config');
  assert.match(noKey.detail, /TEST_AI_KEY/);
});

test('地址、模型、密钥齐了才算 ready', () => {
  const status = core.aiStatus(settings(), { TEST_AI_KEY: 'k' });
  assert.strictEqual(status.state, 'ready');
  assert.strictEqual(status.profile.model, 'some-model');
});

// --- 请求拼装 ----------------------------------------------------------------

test('base URL 的三种写法拼出同一个地址', () => {
  const want = 'https://example.test/v1/chat/completions';
  assert.strictEqual(core.chatCompletionsUrl('https://example.test/v1'), want);
  assert.strictEqual(core.chatCompletionsUrl('https://example.test/v1/'), want);
  // 有人会把整条路径贴进 base URL——那是填错了，但不该拼成两遍。
  assert.strictEqual(core.chatCompletionsUrl(want), want);
});

test('请求体只放填了的那几项', () => {
  const bare = core.buildChatRequest(profile(), [{ role: 'user', content: 'hi' }], {
    apiKey: 'k',
  });
  assert.strictEqual(bare.body.stream, false);
  assert.strictEqual(bare.body.model, 'some-model');
  assert.ok(!('temperature' in bare.body), 'temperature 留 null 就不该出现在请求里');
  assert.ok(!('max_tokens' in bare.body), 'max_tokens 为 0 表示不限，不该出现');
  assert.strictEqual(bare.headers.Authorization, 'Bearer k');
  assert.strictEqual(bare.timeoutMs, 30_000);

  const full = core.buildChatRequest(
    profile({ temperature: 0.3, maxTokens: 1024 }),
    [{ role: 'user', content: 'hi' }],
    { apiKey: 'k', jsonOnly: true },
  );
  assert.strictEqual(full.body.temperature, 0.3);
  assert.strictEqual(full.body.max_tokens, 1024);
  assert.deepStrictEqual(full.body.response_format, { type: 'json_object' });
});

test('超时下限钉在 5 秒——0 秒是一颗定时炸弹', () => {
  const normalized = core.normalizeAiProfile({ timeoutSeconds: 0 }, 1);
  assert.ok(normalized.timeoutSeconds >= 5);
});

// --- 响应解析：失败要说清楚是哪一种失败 ------------------------------------------

test('正常响应取 content 与用量', () => {
  const reply = core.parseChatResponse(
    200,
    JSON.stringify({
      model: 'deepseek-v4-flash',
      choices: [{ message: { role: 'assistant', content: '收到' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 88, completion_tokens: 10, total_tokens: 98 },
    }),
  );
  assert.strictEqual(reply.ok, true);
  assert.strictEqual(reply.content, '收到');
  assert.strictEqual(reply.usage.totalTokens, 98);
  assert.match(reply.detail, /98 tokens/);
});

test('HTTP 错误带上服务端说的那句话', () => {
  const reply = core.parseChatResponse(
    401,
    JSON.stringify({ error: { type: 'invalid_api_key', message: 'bad key' } }),
  );
  assert.strictEqual(reply.ok, false);
  assert.match(reply.detail, /HTTP 401/);
  assert.match(reply.detail, /bad key/);
});

test('200 但正文为空要报错，不能当成模型说了空话', () => {
  const reply = core.parseChatResponse(
    200,
    JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
  );
  assert.strictEqual(reply.ok, false);
  assert.match(reply.detail, /length/);
  // finish_reason=length 要单独说清楚：推理模型的 reasoning 也吃 max_tokens，
  // 于是拿到的是一次「成功」的 200，里面什么都没有（AME-258 实测踩到过）。
  assert.match(reply.detail, /reasoning/);
  assert.match(reply.detail, /max_tokens/);
});

test('预置档位的 max_tokens 按最差的那一次给，不按均值给', () => {
  // 实测（2026-08-18，真实复盘 prompt）：4096 直接空正文；16384 大多数时候够，
  // 但踩到过一次全额吃光。reasoning 那一段的长度每次都不一样，卡着均值给
  // 等于每隔几天空一次。
  for (const preset of core.AI_PRESETS) {
    assert.ok(preset.maxTokens >= 32768, `${preset.id} 的 max_tokens 太小：${preset.maxTokens}`);
  }
});

test('响应根本不是 JSON 也要给一句人话', () => {
  const reply = core.parseChatResponse(502, '<html>bad gateway</html>');
  assert.strictEqual(reply.ok, false);
  assert.match(reply.detail, /HTTP 502/);
});

// --- 从正文里抠 JSON：模型爱裹围栏，这是常态不是异常 ------------------------------

test('围栏、前言、纯 JSON 三种都抠得出来', () => {
  assert.strictEqual(core.extractJsonBlock('{"a":1}'), '{"a":1}');
  assert.strictEqual(core.extractJsonBlock('```json\n{"a":1}\n```'), '{"a":1}');
  assert.strictEqual(core.extractJsonBlock('```\n{"a":1}\n```'), '{"a":1}');
  assert.strictEqual(core.extractJsonBlock('好的，这是结果：\n{"a":1}\n希望有用'), '{"a":1}');
});

test('抠不出来就是空串，不去修补半截 JSON', () => {
  assert.strictEqual(core.extractJsonBlock('完全没有 JSON'), '');
  assert.strictEqual(core.extractJsonBlock(''), '');
});

// ---------------------------------------------------------------------------
// 全局的一层（AME-258 第 22.1 条）
// ---------------------------------------------------------------------------

test('用途表就是「全局」两个字的落点：加一处用途 = 加一行', () => {
  assert.ok(core.AI_CONSUMERS.length >= 1);
  for (const consumer of core.AI_CONSUMERS) {
    assert.ok(consumer.id);
    assert.ok(consumer.label);
    assert.ok(consumer.detail);
  }
});

test('配好了但一处用途都没开的时候，明说「没人调它」', () => {
  const settings = {
    ...core.DEFAULT_SETTINGS,
    aiEnabled: true,
    aiReviewDraft: false,
    aiProfiles: [{ ...core.AI_PRESETS[0], apiKey: 'sk-test' }],
    aiActiveProfile: core.AI_PRESETS[0].id,
  };
  assert.deepStrictEqual(core.activeAiConsumers(settings), []);
  assert.ok(core.describeAi(settings, {}).includes('没人调它'));
});

test('开着的用途会被点名列出来', () => {
  const settings = {
    ...core.DEFAULT_SETTINGS,
    aiEnabled: true,
    aiReviewDraft: true,
    aiProfiles: [{ ...core.AI_PRESETS[0], apiKey: 'sk-test' }],
    aiActiveProfile: core.AI_PRESETS[0].id,
  };
  assert.ok(core.describeAi(settings, {}).includes('睡前复盘草稿'));
});

test('留痕默认开、默认留 7 天——看不见请求和返回才是要修的那件事', () => {
  assert.strictEqual(core.DEFAULT_SETTINGS.aiLogEnabled, true);
  assert.strictEqual(core.DEFAULT_SETTINGS.aiLogKeepDays, 7);
});

test('留 0 天是个没有意义的配置，读回来抬到 1', () => {
  assert.strictEqual(core.normalizeSettings({ aiLogKeepDays: 0 }).aiLogKeepDays, 1);
  assert.strictEqual(core.normalizeSettings({ aiLogKeepDays: 900 }).aiLogKeepDays, 365);
});
