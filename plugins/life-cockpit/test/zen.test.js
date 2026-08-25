'use strict';

// AME-231：遮罩盖谁。
//
// 从前是「工作段全屏遮罩」——把 Obsidian 这个工作台盖住，本末倒置：禅定是**一段活
// 干完之后**的休息与静心，不是「远离电脑」。电脑和 Obsidian 是生产力工具，要躲的是
// 手机那类娱乐工具，而那个恰恰是这块遮罩盖不着的。所以默认只盖休息段。

const test = require('node:test');
const assert = require('node:assert');
const core = require('./.build/core.js');

const { shouldShowZen, zenCoversSegment, DEFAULT_SETTINGS, normalizeSettings } = core;

function input(overrides = {}) {
  return {
    zenEnabled: true,
    zenCoverWork: false,
    kind: 'break',
    status: 'running',
    forced: false,
    dismissed: false,
    ...overrides,
  };
}

test('默认只盖休息段，工作段不盖', () => {
  assert.strictEqual(zenCoversSegment({ kind: 'break', zenCoverWork: false, forced: false }), true);
  assert.strictEqual(
    zenCoversSegment({ kind: 'long-break', zenCoverWork: false, forced: false }),
    true,
  );
  assert.strictEqual(zenCoversSegment({ kind: 'work', zenCoverWork: false, forced: false }), false);
});

test('工作段要盖得有明确的意思表示：设置里长开，或者命令临时叫一次', () => {
  assert.strictEqual(zenCoversSegment({ kind: 'work', zenCoverWork: true, forced: false }), true);
  assert.strictEqual(zenCoversSegment({ kind: 'work', zenCoverWork: false, forced: true }), true);
});

test('zenCoverWork 默认关着——这是本末倒置那条的修法', () => {
  assert.strictEqual(DEFAULT_SETTINGS.zenCoverWork, false);
  assert.strictEqual(normalizeSettings({}).zenCoverWork, false);
  assert.strictEqual(normalizeSettings({ zenCoverWork: true }).zenCoverWork, true);
});

test('整个禅定关掉时哪一段都不盖', () => {
  assert.strictEqual(shouldShowZen(input({ zenEnabled: false })), false);
  assert.strictEqual(shouldShowZen(input({ zenEnabled: false, zenCoverWork: true })), false);
});

test('idle 时没东西可盖', () => {
  assert.strictEqual(shouldShowZen(input({ status: 'idle' })), false);
});

test('暂停着也照盖——停着的表更要有地方说明它为什么不动', () => {
  assert.strictEqual(shouldShowZen(input({ status: 'paused' })), true);
});

test('Esc 退出过的那一段不弹回来', () => {
  assert.strictEqual(shouldShowZen(input({ dismissed: true })), false);
  assert.strictEqual(shouldShowZen(input({ dismissed: true, forced: true })), false);
});
