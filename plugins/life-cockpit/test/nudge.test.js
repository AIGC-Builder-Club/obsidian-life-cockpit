'use strict';

// 推动器的闸门与渠道。PushHub 的渠道是注入的，所以这里拿两个假渠道
// 就能把「闸门 → 分发 → 一条挂了别的还得发出去」整条链路跑真的。

const test = require('node:test');
const assert = require('node:assert');
const core = require('./.build/core.js');

const DAY = '2026-08-11';

function settings(patch = {}) {
  return {
    nudgeEnabled: true,
    nudgeMuted: false,
    nudgeMinLevel: 'info',
    nudgeQuietFrom: '22:00',
    nudgeQuietTo: '05:00',
    nudgeQuietBypassHard: true,
    nudgeCooldownMinutes: 10,
    nudgeDailyCap: 24,
    ...patch,
  };
}

function message(patch = {}) {
  return { key: 'pomodoro-done', level: 'info', title: '番茄跑满了', body: '起来走两步', ...patch };
}

function context(patch = {}) {
  return { day: DAY, minute: 10 * 60, now: 1_000_000, readyChannels: 1, ...patch };
}

function route(patchSettings, patchMessage, patchContext, state) {
  return core.routeNudge(
    settings(patchSettings),
    state ?? core.createNudgeState(),
    message(patchMessage),
    context(patchContext),
  );
}

// ---------------------------------------------------------------------------
// 五道闸
// ---------------------------------------------------------------------------

test('一切正常时推得出去，并记下这一条的时刻', () => {
  const decision = route();
  assert.strictEqual(decision.deliver, true);
  assert.strictEqual(decision.suppressed, null);
  assert.strictEqual(decision.state.count, 1);
  assert.strictEqual(decision.state.lastAt['pomodoro-done'], 1_000_000);
});

test('总开关关掉 / 静音，一条都不推——hard 也不例外', () => {
  assert.strictEqual(route({ nudgeEnabled: false }).suppressed, 'disabled');
  assert.strictEqual(route({ nudgeMuted: true }).suppressed, 'muted');
  assert.strictEqual(route({ nudgeMuted: true }, { level: 'hard' }).suppressed, 'muted');
});

test('分级阈值把低于它的挡下来，等于和高于它的照推', () => {
  assert.strictEqual(route({ nudgeMinLevel: 'nudge' }, { level: 'info' }).suppressed, 'below-threshold');
  assert.strictEqual(route({ nudgeMinLevel: 'nudge' }, { level: 'nudge' }).deliver, true);
  assert.strictEqual(route({ nudgeMinLevel: 'nudge' }, { level: 'hard' }).deliver, true);
  assert.strictEqual(route({ nudgeMinLevel: 'hard' }, { level: 'nudge' }).suppressed, 'below-threshold');
});

test('免打扰时段挡住 info / nudge；hard 是否照推由设置说了算', () => {
  const night = { minute: 23 * 60 };
  assert.strictEqual(route({}, {}, night).suppressed, 'quiet-hours');
  assert.strictEqual(route({}, { level: 'nudge' }, night).suppressed, 'quiet-hours');
  assert.strictEqual(route({}, { level: 'hard' }, night).deliver, true);
  assert.strictEqual(
    route({ nudgeQuietBypassHard: false }, { level: 'hard' }, night).suppressed,
    'quiet-hours',
  );
});

test('免打扰时段跨零点：22:00 到次日 05:00 都算，白天不算', () => {
  const quiet = (hour) => core.inQuietHours(hour * 60, '22:00', '05:00');
  assert.strictEqual(quiet(22), true);
  assert.strictEqual(quiet(23), true);
  assert.strictEqual(quiet(0), true);
  assert.strictEqual(quiet(4), true);
  assert.strictEqual(quiet(5), false);
  assert.strictEqual(quiet(12), false);
  assert.strictEqual(quiet(21), false);
});

test('免打扰时段两端相同 / 写坏了，一律当没设', () => {
  assert.strictEqual(core.inQuietHours(23 * 60, '22:00', '22:00'), false);
  assert.strictEqual(core.inQuietHours(23 * 60, '晚上', '05:00'), false);
  assert.strictEqual(core.inQuietHours(23 * 60, '', ''), false);
});

test('同一个 key 在冷却里不重复推，换个 key 照推', () => {
  const first = route();
  const again = core.routeNudge(
    settings(),
    first.state,
    message(),
    context({ now: 1_000_000 + 5 * 60_000 }),
  );
  assert.strictEqual(again.suppressed, 'cooldown');

  const other = core.routeNudge(
    settings(),
    first.state,
    message({ key: 'rhythm-enter' }),
    context({ now: 1_000_000 + 5 * 60_000 }),
  );
  assert.strictEqual(other.deliver, true);

  const later = core.routeNudge(
    settings(),
    first.state,
    message(),
    context({ now: 1_000_000 + 11 * 60_000 }),
  );
  assert.strictEqual(later.deliver, true);
});

test('冷却对 hard 一视同仁——同一件事炸十遍比不推更糟', () => {
  const first = route({}, { level: 'hard' });
  const again = core.routeNudge(
    settings(),
    first.state,
    message({ level: 'hard' }),
    context({ now: 1_000_000 + 60_000 }),
  );
  assert.strictEqual(again.suppressed, 'cooldown');
});

test('每日配额用完就挡 info / nudge，hard 照推且不吃配额', () => {
  let state = core.createNudgeState();
  for (let i = 0; i < 3; i += 1) {
    const decision = core.routeNudge(
      settings({ nudgeDailyCap: 3, nudgeCooldownMinutes: 0 }),
      state,
      message({ key: `k-${i}` }),
      context(),
    );
    assert.strictEqual(decision.deliver, true);
    state = decision.state;
  }
  assert.strictEqual(state.count, 3);

  const capped = core.routeNudge(
    settings({ nudgeDailyCap: 3, nudgeCooldownMinutes: 0 }),
    state,
    message({ key: 'k-4' }),
    context(),
  );
  assert.strictEqual(capped.suppressed, 'daily-cap');

  const hard = core.routeNudge(
    settings({ nudgeDailyCap: 3, nudgeCooldownMinutes: 0 }),
    state,
    message({ key: 'k-5', level: 'hard' }),
    context(),
  );
  assert.strictEqual(hard.deliver, true);
  assert.strictEqual(hard.state.count, 3, 'hard 不吃配额');
});

test('配额 0 = 不限；冷却 0 = 不冷却', () => {
  let state = core.createNudgeState();
  for (let i = 0; i < 50; i += 1) {
    const decision = core.routeNudge(
      settings({ nudgeDailyCap: 0, nudgeCooldownMinutes: 0 }),
      state,
      message(),
      context(),
    );
    assert.strictEqual(decision.deliver, true);
    state = decision.state;
  }
  assert.strictEqual(core.remainingQuota(settings({ nudgeDailyCap: 0 }), state, DAY), Infinity);
});

test('换天清配额，昨天的数字不参与今天的判断', () => {
  let state = core.createNudgeState();
  const capped = settings({ nudgeDailyCap: 1, nudgeCooldownMinutes: 0 });
  state = core.routeNudge(capped, state, message(), context()).state;
  assert.strictEqual(core.routeNudge(capped, state, message(), context()).suppressed, 'daily-cap');

  const tomorrow = core.routeNudge(capped, state, message(), context({ day: '2026-08-12' }));
  assert.strictEqual(tomorrow.deliver, true);
  assert.strictEqual(tomorrow.state.day, '2026-08-12');
  assert.strictEqual(tomorrow.state.count, 1);
});

test('一条渠道都没有就不推，且说得出是没渠道', () => {
  assert.strictEqual(route({}, {}, { readyChannels: 0 }).suppressed, 'no-channel');
});

test('被拦下来的那一条不吃配额也不记冷却', () => {
  const decision = route({ nudgeMuted: true });
  assert.strictEqual(decision.state.count, 0);
  assert.deepStrictEqual(decision.state.lastAt, {});
});

test('remainingQuota 报的是「还能推几条」', () => {
  const config = settings({ nudgeDailyCap: 5 });
  const state = { day: DAY, count: 2, lastAt: {} };
  assert.strictEqual(core.remainingQuota(config, state, DAY), 3);
  assert.strictEqual(core.remainingQuota(config, state, '2026-08-12'), 5, '换天回满');
});

// ---------------------------------------------------------------------------
// PushHub：闸门 + 渠道
// ---------------------------------------------------------------------------

function fakeChannel(id, state = 'ready', behaviour = 'ok') {
  const sent = [];
  return {
    id,
    label: id,
    sent,
    status: () => ({ id, label: id, state, detail: state === 'ready' ? '可用' : '缺配置' }),
    async send(message) {
      sent.push(message);
      if (behaviour === 'throw') throw new Error('网络炸了');
      if (behaviour === 'fail') return { ok: false, detail: 'HTTP 500' };
      return { ok: true, detail: '已送达' };
    },
  };
}

test('PushHub 只发给 ready 的渠道，缺配置的那条不参与', async () => {
  const ready = fakeChannel('system');
  const missing = fakeChannel('feishu', 'missing-config');
  const hub = new core.PushHub({
    settings: () => settings(),
    channels: () => [ready, missing],
  });

  const outcome = await hub.push(message(), { day: DAY, at: new Date('2026-08-11T10:00:00') });
  assert.strictEqual(outcome.suppressed, null);
  assert.strictEqual(ready.sent.length, 1);
  assert.strictEqual(missing.sent.length, 0);
  assert.deepStrictEqual(
    outcome.delivered.map((item) => item.id),
    ['system'],
  );
});

test('四种渠道状态各说各的话——「你关的」「去填」「别等了」不能糊成一种', () => {
  assert.deepStrictEqual(Object.keys(core.CHANNEL_STATE_LABELS).sort(), [
    'disabled',
    'missing-config',
    'ready',
    'unavailable',
  ]);

  const off = fakeChannel('system', 'disabled');
  const hub = new core.PushHub({ settings: () => settings(), channels: () => [off] });
  assert.strictEqual(hub.readyChannels().length, 0, '人自己关掉的渠道不参与分发');
  assert.strictEqual(hub.statuses()[0].state, 'disabled');
});

test('一条渠道炸了不带走别的，两边的结果都留在 outcome 里', async () => {
  const good = fakeChannel('system');
  const bad = fakeChannel('feishu', 'ready', 'throw');
  const hub = new core.PushHub({ settings: () => settings(), channels: () => [bad, good] });

  const outcome = await hub.push(message(), { day: DAY, at: new Date('2026-08-11T10:00:00') });
  assert.strictEqual(good.sent.length, 1, '前面那条炸了，后面这条照发');
  const byId = Object.fromEntries(outcome.delivered.map((item) => [item.id, item]));
  assert.strictEqual(byId.feishu.ok, false);
  assert.match(byId.feishu.detail, /网络炸了/);
  assert.strictEqual(byId.system.ok, true);
  assert.match(outcome.message, /已推 system/);
  assert.match(outcome.message, /失败 feishu/);
});

test('全部失败时报全部失败，不含糊说「已推」', async () => {
  const bad = fakeChannel('feishu', 'ready', 'fail');
  const hub = new core.PushHub({ settings: () => settings(), channels: () => [bad] });
  const outcome = await hub.push(message(), { day: DAY, at: new Date('2026-08-11T10:00:00') });
  assert.match(outcome.message, /全部失败/);
  assert.match(outcome.message, /HTTP 500/);
});

test('闸门拦下来时一条渠道都不碰，理由写在 message 里', async () => {
  const channel = fakeChannel('system');
  const hub = new core.PushHub({
    settings: () => settings({ nudgeMuted: true }),
    channels: () => [channel],
  });

  const outcome = await hub.push(message(), { day: DAY, at: new Date('2026-08-11T10:00:00') });
  assert.strictEqual(channel.sent.length, 0);
  assert.strictEqual(outcome.suppressed, 'muted');
  assert.match(outcome.message, /已静音/);
});

test('推没推出去都留在最近记录里——「今天怎么没推」得答得出来', async () => {
  const hub = new core.PushHub({
    settings: () => settings({ nudgeCooldownMinutes: 60 }),
    channels: () => [fakeChannel('system')],
  });
  const at = new Date('2026-08-11T10:00:00');
  await hub.push(message(), { day: DAY, at });
  await hub.push(message(), { day: DAY, at: new Date('2026-08-11T10:05:00') });

  assert.strictEqual(hub.recent.length, 2);
  assert.strictEqual(hub.recent[0].outcome.suppressed, 'cooldown', '最近的排最前面');
  assert.strictEqual(hub.recent[1].outcome.suppressed, null);
});

// ---------------------------------------------------------------------------
// 渠道载荷与凭据
// ---------------------------------------------------------------------------

test('飞书请求：不给密钥就不签名，给了才带 timestamp 与待签串', () => {
  const at = new Date('2026-08-11T10:00:00Z');
  const plain = core.buildFeishuRequest(message(), { at });
  assert.strictEqual(plain.signBase, null);
  assert.strictEqual(plain.body.msg_type, 'text');
  assert.strictEqual(plain.body.timestamp, undefined);
  assert.match(plain.body.content.text, /番茄跑满了/);
  assert.match(plain.body.content.text, /提示/);

  const signed = core.buildFeishuRequest(message(), { at, secret: 'xxx' });
  assert.strictEqual(signed.signBase, `${signed.timestamp}\nxxx`);
  assert.strictEqual(signed.body.timestamp, String(signed.timestamp));
});

test('通用 webhook 的载荷把分级摊平，接收方不用认插件的枚举', () => {
  const payload = core.buildWebhookRequest(message({ level: 'hard' }), {
    at: new Date('2026-08-11T10:00:00Z'),
    source: 'life-cockpit@0.6.0',
  });
  assert.strictEqual(payload.level, 'hard');
  assert.strictEqual(payload.levelLabel, '强制');
  assert.strictEqual(payload.source, 'life-cockpit@0.6.0');
  assert.strictEqual(payload.title, '番茄跑满了');
});

test('凭据取值只有两处：设置项优先，其次环境变量，都空就是空', () => {
  const env = { LIFE_COCKPIT_FEISHU_WEBHOOK: 'https://env.example/hook' };
  assert.strictEqual(
    core.resolveCredential('https://settings.example/hook', 'LIFE_COCKPIT_FEISHU_WEBHOOK', env),
    'https://settings.example/hook',
  );
  assert.strictEqual(
    core.resolveCredential('  ', 'LIFE_COCKPIT_FEISHU_WEBHOOK', env),
    'https://env.example/hook',
  );
  assert.strictEqual(core.resolveCredential('', 'LIFE_COCKPIT_FEISHU_WEBHOOK', {}), '');
});

test('默认设置里的凭据位一律是空串——仓库里不留任何真实地址或密钥', () => {
  assert.strictEqual(core.DEFAULT_SETTINGS.nudgeFeishuWebhook, '');
  assert.strictEqual(core.DEFAULT_SETTINGS.nudgeFeishuSecret, '');
  assert.strictEqual(core.DEFAULT_SETTINGS.nudgeWebhookUrl, '');
  assert.strictEqual(core.DEFAULT_SETTINGS.nudgeFeishuEnabled, false);
  assert.strictEqual(core.DEFAULT_SETTINGS.nudgeWebhookEnabled, false);
});

test('normalizeSettings 认得推送这几项，写坏了退回默认', () => {
  const normalized = core.normalizeSettings({
    nudgeMinLevel: '很重要',
    nudgeDailyCap: -5,
    nudgeCooldownMinutes: 0,
  });
  assert.strictEqual(normalized.nudgeMinLevel, 'info');
  assert.strictEqual(normalized.nudgeDailyCap, core.DEFAULT_SETTINGS.nudgeDailyCap);
  assert.strictEqual(normalized.nudgeCooldownMinutes, 0, '0 是合法值，不能被默认值顶掉');
});

test('环境变量里那个换行不算数——`$(cat key.txt)` 带着它是常态（AME-273 第 2 条）', () => {
  const env = { LIFE_COCKPIT_FEISHU_SECRET: 'sEcReT-abc123\n' };
  assert.strictEqual(core.resolveCredential('', 'LIFE_COCKPIT_FEISHU_SECRET', env), 'sEcReT-abc123');
  assert.strictEqual(
    core.resolveCredential(' "sEcReT-abc123" ', 'LIFE_COCKPIT_FEISHU_SECRET', {}),
    'sEcReT-abc123',
    '设置项里手抄粘进来的引号同样不算数',
  );
});
