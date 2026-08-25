// AI 调用留痕。出处（AME-258 第 22.1 条）：
//
//   「目前 Flash 的执行————其实我看不到【请求和返回】，这样，如果出现了错误或者偏离；
//    我是意识不到的？（可能，需要存储 N 天之内的记录，在本地；然后插件设置里，
//    有一个开关，可以简单列表式的预览一下。）」
//
// 这一层是**纯数据**：记什么、怎么裁、留几天、一行怎么写。真正落盘在 `main.ts`
// （走适配器写插件自己的目录），发请求在 `../ai-client.ts`。
//
// 三条规矩：
//
//   1. **密钥一个字符都不进日志。** `Authorization` 头在这里被整条摘掉，不是打码——
//      打码过的密钥仍然会连同前缀一起进版本库、进备份、进别人的截图。
//      `test/ai-log.test.js` 有一条专门守着这件事。
//   2. **落在插件自己的目录里，不落运行区。** 运行区在 2A-META 仓库内，而那个仓库是
//      公开的；请求正文里有当天的番茄、目标、飞书条目，那是私事。插件目录
//      （`.obsidian/plugins/life-cockpit/`）和 `data.json` 同一个地方，不随仓库走。
//   3. **失败比成功更值得记。** 「看不到偏离」这件事，靠的就是失败那几条——所以
//      HTTP 报错、空正文、根本没发出去，全都记，并且记原因。
//
// 一天一份文件，过期整份删。**不做单文件滚动裁剪**：一份写了一半的日志比没有日志更糟，
// 而按天分文件时「删掉过期的那一份」是一个原子动作。

/** 一次调用留下的一条。字段顺序就是详情页从上到下的顺序。 */
export interface AiLogEntry {
  /** `20260818-153012-1`，同一秒内多条也不会撞 */
  id: string;
  /** ISO 时间戳 */
  at: string;
  /** 哪一档发的（档位名）。换档之后回看得知道当时用的是哪个 */
  profile: string;
  /** 服务端自报的模型名；没发出去就是空串 */
  model: string;
  /** 谁要它跑的：`复盘草稿` / `测一次连接` / …… */
  purpose: string;
  url: string;
  ok: boolean;
  /** HTTP 状态码；请求没发出去（DNS、超时、缺配置）时是 null */
  status: number | null;
  durationMs: number;
  /** 成功时是模型名 + 用量，失败时是那句「为什么失败」 */
  detail: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 发出去的消息，拼成人能读的一段 */
  request: string;
  /** 收回来的正文 */
  response: string;
}

/** 插件目录下的日志目录名。和 data.json 同级。 */
export const AI_LOG_DIR = "ai-log";

/** 一条记录里请求 / 返回正文各留多少字符。再长的部分裁掉并标出来。 */
export const AI_LOG_TEXT_LIMIT = 4000;

/** 一天最多留几条。超了丢最老的——今天的最后几次调用才是要查的那几次。 */
export const AI_LOG_MAX_PER_DAY = 200;

export function aiLogPath(dir: string, day: string): string {
  return `${dir.replace(/\/+$/, "")}/${AI_LOG_DIR}/${day}.json`;
}

/** `2026-08-18.json` → `2026-08-18`；不是日志文件名返回空串。 */
export function aiLogDayOf(fileName: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(fileName.trim());
  return match ? match[1] : "";
}

/**
 * 哪几天该删。`keepDays` 从今天倒数——`keepDays = 7` 表示今天连同前面 6 天留着。
 *
 * **`keepDays <= 0` 一份都不留**（等于「记录但立刻清掉」，那是个没有意义的配置，
 * 所以设置那一侧的下限是 1）；这里照实现，不替调用方兜。
 */
export function expiredAiLogDays(days: string[], today: string, keepDays: number): string[] {
  const keep = Math.max(0, Math.round(keepDays));
  const floor = shiftDay(today, -(keep - 1));
  return days.filter((day) => day !== "" && (keep === 0 || day < floor)).sort();
}

/** `2026-08-18` 挪 n 天。只做日期算术，不碰时区。 */
export function shiftDay(day: string, delta: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!match) return day;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() + delta);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** 新的排前面：详情页和设置页里的预览都是「最近几条」，倒序省得每处再排一遍。 */
export function appendAiLogEntry(
  entries: AiLogEntry[],
  entry: AiLogEntry,
  maxPerDay = AI_LOG_MAX_PER_DAY,
): AiLogEntry[] {
  const limit = Math.max(1, Math.round(maxPerDay));
  return [entry, ...entries].slice(0, limit);
}

export function parseAiLog(text: string): AiLogEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as Record<string, unknown> | null)?.entries)
      ? ((raw as Record<string, unknown>).entries as unknown[])
      : [];
  return list.map(normalizeEntry).filter((entry) => entry.at !== "");
}

export function serializeAiLog(entries: AiLogEntry[]): string {
  return `${JSON.stringify(entries, null, 2)}\n`;
}

function normalizeEntry(raw: unknown): AiLogEntry {
  const source = (raw ?? {}) as Record<string, unknown>;
  return {
    id: str(source.id),
    at: str(source.at),
    profile: str(source.profile),
    model: str(source.model),
    purpose: str(source.purpose),
    url: str(source.url),
    ok: source.ok === true,
    status: typeof source.status === "number" && Number.isFinite(source.status) ? source.status : null,
    durationMs: num(source.durationMs),
    detail: str(source.detail),
    promptTokens: num(source.promptTokens),
    completionTokens: num(source.completionTokens),
    totalTokens: num(source.totalTokens),
    request: str(source.request),
    response: str(source.response),
  };
}

/**
 * 把消息拼成人能读的一段。**不做 JSON.stringify**：要查的是「它到底被问了什么」，
 * 而一坨转义过的 JSON 谁都读不下去。
 */
export function formatAiMessages(
  messages: { role: string; content: string }[],
  limit = AI_LOG_TEXT_LIMIT,
): string {
  const text = messages
    .map((message) => `【${message.role}】\n${message.content}`)
    .join("\n\n");
  return clipForLog(text, limit);
}

/** 裁长文本，并且**把裁掉的事实写在正文里**——看不出被裁过的日志会让人误判。 */
export function clipForLog(text: string, limit = AI_LOG_TEXT_LIMIT): string {
  const max = Math.max(200, Math.round(limit));
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n……（还有 ${text.length - max} 个字符，日志里裁掉了）`;
}

/**
 * 请求头里能进日志的那些。**`Authorization` 直接不返回**——
 * 日志会被截图、会被贴进 issue，密钥一旦进去就等于泄露。
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (/^authorization$/i.test(key) || /api[-_]?key/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

/** 列表里的一行。**先说成没成、再说花了多久**——这两件是回看时唯一要一眼看到的。 */
export function describeAiLogEntry(entry: AiLogEntry): string {
  const time = entry.at.slice(11, 19) || entry.at;
  const mark = entry.ok ? "✓" : "✗";
  const cost = entry.durationMs > 0 ? ` · ${(entry.durationMs / 1000).toFixed(1)}s` : "";
  const tokens = entry.totalTokens > 0 ? ` · ${entry.totalTokens} tokens` : "";
  return `${mark} ${time} · ${entry.purpose || "调用"}${cost}${tokens}`;
}

/** 设置页那一行汇总。**失败条数单独说**：那才是打开这个开关的理由。 */
export function summarizeAiLog(entries: AiLogEntry[]): string {
  if (!entries.length) return "还没有记录。跑一次复盘或者按一下【测一次连接】就有了。";
  const failed = entries.filter((entry) => !entry.ok).length;
  const tokens = entries.reduce((sum, entry) => sum + entry.totalTokens, 0);
  const parts = [`最近 ${entries.length} 条`];
  parts.push(failed ? `其中 ${failed} 条没成` : "全都成了");
  if (tokens > 0) parts.push(`合计 ${tokens} tokens`);
  return `${parts.join(" · ")}。`;
}

// ---------------------------------------------------------------------------

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
