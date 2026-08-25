// 候选区的读写层，也是人机交班面的收口点：夜班产物落候选区，人在这里逐条拍板。
//
// 和 PointsStore / GoalStore 一样，文件访问全部走注入的 VaultIo，故意不 import "obsidian"，
// 所以「扫候选区 → 采纳落到主干 → 原件归档 → 删原件」整条链路都能在 node --test 里跑真的。
//
// 三条规矩：
//   1. 不直接改主干——只有人按下「采纳」才写主干，夜班自己写不进去；
//   2. 不静默丢东西——采纳的原件移进 `_归档/` 不删，打回和改写留在原地；
//   3. 落点分派看 `类型`——目标树节点（R3）、账本一笔（R2）、普通笔记各走各的处理器。

import type { VaultIo } from "./vault-io";
import type { LifeCockpitSettings } from "./settings";
import type { GoalStore } from "./goal-store";
import type { PointsStore } from "./points-store";
import { GOAL_LEVEL_LABELS, GOAL_LEVEL_SHORT, GOAL_LEVELS } from "./goals";
import type { GoalLevel } from "./goals";
import { monthFileName, monthOf } from "./points";
import type { PointsDirection } from "./points";
import {
  adoptCandidate,
  candidateTitle,
  goalIdFromTarget,
  isPendingCandidate,
  parseCandidate,
  rejectCandidate,
  rewriteCandidate,
  serializeCandidate,
  splitOriginalSection,
} from "./candidates";
import type { Candidate, CandidateDecision, YamlValue } from "./candidates";

/** 拍板后原件搬进候选区下的这个目录。下划线开头，Obsidian 侧当工具区。 */
export const ARCHIVE_FOLDER = "_归档";

export interface CandidateFile {
  /** 所在的日期目录，`YYYY-MM-DD` */
  day: string;
  /** 文件名，含扩展名 */
  name: string;
  /** vault 内完整路径 */
  path: string;
  candidate: Candidate;
}

export interface CandidateStoreDeps {
  io: VaultIo;
  generator: string;
  /** 取当前设置，不做快照——设置改了下一次读写立刻生效 */
  settings: () => LifeCockpitSettings;
  /** 采纳成目标树节点（R3）时用；没给就只能采纳成笔记 */
  goals?: GoalStore | null;
  /** 采纳成账本一笔（R2）时用 */
  points?: PointsStore | null;
}

export interface DecisionResult {
  ok: boolean;
  /** 给人看的一句话，成功失败都有 */
  message: string;
  /** 采纳时实际写入的路径；没有落点的候选项是空串 */
  landing?: string;
  /** 原件归档到哪；只有采纳才归档 */
  archived?: string;
}

export interface AdoptOptions {
  at?: Date;
  /** 视图里改过的落点，覆盖 frontmatter 里的 `目标落点` */
  target?: string;
}

export interface RejectOptions {
  at?: Date;
  reason: string;
}

export interface RewriteOptions {
  at?: Date;
  body: string;
  reason?: string;
}

interface Landing {
  ok: boolean;
  message: string;
  landing: string;
}

export class CandidateStore {
  private deps: CandidateStoreDeps;
  private entries: CandidateFile[] = [];
  /** 候选区目录还不存在（或一条都没有）——面板上要能说清楚 */
  private folderMissing = true;

  constructor(deps: CandidateStoreDeps) {
    this.deps = deps;
  }

  get files(): CandidateFile[] {
    return this.entries;
  }

  /** 还等着人拍板的：待拍板 + 改写过还没落地的。 */
  get pending(): CandidateFile[] {
    return this.entries.filter((file) => isPendingCandidate(file.candidate));
  }

  get hasFolder(): boolean {
    return !this.folderMissing;
  }

  find(path: string): CandidateFile | null {
    return this.entries.find((file) => file.path === path) ?? null;
  }

  /**
   * 最近的打回理由。给人回看，也是验收条件里那句「理由要能被下一轮 Agent 读到」的人侧：
   * Agent 侧读的是留在原地的候选项文件本身，打回的那份不归档就是为了这个。
   */
  recentRejections(limit = 5): { file: CandidateFile; decision: CandidateDecision }[] {
    const found: { file: CandidateFile; decision: CandidateDecision }[] = [];
    for (const file of this.entries) {
      for (const decision of file.candidate.decisions) {
        if (decision.action === "打回") found.push({ file, decision });
      }
    }
    return found.sort((a, b) => b.decision.at.localeCompare(a.decision.at)).slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // 载入
  // -------------------------------------------------------------------------

  /** 扫一遍候选区。`_` 开头的目录是工具区（含归档），跳过。 */
  async load(): Promise<void> {
    const root = this.root;
    this.entries = [];
    this.folderMissing = true;
    if (!root) return;

    const days = (await this.deps.io.listFolders(root))
      .filter((name) => !name.startsWith("_"))
      .sort();
    if (!days.length) return;
    this.folderMissing = false;

    for (const day of days) {
      const folder = `${root}/${day}`;
      for (const name of (await this.deps.io.listMarkdown(folder)).sort()) {
        const path = `${folder}/${name}`;
        const text = await this.deps.io.read(path);
        if (text === null) continue;
        this.entries.push({ day, name, path, candidate: parseCandidate(text) });
      }
    }
    // 新的排前面：夜班天天往下落，最想看的是昨晚那批。
    this.entries.sort((a, b) => b.day.localeCompare(a.day) || a.name.localeCompare(b.name));
  }

  // -------------------------------------------------------------------------
  // 三个拍板动作
  // -------------------------------------------------------------------------

  /**
   * 采纳：按类型分派落点 → 写主干 → 原件带着裁决移进 `_归档/` → 删原件。
   *
   * 顺序是有讲究的：归档路径先算出来，主干笔记里那行「原文在哪」才能指向归档后的位置；
   * 落点写失败就整条中止，原件一动不动，人还能再按一次。
   */
  async adopt(path: string, options: AdoptOptions = {}): Promise<DecisionResult> {
    const file = this.find(path);
    if (!file) return missing();

    const at = options.at ?? new Date();
    const target = (options.target ?? file.candidate.target).trim();
    const archived = await this.archivePathFor(file);

    const landed = await this.land(file, target, archived, at);
    if (!landed.ok) return { ok: false, message: landed.message };

    const next = adoptCandidate(file.candidate, {
      at,
      actor: this.actor,
      landing: landed.landing,
    });
    await this.deps.io.writeIfChanged(archived, serializeCandidate(next));
    await this.deps.io.remove(file.path);
    this.entries = this.entries.filter((item) => item.path !== file.path);

    return { ok: true, message: landed.message, landing: landed.landing, archived };
  }

  /** 打回：理由落进 `裁决`，文件留在原地——下一轮夜班扫的就是它。 */
  async reject(path: string, options: RejectOptions): Promise<DecisionResult> {
    const file = this.find(path);
    if (!file) return missing();
    const reason = options.reason.trim();
    if (!reason) return { ok: false, message: "打回要带一句理由，下一轮夜班读的就是这句。" };

    const next = rejectCandidate(file.candidate, {
      at: options.at ?? new Date(),
      actor: this.actor,
      reason,
    });
    await this.write(file, next);
    return { ok: true, message: `已打回 · ${reason}` };
  }

  /** 改写：新正文写回本文件，原正文进文末《原始产物》，同样留在原地等采纳。 */
  async rewrite(path: string, options: RewriteOptions): Promise<DecisionResult> {
    const file = this.find(path);
    if (!file) return missing();
    if (!options.body.trim()) {
      return { ok: false, message: "改写后的正文是空的——想清空不如直接打回。" };
    }

    const next = rewriteCandidate(file.candidate, {
      at: options.at ?? new Date(),
      actor: this.actor,
      body: options.body,
      reason: options.reason,
    });
    await this.write(file, next);
    return { ok: true, message: "已改写 · 原正文留在文末《原始产物》。" };
  }

  // -------------------------------------------------------------------------
  // 落点分派。类型认不出来就按普通笔记走——夜班漏填一个字段不该让人卡住。
  // -------------------------------------------------------------------------

  private async land(
    file: CandidateFile,
    target: string,
    archived: string,
    at: Date,
  ): Promise<Landing> {
    if (file.candidate.type === "goal-node") return this.landGoal(file, target);
    if (file.candidate.type === "ledger-entry") return this.landLedger(file, target, at);
    return this.landNote(file, target, archived);
  }

  /**
   * 普通笔记 / 资讯总结：正文追加到落点笔记，前面带一行溯源。
   * 落点已经有这一条就不重复写——同一条按两次采纳不会写出两份。
   *
   * 进主干的只有**当前正文**：改写过的那条，文末《原始产物》是留在候选项里的历史，
   * 跟着落进主干只会把主干搞脏。要回看原文顺着那行溯源点回归档件。
   */
  private async landNote(file: CandidateFile, target: string, archived: string): Promise<Landing> {
    if (!target) {
      return { ok: true, landing: "", message: "这条没有落点，只归档留痕。" };
    }

    const mark = `采纳自候选区 · \`${file.candidate.id || file.path}\``;
    const existing = await this.deps.io.read(target);
    if (existing !== null && existing.includes(mark)) {
      return { ok: true, landing: target, message: `${target} 里已经有这一条了，没重复写。` };
    }

    const body = splitOriginalSection(file.candidate.body).main.trim();
    const block = `> ${mark} · 原件 [归档](${archived})\n\n${body}`;
    const next = existing === null ? `${block}\n` : `${existing.replace(/\s*$/, "")}\n\n${block}\n`;
    await this.deps.io.writeIfChanged(target, next);
    return { ok: true, landing: target, message: `已写入 ${target}` };
  }

  /**
   * 目标树节点（R3）：`目标落点` 指的是挂在哪个节点下，留空就挂顶层。
   * 标题取 `一句话说明`，层级可以用 `目标层级` 指定，不写就比父节点低一级。
   */
  private async landGoal(file: CandidateFile, target: string): Promise<Landing> {
    const goals = this.deps.goals;
    if (!goals || !this.settings.goalsEnabled) {
      return fail("目标树没开（设置 → 目标树），这条 goal-node 先别采纳。");
    }

    const parentId = goalIdFromTarget(target);
    if (target && !parentId) {
      return fail(
        "goal-node 的落点要指到目标树节点（`g-7` / `goal:g-7` / `[[目标树#^g-7]]`），留空表示挂顶层。",
      );
    }
    if (parentId && !goals.find(parentId)) {
      return fail(`目标落点指的 ${parentId} 不在树上，先去目标树面板看一眼。`);
    }

    const parent = goals.find(parentId);
    const node = await goals.create(parentId, {
      title: candidateTitle(file.candidate),
      level: parseGoalLevel(extraText(file.candidate, "目标层级")),
      kind: extraText(file.candidate, "目标类型") || null,
      due: extraText(file.candidate, "截止") || null,
    });

    const landing = `[[${noteBasename(this.settings.goalTreeNote)}#^${node.id}]]`;
    const where = parent ? `挂在「${parent.title}」下` : "挂在顶层";
    return { ok: true, landing, message: `目标树多了一个节点 ${node.id}，${where}。` };
  }

  /**
   * 账本一笔（R2）：分值和方向得由候选项自己写清楚（`方向` / `分值`），
   * 缺一个就不记——账目宁可不落，也不猜。`目标落点` 指到目标树节点时按目标记账。
   */
  private async landLedger(file: CandidateFile, target: string, at: Date): Promise<Landing> {
    const points = this.deps.points;
    if (!points || !this.settings.pointsEnabled) {
      return fail("积分账本没开（设置 → 积分账本），这条 ledger-entry 先别采纳。");
    }

    const direction = parseDirection(extraText(file.candidate, "方向"));
    const amount = Number(extraText(file.candidate, "分值"));
    if (!direction || !Number.isFinite(amount) || amount <= 0) {
      return fail("这条 ledger-entry 缺 `方向`（入账 / 出账）或 `分值`，补上再采纳。");
    }

    const goalId = goalIdFromTarget(target);
    if (target && !goalId) {
      return fail("ledger-entry 的落点只认目标树节点（`goal:g-7`），不指目标就留空。");
    }

    // 记在拍板的那一刻，不是候选项生成的那一刻：这一笔是人此刻认下来的。
    const entry = await points.record({
      at,
      direction,
      amount,
      reason: extraText(file.candidate, "事由") || candidateTitle(file.candidate),
      taskId: extraText(file.candidate, "任务") || null,
      goalId,
    });

    const folder = this.settings.pointsFolder.replace(/^\/+|\/+$/g, "");
    const monthPath = monthFileName(monthOf(entry.day));
    const landing = `${folder ? `${folder}/` : ""}${monthPath}#${entry.id}`;
    return { ok: true, landing, message: `账上多了一笔 ${direction === "earn" ? "+" : "-"}${amount}。` };
  }

  // -------------------------------------------------------------------------

  private async write(file: CandidateFile, next: Candidate): Promise<void> {
    await this.deps.io.writeIfChanged(file.path, serializeCandidate(next));
    this.entries = this.entries.map((item) =>
      item.path === file.path ? { ...item, candidate: next } : item,
    );
  }

  /**
   * 归档路径。同名文件已经在归档里就退一位（`-2`、`-3`），不覆盖：
   * 夜班可能在同一天重出一份同名产物，两份都得留着。
   */
  private async archivePathFor(file: CandidateFile): Promise<string> {
    const folder = `${this.root}/${ARCHIVE_FOLDER}/${file.day}`;
    const dot = file.name.lastIndexOf(".");
    const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
    const extension = dot > 0 ? file.name.slice(dot) : "";
    for (let index = 1; index <= 99; index += 1) {
      const path = index === 1 ? `${folder}/${file.name}` : `${folder}/${stem}-${index}${extension}`;
      if ((await this.deps.io.read(path)) === null) return path;
    }
    throw new Error(`人生驾驶舱：${folder} 下同名归档太多了，先手工清一清`);
  }

  private get settings(): LifeCockpitSettings {
    return this.deps.settings();
  }

  private get root(): string {
    return this.settings.candidatesFolder.replace(/^\/+|\/+$/g, "");
  }

  private get actor(): string {
    return this.settings.candidateActor.trim() || "人";
  }
}

// ---------------------------------------------------------------------------

function missing(): DecisionResult {
  return { ok: false, message: "这条候选项已经不在了，先按「重读」刷一下。" };
}

function fail(message: string): Landing {
  return { ok: false, landing: "", message };
}

/** 类型专属字段都放在 frontmatter 的自由位上，读不到就当没写。 */
export function extraText(candidate: Candidate, key: string): string {
  const value: YamlValue | undefined = candidate.extras[key];
  if (value === undefined || value === null || Array.isArray(value)) return "";
  return String(value).trim();
}

function parseDirection(value: string): PointsDirection | null {
  if (["入账", "earn", "收入", "+"].includes(value)) return "earn";
  if (["出账", "spend", "支出", "-"].includes(value)) return "spend";
  return null;
}

/**
 * `目标层级` 认英文 id（`okr`）也认中文名（`OKR` / `日内目标`）。
 * 认不出来就返回 undefined，交给 GoalStore 按父节点定——那条规则只该有一份。
 */
function parseGoalLevel(value: string): GoalLevel | undefined {
  const text = value.trim();
  if (!text) return undefined;
  const lower = text.toLowerCase();
  return GOAL_LEVELS.find(
    (level) =>
      level === lower ||
      GOAL_LEVEL_SHORT[level] === text ||
      GOAL_LEVEL_LABELS[level] === text,
  );
}

function noteBasename(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.md$/i, "");
}
