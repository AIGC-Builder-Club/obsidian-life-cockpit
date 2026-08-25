import { ItemView, WorkspaceLeaf } from "obsidian";
import type LifeCockpitPlugin from "../main";
import {
  formatGoalProgress,
  GOAL_LEVEL_LABELS,
  GOAL_LEVEL_SHORT,
  GOAL_STATUS_LABELS,
  walkGoals,
} from "../core/goals";
import type { GoalNode, GoalStatus } from "../core/goals";
import { GoalEditModal } from "./goal-edit-modal";
import { GoalBreakdownModal } from "./goal-breakdown-modal";
import { ConfirmModal } from "./confirm-modal";

export const VIEW_TYPE_GOALS = "life-cockpit-goals";

const STATUS_MARKS: Record<GoalStatus, string> = {
  planned: "☐",
  active: "◐",
  done: "☑",
  dropped: "⊘",
};

/** 点一下记号在这三个之间转；「已放弃」是个决定，得进编辑窗里选。 */
const STATUS_CYCLE: GoalStatus[] = ["planned", "active", "done"];

/**
 * 目标树面板：六层、可折叠、每个节点带状态与进度。
 *
 * 进度条画的是**回灌上来的**那个数——所以把一个日内目标勾掉，能当场看见上面
 * 一路到 OKR 的条子都往前动一格。这就是这一项要的东西。
 *
 * 折叠状态只留在内存里，不落盘：它是看树的姿势，不是树的内容。
 */
export class GoalTreeView extends ItemView {
  private plugin: LifeCockpitPlugin;
  private collapsed = new Set<string>();
  private headEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  /** 只有内容真的变了才重画——驾驶舱那边每秒会喊一次 refresh */
  private signature = "";

  constructor(leaf: WorkspaceLeaf, plugin: LifeCockpitPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_GOALS;
  }

  getDisplayText(): string {
    return "目标树";
  }

  getIcon(): string {
    return "target";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("life-cockpit-goals-view");

    this.headEl = root.createDiv({ cls: "life-cockpit-goals-head" });
    this.hintEl = root.createDiv({ cls: "life-cockpit-goals-hint" });
    this.bodyEl = root.createDiv({ cls: "life-cockpit-goal-list" });

    this.refresh();
  }

  refresh(): void {
    if (!this.bodyEl) return;
    const next = this.currentSignature();
    if (next === this.signature) return;
    this.signature = next;

    this.renderHead();
    this.renderHint();
    this.renderTree();
  }

  private currentSignature(): string {
    const goals = this.plugin.goals;
    const nodes = walkGoals(goals.roots).map((node) => {
      const progress = goals.progressOf(node.id);
      const feishu = this.plugin.feishuGoalCounts(node.id);
      return [
        node.id,
        node.status,
        node.title,
        node.level,
        progress?.progress ?? 0,
        feishu ? `${feishu.done}/${feishu.total}` : "-",
      ].join(":");
    });
    return [
      goals.hasNote,
      goals.quarantine.length,
      this.plugin.pomodoroGoalId ?? "-",
      [...this.collapsed].sort().join(","),
      nodes.join("|"),
    ].join("#");
  }

  private renderHead(): void {
    this.headEl.empty();
    const goals = this.plugin.goals;
    const all = walkGoals(goals.roots);
    const done = all.filter((node) => node.status === "done").length;

    const summary = this.headEl.createDiv({ cls: "life-cockpit-goals-summary" });
    summary.createSpan({
      cls: "life-cockpit-points-value",
      text: formatGoalProgress(goals.overall),
    });
    summary.createSpan({
      cls: "life-cockpit-points-today",
      text: `${all.length} 个目标 · ${done} 个已完成`,
    });

    const actions = this.headEl.createDiv({ cls: "life-cockpit-goals-actions" });
    const create = actions.createEl("button", { cls: "mod-cta", text: "＋顶层目标" });
    create.addEventListener("click", () => new GoalEditModal(this.app, this.plugin, {}).open());

    const skeleton = actions.createEl("button", { text: "写六层骨架" });
    skeleton.addEventListener("click", () => void this.plugin.ensureGoalNote());

    const reload = actions.createEl("button", { text: "重读" });
    reload.addEventListener("click", () => void this.plugin.reloadGoals());

    const open = actions.createEl("button", { text: "打开笔记" });
    open.addEventListener("click", () => void this.plugin.openGoalNote());

    // 拉飞书快照那颗按钮就放在这儿（AME-258 第 22.2 条：「包括这个按钮，都可以放在
    // 【插件的右侧面板】的目标树或者其它相关的位置」）。放在目标树而不是别处，
    // 是因为拉回来的东西最终是按目标分组显示的——按完就在同一块面板上看得见结果。
    if (this.plugin.settings.feishuEnabled) {
      const pull = actions.createEl("button", { text: "拉飞书快照" });
      pull.setAttr("aria-label", "喊 Multica 上那条自动化去导一份最新的飞书表格");
      pull.addEventListener("click", () => void this.plugin.pullFeishuSnapshot());
    }
  }

  private renderHint(): void {
    this.hintEl.empty();
    const goals = this.plugin.goals;

    if (!goals.hasNote) {
      this.hintEl.createDiv({
        cls: "life-cockpit-hint",
        text: `目标树笔记还没建（${this.plugin.settings.goalTreeNote}）。按「写六层骨架」写一份，之后在 Obsidian 里直接改也行。`,
      });
    }
    if (goals.quarantine.length) {
      this.hintEl.createDiv({
        cls: "life-cockpit-hint",
        text: `有 ${goals.quarantine.length} 行读不动，已经搬到笔记末尾的《待修复》——它们不参与汇总，也没有被删掉。`,
      });
    }
  }

  private renderTree(): void {
    this.bodyEl.empty();
    const roots = this.plugin.goals.roots;
    if (!roots.length) {
      this.bodyEl.createDiv({
        cls: "life-cockpit-hint",
        text: "还没有目标。先立一个宇宙级的，再一层层往下拆。",
      });
      return;
    }
    for (const node of roots) this.renderNode(node, 0);
  }

  private renderNode(node: GoalNode, depth: number): void {
    const goals = this.plugin.goals;
    const progress = goals.progressOf(node.id);
    const percent = progress?.progress ?? 0;
    const collapsed = this.collapsed.has(node.id);

    const row = this.bodyEl.createDiv({ cls: "life-cockpit-goal-row" });
    row.style.paddingLeft = `${depth * 16}px`;
    row.toggleClass("is-done", node.status === "done");
    row.toggleClass("is-dropped", node.status === "dropped");
    row.toggleClass("is-current", this.plugin.pomodoroGoalId === node.id);

    const twist = row.createEl("button", {
      cls: "life-cockpit-goal-twist",
      text: node.children.length ? (collapsed ? "▸" : "▾") : "·",
    });
    twist.disabled = !node.children.length;
    twist.addEventListener("click", () => {
      if (collapsed) this.collapsed.delete(node.id);
      else this.collapsed.add(node.id);
      this.signature = "";
      this.refresh();
    });

    const mark = row.createEl("button", {
      cls: "life-cockpit-goal-mark",
      text: STATUS_MARKS[node.status],
      attr: { "aria-label": GOAL_STATUS_LABELS[node.status] },
    });
    mark.addEventListener("click", () => void this.cycleStatus(node));

    row.createSpan({
      cls: "life-cockpit-goal-level",
      text: GOAL_LEVEL_SHORT[node.level],
      attr: { "aria-label": GOAL_LEVEL_LABELS[node.level] },
    });

    const title = row.createSpan({ cls: "life-cockpit-goal-title", text: node.title });
    if (node.kind) title.createSpan({ cls: "life-cockpit-goal-kind", text: node.kind });
    if (node.due) title.createSpan({ cls: "life-cockpit-goal-due", text: node.due });
    if (node.metric) {
      title.createSpan({
        cls: "life-cockpit-goal-metric",
        text: `${node.metric.current}/${node.metric.target} ${node.metric.unit}`.trimEnd(),
      });
    }
    // 飞书那一枚徽章：这支目标今天在表上有几条、成了几条（AME-258 第 22.2 条）。
    // 没挂关键词、或者表上今天没这支目标的条目，就不占位置。
    const feishu = this.plugin.feishuGoalCounts(node.id);
    if (feishu) {
      title.createSpan({
        cls: "life-cockpit-goal-feishu",
        text: `飞书 ${feishu.done}/${feishu.total}`,
        attr: { "aria-label": `飞书金字塔表格上挂在这支目标下的条目：${feishu.done} / ${feishu.total} 已完成` },
      });
    }

    const track = row.createDiv({ cls: "life-cockpit-goal-track" });
    track.createDiv({ cls: "life-cockpit-goal-bar" }).style.width = `${Math.round(percent)}%`;
    row.createSpan({ cls: "life-cockpit-goal-percent", text: formatGoalProgress(percent) });

    this.renderActions(row, node);

    if (!collapsed) {
      for (const child of node.children) this.renderNode(child, depth + 1);
    }
  }

  private renderActions(row: HTMLElement, node: GoalNode): void {
    const actions = row.createDiv({ cls: "life-cockpit-goal-actions" });

    const add = actions.createEl("button", { text: "＋", attr: { "aria-label": "新建子目标" } });
    add.addEventListener("click", () =>
      new GoalEditModal(this.app, this.plugin, { parentId: node.id }).open(),
    );

    const split = actions.createEl("button", { text: "拆", attr: { "aria-label": "拆分建议" } });
    split.addEventListener("click", () => new GoalBreakdownModal(this.app, this.plugin, node).open());

    const edit = actions.createEl("button", { text: "✎", attr: { "aria-label": "编辑" } });
    edit.addEventListener("click", () => new GoalEditModal(this.app, this.plugin, { node }).open());

    if (this.plugin.canAttachGoal(node)) {
      const attached = this.plugin.pomodoroGoalId === node.id;
      const pin = actions.createEl("button", {
        text: attached ? "◉" : "○",
        attr: { "aria-label": attached ? "取消挂番茄" : "把番茄挂到这个目标上" },
      });
      pin.addEventListener("click", () => this.plugin.setPomodoroGoal(attached ? null : node.id));
    }

    const up = actions.createEl("button", { text: "↑", attr: { "aria-label": "上移" } });
    up.addEventListener("click", () => void this.plugin.moveGoal(node.id, -1));

    const down = actions.createEl("button", { text: "↓", attr: { "aria-label": "下移" } });
    down.addEventListener("click", () => void this.plugin.moveGoal(node.id, 1));

    const remove = actions.createEl("button", { text: "✕", attr: { "aria-label": "删除" } });
    remove.addEventListener("click", () => {
      const count = walkGoals([node]).length;
      new ConfirmModal(this.app, {
        title: "删掉这个目标？",
        body:
          count > 1
            ? `「${node.title}」连同底下 ${count - 1} 个子目标会一起从树上摘掉。已经记过的积分不会跟着消失，但那几笔会指向一个不存在的节点。`
            : `「${node.title}」会从树上摘掉。已经记过的积分不会跟着消失，但那几笔会指向一个不存在的节点。`,
        confirmText: "删掉",
        onConfirm: () => void this.plugin.removeGoal(node.id),
      }).open();
    });
  }

  private async cycleStatus(node: GoalNode): Promise<void> {
    const index = STATUS_CYCLE.indexOf(node.status);
    // 已放弃不在轮换里：点一下先回到未开始，要再放弃就进编辑窗。
    const next = STATUS_CYCLE[(index + 1) % STATUS_CYCLE.length];
    await this.plugin.updateGoal(node.id, { status: index < 0 ? "planned" : next });
  }
}
