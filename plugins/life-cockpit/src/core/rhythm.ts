// 五行节律表：日记模板里那张「金一木二水三火四土五 × 早起 / 三小时工作日 /
// 双数日 / 单数日 / 睡觉」的表。行 = 时段，列 = 五行。
//
// 列怎么对应到日期，原表没写死。这里做成两种可选映射：
//   weekday（默认）—— 一二三四五 = 周一到周五，周末没有对应列；
//   cycle5        —— 从锚点日起五天一轮，不管星期。
// 两种都测了，改设置就能换。

import type { LifeCockpitSettings, RhythmSegmentSetting } from "./settings";

export interface WuxingPhase {
  id: string;
  /** 1..5 */
  index: number;
  label: string;
  element: string;
}

export const WUXING_PHASES: WuxingPhase[] = [
  { id: "jin", index: 1, label: "金一", element: "金" },
  { id: "mu", index: 2, label: "木二", element: "木" },
  { id: "shui", index: 3, label: "水三", element: "水" },
  { id: "huo", index: 4, label: "火四", element: "火" },
  { id: "tu", index: 5, label: "土五", element: "土" },
];

export interface ResolvedSegment {
  id: string;
  label: string;
  startMinute: number;
  endMinute: number;
  /** 跨零点（例如 睡觉 22:00 → 05:00） */
  wraps: boolean;
}

/** "HH:MM" → 距零点分钟数。允许 "24:00" 表示一天结束。非法返回 null。 */
export function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 24 || minutes < 0 || minutes > 59) return null;
  const total = hours * 60 + minutes;
  if (total > 1440) return null;
  return total;
}

export function formatClock(minuteOfDay: number): string {
  const normalized = ((Math.round(minuteOfDay) % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function minuteOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/** 设置里的时段表 → 可判定的时段表。写坏的行（时间解析不了）直接丢掉。 */
export function resolveSegments(segments: RhythmSegmentSetting[]): ResolvedSegment[] {
  const resolved: ResolvedSegment[] = [];
  for (const segment of segments) {
    const startMinute = parseClock(segment.start);
    const endMinute = parseClock(segment.end);
    if (startMinute === null || endMinute === null) continue;
    if (startMinute === endMinute) continue;
    resolved.push({
      id: segment.id,
      label: segment.label,
      startMinute,
      endMinute,
      wraps: endMinute < startMinute,
    });
  }
  return resolved;
}

export function segmentContains(segment: ResolvedSegment, minute: number): boolean {
  if (segment.wraps) return minute >= segment.startMinute || minute < segment.endMinute;
  return minute >= segment.startMinute && minute < segment.endMinute;
}

/**
 * 当前落在哪个时段。原表里 12-13、17-18 是空的，落在空档就返回 null——
 * 空档就是没有时段，不替表主人补格子。多个时段重叠时取表里靠前的那个。
 */
export function segmentAt(
  segments: ResolvedSegment[],
  minute: number,
): ResolvedSegment | null {
  for (const segment of segments) {
    if (segmentContains(segment, minute)) return segment;
  }
  return null;
}

export interface SegmentTransition {
  left: ResolvedSegment | null;
  entered: ResolvedSegment | null;
}

/** 时段变了才返回事件；没变返回 null。进入 / 离开的提醒都靠它。 */
export function segmentTransition(
  previous: ResolvedSegment | null,
  next: ResolvedSegment | null,
): SegmentTransition | null {
  const previousId = previous?.id ?? null;
  const nextId = next?.id ?? null;
  if (previousId === nextId) return null;
  return { left: previous, entered: next };
}

export function describeTransition(transition: SegmentTransition): string {
  const parts: string[] = [];
  if (transition.left) parts.push(`离开【${transition.left.label}】`);
  if (transition.entered) parts.push(`进入【${transition.entered.label}】`);
  if (!parts.length) return "";
  return parts.join("，");
}

/** 本地零点为准的天数差，避开夏令时把小时数算歪。 */
function daysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86_400_000);
}

function parseIsoDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

/** 今天在哪一列。weekday 映射下周末没有列，返回 null。 */
export function phaseForDate(
  date: Date,
  settings: Pick<LifeCockpitSettings, "phaseMapping" | "cycleAnchorDate" | "cycleAnchorPhase">,
): WuxingPhase | null {
  if (settings.phaseMapping === "weekday") {
    const weekday = date.getDay();
    if (weekday < 1 || weekday > 5) return null;
    return WUXING_PHASES[weekday - 1];
  }

  const anchor = parseIsoDate(settings.cycleAnchorDate);
  if (!anchor) return WUXING_PHASES[0];
  const offset = daysBetween(anchor, date) + settings.cycleAnchorPhase;
  return WUXING_PHASES[((offset % 5) + 5) % 5];
}

export interface RhythmCell {
  segment: ResolvedSegment | null;
  phase: WuxingPhase | null;
}

export function currentCell(
  date: Date,
  settings: Pick<
    LifeCockpitSettings,
    "rhythmSegments" | "phaseMapping" | "cycleAnchorDate" | "cycleAnchorPhase"
  >,
): RhythmCell {
  return {
    segment: segmentAt(resolveSegments(settings.rhythmSegments), minuteOfDay(date)),
    phase: phaseForDate(date, settings),
  };
}

export function describeCell(cell: RhythmCell): string {
  const phase = cell.phase ? cell.phase.label : "无对应列";
  const segment = cell.segment ? cell.segment.label : "空档";
  return `${phase} · ${segment}`;
}
