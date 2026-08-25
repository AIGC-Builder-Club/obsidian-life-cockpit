import { App, Modal, Notice, Setting } from "obsidian";
import type LifeCockpitPlugin from "../main";
import {
  DAILY_KINDS,
  GOAL_LEVEL_LABELS,
  GOAL_LEVELS,
  GOAL_STATUS_LABELS,
} from "../core/goals";
import type { GoalInput, GoalLevel, GoalNode, GoalStatus } from "../core/goals";

interface Draft {
  title: string;
  status: GoalStatus;
  level: GoalLevel;
  kind: string;
  manualProgress: string;
  metricCurrent: string;
  metricTarget: string;
  metricUnit: string;
  weight: string;
  due: string;
  /** 飞书金字塔表格里认哪几个关键词（AME-258 第 22.2 条） */
  feishuMatch: string;
}

/**
 * 新建 / 编辑一个目标。
 *
 * 进度这一栏刻意只收「手写完成度」和「度量」：有子节点的时候进度是回灌上来的，
 * 这里填什么都不算数——所以有子节点时直接把这两栏说明成「不生效」，不骗人。
 */
export class GoalEditModal extends Modal {
  private plugin: LifeCockpitPlugin;
  private parentId: string | null;
  private node: GoalNode | null;
  private draft: Draft;
  private submitting = false;

  constructor(
    app: App,
    plugin: LifeCockpitPlugin,
    options: { parentId?: string | null; node?: GoalNode | null },
  ) {
    super(app);
    this.plugin = plugin;
    this.parentId = options.parentId ?? null;
    this.node = options.node ?? null;
    this.draft = this.initialDraft();
  }

  private initialDraft(): Draft {
    const node = this.node;
    const parent = this.plugin.goals.find(this.parentId);
    const fallbackLevel: GoalLevel = parent
      ? GOAL_LEVELS[Math.min(GOAL_LEVELS.indexOf(parent.level) + 1, GOAL_LEVELS.length - 1)]
      : GOAL_LEVELS[0];

    return {
      title: node?.title ?? "",
      status: node?.status ?? "planned",
      level: node?.level ?? fallbackLevel,
      kind: node?.kind ?? "",
      manualProgress: node?.manualProgress === null || node === null ? "" : String(node.manualProgress),
      metricCurrent: node?.metric ? String(node.metric.current) : "",
      metricTarget: node?.metric ? String(node.metric.target) : "",
      metricUnit: node?.metric?.unit ?? "",
      weight: node ? String(node.weight) : "1",
      due: node?.due ?? "",
      feishuMatch: node?.feishuMatch ?? "",
    };
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("life-cockpit-modal");
    contentEl.createEl("h3", { text: this.node ? "编辑目标" : "新建目标" });

    const anchor = this.node ?? this.plugin.goals.find(this.parentId);
    if (anchor) {
      contentEl.createDiv({
        cls: "life-cockpit-hint",
        text: `${this.node ? "位置" : "挂在"}：${this.plugin.goals.pathLabel(anchor.id)}`,
      });
    }

    new Setting(contentEl).setName("标题").addText((text) => {
      text.setPlaceholder("这个目标是什么");
      text.setValue(this.draft.title);
      text.inputEl.addClass("life-cockpit-wide-input");
      text.onChange((value) => {
        this.draft.title = value;
      });
      window.setTimeout(() => text.inputEl.focus(), 0);
    });

    new Setting(contentEl)
      .setName("层级")
      .setDesc("默认比父目标低一级。想跳级（人生级底下直接挂 OKR）在这儿改。")
      .addDropdown((dropdown) => {
        for (const level of GOAL_LEVELS) dropdown.addOption(level, GOAL_LEVEL_LABELS[level]);
        dropdown.setValue(this.draft.level);
        dropdown.onChange((value) => {
          this.draft.level = value as GoalLevel;
        });
      });

    new Setting(contentEl)
      .setName("状态")
      .setDesc("已放弃的整支退出上层汇总；已完成压过子节点，按 100% 记。")
      .addDropdown((dropdown) => {
        for (const status of Object.keys(GOAL_STATUS_LABELS) as GoalStatus[]) {
          dropdown.addOption(status, GOAL_STATUS_LABELS[status]);
        }
        dropdown.setValue(this.draft.status);
        dropdown.onChange((value) => {
          this.draft.status = value as GoalStatus;
        });
      });

    new Setting(contentEl)
      .setName("类型")
      .setDesc(`日内目标的种类：${DAILY_KINDS.join(" / ")}。别的层留空即可。`)
      .addText((text) => {
        text.setPlaceholder("留空");
        text.setValue(this.draft.kind);
        text.onChange((value) => {
          this.draft.kind = value;
        });
      });

    const rolled = this.node ? this.node.children.some((child) => child.status !== "dropped") : false;

    const metric = new Setting(contentEl)
      .setName("度量")
      .setDesc(
        rolled
          ? "这个目标有子节点，进度按子节点回灌，度量只作展示。"
          : "可量化的目标填这里：已完成 / 目标 / 单位。它比手写完成度优先。",
      );
    metric.addText((text) => {
      text.setPlaceholder("已完成");
      text.inputEl.type = "number";
      text.inputEl.addClass("life-cockpit-number-input");
      text.setValue(this.draft.metricCurrent);
      text.onChange((value) => {
        this.draft.metricCurrent = value;
      });
    });
    metric.addText((text) => {
      text.setPlaceholder("目标");
      text.inputEl.type = "number";
      text.inputEl.addClass("life-cockpit-number-input");
      text.setValue(this.draft.metricTarget);
      text.onChange((value) => {
        this.draft.metricTarget = value;
      });
    });
    metric.addText((text) => {
      text.setPlaceholder("单位");
      text.inputEl.addClass("life-cockpit-number-input");
      text.setValue(this.draft.metricUnit);
      text.onChange((value) => {
        this.draft.metricUnit = value;
      });
    });

    new Setting(contentEl)
      .setName("手写完成度（%）")
      .setDesc(
        rolled
          ? "有子节点时不生效——进度是回灌上来的。"
          : "不可量化的目标才用它。留空表示交给状态：已完成 100%，其余 0%。",
      )
      .addText((text) => {
        text.setPlaceholder("留空");
        text.inputEl.type = "number";
        text.inputEl.addClass("life-cockpit-number-input");
        text.setValue(this.draft.manualProgress);
        text.onChange((value) => {
          this.draft.manualProgress = value;
        });
      });

    new Setting(contentEl)
      .setName("权重")
      .setDesc("回灌到父目标时占多重。拆分出来的子目标默认按摊到的量赋权。")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.addClass("life-cockpit-number-input");
        text.setValue(this.draft.weight);
        text.onChange((value) => {
          this.draft.weight = value;
        });
      });

    new Setting(contentEl).setName("截止").setDesc("YYYY-MM-DD，留空表示不设。").addText((text) => {
      text.setPlaceholder("2026-12-31");
      text.setValue(this.draft.due);
      text.onChange((value) => {
        this.draft.due = value.trim();
      });
    });

    // 飞书那一格（AME-258 第 22.2 条第 1 点）。只有开着飞书那一栏时才摆出来——
    // 关着的时候它是一格永远不会生效的输入框，比没有更让人困惑。
    if (this.plugin.settings.feishuEnabled) {
      new Setting(contentEl)
        .setName("飞书关键词")
        .setDesc(
          "飞书金字塔表格上，正文含这几个词里任意一个的条目，就算在这支目标名下。" +
            "顿号 / 逗号 / 空格分隔，可写多个；留空就是不接飞书。",
        )
        .addText((text) => {
          text.setPlaceholder("量化、赛马、因子");
          text.inputEl.addClass("life-cockpit-wide-input");
          text.setValue(this.draft.feishuMatch);
          text.onChange((value) => {
            this.draft.feishuMatch = value;
          });
        });
    }

    new Setting(contentEl).addButton((button) => {
      button.setButtonText(this.node ? "保存" : "新建").setCta();
      button.onClick(() => void this.submit());
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async submit(): Promise<void> {
    if (this.submitting) return;
    const title = this.draft.title.trim();
    if (!title) {
      new Notice("先给这个目标起个名字。");
      return;
    }

    const target = Number(this.draft.metricTarget);
    const current = Number(this.draft.metricCurrent || "0");
    const hasMetric = this.draft.metricTarget.trim() !== "" && Number.isFinite(target) && target > 0;
    if (this.draft.metricTarget.trim() !== "" && !hasMetric) {
      new Notice("度量的「目标」要是大于 0 的数。");
      return;
    }

    const weight = Number(this.draft.weight);
    const manual = this.draft.manualProgress.trim();
    const patch: Partial<GoalInput> & { title: string } = {
      title,
      status: this.draft.status,
      level: this.draft.level,
      kind: this.draft.kind.trim() || null,
      metric: hasMetric
        ? { current: Number.isFinite(current) ? current : 0, target, unit: this.draft.metricUnit.trim() }
        : null,
      manualProgress: manual === "" ? null : Number(manual),
      weight: Number.isFinite(weight) && weight >= 0 ? weight : 1,
      due: this.draft.due || null,
      feishuMatch: this.draft.feishuMatch.trim(),
    };

    this.submitting = true;
    const ok = this.node
      ? await this.plugin.updateGoal(this.node.id, patch)
      : Boolean(await this.plugin.createGoal(this.parentId, patch));
    this.submitting = false;
    if (ok) this.close();
  }
}
