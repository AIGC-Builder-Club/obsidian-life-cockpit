// 插件的内存结构 → 后端表的载荷。
//
// **为什么单独一层、而且是纯的**：0.13.0 那一版把 `queueForConvex()` 写好了却
// **一个调用点都没接**，于是出站队列永远是空的、面板永远显示「还没同步过」。
// 那是「在几个写盘点上分别挂钩」这种做法的典型下场——漏一个就整条链不通，
// 而且不通的时候一声不吭。
//
// 改法有两条：
//
// 1. **不再在写盘点挂钩，改成按拍对账**（见 `main.ts` 的 `reconcileConvex`）：
//    每一拍拿当前内存里的三样东西算指纹，变了才入队。**漏不掉任何写入点**，
//    而且断网期间攒下的改动回来自己就补上了。
// 2. 映射本身抽到这里，**不 import "obsidian"、不碰网络**，所以
//    「账本日怎么算的」「撤销状态怎么判的」「目标树怎么摊平的」全都能被
//    `node --test` 钉死，而不是等到线上才发现字段对不上。

import type { SessionRecord } from "./ledger";
import type { GoalNode, GoalTree } from "./goals";
import type { PointsEntry } from "./points";

// ---------------------------------------------------------------------------
// 番茄流水
// ---------------------------------------------------------------------------

export interface ConvexSession {
  sessionId: string;
  day: string;
  kind: "work" | "break" | "long-break";
  startedAt: string;
  endedAt: string | null;
  plannedSeconds: number;
  actualSeconds: number;
  completed: boolean;
  task: string | null;
  mode: string | null;
  pomodoroIndex: number | null;
  phase: string | null;
  segment: string | null;
  points: number | null;
  pointsRule: string | null;
  goalId: string | null;
  generator?: string;
}

/**
 * `day` **由插件带上来，后端不重算**——插件本来就要为文件名算一次账本日，
 * 算两遍就有两个口径，而这个仓库已经为「日期跟谁走」栽过一次跟头了。
 */
export function toConvexSession(
  session: SessionRecord,
  day: string,
  generator: string,
): ConvexSession {
  return {
    sessionId: session.id,
    day,
    kind: session.kind as ConvexSession["kind"],
    startedAt: session.startedAt,
    // 跑着的那一段还没有 endedAt，落成空串——后端要的是 null
    endedAt: session.endedAt || null,
    plannedSeconds: session.plannedSeconds,
    actualSeconds: session.actualSeconds,
    completed: session.completed,
    task: session.task || null,
    mode: session.mode || null,
    pomodoroIndex: session.pomodoroIndex ?? null,
    phase: session.phase ?? null,
    segment: session.segment ?? null,
    points: session.points ?? null,
    pointsRule: session.pointsRule ?? null,
    goalId: (session as { goalId?: string | null }).goalId ?? null,
    generator,
  };
}

// ---------------------------------------------------------------------------
// 积分流水
// ---------------------------------------------------------------------------

export interface ConvexLedgerEntry {
  entryId: string;
  day: string;
  at: string;
  direction: "+" | "-";
  amount: number;
  reason: string;
  task: string | null;
  source: string;
  relatedId: string | null;
  status: "有效" | "已撤销" | "撤销";
}

const SOURCE_LABELS: Record<string, string> = {
  manual: "手动",
  pomodoro: "番茄",
  reversal: "撤销",
};

/**
 * 撤销状态的判定和月账 Markdown 那一处**必须是同一套**
 * （`points.ts` 里那行 `entry.source === "reversal" ? "撤销" : voided.has(id) ? "已撤销" : "有效"`）。
 * 两处各写一套的下场是「账本上显示已撤销、库里显示有效」，而那种不一致
 * 没人会主动去查——只会在某天对不上账的时候才发现。
 */
export function toConvexLedgerEntry(
  entry: PointsEntry,
  voided: ReadonlySet<string>,
): ConvexLedgerEntry {
  return {
    entryId: entry.id,
    day: entry.day,
    at: entry.at,
    direction: entry.direction === "spend" ? "-" : "+",
    amount: entry.amount,
    reason: entry.reason,
    task: entry.taskId ?? null,
    source: SOURCE_LABELS[entry.source] ?? entry.source,
    relatedId: entry.ref ?? null,
    status:
      entry.source === "reversal"
        ? "撤销"
        : voided.has(entry.id)
          ? "已撤销"
          : "有效",
  };
}

// ---------------------------------------------------------------------------
// 目标树
// ---------------------------------------------------------------------------

export interface ConvexGoalNode {
  goalId: string;
  parentId: string | null;
  depth: number;
  order: number;
  title: string;
  mark: "todo" | "doing" | "done" | "abandoned";
  weight: number | null;
  manualProgress: number | null;
  metric: string | null;
  kind: string | null;
  dueDate: string | null;
  feishuKeyword: string | null;
}

const MARKS: Record<string, ConvexGoalNode["mark"]> = {
  planned: "todo",
  active: "doing",
  done: "done",
  dropped: "abandoned",
};

/**
 * 把树摊平成一串带 `parentId` 的节点。
 *
 * **父节点不存子 id 数组**：数组上限 8192，而且那会把父文档变成热点，
 * 让所有订阅它的 query 被无关变更触发。反挂 + `order` 就够还原顺序。
 *
 * **进度不传**——它在后端按权重现算。这一侧的 `[进度:: 62%]` 本来也是算出来的，
 * 传上去等于把一个派生值变成两个真相。
 */
export function toConvexGoalNodes(tree: GoalTree): ConvexGoalNode[] {
  const out: ConvexGoalNode[] = [];
  let order = 0;

  const walk = (node: GoalNode, parentId: string | null, depth: number): void => {
    out.push({
      goalId: node.id,
      parentId,
      depth,
      order: order++,
      title: node.title,
      mark: MARKS[node.status] ?? "todo",
      weight: typeof node.weight === "number" ? node.weight : null,
      manualProgress: node.manualProgress ?? null,
      // 度量在插件里是结构体，后端只存给人看的一行，回来也不需要再解析
      metric: node.metric
        ? `${node.metric.current}/${node.metric.target} ${node.metric.unit}`.trim()
        : null,
      kind: node.kind ?? null,
      dueDate: node.due ?? null,
      feishuKeyword: node.feishuMatch || null,
    });
    for (const child of node.children ?? []) walk(child, node.id, depth + 1);
  };

  for (const root of tree.roots ?? []) walk(root, null, 0);
  return out;
}

// ---------------------------------------------------------------------------
// 指纹：判断「变没变」
// ---------------------------------------------------------------------------

/**
 * 内容指纹。**只用来判断要不要重推**，不是安全用途，所以一个便宜的
 * 字符串哈希就够——重点是同样的内容一定给出同样的值。
 *
 * 用 JSON 序列化而不是逐字段比：字段以后会加，逐字段比的那份代码
 * 每加一个字段就要记得同步改一次，而忘了改的表现是「改了不同步」——
 * 又是一种一声不吭的失败。
 */
export function fingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(36)}${h2.toString(36)}`;
}
