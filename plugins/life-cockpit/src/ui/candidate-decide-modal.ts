import { App, Modal, Notice, Setting } from "obsidian";
import type LifeCockpitPlugin from "../main";
import { candidateTitle, splitOriginalSection, typeLabel } from "../core/candidates";
import type { CandidateFile } from "../core/candidate-store";

export type DecideMode = "adopt" | "reject" | "rewrite";

const TITLES: Record<DecideMode, string> = {
  adopt: "采纳这一条",
  reject: "打回这一条",
  rewrite: "改写这一条",
};

/**
 * 三个拍板动作共用一个窗：动作不同的只有中间那一栏，外面的抬头、正文预览、
 * 提交按钮都一样。分成三个窗写只会让三份说明各自漂移。
 *
 * 采纳的落点是**可改的**——夜班填错落点是常事，改一下就能落，比打回一轮快。
 */
export class CandidateDecideModal extends Modal {
  private plugin: LifeCockpitPlugin;
  private file: CandidateFile;
  private mode: DecideMode;
  private target: string;
  private reason = "";
  private body: string;
  private submitting = false;

  constructor(app: App, plugin: LifeCockpitPlugin, file: CandidateFile, mode: DecideMode) {
    super(app);
    this.plugin = plugin;
    this.file = file;
    this.mode = mode;
    this.target = file.candidate.target;
    // 改写窗里给的是当前正文，文末《原始产物》那一节不塞进来——它是历史，不是待改的东西。
    this.body = splitOriginalSection(file.candidate.body).main.trim();
  }

  onOpen(): void {
    const { contentEl } = this;
    const candidate = this.file.candidate;
    contentEl.empty();
    contentEl.addClass("life-cockpit-modal");
    contentEl.createEl("h3", { text: TITLES[this.mode] });

    contentEl.createDiv({ cls: "life-cockpit-hint", text: candidateTitle(candidate) });
    contentEl.createDiv({
      cls: "life-cockpit-hint",
      text: `${this.file.day} · ${typeLabel(candidate.type)} · 来源 ${candidate.source || "没写"}`,
    });

    if (this.mode === "adopt") this.renderAdopt(contentEl);
    if (this.mode === "reject") this.renderReject(contentEl);
    if (this.mode === "rewrite") this.renderRewrite(contentEl);

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText("取消");
        button.onClick(() => this.close());
      })
      .addButton((button) => {
        button.setButtonText(TITLES[this.mode].slice(0, 2)).setCta();
        button.onClick(() => void this.submit());
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderAdopt(contentEl: HTMLElement): void {
    const candidate = this.file.candidate;

    new Setting(contentEl)
      .setName("落点")
      .setDesc(this.targetDesc)
      .addText((text) => {
        text.setPlaceholder("留空 = 只归档，不写主干");
        text.setValue(this.target);
        text.inputEl.addClass("life-cockpit-wide-input");
        text.onChange((value) => {
          this.target = value.trim();
        });
      });

    contentEl.createDiv({
      cls: "life-cockpit-hint",
      text: "采纳之后原件带着这次裁决移进候选区的 `_归档/`，不删；主干那边会留一行指回来。",
    });
    this.renderPreview(contentEl, splitOriginalSection(candidate.body).main);
  }

  private get targetDesc(): string {
    if (this.file.candidate.type === "goal-node") {
      return "挂在哪个目标树节点下：`g-7` / `goal:g-7` / `[[目标树#^g-7]]`。留空就挂顶层。";
    }
    if (this.file.candidate.type === "ledger-entry") {
      return "这一笔记在哪个目标树节点上：`goal:g-7`。留空就按 `任务` 记。";
    }
    return "vault 内的笔记路径。已经有内容的笔记是追加，不覆盖。";
  }

  private renderReject(contentEl: HTMLElement): void {
    new Setting(contentEl)
      .setName("理由")
      .setDesc("这句话是写给下一轮夜班看的——它跑之前会先扫最近的打回理由。")
      .addTextArea((area) => {
        area.setPlaceholder("哪里不对，下次怎么改");
        area.inputEl.addClass("life-cockpit-textarea");
        area.onChange((value) => {
          this.reason = value;
        });
        window.setTimeout(() => area.inputEl.focus(), 0);
      });

    contentEl.createDiv({
      cls: "life-cockpit-hint",
      text: "打回不动正文，文件也留在原地——下一轮夜班读的就是它。",
    });
  }

  private renderRewrite(contentEl: HTMLElement): void {
    new Setting(contentEl)
      .setName("正文")
      .setDesc("改完写回本文件；原正文追加到文末《原始产物》，不覆盖、不删除。")
      .addTextArea((area) => {
        area.setValue(this.body);
        area.inputEl.addClass("life-cockpit-textarea life-cockpit-textarea-tall");
        area.onChange((value) => {
          this.body = value;
        });
        window.setTimeout(() => area.inputEl.focus(), 0);
      });

    contentEl.createDiv({
      cls: "life-cockpit-hint",
      text: "改写不是终局：改完这条还留在待拍板里，等你再采纳或打回。",
    });
  }

  private renderPreview(contentEl: HTMLElement, body: string): void {
    const text = body.trim();
    if (!text) return;
    contentEl.createEl("pre", {
      cls: "life-cockpit-candidate-preview",
      text: text.length > 1200 ? `${text.slice(0, 1200)}\n……` : text,
    });
  }

  private async submit(): Promise<void> {
    if (this.submitting) return;
    if (this.mode === "reject" && !this.reason.trim()) {
      new Notice("打回要带一句理由，下一轮夜班读的就是这句。");
      return;
    }
    if (this.mode === "rewrite" && !this.body.trim()) {
      new Notice("改写后的正文是空的——想清空不如直接打回。");
      return;
    }

    this.submitting = true;
    const ok = await this.plugin.decideCandidate(this.file.path, this.mode, {
      target: this.target,
      reason: this.reason,
      body: this.body,
    });
    this.submitting = false;
    if (ok) this.close();
  }
}
