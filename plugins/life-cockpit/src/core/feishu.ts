// 飞书金字塔表格。出处（AME-258 第 19.1 条）：
//
//   「我其实每天很多具体任务或者具体项的话，我会写在那个飞书表格上面、那个金字塔
//    Excel 表格里面……飞书的金字塔表格，是一个非常适合我的表格；然后目前，我感觉
//    ta 很够用，还不用完全重写内置到 Obsidian 里面（而是我仍然在飞书表格上面做记录）；
//    再然后，目前看这个飞书表格的形式（包括其数据），如何很好的和我们现有的
//    【Obsidian 插件】结合一下。」
//
// 关键的一句是「**还不用完全重写内置到 Obsidian 里面**」。所以这一层明确**不做**：
// 不在插件里造第二张任务表、不写飞书 OpenAPI 客户端、不碰 app secret / user token。
// 记录仍然发生在飞书上，插件只做两件事：
//
//   1. **链接**——复工强提醒页、驾驶舱面板、命令面板上有一个点得开的入口，
//      「进入状态 / 复工提醒的时候，可以把这个【飞书文档链接】填入这个」；
//   2. **快照**——读一份别人导出好的 JSON，把「今天安排了什么、做完了没有」
//      摆进面板、强提醒页和复盘素材包；
//   3. **触发**——主路径是 Convex 的 `feishu:requestPull` job：它编排外部自动化去运行
//      `refresh_feishu_summary.sh`，插件订阅 `jobs:watch` 读取进度。旧的 Multica webhook
//      + Easy Git 轮询仍保留为下位补充，**插件不导表、不碰飞书凭据、不碰 GitHub token**。
//
// 为什么是快照而不是直连：飞书表格的导出**已经有一条跑通的管线**了
// （GA 的 `feishu_daily_tasks_report` SOP，`lark-cli sheets +export` → xlsx →
// `all_tasks.json`，靠单元格填色判完成度）。那条管线拿着 user token、认得那张表
// 的版式，插件再写一遍只会得到一个更差的第二实现，而且要把凭据搬进 vault。
// **所以约定的输入就是那条管线已经在产的 `all_tasks.json`**——把它拷进运行区即可，
// 格式一个字节都不用改。
//
// 快照读不到不是错误，是一种状态：那一天就只是没有飞书这一栏，别的照跑。

/** 表格里那四种填色对应的状态。原样沿用导出管线的中文措辞，不另起一套。 */
export type FeishuStatus = "已完成" | "完成了一部分" | "完全没去做" | "未知状态";

export const FEISHU_STATUSES: FeishuStatus[] = [
  "已完成",
  "完成了一部分",
  "完全没去做",
  "未知状态",
];

export interface FeishuTask {
  text: string;
  status: FeishuStatus;
  /** 高难 / 中难 / 低难；判不出来是空串 */
  difficulty: string;
  /** 工作内容 / 个人兴趣；判不出来是空串 */
  side: string;
  /** 原始 sheet 名，如 `2026年07月02日 周四` */
  sheet: string;
  /** 从 sheet 名解出来的 `YYYY-MM-DD`；解不出来是空串（模板页就是这种） */
  day: string;
}

export interface FeishuSnapshot {
  /** 导出时间，快照多旧一眼看得出来 */
  generatedAt: string;
  /** 表格地址，面板上点得开 */
  sourceUrl: string;
  tasks: FeishuTask[];
}

export interface FeishuSummary {
  total: number;
  done: number;
  partial: number;
  notStarted: number;
  unknown: number;
  /** 高难 / 中难 / 低难 → 条数 */
  byDifficulty: { label: string; count: number; done: number }[];
  /** 工作内容 / 个人兴趣 → 条数 */
  bySide: { label: string; count: number; done: number }[];
}

/**
 * 读一份快照。**三种形状都认**，因为产快照的可能不止一条路：
 *
 *   - `{ all_tasks: [...] }`——GA 那条管线的原始产物，拷过来即可；
 *   - `{ tasks: [...] }`——手写或别的脚本产的；
 *   - 一个裸数组——最省事的那种写法。
 *
 * 认三种不是纵容，是因为「约定定得复杂，夜班就没人遵守」（S1 那条教训）。
 * 读不动返回 null，由调用方决定是报错还是当成「今天没有飞书这一栏」。
 */
export function parseFeishuSnapshot(text: string): FeishuSnapshot | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const list = taskArray(raw);
  if (list === null) return null;

  const source = (Array.isArray(raw) ? {} : ((raw ?? {}) as Record<string, unknown>));
  return {
    generatedAt: str(source.generated_at) || str(source.generatedAt),
    sourceUrl: str(source.source_url) || str(source.sourceUrl),
    tasks: list.map(normalizeTask).filter((task) => task.text !== ""),
  };
}

function taskArray(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  if (Array.isArray(source.all_tasks)) return source.all_tasks;
  if (Array.isArray(source.tasks)) return source.tasks;
  return null;
}

function normalizeTask(raw: unknown): FeishuTask {
  const source = (raw ?? {}) as Record<string, unknown>;
  const sheet = str(source.sheet);
  return {
    text: str(source.text).trim(),
    status: asStatus(source.status),
    difficulty: str(source.difficulty).trim(),
    side: str(source.side).trim(),
    sheet,
    day: str(source.day).trim() || sheetDay(sheet),
  };
}

function asStatus(value: unknown): FeishuStatus {
  const text = str(value).trim();
  return (FEISHU_STATUSES as string[]).includes(text) ? (text as FeishuStatus) : "未知状态";
}

/**
 * `2026年07月02日 周四` → `2026-07-02`。
 *
 * sheet 名是这张表唯一的日期来源，而它的尾巴很随意（`3^`、`周四`、什么都没有），
 * 所以只认前面那段年月日，后面一律不管。解不出来返回空串——
 * 模板页（`模板(直接创建副本)`）本来就没有日期，那不是错误。
 */
export function sheetDay(sheet: string): string {
  const match = sheet.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (match) return `${match[1]}-${pad(match[2])}-${pad(match[3])}`;
  const iso = sheet.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  return iso ? `${iso[1]}-${pad(iso[2])}-${pad(iso[3])}` : "";
}

function pad(value: string): string {
  return value.padStart(2, "0");
}

/** 某一天的条目。日期解不出来的（模板页）永远不算进任何一天。 */
export function feishuTasksFor(snapshot: FeishuSnapshot, day: string): FeishuTask[] {
  return snapshot.tasks.filter((task) => task.day !== "" && task.day === day);
}

/**
 * 最近有记录的那一天。**这一条是给「今天还没填表」那种日子用的**：
 * 表上最后一次填的是三天前的话，与其显示一片空白，不如显示那三天前的清单
 * 并把日期写清楚——「我最近都在做什么」本来就是复盘要回答的问题。
 */
export function latestFeishuDay(snapshot: FeishuSnapshot, notAfter?: string): string {
  let latest = "";
  for (const task of snapshot.tasks) {
    if (!task.day) continue;
    if (notAfter && task.day > notAfter) continue;
    if (task.day > latest) latest = task.day;
  }
  return latest;
}

export function summarizeFeishu(tasks: FeishuTask[]): FeishuSummary {
  const byDifficulty = new Map<string, { count: number; done: number }>();
  const bySide = new Map<string, { count: number; done: number }>();
  let done = 0;
  let partial = 0;
  let notStarted = 0;
  let unknown = 0;

  for (const task of tasks) {
    if (task.status === "已完成") done += 1;
    else if (task.status === "完成了一部分") partial += 1;
    else if (task.status === "完全没去做") notStarted += 1;
    else unknown += 1;

    bump(byDifficulty, task.difficulty || "没标难度", task.status === "已完成");
    bump(bySide, task.side || "没分类", task.status === "已完成");
  }

  return {
    total: tasks.length,
    done,
    partial,
    notStarted,
    unknown,
    // 难度按「高中低」的固有次序排，不按条数——那一列的意义就是这个次序。
    byDifficulty: order(byDifficulty, ["高难", "中难", "低难"]),
    bySide: order(bySide, ["工作内容", "个人兴趣"]),
  };
}

function bump(
  map: Map<string, { count: number; done: number }>,
  key: string,
  done: boolean,
): void {
  const slot = map.get(key) ?? { count: 0, done: 0 };
  slot.count += 1;
  if (done) slot.done += 1;
  map.set(key, slot);
}

function order(
  map: Map<string, { count: number; done: number }>,
  preferred: string[],
): { label: string; count: number; done: number }[] {
  const rank = (label: string): number => {
    const index = preferred.indexOf(label);
    return index === -1 ? preferred.length : index;
  };
  return [...map.entries()]
    .map(([label, slot]) => ({ label, ...slot }))
    .sort((a, b) => rank(a.label) - rank(b.label) || b.count - a.count);
}

/** 一行话。推送正文、面板标题、强提醒页顶栏共用它，免得三处说法不一致。 */
export function feishuHeadline(day: string, summary: FeishuSummary): string {
  if (summary.total === 0) return `飞书表格 ${day}：这一天表上没有条目。`;
  const parts = [`共 ${summary.total} 项`, `已完成 ${summary.done}`];
  if (summary.partial) parts.push(`部分完成 ${summary.partial}`);
  if (summary.notStarted) parts.push(`没动 ${summary.notStarted}`);
  return `飞书表格 ${day}：${parts.join("、")}。`;
}

export interface FeishuRenderOptions {
  /** 表格地址；填了就在标题下面留一条点得开的链接 */
  url?: string;
  /** 最多列几条正文，其余折成一句「还有 N 条」 */
  limit?: number;
  /** 快照本身有多旧 */
  generatedAt?: string;
}

/**
 * 快照 → Markdown。强提醒页、驾驶舱面板、复盘草稿正文用的是同一份渲染。
 *
 * **没做完的排前面**：这一栏出现在复工强提醒页上，人在那几秒里要看的是
 * 「还欠什么」，不是「今天真棒」。
 */
export function describeFeishuTasks(
  day: string,
  tasks: FeishuTask[],
  options: FeishuRenderOptions = {},
): string {
  const summary = summarizeFeishu(tasks);
  const lines = [`## 飞书金字塔表格 · ${day}`, ""];
  lines.push(`- ${feishuHeadline(day, summary).replace(/^飞书表格[^：]*：/, "")}`);
  for (const slice of summary.bySide) {
    lines.push(`- ${slice.label}：${slice.done} / ${slice.count} 已完成`);
  }
  if (options.url) lines.push(`- 表格：${options.url}`);
  if (options.generatedAt) lines.push(`- 快照导出于 ${options.generatedAt}`);
  lines.push("");

  if (!tasks.length) {
    lines.push("这一天表上没有条目。要么还没填，要么快照该更新了。");
    return `${lines.join("\n")}\n`;
  }

  const limit = Math.max(1, options.limit ?? 12);
  const sorted = [...tasks].sort(
    (a, b) => statusRank(a.status) - statusRank(b.status) || difficultyRank(a) - difficultyRank(b),
  );
  for (const task of sorted.slice(0, limit)) {
    const tags = [task.difficulty, task.side].filter(Boolean).join(" · ");
    lines.push(`- ${mark(task.status)} ${task.text}${tags ? `　（${tags}）` : ""}`);
  }
  if (sorted.length > limit) lines.push(`- …还有 ${sorted.length - limit} 条，去表格里看。`);

  return `${lines.join("\n")}\n`;
}

function mark(status: FeishuStatus): string {
  if (status === "已完成") return "[x]";
  if (status === "完成了一部分") return "[/]";
  return "[ ]";
}

function statusRank(status: FeishuStatus): number {
  if (status === "完全没去做") return 0;
  if (status === "完成了一部分") return 1;
  if (status === "未知状态") return 2;
  return 3;
}

function difficultyRank(task: FeishuTask): number {
  const order = ["高难", "中难", "低难"];
  const index = order.indexOf(task.difficulty);
  return index === -1 ? order.length : index;
}

// ---------------------------------------------------------------------------
// 进复盘素材包的那一栏
// ---------------------------------------------------------------------------

/**
 * 复盘素材包里的飞书切片。出处是同一条 issue 的第 4 点：
 *
 *   「复盘你也可以考虑读取其中的一些……至少，能够知道我每天都大概干了什么
 *    （具体在做什么事情；我是一个什么方向的人；我的日常业务都有哪一些）。」
 *
 * 所以这里存的不只是数字，还有**没做完的原句**——「我在做什么事情」这一问，
 * 只有原句答得了，计数答不了。
 */
export interface FeishuReviewSlice {
  /** 这一栏取的是哪一天。可能不等于账本日：表上最近一次填的是哪天就是哪天 */
  day: string;
  url: string;
  generatedAt: string;
  total: number;
  done: number;
  partial: number;
  notStarted: number;
  /** 已完成的原句，最多几条 */
  finished: string[];
  /** 没做完的原句，最多几条 */
  pending: string[];
}

export function feishuReviewSlice(
  day: string,
  tasks: FeishuTask[],
  options: { url?: string; generatedAt?: string; limit?: number } = {},
): FeishuReviewSlice {
  const summary = summarizeFeishu(tasks);
  const limit = Math.max(1, options.limit ?? 20);
  return {
    day,
    url: options.url ?? "",
    generatedAt: options.generatedAt ?? "",
    total: summary.total,
    done: summary.done,
    partial: summary.partial,
    notStarted: summary.notStarted,
    finished: tasks.filter((task) => task.status === "已完成").map((task) => task.text).slice(0, limit),
    pending: tasks
      .filter((task) => task.status !== "已完成")
      .map((task) => `${task.text}（${task.status}）`)
      .slice(0, limit),
  };
}

// ---------------------------------------------------------------------------
// 和目标树的结合（AME-258 第 22.2 条）
//
//   「1、仍然需要，和【目标树、目标项】，做一个结合。」
//
// 结合点是**关键词**，不是 id：那张表是人在飞书上手写的，上面没有目标树的节点号，
// 要求他在飞书里写 `g-7` 等于把两个系统焊死，而他明说了「我仍然在飞书表格上面做记录」。
// 所以对齐由插件这一侧承担——目标项上写一串关键词，表上正文含其中任意一个就算命中。
//
// **一条可以同时命中多支目标**，这里不去重：一件事推进两支目标是常态，
// 强行判给其中一支只会让另一支看起来没动。
// ---------------------------------------------------------------------------

/** 目标树那一侧递过来的最小形状。这一层不 import goals.ts，免得两边互相咬。 */
export interface FeishuGoalBinding {
  id: string;
  title: string;
  keywords: string[];
}

export interface FeishuGoalSlice {
  goalId: string;
  title: string;
  keywords: string[];
  tasks: FeishuTask[];
  total: number;
  done: number;
}

export interface FeishuGoalRollup {
  slices: FeishuGoalSlice[];
  /** 一支目标都没挂上的条目。**它必须被看见**：这一栏是「今天做的事有没有在目标上」 */
  unmatched: FeishuTask[];
  /** 挂上了至少一支目标的条目数 */
  matched: number;
}

/** 这条表格条目命中了吗。大小写不敏感，别让 `AI` 和 `ai` 变成两个词。 */
export function feishuTaskMatches(task: FeishuTask, keywords: string[]): boolean {
  if (!keywords.length) return false;
  const text = task.text.toLowerCase();
  return keywords.some((word) => word.trim() !== "" && text.includes(word.trim().toLowerCase()));
}

export function rollupFeishuByGoal(
  bindings: FeishuGoalBinding[],
  tasks: FeishuTask[],
): FeishuGoalRollup {
  const claimed = new Set<FeishuTask>();
  const slices: FeishuGoalSlice[] = [];

  for (const binding of bindings) {
    if (!binding.keywords.length) continue;
    const hits = tasks.filter((task) => feishuTaskMatches(task, binding.keywords));
    for (const task of hits) claimed.add(task);
    slices.push({
      goalId: binding.id,
      title: binding.title,
      keywords: binding.keywords,
      tasks: hits,
      total: hits.length,
      done: hits.filter((task) => task.status === "已完成").length,
    });
  }

  return {
    slices,
    unmatched: tasks.filter((task) => !claimed.has(task)),
    matched: claimed.size,
  };
}

/** 目标树面板上那一枚小徽章：`飞书 2/3`。没挂条目的目标不显示。 */
export function feishuGoalBadge(slice: FeishuGoalSlice): string {
  return slice.total ? `飞书 ${slice.done}/${slice.total}` : "";
}

/** 强提醒页 / 面板上「这一天的表按目标分了什么」。挂不上的那几条排最后，但一定列出来。 */
export function describeFeishuByGoal(day: string, rollup: FeishuGoalRollup): string {
  const withTasks = rollup.slices.filter((slice) => slice.total > 0);
  if (!withTasks.length && !rollup.unmatched.length) return "";

  const lines = [`## 飞书 × 目标树 · ${day}`, ""];
  if (!withTasks.length) {
    lines.push(
      "表上这一天的条目一支目标都没挂上。去目标树面板给目标项填一行【飞书关键词】，" +
        "这一栏就会按目标分组。",
      "",
    );
  }
  for (const slice of withTasks) {
    lines.push(`- **${slice.title}**：${slice.done} / ${slice.total} 已完成`);
    for (const task of slice.tasks.filter((item) => item.status !== "已完成")) {
      lines.push(`    - ${mark(task.status)} ${task.text}`);
    }
  }
  if (rollup.unmatched.length) {
    lines.push(`- **没挂到目标上**：${rollup.unmatched.length} 条`);
    for (const task of rollup.unmatched.slice(0, 8)) {
      lines.push(`    - ${mark(task.status)} ${task.text}`);
    }
    if (rollup.unmatched.length > 8) {
      lines.push(`    - …还有 ${rollup.unmatched.length - 8} 条`);
    }
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// 快照是怎么来的（AME-258 第 22.2 条）
//
//   「其实我没看到有生成，也并不明白 相关的工作机制是怎样的？」
//
// 老实说：0.10.0 只写了**读**的那一半，没有任何东西会去产生那份快照——所以那个目录
// 当然是空的。这一节补上另一半，按他给的折中方案来：
//
//   1. 插件 POST 一下 Multica 上那条 **webhook 自动化**（不依赖任何自建后台）；
//   2. 对面的 Agent 去导表、把 JSON 写进仓库、推上去；
//   3. 本机用 **Easy Git** 拉下来（复用它已经配好的凭据，插件不碰 token）；
//   4. 插件重读快照目录——**「文件变新了」就是完成信号**。
//
// 第 4 步是这套方案的关键：他担心「WebHook 不太好获得具体的一个完成状态」，
// 而这里根本不需要问对面要状态——**产物本身就是状态**。对面成没成、慢不慢，
// 都由「盘上那份 JSON 有没有变新」来回答，一次网络往返都不用多花。
// ---------------------------------------------------------------------------

export type FeishuPullPhase = "idle" | "waiting" | "arrived" | "timeout" | "failed";

export interface FeishuPullState {
  phase: FeishuPullPhase;
  /** 触发那一刻的毫秒时间戳；idle 时为 0 */
  startedAt: number;
  /** 触发时盘上那份快照的身份。变了 = 新的到了 */
  baseline: string;
  /** 给人看的一句话 */
  detail: string;
}

export function createFeishuPullState(): FeishuPullState {
  return { phase: "idle", startedAt: 0, baseline: "", detail: "" };
}

/**
 * 快照的身份。**用「哪一天 + 导出时间 + 条数」三件事拼**，不用文件 mtime：
 * Easy Git 拉下来的文件 mtime 是本机写入时间，内容没变它也会变——
 * 那样每次拉取都会被判成「来了新的」，这个信号就废了。
 */
export function feishuSnapshotKey(input: {
  day: string;
  generatedAt: string;
  taskCount: number;
} | null): string {
  if (!input) return "";
  return `${input.day}|${input.generatedAt}|${input.taskCount}`;
}

export function startFeishuPull(baseline: string, now: number): FeishuPullState {
  return {
    phase: "waiting",
    startedAt: now,
    baseline,
    detail: "已经喊了一嗓子，等新的快照落地……",
  };
}

export function failFeishuPull(detail: string): FeishuPullState {
  return { phase: "failed", startedAt: 0, baseline: "", detail };
}

/**
 * 等到了没有。**只看快照本身变没变**，不问对面要状态。
 *
 * 超时不算失败，只是「还没等到」：对面可能跑了十分钟，也可能今天就是没人在。
 * 这两种都不该让人看到一句红色的「失败」——那会让他去查一个根本没坏的东西。
 */
export function tickFeishuPull(
  state: FeishuPullState,
  input: { now: number; currentKey: string; waitMs: number },
): FeishuPullState {
  if (state.phase !== "waiting") return state;
  if (input.currentKey !== "" && input.currentKey !== state.baseline) {
    const seconds = Math.max(1, Math.round((input.now - state.startedAt) / 1000));
    return {
      phase: "arrived",
      startedAt: state.startedAt,
      baseline: input.currentKey,
      detail: `新快照到了，用了 ${seconds} 秒。`,
    };
  }
  if (input.now - state.startedAt >= input.waitMs) {
    return {
      phase: "timeout",
      startedAt: state.startedAt,
      baseline: state.baseline,
      detail:
        `等了 ${Math.round(input.waitMs / 1000)} 秒还没等到新快照。` +
        "对面可能还在跑，也可能今天没人接——过一会儿按【重读快照】再看一眼。",
    };
  }
  return state;
}

/** 面板上那一行状态。四种阶段各说各的，别糊成一句「同步中」。 */
export function describeFeishuPull(state: FeishuPullState): string {
  if (state.phase === "idle") return "";
  return state.detail;
}

// ---------------------------------------------------------------------------

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
