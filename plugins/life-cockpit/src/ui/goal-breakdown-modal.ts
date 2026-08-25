import { App, Modal, Notice, Setting } from "obsidian";
import type LifeCockpitPlugin from "../main";
import {
  BREAKDOWN_SCHEME_LABELS,
  childLevelOf,
  defaultBreakdown,
  GOAL_LEVEL_LABELS,
  GOAL_LEVELS,
  suggestBreakdown,
} from "../core/goals";
import type { BreakdownScheme, GoalDraft, GoalLevel, GoalNode } from "../core/goals";

interface Row {
  draft: GoalDraft;
  include: boolean;
}

/**
 * 向下拆分：OKR → KPI → 日内任务。
 *
 * **半自动**——这里只出建议，改完、勾完、按了「落到树上」才写盘。
 * 父目标有度量的话，量会摊到每一段，并且摊到的量直接当权重：
 * 这样一段做完，父目标涨的正好是这一段占的比例，拆分和回灌对得上账。
 */
export class GoalBreakdownModal extends Modal {
  private plugin: LifeCockpitPlugin;
  private node: GoalNode;
  private scheme: BreakdownScheme;
  private count: number;
  private from: string;
  private level: GoalLevel;
  private rows: Row[] = [];
  private previewEl!: HTMLElement;
  private submitting = false;

  constructor(app: App, plugin: LifeCockpitPlugin, node: GoalNode) {
    super(app);
    this.plugin = plugin;
    this.node = node;
    const defaults = defaultBreakdown(node, new Date());
    this.scheme = defaults.scheme;
    this.count = defaults.count;
    this.from = toDay(new Date());
    this.level = childLevelOf(node.level);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("life-cockpit-modal");
    contentEl.addClass("life-cockpit-breakdown-modal");
    contentEl.createEl("h3", { text: "拆分建议" });

    contentEl.createDiv({
      cls: "life-cockpit-hint",
      text:
        `拆：${this.plugin.goals.pathLabel(this.node.id)}` +
        (this.node.metric
          ? ` · 度量 ${this.node.metric.current}/${this.node.metric.target} ${this.node.metric.unit}`.trimEnd()
          : " · 没有度量，只均分段数"),
    });

    new Setting(contentEl).setName("切法").addDropdown((dropdown) => {
      for (const key of Object.keys(BREAKDOWN_SCHEME_LABELS) as BreakdownScheme[]) {
        dropdown.addOption(key, BREAKDOWN_SCHEME_LABELS[key]);
      }
      dropdown.setValue(this.scheme);
      dropdown.onChange((value) => {
        this.scheme = value as BreakdownScheme;
        this.rebuild();
      });
    });

    new Setting(contentEl).setName("拆成几段").addText((text) => {
      text.inputEl.type = "number";
      text.inputEl.addClass("life-cockpit-number-input");
      text.setValue(String(this.count));
      text.onChange((value) => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 1) return;
        this.count = Math.min(52, Math.round(parsed));
        this.rebuild();
      });
    });

    new Setting(contentEl)
      .setName("从哪天起算")
      .setDesc("YYYY-MM-DD。季 / 月 / 周会对齐到这一天所在周期的第一天。")
      .addText((text) => {
        text.setValue(this.from);
        text.onChange((value) => {
          this.from = value.trim();
          this.rebuild();
        });
      });

    new Setting(contentEl)
      .setName("拆到哪一层")
      .setDesc("默认比父目标低一级。")
      .addDropdown((dropdown) => {
        for (const level of GOAL_LEVELS) dropdown.addOption(level, GOAL_LEVEL_LABELS[level]);
        dropdown.setValue(this.level);
        dropdown.onChange((value) => {
          this.level = value as GoalLevel;
          this.rebuild();
        });
      });

    contentEl.createDiv({ cls: "life-cockpit-section-title", text: "建议（改完再落）" });
    this.previewEl = contentEl.createDiv({ cls: "life-cockpit-breakdown-list" });

    new Setting(contentEl).addButton((button) => {
      button.setButtonText("落到树上").setCta();
      button.onClick(() => void this.submit());
    });

    this.rebuild();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private rebuild(): void {
    const from = parseDay(this.from) ?? new Date();
    this.rows = suggestBreakdown(this.node, {
      scheme: this.scheme,
      count: this.count,
      from,
      level: this.level,
    }).map((draft) => ({ draft, include: true }));
    this.renderPreview();
  }

  private renderPreview(): void {
    this.previewEl.empty();
    for (const row of this.rows) {
      const item = this.previewEl.createDiv({ cls: "life-cockpit-breakdown-row" });

      const toggle = item.createEl("input", { type: "checkbox" });
      toggle.checked = row.include;
      toggle.addEventListener("change", () => {
        row.include = toggle.checked;
        item.toggleClass("is-excluded", !row.include);
      });

      const title = item.createEl("input", { type: "text", cls: "life-cockpit-breakdown-title" });
      title.value = row.draft.title;
      title.addEventListener("change", () => {
        row.draft.title = title.value;
      });

      if (row.draft.metric) {
        const target = item.createEl("input", {
          type: "number",
          cls: "life-cockpit-number-input",
        });
        target.value = String(row.draft.metric.target);
        target.addEventListener("change", () => {
          const parsed = Number(target.value);
          if (!Number.isFinite(parsed) || parsed < 0 || !row.draft.metric) {
            target.value = String(row.draft.metric?.target ?? 0);
            return;
          }
          row.draft.metric.target = parsed;
          // 权重跟着量走，否则改完量之后回灌的比例就和拆分对不上了。
          row.draft.weight = parsed;
        });
        item.createSpan({
          cls: "life-cockpit-breakdown-unit",
          text: row.draft.metric.unit || "",
        });
      }

      item.createSpan({
        cls: "life-cockpit-breakdown-due",
        text: row.draft.due ? `截止 ${row.draft.due}` : "",
      });
    }

    if (!this.rows.length) {
      this.previewEl.createDiv({ cls: "life-cockpit-hint", text: "没有可落的段。" });
    }
  }

  private async submit(): Promise<void> {
    if (this.submitting) return;
    const drafts = this.rows
      .filter((row) => row.include && row.draft.title.trim())
      .map((row) => row.draft);
    if (!drafts.length) {
      new Notice("一段都没勾，没什么可落的。");
      return;
    }

    this.submitting = true;
    const created = await this.plugin.applyBreakdown(this.node.id, drafts);
    this.submitting = false;
    if (created) this.close();
  }
}

function toDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseDay(text: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [year, month, day] = text.split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}
