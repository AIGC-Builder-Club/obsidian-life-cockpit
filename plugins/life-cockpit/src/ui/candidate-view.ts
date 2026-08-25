import { ItemView, WorkspaceLeaf } from "obsidian";
import type LifeCockpitPlugin from "../main";
import {
  CANDIDATE_PENDING,
  CANDIDATE_REJECTED,
  isPendingCandidate,
  latestDecision,
  typeLabel,
} from "../core/candidates";
import type { CandidateFile } from "../core/candidate-store";
import { CandidateDecideModal } from "./candidate-decide-modal";

export const VIEW_TYPE_CANDIDATES = "life-cockpit-candidates";

/**
 * 夜班候选区的拍板面——人机交班的那道收口。
 *
 * 夜里 Agent 往候选区落东西，白天人在这里逐条采纳 / 打回 / 改写。**有这道收口面，
 * 夜里才敢放绿灯**：产物进不了主干，最差也就是这张表上多几行待拍板。
 *
 * 「只看待拍板」是默认的：这张表是待办清单，不是档案馆。要回看拍过的按一下切到全部。
 */
export class CandidateView extends ItemView {
  private plugin: LifeCockpitPlugin;
  private pendingOnly = true;
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
    return VIEW_TYPE_CANDIDATES;
  }

  getDisplayText(): string {
    return "夜班候选区";
  }

  getIcon(): string {
    return "inbox";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("life-cockpit-candidates-view");

    this.headEl = root.createDiv({ cls: "life-cockpit-goals-head" });
    this.hintEl = root.createDiv({ cls: "life-cockpit-goals-hint" });
    this.bodyEl = root.createDiv({ cls: "life-cockpit-candidate-list" });

    this.refresh();
  }

  refresh(): void {
    if (!this.bodyEl) return;
    const next = this.currentSignature();
    if (next === this.signature) return;
    this.signature = next;

    this.renderHead();
    this.renderHint();
    this.renderList();
  }

  private currentSignature(): string {
    const files = this.plugin.candidates.files.map((file) =>
      [file.path, file.candidate.status, file.candidate.decisions.length].join(":"),
    );
    return [this.pendingOnly, this.plugin.candidates.hasFolder, files.join("|")].join("#");
  }

  private renderHead(): void {
    this.headEl.empty();
    const store = this.plugin.candidates;
    const pending = store.pending.length;
    const rejected = store.files.filter((file) => file.candidate.status === CANDIDATE_REJECTED).length;

    const summary = this.headEl.createDiv({ cls: "life-cockpit-goals-summary" });
    summary.createSpan({ cls: "life-cockpit-points-value", text: String(pending) });
    summary.createSpan({
      cls: "life-cockpit-points-today",
      text: `条待拍板 · ${store.files.length} 条在候选区 · ${rejected} 条已打回`,
    });

    const actions = this.headEl.createDiv({ cls: "life-cockpit-goals-actions" });
    // 按钮写的是「按下去会怎样」，不是「现在是什么」。
    const toggle = actions.createEl("button", {
      text: this.pendingOnly ? "看全部" : "只看待拍板",
    });
    toggle.addEventListener("click", () => {
      this.pendingOnly = !this.pendingOnly;
      this.signature = "";
      this.refresh();
    });

    // 复盘草稿也落在这张表上，所以发起的入口放在这儿，不再单开一个面板。
    if (this.plugin.settings.reviewEnabled) {
      const review = actions.createEl("button", { text: "睡前复盘" });
      review.addEventListener("click", () => void this.plugin.runReview());
    }

    const reload = actions.createEl("button", { cls: "mod-cta", text: "重读" });
    reload.addEventListener("click", () => void this.plugin.reloadCandidates());
  }

  private renderHint(): void {
    this.hintEl.empty();
    const store = this.plugin.candidates;

    if (!this.plugin.settings.candidatesEnabled) {
      this.hintEl.createDiv({
        cls: "life-cockpit-hint",
        text: "候选区已在设置里关掉了（设置 → 夜班候选区）。",
      });
      return;
    }
    if (!store.hasFolder) {
      this.hintEl.createDiv({
        cls: "life-cockpit-hint",
        text:
          `候选区还是空的（${this.plugin.settings.candidatesFolder}）。夜班 Agent 往 ` +
          "`<候选区>/<日期>/` 里落 .md，这里就会列出来。",
      });
    }

    // 打回理由是写给下一轮夜班的，人这边也要看得见，否则不知道自己上次说了什么。
    const rejections = store.recentRejections(3);
    if (rejections.length) {
      const box = this.hintEl.createDiv({ cls: "life-cockpit-hint" });
      box.createDiv({ text: "最近打回的话（下一轮夜班会读到）：" });
      for (const { file, decision } of rejections) {
        box.createDiv({
          cls: "life-cockpit-candidate-reason",
          text: `· ${decision.reason ?? ""}　—— ${file.name}`,
        });
      }
    }
  }

  private renderList(): void {
    this.bodyEl.empty();
    const store = this.plugin.candidates;
    const files = this.pendingOnly ? store.pending : store.files;

    if (!files.length) {
      this.bodyEl.createDiv({
        cls: "life-cockpit-hint",
        text: this.pendingOnly
          ? "没有待拍板的了。夜班的东西都收完了。"
          : "候选区里一条都没有。",
      });
      return;
    }
    for (const file of files) this.renderRow(file);
  }

  private renderRow(file: CandidateFile): void {
    const candidate = file.candidate;
    const pending = isPendingCandidate(candidate);

    const row = this.bodyEl.createDiv({ cls: "life-cockpit-candidate-row" });
    row.toggleClass("is-decided", !pending);

    const head = row.createDiv({ cls: "life-cockpit-candidate-head" });
    head.createSpan({ cls: "life-cockpit-goal-level", text: typeLabel(candidate.type) });
    head.createSpan({
      cls: "life-cockpit-candidate-title",
      text: candidate.summary.trim() || file.name,
    });
    if (candidate.status !== CANDIDATE_PENDING) {
      head.createSpan({ cls: "life-cockpit-candidate-status", text: candidate.status });
    }

    const meta = row.createDiv({ cls: "life-cockpit-candidate-meta" });
    meta.createSpan({ text: `${file.day} · ${file.name}` });
    meta.createSpan({ text: candidate.target ? `落点 ${candidate.target}` : "没有落点，只归档" });
    if (candidate.coverage !== null) meta.createSpan({ text: `覆盖 ${candidate.coverage} 条` });

    const last = latestDecision(candidate);
    if (last) {
      meta.createSpan({
        cls: "life-cockpit-candidate-reason",
        text: `${last.action} · ${last.actor} · ${last.reason ?? last.landing ?? ""}`,
      });
    }

    this.renderActions(row, file, pending);
  }

  private renderActions(row: HTMLElement, file: CandidateFile, pending: boolean): void {
    const actions = row.createDiv({ cls: "life-cockpit-candidate-actions" });

    const open = actions.createEl("button", { text: "看原文" });
    open.addEventListener("click", () => void this.plugin.openCandidateFile(file.path));

    if (!pending) return;

    const adopt = actions.createEl("button", { cls: "mod-cta", text: "采纳" });
    adopt.addEventListener("click", () =>
      new CandidateDecideModal(this.app, this.plugin, file, "adopt").open(),
    );

    const reject = actions.createEl("button", { text: "打回" });
    reject.addEventListener("click", () =>
      new CandidateDecideModal(this.app, this.plugin, file, "reject").open(),
    );

    const rewrite = actions.createEl("button", { text: "改写" });
    rewrite.addEventListener("click", () =>
      new CandidateDecideModal(this.app, this.plugin, file, "rewrite").open(),
    );
  }
}
