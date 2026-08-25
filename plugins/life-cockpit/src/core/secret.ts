// 手抄密钥的那一段路（AME-273 第 2 条）。
//
//   「ApiKey——我手动复制的，经常会多一个换行（在手动剔除了换行后，发现就可以了）
//    ——在处理时，应给出【示例格式】+【空格这种干扰字符的提醒】+【自动去除此类干扰字符】」
//
// 密钥是这套系统里**唯一必须由人手工搬运**的东西：地址预置好了，落点预置好了，
// 只有它得从浏览器 / 密码管理器 / 聊天记录里复制过来。而复制这条路上什么都会跟着来：
// 换行、行尾空格、`"apikey": "…"` 连键带引号、devtools 里「Copy value」多带的一个逗号、
// 从网页上刮下来的零宽字符。**它们一个都不属于密钥**——却每一个都会让远端回 401，
// 而 401 长得和「key 填错了」一模一样，人根本无从判断自己错在哪。
//
// 所以这一层的规矩是三句话：
//
//   1. **能洗的一律当场洗掉**，不要求人先把剪贴板收拾干净——那是让人替机器干活；
//   2. **洗掉了要说出来**（`describeSecretNoise`）。静默修好比不修好，但比说出来差：
//      下一次他还会照样粘一个换行进来，而且永远不知道这里发生过什么；
//   3. **洗完要给人看形状**（`secretShape`）。密钥不能回显，但「JWT、三段、218 字符、
//      eyJhbG…E4AA」既泄不了密，又足够他一眼认出「这不是我要填的那把」。
//
// 洗的边界也只有一条：**只动确定不属于密钥的字符**。空白、包裹的引号、
// `Bearer` / `apikey:` 这类标签、行尾的逗号分号——去掉它们不会改变任何一把真密钥。
// 别的一律原样留着：猜错了比脏着更糟，那会把一把好 key 洗坏，而人还以为自己填对了。

/** 洗掉的都是些什么。给人看的那句话按这个顺序拼。 */
export type SecretNoise = "newline" | "tab" | "space" | "invisible" | "quote" | "label" | "trailing";

export const SECRET_NOISE_LABELS: Record<SecretNoise, string> = {
  newline: "换行",
  tab: "制表符",
  space: "空格",
  invisible: "零宽字符",
  quote: "包裹的引号",
  label: "开头的 `Bearer` / `apikey:` 之类的标签",
  trailing: "结尾多带的逗号或分号",
};

const NOISE_ORDER: SecretNoise[] = ["newline", "tab", "space", "invisible", "quote", "label", "trailing"];

export interface SecretClean {
  /** 洗过的值。能直接塞进 header 的那一份 */
  value: string;
  /** 洗掉了哪几类干扰，按 `NOISE_ORDER` 排好 */
  removed: SecretNoise[];
  /** 洗掉过东西没有。等价于 `removed.length > 0`，写在这里只是让调用方好读 */
  changed: boolean;
}

/** 零宽字符与 BOM。`\s` 认不出它们，而它们最容易从网页上刮下来。 */
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;

/**
 * `apikey: xxx` / `Authorization = xxx` / `"apikey": xxx` 这类连键带值的复制。
 * 键名两边的引号也认——devtools 里「Copy value」出来的就是带引号的那一份。
 */
const LABEL = /^["'`]?\s*(?:authorization|auth|api[-_\s]?key|apikey|token|secret|key)\s*["'`]?\s*[:=]\s*/i;

/** `Bearer xxx`。header 里那一份连前缀一起复制过来是常态。 */
const BEARER = /^bearer\s+/i;

/** 成对的包裹符。JSON / JS 片段里复制一整行时跟着来的。 */
const QUOTE_PAIRS: Array<[string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["“", "”"],
  ["‘", "’"],
  ["「", "」"],
];

/**
 * 洗一把密钥。**顺序是有讲究的**：空白留到最后再删，因为 `Bearer xxx`、
 * `apikey: xxx` 这两条认的就是中间那个空格——先把空白抹平，它们就认不出来了。
 */
export function cleanSecret(raw: string): SecretClean {
  const noise = new Set<SecretNoise>();

  let value = raw;
  const visible = value.replace(INVISIBLE, "");
  if (visible !== value) {
    noise.add("invisible");
    value = visible;
  }

  // 首尾那一段先认名字**再**剪掉。反过来的话最常见的那一种——「末尾多一个换行」——
  // 会被 trim 悄悄吃掉，人永远不知道自己粘进来的是什么（AME-273 第 2 条报的就是它）。
  const trimmed = value.trim();
  if (trimmed !== value) {
    classifyWhitespace(value.slice(0, value.length - value.trimStart().length), noise);
    classifyWhitespace(value.slice(value.trimEnd().length), noise);
  }
  value = trimmed;

  // 引号 → 标签 → Bearer → 行尾标点，反复剥到不再变为止：
  // `"apikey": "eyJ…",` 这种一整行复制，四层是同时存在的。
  for (let round = 0; round < 4; round += 1) {
    const before = value;

    const unquoted = stripQuotes(value);
    if (unquoted !== value) {
      noise.add("quote");
      value = unquoted.trim();
    }

    const unlabelled = value.replace(LABEL, "").replace(BEARER, "");
    if (unlabelled !== value) {
      noise.add("label");
      value = unlabelled.trim();
    }

    const untrailed = value.replace(/[,;]+$/, "");
    if (untrailed !== value) {
      noise.add("trailing");
      value = untrailed.trim();
    }

    if (value === before) break;
  }

  // 到这里还剩的空白一律不属于密钥：**真密钥里一个空白都没有**
  // （JWT / base64 / hex 的字母表里都没有它）。夹在中间那个换行——trim 治不了的
  // 正是这一种——也在这里被收掉。
  classifyWhitespace(value, noise);
  value = value.replace(/\s+/g, "");

  const removed = NOISE_ORDER.filter((kind) => noise.has(kind));
  return { value, removed, changed: removed.length > 0 };
}

/** 洗干净的那一份。只要值、不关心洗掉了什么时用它。 */
export function cleanSecretValue(raw: string): string {
  return cleanSecret(raw).value;
}

/**
 * 洗掉了什么，说给人听。**没洗掉东西就返回空串**——没事发生的时候不要说话，
 * 每次保存都弹一句「已清理」会让真正有事的那一次也被无视掉。
 */
export function describeSecretNoise(removed: SecretNoise[]): string {
  if (!removed.length) return "";
  const what = removed.map((kind) => SECRET_NOISE_LABELS[kind]).join("、");
  return `粘进来的内容里有${what}，已自动去掉。`;
}

/** 三段、点号分隔、只有 base64url 的字母表——秒哒那把匿名 key 就是这个形状。 */
export function looksLikeJwt(value: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

/**
 * 打码。**首尾各留几个字符**：既认得出是不是自己要填的那一把，又贴不出去。
 * 短到打码没意义的（多半是填错了）就整串盖掉——泄密的风险不值这点方便。
 */
export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 12) return "·".repeat(value.length);
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/**
 * 填进去的到底是个什么东西，一句话。**密钥不回显，只描述形状**：
 * 「JWT（三段） · 218 字符 · eyJhbG…E4AA」。
 *
 * 这一句是「填对了没有」唯一能当场看见的反馈——否则人只能去点一次拉取，
 * 拿一个 401 回来，而 401 不告诉他是多了个换行还是复制少了半截。
 */
export function secretShape(value: string, expectJwt = false): string {
  if (!value) return "还没填。";
  const kind = looksLikeJwt(value)
    ? "JWT（三段，点号分隔）"
    : expectJwt
      ? "**不像 JWT**（正常应是 `eyJ…` 开头、两个点分成三段）——多半是复制少了半截，或者复制到了别的字段"
      : "自定义串";
  return `${kind} · ${value.length} 字符 · ${maskSecret(value)}`;
}

/** 这一段里有哪几类空白。只认名字，删是调用方的事。 */
function classifyWhitespace(text: string, noise: Set<SecretNoise>): void {
  if (/[\r\n]/.test(text)) noise.add("newline");
  if (/\t/.test(text)) noise.add("tab");
  // 全角空格、不断行空格都算「空格」：人分不出它们，也不需要分。
  if (/[^\S\r\n\t]/.test(text)) noise.add("space");
}

/**
 * 剥掉成对的包裹符。**里面还有同款引号就不剥**：`"apikey": "eyJ…"` 这种一整行，
 * 首尾确实各是一个双引号，但它们不是一对——照剥会剥出 `apikey": "eyJ…` 这种废话。
 * 那一行该先被 `LABEL` 咬掉键名，下一轮再来剥剩下的那一对。
 */
function stripQuotes(value: string): string {
  if (value.length < 2) return value;
  for (const [open, close] of QUOTE_PAIRS) {
    if (!value.startsWith(open) || !value.endsWith(close)) continue;
    const inner = value.slice(1, -1);
    if (inner.includes(open) || inner.includes(close)) return value;
    return inner;
  }
  return value;
}
