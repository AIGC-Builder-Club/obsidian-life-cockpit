import { App, Modal, Notice } from "obsidian";
import type LifeCockpitPlugin from "../main";
import { describeAiLogEntry, summarizeAiLog } from "../core/ai-log";
import type { AiLogEntry } from "../core/ai-log";

/**
 * AI 调用记录（AME-258 第 22.1 条）。
 *
 *   「此外，目前 Flash 的执行——其实我看不到【请求和返回】，这样，如果出现了错误
 *    或者偏离；我是意识不到的？……然后插件设置里，有一个开关，可以简单列表式的
 *    预览一下。」
 *
 * 所以这一窗就是那份「简单列表」：**一行一条，点开才看正文**。
 *
 * 两个刻意的取舍：
 *
 *   1. **失败的那几条默认就在最上面**——列表按时间倒序，而人来这儿多半是因为
 *      某一次复盘的结果不对劲。最近一次调用就是他要找的那一条。
 *   2. **请求和返回都摆全文**（超长的在写盘时就裁过了）。只摆摘要的话，
 *      「模型是不是被喂错了东西」这一问答不了——而那正是打开这一窗的理由。
 */
export class AiLogModal extends Modal {
  private plugin: LifeCockpitPlugin;
  private entries: AiLogEntry[] = [];
  private expanded = new Set<string>();

  constructor(app: App, plugin: LifeCockpitPlugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen(): Promise<void> {
    this.entries = await this.plugin.aiLogRecent();
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("life-cockpit-modal");
    contentEl.createEl("h3", { text: "AI 调用记录" });

    contentEl.createDiv({ cls: "life-cockpit-hint", text: summarizeAiLog(this.entries) });
    contentEl.createDiv({
      cls: "life-cockpit-hint",
      text:
        `只留最近 ${this.plugin.settings.aiLogKeepDays} 天，落在插件自己的目录里` +
        "（和 data.json 同级，不在 2A-META 仓库内，不会随仓库公开）。密钥不进日志。",
    });

    if (!this.entries.length) return;

    const list = contentEl.createDiv({ cls: "life-cockpit-ai-log" });
    for (const entry of this.entries) {
      const row = list.createDiv({ cls: "life-cockpit-ai-log-row" });
      row.toggleClass("is-failed", !entry.ok);

      const head = row.createEl("button", { cls: "life-cockpit-ai-log-head" });
      head.createSpan({ cls: "life-cockpit-ai-log-title", text: describeAiLogEntry(entry) });
      head.createSpan({ cls: "life-cockpit-ai-log-detail", text: entry.detail });
      head.addEventListener("click", () => {
        if (this.expanded.has(entry.id)) this.expanded.delete(entry.id);
        else this.expanded.add(entry.id);
        this.render();
      });

      if (!this.expanded.has(entry.id)) continue;
      const body = row.createDiv({ cls: "life-cockpit-ai-log-body" });
      this.field(body, "时间", entry.at);
      this.field(body, "档位", `${entry.profile}${entry.model ? ` · ${entry.model}` : ""}`);
      if (entry.url) this.field(body, "地址", entry.url);
      this.field(
        body,
        "结果",
        `${entry.status === null ? "没拿到状态码" : `HTTP ${entry.status}`} · ${entry.detail}`,
      );
      if (entry.totalTokens > 0) {
        this.field(
          body,
          "用量",
          `提示 ${entry.promptTokens} · 生成 ${entry.completionTokens} · 合计 ${entry.totalTokens}`,
        );
      }
      this.block(body, "请求", entry.request);
      this.block(body, "返回", entry.response || "（空）");
    }
  }

  private field(parent: HTMLElement, label: string, value: string): void {
    const row = parent.createDiv({ cls: "life-cockpit-ai-log-field" });
    row.createSpan({ cls: "life-cockpit-ai-log-label", text: label });
    row.createSpan({ text: value });
  }

  /** 正文用 `<pre>`：prompt 里的换行和缩进就是内容的一部分，压成一段就读不出问题在哪。 */
  private block(parent: HTMLElement, label: string, value: string): void {
    const box = parent.createDiv({ cls: "life-cockpit-ai-log-block" });
    const head = box.createDiv({ cls: "life-cockpit-ai-log-label" });
    head.setText(label);
    const copy = head.createEl("button", { cls: "life-cockpit-ai-log-copy", text: "复制" });
    copy.addEventListener("click", (event) => {
      event.stopPropagation();
      void navigator.clipboard
        .writeText(value)
        .then(() => new Notice(`${label}已复制。`))
        .catch(() => new Notice("复制失败，手动选中吧。"));
    });
    box.createEl("pre", { text: value });
  }
}
