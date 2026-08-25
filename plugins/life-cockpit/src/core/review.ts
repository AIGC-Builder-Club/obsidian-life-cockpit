// 睡前复盘。出处是《知识库》第 144 行：「每天睡觉之前检查计划、复盘（AI 为主，人工为辅），
// 是否已经达到满意的完成程度」。
//
// 这一层只做三件事，且只做这三件：
//   1. **取数**——把当日番茄流水（R1）、积分出入账（R2）、目标树推进（R3）汇成一个素材包；
//   2. **出草稿**——素材包 → 一份复盘草稿。内置的是**确定性兜底**：算得出来的（完成度、偏差）
//      都算出来，判断得出来的（明天该改什么、值不值得记一条不贰过）一律留空，不猜；
//   3. **投递**——草稿拆成候选项，交给 R4 的候选区。
//
// 「AI 为主」那一侧接在 1 和 2 之间：吃素材包 JSON，出一份 ReviewDraft JSON。
// 换模型换渠道不动这里任何一行——这就是「接口留干净」的具体含义。
//
// **回写通道一律走 R4，不另起一套**：复盘正文与不贰过是 `类型: note`（追加进落点笔记），
// 明日计划是 `类型: goal-node`（在目标树上长节点）。人在夜班候选区面板上采纳 / 打回 / 改写，
// 打回的理由下一轮取数时读回来——别在同一个地方栽第二次。

import type { DayLedger } from "./ledger";
import { formatLocalIso } from "./ledger";
import { formatPoints, goalIdOf, round2, summarize } from "./points";
import type { PointsBook } from "./points";
import { formatGoalProgress, goalPath, GOAL_LEVEL_SHORT } from "./goals";
import type { GoalNode, GoalProgress } from "./goals";
import { CANDIDATE_PENDING } from "./candidates";
import type { Candidate } from "./candidates";
import { SIX_DIMENSIONS } from "./settings";
import { extractJsonBlock } from "./ai";
import type { AiMessage } from "./ai";
import type { FeishuReviewSlice } from "./feishu";

export const REVIEW_SCHEMA_VERSION = 1;

/** 复盘投出去的候选项都带这个前缀，下一轮靠它把自己的打回理由挑出来。 */
export const REVIEW_ID_PREFIX = "review";

export type ReviewSlot = "journal" | "plan" | "mistake";

// ---------------------------------------------------------------------------
// 素材包。一天一份，人不用自己翻三处。
// ---------------------------------------------------------------------------

export interface ReviewTaskSlice {
  task: string;
  minutes: number;
  completed: number;
}

export interface ReviewFocus {
  minutes: number;
  targetMinutes: number;
  /** 0..100，达成率 */
  ratio: number;
  completed: number;
  started: number;
  breakMinutes: number;
  /** 挂了目标树节点的番茄数——「今天有多少专注是有去处的」 */
  onGoal: number;
  byTask: ReviewTaskSlice[];
}

export interface ReviewPointsSlice {
  /** 账本里的 `任务` 原值：预设任务 id、`goal:g-7`，或临时任务 */
  key: string;
  /** 给人看的那一版：`goal:g-7` 摊成整条目标路径 */
  label: string;
  earned: number;
  spent: number;
  count: number;
}

export interface ReviewPoints {
  opening: number;
  earned: number;
  spent: number;
  net: number;
  closing: number;
  count: number;
  voidedCount: number;
  byTask: ReviewPointsSlice[];
}

export interface ReviewGoalSlice {
  id: string;
  title: string;
  /** `人生 › OKR › KPI › 日内` */
  path: string;
  level: string;
  status: string;
  /** 回灌之后的进度 0..100 */
  progress: number;
  pomodoros: number;
  earned: number;
  spent: number;
}

export interface ReviewGoals {
  /** 整棵树的进度，`computeProgress` 是唯一真相 */
  overall: number;
  /** 今天真动过的那几支：投过番茄，或记过分 */
  touched: ReviewGoalSlice[];
}

/** 上一轮复盘被打回的话。留在候选区原地的那几条，就是这里读回来的东西。 */
export interface ReviewRejection {
  at: string;
  reason: string;
  /** 被打回的那条候选项文件名 */
  from: string;
}

export interface ReviewMaterial {
  schemaVersion: number;
  /** 账本日 `YYYY-MM-DD`，按 dayRolloverHour 切，不一定等于自然日 */
  day: string;
  generator: string;
  focus: ReviewFocus;
  points: ReviewPoints;
  goals: ReviewGoals;
  rejections: ReviewRejection[];
  /** 日记模板《今日每日任务》的六维，草稿按它排 */
  dimensions: string[];
  /**
   * 飞书金字塔表格那一栏（AME-258 第 19.1 条）。**没有快照就是 null**，
   * 那一天就只是没有这一栏——番茄、积分、目标树三处照旧。
   *
   * 它回答的是前三处答不了的那一问：「我每天都大概干了什么、我是一个什么方向的人」。
   * 番茄流水记的是时间去处，飞书表格记的是**事情本身**。
   */
  feishu?: FeishuReviewSlice | null;
}

export interface CollectReviewInput {
  day: string;
  generator: string;
  /** 当天没跑过番茄时是 null——那也是一种复盘结论，不当错误处理 */
  ledger: DayLedger | null;
  book: PointsBook;
  roots: GoalNode[];
  progress: Map<string, GoalProgress>;
  /** 整棵树的进度，由 GoalStore 给；不给就按 0 */
  overall?: number;
  /** 日档还没建起来时的目标分钟数。目标是设置里的事，不因为今天没跑番茄就消失。 */
  targetMinutes?: number;
  rejections?: ReviewRejection[];
  dimensions?: string[];
  /** 飞书快照那一栏；没有快照就不给 */
  feishu?: FeishuReviewSlice | null;
}

/**
 * 取数汇总。纯函数：三处数据进来，一个素材包出去，不碰任何文件。
 *
 * 目标树那一栏只列**今天真动过的**：投过番茄的、记过分的。整棵树列出来等于没汇总——
 * 复盘要问的是「今天推进了哪一支」，不是「树上有什么」。
 */
export function collectReview(input: CollectReviewInput): ReviewMaterial {
  const ledger = input.ledger;
  const sessions = ledger ? ledger.sessions : [];
  const work = sessions.filter((session) => session.kind === "work");

  const byTask = new Map<string, ReviewTaskSlice>();
  const pomodorosByGoal = new Map<string, number>();
  let onGoal = 0;
  for (const session of work) {
    const task = session.task.trim() || "（没写任务名）";
    const slice = byTask.get(task) ?? { task, minutes: 0, completed: 0 };
    slice.minutes = round2(slice.minutes + session.actualSeconds / 60);
    if (session.completed) slice.completed += 1;
    byTask.set(task, slice);

    if (!session.goalId) continue;
    onGoal += 1;
    pomodorosByGoal.set(session.goalId, (pomodorosByGoal.get(session.goalId) ?? 0) + 1);
  }

  const summary = summarize(input.book, input.day, input.day);
  const pointsByGoal = new Map<string, { earned: number; spent: number }>();
  for (const slice of summary.byTask) {
    const goalId = goalIdOf(slice.key);
    if (!goalId) continue;
    pointsByGoal.set(goalId, { earned: slice.earned, spent: slice.spent });
  }

  const targetMinutes = ledger ? ledger.totals.targetMinutes : (input.targetMinutes ?? 0);
  const minutes = round2((ledger ? ledger.totals.workSeconds : 0) / 60);

  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    day: input.day,
    generator: input.generator,
    focus: {
      minutes,
      targetMinutes,
      ratio: targetMinutes > 0 ? round2(Math.min(100, (minutes / targetMinutes) * 100)) : 0,
      completed: ledger ? ledger.totals.completedPomodoros : 0,
      started: ledger ? ledger.totals.startedPomodoros : 0,
      breakMinutes: round2((ledger ? ledger.totals.breakSeconds : 0) / 60),
      onGoal,
      // 时间多的排前面：复盘先看大头花在哪。
      byTask: [...byTask.values()].sort(
        (a, b) => b.minutes - a.minutes || (a.task < b.task ? -1 : 1),
      ),
    },
    points: {
      opening: summary.opening,
      earned: summary.earned,
      spent: summary.spent,
      net: summary.net,
      closing: summary.closing,
      count: summary.count,
      voidedCount: summary.voidedCount,
      byTask: summary.byTask.map((slice) => ({
        key: slice.key,
        label: taskLabel(slice.key, input.roots),
        earned: slice.earned,
        spent: slice.spent,
        count: slice.count,
      })),
    },
    goals: {
      overall: round2(input.overall ?? 0),
      touched: touchedGoals(input.roots, input.progress, pomodorosByGoal, pointsByGoal),
    },
    rejections: (input.rejections ?? []).map((item) => ({ ...item })),
    dimensions: [...(input.dimensions ?? SIX_DIMENSIONS)],
    feishu: input.feishu ?? null,
  };
}

/** key 顺序手写死，保证同样的一天永远得到同样的字节。素材包重跑不刷空 commit。 */
export function serializeReviewMaterial(material: ReviewMaterial): string {
  const ordered: Record<string, unknown> = {
    schemaVersion: material.schemaVersion,
    day: material.day,
    generator: material.generator,
    focus: {
      minutes: material.focus.minutes,
      targetMinutes: material.focus.targetMinutes,
      ratio: material.focus.ratio,
      completed: material.focus.completed,
      started: material.focus.started,
      breakMinutes: material.focus.breakMinutes,
      onGoal: material.focus.onGoal,
      byTask: material.focus.byTask.map((slice) => ({
        task: slice.task,
        minutes: slice.minutes,
        completed: slice.completed,
      })),
    },
    points: {
      opening: material.points.opening,
      earned: material.points.earned,
      spent: material.points.spent,
      net: material.points.net,
      closing: material.points.closing,
      count: material.points.count,
      voidedCount: material.points.voidedCount,
      byTask: material.points.byTask.map((slice) => ({
        key: slice.key,
        label: slice.label,
        earned: slice.earned,
        spent: slice.spent,
        count: slice.count,
      })),
    },
    goals: {
      overall: material.goals.overall,
      touched: material.goals.touched.map((goal) => ({
        id: goal.id,
        title: goal.title,
        path: goal.path,
        level: goal.level,
        status: goal.status,
        progress: goal.progress,
        pomodoros: goal.pomodoros,
        earned: goal.earned,
        spent: goal.spent,
      })),
    },
    rejections: material.rejections.map((item) => ({
      at: item.at,
      reason: item.reason,
      from: item.from,
    })),
    dimensions: material.dimensions,
  };
  // 没有飞书快照的那一天**整个键都不写**，而不是写一个 null：
  // 素材包是逐字节比对之后才落盘的（writeIfChanged），多一个恒定的 null
  // 只会让所有旧素材包在升级当天集体重写一遍，给 Easy-Git 刷一串空 diff。
  if (material.feishu) {
    const feishu = material.feishu;
    ordered.feishu = {
      day: feishu.day,
      url: feishu.url,
      generatedAt: feishu.generatedAt,
      total: feishu.total,
      done: feishu.done,
      partial: feishu.partial,
      notStarted: feishu.notStarted,
      finished: [...feishu.finished],
      pending: [...feishu.pending],
    };
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** 读坏了不抛，返回 null——素材包是派生数据，重算一份就是了。 */
export function parseReviewMaterial(text: string): ReviewMaterial | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Partial<ReviewMaterial>;
  return typeof source.day === "string" ? (source as ReviewMaterial) : null;
}

// ---------------------------------------------------------------------------
// 草稿。AI 出的和兜底出的是同一种结构，投递那一段不区分。
// ---------------------------------------------------------------------------

export interface ReviewPlanDraft {
  title: string;
  /** 挂到哪个目标树节点下：`g-7` / `goal:g-7` / `[[目标树#^g-7]]`；留空挂顶层 */
  parent: string;
  level: string;
  kind: string;
  due: string;
  /** 为什么明天要做这一步。落成候选项正文，采纳前人看得见 */
  note: string;
}

/** 错题本一条。字段照《AI时代错题本-不贰过》里已有的写法来，不另起一套。 */
export interface ReviewMistakeDraft {
  title: string;
  /** 危害时长，如「大半天到 24 个小时」 */
  harm: string;
  /** 发生概率，如「中等」 */
  odds: string;
  cause: string;
  lesson: string;
}

export interface ReviewDraft {
  day: string;
  /** 谁出的：兜底写 `life-cockpit@x.y.z`，Agent 写 `agent:<名字>` */
  author: string;
  /** 复盘正文（Markdown），按六维排 */
  body: string;
  plans: ReviewPlanDraft[];
  mistakes: ReviewMistakeDraft[];
}

/**
 * 兜底草稿。**确定性，不需要模型，不产生洞见**——和 S1 的抽取式兜底同一个定位：
 * 夜里模型不通的时候，仍然有一份把数字摆齐的复盘，且每个数都能查回源头。
 *
 * 所以这里出的是「完成度判断」和「偏差在哪」（都算得出来），
 * 「明天该改什么」只留位置不填；`plans` / `mistakes` 一律空数组——
 * **不是每天都有不贰过级别的教训，宁可少记，不要把错题本灌成流水账。**
 */
export function fallbackReviewDraft(material: ReviewMaterial): ReviewDraft {
  return {
    day: material.day,
    author: material.generator,
    body: describeReviewMaterial(material),
    plans: [],
    mistakes: [],
  };
}

/**
 * 素材包 → 复盘正文。六维那一节的措辞取 `SIX_DIMENSIONS`，也就是日记模板
 * 《今日每日任务》里的原句——复盘落进日记之后和上面那份任务清单对得上，不另起一套。
 */
export function describeReviewMaterial(material: ReviewMaterial): string {
  const focus = material.focus;
  const points = material.points;
  const lines: string[] = [`## 睡前复盘 · ${material.day}`, ""];

  lines.push("### 今日实况", "");
  lines.push(
    `- 番茄：完成 ${focus.completed} 个 / 开始 ${focus.started} 个，` +
      `专注 ${formatMinutes(focus.minutes)} 分钟` +
      (focus.targetMinutes > 0
        ? `（目标 ${formatMinutes(focus.targetMinutes)}，达成 ${formatGoalProgress(focus.ratio)}）`
        : "（没设目标分钟）"),
  );
  lines.push(
    `- 积分：入账 ${formatPoints(points.earned)}、出账 ${formatPoints(points.spent)}、` +
      `净 ${signed(points.net)}，期末余额 ${formatPoints(points.closing)}`,
  );
  lines.push(
    `- 目标树：整体 ${formatGoalProgress(material.goals.overall)}，` +
      `今天动过 ${material.goals.touched.length} 支`,
  );
  for (const goal of material.goals.touched) {
    // 目标被删了就没有层级可写，那一段直接省掉，不留一个孤零零的分隔符。
    const head = [goal.level, goal.title, formatGoalProgress(goal.progress)]
      .filter(Boolean)
      .join(" · ");
    lines.push(
      `    - ${head}（${goal.pomodoros} 个番茄，${signed(round2(goal.earned - goal.spent))} 分）`,
    );
  }
  for (const slice of focus.byTask.slice(0, 5)) {
    lines.push(`- 时间去处：${slice.task} · ${formatMinutes(slice.minutes)} 分钟`);
  }
  lines.push("");

  lines.push("### 完成度判断", "");
  for (const line of completionLines(material)) lines.push(`- ${line}`);
  lines.push("");

  lines.push("### 偏差在哪", "");
  const gaps = gapLines(material);
  if (gaps.length) {
    for (const line of gaps) lines.push(`- ${line}`);
  } else {
    lines.push("- 数字上没看出偏差。真偏差在哪，得由人或 AI 说。");
  }
  lines.push("");

  // 飞书那一栏排在「偏差」之后、「打回」之前：前面两节讲的是表上的数字，
  // 这一节讲的是**事情本身**——今天到底在做什么。两者要挨着看才有意义。
  const feishu = material.feishu;
  if (feishu && feishu.total > 0) {
    lines.push(`### 飞书金字塔表格 · ${feishu.day}`, "");
    lines.push(
      `- 共 ${feishu.total} 项：已完成 ${feishu.done}、部分完成 ${feishu.partial}、没动 ${feishu.notStarted}`,
    );
    if (feishu.day !== material.day) {
      lines.push(`- ⚠️ 这是表上最近有记录的一天（${feishu.day}），不是今天——今天还没填表。`);
    }
    if (feishu.url) lines.push(`- 表格：${feishu.url}`);
    for (const item of feishu.finished.slice(0, 8)) lines.push(`    - [x] ${item}`);
    for (const item of feishu.pending.slice(0, 8)) lines.push(`    - [ ] ${item}`);
    lines.push("");
  }

  if (material.rejections.length) {
    lines.push("### 上一轮打回的话", "");
    for (const item of material.rejections) {
      lines.push(`- ${item.reason}　—— ${item.from} · ${item.at}`);
    }
    lines.push("", "> 这几条是上一轮复盘被打回的理由，别在同一个地方栽第二次。", "");
  }

  lines.push("### 六维回看", "");
  for (const dimension of material.dimensions) {
    lines.push(`#### ${dimension}`, "", "（今天在这一维上，哪些是真做，哪些是假动作？）", "");
  }

  lines.push("### 明天该改什么", "");
  lines.push("（这一段兜底不写——它是判断，不是计算。AI 出草稿时填这里，人在候选区上改。）");

  return `${lines.join("\n")}\n`;
}

/** 「是否已经达到满意的完成程度」——这一问的可计算部分。 */
function completionLines(material: ReviewMaterial): string[] {
  const focus = material.focus;
  const lines: string[] = [];

  if (focus.targetMinutes <= 0) {
    lines.push(`专注 ${formatMinutes(focus.minutes)} 分钟，没设目标分钟，达成度无从算起。`);
  } else {
    lines.push(
      `专注 ${formatMinutes(focus.minutes)} / ${formatMinutes(focus.targetMinutes)} 分钟，` +
        `达成 ${formatGoalProgress(focus.ratio)}。`,
    );
  }
  lines.push(
    focus.started > 0
      ? `开始过 ${focus.started} 个番茄，跑满 ${focus.completed} 个。`
      : "今天一个番茄都没开始。",
  );
  if (material.points.count === 0) {
    lines.push("今天一笔账都没记——完成了什么、花掉了什么，账上看不出来。");
  } else {
    lines.push(
      material.points.net >= 0
        ? `积分净 ${signed(material.points.net)}，账是往前走的。`
        : `积分净 ${signed(material.points.net)}，今天花的比挣的多。`,
    );
  }
  lines.push(`目标树整体 ${formatGoalProgress(material.goals.overall)}。`);
  return lines;
}

/** 偏差只报**数得出来**的那几种，报不出来就说报不出来，不替人编。 */
function gapLines(material: ReviewMaterial): string[] {
  const focus = material.focus;
  const lines: string[] = [];

  if (focus.targetMinutes > 0 && focus.minutes < focus.targetMinutes) {
    lines.push(
      `专注离目标差 ${formatMinutes(round2(focus.targetMinutes - focus.minutes))} 分钟。`,
    );
  }
  if (focus.started > focus.completed) {
    lines.push(`有 ${focus.started - focus.completed} 个番茄没跑满——中途被什么打断了？`);
  }
  if (focus.started > 0 && focus.onGoal === 0) {
    lines.push("今天的番茄一个都没挂目标树：时间花掉了，但不知道花在哪一支上。");
  } else if (focus.started > focus.onGoal) {
    lines.push(
      `${focus.started} 个番茄里只有 ${focus.onGoal} 个挂了目标，其余的去处记不回来。`,
    );
  }
  if (material.points.spent > material.points.earned) {
    lines.push(
      `出账 ${formatPoints(material.points.spent)} 高过入账 ${formatPoints(material.points.earned)}，享乐超支。`,
    );
  }
  if (material.goals.touched.length === 0) {
    lines.push("目标树今天一支都没动。");
  }
  return lines;
}

// ---------------------------------------------------------------------------
// AI 那一侧交回来的草稿。JSON 进来，缺什么补什么，读不动就用兜底。
// ---------------------------------------------------------------------------

/**
 * 读一份 Agent 交回来的草稿。**容错但不静默降级**：整份读不动返回 null，
 * 由调用方决定是报错还是退回兜底——夜里静默降级比直接失败更难发现。
 */
export function parseReviewDraft(text: string): ReviewDraft | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const body = str(source.body);
  if (!body.trim()) return null;

  return {
    day: str(source.day),
    author: str(source.author) || "agent:未署名",
    body,
    plans: asArray(source.plans).map((item) => ({
      title: str(item.title),
      parent: str(item.parent),
      level: str(item.level),
      kind: str(item.kind),
      due: str(item.due),
      note: str(item.note),
    })).filter((plan) => plan.title.trim() !== ""),
    mistakes: asArray(source.mistakes).map((item) => ({
      title: str(item.title),
      harm: str(item.harm),
      odds: str(item.odds),
      cause: str(item.cause),
      lesson: str(item.lesson),
    })).filter((mistake) => mistake.title.trim() !== ""),
  };
}

// ---------------------------------------------------------------------------
// 接模型的那一段。**只拼 prompt、只读回答，不发请求**——发请求在 `../ai-client.ts`。
// ---------------------------------------------------------------------------

/**
 * 「AI 为主、人工为辅」那一侧的 prompt（R5 的验收条件 3）。
 *
 * 三条硬约束写进 system，不是写在注释里指望模型自觉：
 *
 *   1. **不许编数字。** 素材包里的数就是全部事实，模型只负责解释它们。
 *      复盘一旦开始编数，它写的每一句话都不能信了。
 *   2. **`plans` / `mistakes` 宁可空着。** 兜底草稿之所以把这两个数组留空，
 *      理由是「不是每天都有不贰过级别的教训」——换成模型来写，这条更要守：
 *      模型天生倾向于把每个格子填满。
 *   3. **只出 JSON。** 出来的东西要直接喂 `parseReviewDraft`。
 *
 * 上一轮被打回的理由**原样带进 user 消息**：那是人明确说过的话，
 * 「别在同一个地方栽第二次」这一条只有把它摆到模型眼前才成立。
 */
export function buildReviewMessages(material: ReviewMaterial): AiMessage[] {
  const system = [
    "你是这套「人生驾驶舱」的复盘助手。人已经收工，现在要出一份当日复盘草稿，交给他本人拍板。",
    "",
    "规矩：",
    "1. 只能用素材包里给出的数字和条目。**素材包里没有的事实一律不许写**，包括你觉得「大概会是这样」的推测。",
    "2. plans（明日计划）只在素材包真的指向某个下一步时才写，最多 3 条；没有就给空数组。",
    "3. mistakes（错题本「不贰过」）是高门槛的：只有当天出现了会重复发生、且值得写进错题本的教训才写，最多 1 条；绝大多数日子应该是空数组。",
    "4. body 用中文 Markdown，按素材包给的六维排小节，重点写「完成度判断」「偏差在哪」「明天该改什么」——前两项要落到具体数字上，第三项是你的判断。",
    "5. 只输出一个 JSON 对象，不要任何解释文字、不要代码围栏。",
    "",
    "JSON 形状：",
    '{"day":"YYYY-MM-DD","author":"ai:<模型名>","body":"<Markdown>","plans":[{"title":"","parent":"","level":"","kind":"","due":"","note":""}],"mistakes":[{"title":"","harm":"","odds":"","cause":"","lesson":""}]}',
  ].join("\n");

  const parts = [
    `账本日：${material.day}`,
    "",
    "素材包（这就是全部事实）：",
    "```json",
    serializeReviewMaterial(material).trimEnd(),
    "```",
  ];
  if (material.rejections.length) {
    parts.push(
      "",
      "上一轮这份复盘被他打回过，理由如下。**别在同一个地方栽第二次**：",
      ...material.rejections.map((item) => `- ${item.reason}`),
    );
  }
  parts.push("", "现在出这一份草稿。");

  return [
    { role: "system", content: system },
    { role: "user", content: parts.join("\n") },
  ];
}

/**
 * 读模型交回来的草稿。**容错但不静默降级**：读不动返回 null，
 * 由调用方明说「模型这一段没出来，用的是兜底草稿」——
 * 夜里静默降级比直接失败更难发现（S1 那条教训，这里照抄）。
 *
 * `day` 一律以素材包为准：模型偶尔会把日期写成今天的自然日，
 * 而账本日是按 `dayRolloverHour` 切的，两者在凌晨会差一天。
 */
export function parseAiReviewDraft(content: string, material: ReviewMaterial): ReviewDraft | null {
  const json = extractJsonBlock(content);
  if (!json) return null;
  const draft = parseReviewDraft(json);
  if (!draft) return null;
  return { ...draft, day: material.day };
}

// ---------------------------------------------------------------------------
// 投递。草稿拆成候选项，交给 R4——**回写只有这一条通道**。
// ---------------------------------------------------------------------------

export interface ReviewCandidateOptions {
  day: string;
  at: Date;
  /** 当日日记路径，复盘正文的落点 */
  journalNote: string;
  /** 错题本路径，不贰过的落点 */
  mistakeNote: string;
}

export interface ReviewCandidateFile {
  /** 候选区日期目录下的文件名 */
  name: string;
  slot: ReviewSlot;
  candidate: Candidate;
}

/**
 * 草稿 → 候选项。三个去处，三种类型，**全部是 R4 已有的处理器**：
 *
 * | 去处 | 类型 | 落点 |
 * | --- | --- | --- |
 * | 当日日记 | `note` | 日记路径，追加不覆盖 |
 * | 目标树（明日计划） | `goal-node` | 挂在哪个节点下 |
 * | 错题本（不贰过） | `note` | 错题本路径，追加不覆盖 |
 *
 * 没有 `ledger-entry`：复盘不替人记账。分该怎么记是当场的事，
 * 隔一天由复盘补记只会让账目和事实对不上——账目宁可不落，也不猜。
 */
export function reviewCandidates(
  draft: ReviewDraft,
  options: ReviewCandidateOptions,
): ReviewCandidateFile[] {
  const generatedAt = formatLocalIso(options.at);
  const files: ReviewCandidateFile[] = [
    {
      name: "睡前复盘-复盘正文.md",
      slot: "journal",
      candidate: {
        ...blankCandidate(),
        id: reviewCandidateId(options.day, "journal"),
        source: draft.author,
        generatedAt,
        target: options.journalNote,
        summary: `${options.day} 睡前复盘`,
        type: "note",
        body: draft.body.trim(),
      },
    },
  ];

  draft.plans.forEach((plan, index) => {
    files.push({
      name: `睡前复盘-明日计划-${index + 1}.md`,
      slot: "plan",
      candidate: {
        ...blankCandidate(),
        id: reviewCandidateId(options.day, "plan", index + 1),
        source: draft.author,
        generatedAt,
        target: plan.parent.trim(),
        summary: plan.title.trim(),
        type: "goal-node",
        ...planExtras(plan),
        body: planBody(plan, options.day),
      },
    });
  });

  draft.mistakes.forEach((mistake, index) => {
    files.push({
      name: `睡前复盘-不贰过-${index + 1}.md`,
      slot: "mistake",
      candidate: {
        ...blankCandidate(),
        id: reviewCandidateId(options.day, "mistake", index + 1),
        source: draft.author,
        generatedAt,
        target: options.mistakeNote,
        summary: mistake.title.trim(),
        type: "note",
        body: mistakeBody(mistake, options.day),
      },
    });
  });

  return files;
}

export function reviewCandidateId(day: string, slot: ReviewSlot, index?: number): string {
  const tail = index === undefined ? "" : `-${index}`;
  return `${day}-${REVIEW_ID_PREFIX}-${slot}${tail}`;
}

const REVIEW_ID = new RegExp(`-${REVIEW_ID_PREFIX}-(journal|plan|mistake)(-\\d+)?$`);

/** 这条候选项是不是复盘投出去的。读回自己的打回理由时用它筛。 */
export function isReviewCandidate(candidate: Candidate): boolean {
  return REVIEW_ID.test(candidate.id);
}

function planExtras(plan: ReviewPlanDraft): Pick<Candidate, "extras" | "extraOrder"> {
  const extras: Candidate["extras"] = {};
  const extraOrder: string[] = [];
  const put = (key: string, value: string): void => {
    const text = value.trim();
    if (!text) return;
    extras[key] = text;
    extraOrder.push(key);
  };
  // 键名照约定文档的《类型专属字段》，不另起一套。
  put("目标层级", plan.level);
  put("目标类型", plan.kind);
  put("截止", plan.due);
  return { extras, extraOrder };
}

function planBody(plan: ReviewPlanDraft, day: string): string {
  const lines = [`## 明日计划 · ${plan.title.trim()}`, ""];
  if (plan.note.trim()) lines.push(plan.note.trim(), "");
  lines.push(`> 出自 ${day} 的睡前复盘。采纳后会在目标树上长出这个节点。`);
  return lines.join("\n");
}

/**
 * 错题本一条。写成《AI时代错题本-不贰过》里已有的形状：
 * 危害时长 + 发生概率打头，底下挂直接原因和反省。
 */
function mistakeBody(mistake: ReviewMistakeDraft, day: string): string {
  const harm = mistake.harm.trim() || "未估";
  const odds = mistake.odds.trim() || "未估";
  const lines = [
    `- （危害时长：${harm}。发生概率：${odds}）${day}`,
    `\t- ${mistake.title.trim()}`,
  ];
  if (mistake.cause.trim()) {
    lines.push("\t\t- 直接原因：", `\t\t\t- ${mistake.cause.trim()}`);
  }
  if (mistake.lesson.trim()) {
    lines.push("\t\t- 反省：", `\t\t\t- ${mistake.lesson.trim()}`);
  }
  return lines.join("\n");
}

function blankCandidate(): Candidate {
  return {
    id: "",
    source: "",
    generatedAt: "",
    target: "",
    summary: "",
    status: CANDIDATE_PENDING,
    type: "",
    level: null,
    coverage: null,
    trace: [],
    decisions: [],
    extras: {},
    extraOrder: [],
    body: "",
  };
}

// ---------------------------------------------------------------------------
// 睡前触发。到点提醒一次，一天只一次。
// ---------------------------------------------------------------------------

export interface BedtimeState {
  /** 已经提醒过的那个账本日；null = 这一天还没提醒过 */
  firedFor: string | null;
}

export function createBedtimeState(): BedtimeState {
  return { firedFor: null };
}

export interface BedtimeTick {
  state: BedtimeState;
  due: boolean;
}

/**
 * 睡点过了没有。凌晨那几个小时按账本日还算前一天，睡点早就过了——
 * 一点半还没睡的人更需要这条提醒，不是更不需要。
 */
export function bedtimeDue(minute: number, atMinute: number, rolloverHour: number): boolean {
  if (minute >= atMinute) return true;
  return minute < rolloverHour * 60;
}

/**
 * 到点返回 due=true，一个账本日只返回一次。换天自动重置，
 * 所以连着开三天 Obsidian 会提醒三次，一天里反复开关只提醒一次。
 */
export function tickBedtime(
  state: BedtimeState,
  input: { day: string; minute: number; atMinute: number; rolloverHour: number },
): BedtimeTick {
  if (state.firedFor === input.day) return { state, due: false };
  if (!bedtimeDue(input.minute, input.atMinute, input.rolloverHour)) {
    return { state, due: false };
  }
  return { state: { firedFor: input.day }, due: true };
}

/** 手动发起过一次就别再提醒了——人已经在做这件事了。 */
export function markBedtimeFired(day: string): BedtimeState {
  return { firedFor: day };
}

// ---------------------------------------------------------------------------

function touchedGoals(
  roots: GoalNode[],
  progress: Map<string, GoalProgress>,
  pomodoros: Map<string, number>,
  points: Map<string, { earned: number; spent: number }>,
): ReviewGoalSlice[] {
  const ids = new Set<string>([...pomodoros.keys(), ...points.keys()]);
  const slices: ReviewGoalSlice[] = [];

  for (const id of [...ids].sort()) {
    const path = goalPath(roots, id);
    const node = path.at(-1);
    const scored = points.get(id) ?? { earned: 0, spent: 0 };
    slices.push({
      id,
      // 目标被删了也如实写出来，不把这几个番茄悄悄丢掉。
      title: node ? node.title : "（已不在树上）",
      path: path.map((item) => item.title).join(" › "),
      level: node ? GOAL_LEVEL_SHORT[node.level] : "",
      status: node ? node.status : "",
      progress: round2(progress.get(id)?.progress ?? 0),
      pomodoros: pomodoros.get(id) ?? 0,
      earned: scored.earned,
      spent: scored.spent,
    });
  }

  // 投得多的排前面，其次按 id——同一天永远排出同一个顺序。
  return slices.sort(
    (a, b) => b.pomodoros - a.pomodoros || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

function taskLabel(key: string, roots: GoalNode[]): string {
  const goalId = goalIdOf(key);
  if (!goalId) return key;
  const path = goalPath(roots, goalId);
  if (!path.length) return `${key}（已不在树上）`;
  return path.map((node) => node.title).join(" › ");
}

function formatMinutes(value: number): string {
  return String(round2(value));
}

function signed(value: number): string {
  return value >= 0 ? `+${formatPoints(value)}` : `-${formatPoints(Math.abs(value))}`;
}

function str(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : String(value);
}

function asArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object",
  );
}
