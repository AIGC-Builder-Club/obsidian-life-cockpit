import { App, Component, MarkdownRenderer, TFile } from "obsidian";
import { formatDuration, isBreak } from "../core/timer";
import type { SegmentKind } from "../core/timer";
import type { BreakPageSetting } from "../core/settings";
import { GATE_REASON_LABELS } from "../core/gate";
import type { GateReason } from "../core/gate";
import type { ReadingPick } from "../core/reading";

export interface ZenContext {
  kind: SegmentKind;
  remainingMs: number;
  plannedMs: number;
  task: string;
  theme: string | null;
  pomodoroIndex: number;
  /** 这个番茄在推进哪个目标；没挂就是 null */
  goal: string | null;
  /** 休息段轮到的那一页；工作段为 null */
  breakPage: BreakPageSetting | null;
  /**
   * 计时器停着。**必须传进来**：遮罩把状态栏那个「⏸」盖掉了，
   * 不在这一页上说清楚，一块不动的表就只能被读成「坏了」。
   */
  paused: boolean;
  /** 系统级强制锁屏是关着的——那就别让这块遮罩冒充锁屏 */
  lockOff: boolean;
}

export interface GateContext {
  reason: GateReason;
  /** 今天要过的那一页；没配就是 null */
  page: BreakPageSetting | null;
  /** 还差多少毫秒才能过 */
  remainingMs: number;
  dwellMs: number;
  /**
   * 飞书那一栏（Markdown）。它只有文字和一条外链，没有 vault 内链，
   * 所以照旧交给 MarkdownRenderer。
   */
  reading: string;
  /**
   * 今日推荐读物。**这一栏不再走 Markdown**（AME-258 第 22.4 条）：
   *
   *   「复工前的读物提醒里面，我点击了 比如【阳明心学】…………看到【对应页面】
   *    并未在【Obsidian】中打开。」
   *
   * 原因是这块遮罩挂在 `document.body` 上、在 workspace 之外，Obsidian 那套
   * 「点 `[[内链]]` 就跳过去」的默认行为在这儿根本不触发——渲染出来的是一个
   * **看起来像链接、点了什么都不会发生**的东西。所以推荐这一栏改成插件自己画的行，
   * 点击走 `onOpenReading`，不再指望框架替我们接这一下。
   */
  picks: ReadingPick[];
  allowSkip: boolean;
  /** 停留倒计时正停着（人不在看这一页） */
  stalled: boolean;
  /** 「它现在觉得我在不在」，原样显示 */
  attention: string;
}

export interface LockContext {
  remainingMs: number;
  totalMs: number;
  /** 用的是哪条锁屏命令，写给人看 */
  method: string;
  deferMinutes: number;
}

export interface ZenHandlers {
  /** 只关遮罩，不动计时器 */
  onExit: () => void;
  /**
   * 开工：停着的表在这一页上重新走起来。
   * **没有「暂停」和「跳过本段」的对应项**——AME-239 把那两颗按钮整个拿掉了。
   */
  onStart: () => void;
  /** 过闸开工 */
  onPassGate: () => void;
  /** 不看了，直接开工（设置里可禁掉） */
  onSkipGate: () => void;
  onLockNow: () => void;
  onDeferLock: () => void;
  onExemptLock: () => void;
  /** 打开一条推荐读物（vault 内路径） */
  onOpenReading: (path: string) => void;
  /**
   * 打开遮罩上渲染出来的任意一条链接。**遮罩里的链接框架不会替我们接**
   * （见 GateContext.picks 那一段），所以休息页 / 强提醒页笔记正文里的
   * `[[内链]]` 和外链也一并从这里走。
   */
  onOpenLink: (href: string, sourcePath: string, external: boolean) => void;
}

type OverlayMode = "timer" | "gate" | "lock";

interface ActionSpec {
  key: string;
  text: string;
  cta?: boolean;
  warning?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/**
 * 全屏遮罩。**整个插件只有这一块遮罩**，三种用途共用它：
 *
 * | 模式 | 谁开的 | 能不能一按 Esc 就走 |
 * | --- | --- | --- |
 * | `timer` | R1 禅定模式（默认只在休息段） | 能。休息页是给自己用的，不是关自己禁闭 |
 * | `gate` | R6 复工强提醒页 | 不能。停留时间到了才放行；「跳过」按钮可在设置里禁掉 |
 * | `lock` | R6 强制锁屏倒计时 | 能，而且必须能——锁屏不可逆，反悔的口子一定要留着 |
 *
 * R6 没有另起一套遮罩：同一块屏幕上不该有两套盖法，两套的下场是两边的
 * Esc 语义、层级和退出路径各走各的，早晚打架。
 */
export class ZenOverlay extends Component {
  private app: App;
  private handlers: ZenHandlers;
  private root: HTMLElement | null = null;
  private timeEl: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private subtitleEl: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private barEl: HTMLElement | null = null;
  private actionsEl: HTMLElement | null = null;
  private mode: OverlayMode = "timer";
  /** 已经渲染过的休息页路径，避免每秒重渲染一次笔记 */
  private renderedPath: string | null = null;
  private renderedKind: string | null = null;
  /** 正文那篇笔记的路径。遮罩上的相对内链要靠它解析 */
  private sourcePath = "";
  /** 按钮组的形状签名；只有形状变了才重建，否则每秒重建会吃掉点击 */
  private actionsSignature = "";
  private keyHandler: ((event: KeyboardEvent) => void) | null = null;
  /** 强制干扰的闪烁层，和遮罩各挂各的：见 setFlash */
  private flashEl: HTMLElement | null = null;

  constructor(app: App, handlers: ZenHandlers) {
    super();
    this.app = app;
    this.handlers = handlers;
  }

  get isVisible(): boolean {
    return this.root !== null;
  }

  get currentMode(): OverlayMode | null {
    return this.root ? this.mode : null;
  }

  // -------------------------------------------------------------------------
  // 禅定模式（R1）
  // -------------------------------------------------------------------------

  show(context: ZenContext): void {
    this.enter("timer");
    this.update(context);
  }

  update(context: ZenContext): void {
    if (!this.root || this.mode !== "timer") return;

    const breaking = isBreak(context.kind);
    this.root.toggleClass("is-break", breaking);
    this.root.toggleClass("is-work", !breaking);
    this.root.toggleClass("is-paused", context.paused);

    if (this.timeEl) this.timeEl.setText(formatDuration(context.remainingMs));
    this.setBar(context.plannedMs > 0 ? 1 - context.remainingMs / context.plannedMs : 0);

    if (breaking) {
      const page = context.breakPage;
      if (this.titleEl) this.titleEl.setText(page ? page.label : "休息");
      if (this.subtitleEl) {
        this.subtitleEl.setText(
          context.paused
            ? "停着 · 按「开工」倒计时才会走"
            : page?.notePath
              ? page.notePath
              : "在设置里给这一类休息页指定 vault 内的笔记",
        );
      }
      void this.renderNote(
        page?.notePath ?? "",
        "break",
        "设置 → 人生驾驶舱 → 休息页，填一个 vault 内笔记路径。",
        context.lockOff,
      );
    } else {
      if (this.titleEl) this.titleEl.setText(context.task || "禅定模式");
      if (this.subtitleEl) {
        const head = `第 ${context.pomodoroIndex} 个番茄${context.goal ? ` · 推进「${context.goal}」` : ""}`;
        this.subtitleEl.setText(
          context.paused ? `${head} · 停着，按「开工」倒计时才会走` : head,
        );
      }
      this.renderWorkBody(context.theme);
    }

    // 停着的时候只有一件事可做：开工。跑着的时候一件都没有——
    // 这一页上不再有「暂停」和「跳过本段」（AME-239）。
    const actions: ActionSpec[] = [];
    if (context.paused) {
      actions.push({ key: "run", text: "开工", cta: true, onClick: () => this.handlers.onStart() });
    }
    actions.push({ key: "exit", text: "退出禅定（Esc）", onClick: () => this.handlers.onExit() });
    this.setActions(actions);
  }

  // -------------------------------------------------------------------------
  // 复工强提醒页（R6）
  // -------------------------------------------------------------------------

  showGate(context: GateContext): void {
    this.enter("gate");
    if (!this.root) return;

    this.root.toggleClass("is-break", false);
    this.root.toggleClass("is-work", true);
    this.root.toggleClass("is-gate", true);

    const ready = context.remainingMs <= 0;
    // 倒计时停着 = 人不在看。这一页必须把它说出来，否则一块不走的表只会被读成
    // 「坏了」——而「没人看的时候倒计时不走」正是 AME-238 修掉的那条 bug。
    const stalled = context.stalled && !ready;
    this.root.toggleClass("is-stalled", stalled);

    if (this.titleEl) this.titleEl.setText(context.page?.label || "复工前，先过这一页");
    if (this.subtitleEl) {
      this.subtitleEl.setText(
        stalled
          ? `${GATE_REASON_LABELS[context.reason]} · 倒计时停着：${context.attention}`
          : GATE_REASON_LABELS[context.reason],
      );
    }
    if (this.timeEl) {
      this.timeEl.setText(ready ? "可以开工了" : formatDuration(context.remainingMs));
      this.timeEl.toggleClass("is-ready", ready);
      this.timeEl.toggleClass("is-stalled", stalled);
    }
    this.setBar(context.dwellMs > 0 ? 1 - context.remainingMs / context.dwellMs : 1);

    void this.renderGateBody(context);

    const actions: ActionSpec[] = [
      {
        key: "pass",
        text: ready
          ? "看完了，开工"
          : stalled
            ? `还要看 ${Math.ceil(context.remainingMs / 1000)} 秒（倒计时停着）`
            : `再看 ${Math.ceil(context.remainingMs / 1000)} 秒`,
        cta: true,
        disabled: !ready,
        onClick: () => this.handlers.onPassGate(),
      },
    ];
    if (context.allowSkip) {
      // 「这次先跳过」——**它做的就是这一次**：下一段休息完照样拦（AME-273 第 1 条）。
      // 从前写的是「今天先跳过」，而它从来没有跳过一整天，那句话在骗人。
      actions.push({ key: "skip", text: "这次先跳过", onClick: () => this.handlers.onSkipGate() });
    }
    this.setActions(actions);
  }

  // -------------------------------------------------------------------------
  // 强制锁屏倒计时（R6）
  // -------------------------------------------------------------------------

  showLock(context: LockContext): void {
    this.enter("lock");
    if (!this.root) return;

    this.root.toggleClass("is-work", false);
    this.root.toggleClass("is-break", true);
    this.root.toggleClass("is-lock", true);

    if (this.titleEl) this.titleEl.setText("该真的休息了");
    if (this.subtitleEl) {
      this.subtitleEl.setText(`倒计时结束后锁屏 · ${context.method}`);
    }
    if (this.timeEl) this.timeEl.setText(formatDuration(context.remainingMs));
    this.setBar(context.totalMs > 0 ? 1 - context.remainingMs / context.totalMs : 0);

    if (this.bodyEl && this.renderedKind !== "lock") {
      this.renderedKind = "lock";
      this.renderedPath = null;
      this.bodyEl.empty();
      this.bodyEl.createDiv({
        cls: "life-cockpit-zen-theme",
        text: "锁屏是不可逆的打断。现在按「推迟」或「今天豁免」都还来得及。",
      });
    }

    this.setActions([
      { key: "now", text: "立刻锁", warning: true, onClick: () => this.handlers.onLockNow() },
      {
        key: "defer",
        text: `推迟 ${context.deferMinutes} 分钟`,
        cta: true,
        onClick: () => this.handlers.onDeferLock(),
      },
      { key: "exempt", text: "今天豁免", onClick: () => this.handlers.onExemptLock() },
    ]);
  }

  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // 遮罩闪烁（AME-238）
  // -------------------------------------------------------------------------

  /**
   * 全屏闪烁层。**和上面那块遮罩是两回事**，所以另挂一个节点：
   *
   * - 它 `pointer-events: none`，**不挡任何操作**——干扰的目的是让人回来干活，
   *   不是让他先跟一层遮罩搏斗；
   * - 它和番茄状态无关，工作段中途也能闪（连击就发生在工作段末尾）；
   * - 它是**亮度调不动那台机器上唯一还看得见的干扰**（外接显示器走 DDC/CI，
   *   WMI 够不着）。真能调亮度的机器上两者叠加，只会更难忽略。
   */
  setFlash(active: boolean): void {
    if (active) {
      if (!this.flashEl) {
        this.flashEl = document.body.createDiv({ cls: "life-cockpit-flash" });
      }
      return;
    }
    this.flashEl?.remove();
    this.flashEl = null;
  }

  hide(): void {
    if (this.keyHandler) {
      document.removeEventListener("keydown", this.keyHandler);
      this.keyHandler = null;
    }
    this.root?.remove();
    this.root = null;
    this.timeEl = null;
    this.titleEl = null;
    this.subtitleEl = null;
    this.bodyEl = null;
    this.barEl = null;
    this.actionsEl = null;
    this.renderedPath = null;
    this.renderedKind = null;
    this.actionsSignature = "";
  }

  onunload(): void {
    this.hide();
    // 闪烁层挂在 body 上、活得比遮罩长，插件卸载时必须自己收——
    // 留一层会闪的东西在页面上，人只能重启 Obsidian 才弄得掉。
    this.setFlash(false);
  }

  /** 切模式时把上一模式渲染过的东西作废，避免休息页的内容留在强提醒页上。 */
  private enter(mode: OverlayMode): void {
    if (!this.root) this.build();
    if (this.mode === mode) return;
    this.mode = mode;
    this.renderedPath = null;
    this.renderedKind = null;
    this.actionsSignature = "";
    this.root?.toggleClass("is-gate", mode === "gate");
    this.root?.toggleClass("is-lock", mode === "lock");
    // 暂停是计时器的状态，强提醒页和锁屏倒计时都跟它无关，切过去先摘掉。
    this.root?.toggleClass("is-paused", false);
    this.timeEl?.toggleClass("is-ready", false);
  }

  private build(): void {
    const root = document.body.createDiv({ cls: "life-cockpit-zen" });
    this.root = root;

    const card = root.createDiv({ cls: "life-cockpit-zen-card" });
    this.titleEl = card.createDiv({ cls: "life-cockpit-zen-title" });
    this.subtitleEl = card.createDiv({ cls: "life-cockpit-zen-subtitle" });
    this.timeEl = card.createDiv({ cls: "life-cockpit-zen-time" });

    const track = card.createDiv({ cls: "life-cockpit-zen-track" });
    this.barEl = track.createDiv({ cls: "life-cockpit-zen-bar" });

    this.bodyEl = card.createDiv({ cls: "life-cockpit-zen-body" });
    this.actionsEl = card.createDiv({ cls: "life-cockpit-zen-actions" });

    // 遮罩上的链接自己接（AME-258 第 22.4 条）。这块遮罩挂在 `document.body` 上，
    // 在 workspace 之外，Obsidian 那套「点内链就跳过去」的默认行为够不着它——
    // 于是笔记正文里的每一条 `[[链接]]` 都是**看着像链接、点了没反应**的死链。
    // 一处代理全接掉：内链走 openLinkText，外链交给系统浏览器。
    this.bodyEl.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const anchor = target.closest("a");
      if (!anchor) return;
      const href = anchor.getAttribute("data-href") ?? anchor.getAttribute("href") ?? "";
      if (!href) return;
      event.preventDefault();
      const external =
        anchor.classList.contains("external-link") || /^[a-z][a-z0-9+.-]*:/i.test(href);
      this.handlers.onOpenLink(href, this.sourcePath, external);
    });

    this.keyHandler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 强提醒页按 Esc 不放行：一按就走的「强提醒」等于没提醒。
      if (this.mode === "gate") {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      // 锁屏倒计时里 Esc = 推迟。不可逆的动作，反悔的口子一定要留着。
      if (this.mode === "lock") this.handlers.onDeferLock();
      else this.handlers.onExit();
    };
    document.addEventListener("keydown", this.keyHandler);
  }

  private setBar(done: number): void {
    if (!this.barEl) return;
    const ratio = Number.isFinite(done) ? Math.min(1, Math.max(0, done)) : 0;
    this.barEl.style.width = `${Math.round(ratio * 100)}%`;
  }

  /** 按钮每秒都会被要求重画一遍，所以只在形状变了时才真的重建。 */
  private setActions(specs: ActionSpec[]): void {
    if (!this.actionsEl) return;
    const signature = specs
      .map((spec) => `${spec.key}:${spec.text}:${spec.disabled ? 1 : 0}`)
      .join("|");
    if (signature === this.actionsSignature) return;
    this.actionsSignature = signature;

    this.actionsEl.empty();
    for (const spec of specs) {
      const button = this.actionsEl.createEl("button", { text: spec.text });
      if (spec.cta) button.addClass("mod-cta");
      if (spec.warning) button.addClass("mod-warning");
      button.disabled = Boolean(spec.disabled);
      button.addEventListener("click", () => spec.onClick());
    }
  }

  private renderWorkBody(theme: string | null): void {
    if (!this.bodyEl) return;
    const signature = `work:${theme ?? ""}`;
    if (this.renderedPath === signature && this.renderedKind === "work") return;
    this.renderedPath = signature;
    this.renderedKind = "work";

    this.bodyEl.empty();
    if (theme) {
      this.bodyEl.createDiv({ cls: "life-cockpit-zen-theme", text: theme });
    }
  }

  /**
   * 强提醒页的正文 = 今天那一页笔记 + 今日推荐。
   * 推荐挂在这里而不是另开一个面板：人被拦下来的这几秒，是一天里最可能真的看一眼的时刻。
   */
  private async renderGateBody(context: GateContext): Promise<void> {
    if (!this.bodyEl) return;
    const path = context.page?.notePath.trim() ?? "";
    const picksKey = context.picks.map((pick) => `${pick.kind}:${pick.path}`).join("|");
    const signature = `${path}#${context.reading}#${picksKey}`;
    if (this.renderedPath === signature && this.renderedKind === "gate") return;
    this.renderedPath = signature;
    this.renderedKind = "gate";
    this.sourcePath = path;

    this.bodyEl.empty();
    const noteEl = this.bodyEl.createDiv();
    if (!path) {
      noteEl.createDiv({
        cls: "life-cockpit-zen-hint",
        text: "还没配要看的那一页。设置 → 人生驾驶舱 → 复工强提醒页，填一个 vault 内笔记路径。",
      });
    } else {
      await this.renderInto(noteEl, path);
    }

    // 渲染是异步的，中途可能已经切走了；切走了就别把内容贴上去。
    if (this.renderedPath !== signature || this.renderedKind !== "gate") return;
    this.renderPicks(context.picks);
    if (!context.reading.trim()) return;
    const readingEl = this.bodyEl.createDiv({ cls: "life-cockpit-zen-reading" });
    await MarkdownRenderer.render(this.app, context.reading, readingEl, "", this);
  }

  /**
   * 今日推荐那一栏。**每一条都是一颗真的能按的按钮**，不是渲染出来的内链——
   * 遮罩在 workspace 之外，内链在这儿点了不会有任何反应（AME-258 第 22.4 条）。
   *
   * 按下去笔记会在遮罩**后面**打开：这一页是闸门，不能因为点了篇文章就放行。
   * 所以那条通知很重要——它是「按下去了、确实开了」的唯一回执，
   * 而人在按之前不知道自己看的是一层盖住了工作台的遮罩。
   */
  private renderPicks(picks: ReadingPick[]): void {
    if (!this.bodyEl || !picks.length) return;
    const box = this.bodyEl.createDiv({ cls: "life-cockpit-zen-reading" });
    box.createDiv({ cls: "life-cockpit-zen-reading-title", text: "今日推荐" });
    const list = box.createDiv({ cls: "life-cockpit-zen-picks" });
    for (const pick of picks) {
      const row = list.createDiv({ cls: "life-cockpit-zen-pick" });
      const button = row.createEl("button", { cls: "life-cockpit-zen-pick-open" });
      button.createSpan({ cls: "life-cockpit-reading-kind", text: pick.kind });
      button.createSpan({ cls: "life-cockpit-zen-pick-title", text: pick.title });
      button.addEventListener("click", () => this.handlers.onOpenReading(pick.path));
      row.createDiv({ cls: "life-cockpit-zen-pick-reason", text: pick.reason });
    }
  }

  private async renderNote(
    path: string,
    kind: string,
    emptyHint: string,
    lockOff: boolean,
  ): Promise<void> {
    if (!this.bodyEl) return;
    const signature = `${path}#${lockOff ? "nolock" : "lock"}`;
    if (this.renderedPath === signature && this.renderedKind === kind) return;
    this.renderedPath = signature;
    this.renderedKind = kind;

    this.sourcePath = path;
    this.bodyEl.empty();
    const noteEl = this.bodyEl.createDiv();
    if (!path) {
      noteEl.createDiv({ cls: "life-cockpit-zen-hint", text: emptyHint });
    } else {
      await this.renderInto(noteEl, path);
    }

    if (!lockOff) return;
    // 渲染是异步的，中途可能已经切走了；切走了就别把内容贴上去。
    if (this.renderedPath !== signature || this.renderedKind !== kind) return;
    // 说清楚这块遮罩是什么、不是什么。它只盖得住 Obsidian——而 Obsidian 恰恰是
    // 干活的地方，不是要躲开的地方。拿它冒充锁屏，只会锁住工作台、放过所有玩具。
    this.bodyEl.createDiv({
      cls: "life-cockpit-zen-footnote",
      text: "这是休息页，不是锁屏：它只盖 Obsidian，挡不住浏览器和手机。要真锁，去设置 → 人生驾驶舱 → 强制休息与锁屏。",
    });
  }

  private async renderInto(target: HTMLElement, path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      target.createDiv({ cls: "life-cockpit-zen-hint", text: `找不到笔记：${path}` });
      return;
    }
    const markdown = await this.app.vault.cachedRead(file);
    // 渲染期间可能已经切段了，切了就别把旧内容贴上去。
    if (!this.root) return;
    target.empty();
    await MarkdownRenderer.render(this.app, markdown, target, file.path, this);
  }
}
