'use strict';

// 运行时音乐：这一段该放什么、要不要换。
// 番茄每秒 tick 一次，所以「同一首继续放」必须是最省事的那条路。

const test = require('node:test');
const assert = require('node:assert');
const core = require('./.build/core.js');

const WORK = 'Root/音乐/狮子吼六字真言.mp3';
const BREAK = 'Root/音乐/流水.mp3';

function settings(patch = {}) {
  return {
    musicEnabled: true,
    musicWorkTrack: WORK,
    musicBreakTrack: BREAK,
    musicVolume: 0.6,
    musicLoop: true,
    ...patch,
  };
}

test('工作段与休息段各放各的，长休息按休息处理', () => {
  assert.strictEqual(core.trackForSegment(settings(), 'work', 'running').path, WORK);
  assert.strictEqual(core.trackForSegment(settings(), 'break', 'running').path, BREAK);
  assert.strictEqual(core.trackForSegment(settings(), 'long-break', 'running').path, BREAK);
});

test('番茄没在跑就不放——停着还在响比不放更烦', () => {
  assert.strictEqual(core.trackForSegment(settings(), 'work', 'paused'), null);
  assert.strictEqual(core.trackForSegment(settings(), 'work', 'idle'), null);
});

test('关掉就一律不放', () => {
  assert.strictEqual(core.trackForSegment(settings({ musicEnabled: false }), 'work', 'running'), null);
});

test('哪一段没配曲子，哪一段就不放，另一段照放', () => {
  const onlyWork = settings({ musicBreakTrack: '' });
  assert.strictEqual(core.trackForSegment(onlyWork, 'work', 'running').path, WORK);
  assert.strictEqual(core.trackForSegment(onlyWork, 'break', 'running'), null);
});

test('音量夹在 0..1 之间，写坏了当满音量', () => {
  assert.strictEqual(core.trackForSegment(settings({ musicVolume: 3 }), 'work', 'running').volume, 1);
  assert.strictEqual(core.trackForSegment(settings({ musicVolume: -1 }), 'work', 'running').volume, 0);
  assert.strictEqual(
    core.trackForSegment(settings({ musicVolume: Number.NaN }), 'work', 'running').volume,
    1,
  );
  assert.strictEqual(core.trackForSegment(settings(), 'work', 'running').loop, true);
});

test('同一首继续放要返回 none——否则每秒会把它重头播一遍', () => {
  const track = core.trackForSegment(settings(), 'work', 'running');
  assert.strictEqual(core.musicAction(WORK, track), 'none');
});

test('从没放到该放是 start，换一首是 switch，该停是 stop', () => {
  const work = core.trackForSegment(settings(), 'work', 'running');
  const brk = core.trackForSegment(settings(), 'break', 'running');
  assert.strictEqual(core.musicAction(null, work), 'start');
  assert.strictEqual(core.musicAction(WORK, brk), 'switch');
  assert.strictEqual(core.musicAction(WORK, null), 'stop');
});

test('本来就没放、也不该放：什么都不做', () => {
  assert.strictEqual(core.musicAction(null, null), 'none');
});

test('默认不放音乐，也不预置任何曲目——插件不内置音频文件', () => {
  assert.strictEqual(core.DEFAULT_SETTINGS.musicEnabled, false);
  assert.strictEqual(core.DEFAULT_SETTINGS.musicWorkTrack, '');
  assert.strictEqual(core.DEFAULT_SETTINGS.musicBreakTrack, '');
});

test('normalizeSettings 把音量夹回 0..1', () => {
  assert.strictEqual(core.normalizeSettings({ musicVolume: 9 }).musicVolume, 1);
  assert.strictEqual(core.normalizeSettings({ musicVolume: -9 }).musicVolume, 0);
  assert.strictEqual(
    core.normalizeSettings({ musicVolume: '大声点' }).musicVolume,
    core.DEFAULT_SETTINGS.musicVolume,
  );
});
