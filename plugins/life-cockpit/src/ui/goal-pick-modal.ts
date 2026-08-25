import { App, FuzzySuggestModal } from "obsidian";
import type LifeCockpitPlugin from "../main";
import { GOAL_LEVEL_SHORT } from "../core/goals";
import type { GoalNode } from "../core/goals";

/** 「不挂目标」也得能选，所以塞一个空 id 的哨兵进候选表。 */
const NONE_ID = "";

/** 命令面板里挑一个目标挂到当前番茄上。 */
export class GoalPickModal extends FuzzySuggestModal<GoalNode> {
  private plugin: LifeCockpitPlugin;
  private onPick: (goalId: string | null) => void;

  constructor(app: App, plugin: LifeCockpitPlugin, onPick: (goalId: string | null) => void) {
    super(app);
    this.plugin = plugin;
    this.onPick = onPick;
    this.setPlaceholder("这个番茄在推进哪个目标？");
  }

  getItems(): GoalNode[] {
    const none = {
      id: NONE_ID,
      level: "daily",
      title: "不挂目标",
      status: "planned",
      manualProgress: null,
      metric: null,
      weight: 1,
      due: null,
      kind: null,
      feishuMatch: "",
      extras: [],
      children: [],
    } satisfies GoalNode;
    return [none, ...this.plugin.goals.attachableGoals()];
  }

  getItemText(item: GoalNode): string {
    if (item.id === NONE_ID) return item.title;
    const percent = this.plugin.goals.progressOf(item.id)?.progress ?? 0;
    return `${GOAL_LEVEL_SHORT[item.level]} · ${this.plugin.goals.pathLabel(item.id)} · ${percent}%`;
  }

  onChooseItem(item: GoalNode): void {
    this.onPick(item.id === NONE_ID ? null : item.id);
  }
}
