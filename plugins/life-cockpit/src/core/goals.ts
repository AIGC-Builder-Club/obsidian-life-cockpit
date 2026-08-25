// 目标树。《知识库》第 115–126 行那六层「全目标管理」，做成能跑的树：
//
//   宇宙级 → 人生级 → 大阶段 / 五年计划 → 【年度】OKR → 【季度到每周】KPI → 日内目标
//
// 三条硬要求：
//   1. **回灌是主线**。日内目标的完成度要能反向汇总到 KPI / OKR——只做单向拆分
//      等于又造了一堆静态清单，那正是这一项要解决的问题。所以进度默认是算出来的，
//      不是填出来的：叶子给数，上层按权重收。
//   2. 落盘是给人看的 Markdown 缩进列表。树的形状要在 Obsidian 里直接看得见、
//      直接改；节点 id 就是 Obsidian 的块引用锚点（`^g-7`），能被链、能被积分账本指回来。
//   3. 写盘幂等 + 不静默丢东西，和 R1 日档、R2 月账同一套规矩：同样的树序列化出
//      同样的字节；读不动的行原样搬到《待修复》，手工改坏也不会消失。

export const GOAL_TREE_SCHEMA_VERSION = 1;

export type GoalLevel = "universe" | "life" | "stage" | "okr" | "kpi" | "daily";

/** 顺序即层级深度，顶格是 GOAL_LEVELS[0]。 */
export const GOAL_LEVELS: GoalLevel[] = ["universe", "life", "stage", "okr", "kpi", "daily"];

export const GOAL_LEVEL_LABELS: Record<GoalLevel, string> = {
  universe: "宇宙级目标",
  life: "人生级目标",
  stage: "大阶段级 / 五年计划级目标",
  okr: "【年度】OKR 级目标",
  kpi: "【季度到每周】KPI 级目标",
  daily: "日内目标",
};

/** 落盘与徽章用的短名。 */
export const GOAL_LEVEL_SHORT: Record<GoalLevel, string> = {
  universe: "宇宙",
  life: "人生",
  stage: "大阶段",
  okr: "OKR",
  kpi: "KPI",
  daily: "日内",
};

/** 日内目标的种类，出处同上：项目规划 / Goal / Spec / Issue。 */
export const DAILY_KINDS = ["项目规划", "Goal", "Spec", "Issue"];

export type GoalStatus = "planned" | "active" | "done" | "dropped";

export const GOAL_STATUS_LABELS: Record<GoalStatus, string> = {
  planned: "未开始",
  active: "进行中",
  done: "已完成",
  dropped: "已放弃",
};

/** 任务记号 ↔ 状态。只认这四个，别的会被归一成未开始。 */
const STATUS_MARKS: Record<GoalStatus, string> = {
  planned: " ",
  active: "/",
  done: "x",
  dropped: "-",
};

export interface GoalMetric {
  current: number;
  target: number;
  /** 单位，可留空 */
  unit: string;
}

export interface GoalNode {
  /** `g-7`，同时是 Obsidian 块引用锚点；积分账本按 `goal:g-7` 指回来 */
  id: string;
  level: GoalLevel;
  title: string;
  status: GoalStatus;
  /** 人手写的完成度 0..100；null = 不写死，交给度量或状态 */
  manualProgress: number | null;
  /** 可量化目标的度量；null = 不可量化 */
  metric: GoalMetric | null;
  /** 回灌加权，>= 0。拆分出来的子目标按各自摊到的量赋权 */
  weight: number;
  due: string | null;
  /** 日内目标的种类（项目规划 / Goal / Spec / Issue）；别的层一般为 null */
  kind: string | null;
  /**
   * 飞书金字塔表格里哪些条目算在这支目标上（AME-258 第 22.2 条：
   * 「仍然需要，和【目标树、目标项】，做一个结合」）。
   *
   * 一串关键词，用顿号 / 逗号 / 空格分开；表上的条目**正文包含其中任意一个**就算命中。
   * 留空 = 这支目标不接飞书。
   *
   * 为什么是关键词而不是 id：那张表是人在飞书上手写的，上面没有、也不该有目标树的
   * 节点号。要求人在飞书里写 `g-7` 等于把两个系统焊死，而他明说了
   * 「我仍然在飞书表格上面做记录」——所以对齐这件事由插件这一侧承担。
   */
  feishuMatch: string;
  /** 认不出来但形如 `[k:: v]` 的行内字段，原样带着走，不替人删 */
  extras: string[];
  children: GoalNode[];
}

export interface GoalTree {
  schemaVersion: number;
  /** 下一个可用编号。只增不减——删掉的节点 id 不回收，免得旧账指到新目标上 */
  nextId: number;
  roots: GoalNode[];
  /** 解析不动的原始行，序列化时原样写回 */
  quarantine: string[];
}

export function createGoalTree(): GoalTree {
  return { schemaVersion: GOAL_TREE_SCHEMA_VERSION, nextId: 1, roots: [], quarantine: [] };
}

export function levelIndex(level: GoalLevel): number {
  const index = GOAL_LEVELS.indexOf(level);
  return index < 0 ? 0 : index;
}

/** 下一层。已经在日内目标就还是日内目标——树可以更深，层级名到此为止。 */
export function childLevelOf(level: GoalLevel): GoalLevel {
  return GOAL_LEVELS[Math.min(levelIndex(level) + 1, GOAL_LEVELS.length - 1)];
}

// ---------------------------------------------------------------------------
// 树操作。一律返回新数组，不就地改——UI 拿到的引用不会在背后变形。
// ---------------------------------------------------------------------------

export interface GoalInput {
  title: string;
  level: GoalLevel;
  status?: GoalStatus;
  manualProgress?: number | null;
  metric?: GoalMetric | null;
  weight?: number;
  due?: string | null;
  kind?: string | null;
  feishuMatch?: string;
  extras?: string[];
  children?: GoalNode[];
}

export function createGoalNode(id: string, input: GoalInput): GoalNode {
  return {
    id,
    level: input.level,
    title: input.title.trim() || "（未命名目标）",
    status: input.status ?? "planned",
    manualProgress: normalizePercent(input.manualProgress ?? null),
    metric: normalizeMetric(input.metric ?? null),
    weight: normalizeWeight(input.weight),
    due: normalizeDay(input.due ?? null),
    kind: normalizeKind(input.kind ?? null),
    feishuMatch: (input.feishuMatch ?? "").trim(),
    extras: [...(input.extras ?? [])],
    children: [...(input.children ?? [])],
  };
}

/**
 * 这支目标认哪几个关键词。顿号、逗号、分号、空白都当分隔符——
 * 人在编辑窗里怎么顺手怎么写，别让他记一套分隔符规矩。
 */
export function goalFeishuKeywords(node: GoalNode): string[] {
  return node.feishuMatch
    .split(/[、,，;；\s]+/)
    .map((word) => word.trim())
    .filter((word) => word !== "");
}

/** 取号并前进。id 不回收：删了 g-7 之后新建的是 g-8，旧账不会指错目标。 */
export function takeGoalId(tree: GoalTree): { id: string; tree: GoalTree } {
  const id = `g-${tree.nextId}`;
  return { id, tree: { ...tree, nextId: tree.nextId + 1 } };
}

export function walkGoals(nodes: GoalNode[]): GoalNode[] {
  const flat: GoalNode[] = [];
  const visit = (list: GoalNode[]): void => {
    for (const node of list) {
      flat.push(node);
      visit(node.children);
    }
  };
  visit(nodes);
  return flat;
}

export function findGoal(nodes: GoalNode[], id: string | null): GoalNode | null {
  if (!id) return null;
  return walkGoals(nodes).find((node) => node.id === id) ?? null;
}

/** 从根到该节点的整条路径，含节点自己；找不到返回空数组。 */
export function goalPath(nodes: GoalNode[], id: string): GoalNode[] {
  const path: GoalNode[] = [];
  const visit = (list: GoalNode[]): boolean => {
    for (const node of list) {
      path.push(node);
      if (node.id === id || visit(node.children)) return true;
      path.pop();
    }
    return false;
  };
  return visit(nodes) ? path : [];
}

export function parentOfGoal(nodes: GoalNode[], id: string): GoalNode | null {
  const path = goalPath(nodes, id);
  return path.length >= 2 ? path[path.length - 2] : null;
}

/** parentId 为 null 时挂到顶层。 */
export function insertGoal(nodes: GoalNode[], parentId: string | null, node: GoalNode): GoalNode[] {
  if (!parentId) return [...nodes, node];
  return nodes.map((current) => {
    if (current.id === parentId) return { ...current, children: [...current.children, node] };
    return { ...current, children: insertGoal(current.children, parentId, node) };
  });
}

export function updateGoal(
  nodes: GoalNode[],
  id: string,
  patch: Partial<GoalInput>,
): GoalNode[] {
  return nodes.map((node) => {
    if (node.id !== id) return { ...node, children: updateGoal(node.children, id, patch) };
    return {
      ...node,
      level: patch.level ?? node.level,
      title: patch.title === undefined ? node.title : patch.title.trim() || node.title,
      status: patch.status ?? node.status,
      manualProgress:
        patch.manualProgress === undefined
          ? node.manualProgress
          : normalizePercent(patch.manualProgress),
      metric: patch.metric === undefined ? node.metric : normalizeMetric(patch.metric),
      weight: patch.weight === undefined ? node.weight : normalizeWeight(patch.weight),
      due: patch.due === undefined ? node.due : normalizeDay(patch.due),
      kind: patch.kind === undefined ? node.kind : normalizeKind(patch.kind),
      feishuMatch: patch.feishuMatch === undefined ? node.feishuMatch : patch.feishuMatch.trim(),
    };
  });
}

/** 连同整棵子树一起摘掉。 */
export function removeGoal(nodes: GoalNode[], id: string): GoalNode[] {
  return nodes
    .filter((node) => node.id !== id)
    .map((node) => ({ ...node, children: removeGoal(node.children, id) }));
}

/** 同级上下挪一格。已经在头 / 尾就原样返回。 */
export function moveGoal(nodes: GoalNode[], id: string, delta: number): GoalNode[] {
  const index = nodes.findIndex((node) => node.id === id);
  if (index >= 0) {
    const target = index + delta;
    if (target < 0 || target >= nodes.length) return nodes;
    const moved = [...nodes];
    const [node] = moved.splice(index, 1);
    moved.splice(target, 0, node);
    return moved;
  }
  return nodes.map((node) => ({ ...node, children: moveGoal(node.children, id, delta) }));
}

/**
 * 把整棵树的层级按缩进重排一遍：子节点至少比父节点深一级，最深停在日内目标。
 * 手工编辑之后调用——人只管缩进，层级名交给这里对齐。
 */
export function relevelGoals(nodes: GoalNode[], parentLevel: GoalLevel | null = null): GoalNode[] {
  const floor = parentLevel === null ? 0 : levelIndex(parentLevel) + 1;
  return nodes.map((node) => {
    const index = Math.min(Math.max(levelIndex(node.level), floor), GOAL_LEVELS.length - 1);
    const level = GOAL_LEVELS[index];
    return { ...node, level, children: relevelGoals(node.children, level) };
  });
}

// ---------------------------------------------------------------------------
// 向上回灌
// ---------------------------------------------------------------------------

export type ProgressSource =
  | "rollup"
  | "feishu"
  | "metric"
  | "manual"
  | "closed"
  | "dropped"
  | "none";

/**
 * 一支目标在飞书金字塔表格上的战绩。**由调用方按 `[飞书:: 关键词]` 匹配好递进来**，
 * 这一层不 import `feishu.ts`——两边互相 import 迟早咬起来（`feishu.ts` 开头那条同款规矩）。
 */
export interface FeishuGoalTally {
  done: number;
  /** 「完成了一部分」算半个：它既不是没动，也不是做完了 */
  partial: number;
  total: number;
}

/**
 * 表上那几条 → 这支目标的完成度。
 *
 * 出处（AME-271 后续）：
 *
 *   「最好目标的完成——也可以根据【飞书Excel】上面的来？免得我在【飞书Excel上
 *    手动更改了目标完成程度】——本地OB插件还要手动来一次？」
 *
 * 所以口径只有一条、写死在这儿：**已完成算 1，完成了一部分算 0.5，其余算 0。**
 * 半个不是拍脑袋——表上那一档就叫「完成了一部分」，把它算成 0 会让一支
 * 推了一半的目标显示成没动，算成 1 会让它显示成做完了，两边都在说谎。
 */
export function feishuGoalProgress(tally: FeishuGoalTally): number {
  if (tally.total <= 0) return 0;
  return clamp(((tally.done + tally.partial * 0.5) / tally.total) * 100, 0, 100);
}

export interface GoalProgress {
  id: string;
  /** 0..100 */
  progress: number;
  source: ProgressSource;
  /** 这棵子树里参与统计的叶子数（已放弃的整支不算） */
  leaves: number;
  doneLeaves: number;
  /** 参与回灌的直接子节点数 */
  rolledChildren: number;
}

/**
 * 每个节点的进度。**这是本项的重点**：日内目标做完 → KPI 涨 → OKR 涨，一路自己走上去。
 *
 * 取值顺序（先命中先算，写在这里是因为它是全树唯一的真相）：
 *   1. 已放弃 → 0，并且**整支退出上层汇总**（放弃一个子目标不该让父目标永远背着）；
 *   2. 已完成 → 100（人手动结项，压过子节点——这是他自己的人生）；
 *   3. 有未放弃的子节点 → 子节点进度按 weight 加权平均，**这一条就是回灌**；
 *   4. **绑了飞书关键词且表上有命中 → 按表算**（已完成 1 / 部分 0.5），
 *      压过度量和手写完成度：绑定本身就是「这支的进度以那张表为准」；
 *   5. 有度量 → current / target（数据比估计可信，所以压过手写完成度）；
 *   6. 有手写完成度 → 用它；
 *   7. 都没有 → 0。
 */
export function computeProgress(
  nodes: GoalNode[],
  feishuTally?: Map<string, FeishuGoalTally>,
): Map<string, GoalProgress> {
  const result = new Map<string, GoalProgress>();

  const visit = (node: GoalNode): GoalProgress => {
    const children = node.children.map(visit);
    const rolled = node.children
      .map((child, index) => ({ child, progress: children[index] }))
      .filter((item) => item.child.status !== "dropped");

    const leaves = rolled.length
      ? rolled.reduce((sum, item) => sum + item.progress.leaves, 0)
      : 1;
    const doneLeaves = rolled.length
      ? rolled.reduce((sum, item) => sum + item.progress.doneLeaves, 0)
      : node.status === "done"
        ? 1
        : 0;

    let progress = 0;
    let source: ProgressSource = "none";

    if (node.status === "dropped") {
      source = "dropped";
    } else if (node.status === "done") {
      progress = 100;
      source = "closed";
    } else if (rolled.length) {
      let weightSum = 0;
      let weighted = 0;
      for (const item of rolled) {
        const weight = normalizeWeight(item.child.weight);
        weightSum += weight;
        weighted += weight * item.progress.progress;
      }
      // 权重全是 0 的话退回等权，否则整层都会被算成 0。
      progress = weightSum > 0
        ? weighted / weightSum
        : rolled.reduce((sum, item) => sum + item.progress.progress, 0) / rolled.length;
      source = "rollup";
    } else if ((feishuTally?.get(node.id)?.total ?? 0) > 0) {
      // **绑了飞书关键词，这支目标的完成度就以表为准**——绑定这个动作本身
      // 就是「这支目标的进度活在那张表上」的意思，不该再要求他在 Obsidian
      // 里把同一件事写第二遍。表上没有命中的条目时会落到下面几条，安全降级。
      progress = feishuGoalProgress(feishuTally!.get(node.id)!);
      source = "feishu";
    } else if (node.metric && node.metric.target > 0) {
      progress = clamp((node.metric.current / node.metric.target) * 100, 0, 100);
      source = "metric";
    } else if (node.manualProgress !== null) {
      progress = node.manualProgress;
      source = "manual";
    }

    const own: GoalProgress = {
      id: node.id,
      progress: round2(progress),
      source,
      leaves: node.status === "dropped" ? 0 : leaves,
      doneLeaves: node.status === "dropped" ? 0 : doneLeaves,
      rolledChildren: rolled.length,
    };
    result.set(node.id, own);
    return own;
  };

  for (const node of nodes) visit(node);
  return result;
}

/** 整棵树的进度：顶层节点按权重收一次。空树是 0。 */
export function treeProgress(nodes: GoalNode[], progress: Map<string, GoalProgress>): number {
  const live = nodes.filter((node) => node.status !== "dropped");
  if (!live.length) return 0;
  let weightSum = 0;
  let weighted = 0;
  for (const node of live) {
    const weight = normalizeWeight(node.weight);
    weightSum += weight;
    weighted += weight * (progress.get(node.id)?.progress ?? 0);
  }
  if (weightSum > 0) return round2(weighted / weightSum);
  return round2(
    live.reduce((sum, node) => sum + (progress.get(node.id)?.progress ?? 0), 0) / live.length,
  );
}

// ---------------------------------------------------------------------------
// 向下拆分（半自动：这里只出建议，落不落由人按确认）
// ---------------------------------------------------------------------------

export type BreakdownScheme = "quarter" | "month" | "week" | "day" | "even";

export const BREAKDOWN_SCHEME_LABELS: Record<BreakdownScheme, string> = {
  quarter: "按季度",
  month: "按月",
  week: "按周",
  day: "按天",
  even: "均分成若干段",
};

export interface BreakdownOptions {
  scheme: BreakdownScheme;
  count: number;
  /** 第一段从哪天起算；季 / 月 / 周会对齐到所在周期的第一天 */
  from: Date;
  /** 不给就按父节点的下一层 */
  level?: GoalLevel;
}

export interface GoalDraft {
  title: string;
  level: GoalLevel;
  weight: number;
  metric: GoalMetric | null;
  due: string | null;
  kind: string | null;
}

/** 每层的默认切法。OKR 按季度落到 KPI，KPI 均分成几步落到日内目标。 */
export function defaultBreakdown(node: GoalNode, from: Date): BreakdownOptions {
  if (node.level === "okr") return { scheme: "quarter", count: 4, from };
  if (node.level === "kpi") return { scheme: "even", count: 5, from };
  if (node.level === "stage") return { scheme: "even", count: 4, from };
  return { scheme: "even", count: 3, from };
}

/**
 * 拆分建议。父目标有度量就把量摊到每一段（整数摊，余数给靠前的几段——早做完早安心），
 * 并且**用摊到的量当权重**：这样子目标做完一段，回灌上来的百分比恰好等于这一段占的量。
 */
export function suggestBreakdown(node: GoalNode, options: BreakdownOptions): GoalDraft[] {
  const count = Math.min(52, Math.max(1, Math.round(options.count)));
  const level = options.level ?? childLevelOf(node.level);
  const periods = periodsFor(options.scheme, options.from, count);
  const shares = node.metric && node.metric.target > 0 ? splitEvenly(node.metric.target, count) : null;

  return periods.map((period, index) => {
    const share = shares ? shares[index] : null;
    return {
      title: `${node.title} · ${period.label}`,
      level,
      weight: share ?? 1,
      metric: share === null ? null : { current: 0, target: share, unit: node.metric?.unit ?? "" },
      due: clampDay(period.end, node.due),
      kind: level === "daily" ? "Issue" : null,
    };
  });
}

/**
 * 把 total 摊成 count 份。整数目标摊成整数，余数分给靠前的几份；
 * 小数目标按两位小数摊，误差同样补在第一份上。无论哪种，**各份之和恰好等于 total**。
 */
export function splitEvenly(total: number, count: number): number[] {
  const parts = Math.max(1, Math.round(count));
  if (Number.isInteger(total)) {
    const base = Math.trunc(total / parts);
    const remainder = total - base * parts;
    return Array.from({ length: parts }, (_, index) => base + (index < remainder ? 1 : 0));
  }
  const base = round2(total / parts);
  const shares = Array.from({ length: parts }, () => base);
  shares[0] = round2(total - base * (parts - 1));
  return shares;
}

interface Period {
  label: string;
  end: string | null;
}

function periodsFor(scheme: BreakdownScheme, from: Date, count: number): Period[] {
  const periods: Period[] = [];
  if (scheme === "even") {
    for (let index = 0; index < count; index += 1) {
      periods.push({ label: `第 ${index + 1} 段`, end: null });
    }
    return periods;
  }

  const anchor = startOfPeriod(scheme, from);
  for (let index = 0; index < count; index += 1) {
    const start = advancePeriod(scheme, anchor, index);
    periods.push({ label: periodLabel(scheme, start), end: dateToDay(endOfPeriod(scheme, start)) });
  }
  return periods;
}

function startOfPeriod(scheme: BreakdownScheme, date: Date): Date {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0);
  if (scheme === "quarter") return new Date(day.getFullYear(), Math.floor(day.getMonth() / 3) * 3, 1, 12);
  if (scheme === "month") return new Date(day.getFullYear(), day.getMonth(), 1, 12);
  if (scheme === "week") {
    // 周一起算：getDay() 里周日是 0，先折算成 6。
    const offset = (day.getDay() + 6) % 7;
    day.setDate(day.getDate() - offset);
    return day;
  }
  return day;
}

function advancePeriod(scheme: BreakdownScheme, start: Date, steps: number): Date {
  const next = new Date(start.getTime());
  if (scheme === "quarter") next.setMonth(next.getMonth() + steps * 3);
  else if (scheme === "month") next.setMonth(next.getMonth() + steps);
  else if (scheme === "week") next.setDate(next.getDate() + steps * 7);
  else next.setDate(next.getDate() + steps);
  return next;
}

function endOfPeriod(scheme: BreakdownScheme, start: Date): Date {
  const end = new Date(start.getTime());
  if (scheme === "quarter") end.setMonth(end.getMonth() + 3);
  else if (scheme === "month") end.setMonth(end.getMonth() + 1);
  else if (scheme === "week") end.setDate(end.getDate() + 7);
  else end.setDate(end.getDate() + 1);
  end.setDate(end.getDate() - 1);
  return end;
}

function periodLabel(scheme: BreakdownScheme, start: Date): string {
  const year = start.getFullYear();
  if (scheme === "quarter") return `${year} Q${Math.floor(start.getMonth() / 3) + 1}`;
  if (scheme === "month") return `${year}-${pad(start.getMonth() + 1)}`;
  if (scheme === "week") return isoWeekLabel(start);
  return dateToDay(start);
}

/** ISO 周：以周四所在的年为准，第 1 周是含 1 月 4 日的那一周。 */
function isoWeekLabel(start: Date): string {
  const thursday = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 3, 12);
  const firstThursday = new Date(thursday.getFullYear(), 0, 4, 12);
  const offset = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - offset + 3);
  const week = Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86400000)) + 1;
  return `${thursday.getFullYear()}-W${pad(week)}`;
}

function clampDay(day: string | null, ceiling: string | null): string | null {
  if (!day) return null;
  if (ceiling && day > ceiling) return ceiling;
  return day;
}

// ---------------------------------------------------------------------------
// 落盘：缩进列表 Markdown
// ---------------------------------------------------------------------------

const TREE_HEADING = "## 树";
const QUARANTINE_TITLE = "## 待修复";
const INDENT = "    ";
/** 缩进列表的候选行：`- ` 之后得有东西。frontmatter 的 `---` 不会中招。 */
const BULLET = /^(\s*)-\s+(\S.*)$/;
const TASK = /^\[(.)\]\s*(.*)$/;
const INLINE_FIELD = /\[([^[\]:]+)::\s*([^\]]*)\]/g;
const BLOCK_ID = /\s+\^([A-Za-z0-9-]+)\s*$/;

export interface GoalSerializeOptions {
  generator: string;
}

export function serializeGoalTree(tree: GoalTree, options: GoalSerializeOptions): string {
  const progress = computeProgress(tree.roots);
  const all = walkGoals(tree.roots);
  const done = all.filter((node) => node.status === "done").length;

  const lines: string[] = [
    "---",
    `schemaVersion: ${GOAL_TREE_SCHEMA_VERSION}`,
    `generator: ${options.generator}`,
    `nextId: ${Math.max(1, Math.round(tree.nextId))}`,
    `nodeCount: ${all.length}`,
    `doneCount: ${done}`,
    `progress: ${formatNumber(treeProgress(tree.roots, progress))}`,
    "---",
    "",
    "# 目标树",
    "",
    "《知识库》「全目标管理」那六层，做成能跑的树。这份 Markdown 就是源头：插件读它、写它，",
    "你也可以在 Obsidian 里直接改，两边不打架。",
    "",
    "1. **缩进决定层级**：顶格是宇宙级，每往里缩一层降一级，最深停在日内目标。" +
      "跳级（比如人生级底下直接挂 OKR）会写出 `[层级:: OKR]`。",
    "2. **记号只认四个**：`[ ]` 未开始、`[/]` 进行中、`[x]` 已完成、`[-]` 已放弃。" +
      "已放弃整支退出上层汇总；别的记号会被归一成未开始。",
    "3. **`[进度:: 62%]` 是算出来的**——子节点按 `[权重:: n]` 回灌上来，改它没有意义。" +
      "要手写完成度用 `[完成:: 40%]`，可量化的目标用 `[度量:: 3/10 篇]`（度量比手写完成度优先）。",
    "4. **行尾的 `^g-7` 是节点 id**，同时是 Obsidian 的块引用锚点：`[[目标树#^g-7]]` 能直接链过来；" +
      "积分账本里那一笔的「任务」写成 `goal:g-7` 就指回这里。",
    "5. **`[飞书:: 关键词]` 把这支目标接到飞书金字塔表格上**：表上正文含这几个词里任意一个的" +
      "条目，就算在这支目标名下（顿号 / 逗号 / 空格分隔，可写多个）。留空就是不接。",
    "6. **认不出来的行不会被删**，会搬到文末《待修复》；在那儿改好了下次读盘自动归位。",
    "",
    TREE_HEADING,
    "",
  ];

  if (all.length) {
    appendNodes(lines, tree.roots, 0, null, progress);
  } else {
    lines.push("（还没有目标。在驾驶舱的目标树面板里新建，或者直接在这儿按上面的格式写一行。）");
  }

  if (tree.quarantine.length) {
    lines.push(
      "",
      QUARANTINE_TITLE,
      "",
      "下面这些行读不动（多半是手工改的时候记号或格式对不上）。它们不参与汇总，也不会被删除，",
      "改好之后会自动归位。",
      "",
      ...tree.quarantine,
    );
  }

  return `${lines.join("\n")}\n`;
}

function appendNodes(
  lines: string[],
  nodes: GoalNode[],
  depth: number,
  parentLevel: GoalLevel | null,
  progress: Map<string, GoalProgress>,
): void {
  for (const node of nodes) {
    lines.push(serializeNode(node, depth, parentLevel, progress));
    appendNodes(lines, node.children, depth + 1, node.level, progress);
  }
}

function serializeNode(
  node: GoalNode,
  depth: number,
  parentLevel: GoalLevel | null,
  progress: Map<string, GoalProgress>,
): string {
  const parts = [`${INDENT.repeat(depth)}- [${STATUS_MARKS[node.status]}] ${node.title}`];

  // 缩进已经说明的层级就不再写一遍；只有跳级才需要显式标出来。
  const impliedIndex = parentLevel === null ? 0 : Math.min(levelIndex(parentLevel) + 1, GOAL_LEVELS.length - 1);
  if (levelIndex(node.level) !== impliedIndex) {
    parts.push(field("层级", GOAL_LEVEL_SHORT[node.level]));
  }
  parts.push(field("进度", `${formatNumber(progress.get(node.id)?.progress ?? 0)}%`));
  if (node.metric) {
    const unit = node.metric.unit ? ` ${node.metric.unit}` : "";
    parts.push(field("度量", `${formatNumber(node.metric.current)}/${formatNumber(node.metric.target)}${unit}`));
  }
  if (node.manualProgress !== null) parts.push(field("完成", `${formatNumber(node.manualProgress)}%`));
  if (node.weight !== 1) parts.push(field("权重", formatNumber(node.weight)));
  if (node.kind) parts.push(field("类型", node.kind));
  if (node.due) parts.push(field("截止", node.due));
  if (node.feishuMatch) parts.push(field("飞书", node.feishuMatch));
  parts.push(...node.extras);
  parts.push(`^${node.id}`);

  return parts.join(" ");
}

export function parseGoalTree(text: string): GoalTree {
  const quarantine: string[] = [];
  const taken = new Set<string>();
  const roots: GoalNode[] = [];
  const stack: { indent: number; node: GoalNode }[] = [];
  let maxId = 0;
  const pending: { node: GoalNode; explicit: GoalLevel | null }[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    const bullet = BULLET.exec(line);
    if (!bullet) continue;

    const parsed = parseNodeLine(bullet[2]);
    if (!parsed) {
      quarantine.push(line);
      continue;
    }

    const indent = indentWidth(bullet[1]);
    // 缩进比栈顶浅或相同就一路弹到该挂的那一层；深了就是上一行的孩子。
    while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack.length ? stack[stack.length - 1].node : null;
    const depth = stack.length;

    let id = parsed.id;
    if (id && taken.has(id)) id = null; // 复制粘贴出来的重号：后来的那个重新取号
    if (id) {
      taken.add(id);
      maxId = Math.max(maxId, numericIdOf(id));
    }

    const impliedIndex = Math.min(depth, GOAL_LEVELS.length - 1);
    const node = createGoalNode(id ?? "", {
      ...parsed.input,
      level: parsed.explicit ?? GOAL_LEVELS[impliedIndex],
    });

    pending.push({ node, explicit: parsed.explicit });
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push({ indent, node });
  }

  // 没写 id 的行（手写新增、或重号被收走的那个）在这里统一补号，按文档顺序取，
  // 所以同一份文件读两遍拿到的 id 一样。
  let nextId = maxId + 1;
  for (const item of pending) {
    if (item.node.id) continue;
    while (taken.has(`g-${nextId}`)) nextId += 1;
    item.node.id = `g-${nextId}`;
    taken.add(item.node.id);
    nextId += 1;
  }

  // frontmatter 里的 nextId 只增不减：删掉编号最大的那个节点之后，新建的也不会
  // 捡回它的号，否则积分账本里旧的 `goal:g-7` 会指到一个毫不相干的新目标上。
  return {
    schemaVersion: GOAL_TREE_SCHEMA_VERSION,
    nextId: Math.max(nextId, maxId + 1, frontmatterNextId(text), 1),
    roots: relevelGoals(roots),
    quarantine,
  };
}

function frontmatterNextId(text: string): number {
  const match = /^nextId:\s*(\d+)\s*$/m.exec(text.split(/\r?\n/).slice(0, 20).join("\n"));
  return match ? Number(match[1]) : 0;
}

interface ParsedLine {
  id: string | null;
  explicit: GoalLevel | null;
  input: Omit<GoalInput, "level">;
}

function parseNodeLine(body: string): ParsedLine | null {
  const task = TASK.exec(body);
  if (!task) return null;

  const status = statusFromMark(task[1]);
  let rest = task[2];

  let id: string | null = null;
  const block = BLOCK_ID.exec(rest);
  if (block) {
    id = block[1];
    rest = rest.slice(0, block.index);
  }

  const parsed: Omit<GoalInput, "level" | "title"> = {
    status,
    manualProgress: null,
    metric: null,
    weight: 1,
    due: null,
    kind: null,
    feishuMatch: "",
    extras: [],
  };
  let explicit: GoalLevel | null = null;

  for (const match of rest.matchAll(INLINE_FIELD)) {
    const key = match[1].trim();
    const value = match[2].trim();
    if (key === "进度") continue; // 算出来的，读回来直接扔
    else if (key === "完成") parsed.manualProgress = parsePercent(value);
    else if (key === "度量") parsed.metric = parseMetric(value);
    else if (key === "权重") parsed.weight = parseWeight(value);
    else if (key === "截止") parsed.due = normalizeDay(value);
    else if (key === "类型") parsed.kind = value || null;
    else if (key === "飞书") parsed.feishuMatch = value;
    else if (key === "层级") explicit = parseLevel(value);
    else parsed.extras?.push(match[0]);
  }

  const title = rest.replace(INLINE_FIELD, "").replace(/\s+/g, " ").trim();
  if (!title) return null;
  return { id, explicit, input: { ...parsed, title } };
}

/** tab 按 4 空格算，混用缩进也能排出稳定的父子关系。 */
function indentWidth(indent: string): number {
  let width = 0;
  for (const char of indent) width += char === "\t" ? 4 : 1;
  return width;
}

function statusFromMark(mark: string): GoalStatus {
  const value = mark.toLowerCase();
  if (value === "x") return "done";
  if (value === "/") return "active";
  if (value === "-") return "dropped";
  return "planned";
}

function numericIdOf(id: string): number {
  const match = /^g-(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

function parseLevel(value: string): GoalLevel | null {
  const text = value.trim();
  for (const level of GOAL_LEVELS) {
    if (text === level || text === GOAL_LEVEL_SHORT[level] || text === GOAL_LEVEL_LABELS[level]) {
      return level;
    }
  }
  return null;
}

function parseMetric(value: string): GoalMetric | null {
  const match = /^(-?[\d.]+)\s*\/\s*(-?[\d.]+)\s*(.*)$/.exec(value.trim());
  if (!match) return null;
  const current = Number(match[1]);
  const target = Number(match[2]);
  if (!Number.isFinite(current) || !Number.isFinite(target)) return null;
  return { current: round2(current), target: round2(target), unit: match[3].trim() };
}

function parsePercent(value: string): number | null {
  const parsed = Number(value.replace("%", "").trim());
  if (!Number.isFinite(parsed)) return null;
  return clamp(round2(parsed), 0, 100);
}

function parseWeight(value: string): number {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? round2(parsed) : 1;
}

function field(key: string, value: string): string {
  return `[${key}:: ${escapeField(value)}]`;
}

/** 字段值里的 `]` 会把行切坏，换成全角的，不丢内容也不破格式。 */
function escapeField(value: string): string {
  return value.replace(/\]/g, "］").replace(/\s*\n\s*/g, " ").trim();
}

// ---------------------------------------------------------------------------
// 骨架与工具
// ---------------------------------------------------------------------------

/** 第一次用的六层骨架，措辞照抄《知识库》那一段，直接改就行。 */
export function defaultGoalSkeleton(): GoalTree {
  const titles: Record<GoalLevel, string> = {
    universe: "宇宙级目标：我愿意为之存在的那个尺度",
    life: "人生级目标：这一生要成为什么样的人",
    stage: "大阶段 / 五年计划：未来五年最该完成的那件事",
    okr: "【年度】OKR：今年的目标与关键结果",
    kpi: "【季度到每周】KPI：这个季度可量化的推进",
    daily: "日内目标：今天要推进的那一步",
  };

  let tree = createGoalTree();
  let parentId: string | null = null;
  for (const level of GOAL_LEVELS) {
    const taken = takeGoalId(tree);
    const node = createGoalNode(taken.id, {
      title: titles[level],
      level,
      kind: level === "daily" ? "Issue" : null,
    });
    tree = { ...taken.tree, roots: insertGoal(taken.tree.roots, parentId, node) };
    parentId = node.id;
  }
  return tree;
}

export function formatGoalProgress(value: number): string {
  return `${formatNumber(value)}%`;
}

/** 一行摘要：`OKR · 今年的目标 · 62%`，状态栏与下拉都用它。 */
export function describeGoal(node: GoalNode, progress?: Map<string, GoalProgress>): string {
  const own = progress?.get(node.id);
  const percent = progress ? formatGoalProgress(own?.progress ?? 0) : "";
  // **进度是从表上算出来的，就要说出来。** 一个数字悄悄换了来源，人只会以为
  // 自己填的那个完成度没生效——那正是「为什么它不听我的」这类问题的来路。
  const from = own?.source === "feishu" ? "飞书" : "";
  return [GOAL_LEVEL_SHORT[node.level], node.title, percent, from].filter(Boolean).join(" · ");
}

function normalizeWeight(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 1;
  return round2(value);
}

function normalizePercent(value: number | null): number | null {
  if (value === null || typeof value !== "number" || !Number.isFinite(value)) return null;
  return clamp(round2(value), 0, 100);
}

function normalizeMetric(metric: GoalMetric | null): GoalMetric | null {
  if (!metric) return null;
  const current = Number(metric.current);
  const target = Number(metric.target);
  if (!Number.isFinite(current) || !Number.isFinite(target)) return null;
  return { current: round2(current), target: round2(target), unit: (metric.unit ?? "").trim() };
}

function normalizeDay(value: string | null): string | null {
  if (!value) return null;
  const text = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function normalizeKind(value: string | null): string | null {
  if (!value) return null;
  const text = value.trim();
  return text || null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 数字最多两位小数，整数不带小数点——同一个数永远打出同一串字符。 */
function formatNumber(value: number): string {
  return String(round2(value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function dateToDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
