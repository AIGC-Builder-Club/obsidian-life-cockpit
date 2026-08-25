'use strict';

// 新手 / 专家两档设置面（AME-244）。这一层只有一条规矩要守：
// **默认是新手，而且新手模式下漏标的项一律锁上**——漏标顶多「改不了」，
// 不会变成「悄悄能改」。

const test = require('node:test');
const assert = require('node:assert');
const core = require('./.build/core.js');

test('默认是新手模式', () => {
  assert.strictEqual(core.DEFAULT_SETTINGS.expertise, 'beginner');
  assert.strictEqual(core.normalizeSettings({}).expertise, 'beginner');
  assert.strictEqual(core.normalizeSettings(null).expertise, 'beginner');
});

test('档位认不出来就退回新手', () => {
  assert.strictEqual(core.normalizeSettings({ expertise: 'expert' }).expertise, 'expert');
  assert.strictEqual(core.normalizeSettings({ expertise: 'wizard' }).expertise, 'beginner');
  assert.strictEqual(core.normalizeSettings({ expertise: 3 }).expertise, 'beginner');
  assert.strictEqual(core.isExpertise('beginner'), true);
  assert.strictEqual(core.isExpertise('BEGINNER'), false);
});

test('专家模式下一切都能改；新手模式下只有标过记号的能改', () => {
  assert.strictEqual(core.canEditSetting('expert', false), true);
  assert.strictEqual(core.canEditSetting('expert', true), true);
  assert.strictEqual(core.canEditSetting('beginner', true), true);
  // 没标记号 = 锁上。新增一项的默认结果就是这一格。
  assert.strictEqual(core.canEditSetting('beginner', false), false);
});

test('两档都说得清自己是什么，并且说明「切回去不会还原改过的值」', () => {
  assert.match(core.describeExpertise('beginner'), /只是不许改/);
  assert.match(core.describeExpertise('beginner'), /专家模式/);
  assert.match(core.describeExpertise('expert'), /不会.*还原/);
  assert.deepStrictEqual(core.EXPERTISE_IDS, ['beginner', 'expert']);
  assert.strictEqual(core.EXPERTISE_LABELS.beginner, '新手 · 开箱即用');
});
