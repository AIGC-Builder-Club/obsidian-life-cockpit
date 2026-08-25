// 目标树的读写层。和 PointsStore 一样：文件访问全部走注入的 VaultIo，故意不 import
// "obsidian"，所以「读盘 → 改树 → 回灌 → 写盘幂等」整条链路都能在 node --test 里跑真的。
//
// 整棵树只有一个文件、体量很小，所以一次全读进来。回灌是纯计算，每次改动之后重算一遍，
// 不维护任何增量缓存去和源头对账。

import { StaleMissingError } from "./vault-io";
import type { VaultIo } from "./vault-io";
import type { LifeCockpitSettings } from "./settings";
import {
  childLevelOf,
  computeProgress,
  createGoalNode,
  createGoalTree,
  defaultGoalSkeleton,
  describeGoal,
  findGoal,
  GOAL_LEVELS,
  goalPath,
  insertGoal,
  levelIndex,
  moveGoal,
  parentOfGoal,
  parseGoalTree,
  relevelGoals,
  removeGoal,
  serializeGoalTree,
  takeGoalId,
  treeProgress,
  updateGoal,
  walkGoals,
  FeishuGoalTally,
} from "./goals";
import type {
  GoalDraft,
  GoalInput,
  GoalLevel,
  GoalNode,
  GoalProgress,
  GoalStatus,
  GoalTree,
} from "./goals";

export interface GoalStoreDeps {
  io: VaultIo;
  generator: string;
  /** 取当前设置，不做快照——设置改了下一次读写立刻生效 */
  settings: () => LifeCockpitSettings;
}

/** 能挂到番茄上的层级：日内目标是本分，KPI 是给还没拆到日内的人留的口子。 */
const ATTACHABLE: GoalLevel[] = ["kpi", "daily"];

export class GoalStore {
  private deps: GoalStoreDeps;
  private currentTree: GoalTree = createGoalTree();
  private progressMap = new Map<string, GoalProgress>();
  /**
   * 飞书那张表上每支目标的战绩。**由 main.ts 按 `[飞书:: 关键词]` 匹配好喂进来**，
   * 这一层不认识飞书，只负责在算进度时把它带上。空 map = 没接飞书，一切照旧。
   */
  private feishuTally = new Map<string, FeishuGoalTally>();
  /** 目标树笔记还不存在——面板上要能提示「去建一份」 */
  private noteMissing = true;

  constructor(deps: GoalStoreDeps) {
    this.deps = deps;
    this.recompute();
  }

  get tree(): GoalTree {
    return this.currentTree;
  }

  get roots(): GoalNode[] {
    return this.currentTree.roots;
  }

  get quarantine(): string[] {
    return this.currentTree.quarantine;
  }

  get hasNote(): boolean {
    return !this.noteMissing;
  }

  get isEmpty(): boolean {
    return this.currentTree.roots.length === 0;
  }

  get progress(): Map<string, GoalProgress> {
    return this.progressMap;
  }

  /** 整棵树的进度，状态栏与面板抬头用。 */
  get overall(): number {
    return treeProgress(this.currentTree.roots, this.progressMap);
  }

  progressOf(id: string): GoalProgress | null {
    return this.progressMap.get(id) ?? null;
  }

  find(id: string | null): GoalNode | null {
    return findGoal(this.currentTree.roots, id);
  }

  /** `OKR › KPI › 日内目标` 这样一条面包屑，让人知道这个番茄在推进哪一支。 */
  pathLabel(id: string, separator = " › "): string {
    return goalPath(this.currentTree.roots, id)
      .map((node) => node.title)
      .join(separator);
  }

  describe(id: string): string {
    const node = this.find(id);
    return node ? describeGoal(node, this.progressMap) : "";
  }

  /** 可以挂番茄的节点：未完成、未放弃的日内目标与 KPI，按树里的顺序。 */
  attachableGoals(): GoalNode[] {
    return walkGoals(this.currentTree.roots).filter(
      (node) =>
        ATTACHABLE.includes(node.level) && node.status !== "done" && node.status !== "dropped",
    );
  }

  // -------------------------------------------------------------------------
  // 读写
  // -------------------------------------------------------------------------

  async load(): Promise<void> {
    const path = this.notePath;
    const text = path ? await this.deps.io.read(path) : null;
    if (text === null) {
      this.noteMissing = true;
      this.currentTree = createGoalTree();
      this.recompute();
      return;
    }
    this.noteMissing = false;
    this.currentTree = parseGoalTree(text);
    this.recompute();
  }

  async save(): Promise<boolean> {
    const path = this.notePath;
    if (!path) return false;
    await this.guardStaleMissing(path);
    const written = await this.deps.io.writeIfChanged(
      path,
      serializeGoalTree(this.currentTree, { generator: this.deps.generator }),
    );
    this.noteMissing = false;
    return written;
  }

  /**
   * 整棵树是整份重写的，所以「以为笔记不在」这个判断错了就是抹掉人的目标树。
   * 冷启动时 vault 索引还没建好、读回 null，正是这个判断出错的场面（AME-227）。
   * 落盘前再问一次盘：真在，就宁可报错让人重读，也不拿空树盖上去。
   */
  private async guardStaleMissing(path: string): Promise<void> {
    if (!this.noteMissing) return;
    if ((await this.deps.io.read(path)) === null) return;
    throw new StaleMissingError(
      `目标树笔记 ${path} 已经在盘上了，但这次载入没读到它。` +
        `先跑一次「重读目标树」，别拿空树覆盖它。`,
    );
  }

  /** 笔记不在（或树是空的）就写一份六层骨架，照《知识库》那一段的措辞。 */
  async writeSkeleton(): Promise<boolean> {
    if (this.currentTree.roots.length) return this.save();
    const skeleton = defaultGoalSkeleton();
    this.currentTree = { ...skeleton, quarantine: this.currentTree.quarantine };
    this.recompute();
    return this.save();
  }

  // -------------------------------------------------------------------------
  // 编辑。每一步都是「改内存 → 重算回灌 → 写盘」，写盘走 writeIfChanged。
  // -------------------------------------------------------------------------

  async create(parentId: string | null, input: Omit<GoalInput, "level"> & { level?: GoalLevel }): Promise<GoalNode> {
    const parent = this.find(parentId);
    const taken = takeGoalId(this.currentTree);
    const node = createGoalNode(taken.id, { ...input, level: this.levelFor(parent, input.level) });
    this.currentTree = { ...taken.tree, roots: insertGoal(taken.tree.roots, parent?.id ?? null, node) };
    await this.commit();
    return node;
  }

  async update(id: string, patch: Partial<GoalInput>): Promise<void> {
    this.currentTree = {
      ...this.currentTree,
      roots: updateGoal(this.currentTree.roots, id, patch),
    };
    await this.commit();
  }

  async setStatus(id: string, status: GoalStatus): Promise<void> {
    await this.update(id, { status });
  }

  async remove(id: string): Promise<void> {
    this.currentTree = { ...this.currentTree, roots: removeGoal(this.currentTree.roots, id) };
    await this.commit();
  }

  async move(id: string, delta: number): Promise<void> {
    this.currentTree = { ...this.currentTree, roots: moveGoal(this.currentTree.roots, id, delta) };
    await this.commit();
  }

  /**
   * 落一批拆分建议。人在拆分窗里确认过才走到这里——建议本身不会自己落盘，
   * 「半自动」那一半就是这个 gate。
   */
  async applyBreakdown(parentId: string, drafts: GoalDraft[]): Promise<GoalNode[]> {
    const parent = this.find(parentId);
    if (!parent || !drafts.length) return [];

    let tree = this.currentTree;
    const created: GoalNode[] = [];
    for (const draft of drafts) {
      const taken = takeGoalId(tree);
      const node = createGoalNode(taken.id, {
        title: draft.title,
        level: this.levelFor(parent, draft.level),
        weight: draft.weight,
        metric: draft.metric,
        due: draft.due,
        kind: draft.kind,
      });
      tree = { ...taken.tree, roots: insertGoal(taken.tree.roots, parent.id, node) };
      created.push(node);
    }

    this.currentTree = tree;
    await this.commit();
    return created;
  }

  // -------------------------------------------------------------------------

  private async commit(): Promise<void> {
    this.currentTree = { ...this.currentTree, roots: relevelGoals(this.currentTree.roots) };
    this.recompute();
    await this.save();
  }

  private recompute(): void {
    this.progressMap = computeProgress(this.currentTree.roots, this.feishuTally);
  }

  /**
   * 换一份飞书战绩并重算进度。**只在内容真的变了时才重算**——
   * 面板每秒问一次，白重算一棵树是纯浪费。返回是否真的变了，方便调用方决定要不要重画。
   */
  setFeishuTally(tally: Map<string, FeishuGoalTally>): boolean {
    if (sameTally(this.feishuTally, tally)) return false;
    this.feishuTally = tally;
    this.recompute();
    return true;
  }

  /** 子节点至少比父节点深一级；想跳级（人生级底下直接挂 OKR）传 level 即可。 */
  private levelFor(parent: GoalNode | null, wanted: GoalLevel | undefined): GoalLevel {
    if (!parent) return wanted ?? GOAL_LEVELS[0];
    const floor = levelIndex(childLevelOf(parent.level));
    if (!wanted) return GOAL_LEVELS[floor];
    return GOAL_LEVELS[Math.max(floor, levelIndex(wanted))];
  }

  private get notePath(): string {
    return this.deps.settings().goalTreeNote.trim();
  }
}

/** 便于 UI 拿父节点做面包屑与层级判断。 */
export function goalParent(roots: GoalNode[], id: string): GoalNode | null {
  return parentOfGoal(roots, id);
}

/** 两份战绩一不一样。**只比用得上的那三个数**，不做深比较。 */
function sameTally(
  a: Map<string, FeishuGoalTally>,
  b: Map<string, FeishuGoalTally>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [id, left] of a) {
    const right = b.get(id);
    if (!right) return false;
    if (left.done !== right.done || left.partial !== right.partial || left.total !== right.total) {
      return false;
    }
  }
  return true;
}
