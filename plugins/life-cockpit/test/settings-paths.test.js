'use strict';

// 驾驶舱的数据面默认整块落在一个**中性名字**的根目录下（AME-317）。
//
// 为什么改：0.19.0 之前默认路径带着仓库主人私人知识库的名字——陌生人装上插件，
// vault 里凭空长出一个别人私仓的目录，这是「一看就是从别人的私仓里抠出来的」
// 最直接的证据。0.19.0 起新装用户默认落到 `LifeCockpit/`，子结构不变；
// 已有配置一个字不动（世代迁移锁死这条，见 settings-migration.test.js）。
//
// 断言分两半：默认值全部挂在中性根下、子结构固定（防新增设置项再散出去），
// 以及 0.6.x 旧默认值的一次性迁移仍然有效。

const test = require('node:test');
const assert = require('node:assert');
const core = require('./.build/core.js');

const { DEFAULT_SETTINGS, normalizeSettings, COCKPIT_ROOT, cockpitPaths } = core;

/** 插件自己写盘的每一项。人自己配的读物池 / 休息页 / 音乐不在内——那些指哪儿是人的自由。 */
const OWNED_PATH_KEYS = [
  'ledgerFolder',
  'pointsFolder',
  'pointsTaskNote',
  'goalTreeNote',
  'candidatesFolder',
  'reviewJournalFolder',
  'reviewMaterialFolder',
  'reviewMistakeNote',
  'feishuSnapshotFolder',
  'miaodaFolder',
];

test('新装用户的每一项默认值都挂在中性根 LifeCockpit/ 下', () => {
  for (const key of OWNED_PATH_KEYS) {
    assert.ok(
      DEFAULT_SETTINGS[key].startsWith(`${COCKPIT_ROOT}/`),
      `${key} 没落在 ${COCKPIT_ROOT}/ 下：${DEFAULT_SETTINGS[key]}`,
    );
  }
});

test('默认值里不再出现仓库主人的私人路径名', () => {
  for (const key of OWNED_PATH_KEYS) {
    assert.ok(
      !DEFAULT_SETTINGS[key].includes('【2A-META】'),
      `${key} 还带着私人知识库的名字：${DEFAULT_SETTINGS[key]}`,
    );
    assert.ok(
      !DEFAULT_SETTINGS[key].startsWith('Root/每日Journal/'),
      `${key} 还指着人的私域：${DEFAULT_SETTINGS[key]}`,
    );
  }
});

test('子结构和从前是同一套：换任何根都长同样的八样', () => {
  const mine = cockpitPaths('我的数据');
  assert.strictEqual(mine.ledgerFolder, '我的数据/番茄流水');
  assert.strictEqual(mine.pointsFolder, '我的数据/积分账本');
  assert.strictEqual(mine.pointsTaskNote, '我的数据/积分账本/积分任务表.md');
  assert.strictEqual(mine.goalTreeNote, '我的数据/目标树.md');
  assert.strictEqual(mine.candidatesFolder, '我的数据/候选区');
  assert.strictEqual(mine.reviewJournalFolder, '我的数据/复盘日记');
  assert.strictEqual(mine.reviewMaterialFolder, '我的数据/复盘素材');
  assert.strictEqual(mine.feishuSnapshotFolder, '我的数据/飞书快照');
  assert.strictEqual(mine.miaodaFolder, '我的数据/秒哒写作');
  // 错题本也跟着数据区走：新装用户没有「AI史书」那棵树可挂。
  assert.strictEqual(mine.reviewMistakeNote, '我的数据/AI时代错题本-不贰过.md');
});

test('根为空或只剩斜杠时退回中性默认', () => {
  assert.strictEqual(cockpitPaths('').goalTreeNote, `${COCKPIT_ROOT}/目标树.md`);
  assert.strictEqual(cockpitPaths('   ').miaodaFolder, `${COCKPIT_ROOT}/秒哒写作`);
  assert.strictEqual(cockpitPaths('notes///').pointsFolder, 'notes/积分账本');
});

test('inferCockpitRoot：整块挂在同一个根下就推得出那个根', () => {
  const v1Root = 'Root/【2A-META】AI-First时代，知识库（toAI完全公开）/驾驶舱运行区';
  const legacy = { ...DEFAULT_SETTINGS, ...cockpitPaths(v1Root) };
  // 升级上来的老机器：推出来的是它们现在真正的根——引导预填它，确认等于不改。
  assert.strictEqual(core.inferCockpitRoot(legacy), v1Root);
  assert.strictEqual(core.inferCockpitRoot(DEFAULT_SETTINGS), COCKPIT_ROOT);
});

test('inferCockpitRoot：路径各奔东西时没有唯一答案，返回 null', () => {
  const mixed = normalizeSettings({
    ledgerFolder: 'A/番茄流水',
    pointsFolder: 'B/积分账本',
  });
  assert.strictEqual(core.inferCockpitRoot(mixed), null);
});

test('存量设置里的旧默认值一次性迁到当前的位置', () => {
  const legacy = {
    ledgerFolder: 'Root/每日Journal/番茄流水',
    pointsFolder: 'Root/每日Journal/积分账本',
    pointsTaskNote: 'Root/每日Journal/积分账本/积分任务表.md',
    goalTreeNote: 'Root/每日Journal/目标树.md',
    candidatesFolder: 'Root/候选区',
    reviewJournalFolder: 'Root/每日Journal/日记',
    reviewMaterialFolder: 'Root/每日Journal/复盘素材',
  };
  const migrated = normalizeSettings(legacy);
  for (const key of Object.keys(legacy)) {
    assert.strictEqual(migrated[key], DEFAULT_SETTINGS[key], `${key} 没迁到新位置`);
  }
});

test('自己改过的路径不动——改过就是有意的', () => {
  const custom = {
    candidatesFolder: 'Root/我自己的候选区',
    goalTreeNote: 'Root/别处/树.md',
    // 只差一个尾斜杠也不算旧默认值，宁可不迁也不猜。
    ledgerFolder: 'Root/每日Journal/番茄流水/',
  };
  const kept = normalizeSettings(custom);
  assert.strictEqual(kept.candidatesFolder, 'Root/我自己的候选区');
  assert.strictEqual(kept.goalTreeNote, 'Root/别处/树.md');
  assert.strictEqual(kept.ledgerFolder, 'Root/每日Journal/番茄流水/');
});

test('迁移不影响空设置——空的直接吃新默认值', () => {
  const fresh = normalizeSettings({});
  for (const key of OWNED_PATH_KEYS) {
    assert.strictEqual(fresh[key], DEFAULT_SETTINGS[key]);
  }
});
