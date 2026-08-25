// 当日番茄流水。落成 vault 内一天一个 JSON 文件，R2 的积分账本直接在
// points 位上长，不用改已有字段。
//
// 两条硬要求：
//   1. schema 给 R2 预留位置——每条流水带 points / pointsRule，日档带 points 汇总；
//   2. 写盘幂等——同样的输入必须序列化出一模一样的字节，否则 Easy-Git 会被
//      刷出一串空 commit。所以这里没有 generatedAt 之类每次都变的字段，
//      key 顺序也是手写死的。

import type { ModeId } from "./settings";
import type { SegmentKind } from "./timer";

export const LEDGER_SCHEMA_VERSION = 1;
export const POINTS_SCHEMA_VERSION = 1;

export interface SessionRecord {
  id: string;
  kind: SegmentKind;
  /** 本地时间 ISO 8601，带时区偏移 */
  startedAt: string;
  endedAt: string;
  plannedSeconds: number;
  actualSeconds: number;
  /** 跑满才算完成 */
  completed: boolean;
  task: string;
  mode: ModeId;
  pomodoroIndex: number;
  /** 五行列；weekday 映射下周末为 null */
  phase: string | null;
  /** 节律表时段；落在空档为 null */
  segment: string | null;
  /** R2 预留：本条产生的积分。R1 一律 null，不猜规则。 */
  points: number | null;
  /** R2 预留：计分规则 id */
  pointsRule: string | null;
  /** R3：这个番茄在推进哪个目标树节点（`g-7`）；没挂就是 null */
  goalId: string | null;
}

/** R2 积分账本预留位。R1 只负责把位置留出来并保持 schema 稳定。 */
export interface PointsLedger {
  schemaVersion: number;
  earned: number | null;
  spent: number | null;
  balance: number | null;
  entries: unknown[];
}

export interface DayTotals {
  workSeconds: number;
  breakSeconds: number;
  completedPomodoros: number;
  startedPomodoros: number;
  targetMinutes: number;
  windowHours: number;
}

export interface DayLedger {
  schemaVersion: number;
  /** YYYY-MM-DD，按 dayRolloverHour 切分，不一定等于自然日 */
  date: string;
  generator: string;
  totals: DayTotals;
  sessions: SessionRecord[];
  points: PointsLedger;
}

export interface DayLedgerOptions {
  targetMinutes: number;
  windowHours: number;
  generator: string;
}

/**
 * 这条流水属于哪一天。14 小时工作制会跨零点（睡觉段 22:00 → 05:00），
 * 所以凌晨 1 点收工那条应该记在前一天。
 */
export function dayKeyFor(date: Date, rolloverHour: number): string {
  const shifted = new Date(date.getTime());
  if (date.getHours() < rolloverHour) {
    shifted.setDate(shifted.getDate() - 1);
  }
  const year = shifted.getFullYear();
  const month = String(shifted.getMonth() + 1).padStart(2, "0");
  const day = String(shifted.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 本地时间 ISO 8601，例如 2026-08-09T09:00:00+09:00。Date.toISOString() 是 UTC，会把时段对不上。 */
export function formatLocalIso(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  );
}

/** 同一段重复落盘要拿到同一个 id，否则重放会写出重复行。 */
export function makeSessionId(kind: SegmentKind, pomodoroIndex: number, startedAt: number): string {
  return `${kind}-${pomodoroIndex}-${startedAt}`;
}

export function createDayLedger(date: string, options: DayLedgerOptions): DayLedger {
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    date,
    generator: options.generator,
    totals: {
      workSeconds: 0,
      breakSeconds: 0,
      completedPomodoros: 0,
      startedPomodoros: 0,
      targetMinutes: options.targetMinutes,
      windowHours: options.windowHours,
    },
    sessions: [],
    points: emptyPoints(),
  };
}

function emptyPoints(): PointsLedger {
  return {
    schemaVersion: POINTS_SCHEMA_VERSION,
    earned: null,
    spent: null,
    balance: null,
    entries: [],
  };
}

/** 按 id 覆盖或追加，然后重算汇总。顺序固定：开始时间，再 id。 */
export function upsertSession(day: DayLedger, session: SessionRecord): DayLedger {
  const sessions = day.sessions.filter((existing) => existing.id !== session.id);
  sessions.push(session);
  sessions.sort((a, b) => {
    if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return recomputeTotals({ ...day, sessions });
}

export function recomputeTotals(day: DayLedger): DayLedger {
  let workSeconds = 0;
  let breakSeconds = 0;
  let completedPomodoros = 0;
  let startedPomodoros = 0;

  for (const session of day.sessions) {
    if (session.kind === "work") {
      workSeconds += session.actualSeconds;
      startedPomodoros += 1;
      if (session.completed) completedPomodoros += 1;
    } else {
      breakSeconds += session.actualSeconds;
    }
  }

  return {
    ...day,
    totals: {
      ...day.totals,
      workSeconds,
      breakSeconds,
      completedPomodoros,
      startedPomodoros,
    },
  };
}

/** 当日进度：已专注分钟 / 目标分钟。 */
export function focusProgress(day: DayLedger): {
  minutes: number;
  targetMinutes: number;
  ratio: number;
} {
  const minutes = day.totals.workSeconds / 60;
  const targetMinutes = day.totals.targetMinutes;
  const ratio = targetMinutes > 0 ? Math.min(1, minutes / targetMinutes) : 0;
  return { minutes, targetMinutes, ratio };
}

/** key 顺序手写死，保证同样的数据永远得到同样的字节。 */
export function serializeDayLedger(day: DayLedger): string {
  const ordered = {
    schemaVersion: day.schemaVersion,
    date: day.date,
    generator: day.generator,
    totals: {
      workSeconds: day.totals.workSeconds,
      breakSeconds: day.totals.breakSeconds,
      completedPomodoros: day.totals.completedPomodoros,
      startedPomodoros: day.totals.startedPomodoros,
      targetMinutes: day.totals.targetMinutes,
      windowHours: day.totals.windowHours,
    },
    sessions: day.sessions.map((session) => ({
      id: session.id,
      kind: session.kind,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      plannedSeconds: session.plannedSeconds,
      actualSeconds: session.actualSeconds,
      completed: session.completed,
      task: session.task,
      mode: session.mode,
      pomodoroIndex: session.pomodoroIndex,
      phase: session.phase,
      segment: session.segment,
      points: session.points,
      pointsRule: session.pointsRule,
      // 旧日档没有这一位，补成 null 再写——缺 key 和 null 是两份不同的字节。
      goalId: session.goalId ?? null,
    })),
    points: {
      schemaVersion: day.points.schemaVersion,
      earned: day.points.earned,
      spent: day.points.spent,
      balance: day.points.balance,
      entries: day.points.entries,
    },
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** 读坏文件不抛，返回 null，让调用方决定是重建还是保留。 */
export function parseDayLedger(text: string): DayLedger | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;

  const source = raw as Partial<DayLedger>;
  if (typeof source.date !== "string") return null;

  const sessions = Array.isArray(source.sessions)
    ? source.sessions.filter((session): session is SessionRecord => {
        return Boolean(session) && typeof (session as SessionRecord).id === "string";
      })
    : [];

  const day: DayLedger = {
    schemaVersion:
      typeof source.schemaVersion === "number" ? source.schemaVersion : LEDGER_SCHEMA_VERSION,
    date: source.date,
    generator: typeof source.generator === "string" ? source.generator : "",
    totals: {
      workSeconds: 0,
      breakSeconds: 0,
      completedPomodoros: 0,
      startedPomodoros: 0,
      targetMinutes: source.totals?.targetMinutes ?? 0,
      windowHours: source.totals?.windowHours ?? 0,
    },
    sessions,
    // R2 写进来的积分要原样带回去，不能被 R1 的重算抹掉。
    points: source.points
      ? {
          schemaVersion: source.points.schemaVersion ?? POINTS_SCHEMA_VERSION,
          earned: source.points.earned ?? null,
          spent: source.points.spent ?? null,
          balance: source.points.balance ?? null,
          entries: Array.isArray(source.points.entries) ? source.points.entries : [],
        }
      : emptyPoints(),
  };

  return recomputeTotals(day);
}

/** RefBake 的 writeIfChanged 判定部分：内容没变就不写。 */
export function shouldWrite(existing: string | null, next: string): boolean {
  return existing !== next;
}
