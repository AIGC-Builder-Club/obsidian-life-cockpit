// 秒哒「5 分钟写作」拉取层。出处（AME-272 第 26 条）：
//
//   「把秒哒应用——接口，给直接接过来？ 放到 Obsidian 的插件中去……
//    然后，存到 Obsidian vault 的相关【2A-META】的目录中……
//    1、比如，按日期来。日期之内，按大标题，放各个文章、档案。
//    2、这里，我更倾向于 保存到我的 Obsidian 里面，给人看的区域的。」
//
// 那个 APP 是什么，他自己写清楚了：
//
//   - **头脑风暴**——「借鉴了另一款 5 秒钟不写就会擦除所有记录的 GitHub 项目，
//     这个 APP 内 5 秒或 12 秒不写，内容就会被擦除」；
//   - **手机语音输入**——「受部分识别的影响」。
//
// 这两句话决定了这一层的形状：拉下来的是**毛坯**，不是成品。于是三条规矩：
//
//   1. **原文一个字不改**。识别错的字、断掉的句子、重复的段落，照抄进去。
//      这一层没有资格替他润色——润色是他自己（或以后某个 Agent）在候选区里干的事。
//   2. **落地区可以随手改、随手搬走**。他明说了「我可能会手动整理之后，放到飞书的
//      Excel 中的一些任务或者事项」。所以搬走了的段落**永远不会被再拉回来**——
//      同步索引记得哪一条写过，写过就不再补写（见 `planMiaodaSync` 与 `mergeMiaodaDay`）。
//   3. **重复拉取不写盘**。同一条拉十次得到同一份字节，交给 `writeIfChanged`
//      就是零写入——落在 2A-META 仓库里的东西不许给 Easy Git 制造空 commit。
//
// 远端是 Supabase 的 PostgREST（`writing_sessions` 表），字段是实测出来的、不是猜的：
// id / title / content / mode / status / countdown_seconds / char_count /
// started_at / updated_at / ended_at / copied_to_clipboard / shared_count /
// last_save_reason / created_at / target_achieved。

import { dayKeyFor, formatLocalIso } from "./ledger";

/** 同步索引的世代号。改了落盘形状就加一档。 */
export const MIAODA_INDEX_VERSION = 1;

/** 一段写作。字段名从远端的下划线转成驼峰，值一律不动。 */
export interface MiaodaSession {
  id: string;
  /** 远端自动取的正文开头，可能是半句话；空正文的那种这里也是空串 */
  title: string;
  content: string;
  /** classic / quick / voice；认不出来的原样留着，别把新枚举吃掉 */
  mode: string;
  /** writing / completed / interrupted / failed_saved */
  status: string;
  /** 5 或 12：几秒不写就擦。这个数字就是「头脑风暴」那层压迫感本身 */
  countdownSeconds: number;
  charCount: number;
  /** ISO 时刻，远端给的是 UTC */
  startedAt: string;
  endedAt: string;
  updatedAt: string;
  createdAt: string;
  copiedToClipboard: boolean;
  sharedCount: number;
  lastSaveReason: string;
  targetAchieved: boolean;
}

export const MIAODA_MODE_LABELS: Readonly<Record<string, string>> = {
  classic: "经典",
  quick: "快速",
  voice: "语音",
};

export const MIAODA_STATUS_LABELS: Readonly<Record<string, string>> = {
  writing: "还在写",
  completed: "写完了",
  interrupted: "中断",
  // 这一档正是那个「不写就擦」的机制留下的痕迹：倒计时归零了，但内容还是存下来了。
  failed_saved: "没撑住（内容仍存下来了）",
};

export const MIAODA_SAVE_REASON_LABELS: Readonly<Record<string, string>> = {
  manual_end_copy: "手动结束并复制",
  manual_end_copy_after_achieved: "达标后手动结束并复制",
  manual_end_share: "手动结束并分享",
  countdown_failed: "倒计时归零",
  target_achieved: "达标",
  background_interrupt: "切到后台",
  leave_page: "离开页面",
  debounce: "自动保存",
  snapshot: "快照",
};

/** 认不出来的枚举值原样返回——远端加了新档位，这里不该把它显示成空白。 */
function label(table: Readonly<Record<string, string>>, value: string): string {
  return table[value] ?? value;
}

export function miaodaModeLabel(mode: string): string {
  return label(MIAODA_MODE_LABELS, mode);
}

export function miaodaStatusLabel(status: string): string {
  return label(MIAODA_STATUS_LABELS, status);
}

export function miaodaSaveReasonLabel(reason: string): string {
  return label(MIAODA_SAVE_REASON_LABELS, reason);
}

// ---------------------------------------------------------------------------
// 读远端
// ---------------------------------------------------------------------------

/** 一整份响应。读不动返回 null，由调用方决定说什么。 */
export function parseMiaodaRows(text: string): MiaodaSession[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  // PostgREST 正常返回裸数组；出错时返回 `{ message, code }` 那种对象——
  // 那不是「零条」，是「没读到」，所以只认数组。
  if (!Array.isArray(raw)) return null;
  return raw.map(normalizeMiaodaSession).filter((session) => session.id !== "");
}

export function normalizeMiaodaSession(raw: unknown): MiaodaSession {
  const source = (raw ?? {}) as Record<string, unknown>;
  const startedAt = str(source.started_at) || str(source.created_at);
  return {
    id: str(source.id).trim(),
    title: str(source.title).trim(),
    content: str(source.content),
    mode: str(source.mode).trim(),
    status: str(source.status).trim(),
    countdownSeconds: num(source.countdown_seconds),
    // 远端自己算好的字数照用；没给就现数一遍，别在面板上留一个空洞。
    charCount: num(source.char_count) || str(source.content).length,
    startedAt,
    endedAt: str(source.ended_at),
    updatedAt: str(source.updated_at) || startedAt,
    createdAt: str(source.created_at) || startedAt,
    copiedToClipboard: source.copied_to_clipboard === true,
    sharedCount: num(source.shared_count),
    lastSaveReason: str(source.last_save_reason).trim(),
    targetAchieved: source.target_achieved === true,
  };
}

/** 一段写作有没有正文。空的那种是「点开了又没写」，默认不落盘（见 `planMiaodaSync`）。 */
export function isMiaodaEmpty(session: MiaodaSession): boolean {
  return session.content.trim() === "";
}

/**
 * 这一段属于哪一天。**按「开始写」那一刻算，不按 `updated_at`**——
 * 实测远端会因为一次批量迁移把几十条旧记录的 `updated_at` 全推到同一天，
 * 拿它分桶的话，七月的那些头脑风暴会整片掉进八月的某一页里。
 *
 * 换日点复用驾驶舱的账本日（默认 04:00）：运行区里番茄流水、积分、复盘全按这个口径，
 * 深夜两点的那一段该跟着当天走。要纯日历日的把 `rolloverHour` 传 0。
 */
export function miaodaDayOf(session: MiaodaSession, rolloverHour: number): string {
  const date = new Date(session.startedAt);
  if (Number.isNaN(date.getTime())) return "";
  return dayKeyFor(date, rolloverHour);
}

export interface MiaodaQuery {
  /** 只要这个时刻**之后**（含）更新过的。留空 = 整份拉 */
  since?: string;
  limit: number;
  offset: number;
}

/**
 * 拼一次请求的地址。
 *
 * 两个地方和 issue 里那条原始 `fetch` 不一样，都是有意的：
 *
 *   1. **按 `updated_at` 升序**，不是降序。分页要的是一个稳定次序，而降序 + offset
 *      在拉的过程中来了新记录就会漏掉一条（新的挤进第一页，原第一页的末尾被顶到第二页）。
 *   2. **增量靠 `updated_at=gte.<上次最新的>`**，不是靠把 limit 调大。他问的是
 *      「其实可以，把 limit 放大一点、或者删除？」——可以，但那是每次都把整张表搬一遍。
 *      记住上次拉到哪儿，之后每次只拉动过的那几条，两百条也好两万条也好都一样快。
 *      用 `gte` 而不是 `gt` 是为了不丢同一毫秒里的第二条；重复的那条由同步索引挡掉。
 */
export function miaodaPullUrl(endpoint: string, query: MiaodaQuery): string {
  const base = endpoint.trim().replace(/\?.*$/, "").replace(/\/+$/, "");
  const parts = [
    "select=*",
    "order=updated_at.asc",
    `limit=${Math.max(1, Math.round(query.limit))}`,
    `offset=${Math.max(0, Math.round(query.offset))}`,
  ];
  if (query.since) parts.push(`updated_at=gte.${encodeURIComponent(query.since)}`);
  return `${base}?${parts.join("&")}`;
}

// ---------------------------------------------------------------------------
// 同步索引
//
// 这一份 JSON 是「不复活」这条规矩的全部实现：它记住哪一条写过、写去了哪一天、
// 写的是哪个版本。人把某一段搬去飞书、然后从落地页里删掉之后，下一次拉取会看到
// 「这条我写过」，于是**不再补写**——落地区因此是可以清空的，而不是一个每次拉取
// 都会长回来的收件箱。
// ---------------------------------------------------------------------------

export interface MiaodaIndexEntry {
  /** 写去了哪一天那一页 */
  day: string;
  /** 写下去的是哪个版本的 `updated_at` */
  updatedAt: string;
}

export interface MiaodaIndex {
  schemaVersion: number;
  generator: string;
  /** 见过的最新 `updated_at`，下一次增量从这儿接着拉 */
  lastUpdatedAt: string;
  sessions: Record<string, MiaodaIndexEntry>;
}

export function createMiaodaIndex(generator: string): MiaodaIndex {
  return { schemaVersion: MIAODA_INDEX_VERSION, generator, lastUpdatedAt: "", sessions: {} };
}

export function parseMiaodaIndex(text: string | null, generator: string): MiaodaIndex {
  if (text === null) return createMiaodaIndex(generator);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // 读不动就当没有：大不了把整份重拉一次，写盘幂等，不会写出重复段落。
    return createMiaodaIndex(generator);
  }
  const source = (raw ?? {}) as Record<string, unknown>;
  const sessions: Record<string, MiaodaIndexEntry> = {};
  const bag = (source.sessions ?? {}) as Record<string, unknown>;
  for (const [id, value] of Object.entries(bag)) {
    const entry = (value ?? {}) as Record<string, unknown>;
    const day = str(entry.day);
    const updatedAt = str(entry.updatedAt);
    if (!id || !day) continue;
    sessions[id] = { day, updatedAt };
  }
  return {
    schemaVersion: MIAODA_INDEX_VERSION,
    generator,
    lastUpdatedAt: str(source.lastUpdatedAt),
    sessions,
  };
}

/**
 * 序列化。**key 顺序手写死、id 排序**——顺序飘一下就是一次假写入，
 * 而这份文件落在 2A-META 仓库里，假写入等于给 Easy Git 制造空 commit。
 */
export function serializeMiaodaIndex(index: MiaodaIndex): string {
  const ids = Object.keys(index.sessions).sort();
  const sessions: Record<string, MiaodaIndexEntry> = {};
  for (const id of ids) {
    sessions[id] = { day: index.sessions[id].day, updatedAt: index.sessions[id].updatedAt };
  }
  return `${JSON.stringify(
    {
      schemaVersion: index.schemaVersion,
      generator: index.generator,
      lastUpdatedAt: index.lastUpdatedAt,
      sessions,
    },
    null,
    2,
  )}\n`;
}

// ---------------------------------------------------------------------------
// 拉回来之后怎么落
// ---------------------------------------------------------------------------

/** 新的 = 从没写过；更新 = 写过，但远端又动了 */
export type MiaodaChange = "new" | "updated";

export interface MiaodaPlanItem {
  session: MiaodaSession;
  change: MiaodaChange;
  day: string;
  /** 索引里记着的旧落点；跨天了要先把旧的那一份处理掉 */
  previousDay: string;
}

export interface MiaodaSyncPlan {
  /** 按天分组，天内按开始时间升序——落盘顺序就是写作顺序 */
  byDay: { day: string; items: MiaodaPlanItem[] }[];
  /** 远端有、但和索引里记的一模一样：一个字节都不用动 */
  unchanged: number;
  /** 空白记录（点开了没写）。默认不落盘，但要报数——不能让人以为丢了 */
  skippedEmpty: number;
  /** 时间戳坏掉、分不出属于哪一天的 */
  skippedUndated: number;
  /** 这一批里最新的 `updated_at`，写回索引 */
  latestUpdatedAt: string;
}

export interface MiaodaPlanOptions {
  rolloverHour: number;
  /** 连空白记录也要 */
  includeEmpty: boolean;
}

export function planMiaodaSync(
  sessions: MiaodaSession[],
  index: MiaodaIndex,
  options: MiaodaPlanOptions,
): MiaodaSyncPlan {
  const days = new Map<string, MiaodaPlanItem[]>();
  let unchanged = 0;
  let skippedEmpty = 0;
  let skippedUndated = 0;
  let latestUpdatedAt = index.lastUpdatedAt;

  for (const session of sessions) {
    // 空白的那 27 条不进索引：以后他要是把开关打开，这些还得拉得到。
    if (!options.includeEmpty && isMiaodaEmpty(session)) {
      skippedEmpty += 1;
      continue;
    }
    const day = miaodaDayOf(session, options.rolloverHour);
    if (!day) {
      skippedUndated += 1;
      continue;
    }
    if (session.updatedAt > latestUpdatedAt) latestUpdatedAt = session.updatedAt;

    const known = index.sessions[session.id];
    if (known && known.updatedAt === session.updatedAt && known.day === day) {
      unchanged += 1;
      continue;
    }
    const item: MiaodaPlanItem = {
      session,
      change: known ? "updated" : "new",
      day,
      previousDay: known?.day ?? "",
    };
    const bucket = days.get(day);
    if (bucket) bucket.push(item);
    else days.set(day, [item]);
  }

  const byDay = [...days.entries()]
    .map(([day, items]) => ({
      day,
      items: items.sort((a, b) => a.session.startedAt.localeCompare(b.session.startedAt)),
    }))
    .sort((a, b) => a.day.localeCompare(b.day));

  return { byDay, unchanged, skippedEmpty, skippedUndated, latestUpdatedAt };
}

// ---------------------------------------------------------------------------
// 一天一页的 Markdown
// ---------------------------------------------------------------------------

/** 每一段正文上面那一行的锚。解析、更新、判「还在不在」全靠它。 */
const ID_PREFIX = "- 秒哒ID：";
const UPDATED_PREFIX = "- 远端更新于 ";

export interface MiaodaSection {
  /** 认不出 id 的段落（他自己手写的、或正文里恰好有个二级标题）这里是空串 */
  id: string;
  /** 连标题带正文的原文，末尾不带空行 */
  text: string;
}

export interface MiaodaDayFile {
  /** 第一个段落之前的那一段（页首那两行说明）。人改过就照他改的留着 */
  preamble: string;
  sections: MiaodaSection[];
}

/**
 * 把一天那一页拆回段落。
 *
 * **段落的边界不是「一个二级标题」，是「一个后面跟着秒哒ID 的二级标题」。**
 * 这条判断换来两件事：正文里恰好有一行以 `## ` 开头时不会被劈成两段；
 * 他自己在某一段里加的小标题，也仍然算那一段的一部分，不会变成孤儿。
 */
export function parseMiaodaDay(text: string | null): MiaodaDayFile {
  if (text === null || text.trim() === "") return { preamble: "", sections: [] };
  const lines = text.split("\n");
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith("## ")) continue;
    if (idAfter(lines, i) !== "") starts.push(i);
  }
  if (!starts.length) return { preamble: trimTail(text), sections: [] };

  const sections: MiaodaSection[] = [];
  for (let n = 0; n < starts.length; n += 1) {
    const from = starts[n];
    const to = n + 1 < starts.length ? starts[n + 1] : lines.length;
    sections.push({
      id: idAfter(lines, from),
      text: trimTail(lines.slice(from, to).join("\n")),
    });
  }
  return { preamble: trimTail(lines.slice(0, starts[0]).join("\n")), sections };
}

/** 标题往下找 id 行。只看紧跟着的头几行——隔了正文的那种不算这一段的身份证。 */
function idAfter(lines: string[], headingIndex: number): string {
  for (let i = headingIndex + 1; i < Math.min(lines.length, headingIndex + 5); i += 1) {
    const line = lines[i];
    if (line.startsWith("## ")) return "";
    if (line.startsWith(ID_PREFIX)) return line.slice(ID_PREFIX.length).replace(/`/g, "").trim();
  }
  return "";
}

/** 段落上记着的远端版本。索引丢了的时候靠它判「远端是不是又动了」。 */
export function sectionUpdatedAt(text: string): string {
  for (const line of text.split("\n")) {
    if (line.startsWith(UPDATED_PREFIX)) return line.slice(UPDATED_PREFIX.length).trim();
  }
  return "";
}

export interface MiaodaRenderOptions {
  /** 换日点，写进页首那行说明，免得他对着 00:30 的那一段发愣 */
  rolloverHour: number;
}

/**
 * 一段写作 → 一个大标题加一段正文。
 *
 * 标题是「时间 · 模式 · 开头几个字」：远端那个 `title` 是正文前二十来个字截出来的，
 * 单看经常是半句话，所以它只能当线索，不能当标题的全部。
 */
export function renderMiaodaSection(session: MiaodaSession): string {
  const started = new Date(session.startedAt);
  const heading = `## ${clock(started)} · ${miaodaModeLabel(session.mode)} · ${headline(session)}`;
  const facts = [`${session.charCount} 字`, `擦除倒计时 ${session.countdownSeconds} 秒`];
  const span = duration(session);
  if (span) facts.unshift(span);

  const marks = [miaodaStatusLabel(session.status)];
  if (session.targetAchieved) marks.push("达标");
  if (session.lastSaveReason) marks.push(`保存于「${miaodaSaveReasonLabel(session.lastSaveReason)}」`);
  if (session.sharedCount > 0) marks.push(`分享过 ${session.sharedCount} 次`);

  const lines = [
    heading,
    "",
    `${ID_PREFIX}\`${session.id}\``,
    `- ${timeRange(session)}${facts.length ? ` · ${facts.join(" · ")}` : ""}`,
    `- ${marks.join(" · ")}`,
    `${UPDATED_PREFIX}${localIso(session.updatedAt)}`,
    "",
  ];
  // 正文照抄。识别错的字也留着——「受部分识别的影响」是他自己写在需求里的前提，
  // 而不是一个要在这一层修掉的缺陷。
  lines.push(session.content.replace(/\s+$/, ""));
  return trimTail(lines.join("\n"));
}

function headline(session: MiaodaSession): string {
  const source = session.title || session.content;
  const first = source.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
  const clipped = first.length > 24 ? `${first.slice(0, 24)}…` : first;
  return clipped || "（没有正文）";
}

/** 页首那两行。**不带任何每次都变的东西**（没有「拉取于」），否则每拉一次都是一次假写入。 */
export function renderMiaodaPreamble(day: string, options: MiaodaRenderOptions): string {
  const rollover = String(options.rolloverHour).padStart(2, "0");
  return [
    `> 秒哒「5 分钟写作」· ${day}（账本日，${rollover}:00 换日）· 由【人生驾驶舱】拉取。`,
    "> 一段写作一个大标题，原文一字未改（语音识别的错字也照抄）。" +
      "这一页是给人看的落地区：随手改、随手搬走都行，**搬走的段落不会被再拉回来**。",
  ].join("\n");
}

export interface MiaodaMergeResult {
  text: string;
  added: number;
  updated: number;
  /** 索引里说写过、页面上却找不着了：他搬走了。**不补写**，只报数 */
  vanished: number;
}

/**
 * 把这一批段落并进已经有的那一页。
 *
 * 三条分支，每一条都对应一种真实发生的情况：
 *
 *   - **没见过的** → 追加到末尾。这一批已按开始时间排好序，所以追加就是按时间排。
 *   - **见过、还在页面上** → 原地换掉。远端又动过才会走到这儿（见 `planMiaodaSync`），
 *     所以覆盖的是一份确实过期的正文。
 *   - **见过、页面上没有了** → **什么都不做**。他把这一段搬去飞书或者别处了，
 *     再写回来就是在跟他打架。
 *
 * 他自己手写的段落（认不出 id 的）原地不动，一个字都不碰。
 */
export function mergeMiaodaDay(
  day: string,
  existing: string | null,
  items: MiaodaPlanItem[],
  options: MiaodaRenderOptions,
): MiaodaMergeResult {
  const file = parseMiaodaDay(existing);
  const sections = file.sections.slice();
  const at = new Map<string, number>();
  sections.forEach((section, index) => {
    if (section.id) at.set(section.id, index);
  });

  let added = 0;
  let updated = 0;
  let vanished = 0;

  for (const item of items) {
    const rendered = renderMiaodaSection(item.session);
    const index = at.get(item.session.id);
    if (index !== undefined) {
      if (sections[index].text !== rendered) updated += 1;
      sections[index] = { id: item.session.id, text: rendered };
      continue;
    }
    if (item.change === "updated") {
      // 索引说写过，页面上却没有——搬走了。不复活。
      vanished += 1;
      continue;
    }
    at.set(item.session.id, sections.length);
    sections.push({ id: item.session.id, text: rendered });
    added += 1;
  }

  const preamble = file.preamble || renderMiaodaPreamble(day, options);
  const body = sections.map((section) => section.text).join("\n\n");
  return { text: `${[preamble, body].filter(Boolean).join("\n\n")}\n`, added, updated, vanished };
}

export interface MiaodaRemoveResult {
  text: string;
  removed: number;
  /** 拿掉之后这一页只剩页首说明了——那就该把文件删掉，别留一页空壳 */
  empty: boolean;
}

/**
 * 从某一天那一页里摘掉几段。**只在「这一段换天了」时用**：换日点改过（04:00 → 00:00）
 * 之后，深夜那几段属于哪一天会整体挪位，这时候必须先从旧的那一页拿走，
 * 否则同一段会在两页里各留一份。
 */
export function removeMiaodaSections(text: string | null, ids: Set<string>): MiaodaRemoveResult {
  const file = parseMiaodaDay(text);
  const kept = file.sections.filter((section) => !section.id || !ids.has(section.id));
  const removed = file.sections.length - kept.length;
  if (!kept.length) return { text: "", removed, empty: true };
  const body = kept.map((section) => section.text).join("\n\n");
  return { text: `${[file.preamble, body].filter(Boolean).join("\n\n")}\n`, removed, empty: false };
}

// ---------------------------------------------------------------------------
// 给人看的那一行
// ---------------------------------------------------------------------------

export interface MiaodaReport {
  added: number;
  updated: number;
  unchanged: number;
  vanished: number;
  skippedEmpty: number;
  days: string[];
}

export function describeMiaodaReport(report: MiaodaReport): string {
  const parts: string[] = [];
  if (report.added) parts.push(`新写 ${report.added} 段`);
  if (report.updated) parts.push(`更新 ${report.updated} 段`);
  if (report.unchanged) parts.push(`没动 ${report.unchanged} 段`);
  if (report.vanished) parts.push(`${report.vanished} 段你已经搬走了，没有补回去`);
  if (report.skippedEmpty) parts.push(`跳过 ${report.skippedEmpty} 条空白记录`);
  if (!parts.length) return "秒哒：远端没有新东西。";
  const days = report.days.length
    ? `，落在 ${report.days.length} 天（${report.days[0]}${
        report.days.length > 1 ? ` … ${report.days[report.days.length - 1]}` : ""
      }）`
    : "";
  return `秒哒：${parts.join("、")}${days}。`;
}

// ---------------------------------------------------------------------------

function timeRange(session: MiaodaSession): string {
  const started = new Date(session.startedAt);
  if (!session.endedAt) return `${clock(started)} 起`;
  return `${clock(started)} → ${clock(new Date(session.endedAt))}`;
}

function duration(session: MiaodaSession): string {
  if (!session.endedAt) return "";
  const ms = new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
}

function clock(date: Date): string {
  if (Number.isNaN(date.getTime())) return "??:??";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 远端给的是 UTC，落盘写本地时间——他看的是自己几点写的，不是格林尼治几点。 */
function localIso(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : formatLocalIso(date);
}

function trimTail(text: string): string {
  return text.replace(/\s+$/, "");
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
