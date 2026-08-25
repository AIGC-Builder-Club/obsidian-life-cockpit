// 夜班候选区的候选项：解析、序列化、三个拍板动作（采纳 / 打回 / 改写）。
//
// 落盘格式钉死在 docs/资讯_投喂口_收件箱_候选区/资讯收件箱与候选区-约定.md v1。S1（tools/news-inbox）往候选区写、
// 这里读，两边共用同一份约定，所以 key 顺序、引号规则都得逐字节对齐——差一个字节，
// 夜班重跑就会刷出一个空 commit。那边是 ESM 的 node 工具、这边是插件的 core
// （不许 import "obsidian"），没法共用一份代码，只能各写一遍：改任何一边之前先看约定文档。
//
// 两条硬要求和 R1 / R2 / R3 一样：
//   1. 写盘幂等——同样的候选项序列化出同样的字节；
//   2. 不静默丢东西——约定之外的 frontmatter 键原样带着走，改写过的原正文留在文末。

import { formatLocalIso } from "./ledger";

export type YamlScalar = string | number | boolean;
export type YamlItem = YamlScalar | Record<string, YamlScalar>;
export type YamlValue = YamlScalar | YamlItem[];

export const CANDIDATE_PENDING = "待拍板";
export const CANDIDATE_ADOPTED = "已采纳";
export const CANDIDATE_REJECTED = "已打回";
export const CANDIDATE_REWRITTEN = "已改写";

export type CandidateAction = "采纳" | "打回" | "改写";

export const CANDIDATE_ACTIONS: CandidateAction[] = ["采纳", "打回", "改写"];

/** 类型是「按落点分派处理器」的开关。认不出来的类型按普通笔记处理。 */
export const CANDIDATE_TYPES = ["news-digest", "goal-node", "ledger-entry", "note"];

export const CANDIDATE_TYPE_LABELS: Record<string, string> = {
  "news-digest": "资讯总结",
  "goal-node": "目标树节点",
  "ledger-entry": "账本一笔",
  note: "普通笔记",
};

/** 改写时原正文搬到这一节下面，不覆盖、不删除。 */
export const ORIGINAL_SECTION = "## 原始产物";

/** frontmatter 的 key 顺序写死，写盘幂等靠它。和 S1 的 FIELD_ORDER 一致。 */
const FIELD_ORDER = [
  "候选ID",
  "来源",
  "生成时间",
  "目标落点",
  "一句话说明",
  "状态",
  "类型",
  "层级",
  "覆盖条目",
  "溯源",
  "裁决",
];

const DECISION_ORDER = ["动作", "时间", "操作者", "理由", "落点"];

export interface CandidateDecision {
  action: string;
  at: string;
  actor: string;
  /** 打回时给下一轮 Agent 看的那句话 */
  reason: string | null;
  /** 采纳时实际写入的路径；没有落点的候选项是空串 */
  landing: string | null;
  /** 约定之外的键，原样带着走 */
  extras: Record<string, YamlScalar>;
}

export interface Candidate {
  id: string;
  source: string;
  generatedAt: string;
  /** 采纳后写到哪。空串是合法的：这条只给人看，没有落点 */
  target: string;
  summary: string;
  /** 待拍板 / 已采纳 / 已打回 / 已改写；认不出来的原样留着，不归一 */
  status: string;
  type: string;
  level: number | null;
  coverage: number | null;
  trace: string[];
  decisions: CandidateDecision[];
  /** 约定之外的 frontmatter 键，原样带着走，不替夜班删 */
  extras: Record<string, YamlValue>;
  extraOrder: string[];
  body: string;
}

// ---------------------------------------------------------------------------
// 解析。只认约定里用到的 YAML 子集：`键: 值`、`键:` + `  - 列表项`、
// 以及列表项下的 `    子键: 值`（拍板留痕用）。不引 YAML 库——候选项是人可编辑的文本，
// 解析器越小越好排错，出格的写法宁可原样当字符串留着。
// ---------------------------------------------------------------------------

/**
 * 键必须是「冒号 + 空白」或「冒号 + 行尾」。冒号后面紧跟非空白的一律当标量——
 * `sha256:1a2b`、`goal:g-7` 这些值都长这样，按 `键: 值` 去读会把它们变成对象。
 */
const KEY_VALUE = /^([^:]+):(?:[ \t]+([\s\S]*))?$/;

export function parseCandidate(text: string): Candidate {
  const { fields, order, body } = parseFrontmatter(text);
  const extras: Record<string, YamlValue> = {};
  const extraOrder: string[] = [];
  for (const key of order) {
    if (FIELD_ORDER.includes(key)) continue;
    extras[key] = fields[key];
    extraOrder.push(key);
  }

  const level = numberOrNull(fields["层级"]);
  const coverage = numberOrNull(fields["覆盖条目"]);
  // 数字位上写了别的东西：不认得就别硬塞，原样搬到 extras 里留着。
  if (level === null && fields["层级"] !== undefined) keepRaw(extras, extraOrder, "层级", fields["层级"]);
  if (coverage === null && fields["覆盖条目"] !== undefined) {
    keepRaw(extras, extraOrder, "覆盖条目", fields["覆盖条目"]);
  }

  return {
    id: text_(fields["候选ID"]),
    source: text_(fields["来源"]),
    generatedAt: text_(fields["生成时间"]),
    target: text_(fields["目标落点"]),
    summary: text_(fields["一句话说明"]),
    status: text_(fields["状态"]) || CANDIDATE_PENDING,
    type: text_(fields["类型"]),
    level,
    coverage,
    trace: Array.isArray(fields["溯源"]) ? fields["溯源"].map((item) => text_(item as YamlValue)) : [],
    decisions: parseDecisions(fields["裁决"]),
    extras,
    extraOrder,
    body,
  };
}

/**
 * 写回一份候选项。key 顺序照约定钉死，认不出来的键排在最后原样写回。
 *
 * 空掉的可选字段（`类型` / `层级` / `覆盖条目` / 空的 `溯源`）不写——它们不带信息，
 * 省掉只影响观感。必填的五项一律写出来，哪怕是空串：约定说「缺的字段由工具补」。
 */
export function serializeCandidate(candidate: Candidate): string {
  const lines = ["---"];
  emit(lines, "候选ID", candidate.id);
  emit(lines, "来源", candidate.source);
  emit(lines, "生成时间", candidate.generatedAt);
  emit(lines, "目标落点", candidate.target);
  emit(lines, "一句话说明", candidate.summary);
  emit(lines, "状态", candidate.status);
  if (candidate.type) emit(lines, "类型", candidate.type);
  if (candidate.level !== null) emit(lines, "层级", candidate.level);
  if (candidate.coverage !== null) emit(lines, "覆盖条目", candidate.coverage);
  if (candidate.trace.length) emit(lines, "溯源", candidate.trace);
  emit(lines, "裁决", candidate.decisions.map(decisionToItem));
  for (const key of candidate.extraOrder) {
    const value = candidate.extras[key];
    if (value !== undefined) emit(lines, key, value);
  }
  lines.push("---");
  return `${lines.join("\n")}\n\n${candidate.body.trim()}\n`;
}

// ---------------------------------------------------------------------------
// 三个拍板动作。都是纯函数：进一个候选项，出一个新的候选项，落盘交给 CandidateStore。
// 三个动作一律**追加**到 `裁决`，历史不覆盖。
// ---------------------------------------------------------------------------

export interface DecisionInput {
  at: Date;
  actor: string;
}

/** 采纳：状态改「已采纳」，补上实际写入的落点。没有落点时 `落点` 是空串。 */
export function adoptCandidate(
  candidate: Candidate,
  input: DecisionInput & { landing: string },
): Candidate {
  return withDecision(candidate, CANDIDATE_ADOPTED, {
    action: "采纳",
    at: formatLocalIso(input.at),
    actor: input.actor,
    reason: null,
    landing: input.landing,
    extras: {},
  });
}

/** 打回：理由是给下一轮 Agent 读的，所以它是必填。 */
export function rejectCandidate(
  candidate: Candidate,
  input: DecisionInput & { reason: string },
): Candidate {
  return withDecision(candidate, CANDIDATE_REJECTED, {
    action: "打回",
    at: formatLocalIso(input.at),
    actor: input.actor,
    reason: input.reason.trim(),
    landing: null,
    extras: {},
  });
}

/**
 * 改写：新正文写回本文件，原正文追加到文末《原始产物》一节下。
 *
 * 改写不是终局——改完还得采纳或打回，所以状态是「已改写」而不是「已采纳」。
 * 反复改写会在那一节下面一块块累加，每块带改写时间，不覆盖上一版。
 */
export function rewriteCandidate(
  candidate: Candidate,
  input: DecisionInput & { body: string; reason?: string },
): Candidate {
  const stamp = formatLocalIso(input.at);
  const { main, originals } = splitOriginalSection(candidate.body);
  const kept = originals.trim() || ORIGINAL_SECTION;
  const body = [
    input.body.trim(),
    "",
    kept.trimEnd(),
    "",
    `### 改写前 · ${stamp}`,
    "",
    main.trim() || "（原正文是空的）",
  ].join("\n");

  const next = withDecision(candidate, CANDIDATE_REWRITTEN, {
    action: "改写",
    at: stamp,
    actor: input.actor,
    reason: input.reason?.trim() || null,
    landing: null,
    extras: {},
  });
  return { ...next, body };
}

/** 把正文拆成「当前正文」和「原始产物那一节」两半；没有那一节时后者是空串。 */
export function splitOriginalSection(body: string): { main: string; originals: string } {
  const lines = body.split("\n");
  const index = lines.findIndex((line) => line.trim() === ORIGINAL_SECTION);
  if (index < 0) return { main: body, originals: "" };
  return { main: lines.slice(0, index).join("\n"), originals: lines.slice(index).join("\n") };
}

// ---------------------------------------------------------------------------
// 视图用的小工具
// ---------------------------------------------------------------------------

/** 还等着人拍板的：待拍板，以及改写过但还没落地的。 */
export function isPendingCandidate(candidate: Candidate): boolean {
  return candidate.status === CANDIDATE_PENDING || candidate.status === CANDIDATE_REWRITTEN;
}

export function candidateTitle(candidate: Candidate): string {
  const summary = candidate.summary.trim();
  if (summary) return summary;
  const heading = candidate.body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return (heading ?? "").replace(/^#+\s*/, "").trim() || candidate.id || "（没写说明的候选项）";
}

export function latestDecision(candidate: Candidate): CandidateDecision | null {
  return candidate.decisions.length ? candidate.decisions[candidate.decisions.length - 1] : null;
}

export function typeLabel(type: string): string {
  return CANDIDATE_TYPE_LABELS[type] ?? (type || "未标类型");
}

/** `[[目标树#^g-7]]` / `goal:g-7` / `g-7` 都认；指不到节点就返回 null。 */
export function goalIdFromTarget(target: string): string | null {
  const text = target.trim();
  if (!text) return null;
  const anchor = /\^([A-Za-z0-9-]+)/.exec(text);
  if (anchor) return anchor[1];
  const ref = /^goal:([A-Za-z0-9-]+)$/.exec(text);
  if (ref) return ref[1];
  return /^g-\d+$/.test(text) ? text : null;
}

// ---------------------------------------------------------------------------

function withDecision(
  candidate: Candidate,
  status: string,
  decision: CandidateDecision,
): Candidate {
  return { ...candidate, status, decisions: [...candidate.decisions, decision] };
}

function parseDecisions(value: YamlValue | undefined): CandidateDecision[] {
  if (!Array.isArray(value)) return [];
  const decisions: CandidateDecision[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, YamlScalar>;
    const extras: Record<string, YamlScalar> = {};
    for (const [key, raw] of Object.entries(record)) {
      if (!DECISION_ORDER.includes(key)) extras[key] = raw;
    }
    decisions.push({
      action: text_(record["动作"]),
      at: text_(record["时间"]),
      actor: text_(record["操作者"]),
      reason: record["理由"] === undefined ? null : text_(record["理由"]),
      landing: record["落点"] === undefined ? null : text_(record["落点"]),
      extras,
    });
  }
  return decisions;
}

function decisionToItem(decision: CandidateDecision): Record<string, YamlScalar> {
  const item: Record<string, YamlScalar> = {
    动作: decision.action,
    时间: decision.at,
    操作者: decision.actor,
  };
  if (decision.reason !== null) item["理由"] = decision.reason;
  if (decision.landing !== null) item["落点"] = decision.landing;
  for (const [key, value] of Object.entries(decision.extras)) item[key] = value;
  return item;
}

function keepRaw(
  extras: Record<string, YamlValue>,
  order: string[],
  key: string,
  value: YamlValue,
): void {
  if (order.includes(key)) return;
  extras[key] = value;
  order.push(key);
}

function numberOrNull(value: YamlValue | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function text_(value: YamlValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return "";
  return typeof value === "string" ? value : String(value);
}

// ---------------------------------------------------------------------------
// frontmatter 的读写。规则和 S1 的 frontmatter.js 一一对应。
// ---------------------------------------------------------------------------

export function parseFrontmatter(content: string): {
  fields: Record<string, YamlValue>;
  order: string[];
  body: string;
} {
  const text = String(content ?? "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  // frontmatter 都没有的裸 .md 也是合法条目，缺的字段由工具补，不由人补。
  if (!text.startsWith("---\n")) return { fields: {}, order: [], body: text.trim() };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { fields: {}, order: [], body: text.trim() };
  const head = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\n/, "");
  const { fields, order } = parseBlock(head.split("\n"));
  return { fields, order, body: body.trim() };
}

function parseBlock(lines: string[]): { fields: Record<string, YamlValue>; order: string[] } {
  const fields: Record<string, YamlValue> = {};
  const order: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "" || indentOf(line) > 0) {
      index += 1;
      continue;
    }
    const match = KEY_VALUE.exec(line.trim());
    if (!match) {
      index += 1;
      continue;
    }
    const key = match[1].trim();
    const inline = match[2] ?? "";
    if (!(key in fields)) order.push(key);

    if (inline !== "") {
      // `裁决: []` 是空列表，不是字符串。列表项里面不会出现这个写法，所以只在这儿认。
      fields[key] = inline.trim() === "[]" ? [] : parseScalar(inline);
      index += 1;
      continue;
    }

    const items: YamlItem[] = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const next = lines[cursor];
      if (next.trim() === "") {
        cursor += 1;
        continue;
      }
      const nextIndent = indentOf(next);
      if (nextIndent === 0 || !next.trim().startsWith("- ")) break;
      const head = next.trim().slice(2);
      const headMatch = KEY_VALUE.exec(head);
      if (headMatch) {
        // 列表项是对象：`- 动作: 打回` 后面跟同缩进的兄弟键
        const object: Record<string, YamlScalar> = {
          [headMatch[1].trim()]: parseScalar(headMatch[2] ?? ""),
        };
        const childIndent = nextIndent + 2;
        cursor += 1;
        while (cursor < lines.length) {
          const child = lines[cursor];
          if (child.trim() === "") {
            cursor += 1;
            continue;
          }
          if (indentOf(child) !== childIndent || child.trim().startsWith("- ")) break;
          const childMatch = /^([^:]+):\s*(.*)$/.exec(child.trim());
          if (!childMatch) break;
          object[childMatch[1].trim()] = parseScalar(childMatch[2]);
          cursor += 1;
        }
        items.push(object);
        continue;
      }
      items.push(parseScalar(head));
      cursor += 1;
    }
    fields[key] = items;
    index = cursor > index + 1 ? cursor : index + 1;
  }

  return { fields, order };
}

function parseScalar(raw: string): YamlScalar {
  const value = raw.trim();
  if (value === "") return "";
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
    (value.startsWith("'") && value.endsWith("'") && value.length > 1)
  ) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function emit(lines: string[], key: string, value: YamlValue): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${key}: []`);
      return;
    }
    lines.push(`${key}:`);
    for (const item of value) {
      if (item && typeof item === "object") {
        Object.entries(item).forEach(([childKey, childValue], position) => {
          lines.push(`${position === 0 ? "  - " : "    "}${childKey}: ${serializeScalar(childValue)}`);
        });
        continue;
      }
      lines.push(`  - ${serializeScalar(item)}`);
    }
    return;
  }
  lines.push(`${key}: ${serializeScalar(value)}`);
}

function needsQuote(value: string): boolean {
  return /^[\s]|[\s]$|^[-?:,[\]{}#&*!|>'"%@`]|: |\n/.test(value);
}

function serializeScalar(value: YamlScalar | undefined | null): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (value === "") return '""';
  return needsQuote(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}
