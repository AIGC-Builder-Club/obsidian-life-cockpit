'use strict';

// 手抄密钥那一段路（AME-273 第 2 条）。
//
// 原话：「ApiKey——我手动复制的，经常会多一个换行（在手动剔除了换行后，发现就可以了）」。
// 所以这一组测试盯的只有两件事：
//   1. **确定不属于密钥的字符一律洗掉**——洗不掉的那一个换行换来的是 401，
//      而 401 长得和「key 填错了」一模一样；
//   2. **该留的一个字都不许动**——洗坏一把好 key 比脏着更糟，人还以为自己填对了。

const test = require('node:test');
const assert = require('node:assert');
const core = require('./.build/core.js');

// 形状照真的那把来（三段 JWT），但不是真 key：这个仓库是公开的。
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.K_11TLRso66ZGcd2Bng';

test('末尾那个换行——本条 issue 报的就是它', () => {
  const cleaned = core.cleanSecret(`${KEY}\n`);
  assert.strictEqual(cleaned.value, KEY);
  assert.deepStrictEqual(cleaned.removed, ['newline']);
  assert.strictEqual(cleaned.changed, true);
});

test('换行夹在中间也照洗——trim 治不了的正是这一种', () => {
  const wrapped = `${KEY.slice(0, 40)}\n${KEY.slice(40)}`;
  assert.strictEqual(core.cleanSecret(wrapped).value, KEY);
});

test('空格、制表符、零宽字符各认各的名字', () => {
  const dirty = ` ${KEY.slice(0, 10)} \t${KEY.slice(10)}​ `;
  const cleaned = core.cleanSecret(dirty);
  assert.strictEqual(cleaned.value, KEY);
  assert.deepStrictEqual(cleaned.removed, ['tab', 'space', 'invisible']);
});

test('从 devtools 里连键带引号复制的一整行', () => {
  const cleaned = core.cleanSecret(`  "apikey": "${KEY}",\n`);
  assert.strictEqual(cleaned.value, KEY);
  assert.ok(cleaned.removed.includes('quote'));
  assert.ok(cleaned.removed.includes('label'));
  assert.ok(cleaned.removed.includes('trailing'));
});

test('header 里那一份连 Bearer 一起复制过来', () => {
  assert.strictEqual(core.cleanSecret(`Bearer ${KEY}`).value, KEY);
  assert.strictEqual(core.cleanSecret(`authorization: Bearer ${KEY}`).value, KEY);
});

test('干净的那一份一个字都不动，也不报「洗过」', () => {
  const cleaned = core.cleanSecret(KEY);
  assert.strictEqual(cleaned.value, KEY);
  assert.strictEqual(cleaned.changed, false);
  assert.deepStrictEqual(cleaned.removed, []);
});

test('密钥自己的字符一个都不许当噪音洗掉', () => {
  // base64url 的 - 和 _、结尾的 = 补位、以及三段之间的点，全是密钥的一部分。
  const padded = 'abc-def_ghi.jkl-mno_pqr.stu==';
  assert.strictEqual(core.cleanSecret(padded).value, padded);
  // 只有**成对**的包裹符才算引号；单边的那个可能真是密钥的一部分。
  assert.strictEqual(core.cleanSecret('"半边引号').value, '"半边引号');
});

test('空的进来还是空的出去', () => {
  const cleaned = core.cleanSecret('   \n  ');
  assert.strictEqual(cleaned.value, '');
  assert.strictEqual(core.cleanSecretValue(''), '');
});

test('洗掉了要说出来；没洗掉就闭嘴', () => {
  assert.match(core.describeSecretNoise(['newline', 'space']), /换行、空格/);
  assert.match(core.describeSecretNoise(['newline']), /已自动去掉/);
  assert.strictEqual(core.describeSecretNoise([]), '', '没事发生的时候不要说话');
});

test('形状看得见，密钥看不见', () => {
  const shape = core.secretShape(KEY, true);
  assert.match(shape, /JWT/);
  assert.match(shape, new RegExp(`${KEY.length} 字符`));
  assert.ok(!shape.includes(KEY), '整把 key 绝不能出现在给人看的那一行里');
  assert.strictEqual(core.maskSecret(KEY), `${KEY.slice(0, 6)}…${KEY.slice(-4)}`);
  // 短到打码没意义的整串盖掉。
  assert.strictEqual(core.maskSecret('abc'), '···');
  assert.strictEqual(core.secretShape('', true), '还没填。');
});

test('不像 JWT 的时候要说出来——「复制少了半截」是最常见的那一种', () => {
  assert.strictEqual(core.looksLikeJwt(KEY), true);
  assert.strictEqual(core.looksLikeJwt('eyJhbGciOi'), false, '少了两段');
  assert.strictEqual(core.looksLikeJwt(`${KEY} `), false, '带空白的一律不算——洗过之后才判');
  assert.match(core.secretShape('随便一串', true), /不像 JWT/);
  assert.doesNotMatch(core.secretShape('随便一串', false), /不像 JWT/, '不指望是 JWT 的地方别乱报警');
});
