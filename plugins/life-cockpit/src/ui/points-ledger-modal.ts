import { App, Modal, Setting } from "obsidian";
import type { TextComponent } from "obsidian";
import type LifeCockpitPlugin from "../main";
import {
  findTask,
  formatPoints,
  goalIdOf,
  presetRange,
  RANGE_PRESET_LABELS,
  sourceLabel,
  summarize,
  voidedIds,
} from "../core/points";
import type { PointsEntry, RangePreset } from "../core/points";

/**
 * 账本视图：任意区间的流水与余额变化。
 * 这就是「账本不是计数器」那句话的界面——每一笔看得见来源、看得见事由、能当场撤销。
 */
export class PointsLedgerModal extends Modal {
  private plugin: LifeCockpitPlugin;
  private preset: RangePreset = "week";
  private from = "";
  private to = "";
  private body!: HTMLElement;
  private fromInput?: TextComponent;
  private toInput?: TextComponent;

  constructor(app: App, plugin: LifeCockpitPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("life-cockpit-modal");
    contentEl.addClass("life-cockpit-ledger-modal");
    contentEl.createEl("h3", { text: "积分账本" });

    this.applyPreset(this.preset);

    new Setting(contentEl)
      .setName("区间")
      .setDesc("按账本日算：凌晨记的一笔归前一天。")
      .addDropdown((dropdown) => {
        for (const key of Object.keys(RANGE_PRESET_LABELS) as RangePreset[]) {
          dropdown.addOption(key, RANGE_PRESET_LABELS[key]);
        }
        dropdown.addOption("custom", "自定义");
        dropdown.setValue(this.preset);
        dropdown.onChange((value) => {
          if (value !== "custom") this.applyPreset(value as RangePreset);
          this.render();
        });
      });

    const custom = new Setting(contentEl).setName("自定义区间").setDesc("YYYY-MM-DD，留空表示不设边界。");
    custom.addText((text) => {
      this.fromInput = text;
      text.setPlaceholder("从");
      text.setValue(this.from);
      text.onChange((value) => {
        this.from = value.trim();
        this.render();
      });
    });
    custom.addText((text) => {
      this.toInput = text;
      text.setPlaceholder("到");
      text.setValue(this.to);
      text.onChange((value) => {
        this.to = value.trim();
        this.render();
      });
    });

    this.body = contentEl.createDiv({ cls: "life-cockpit-ledger-body" });
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private applyPreset(preset: RangePreset): void {
    this.preset = preset;
    const range = presetRange(preset, new Date(), this.plugin.settings.dayRolloverHour);
    this.from = range.from ?? "";
    this.to = range.to ?? "";
    // 两个输入框要跟着走，否则下面显示的是本周、框里还写着上次那两个日期。
    this.fromInput?.setValue(this.from);
    this.toInput?.setValue(this.to);
  }

  private render(): void {
    if (!this.body) return;
    this.body.empty();

    const book = this.plugin.points.book;
    const summary = summarize(book, this.from || undefined, this.to || undefined);
    const voided = voidedIds(book);

    const head = this.body.createDiv({ cls: "life-cockpit-ledger-summary" });
    stat(head, "期初", formatPoints(summary.opening));
    stat(head, "入账", `+${formatPoints(summary.earned)}`);
    stat(head, "出账", `-${formatPoints(summary.spent)}`);
    stat(head, "净额", formatPoints(summary.net));
    stat(head, "期末", formatPoints(summary.closing));

    this.body.createDiv({
      cls: "life-cockpit-hint",
      text:
        `${summary.count} 笔流水` +
        (summary.voidedCount ? `，其中 ${summary.voidedCount} 笔是撤销相关（不计入入账 / 出账）` : ""),
    });

    if (summary.byTask.length) {
      this.body.createDiv({ cls: "life-cockpit-section-title", text: "分去处" });
      const list = this.body.createDiv({ cls: "life-cockpit-ledger-tasks" });
      for (const row of summary.byTask) {
        const net = row.earned - row.spent;
        const item = list.createDiv({ cls: "life-cockpit-ledger-task" });
        item.createSpan({ text: this.labelForKey(row.key) });
        item.createSpan({
          cls: net >= 0 ? "is-earn" : "is-spend",
          text: `${net >= 0 ? "+" : ""}${formatPoints(net)} · ${row.count} 笔`,
        });
      }
    }

    this.body.createDiv({ cls: "life-cockpit-section-title", text: "流水" });
    if (!summary.entries.length) {
      this.body.createDiv({ cls: "life-cockpit-hint", text: "这段时间还没有流水。" });
      return;
    }

    const table = this.body.createEl("table", { cls: "life-cockpit-ledger-table" });
    const header = table.createEl("thead").createEl("tr");
    for (const label of ["时间", "分值", "事由", "来源", "状态", ""]) {
      header.createEl("th", { text: label });
    }

    const rows = table.createEl("tbody");
    // 最近的排最上面：翻账本的人多半在找刚刚那一笔。
    for (const entry of [...summary.entries].reverse()) {
      this.renderRow(rows, entry, voided.has(entry.id));
    }
  }

  /** 「分去处」那一栏的名字：预设任务查任务表，`goal:` 开头的查目标树。 */
  private labelForKey(key: string): string {
    const goalId = goalIdOf(key);
    if (goalId) {
      const node = this.plugin.goals.find(goalId);
      // 目标被删了也如实说，别把这几笔悄悄并进「临时任务」。
      return node ? `目标 · ${this.plugin.goals.pathLabel(goalId)}` : `目标 · ${goalId}（已不在树上）`;
    }
    const task = findTask(this.plugin.points.tasks, key);
    return task ? task.label : key;
  }

  private renderRow(parent: HTMLElement, entry: PointsEntry, isVoided: boolean): void {
    const row = parent.createEl("tr");
    if (isVoided) row.addClass("is-voided");

    row.createEl("td", { text: entry.at.replace("T", " ") });
    row.createEl("td", {
      cls: entry.direction === "earn" ? "is-earn" : "is-spend",
      text: `${entry.direction === "earn" ? "+" : "-"}${formatPoints(entry.amount)}`,
    });
    row.createEl("td", { text: entry.reason });
    row.createEl("td", { text: sourceLabel(entry.source) });
    row.createEl("td", { text: entry.source === "reversal" ? "撤销单" : isVoided ? "已撤销" : "有效" });

    const actions = row.createEl("td");
    if (entry.source === "reversal" || isVoided) return;
    const button = actions.createEl("button", { text: "撤销" });
    button.addEventListener("click", () => {
      button.disabled = true;
      void this.plugin.reversePoints(entry.id).then(() => this.render());
    });
  }
}

function stat(parent: HTMLElement, label: string, value: string): void {
  const cell = parent.createDiv({ cls: "life-cockpit-stat" });
  cell.createDiv({ cls: "life-cockpit-stat-label", text: label });
  cell.createDiv({ cls: "life-cockpit-stat-value", text: value });
}
