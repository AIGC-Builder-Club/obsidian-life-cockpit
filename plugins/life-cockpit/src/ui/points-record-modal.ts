import { App, Modal, Notice, Setting } from "obsidian";
import type { TextComponent } from "obsidian";
import type LifeCockpitPlugin from "../main";
import { directionLabel, findTask, formatPoints } from "../core/points";
import type { PointsDirection, PointsTask } from "../core/points";

const TEMP_TASK = "__temp__";
const NO_GOAL = "__nogoal__";

/**
 * 随手记一笔。预设任务选下拉，临时任务选「临时任务」自己填——
 * 「非周期性 / 非常规 / 临时任务」不需要先在任务表里存在。
 */
export class RecordPointsModal extends Modal {
  private plugin: LifeCockpitPlugin;
  private direction: PointsDirection;
  private taskId: string = TEMP_TASK;
  private goalId: string = NO_GOAL;
  private amount = 1;
  private reason = "";
  private submitting = false;

  private taskSelect!: HTMLSelectElement;
  private descEl!: HTMLElement;
  private amountInput!: TextComponent;
  private reasonInput!: TextComponent;

  constructor(app: App, plugin: LifeCockpitPlugin, direction: PointsDirection = "earn") {
    super(app);
    this.plugin = plugin;
    this.direction = direction;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("life-cockpit-modal");
    contentEl.createEl("h3", { text: "记一笔积分" });

    new Setting(contentEl).setName("方向").addDropdown((dropdown) => {
      dropdown.addOption("earn", "入账 · 完成任务");
      dropdown.addOption("spend", "出账 · 享乐消耗");
      dropdown.setValue(this.direction);
      dropdown.onChange((value) => {
        this.direction = value === "spend" ? "spend" : "earn";
        this.taskId = TEMP_TASK;
        this.renderTaskOptions();
        this.descEl.setText(this.taskDesc);
      });
    });

    const taskSetting = new Setting(contentEl).setName("任务");
    this.descEl = taskSetting.descEl;
    taskSetting.addDropdown((dropdown) => {
      // 直接拿 selectEl：换方向要重排选项，用 Setting 整块重建会在
      // 下拉自己的 change 回调里把自己删掉。
      this.taskSelect = dropdown.selectEl;
      dropdown.onChange((value) => {
        this.taskId = value;
        const task = findTask(this.options, value);
        if (!task) return;
        this.amount = task.points;
        this.reason = task.label;
        this.amountInput.setValue(String(this.amount));
        this.reasonInput.setValue(this.reason);
      });
    });
    this.renderTaskOptions();
    this.descEl.setText(this.taskDesc);

    if (this.plugin.settings.goalsEnabled) {
      const goals = this.plugin.goals.attachableGoals();
      new Setting(contentEl)
        .setName("推进的目标")
        .setDesc(
          goals.length
            ? "挂上之后这一笔会指回目标树节点，复盘就能问「分都花在哪个目标上」。"
            : "目标树上还没有可挂的日内目标 / KPI。",
        )
        .addDropdown((dropdown) => {
          dropdown.addOption(NO_GOAL, "不挂目标");
          for (const node of goals) {
            dropdown.addOption(node.id, this.plugin.goals.pathLabel(node.id));
          }
          dropdown.setValue(this.goalId);
          dropdown.onChange((value) => {
            this.goalId = value;
          });
        });
    }

    new Setting(contentEl).setName("分值").addText((text) => {
      this.amountInput = text;
      text.inputEl.type = "number";
      text.inputEl.addClass("life-cockpit-number-input");
      text.setValue(String(this.amount));
      text.onChange((value) => {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) this.amount = parsed;
      });
    });

    new Setting(contentEl)
      .setName("事由")
      .setDesc("写清楚这一笔为什么发生——复盘只看得到你在这里写的话。")
      .addText((text) => {
        this.reasonInput = text;
        text.setPlaceholder("例如：临时帮同事看一份合同");
        text.setValue(this.reason);
        text.inputEl.addClass("life-cockpit-wide-input");
        text.onChange((value) => {
          this.reason = value;
        });
        window.setTimeout(() => text.inputEl.focus(), 0);
      });

    new Setting(contentEl).addButton((button) => {
      button.setButtonText("记账").setCta();
      button.onClick(() => void this.submit());
    });

    contentEl.createDiv({
      cls: "life-cockpit-hint",
      text: "记错了可以在账本里撤销：撤销会留下一笔反向流水，原笔照旧留在账上。",
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private get options(): PointsTask[] {
    return this.direction === "earn" ? this.plugin.points.earnTasks() : this.plugin.points.spendTasks();
  }

  private get taskDesc(): string {
    return `${directionLabel(this.direction)}项来自积分任务表；临时任务不用先登记。`;
  }

  private renderTaskOptions(): void {
    this.taskSelect.empty();
    for (const task of this.options) {
      this.taskSelect.createEl("option", {
        value: task.id,
        text: `${task.label}（${formatPoints(task.points)}）`,
      });
    }
    this.taskSelect.createEl("option", { value: TEMP_TASK, text: "临时任务（自己填）" });
    this.taskSelect.value = this.taskId;
  }

  private async submit(): Promise<void> {
    if (this.submitting) return;
    if (!(this.amount > 0)) {
      new Notice("分值要是大于 0 的数。");
      return;
    }
    const reason = this.reason.trim();
    if (!reason) {
      new Notice("写一句事由，否则复盘的时候看不懂这笔是什么。");
      return;
    }

    this.submitting = true;
    const entry = await this.plugin.recordPoints({
      direction: this.direction,
      amount: this.amount,
      reason,
      taskId: this.taskId === TEMP_TASK ? null : this.taskId,
      goalId: this.goalId === NO_GOAL ? null : this.goalId,
    });
    this.submitting = false;
    if (entry) this.close();
  }
}
