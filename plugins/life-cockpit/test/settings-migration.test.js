'use strict';

// 世代迁移（AME-244）。0.9.0 把两种模式的基准时长对调了，而**改默认值救不回
// 已经存过一次的机器**（AME-239 的教训）——所以有这一段迁移，也所以它必须
// 只认没被人改过的值。

const test = require('node:test');
const assert = require('node:assert');
const core = require('./.build/core.js');

/** 0.8.0 及之前 data.json 里那两组数（themeCycle 不参与迁移，这里也不摆）。 */
const OLD = {
  'accelerated-practice': {
    workMinutes: 25,
    breakMinutes: 5,
    longBreakMinutes: 15,
    pomodorosPerLongBreak: 4,
    reminderIntervalMinutes: 30,
  },
  'thinking-first': {
    workMinutes: 45,
    breakMinutes: 10,
    longBreakMinutes: 25,
    pomodorosPerLongBreak: 3,
    reminderIntervalMinutes: 45,
  },
};

test('新装的机器直接是新基准：思考优先 25、加速实践 45', () => {
  const settings = core.normalizeSettings(null);
  assert.strictEqual(settings.modes['thinking-first'].workMinutes, 25);
  assert.strictEqual(settings.modes['thinking-first'].breakMinutes, 5);
  assert.strictEqual(settings.modes['accelerated-practice'].workMinutes, 45);
  assert.strictEqual(settings.modes['accelerated-practice'].breakMinutes, 10);
  assert.strictEqual(settings.settingsVersion, core.SETTINGS_VERSION);
});

test('装过 0.8.0、一个数都没改过的机器：整组对调过来', () => {
  const settings = core.normalizeSettings({ modes: OLD });
  assert.strictEqual(settings.modes['thinking-first'].workMinutes, 25);
  assert.strictEqual(settings.modes['thinking-first'].reminderIntervalMinutes, 30);
  assert.strictEqual(settings.modes['accelerated-practice'].workMinutes, 45);
  assert.strictEqual(settings.modes['accelerated-practice'].reminderIntervalMinutes, 45);
});

test('提醒主题不跟着走：那几句写的是心法，和跑多久无关', () => {
  const themes = ['当 · 只想一件事'];
  const settings = core.normalizeSettings({
    modes: {
      ...OLD,
      'thinking-first': { ...OLD['thinking-first'], themeCycle: themes },
    },
  });
  assert.deepStrictEqual(settings.modes['thinking-first'].themeCycle, themes);
  assert.strictEqual(settings.modes['thinking-first'].workMinutes, 25);
});

test('自己调过时长的机器一个数都不动——改过就是有意的', () => {
  const mine = {
    ...OLD,
    'thinking-first': { ...OLD['thinking-first'], workMinutes: 50 },
  };
  const settings = core.normalizeSettings({ modes: mine });
  assert.strictEqual(settings.modes['thinking-first'].workMinutes, 50);
  // 一组不匹配就整个不迁：两组值必须成对，半迁会得到 25 + 25 这种鬼东西。
  assert.strictEqual(settings.modes['accelerated-practice'].workMinutes, 25);
});

test('迁移一台机器上只发生一次：写下世代号之后就不再翻', () => {
  const once = core.normalizeSettings({ modes: OLD });
  assert.strictEqual(once.settingsVersion, core.SETTINGS_VERSION);
  // 有意把它调成旧的那一组（0.9.0 之后这也是合法配置），不许再被翻过去。
  const again = core.normalizeSettings({ settingsVersion: 1, modes: OLD });
  assert.strictEqual(again.modes['thinking-first'].workMinutes, 45);
  assert.strictEqual(again.modes['accelerated-practice'].workMinutes, 25);
});

test('间歇节奏默认关、倍数默认一半，坏值退回默认', () => {
  const settings = core.normalizeSettings({});
  assert.strictEqual(settings.pomodoroAlternateEnabled, false);
  assert.strictEqual(settings.pomodoroAlternateRatio, 0.5);
  assert.strictEqual(core.normalizeSettings({ pomodoroAlternateRatio: 0 }).pomodoroAlternateRatio, 0.1);
  assert.strictEqual(core.normalizeSettings({ pomodoroAlternateRatio: 5 }).pomodoroAlternateRatio, 1);
  assert.strictEqual(
    core.normalizeSettings({ pomodoroAlternateRatio: 'half' }).pomodoroAlternateRatio,
    0.5,
  );
});

test('重启接现场默认开、宽限期默认 5 分钟，0 是合法值', () => {
  const settings = core.normalizeSettings({});
  assert.strictEqual(settings.sessionRestoreEnabled, true);
  assert.strictEqual(settings.sessionGraceMinutes, 5);
  assert.strictEqual(core.normalizeSettings({ sessionGraceMinutes: 0 }).sessionGraceMinutes, 0);
  assert.strictEqual(core.normalizeSettings({ sessionGraceMinutes: -3 }).sessionGraceMinutes, 5);
});

// ---------------------------------------------------------------------------
// 世代 2（AME-317）：默认数据根换成中性的 LifeCockpit/。
// 钉的是「缺失的路径项」，不是「等于旧默认值的项」——显式存着的值
// 一个字都不碰，不管它像不像旧默认值。
// ---------------------------------------------------------------------------

/** 世代 1 的默认路径：升级上来没改过的机器，data.json 里就是这些。 */
const V1 = {
  ledgerFolder:
    'Root/【2A-META】AI-First时代，知识库（toAI完全公开）/驾驶舱运行区/番茄流水',
  pointsFolder:
    'Root/【2A-META】AI-First时代，知识库（toAI完全公开）/驾驶舱运行区/积分账本',
  pointsTaskNote:
    'Root/【2A-META】AI-First时代，知识库（toAI完全公开）/驾驶舱运行区/积分账本/积分任务表.md',
  goalTreeNote:
    'Root/【2A-META】AI-First时代，知识库（toAI完全公开）/驾驶舱运行区/目标树.md',
  candidatesFolder:
    'Root/【2A-META】AI-First时代，知识库（toAI完全公开）/驾驶舱运行区/候选区',
  reviewJournalFolder:
    'Root/【2A-META】AI-First时代，知识库（toAI完全公开）/驾驶舱运行区/复盘日记',
  reviewMaterialFolder:
    'Root/【2A-META】AI-First时代，知识库（toAI完全公开）/驾驶舱运行区/复盘素材',
  reviewMistakeNote:
    'Root/【2A-META】AI-First时代，知识库（toAI完全公开）/AI史书/AI时代错题本-不贰过.md',
  feishuSnapshotFolder:
    'Root/【2A-META】AI-First时代，知识库（toAI完全公开）/驾驶舱运行区/飞书快照',
  miaodaFolder:
    'Root/【2A-META】AI-First时代，知识库（toAI完全公开）/驾驶舱运行区/秒哒写作',
};

test('显式存着世代 1 默认值的机器：一个字都不动', () => {
  const kept = core.normalizeSettings({ ...V1, settingsVersion: 1 });
  for (const [key, value] of Object.entries(V1)) {
    assert.strictEqual(kept[key], value, `${key} 被新默认值顶掉了`);
  }
});

test('自己改过的路径同样不动——钉的只是缺的那几条', () => {
  const mine = { ...V1, ledgerFolder: 'Root/我自己的番茄', settingsVersion: 1 };
  const kept = core.normalizeSettings(mine);
  assert.strictEqual(kept.ledgerFolder, 'Root/我自己的番茄');
  assert.strictEqual(kept.miaodaFolder, V1.miaodaFolder);
});

test('缺了哪条路径就按世代 1 的位置钉住哪条——不搬盘上的文件', () => {
  // 0.15 的机器没有秒哒这一项：升级后不能悄悄挪到 LifeCockpit 去，
  // 否则下一次拉取就落在别人不知道的地方。
  const kept = core.normalizeSettings({
    ledgerFolder: V1.ledgerFolder,
    settingsVersion: 1,
  });
  assert.strictEqual(kept.ledgerFolder, V1.ledgerFolder);
  assert.strictEqual(kept.miaodaFolder, V1.miaodaFolder);
  assert.strictEqual(kept.feishuSnapshotFolder, V1.feishuSnapshotFolder);
});

test('首次安装（data.json 为空）吃的是中性默认值，不是钉住的旧值', () => {
  // 一个键都没有＝没有「已有配置」这回事，钉挂不上它。
  for (const raw of [null, {}]) {
    const fresh = core.normalizeSettings(raw);
    assert.strictEqual(fresh.ledgerFolder, `${core.COCKPIT_ROOT}/番茄流水`);
    assert.strictEqual(fresh.miaodaFolder, `${core.COCKPIT_ROOT}/秒哒写作`);
  }
});

test('世代号写下去之后就不再钉：v2 机器缺了路径项就吃新默认值', () => {
  const kept = core.normalizeSettings({ settingsVersion: core.SETTINGS_VERSION });
  assert.strictEqual(kept.miaodaFolder, `${core.COCKPIT_ROOT}/秒哒写作`);
});
