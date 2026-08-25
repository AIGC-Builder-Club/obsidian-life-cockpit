import { ItemView, WorkspaceLeaf } from "obsidian";
import type LifeCockpitPlugin from "../main";
import { MODE_IDS, MODE_LABELS } from "../core/settings";
import type { ModeId } from "../core/settings";
import { formatDuration, remainingMs, SEGMENT_LABELS } from "../core/timer";
import {
  formatClock,
  minuteOfDay,
  phaseForDate,
  resolveSegments,
  segmentAt,
  WUXING_PHASES,
} from "../core/rhythm";
import { dayKeyFor, focusProgress } from "../core/ledger";
import { currentBalance, formatPoints, presetRange, summarize } from "../core/points";
import { formatGoalProgress, GOAL_LEVEL_SHORT } from "../core/goals";
import { CHANNEL_STATE_LABELS, NUDGE_LEVEL_LABELS, remainingQuota } from "../core/nudge";

export const VIEW_TYPE_COCKPIT = "life-cockpit-view";

const NO_TASK = "__none__";
const NO_GOAL = "__nogoal__";

/**
 * 驾驶舱面板：番茄计时 + 当日 560 分钟进度 + 积分余额 + 五行节律表（当前格高亮）+ 今日流水。
 * 骨架只建一次，每秒只改会动的那几处文字和宽度。
 */
export class CockpitView extends ItemView {
  private plugin: LifeCockpitPlugin;

  private cellEl!: HTMLElement;
  private modeButtons = new Map<ModeId, HTMLButtonElement>();
  private timeEl!: HTMLElement;
  private segmentEl!: HTMLElement;
  private taskSelect!: HTMLSelectElement;
  private taskInput!: HTMLInputElement;
  private primaryButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private focusBarEl!: HTMLElement;
  private focusTextEl!: HTMLElement;
  private pomodoroTextEl!: HTMLElement;
  private pointsEl!: HTMLElement;
  private pointsBodyEl!: HTMLElement;
  private nudgeEl!: HTMLElement;
  private nudgeBodyEl!: HTMLElement;
  private muteButton!: HTMLButtonElement;
  private enforceEl!: HTMLElement;
  private enforceTextEl!: HTMLElement;
  private feishuEl!: HTMLElement;
  private feishuTextEl!: HTMLElement;
  private feishuSummaryButton!: HTMLButtonElement;
  private feishuSummaryRefreshButton!: HTMLButtonElement;
  private goalEl!: HTMLElement;
  private goalSelect!: HTMLSelectElement;
  private goalBodyEl!: HTMLElement;
  private tableEl!: HTMLElement;
  private sessionsEl!: HTMLElement;

  /** 只有内容真的变了才重画表格 / 流水列表 */
  private tableSignature = "";
  private sessionsSignature = "";
  private pointsSignature = "";
  private nudgeSignature = "";
  private taskOptionsSignature = "";
  private goalOptionsSignature = "";
  private goalSignature = "";

  constructor(leaf: WorkspaceLeaf, plugin: LifeCockpitPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_COCKPIT;
  }

  getDisplayText(): string {
    return "人生驾驶舱";
  }

  getIcon(): string {
    return "timer";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("life-cockpit-view");

    this.cellEl = root.createDiv({ cls: "life-cockpit-cell" });

    const modes = root.createDiv({ cls: "life-cockpit-modes" });
    for (const id of MODE_IDS) {
      const button = modes.createEl("button", { text: MODE_LABELS[id] });
      button.addEventListener("click", () => void this.plugin.switchMode(id));
      this.modeButtons.set(id, button);
    }

    const timer = root.createDiv({ cls: "life-cockpit-timer" });
    this.timeEl = timer.createDiv({ cls: "life-cockpit-time" });
    this.segmentEl = timer.createDiv({ cls: "life-cockpit-segment" });

    const task = root.createDiv({ cls: "life-cockpit-task-row" });
    this.taskSelect = task.createEl("select", { cls: "life-cockpit-task-select dropdown" });
    this.taskSelect.addEventListener("change", () => {
      const value = this.taskSelect.value;
      this.plugin.setPomodoroTask(value === NO_TASK ? null : value);
      // 挑了预设任务就顺手把任务名填进流水，省得再手打一遍。
      const picked = this.plugin.points.earnTasks().find((item) => item.id === value);
      if (picked && !this.taskInput.value.trim()) {
        this.taskInput.value = picked.label;
        this.plugin.setTask(picked.label);
      }
    });

    this.taskInput = task.createEl("input", {
      cls: "life-cockpit-task",
      attr: { type: "text", placeholder: "这个番茄在做什么" },
    });
    this.taskInput.addEventListener("change", () => {
      this.plugin.setTask(this.taskInput.value);
    });

    this.goalEl = root.createDiv({ cls: "life-cockpit-goal-row-inline" });
    this.goalSelect = this.goalEl.createEl("select", { cls: "life-cockpit-goal-select dropdown" });
    this.goalSelect.addEventListener("change", () => {
      const value = this.goalSelect.value;
      this.plugin.setPomodoroGoal(value === NO_GOAL ? null : value);
    });
    const goalOpen = this.goalEl.createEl("button", { text: "目标树" });
    goalOpen.addEventListener("click", () => void this.plugin.openGoals());
    this.goalBodyEl = root.createDiv({ cls: "life-cockpit-goal-current" });

    // 只剩两颗按钮（AME-239）：**开工**和**结束**。
    // 「暂停」和「跳过本段」整个拿掉——一个能随手暂停、随手跳过的强制干预，
    // 不是强制干预。
    //
    // 「结束」结束的是**这一段**，不是这一天（AME-258 第 18 条）：结束之后照常进休息、
    // 照常催复工。要今天到此为止，走命令面板里的「今天收工」——**那颗按钮不放在这里**，
    // 唯一能把催促停下来的动作应该需要专门找一下才按得到。
    const actions = root.createDiv({ cls: "life-cockpit-actions" });
    this.primaryButton = actions.createEl("button", { cls: "mod-cta", text: "开始" });
    this.primaryButton.addEventListener("click", () => void this.plugin.startOrResume());
    this.stopButton = actions.createEl("button", { text: "结束本段" });
    this.stopButton.addEventListener("click", () => void this.plugin.stopTimer());

    const daily = root.createDiv({ cls: "life-cockpit-daily" });
    daily.createDiv({ cls: "life-cockpit-section-title", text: "当日累计" });
    const track = daily.createDiv({ cls: "life-cockpit-track" });
    this.focusBarEl = track.createDiv({ cls: "life-cockpit-bar" });
    this.focusTextEl = daily.createDiv({ cls: "life-cockpit-daily-text" });
    this.pomodoroTextEl = daily.createDiv({ cls: "life-cockpit-daily-text" });

    this.pointsEl = root.createDiv({ cls: "life-cockpit-points" });
    const pointsHead = this.pointsEl.createDiv({ cls: "life-cockpit-points-head" });
    pointsHead.createDiv({ cls: "life-cockpit-section-title", text: "积分账本" });
    const pointsActions = pointsHead.createDiv({ cls: "life-cockpit-points-actions" });
    const earnButton = pointsActions.createEl("button", { text: "＋记一笔" });
    earnButton.addEventListener("click", () => this.plugin.openRecordPoints("earn"));
    const spendButton = pointsActions.createEl("button", { text: "－享乐" });
    spendButton.addEventListener("click", () => this.plugin.openRecordPoints("spend"));
    const ledgerButton = pointsActions.createEl("button", { text: "账本" });
    ledgerButton.addEventListener("click", () => this.plugin.openPointsLedger());
    this.pointsBodyEl = this.pointsEl.createDiv({ cls: "life-cockpit-points-body" });

    this.nudgeEl = root.createDiv({ cls: "life-cockpit-nudge" });
    const nudgeHead = this.nudgeEl.createDiv({ cls: "life-cockpit-points-head" });
    nudgeHead.createDiv({ cls: "life-cockpit-section-title", text: "推动器" });
    const nudgeActions = nudgeHead.createDiv({ cls: "life-cockpit-points-actions" });
    this.muteButton = nudgeActions.createEl("button", { text: "静音" });
    this.muteButton.addEventListener("click", () => void this.plugin.toggleMute());
    const readingButton = nudgeActions.createEl("button", { text: "今日推荐" });
    readingButton.addEventListener("click", () => this.plugin.showReading());
    const gateButton = nudgeActions.createEl("button", { text: "强提醒页" });
    gateButton.addEventListener("click", () => this.plugin.openGateNow());
    this.nudgeBodyEl = this.nudgeEl.createDiv({ cls: "life-cockpit-points-body" });

    // 强制干扰单独一栏，不并进推动器：推动器关掉的时候这一层照样在跑，
    // 而「它现在会不会突然锁我的屏」是人随时想确认的一件事。
    this.enforceEl = root.createDiv({ cls: "life-cockpit-nudge" });
    const enforceHead = this.enforceEl.createDiv({ cls: "life-cockpit-points-head" });
    enforceHead.createDiv({ cls: "life-cockpit-section-title", text: "强制干扰" });
    const enforceActions = enforceHead.createDiv({ cls: "life-cockpit-points-actions" });
    const drillButton = enforceActions.createEl("button", { text: "演练" });
    drillButton.addEventListener("click", () => this.plugin.enforceDrill());
    const stopButton = enforceActions.createEl("button", { text: "停" });
    stopButton.addEventListener("click", () => this.plugin.stopEnforcement());
    this.enforceTextEl = this.enforceEl.createDiv({ cls: "life-cockpit-hint" });

    // 飞书那一栏（AME-258 第 19.1 条）。它不是驾驶舱的数据面，是**外面那张表**的
    // 一个回执——所以只有一行状态和一颗打开按钮，不在这里重画那张表。
    this.feishuEl = root.createDiv({ cls: "life-cockpit-nudge" });
    const feishuHead = this.feishuEl.createDiv({ cls: "life-cockpit-points-head" });
    feishuHead.createDiv({ cls: "life-cockpit-section-title", text: "飞书金字塔表格" });
    const feishuActions = feishuHead.createDiv({ cls: "life-cockpit-points-actions" });
    const feishuOpen = feishuActions.createEl("button", { text: "打开表格" });
    feishuOpen.addEventListener("click", () => void this.plugin.openFeishu());
    // 【总结】那一页（AME-271 第 28 条）：整表的「哪些做了、哪些没做」写在飞书自己身上，
    // 这里只给一个入口。地址没填就不显示这颗——一颗按下去只会弹「没配」的按钮是噪音。
    this.feishuSummaryButton = feishuActions.createEl("button", { text: "打开总结页" });
    this.feishuSummaryButton.addEventListener("click", () => void this.plugin.openFeishuSummary());
    // 新主链：Convex job 派自动化去跑 lark-cli 和 write_feishu_summary.py。
    this.feishuSummaryRefreshButton = feishuActions.createEl("button", {
      text: "更新总结页",
      cls: "mod-cta",
    });
    this.feishuSummaryRefreshButton.addEventListener(
      "click",
      () => void this.plugin.refreshFeishuSummary(),
    );
    const feishuReload = feishuActions.createEl("button", { text: "重读快照" });
    feishuReload.addEventListener("click", () => void this.plugin.reloadFeishu());
    // 旧版快照链仍保留为下位补充：它只拉仓库里的快照，不负责主链的总结页状态。
    const feishuPull = feishuActions.createEl("button", { text: "备用：拉一份快照" });
    feishuPull.addEventListener("click", () => void this.plugin.pullFeishuSnapshot());
    this.feishuTextEl = this.feishuEl.createDiv({ cls: "life-cockpit-hint" });

    const rhythm = root.createDiv({ cls: "life-cockpit-rhythm" });
    rhythm.createDiv({ cls: "life-cockpit-section-title", text: "五行节律表" });
    this.tableEl = rhythm.createDiv({ cls: "life-cockpit-table-wrap" });

    const sessions = root.createDiv({ cls: "life-cockpit-sessions" });
    sessions.createDiv({ cls: "life-cockpit-section-title", text: "今日流水" });
    this.sessionsEl = sessions.createDiv({ cls: "life-cockpit-session-list" });

    this.refresh();
  }

  refresh(): void {
    if (!this.cellEl) return;

    const settings = this.plugin.settings;
    const timer = this.plugin.timerState;
    const now = Date.now();
    const date = new Date(now);

    this.cellEl.setText(`当前：${this.plugin.describeCurrentCell(date)}`);

    for (const [id, button] of this.modeButtons) {
      button.toggleClass("mod-cta", settings.activeMode === id);
    }

    if (timer.status === "idle") {
      this.timeEl.setText("--:--");
      this.segmentEl.setText(`未开始 · ${MODE_LABELS[settings.activeMode]}`);
      this.primaryButton.setText("开始");
      this.primaryButton.disabled = false;
      this.stopButton.disabled = true;
    } else {
      this.timeEl.setText(formatDuration(remainingMs(timer, now)));
      // 停着 = 在等人开工，不是「被暂停了」——这一版里没有任何东西会暂停它。
      const waiting = timer.status === "paused";
      this.segmentEl.setText(
        `${waiting ? "等你开工 · " : ""}${SEGMENT_LABELS[timer.kind]} · 第 ${timer.pomodoroIndex} 个 · ${MODE_LABELS[settings.activeMode]}`,
      );
      this.primaryButton.setText(waiting ? "开工" : "进行中");
      // 正在跑的时候这颗按钮没有事情可做。灰着比消失好：位置不跳，人也看得出
      // 「现在没有别的选择，就是干活」。
      this.primaryButton.disabled = !waiting;
      // 停着等人开工的那一段一秒都还没跑过，没有「结束」可言（AME-258 第 18 条）：
      // 放行的话按一下就换来一段休息，那就是「跳过本段」从后门回来了。
      this.stopButton.disabled = timer.segmentStartedAt === null;
    }

    if (document.activeElement !== this.taskInput) {
      this.taskInput.value = timer.task;
    }

    const day = this.plugin.today;
    const progress = focusProgress(day);
    this.focusBarEl.style.width = `${Math.round(progress.ratio * 100)}%`;
    this.focusTextEl.setText(
      `专注 ${progress.minutes.toFixed(1)} / ${progress.targetMinutes} 分钟` +
        `（${settings.dailyWindowHours} 小时工作制）`,
    );
    this.pomodoroTextEl.setText(
      `完成 ${day.totals.completedPomodoros} 个番茄，开始过 ${day.totals.startedPomodoros} 个`,
    );

    this.renderTaskOptions();
    this.renderGoal();
    this.renderPoints(date);
    this.renderNudge(date);
    this.renderEnforce();
    this.renderFeishu();
    this.renderTable(date);
    this.renderSessions();
  }

  /**
   * 强制干扰这一栏只回答一个问题：**它接下来会做什么、什么时候做。**
   * 一层会自己锁屏、自己闪屏的东西，人有权随时看见它的下一步。
   */
  private renderEnforce(): void {
    const settings = this.plugin.settings;
    this.enforceEl.toggleClass("is-hidden", !settings.enforceEnabled);
    if (!settings.enforceEnabled) return;
    // 每秒都在变的一行字，直接 setText——重建节点才是浪费。
    this.enforceTextEl.setText(this.plugin.describeEnforcement());
  }

  /** 飞书那一栏只回答一句：现在读到的是哪一天的表、还欠多少条。 */
  private renderFeishu(): void {
    const on = this.plugin.settings.feishuEnabled;
    this.feishuEl.toggleClass("is-hidden", !on);
    if (!on) return;
    this.feishuSummaryButton.toggleClass(
      "is-hidden",
      this.plugin.settings.feishuSummarySheetUrl.trim() === "",
    );
    this.feishuSummaryRefreshButton.disabled = this.plugin.feishuSummaryRefreshActive();
    // 两行：第一行是「现在读到的是哪一天的表」，第二行是「拉取那条路现在什么状态」。
    // 合成一行的话，等待中的那句会把快照本身的信息挤没。
    const pull = this.plugin.describeFeishuPull();
    const summary = this.plugin.describeFeishuSummaryRefresh();
    this.feishuTextEl.setText([this.plugin.describeFeishu(), pull, summary].filter(Boolean).join("\n"));
  }

  /**
   * 推动器这一栏回答三个问题：**推得出去吗、今天还能推几条、今天该读什么**。
   * 渠道状态直接摊在这里，不用进设置面板翻——缺配置的时候人才想得起来去补。
   */
  private renderNudge(date: Date): void {
    const settings = this.plugin.settings;
    this.nudgeEl.toggleClass("is-hidden", !settings.nudgeEnabled);
    if (!settings.nudgeEnabled) return;

    this.muteButton.setText(settings.nudgeMuted ? "取消静音" : "静音");
    this.muteButton.toggleClass("mod-warning", settings.nudgeMuted);

    const statuses = this.plugin.push.statuses();
    const day = dayKeyFor(date, settings.dayRolloverHour);
    const quota = remainingQuota(settings, this.plugin.push.counters, day);
    const picks = this.plugin.todayReading();
    const latest = this.plugin.push.recent[0] ?? null;

    const signature = [
      settings.nudgeMuted,
      statuses.map((item) => `${item.id}:${item.state}`).join(","),
      quota,
      picks.map((pick) => pick.path).join(","),
      latest ? `${latest.key}@${latest.at.getTime()}` : "-",
    ].join("#");
    if (signature === this.nudgeSignature) return;
    this.nudgeSignature = signature;

    this.nudgeBodyEl.empty();

    const channels = this.nudgeBodyEl.createDiv({ cls: "life-cockpit-channel-status" });
    for (const status of statuses) {
      const row = channels.createDiv({ cls: "life-cockpit-channel-row" });
      row.addClass(`is-${status.state}`);
      row.createSpan({ cls: "life-cockpit-channel-name", text: status.label });
      row.createSpan({
        cls: "life-cockpit-channel-state",
        text: CHANNEL_STATE_LABELS[status.state],
      });
      row.createSpan({ cls: "life-cockpit-channel-detail", text: status.detail });
    }

    this.nudgeBodyEl.createDiv({
      cls: "life-cockpit-hint",
      text: settings.nudgeMuted
        ? "已静音：一条都不推，强制级也不例外。"
        : `今天还能推 ${Number.isFinite(quota) ? quota : "∞"} 条 · 最低分级 ${NUDGE_LEVEL_LABELS[settings.nudgeMinLevel]}`,
    });

    if (latest) {
      this.nudgeBodyEl.createDiv({
        cls: "life-cockpit-hint",
        text: `最近一条「${latest.title}」：${latest.outcome.message}`,
      });
    }

    if (!settings.readingEnabled) return;
    if (!picks.length) {
      this.nudgeBodyEl.createDiv({
        cls: "life-cockpit-hint",
        text: "今天没挑出可推的读物——候选区没有夜班总结，休息页和读物池也还没配。",
      });
      return;
    }
    const list = this.nudgeBodyEl.createDiv({ cls: "life-cockpit-reading-list" });
    for (const pick of picks) {
      const row = list.createDiv({ cls: "life-cockpit-reading-row" });
      row.createSpan({ cls: "life-cockpit-reading-kind", text: pick.kind });
      const link = row.createSpan({ cls: "life-cockpit-reading-title", text: pick.title });
      link.addEventListener("click", () => void this.plugin.openReadingPick(pick.path));
    }
  }

  /**
   * 这个番茄在推进哪个目标。下拉里只列能挂的那几层（日内目标与 KPI），
   * 下面一行把整条路径和回灌上来的进度摊开——推着的是哪一支，一眼看得见。
   */
  private renderGoal(): void {
    const settings = this.plugin.settings;
    this.goalEl.toggleClass("is-hidden", !settings.goalsEnabled);
    this.goalBodyEl.toggleClass("is-hidden", !settings.goalsEnabled);
    if (!settings.goalsEnabled) return;

    const goals = this.plugin.goals;
    const options = goals.attachableGoals();
    const optionsSignature = options
      .map((node) => `${node.id}:${node.level}:${node.title}`)
      .join("|");
    if (optionsSignature !== this.goalOptionsSignature) {
      this.goalOptionsSignature = optionsSignature;
      this.goalSelect.empty();
      this.goalSelect.createEl("option", { value: NO_GOAL, text: "不挂目标" });
      for (const node of options) {
        this.goalSelect.createEl("option", {
          value: node.id,
          text: `${GOAL_LEVEL_SHORT[node.level]} · ${node.title}`,
        });
      }
    }

    const wanted = this.plugin.pomodoroGoalId ?? NO_GOAL;
    if (this.goalSelect.value !== wanted) this.goalSelect.value = wanted;

    const current = goals.find(this.plugin.pomodoroGoalId);
    const percent = current ? goals.progressOf(current.id)?.progress ?? 0 : 0;
    const pomodoros = current ? this.plugin.pomodorosForGoal(current.id) : 0;
    const signature = [current?.id ?? "-", percent, pomodoros, goals.hasNote, options.length].join("#");
    if (signature === this.goalSignature) return;
    this.goalSignature = signature;

    this.goalBodyEl.empty();
    if (!current) {
      this.goalBodyEl.createDiv({
        cls: "life-cockpit-hint",
        text: options.length
          ? "这个番茄还没挂目标——挂上之后，跑完它会把进度顶回 KPI / OKR。"
          : "目标树上还没有可挂的日内目标 / KPI。去目标树面板拆一层出来。",
      });
      return;
    }

    this.goalBodyEl.createDiv({
      cls: "life-cockpit-goal-path",
      text: goals.pathLabel(current.id),
    });
    this.goalBodyEl.createDiv({
      cls: "life-cockpit-hint",
      text: `进度 ${formatGoalProgress(percent)} · 今日已投 ${pomodoros} 个番茄`,
    });
  }

  /** 番茄挂哪个预设任务。任务表在 vault 里改完即时生效，所以每次刷新都比对一下。 */
  private renderTaskOptions(): void {
    const tasks = this.plugin.points.earnTasks();
    const signature = tasks.map((task) => `${task.id}:${task.label}`).join("|");
    if (signature !== this.taskOptionsSignature) {
      this.taskOptionsSignature = signature;
      this.taskSelect.empty();
      this.taskSelect.createEl("option", { value: NO_TASK, text: "不挂任务" });
      for (const task of tasks) {
        this.taskSelect.createEl("option", { value: task.id, text: task.label });
      }
    }

    const wanted = this.plugin.pomodoroTaskId ?? NO_TASK;
    // 任务表里把这项删了：状态跟着回到「不挂任务」，别让下拉显示的和实际计分的对不上。
    // **任务表压根没读到的时候不算「删了」**（冷启动竞态，AME-227）：这个选择现在是
    // 要落盘的（AME-244），放掉就等于替人把它永久删掉。
    if (
      wanted !== NO_TASK &&
      this.plugin.points.hasTaskNote &&
      !tasks.some((task) => task.id === wanted)
    ) {
      this.plugin.setPomodoroTask(null);
      this.taskSelect.value = NO_TASK;
    } else if (this.taskSelect.value !== wanted) {
      this.taskSelect.value = wanted;
    }
    this.taskSelect.disabled = !this.plugin.settings.pointsEnabled;
  }

  private renderPoints(date: Date): void {
    const settings = this.plugin.settings;
    this.pointsEl.toggleClass("is-hidden", !settings.pointsEnabled);
    if (!settings.pointsEnabled) return;

    const book = this.plugin.points.book;
    const range = presetRange("today", date, settings.dayRolloverHour);
    const today = summarize(book, range.from, range.to);
    const balance = currentBalance(book);
    const recent = [...today.entries].reverse().slice(0, 4);

    const signature = [
      balance,
      today.earned,
      today.spent,
      this.plugin.points.hasTaskNote,
      recent.map((entry) => entry.id).join(","),
    ].join("#");
    if (signature === this.pointsSignature) return;
    this.pointsSignature = signature;

    this.pointsBodyEl.empty();
    const head = this.pointsBodyEl.createDiv({ cls: "life-cockpit-points-balance" });
    head.createSpan({ cls: "life-cockpit-points-value", text: formatPoints(balance) });
    head.createSpan({ cls: "life-cockpit-points-unit", text: "分" });
    head.createSpan({
      cls: "life-cockpit-points-today",
      text: `今日 +${formatPoints(today.earned)} / -${formatPoints(today.spent)}`,
    });

    if (!this.plugin.points.hasTaskNote) {
      this.pointsBodyEl.createDiv({
        cls: "life-cockpit-hint",
        text: `任务表还没建（${settings.pointsTaskNote}）。命令面板里跑「写出积分任务表」，之后直接在 vault 里改分值。`,
      });
    }

    if (!recent.length) {
      this.pointsBodyEl.createDiv({ cls: "life-cockpit-hint", text: "今天还没有积分流水。" });
      return;
    }

    const list = this.pointsBodyEl.createDiv({ cls: "life-cockpit-points-list" });
    for (const entry of recent) {
      const row = list.createDiv({ cls: "life-cockpit-points-entry" });
      row.createSpan({ cls: "life-cockpit-session-time", text: entry.at.slice(11) });
      row.createSpan({
        cls: entry.direction === "earn" ? "is-earn" : "is-spend",
        text: `${entry.direction === "earn" ? "+" : "-"}${formatPoints(entry.amount)}`,
      });
      row.createSpan({ cls: "life-cockpit-session-body", text: entry.reason });
    }
  }

  private renderTable(date: Date): void {
    const settings = this.plugin.settings;
    const segments = resolveSegments(settings.rhythmSegments);
    const current = segmentAt(segments, minuteOfDay(date));
    const phase = phaseForDate(date, settings);

    const signature = [
      segments.map((s) => `${s.id}:${s.label}:${s.startMinute}:${s.endMinute}`).join("|"),
      current?.id ?? "-",
      phase?.id ?? "-",
    ].join("#");
    if (signature === this.tableSignature) return;
    this.tableSignature = signature;

    this.tableEl.empty();
    const table = this.tableEl.createEl("table", { cls: "life-cockpit-table" });

    const head = table.createEl("thead").createEl("tr");
    head.createEl("th", { text: "时间" });
    head.createEl("th", { text: "时段" });
    for (const item of WUXING_PHASES) {
      const th = head.createEl("th", { text: item.label });
      if (phase && phase.id === item.id) th.addClass("is-current-phase");
    }

    const body = table.createEl("tbody");
    for (const segment of segments) {
      const row = body.createEl("tr");
      if (current && current.id === segment.id) row.addClass("is-current-segment");
      row.createEl("td", {
        text: `${formatClock(segment.startMinute)} - ${formatClock(segment.endMinute)}`,
      });
      row.createEl("td", { text: segment.label });
      for (const item of WUXING_PHASES) {
        const cell = row.createEl("td");
        const isCurrent = Boolean(current && current.id === segment.id && phase && phase.id === item.id);
        if (isCurrent) {
          cell.addClass("is-current-cell");
          cell.setText("●");
        }
      }
    }

    if (!current) {
      this.tableEl.createDiv({
        cls: "life-cockpit-hint",
        text: "现在落在表里的空档（12-13、17-18 原表就是空的）。",
      });
    }
    if (!phase && settings.phaseMapping === "weekday") {
      this.tableEl.createDiv({
        cls: "life-cockpit-hint",
        text: "今天是周末，weekday 映射下没有对应列。可在设置里改成 cycle5。",
      });
    }
  }

  private renderSessions(): void {
    const sessions = this.plugin.today.sessions;
    const recent = sessions.slice(-12).reverse();
    const signature = recent.map((s) => `${s.id}:${s.actualSeconds}:${s.completed}`).join("|");
    if (signature === this.sessionsSignature) return;
    this.sessionsSignature = signature;

    this.sessionsEl.empty();
    if (!recent.length) {
      this.sessionsEl.createDiv({ cls: "life-cockpit-hint", text: "今天还没有流水。" });
      return;
    }

    for (const session of recent) {
      const row = this.sessionsEl.createDiv({ cls: "life-cockpit-session" });
      row.toggleClass("is-work", session.kind === "work");
      const clock = session.startedAt.slice(11, 16);
      const minutes = (session.actualSeconds / 60).toFixed(1);
      const mark = session.completed ? "✓" : "·";
      row.createSpan({ cls: "life-cockpit-session-time", text: clock });
      row.createSpan({
        cls: "life-cockpit-session-body",
        text: `${mark} ${SEGMENT_LABELS[session.kind]} ${minutes} 分钟${session.task ? ` · ${session.task}` : ""}`,
      });
    }
  }
}
