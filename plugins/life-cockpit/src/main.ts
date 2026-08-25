import { normalizePath, Notice, Plugin, requestUrl, TFile, TFolder } from "obsidian";
import type { ListedFiles } from "obsidian";
import {
  activeModeSetting,
  COCKPIT_ROOT,
  DEFAULT_SETTINGS,
  inferCockpitRoot,
  MODE_IDS,
  MODE_LABELS,
  normalizeSettings,
} from "./core/settings";
import type { BreakPageSetting, LifeCockpitSettings, ModeId } from "./core/settings";
import {
  configFromMode,
  createInitialState,
  describeAlternatePlan,
  isBreak,
  reduce,
  remainingMs,
  resetDayCounter,
  SEGMENT_LABELS,
} from "./core/timer";
import type { CompletedSegment, SegmentKind, TimerConfig, TimerState } from "./core/timer";
import {
  createSessionSnapshot,
  describeRestore,
  normalizeSession,
  restoreSession,
} from "./core/session";
import type { PersistedSession } from "./core/session";
import {
  createDayLedger,
  dayKeyFor,
  focusProgress,
  formatLocalIso,
  makeSessionId,
  parseDayLedger,
  serializeDayLedger,
  shouldWrite,
  upsertSession,
} from "./core/ledger";
import type { DayLedger, SessionRecord } from "./core/ledger";
import {
  currentCell,
  describeCell,
  describeTransition,
  minuteOfDay,
  parseClock,
  phaseForDate,
  resolveSegments,
  segmentAt,
  segmentTransition,
} from "./core/rhythm";
import type { ResolvedSegment } from "./core/rhythm";
import {
  createReminderState,
  resetReminderState,
  tickReminder,
} from "./core/reminders";
import type { ReminderState } from "./core/reminders";
import { PointsStore } from "./core/points-store";
import { StaleMissingError } from "./core/vault-io";
import type { VaultIo } from "./core/vault-io";
import { currentBalance, formatPoints } from "./core/points";
import type { PointsDirection, PointsEntry } from "./core/points";
import { GoalStore } from "./core/goal-store";
import { formatGoalProgress, goalFeishuKeywords, walkGoals } from "./core/goals";
import type { FeishuGoalTally, GoalDraft, GoalInput, GoalNode } from "./core/goals";
import { CandidateStore } from "./core/candidate-store";
import { ReviewStore } from "./core/review-store";
import type { ReviewRun } from "./core/review-store";
import { createBedtimeState, markBedtimeFired, tickBedtime } from "./core/review";
import type { BedtimeState } from "./core/review";
import { PushHub, resolveCredential } from "./core/nudge";
import type { NudgeLevel, NudgeMessage, PushChannel } from "./core/nudge";
import {
  abandonGate,
  advanceGateDwell,
  canPassGate,
  createGateState,
  gateRemainingMs,
  openGate,
  passGate,
  skipGate,
  pickGatePage,
  shouldOpenGate,
} from "./core/gate";
import type { GateReason, GateState } from "./core/gate";
import {
  breakStartActions,
  createEnforceState,
  describeEnforcePlan,
  nextEnforceCheckMs,
  stepEnforce,
} from "./core/enforce";
import type { EnforceAction, EnforceState } from "./core/enforce";
import { describeAttention, evaluateAttention, IDLE_PROBE_SCRIPT, parseIdleProbe } from "./core/attention";
import type { AttentionVerdict } from "./core/attention";
import {
  buildHudSnapshot,
  createHeartbeatState,
  describeHudPlan,
  stepHeartbeat,
} from "./core/hud";
import type { HeartbeatState, HudSnapshot } from "./core/hud";
import { powerShellArgs } from "./core/brightness";
import {
  countdownDue,
  countdownRemainingMs,
  createLockState,
  deferLock,
  exemptLockToday,
  finishCountdown,
  lockCommandFor,
  lockSupport,
  rolloverLock,
  shouldOfferLock,
  startCountdown,
} from "./core/lock";
import type { LockState } from "./core/lock";
import {
  buildReadingList,
  createDailySlotState,
  describeReadingList,
  expandReadingPool,
  markDailySlotFired,
  summarizeReadingList,
  tickDailySlot,
} from "./core/reading";
import type { DailySlotState, ReadingPick } from "./core/reading";
import type { ReviewMaterial } from "./core/review";
import { buildReviewMessages, parseAiReviewDraft, parseReviewMaterial } from "./core/review";
import type { ReviewDraft } from "./core/review";
import {
  createFeishuPullState,
  describeFeishuByGoal,
  describeFeishuTasks,
  failFeishuPull,
  feishuHeadline,
  feishuReviewSlice,
  feishuSnapshotKey,
  feishuTasksFor,
  latestFeishuDay,
  parseFeishuSnapshot,
  rollupFeishuByGoal,
  startFeishuPull,
  summarizeFeishu,
  tickFeishuPull,
} from "./core/feishu";
import type {
  FeishuGoalRollup,
  FeishuPullState,
  FeishuReviewSlice,
  FeishuSnapshot,
  FeishuTask,
} from "./core/feishu";
import { describeAi } from "./core/ai";
import {
  AI_LOG_DIR,
  aiLogDayOf,
  aiLogPath,
  appendAiLogEntry,
  expiredAiLogDays,
  parseAiLog,
  serializeAiLog,
} from "./core/ai-log";
import type { AiLogEntry } from "./core/ai-log";
import { AiClient, aiEnv } from "./ai-client";
import { MiaodaStore } from "./core/miaoda-store";
import { MiaodaClient } from "./miaoda-client";
import { shouldShowZen } from "./core/zen";
import { SystemChannel } from "./channels/system-channel";
import { FeishuChannel, WebhookChannel } from "./channels/webhook-channel";
import {
  currentPlatform,
  describeDesktopBridge,
  flashTaskbar,
  focusMainWindow,
  openExternal,
  runCommand,
  setBackgroundThrottling,
  systemIdleMs,
} from "./desktop";
import { AlarmRunner, systemNotify } from "./alarm";
import { HudPresenter } from "./hud";
import { AudioPlayer } from "./ui/audio-player";
import { CockpitView, VIEW_TYPE_COCKPIT } from "./ui/cockpit-view";
import { GoalTreeView, VIEW_TYPE_GOALS } from "./ui/goal-tree-view";
import { CandidateView, VIEW_TYPE_CANDIDATES } from "./ui/candidate-view";
import { WechatView, VIEW_TYPE_WECHAT } from "./ui/wechat-view";
import {
  DashboardView,
  DASHBOARD_VIEW_TYPE,
  WechatPersonaView,
  WECHAT_PERSONA_VIEW_TYPE,
} from "./ui/dashboard/view";
import { ConvexSync } from "./convex-sync";
import type { ConvexJobSnapshot } from "./convex-sync";
import type { OutboxState } from "./core/outbox";
import { describe as describeOutbox, emptyOutbox, enqueue, normalizeOutbox } from "./core/outbox";
import {
  fingerprint,
  toConvexGoalNodes,
  toConvexLedgerEntry,
  toConvexSession,
} from "./core/convex-map";
import { voidedIds } from "./core/points";
import type { DecideMode } from "./ui/candidate-decide-modal";
import { ConfirmModal } from "./ui/confirm-modal";
import { GoalEditModal } from "./ui/goal-edit-modal";
import { GoalPickModal } from "./ui/goal-pick-modal";
import { OnboardingModal } from "./ui/onboarding-modal";
import { StatusBarIndicator } from "./ui/status-bar";
import { ZenOverlay } from "./ui/zen-overlay";
import { AiLogModal } from "./ui/ai-log-modal";
import { PointsLedgerModal } from "./ui/points-ledger-modal";
import { RecordPointsModal } from "./ui/points-record-modal";
import { LifeCockpitSettingTab } from "./settings-tab";

/**
 * 写进日档 / 月账 / 目标树 / 候选项抬头的「谁写的」。
 *
 * **只有落盘格式可能变了才跟着版本动。** 它一变，下一次写盘就要把盘上所有相关文件
 * 整份重写一遍——纯 UI 的版本（0.6.3 的设置页标签页就是）这么做只会给 Easy-Git
 * 造一串没有信息量的 diff，正是 writeIfChanged 想避免的那种。
 */
const GENERATOR = "life-cockpit@0.6.2";
const TICK_MS = 1000;

/**
 * 番茄跑着的时候，多久往 data.json 里刷新一次「现在几点、跑到哪儿了」。
 *
 * 这个数字决定的是**崩溃 / 强杀之后的误差上限**：正常退出有 `onunload` 收尾，
 * 而 Obsidian 被任务管理器结束掉时，只有最后这一次刷新算数。15 秒的误差对
 * 分钟级的宽限期毫无影响，写盘量也可以忽略（data.json 只有几 KB，且不在 vault 里，
 * 不会给 Easy-Git 制造 commit）。
 */
const SESSION_SAVE_MS = 15_000;

/** 适配器列目录给的是全路径，VaultIo 那两个 list 口只要文件名。 */
function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/**
 * 出错弹什么。绝大多数写盘失败只能指去控制台，但 `StaleMissingError` 的文案是
 * 写给人看的、能照着做（去跑一次「重读……」），埋进控制台就白写了。
 */
function failureNotice(error: unknown, fallback: string): string {
  return error instanceof StaleMissingError ? error.message : fallback;
}

export default class LifeCockpitPlugin extends Plugin {
  // `declare` 覆盖基类里 unknown 的 settings，不额外产出会遮蔽它的字段。
  declare settings: LifeCockpitSettings;

  timerState: TimerState = createInitialState();
  today: DayLedger = createDayLedger("", {
    targetMinutes: DEFAULT_SETTINGS.dailyFocusTargetMinutes,
    windowHours: DEFAULT_SETTINGS.dailyWindowHours,
    generator: GENERATOR,
  });
  points!: PointsStore;
  goals!: GoalStore;
  candidates!: CandidateStore;
  review!: ReviewStore;
  /**
   * 当前番茄挂在哪个预设任务上；没挑就走设置里的默认项。
   * **落 data.json**（AME-244）——重启一次就要重挑一遍，是这条 issue 的第一句话。
   */
  pomodoroTaskId: string | null = null;
  /** 当前番茄在推进哪个目标树节点；没挂就是 null。同样落 data.json */
  pomodoroGoalId: string | null = null;

  /** 推动器：闸门 + 渠道。R6 唯一对外说话的口子 */
  push!: PushHub;
  /** AI 接口（AME-258 第 20 条）。唯一发模型请求的口子 */
  ai!: AiClient;
  /** 秒哒「5 分钟写作」的落盘层（AME-272 第 26 条） */
  miaoda!: MiaodaStore;
  /** 秒哒的执行侧。唯一向秒哒发请求的口子 */
  miaodaClient!: MiaodaClient;

  private statusBar?: StatusBarIndicator;
  private zen?: ZenOverlay;
  private audio?: AudioPlayer;
  private reminders: ReminderState = createReminderState();
  /** 睡前复盘一个账本日只提醒一次；换天自动重置 */
  private bedtime: BedtimeState = createBedtimeState();
  private currentTheme: string | null = null;
  private lastSegment: ResolvedSegment | null = null;
  private breakPageCursor = 0;
  /** Esc 退出禅定后记住是哪一段，同一段不再弹回来 */
  private zenDismissedFor: string | null = null;
  /** 用命令手动叫出遮罩的那一段；工作段默认不盖，只有这一次破例 */
  private zenForcedFor: string | null = null;
  /** 落盘串行化，避免读-改-写互相覆盖 */
  private writeQueue: Promise<void> = Promise.resolve();

  // --- 跨重启的现场（AME-244） ---
  /** 上一次退出时存下来的现场。`bootstrapFromVault` 用完就不再看它 */
  private savedSession: PersistedSession | null = null;
  /** 上一次写进 data.json 的状态指纹；没变就不重复写 */
  private lastSessionKey = "";
  private lastSessionSaveAt = 0;

  // --- 推动器（R6） ---
  private gate: GateState = createGateState();
  private lock: LockState = createLockState();
  /** 每日推荐一个账本日只推一次 */
  private readingSlot: DailySlotState = createDailySlotState();
  /** 挑推荐读物时用的复盘素材；载入时读一次，跑完复盘再读一次 */
  private readingMaterial: { material: ReviewMaterial; path: string } | null = null;
  /**
   * 飞书快照：读进来的那一份、它对应哪一天、从哪个文件读的。
   * `null` = 没有快照，那就只是没有这一栏（AME-258 第 19.1 条）。
   */
  private feishu: { snapshot: FeishuSnapshot; day: string; path: string } | null = null;
  /** 「喊了一嗓子之后等新快照」那件事跑到哪一步了（AME-258 第 22.2 条） */
  private feishuPull: FeishuPullState = createFeishuPullState();
  /** Convex 主链更新【总结】页的 job；旧 webhook 快照链不再是默认入口。 */
  private feishuSummaryJob: ConvexJobSnapshot | null = null;
  private feishuSummaryJobUnsubscribe: (() => void) | null = null;
  private feishuSummaryWatchedJobId: string | null = null;
  private feishuSummaryActiveUnsubscribe: (() => void) | null = null;
  /** 上一次真的去盘上看快照的时刻。等待期间每 30 秒才动一次盘 */
  private lastFeishuProbeAt = 0;
  /** 上一拍探快照的活儿还没跑完。Easy Git 慢的时候不许再叠一次 */
  private feishuProbing = false;
  /** 「飞书 × 目标树」那一份归组的一拍缓存，见 feishuGoalRollup */
  private feishuRollupCache: { key: string; at: number; value: FeishuGoalRollup | null } | null =
    null;
  /** 素材包一个账本日只自动落一次；换天自动重置 */
  private materialWrittenFor: string | null = null;
  /** 上一次自动拉秒哒的时刻。0 = 这一次启动之后还没拉过 */
  private lastMiaodaPullAt = 0;
  /** 上一次拉秒哒还没跑完。网络慢的时候不许再叠一次 */
  private miaodaPulling = false;
  /**
   * 今天的 AI 调用留痕（新的在前）。**只在内存里攒，写盘是追加式的**：
   * 一次复盘就一两条，没必要为它维护缓存一致性。
   */
  private aiLog: AiLogEntry[] = [];
  private aiLogDay = "";
  /** 读物池按目录展开的结果，带一分钟 TTL。见 `expandedReadingPool` */
  private readingPoolCache: { key: string; at: number; paths: string[] } | null = null;
  /**
   * 上一次收工的时刻。`null` = 不知道（刚装载插件），按「离开很久」处理——
   * 重开 Obsidian 坐下来的那一次，正是最该被拦一下的那一次。
   */
  private lastIdleAt: number | null = null;
  private channels: PushChannel[] = [];
  /**
   * Convex 同步层（AME-267）。**它是同步层，不是运行时依赖**——
   * 整个挂掉番茄也照跑，所以对它的每一次调用都吞异常。
   */
  private convex = new ConvexSync();
  /**
   * 出站队列。和现场一样住在 `data.json` 里（不进 settings），所以**重启接得上**：
   * 关掉 Obsidian 时没推上去的，下次开机继续推。
   */
  private outbox: OutboxState = emptyOutbox();
  private lastOutboxFlushAt = 0;
  private lastReconcileAt = 0;
  /**
   * 上一次入队时的内容指纹。**不落盘**——重启之后重推一遍是无害的
   * （后端按自然键幂等，内容没变会返回 skipped），而落盘就多一份要维护的状态。
   */
  private convexFingerprints = new Map<string, string>();
  /**
   * 全账推过一次了没有。**不落盘**——每次启动重推一遍全账是无害的
   * （自然键幂等，内容没变后端返回 skipped），而它换来的是
   * 「一台新机器配好之后历史账目也上得去」。
   */
  private convexBackfilled = false;

  /** 已经 onunload 了。布局就绪回调撤不掉，只能自己认这面旗子。 */
  private unloaded = false;

  // --- 存在感层（AME-239） ---
  /** 桌面悬浮提示框 + 任务栏展示。开不出桌面窗时自己退回窗口内浮层 */
  private hud?: HudPresenter;
  /** 心跳提醒（默认每 2 分钟一拍）的节拍状态 */
  private heartbeat: HeartbeatState = createHeartbeatState();
  /** 心跳闪任务栏之后把它收掉的那个计时器 */
  private flashTimer: number | null = null;

  // --- 强制干扰（AME-238） ---
  private alarm?: AlarmRunner;
  private enforce: EnforceState = createEnforceState();
  /**
   * 复工待命起点：休息结束了、工作段却没跑起来。0.8.0 起工作段**一律**停着等人
   * （AME-239：自动开工永远不可接受），所以每一次休息结束都会走到这里。
   * **这就是「人没有点击恢复继续番茄」那个状态**，催促的每一轮都从它算起。
   */
  private awaitingSince: number | null = null;
  /** Obsidian 窗口内最后一次输入。窗口外的输入它看不见，所以只是佐证 */
  private lastInputAt: number | null = null;
  /** PowerShell 兜底探出来的系统空闲时间，带时间戳的缓存 */
  private idleProbe: { at: number; ms: number | null } = { at: 0, ms: null };
  private idleProbing = false;
  /** 最近一次「人在不在」的判定，面板和设置页直接显示它 */
  private attention: AttentionVerdict = {
    atKeyboard: true,
    attending: true,
    idleMs: 0,
    reason: null,
  };
  /** 关过后台节流；卸载时要还回去 */
  private throttlingSuspended = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    const io = this.vaultIo();
    this.points = new PointsStore({
      io,
      generator: GENERATOR,
      settings: () => this.settings,
      dayLedgerPath: (day) => this.ledgerPath(day),
    });
    this.goals = new GoalStore({ io, generator: GENERATOR, settings: () => this.settings });
    // 候选区拿着目标树和账本：采纳一条 goal-node / ledger-entry 就是往这两处落。
    this.candidates = new CandidateStore({
      io,
      generator: GENERATOR,
      settings: () => this.settings,
      goals: this.goals,
      points: this.points,
    });
    // 复盘拿着前四样：取数读 R1/R2/R3，回写只走 R4 的候选区，不另起一套通道。
    this.review = new ReviewStore({
      io,
      generator: GENERATOR,
      settings: () => this.settings,
      points: this.points,
      goals: this.goals,
      candidates: this.candidates,
      dayLedgerPath: (day) => this.ledgerPath(day),
      feishu: (day) => this.feishuSlice(day),
    });

    // 系统通知不需要凭据，所以它排第一个：飞书 / webhook 没配也照样有一条通道能用。
    const system = new SystemChannel(() => this.settings.nudgeSystemEnabled);
    this.channels = [
      system,
      new FeishuChannel(() => ({
        enabled: this.settings.nudgeFeishuEnabled,
        webhook: this.settings.nudgeFeishuWebhook,
        secret: this.settings.nudgeFeishuSecret,
      })),
      new WebhookChannel(
        () => ({ enabled: this.settings.nudgeWebhookEnabled, url: this.settings.nudgeWebhookUrl }),
        GENERATOR,
      ),
    ];
    this.push = new PushHub({ settings: () => this.settings, channels: () => this.channels });
    // AI 接口和推动器是同一个形状：闸门与配置在 core，发请求在外面一层。
    // 它是**全局的一层**（AME-258 第 22.1 条）：档位表在设置里自己一页，
    // 谁要用就调 `this.ai`，现在的消费方只有睡前复盘一处，以后加处不用改配置。
    // 第二个参数是留痕的落点——**每一次调用都记，包括根本没发出去的那种**。
    this.ai = new AiClient(
      () => this.settings,
      (entry) => void this.recordAiCall(entry),
    );
    // 秒哒也是同一个形状：落盘在 core（跑得到测试），发请求在外面一层。
    this.miaoda = new MiaodaStore({ io, generator: GENERATOR, settings: () => this.settings });
    this.miaodaClient = new MiaodaClient(() => this.settings);
    void system.requestPermission();

    this.zen = new ZenOverlay(this.app, {
      onExit: () => this.dismissZen(),
      onStart: () => void this.startOrResume(),
      onPassGate: () => this.passCurrentGate(false),
      onSkipGate: () => this.passCurrentGate(true),
      onLockNow: () => void this.lockScreen(),
      onDeferLock: () => this.deferLockScreen(),
      onExemptLock: () => this.exemptLockScreen(),
      onOpenReading: (path) => void this.openReadingPick(path),
      onOpenLink: (href, sourcePath, external) =>
        void this.openOverlayLink(href, sourcePath, external),
    });
    this.addChild(this.zen);

    this.audio = new AudioPlayer(this.app);
    this.addChild(this.audio);

    // 干扰的执行侧。遮罩闪烁交给 ZenOverlay——亮度调不动的机器上就靠它。
    this.alarm = new AlarmRunner({
      settings: () => this.settings,
      onFlash: (active) => this.zen?.setFlash(active),
    });
    // 存在感层：常驻的那一块。它和 alarm 各管一头——alarm 是出事时才炸的，
    // 这一块是「一直在」的（AME-239）。
    this.hud = new HudPresenter({ settings: () => this.settings });
    this.addChild(this.hud);
    this.applyFontScale();
    this.registerAttentionProbes();

    this.addSettingTab(new LifeCockpitSettingTab(this.app, this));

    this.registerView(VIEW_TYPE_COCKPIT, (leaf) => new CockpitView(leaf, this));
    this.registerView(VIEW_TYPE_GOALS, (leaf) => new GoalTreeView(leaf, this));
    this.registerView(VIEW_TYPE_CANDIDATES, (leaf) => new CandidateView(leaf, this));
    this.registerView(VIEW_TYPE_WECHAT, (leaf) => new WechatView(leaf, this));
    // 数据台：那张 React 页。**它只读 Convex**，Convex 没配就显示一句「去填配置」，
    // 不影响任何别的功能。
    this.registerView(
      DASHBOARD_VIEW_TYPE,
      (leaf) => new DashboardView(leaf, this.convexBridge(), () => this.dayKey()),
    );
    this.registerView(
      WECHAT_PERSONA_VIEW_TYPE,
      (leaf) => new WechatPersonaView(leaf, this.convexBridge(), () => this.dayKey()),
    );
    this.applyConvexConfig();

    this.statusBar = new StatusBarIndicator(
      this.addStatusBarItem(),
      () => ({
        timer: this.timerState,
        now: Date.now(),
        focusMinutes: focusProgress(this.today).minutes,
        targetMinutes: this.settings.dailyFocusTargetMinutes,
        modeLabel: MODE_LABELS[this.settings.activeMode],
        balance: this.settings.pointsEnabled ? this.balance : null,
      }),
      () => void this.openCockpit(),
    );

    this.addRibbonIcon("timer", "人生驾驶舱", () => void this.openCockpit());
    this.addRibbonIcon("target", "目标树", () => void this.openGoals());
    this.addRibbonIcon("inbox", "夜班候选区", () => void this.openCandidates());
    // 数据台**必须有 ribbon 图标**。0.13.0 只给了命令面板一个入口，
    // 而另外三个视图都在 ribbon 上——结果就是「我找遍了也没看到」。
    // 一个只能靠命令面板搜出来的视图，等于没做。
    this.addRibbonIcon("bar-chart-3", "驾驶舱数据台", () => void this.openDashboard());
    this.registerCommands();

    // 首次运行引导（AME-317）：只在真的第一次弹。老机器升级上来也会见到一次，
    // 但文件夹那一问预填的是它们现在真正的数据根——原样确认等于什么都没改。
    if (!this.settings.onboardingDone) this.openOnboarding();

    // 读 vault 的那一段必须等布局就绪。冷启动（关掉 Obsidian 再打开）时插件的
    // onload 排在 vault 建索引之前，那会儿 getAbstractFileByPath 对着一份真实存在的
    // 笔记也会返回 null——目标树会读成空树、任务表会误判成「还没建」。手动在设置里
    // 启用插件之所以一直是好的，正是因为那时索引早就建好了。
    // onLayoutReady 在布局已经就绪时会立刻执行，所以手动启用那条路的时序不变。
    this.app.workspace.onLayoutReady(() => void this.bootstrapFromVault());
  }

  /** onload 里所有要读 vault 的活儿。见 onload 末尾：只能在布局就绪之后跑。 */
  private async bootstrapFromVault(): Promise<void> {
    // 布局就绪之前被停用了（设置里关掉 / 换主题重载）——这时候再挂定时器就没人收了。
    if (this.unloaded) return;
    await this.loadPoints();
    await this.loadGoals();
    await this.loadCandidates();
    await this.loadToday();
    await this.loadFeishu();
    // 同步索引要在第一次自动拉取之前读进来：没读到就分不清「从没拉过」和
    // 「还不知道拉没拉过」，而这两种的正确行为正好相反（见 MiaodaStore.since）。
    await this.loadMiaoda();
    await this.loadReadingMaterial();
    // 过期的 AI 留痕在这里清一次。放载入时而不是每次调用后：一天最多多留一份，
    // 而每次调用都扫一遍目录，是拿一个稳定的小成本换一个没人看得见的收益。
    await this.pruneAiLog();
    // 排在最后：接现场要用到刚读进来的任务表、目标树和当日流水。
    this.restoreLastSession();
    this.lastSegment = this.resolveCurrentSegment(new Date());
    this.reminders = resetReminderState(Date.now());
    this.currentTheme = activeModeSetting(this.settings).themeCycle[0] ?? null;

    this.registerInterval(window.setInterval(() => this.tick(), TICK_MS));
    this.applyBackgroundThrottling();
    this.refreshUi();
  }

  /**
   * 接上一次退出时的现场（AME-244）。判断全在 `core/session.ts`，这里只做三件事：
   * **把选择填回去**、**把状态机摆好**、**该补记的那一段补记掉**。
   *
   * 顺序有讲究：挂着的任务与目标先接回来（哪怕番茄本身接不回来也要接——
   * 「不用每次启动 Obsidian 都要去选」是这条 issue 的第一句话），再谈这一段番茄。
   */
  private restoreLastSession(): void {
    const saved = this.savedSession;
    if (!saved || !this.settings.sessionRestoreEnabled) return;

    this.pomodoroTaskId = saved.taskId;
    this.pomodoroGoalId = saved.goalId;
    this.pruneGoalSelection();
    this.pruneTaskSelection();

    const now = Date.now();
    const restore = restoreSession({
      session: saved,
      settings: this.settings,
      config: this.timerConfig,
      now,
      day: this.dayKey(new Date(now)),
    });
    if (restore.kind === "none") return;

    if (restore.kind !== "dropped") this.timerState = restore.state;
    if (restore.kind === "handoff") {
      // 离开期间跑完的那一段休息照实补记：它真的发生过，起止时刻也都是真的。
      for (const event of restore.events) {
        if (event.type === "segment-completed") this.recordSegment(event.segment);
      }
    }
    // 停着等人开工的三种情况（冻住的工作段、本来就停着、休息刚跑完）走同一条路：
    // 和「休息跑完」那一刻完全一样——该拦的拦一页，该催的从这一刻开始催。
    if (restore.kind === "held" || restore.kind === "handoff") {
      this.onSegmentStarted("work", restore.kind === "handoff", now);
    }
    new Notice(describeRestore(restore, saved));
  }

  /**
   * 任务表里已经没有这一项了：选择跟着放掉，别让计分指向一个不存在的任务。
   *
   * **任务表根本没读到的时候不动它**（`hasTaskNote`）：那可能只是冷启动竞态
   * （AME-227），这时候放掉选择等于替人把他挑好的任务永久删掉——现在这个选择是
   * 要落盘的，下一次写盘就把 null 钉死了。
   */
  private pruneTaskSelection(): void {
    if (!this.pomodoroTaskId || !this.points.hasTaskNote) return;
    const known = this.points.earnTasks().some((task) => task.id === this.pomodoroTaskId);
    if (!known) this.pomodoroTaskId = null;
  }

  onunload(): void {
    // Convex 那一层先收：不 dispose 的话订阅会漏，而漏掉的订阅还在计费。
    this.feishuSummaryJobUnsubscribe?.();
    this.feishuSummaryJobUnsubscribe = null;
    this.feishuSummaryWatchedJobId = null;
    this.feishuSummaryActiveUnsubscribe?.();
    this.feishuSummaryActiveUnsubscribe = null;
    this.convex.dispose();
    // 现场最后再存一次。**这只是锦上添花**：`saveData` 是异步的，Obsidian 不等它，
    // 被强杀时更不会走到这里——真正兜底的是跑着时每 15 秒那一次刷新。
    void this.persistData().catch(() => undefined);
    // 遮罩挂在 document.body 上，交给 ZenOverlay 的 onunload 收掉。
    // onLayoutReady 排的那个回调没法撤，只能让它自己看见这面旗子掉头。
    this.unloaded = true;
    // 干扰是外部进程 + 系统亮度，插件卸载了它可不会自己停。**必须显式收摊**，
    // 否则重载插件会留下一块暗着的屏幕和一个还在闪的任务栏图标。
    this.alarm?.stop();
    // 悬浮框是另一扇真窗户，`addChild` 会调它的 onunload 把它关掉；
    // 这里只收自己起的那个闪烁计时器。
    if (this.flashTimer !== null) {
      window.clearTimeout(this.flashTimer);
      this.flashTimer = null;
    }
    flashTaskbar(false);
    document.body.style.removeProperty("--life-cockpit-scale");
    if (this.throttlingSuspended) {
      setBackgroundThrottling(true);
      this.throttlingSuspended = false;
    }
  }

  /**
   * 后台节流：开着强制干扰就关掉它。
   *
   * 不关的话，人切走之后 Chromium 会把这个窗口的定时器压到每秒一次、五分钟后
   * 每分钟一次——而「人切走了」正是催促要跑的场景。AME-238 那两个小时里，
   * 插件的心跳大概每分钟才跳一下。
   */
  private applyBackgroundThrottling(): void {
    const want = this.settings.enforceEnabled;
    if (want === this.throttlingSuspended) return;
    const ok = setBackgroundThrottling(!want);
    if (ok) this.throttlingSuspended = want;
  }

  /**
   * 首次运行引导窗。它**不读 vault**，所以不用等布局就绪；
   * 数据根预填 `inferCockpitRoot` 推出来的现在真正的根（推不出就是中性默认），
   * 「就这样，开始用」和「跳过」都会把 `onboardingDone` 写进 data.json。
   */
  private openOnboarding(): void {
    if (this.settings.onboardingDone) return;
    new OnboardingModal(this.app, {
      settings: this.settings,
      currentRoot: inferCockpitRoot(this.settings) ?? COCKPIT_ROOT,
      onFinish: () => this.saveSettings(),
    }).open();
  }

  // -------------------------------------------------------------------------
  // 设置
  // -------------------------------------------------------------------------

  private async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as { session?: unknown } | null;
    this.settings = normalizeSettings(raw);
    // 现场和设置同住 data.json，但**不进 settings**：`normalizeSettings` 只认它认识的
    // 那些键，多出来的一律不带走，所以这一份必须自己读、自己写。
    this.savedSession = normalizeSession(raw?.session);
    // 出站队列和现场同住 data.json，同样不进 settings——`normalizeSettings`
    // 只认它认识的键，多出来的一律不带走，所以这一份也要自己读、自己写。
    this.outbox = normalizeOutbox((raw as { outbox?: unknown } | null)?.outbox);
  }

  /**
   * data.json 写一次就是整份覆盖，所以设置和现场必须一起写——
   * 单独 `saveData(this.settings)` 等于把上一次存的现场删掉。
   */
  private async persistData(): Promise<void> {
    const now = Date.now();
    this.lastSessionSaveAt = now;
    this.lastSessionKey = this.sessionKey();
    await this.saveData({
      ...this.settings,
      session: this.sessionSnapshot(now),
      outbox: this.outbox,
    });
  }

  // -------------------------------------------------------------------------
  // Convex 同步（AME-267）
  //
  // 三件事在这儿收口：把配置喂给同步层、给 React 页一个数据口、按拍推队列。
  // 队列语义本身是纯的，在 `core/outbox.ts` 里，被 `test/outbox.test.js` 钉住。
  // -------------------------------------------------------------------------

  /**
   * 凭据两处来源：设置项 → 环境变量。**没有第三处，也没有内置默认值**——
   * 照抄推动器和 AI 接口那两层的规矩。
   */
  private convexConfig(): { url: string; token: string } {
    const env = (name: string): string => {
      try {
        return (globalThis as { process?: { env?: Record<string, string> } })
          .process?.env?.[name] ?? "";
      } catch {
        return "";
      }
    };
    return {
      url: this.settings.convexUrl || env("LIFE_COCKPIT_CONVEX_URL"),
      token: this.settings.convexToken || env("LIFE_COCKPIT_CONVEX_TOKEN"),
    };
  }

  /** 设置改了之后重连，并把已经开着的数据台重画一遍。 */
  applyConvexConfig(): void {
    // configure 会 dispose 旧 client 的全部订阅；本地引用也要一起清掉，避免误以为
    // 仍在 watch。新 client 建好后先订活动 job，Obsidian 重启也能接回刷新现场。
    this.feishuSummaryJobUnsubscribe = null;
    this.feishuSummaryWatchedJobId = null;
    this.feishuSummaryActiveUnsubscribe = null;
    this.convex.configure(this.convexConfig(), this.settings.convexEnabled);
    this.feishuSummaryActiveUnsubscribe = this.convex.watchActiveJobs((jobs) => {
      const active = jobs.find(
        (job) => job.kind === "feishu-snapshot" && job.day === this.dayKey(),
      );
      if (!active) return;
      this.feishuSummaryJob = active;
      this.watchFeishuSummaryJob(active._id);
      this.refreshUi();
    });
    for (const leaf of this.app.workspace.getLeavesOfType(WECHAT_PERSONA_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof WechatPersonaView) view.render();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof DashboardView) view.render();
    }
  }

  /** 给那张 React 页的数据口。**它只认这个接口，不认 Obsidian**——将来能拆成网站。 */
  private convexBridge() {
    return {
      subscribe: <T,>(
        fn: string,
        args: Record<string, unknown>,
        cb: (v: T) => void,
      ) => this.convex.subscribe<T>(fn, args, cb),
      mutate: (fn: string, args: Record<string, unknown>) =>
        this.convex.mutate(fn, args),
      status: () => this.convex.getStatus(),
    };
  }

  /**
   * 只读的 Convex 数据口，给微信分析面板用。
   *
   * 和 `convexBridge()` 同一个东西，但**只暴露读**——那个面板碰不到 mutate，
   * 也不该碰：`wechat*` 那几张表的写入方是服务器上的归档流水线，
   * 插件这边多一条写路径，就多一处能把派生数据写歪的地方。
   */
  convexReader(): {
    subscribe: <T>(fn: string, args: Record<string, unknown>, cb: (v: T) => void) => () => void;
    status: () => ReturnType<ConvexSync["getStatus"]>;
  } {
    return {
      subscribe: <T,>(
        fn: string,
        args: Record<string, unknown>,
        cb: (v: T) => void,
      ) => this.convex.subscribe<T>(fn, args, cb),
      status: () => this.convex.getStatus(),
    };
  }

  /** 往队列里塞一条。只由 `reconcileConvex` 调，不在写盘点上散着挂。 */
  private queueForConvex(
    kind: "session" | "ledger" | "goals",
    key: string,
    payload: unknown,
  ): void {
    this.outbox = enqueue(this.outbox, {
      key,
      kind,
      payload: JSON.stringify(payload),
      at: Date.now(),
    });
  }

  /**
   * 对账：拿当前内存里的三样东西和「上次推上去的」比，变了才入队。
   *
   * **这是上行链路的唯一入口。** 0.13.0 那一版指望在各个写盘点上分别挂钩，
   * 结果一个钩子都没接上——队列永远是空的，面板永远显示「还没同步过」，
   * 而且一声不吭。挂钩这种做法漏一个就断一条，对账则漏不掉：
   * 不管是谁、在哪儿改的内存，下一拍都会被看见。
   *
   * 顺带的好处：断网期间攒下的改动，回来第一拍自己就补上了，不需要额外的补偿逻辑。
   */
  private reconcileConvex(now: number): void {
    if (!this.settings.convexEnabled) return;
    // 一秒钟对一次账没有意义（tick 是每秒一拍），按同步节拍走
    const interval = this.settings.convexSyncSeconds * 1000;
    if (now - this.lastReconcileAt < interval) return;
    this.lastReconcileAt = now;

    try {
      // ---- 番茄流水：一条一个自然键 ----
      const day = this.today.date;
      for (const session of this.today.sessions) {
        const payload = toConvexSession(session, day, GENERATOR);
        const key = `session:${session.id}`;
        const fp = fingerprint(payload);
        if (this.convexFingerprints.get(key) === fp) continue;
        this.queueForConvex("session", key, payload);
        this.convexFingerprints.set(key, fp);
      }

      // ---- 积分流水 ----
      // **第一拍推全账，之后只看当天的和被撤销的。**
      //
      // 推全账那一下是必要的：一台新机器配好之后，历史账目也得上得去，
      // 否则库里只有「从今天开始」的账，余额从第一天就是错的。
      // 全账在内存里、月账很小，所以这一次全扫不值得心疼。
      //
      // 之后只看当天：历史笔落库之后不会再变，唯一的例外是被撤销——
      // 而撤销会翻转原笔的状态，所以 voided 里的那些每拍都要重新看一眼。
      const book = this.points.book;
      const voided = voidedIds(book);
      const backfilling = !this.convexBackfilled;
      for (const entry of book.entries) {
        if (!backfilling && entry.day !== day && !voided.has(entry.id)) continue;
        const payload = toConvexLedgerEntry(entry, voided);
        const key = `ledger:${entry.id}`;
        const fp = fingerprint(payload);
        if (this.convexFingerprints.get(key) === fp) continue;
        this.queueForConvex("ledger", key, payload);
        this.convexFingerprints.set(key, fp);
      }
      // 全账扫完了才置位——中间抛异常的话下一拍还要再全扫一次
      this.convexBackfilled = true;

      // ---- 目标树：整棵一起推 ----
      // `goals:replaceTree` 是**整树替换**，所以绝不能拆成多批——
      // 半批推上去等于把不在这一批里的节点全删了。
      const nodes = toConvexGoalNodes(this.goals.tree);
      const treeFp = fingerprint(nodes);
      if (this.convexFingerprints.get("goals:tree") !== treeFp) {
        this.queueForConvex("goals", "goals:tree", { nodes });
        this.convexFingerprints.set("goals:tree", treeFp);
      }
    } catch (err) {
      // 对账挂了不该影响任何别的东西，但**要说出来**——
      // 一个一声不吭地不同步的系统，正是这一轮要修的毛病
      console.warn("[life-cockpit:convex] 对账失败：", err);
    }
  }


  /** 主动握一次手，给设置页那颗【测一次连接】用。 */
  async probeConvex(): Promise<void> {
    const result = await this.convex.probe();
    new Notice(result.ok ? `Convex：${result.detail}` : `Convex 连不上：${result.detail}`, 8000);
  }

  /** 同步层状态，给设置页那一行用。 */
  convexStatus(): { phase: string; detail: string } {
    return this.convex.getStatus();
  }

  /** 出站队列的一句话。**「一切正常」也要说出来**，否则人不知道它在不在跑。 */
  outboxSummary(): string {
    return describeOutbox(this.outbox, Date.now());
  }

  /**
   * 配对：拿配对码换一个设备令牌。
   *
   * **整个流程只碰这一个方法**——没有 clone、没有 npx、没有命令行。
   * 拿到的令牌直接存进 `data.json`，配对码用完就丢（它不落盘）。
   */
  async pairConvexDevice(code: string, label: string): Promise<void> {
    const url = this.convexConfig().url;
    if (!url) {
      new Notice("先填服务地址。");
      return;
    }
    if (!code) {
      new Notice("配对码是空的。");
      return;
    }
    // convex.cloud 是数据面，HTTP 端点在 convex.site —— 两个域名，别填错
    const site = url.replace(".convex.cloud", ".convex.site").replace(/\/$/, "");

    try {
      const res = await requestUrl({
        url: `${site}/hooks/pair`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, label }),
        // 4xx 不要抛，我们要读它的正文——「码不对」和「没开配对」
        // 对使用者是完全不同的下一步动作
        throw: false,
      });
      const body = res.json as { ok?: boolean; token?: string; error?: string; revokedPrevious?: number };
      if (!body?.ok || !body.token) {
        new Notice(`配对没成：${body?.error ?? `HTTP ${res.status}`}`, 8000);
        return;
      }
      this.settings.convexToken = body.token;
      await this.saveSettings();
      this.applyConvexConfig();
      const tail = body.revokedPrevious ? `，顶掉了 ${body.revokedPrevious} 个同名旧令牌` : "";
      new Notice(
        `配对成功${tail}。现在可以去 Convex Dashboard 把 LIFE_COCKPIT_PAIR_CODE 删掉了。`,
        8000,
      );
    } catch (err) {
      new Notice(`配对没成：${String(err).slice(0, 200)}`, 8000);
    }
  }

  /** 出站队列，给设置页那一行状态和数据台用。 */
  outboxState(): OutboxState {
    return this.outbox;
  }

  /**
   * 推一轮。**整个方法吞掉一切失败**：这一层挂了，番茄也得照跑。
   */
  private async flushConvexOutbox(now: number): Promise<void> {
    if (!this.settings.convexEnabled) return;
    const interval = this.settings.convexSyncSeconds * 1000;
    if (now - this.lastOutboxFlushAt < interval) return;
    this.lastOutboxFlushAt = now;

    try {
      const before = this.outbox;
      const after = await this.convex.flushOnce(before, now);
      if (after === before) return;
      this.outbox = after;
      await this.persistData();
    } catch {
      // 同步层的任何失败都不该冒到这里来；真冒上来了也只是这一拍不推
    }
  }

  private sessionSnapshot(now: number): PersistedSession {
    return createSessionSnapshot({
      now,
      day: this.dayKey(new Date(now)),
      timer: this.timerState,
      taskId: this.pomodoroTaskId,
      goalId: this.pomodoroGoalId,
    });
  }

  /** 现场的指纹。它变了才值得写一次盘——每秒一次的 tick 本身不算变化。 */
  private sessionKey(): string {
    const state = this.timerState;
    return [
      state.status,
      state.kind,
      state.pomodoroIndex,
      state.plannedMs,
      state.task,
      this.pomodoroTaskId ?? "-",
      this.pomodoroGoalId ?? "-",
    ].join("|");
  }

  /**
   * 该存就存。两种情况要写：**指纹变了**（换段、开工、改任务、挂目标），
   * 或者**正在跑而且上次写盘已经是 15 秒前**（为了被强杀时也丢不了多少）。
   */
  private maybePersistSession(now: number): void {
    const changed = this.sessionKey() !== this.lastSessionKey;
    const stale =
      this.timerState.status === "running" && now - this.lastSessionSaveAt >= SESSION_SAVE_MS;
    if (!changed && !stale) return;
    void this.persistData().catch((error) => {
      console.error("人生驾驶舱：现场存不下来", error);
    });
  }

  async saveSettings(): Promise<void> {
    await this.persistData();
    this.today.totals.targetMinutes = this.settings.dailyFocusTargetMinutes;
    this.today.totals.windowHours = this.settings.dailyWindowHours;
    // 强制干扰关掉的那一下要立刻停：改完设置还在闪，人只会以为关不掉。
    if (!this.settings.enforceEnabled) this.alarm?.stop();
    this.applyBackgroundThrottling();
    this.applyFontScale();
    this.refreshUi();
  }

  /**
   * 字号缩放：往 `document.body` 上挂一个 CSS 变量，插件所有面板、遮罩、悬浮框
   * 都是相对它排版的（styles.css 里那一组 `--life-cockpit-scale`）。
   *
   * 挂在 body 而不是各个视图上：遮罩和悬浮层是直接挂在 body 下的，
   * 挂在视图上它们就吃不到。
   */
  private applyFontScale(): void {
    document.body.style.setProperty("--life-cockpit-scale", String(this.settings.uiFontScale));
  }

  private get timerConfig(): TimerConfig {
    return configFromMode(activeModeSetting(this.settings), {
      enabled: this.settings.pomodoroAlternateEnabled,
      ratio: this.settings.pomodoroAlternateRatio,
    });
  }

  /** 设置页和面板共用的一句话：这一档节奏接下来会怎么跑。 */
  describePomodoroRhythm(): string {
    return describeAlternatePlan(activeModeSetting(this.settings), {
      enabled: this.settings.pomodoroAlternateEnabled,
      ratio: this.settings.pomodoroAlternateRatio,
    });
  }

  async switchMode(mode: ModeId): Promise<void> {
    if (!MODE_IDS.includes(mode) || mode === this.settings.activeMode) return;
    this.settings.activeMode = mode;
    // 切模式重排提醒节律：新间隔从此刻起算，主题回到第一条。
    this.reminders = resetReminderState(Date.now());
    this.currentTheme = activeModeSetting(this.settings).themeCycle[0] ?? null;
    await this.saveSettings();

    const label = MODE_LABELS[mode];
    const active = activeModeSetting(this.settings);
    new Notice(
      `切到【${label}】：${active.workMinutes} + ${active.breakMinutes} 分钟，` +
        `每 ${active.reminderIntervalMinutes} 分钟一条主题提醒。`,
    );
  }

  // -------------------------------------------------------------------------
  // 计时器
  // -------------------------------------------------------------------------

  setTask(task: string): void {
    this.dispatch({ type: "set-task", task });
  }

  /**
   * 开工。**这是这台表唯一的人类入口**（AME-239）：
   *
   *   「【暂停】————这是没有任何需要和必要的……也不符合我们的设计哲学。」
   *   「【开工】永远是 人类手动的行为。」
   *
   * 所以它只往一个方向推：没开始就开始，停着就接着跑，正在跑的时候什么都不做。
   * 暂停那一路的入口整个删了——`pause` 还在状态机里，但只有强提醒页拦人时用得到。
   */
  async startOrResume(): Promise<void> {
    const now = Date.now();
    if (this.timerState.status === "idle") this.dispatch({ type: "start", at: now });
    else if (this.timerState.status === "paused") this.dispatch({ type: "resume", at: now });
  }

  /**
   * 结束本段。**结束不等于今天不干了**（AME-258 第 18 条）：
   *
   *   「我发现，在【手动结束一个番茄】之后，不会有后续的【提醒、介入】什么之类的
   *    ————ta 就那么一直停在那儿了？……我的预期是【不管是自然完成还是结束；
   *    强干扰和提示 仍然会照规则存在的。】」
   *
   * 所以这一下走的是和跑满同一条路（见 `timer.ts` 的 `stop`）：工作段结束进休息、
   * 休息段结束进待命。要真的收工走 `closeDay`。
   */
  async stopTimer(): Promise<void> {
    const before = this.timerState;
    this.dispatch({ type: "stop", at: Date.now() });
    // 一秒没跑过的段状态机不动它（那等于把「跳过本段」放回来了），
    // 但人按了按钮就得有回音——什么都不发生最容易被当成插件坏了。
    if (this.timerState === before) {
      new Notice("这一段还没开始跑，没有可结束的。要今天到此为止的话，用命令面板里的「今天收工」。");
    }
  }

  /**
   * 今天收工。**这是唯一一个把整套催促停下来的动作，所以它必须被专门说出口**——
   * 不放在面板的两颗按钮里，只在命令面板里，且要确认一次。
   *
   * 「该开工而没开工就应该永远提示」（AME-239）那条规矩仍然成立：
   * 停的不是规矩，是今天。明天第一次开工，一切照旧。
   */
  async closeDay(): Promise<void> {
    this.dispatch({ type: "close-day", at: Date.now() });
    new Notice("今天收工。番茄停了，催促也停了——明天开工时一切照旧。");
  }

  /** 收工要确认一次。「今天不干了」是个决定，不该被误触。 */
  private confirmCloseDay(): void {
    new ConfirmModal(this.app, {
      title: "今天收工？",
      body:
        "这一段会照实记成未完成，之后不再进休息、不再催你复工——" +
        "今天剩下的强提醒与强制干扰全部停掉。明天第一次开工时一切照旧。",
      confirmText: "收工",
      onConfirm: () => void this.closeDay(),
    }).open();
  }

  private dispatch(action: Parameters<typeof reduce>[2]): void {
    const now = Date.now();
    const result = reduce(this.timerConfig, this.timerState, action);
    const wasBreak = isBreak(this.timerState.kind) && this.timerState.status !== "idle";
    this.timerState = result.state;

    for (const event of result.events) {
      if (event.type === "segment-completed") {
        this.recordSegment(event.segment);
      }
      if (event.type === "segment-started") {
        this.zenDismissedFor = null;
        this.zenForcedFor = null;
        if (isBreak(event.kind)) this.breakPageCursor += 1;
        this.onSegmentStarted(event.kind, wasBreak, now);
      }
      if (event.type === "stopped") {
        this.lastIdleAt = now;
        this.gate = abandonGate(this.gate);
        this.zen?.hide();
      }
    }

    // 番茄真的跑起来了（或者整个停了）= 人已经复工，待命结束、干扰收摊。
    // 放在事件循环之后：onSegmentStarted 刚刚可能才把待命立起来。
    if (this.timerState.status === "running" || this.timerState.status === "idle") {
      this.clearAwaiting();
    }

    this.syncOverlay(now);
    this.syncMusic();
    this.syncHud(now);
    this.maybePersistSession(now);
    this.refreshUi();
  }

  private tick(): void {
    const now = Date.now();
    const date = new Date(now);

    this.rolloverIfNeeded(date);
    this.dispatch({ type: "tick", at: now });
    this.checkRhythm(date);
    this.checkThemeReminder(now);
    this.checkBedtime(date);
    this.checkReadingPush(date);
    this.checkLockCountdown(now);
    // 先对账再推。**对账是上行链路的唯一入口**——0.13.0 那一版指望在各个写盘点
    // 上分别挂钩，结果一个钩子都没接上，队列永远是空的。
    this.reconcileConvex(now);
    // 推一轮出站队列。**吞掉一切失败**——这一层挂了番茄也得照跑。
    void this.flushConvexOutbox(now);
    // 等飞书快照那件事：不阻塞任何东西，等到了弹一条通知（AME-258 第 22.2 条）。
    void this.probeFeishuPull(now);
    // 自动拉一次秒哒（AME-272 补充第 1 条）。**吞掉一切失败**——外网连不上
    // 和番茄跑不跑没有任何关系。
    void this.autoPullMiaoda(now);
    // 先判「人在不在」，再让强提醒页的停留倒计时走一拍——**倒计时只在人真的
    // 看着的时候走**，这是 AME-238 那条 bug 的正面修复。然后才轮到强制干扰。
    this.sampleAttention(now);
    this.advanceGate(now);
    this.stepEnforcement(now);
    this.syncOverlay(now);
    this.syncMusic();
    this.syncHud(now);
    // dispatch 里已经存过一次；这一次收的是绕开 dispatch 的那几条路
    // （强提醒页拦人时的 pause / 过闸之后的 resume）。
    this.maybePersistSession(now);
    this.refreshUi();
  }

  // -------------------------------------------------------------------------
  // 五行节律表
  // -------------------------------------------------------------------------

  private resolveCurrentSegment(date: Date): ResolvedSegment | null {
    return segmentAt(resolveSegments(this.settings.rhythmSegments), minuteOfDay(date));
  }

  private checkRhythm(date: Date): void {
    const next = this.resolveCurrentSegment(date);
    const transition = segmentTransition(this.lastSegment, next);
    if (!transition) return;

    this.lastSegment = next;
    if (!this.settings.rhythmNoticesEnabled) return;

    const text = describeTransition(transition);
    if (!text) return;
    const phase = phaseForDate(date, this.settings);
    const line = `${text}${phase ? `（${phase.label}）` : ""}`;
    new Notice(line);
    // key 带上时段 id：一天里换五次时段就该推五条，不该被同一个 key 的冷却吃掉。
    this.nudge("info", `rhythm:${next?.id ?? "gap"}`, "节律表换段了", line);
  }

  describeCurrentCell(date: Date): string {
    return describeCell(currentCell(date, this.settings));
  }

  private checkThemeReminder(now: number): void {
    const result = tickReminder(activeModeSetting(this.settings), this.reminders, now);
    this.reminders = result.state;
    if (!result.theme) return;
    this.currentTheme = result.theme;
    if (!this.settings.themeNoticesEnabled) return;
    new Notice(result.theme);
    this.nudge("info", "theme", "主题提醒", result.theme);
  }

  // -------------------------------------------------------------------------
  // 禅定模式
  // -------------------------------------------------------------------------

  private segmentKey(): string {
    const state = this.timerState;
    return `${state.kind}-${state.pomodoroIndex}-${state.segmentStartedAt ?? 0}`;
  }

  private currentBreakPage(): BreakPageSetting | null {
    const pages = this.settings.breakPages;
    if (!pages.length) return null;
    return pages[this.breakPageCursor % pages.length];
  }

  /**
   * 谁来盖这块屏幕。**只有一块遮罩，所以优先级必须写死**：
   * 锁屏倒计时 > 复工强提醒页 > 禅定模式。
   * 越不可逆的越靠前——倒计时被别的东西盖住的话，人就没机会按「推迟」了。
   */
  private syncOverlay(now: number): void {
    if (!this.zen) return;
    if (this.lock.countdown) {
      const command = lockCommandFor(currentPlatform(), this.settings.lockMethod);
      this.zen.showLock({
        remainingMs: countdownRemainingMs(this.lock, now),
        totalMs: Math.max(1, this.settings.lockCountdownSeconds) * 1000,
        method: command ? command.label : "锁不动（见设置里的说明）",
        deferMinutes: this.settings.lockDeferMinutes,
      });
      return;
    }
    if (this.gate.open) {
      this.zen.showGate({
        reason: this.gate.open.reason,
        page: pickGatePage(this.settings.gatePages, this.dayKey()),
        remainingMs: gateRemainingMs(this.gate, this.settings, now),
        dwellMs: Math.max(0, this.settings.gateDwellSeconds) * 1000,
        // 飞书那一栏排在推荐读物前面：被拦下来的这几秒，先看「今天答应过要做什么」，
        // 再看「今天读点什么」（AME-258 第 19.1 条的第 1 点）。
        // 0.11.0 起飞书那一栏底下多一段「按目标树分组」（第 22.2 条第 1 点）。
        reading: [this.gateFeishuMarkdown(), this.gateFeishuGoalMarkdown()]
          .filter(Boolean)
          .join("\n"),
        // 推荐读物改成插件自己画的行：遮罩里的内链点了不会有任何反应（第 22.4 条）。
        picks: this.settings.gateShowReading ? this.todayReading() : [],
        allowSkip: this.settings.gateAllowSkip,
        // 倒计时停着的时候必须在这一页上说出来。不说的话，一块不走的表只会被
        // 读成「坏了」——而它恰恰是这一版最重要的行为改动（AME-238）。
        stalled: this.settings.gateRequireAttention && !this.attention.attending,
        attention: describeAttention(this.attention),
      });
      return;
    }
    this.syncZen(now);
  }

  /** 盖不盖这一段是纯判断，规则和理由都在 core/zen.ts。 */
  private syncZen(now: number): void {
    if (!this.zen) return;
    const state = this.timerState;
    const key = this.segmentKey();
    const shouldShow = shouldShowZen({
      zenEnabled: this.settings.zenEnabled,
      zenCoverWork: this.settings.zenCoverWork,
      kind: state.kind,
      status: state.status,
      forced: this.zenForcedFor === key,
      dismissed: this.zenDismissedFor === key,
    });

    if (!shouldShow) {
      if (this.zen.isVisible) this.zen.hide();
      return;
    }

    this.zen.show({
      kind: state.kind,
      remainingMs: remainingMs(state, now),
      plannedMs: state.plannedMs,
      task: state.task,
      theme: this.currentTheme,
      pomodoroIndex: state.pomodoroIndex,
      goal: this.goals.find(this.pomodoroGoalId)?.title ?? null,
      breakPage: isBreak(state.kind) ? this.currentBreakPage() : null,
      paused: state.status === "paused",
      lockOff: !this.settings.lockEnabled,
    });
  }

  private dismissZen(): void {
    this.zenDismissedFor = this.segmentKey();
    this.zen?.hide();
  }

  toggleZen(): void {
    if (!this.zen) return;
    if (this.zen.isVisible) {
      this.dismissZen();
      return;
    }
    if (this.timerState.status === "idle") {
      new Notice("先开始一个番茄，禅定遮罩才有东西可盖。");
      return;
    }
    this.zenDismissedFor = null;
    // 手动叫出来的这一次，工作段也认——这是明确要求，不是默认行为。
    this.zenForcedFor = this.segmentKey();
    this.syncOverlay(Date.now());
  }

  // -------------------------------------------------------------------------
  // 流水
  // -------------------------------------------------------------------------

  private ledgerPath(date: string): string {
    const folder = this.settings.ledgerFolder.replace(/^\/+|\/+$/g, "");
    return folder ? `${folder}/${date}.json` : `${date}.json`;
  }

  private async loadToday(): Promise<void> {
    const key = dayKeyFor(new Date(), this.settings.dayRolloverHour);
    const path = this.ledgerPath(key);
    const text = await this.readPath(path);

    if (text !== null) {
      const parsed = parseDayLedger(text);
      if (parsed) {
        this.today = parsed;
        this.today.totals.targetMinutes = this.settings.dailyFocusTargetMinutes;
        this.today.totals.windowHours = this.settings.dailyWindowHours;
        return;
      }
      // 文件读坏了就在内存里重开一份，但不覆盖磁盘——留着让人自己看。
      new Notice(`番茄流水读不动，今天先在内存里重开：${path}`);
    }

    this.today = createDayLedger(key, {
      targetMinutes: this.settings.dailyFocusTargetMinutes,
      windowHours: this.settings.dailyWindowHours,
      generator: GENERATOR,
    });
  }

  private rolloverIfNeeded(date: Date): void {
    const key = dayKeyFor(date, this.settings.dayRolloverHour);
    if (key === this.today.date) return;
    this.timerState = resetDayCounter(this.timerState);
    // 「今天豁免锁屏」到此为止：豁免是今天的事，不是永久开关。
    this.lock = rolloverLock(this.lock, key);
    this.queueWrite(async () => {
      await this.loadToday();
      // 换天要重挑快照：昨天那份不该继续顶着「今天」的名义显示（AME-258）。
      await this.loadFeishu();
      await this.loadReadingMaterial();
    });
  }

  private recordSegment(segment: CompletedSegment): void {
    // 0 秒的段不记账：切模式或误触会产生一堆没意义的空行。
    if (segment.actualMs < 1000) return;

    const startedAt = new Date(segment.startedAt);
    const cell = currentCell(startedAt, this.settings);
    const sessionId = makeSessionId(segment.kind, segment.pomodoroIndex, segment.startedAt);
    const record: SessionRecord = {
      id: sessionId,
      kind: segment.kind,
      startedAt: formatLocalIso(startedAt),
      endedAt: formatLocalIso(new Date(segment.endedAt)),
      plannedSeconds: Math.round(segment.plannedMs / 1000),
      actualSeconds: Math.round(segment.actualMs / 1000),
      completed: segment.completed,
      task: segment.task,
      mode: this.settings.activeMode,
      pomodoroIndex: segment.pomodoroIndex,
      phase: cell.phase ? cell.phase.label : null,
      segment: cell.segment ? cell.segment.label : null,
      // 由 R2 在落盘时按账本回填，这里不猜。
      points: null,
      pointsRule: null,
      goalId: this.settings.goalsEnabled ? this.pomodoroGoalId : null,
    };

    this.today = upsertSession(this.today, record);
    // 落盘时把当下这份快照钉住：恰好在换天那一 tick 完成的段，
    // 排在它前面的 loadToday 会把 this.today 换成新的一天，
    // 到时候再读 this.today 就会把这条流水写丢。
    const snapshot = this.today;
    this.queueWrite(async () => {
      await this.persist(snapshot);
      // 入账排在流水落盘之后：账本要指回一条已经存在的番茄段。
      await this.awardPomodoro(segment, sessionId);
    });

    if (segment.kind === "work" && segment.completed) {
      const progress = focusProgress(this.today);
      const line =
        `第 ${segment.pomodoroIndex} 个番茄完成 · ` +
        `今日 ${Math.floor(progress.minutes)}/${progress.targetMinutes} 分钟`;
      new Notice(line);
      this.nudge("info", "pomodoro-done", "番茄跑满了", line);
    }
  }

  private async awardPomodoro(segment: CompletedSegment, sessionId: string): Promise<void> {
    if (segment.kind !== "work" || !segment.completed) return;
    if (!this.settings.pointsEnabled) return;

    const entry = await this.points.awardPomodoro({
      sessionId,
      endedAt: new Date(segment.endedAt),
      taskId: this.pomodoroTaskId,
      goalId: this.settings.goalsEnabled ? this.pomodoroGoalId : null,
      fallbackReason: segment.task,
    });
    if (!entry) return;

    const goal = this.goals.find(this.pomodoroGoalId);
    new Notice(
      `积分 +${formatPoints(entry.amount)} · 余额 ${formatPoints(this.balance)}` +
        (goal ? ` · 推进「${goal.title}」` : ""),
    );
    this.refreshUi();
  }

  private queueWrite(task: () => Promise<void>): void {
    void this.queued(task).catch(() => undefined);
  }

  /** 和 queueWrite 排同一条队，但把结果交回给调用方。 */
  private queued<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(task);
    this.writeQueue = run.then(
      () => undefined,
      (error) => {
        console.error("人生驾驶舱：写入失败", error);
        new Notice(failureNotice(error, "写入失败，详情见开发者控制台。"));
      },
    );
    return run;
  }

  /** 日档 JSON 的每一次写入都要过 applyMirror，否则会把账本镜像盖掉。 */
  private async persist(day: DayLedger): Promise<void> {
    await this.writeIfChanged(
      this.ledgerPath(day.date),
      serializeDayLedger(this.points.applyMirror(day)),
    );
  }

  /** 照抄 RefBake 的 writeIfChanged：内容没变就不写，别给 Easy-Git 制造空 commit。 */
  private async writeIfChanged(path: string, content: string): Promise<boolean> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      const current = await this.app.vault.read(existing);
      if (!shouldWrite(current, content)) return false;
      await this.app.vault.modify(existing, content);
      return true;
    }
    // 索引里没有，不代表盘上没有（见 readPath）。这时候 vault.create 会直接报
    // 「File already exists」，所以照旧走适配器改写，别把人写的东西丢在半路。
    const onDisk = await this.readPath(path);
    if (onDisk !== null) {
      if (!shouldWrite(onDisk, content)) return false;
      await this.app.vault.adapter.write(path, content);
      return true;
    }
    await this.ensureParentFolder(path);
    await this.app.vault.create(path, content);
    return true;
  }

  private async ensureParentFolder(path: string): Promise<void> {
    const parts = path.split("/").filter(Boolean).slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFile) {
        throw new Error(`人生驾驶舱：无法创建目录「${current}」，同名文件已存在`);
      }
      if (!(existing instanceof TFolder)) await this.app.vault.createFolder(current);
    }
  }

  // -------------------------------------------------------------------------
  // 积分账本
  // -------------------------------------------------------------------------

  private vaultIo(): VaultIo {
    return {
      read: (path) => this.readPath(path),
      writeIfChanged: (path, content) => this.writeIfChanged(path, content),
      // 两个 list 口都是「索引里一条都没有就问一次盘」：目录没进索引会返回 null，
      // 但 vault 根目录例外——它永远在，冷启动时只是 children 还空着（见 readPath）。
      listMarkdown: async (folder) => {
        const names = (this.folderAt(folder)?.children ?? [])
          .filter((child): child is TFile => child instanceof TFile && child.extension === "md")
          .map((file) => file.name);
        if (names.length) return names;
        const listed = await this.listOnDisk(folder);
        return listed.files.map(baseName).filter((name) => name.endsWith(".md"));
      },
      listFolders: async (folder) => {
        const names = (this.folderAt(folder)?.children ?? [])
          .filter((child): child is TFolder => child instanceof TFolder)
          .map((child) => child.name);
        if (names.length) return names;
        const listed = await this.listOnDisk(folder);
        return listed.folders.map(baseName);
      },
      // 走 trashFile 而不是 delete：删到哪儿由 Obsidian 的「已删除文件」设置说了算。
      // 候选区这条路上删原件之前归档已经落盘了，所以这里删不掉也丢不了东西。
      remove: async (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return false;
        await this.app.fileManager.trashFile(file);
        return true;
      },
    };
  }

  /**
   * 目录下的 `.json` 文件名。`listMarkdown` 那一路的同款兜底：先问索引，
   * 索引里一条都没有再问一次盘（`.json` 不是笔记，冷启动时更容易还没进索引）。
   */
  private async listJson(folder: string): Promise<string[]> {
    const names = (this.folderAt(folder)?.children ?? [])
      .filter((child): child is TFile => child instanceof TFile && child.extension === "json")
      .map((file) => file.name);
    if (names.length) return names;
    const listed = await this.listOnDisk(folder).catch(() => ({ files: [], folders: [] }));
    return listed.files.map(baseName).filter((name) => name.endsWith(".json"));
  }

  /**
   * 读一份笔记，文件不在返回 null。
   *
   * 索引里查不到不等于盘上没有：冷启动那一小会儿 getAbstractFileByPath 会对着真实
   * 存在的文件返回 null（AME-227）。所以查不到就再问一次适配器——它直接问文件系统，
   * 不看索引。这一层是兜底，正常时序下永远走不到。
   */
  private async readPath(path: string): Promise<string | null> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) return await this.app.vault.read(file);
    if (!path.trim()) return null;
    const normalized = normalizePath(path);
    const stat = await this.app.vault.adapter.stat(normalized);
    if (stat?.type !== "file") return null;
    console.warn(`人生驾驶舱：${normalized} 还没进 vault 索引，这次直接从盘上读。`);
    return await this.app.vault.adapter.read(normalized);
  }

  /** 索引里列不出东西时的兜底列目录。适配器给的 files / folders 都是全路径。 */
  private async listOnDisk(folder: string): Promise<ListedFiles> {
    const normalized = normalizePath(folder);
    const stat = await this.app.vault.adapter.stat(normalized);
    if (stat?.type !== "folder") return { files: [], folders: [] };
    return await this.app.vault.adapter.list(normalized);
  }

  private folderAt(folder: string): TFolder | null {
    const target = folder ? this.app.vault.getAbstractFileByPath(folder) : this.app.vault.getRoot();
    return target instanceof TFolder ? target : null;
  }

  get balance(): number {
    return currentBalance(this.points.book);
  }

  private async loadPoints(): Promise<void> {
    try {
      await this.points.load();
    } catch (error) {
      console.error("人生驾驶舱：积分账本读取失败", error);
      new Notice(failureNotice(error, "积分账本读取失败，详情见开发者控制台。"));
    }
  }

  async reloadPoints(): Promise<void> {
    await this.loadPoints();
    this.refreshUi();
    new Notice(`积分账本已重读 · 余额 ${formatPoints(this.balance)}`);
  }

  async recordPoints(input: {
    direction: PointsDirection;
    amount: number;
    reason: string;
    taskId: string | null;
    goalId?: string | null;
  }): Promise<PointsEntry | null> {
    try {
      const entry = await this.queued(() => this.points.record(input));
      const sign = entry.direction === "earn" ? "+" : "-";
      new Notice(
        `${sign}${formatPoints(entry.amount)} · ${entry.reason} · 余额 ${formatPoints(this.balance)}`,
      );
      this.refreshUi();
      return entry;
    } catch (error) {
      console.error("人生驾驶舱：记账失败", error);
      new Notice(failureNotice(error, "记账失败，详情见开发者控制台。"));
      return null;
    }
  }

  /** 撤销一笔。撤销本身留痕，不做静默删除。 */
  async reversePoints(entryId: string, note?: string): Promise<boolean> {
    try {
      const result = await this.queued(() => this.points.reverse(entryId, note));
      if (!result.ok) {
        new Notice(result.reason);
        return false;
      }
      new Notice(`已撤销 · 余额 ${formatPoints(this.balance)}`);
      this.refreshUi();
      return true;
    } catch (error) {
      console.error("人生驾驶舱：撤销失败", error);
      new Notice(failureNotice(error, "撤销失败，详情见开发者控制台。"));
      return false;
    }
  }

  /** 撤销最近一笔还有效的流水。手滑记错了当场按一下就行。 */
  async reverseLatest(): Promise<void> {
    const book = this.points.book;
    const voided = new Set<string>();
    for (const entry of book.entries) {
      if (entry.source === "reversal" && entry.ref) voided.add(entry.ref);
    }
    const target = [...book.entries]
      .reverse()
      .find((entry) => entry.source !== "reversal" && !voided.has(entry.id));
    if (!target) {
      new Notice("账上没有可撤销的流水。");
      return;
    }
    await this.reversePoints(target.id);
  }

  openRecordPoints(direction: PointsDirection = "earn"): void {
    if (!this.settings.pointsEnabled) {
      new Notice("积分账本已在设置里关掉了。");
      return;
    }
    new RecordPointsModal(this.app, this, direction).open();
  }

  openPointsLedger(): void {
    new PointsLedgerModal(this.app, this).open();
  }

  /** 任务表笔记不在就建一份默认的。分值与任务项之后直接在 vault 里改。 */
  async ensureTaskNote(): Promise<void> {
    try {
      const written = await this.queued(() => this.points.writeTaskNote());
      await this.points.loadTasks();
      this.refreshUi();
      new Notice(
        written
          ? `积分任务表已写入：${this.settings.pointsTaskNote}`
          : "积分任务表已经是最新的，没有改动。",
      );
    } catch (error) {
      console.error("人生驾驶舱：写积分任务表失败", error);
      new Notice(failureNotice(error, "写积分任务表失败，详情见开发者控制台。"));
    }
  }

  // -------------------------------------------------------------------------
  // 目标树
  // -------------------------------------------------------------------------

  private async loadGoals(): Promise<void> {
    try {
      await this.goals.load();
    } catch (error) {
      console.error("人生驾驶舱：目标树读取失败", error);
      new Notice(failureNotice(error, "目标树读取失败，详情见开发者控制台。"));
    }
    this.pruneGoalSelection();
  }

  async reloadGoals(): Promise<void> {
    await this.loadGoals();
    this.refreshUi();
    new Notice(`目标树已重读 · 总进度 ${formatGoalProgress(this.goals.overall)}`);
  }

  /**
   * 挂着的那个目标被删了 / 被做完了，选择就跟着放掉，别让面板显示的和实际记的对不上。
   *
   * **树根本没读到的时候不动它**（`hasNote`）：和 `pruneTaskSelection` 同一个理由——
   * 冷启动读成空树（AME-227）时放掉选择，等于替人把他挂好的目标永久删掉（AME-244 起它落盘）。
   */
  private pruneGoalSelection(): void {
    if (!this.pomodoroGoalId || !this.goals.hasNote) return;
    const node = this.goals.find(this.pomodoroGoalId);
    if (!node || !this.canAttachGoal(node)) this.pomodoroGoalId = null;
  }

  canAttachGoal(node: GoalNode): boolean {
    return this.goals.attachableGoals().some((item) => item.id === node.id);
  }

  setPomodoroGoal(goalId: string | null): void {
    this.pomodoroGoalId = goalId;
    const node = this.goals.find(goalId);
    // 没给番茄写任务名就借目标的标题：流水里那一栏空着最难复盘。
    if (node && !this.timerState.task.trim()) this.setTask(node.title);
    new Notice(node ? `番茄挂到「${node.title}」` : "番茄不挂目标了。");
    // 挂在哪个目标上是要**跨重启活下来**的（AME-244），所以挑完当场落盘。
    this.maybePersistSession(Date.now());
    this.refreshUi();
  }

  /** 番茄挂哪个预设任务。面板那个下拉和重启之后的恢复走的都是这一条路。 */
  setPomodoroTask(taskId: string | null): void {
    if (this.pomodoroTaskId === taskId) return;
    this.pomodoroTaskId = taskId;
    this.maybePersistSession(Date.now());
  }

  async createGoal(
    parentId: string | null,
    input: Partial<GoalInput> & { title: string },
  ): Promise<GoalNode | null> {
    try {
      const node = await this.queued(() => this.goals.create(parentId, input));
      this.refreshUi();
      return node;
    } catch (error) {
      console.error("人生驾驶舱：新建目标失败", error);
      new Notice(failureNotice(error, "新建目标失败，详情见开发者控制台。"));
      return null;
    }
  }

  async updateGoal(id: string, patch: Partial<GoalInput>): Promise<boolean> {
    try {
      await this.queued(() => this.goals.update(id, patch));
      this.pruneGoalSelection();
      this.refreshUi();
      return true;
    } catch (error) {
      console.error("人生驾驶舱：改目标失败", error);
      new Notice(failureNotice(error, "改目标失败，详情见开发者控制台。"));
      return false;
    }
  }

  async moveGoal(id: string, delta: number): Promise<void> {
    try {
      await this.queued(() => this.goals.move(id, delta));
      this.refreshUi();
    } catch (error) {
      console.error("人生驾驶舱：挪目标失败", error);
      new Notice(failureNotice(error, "挪目标失败，详情见开发者控制台。"));
    }
  }

  async removeGoal(id: string): Promise<void> {
    try {
      await this.queued(() => this.goals.remove(id));
      this.pruneGoalSelection();
      this.refreshUi();
    } catch (error) {
      console.error("人生驾驶舱：删目标失败", error);
      new Notice(failureNotice(error, "删目标失败，详情见开发者控制台。"));
    }
  }

  /** 拆分建议落到树上。建议本身在窗里，人确认过才走到这里。 */
  async applyBreakdown(parentId: string, drafts: GoalDraft[]): Promise<GoalNode[] | null> {
    try {
      const created = await this.queued(() => this.goals.applyBreakdown(parentId, drafts));
      this.refreshUi();
      new Notice(`落了 ${created.length} 个子目标。`);
      return created;
    } catch (error) {
      console.error("人生驾驶舱：拆分落盘失败", error);
      new Notice(failureNotice(error, "拆分落盘失败，详情见开发者控制台。"));
      return null;
    }
  }

  /** 目标树笔记不在就写一份六层骨架；已经有内容就只重写一遍。 */
  async ensureGoalNote(): Promise<void> {
    try {
      const written = await this.queued(() => this.goals.writeSkeleton());
      this.refreshUi();
      new Notice(
        written
          ? `目标树已写入：${this.settings.goalTreeNote}`
          : "目标树已经是最新的，没有改动。",
      );
    } catch (error) {
      console.error("人生驾驶舱：写目标树失败", error);
      new Notice(failureNotice(error, "写目标树失败，详情见开发者控制台。"));
    }
  }

  async openGoalNote(): Promise<void> {
    const path = this.settings.goalTreeNote.trim();
    const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
    if (!(file instanceof TFile)) {
      new Notice(`目标树笔记还不在：${path || "（没配路径）"}`);
      return;
    }
    await this.app.workspace.getLeaf(true).openFile(file);
  }

  // -------------------------------------------------------------------------
  // 夜班候选区
  // -------------------------------------------------------------------------

  private async loadCandidates(): Promise<void> {
    if (!this.settings.candidatesEnabled) return;
    try {
      await this.candidates.load();
    } catch (error) {
      console.error("人生驾驶舱：候选区读取失败", error);
      new Notice(failureNotice(error, "候选区读取失败，详情见开发者控制台。"));
    }
  }

  async reloadCandidates(): Promise<void> {
    await this.loadCandidates();
    this.refreshUi();
    new Notice(`候选区已重读 · ${this.candidates.pending.length} 条待拍板`);
  }

  /**
   * 拍板。三个动作走同一条落盘队列，和番茄、记账排在一起——
   * 采纳会同时动候选项、主干笔记、目标树 / 账本，谁都不能和别人抢着写。
   */
  async decideCandidate(
    path: string,
    mode: DecideMode,
    input: { target?: string; reason?: string; body?: string },
  ): Promise<boolean> {
    try {
      const result = await this.queued(() => {
        if (mode === "adopt") return this.candidates.adopt(path, { target: input.target });
        if (mode === "reject") return this.candidates.reject(path, { reason: input.reason ?? "" });
        return this.candidates.rewrite(path, { body: input.body ?? "" });
      });
      new Notice(result.message);
      this.refreshUi();
      return result.ok;
    } catch (error) {
      console.error("人生驾驶舱：拍板失败", error);
      new Notice(failureNotice(error, "拍板失败，详情见开发者控制台。"));
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // 睡前复盘
  // -------------------------------------------------------------------------

  /** 到点提醒一次。只提醒，不代人发起——复盘是人要坐下来做的事。 */
  private checkBedtime(date: Date): void {
    if (!this.settings.reviewEnabled || !this.settings.reviewReminderEnabled) return;

    const result = tickBedtime(this.bedtime, {
      day: dayKeyFor(date, this.settings.dayRolloverHour),
      minute: minuteOfDay(date),
      atMinute: this.bedtimeMinute,
      rolloverHour: this.settings.dayRolloverHour,
    });
    this.bedtime = result.state;
    if (!result.due) return;

    const line =
      `${this.settings.reviewReminderAt} 了，睡前复盘：` +
      "跑一次「睡前复盘」，草稿会落到夜班候选区等你拍板。";
    new Notice(line);
    // 睡前提醒是 nudge 不是 info：它推的是一件今天还没做完的事，不是一条状态播报。
    this.nudge("nudge", "bedtime", "该收口了", line);
    // 提醒的同时把素材包写出来。见 `writeReviewMaterial` 里为什么。
    void this.writeReviewMaterial("bedtime");
  }

  /**
   * 只取数、只写素材包，**不出草稿、不投候选区**（AME-258 第 19.2 条）。
   *
   * 这是那条「夜班连着几天报『没有素材包』」的正面修复。原来的链条是：
   * 人手动发起复盘 → 插件写素材包 → 23:30 的夜班读它 → 出 AI 草稿投候选区。
   * 第一环挂在人今晚记不记得点一下，于是后面三环全部空转。
   *
   * 现在到点自己落一份。**只落这一个 JSON**——出草稿是判断、投候选区是交班，
   * 那两件事仍然由人（或夜班）发起，插件不替人做决定。
   */
  async writeReviewMaterial(reason: "bedtime" | "manual"): Promise<string | null> {
    if (!this.settings.reviewEnabled) return null;
    if (reason === "bedtime" && !this.settings.reviewMaterialAutoWrite) return null;

    const day = this.today.date || this.dayKey();
    if (reason === "bedtime" && this.materialWrittenFor === day) return null;
    try {
      // 取数之前先把三处读新：账本和目标树可能在别处被人改过。
      await this.loadPoints();
      await this.loadGoals();
      await this.loadCandidates();
      await this.loadFeishu();
      const result = await this.queued(() => this.review.writeMaterial(day));
      this.materialWrittenFor = day;
      await this.loadReadingMaterial();
      if (reason === "manual") new Notice(`复盘素材包已落盘：${result.path}`);
      return result.path;
    } catch (error) {
      console.error("人生驾驶舱：写复盘素材包失败", error);
      if (reason === "manual") new Notice(failureNotice(error, "写复盘素材包失败。"));
      return null;
    }
  }

  private get bedtimeMinute(): number {
    return parseClock(this.settings.reviewReminderAt) ?? 22 * 60;
  }

  /**
   * 发起一轮复盘：取数 → 落素材包 → 出草稿 → 投候选区。
   *
   * 草稿默认是**兜底**那一版（确定性，不需要模型）。AI 那一侧读素材包 JSON、
   * 交回一份 ReviewDraft 就能顶掉它——插件这边一个字都不用改。
   */
  async runReview(): Promise<ReviewRun | null> {
    if (!this.settings.reviewEnabled) {
      new Notice("睡前复盘已在设置里关掉了。");
      return null;
    }
    if (!this.settings.candidatesEnabled) {
      new Notice("复盘的回写走候选区，先在设置里打开「夜班候选区」。");
      return null;
    }

    const day = this.today.date || dayKeyFor(new Date(), this.settings.dayRolloverHour);
    try {
      // 取数之前先把三处读新：账本和目标树可能在别处被人改过。
      await this.loadPoints();
      await this.loadGoals();
      await this.loadCandidates();
      await this.loadFeishu();
      const run = await this.queued(() =>
        this.review.run(day, { draftFrom: (material) => this.aiReviewDraft(material) }),
      );
      // 投完再扫一遍候选区，拍板面立刻能看见这几条。
      await this.loadCandidates();
      // 刚落的素材包就是明天推荐读物要读的那一份，顺手换新。
      await this.loadReadingMaterial();
      this.bedtime = markBedtimeFired(day);
      this.refreshUi();
      new Notice(run.message);
      await this.openCandidates();
      return run;
    } catch (error) {
      console.error("人生驾驶舱：睡前复盘失败", error);
      new Notice(failureNotice(error, "睡前复盘失败，详情见开发者控制台。"));
      return null;
    }
  }

  /**
   * 让模型出这一版草稿（AME-258 第 20 条）。**出不来就返回 null 并明说为什么**——
   * 静默退回兜底草稿是最坏的一种：第二天看到的是一份「看起来正常但没有洞见」的复盘，
   * 没人会去查模型是不是根本没跑（S1 那条教训，这里照抄）。
   */
  private async aiReviewDraft(material: ReviewMaterial): Promise<ReviewDraft | null> {
    if (!this.settings.aiEnabled || !this.settings.aiReviewDraft) return null;
    const status = this.ai.status();
    if (status.state !== "ready") {
      new Notice(`复盘草稿走兜底：${status.detail}`);
      return null;
    }

    new Notice(`正在让 ${status.profile?.label ?? "模型"} 出复盘草稿……`);
    const reply = await this.ai.chat(buildReviewMessages(material), {
      jsonOnly: true,
      purpose: "睡前复盘草稿",
    });
    if (!reply.ok) {
      new Notice(`模型没出草稿，用兜底那一版：${reply.detail}`);
      return null;
    }
    const draft = parseAiReviewDraft(reply.content, material);
    if (!draft) {
      new Notice("模型回了东西，但读不出草稿 JSON，用兜底那一版。原文见开发者控制台。");
      console.warn("人生驾驶舱：AI 复盘草稿解析失败，原文如下\n", reply.content);
      return null;
    }
    // 署名写清楚是哪个模型出的：候选区里人一眼要能分出「这是 AI 写的还是兜底算的」。
    return { ...draft, author: `ai:${reply.model || status.profile?.model || "未知模型"}` };
  }

  /** 打开当天的素材包。AI 那一侧读的是同一个文件，人也该看得见它。 */
  async openReviewMaterial(): Promise<void> {
    const day = this.today.date || dayKeyFor(new Date(), this.settings.dayRolloverHour);
    const path = this.review.materialPath(day);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`今天的复盘素材还没生成：${path}。先跑一次「睡前复盘」。`);
      return;
    }
    await this.app.workspace.getLeaf(true).openFile(file);
  }

  async openCandidateFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`这份候选项已经不在了：${path}`);
      return;
    }
    await this.app.workspace.getLeaf(true).openFile(file);
  }

  /**
   * 打开一条推荐读物。**推荐必须点得开**，点不开就说清楚是哪一条路径断了。
   *
   * 强提醒页上按的那一下走的也是这里。那时候笔记会在**遮罩后面**打开——
   * 闸门不能因为点了篇文章就放行——所以必须弹一条回执说清楚：
   * 「开了，在遮罩后面，开工之后就在眼前」。没有这条回执，人看到的就是
   * 「点了一下，什么都没发生」（AME-258 第 22.4 条的原话）。
   */
  async openReadingPick(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`这一条推荐指到的文件不在了：${path}`);
      return;
    }
    await this.app.workspace.getLeaf(true).openFile(file);
    if (this.zen?.currentMode === "gate") {
      new Notice(`已经打开《${file.basename}》，就在这一页后面——按【看完了，开工】就看得到。`);
    }
  }

  /**
   * 遮罩上那些链接。**框架不接，插件自己接**（AME-258 第 22.4 条）：
   * 遮罩挂在 `document.body` 上、在 workspace 之外，Obsidian 的内链点击处理
   * 够不着它，于是休息页与强提醒页正文里的每一条 `[[链接]]` 都是死的。
   */
  async openOverlayLink(href: string, sourcePath: string, external: boolean): Promise<void> {
    if (external) {
      const ok = await openExternal(href);
      if (!ok) new Notice(`打不开：${href}`);
      return;
    }
    // openLinkText 自己会解析 `笔记名#标题^块` 这一整套写法，不要在这儿重造一遍。
    await this.app.workspace.openLinkText(href, sourcePath, true);
    if (this.zen?.isVisible) {
      new Notice(`已经在这一页后面打开了「${href}」。`);
    }
  }

  /** 今天有几个番茄挂在这个目标上。面板拿它回答「这一支到底动了没有」。 */
  pomodorosForGoal(goalId: string): number {
    return this.today.sessions.filter(
      (session) => session.kind === "work" && session.completed && session.goalId === goalId,
    ).length;
  }

  // -------------------------------------------------------------------------
  // 推动器（R6）
  // -------------------------------------------------------------------------

  private dayKey(date: Date = new Date()): string {
    return dayKeyFor(date, this.settings.dayRolloverHour);
  }

  /**
   * 推一条。**所有对外说话都从这一个口子走**，分级、静音、免打扰、冷却、配额
   * 全在 PushHub 里判；这里只管把事情说清楚。
   */
  private nudge(level: NudgeLevel, key: string, title: string, body: string): void {
    if (!this.settings.nudgeEnabled) return;
    const message: NudgeMessage = { key, level, title, body };
    void this.push
      .push(message, { day: this.dayKey(), at: new Date() })
      .catch((error) => console.error("人生驾驶舱：推送失败", error));
  }

  /** 设置页上那颗「测一次」。通没通当场看得见，不用等到睡前复盘那一刻才发现没配对。 */
  async testAi(): Promise<string> {
    const notice = new Notice("正在问模型……", 0);
    try {
      const message = await this.ai.test();
      new Notice(message);
      return message;
    } finally {
      notice.hide();
    }
  }

  /** 设置页与面板共用的一句话：AI 接口现在什么状态。 */
  describeAiStatus(): string {
    return describeAi(this.settings, aiEnv());
  }

  // -------------------------------------------------------------------------
  // AI 调用留痕（AME-258 第 22.1 条）
  //
  // 「目前 Flash 的执行——其实我看不到【请求和返回】，这样，如果出现了错误或者偏离；
  //  我是意识不到的？」
  //
  // 落点是**插件自己的目录**（`.obsidian/plugins/life-cockpit/ai-log/`），和 data.json
  // 同级，**不在 2A-META 仓库内**。请求正文里带着当天的番茄、目标和飞书条目，
  // 那是私事；运行区是公开仓库，往那儿写等于把它公开出去。
  // -------------------------------------------------------------------------

  /** 日志目录。插件目录拿不到（理论上不会）就返回空串，留痕整个跳过而不是猜路径。 */
  private aiLogDir(): string {
    return this.manifest.dir ?? "";
  }

  private aiLogFile(day: string): string {
    const dir = this.aiLogDir();
    return dir ? normalizePath(aiLogPath(dir, day)) : "";
  }

  /**
   * 记一条。**写盘失败只警告，绝不往上抛**——留痕挂了是小事，
   * 把正在跑的复盘一起带走是大事。
   */
  private async recordAiCall(entry: AiLogEntry): Promise<void> {
    const day = entry.at.slice(0, 10);
    try {
      if (day !== this.aiLogDay) {
        this.aiLog = await this.readAiLogDay(day);
        this.aiLogDay = day;
      }
      this.aiLog = appendAiLogEntry(this.aiLog, entry);
      const path = this.aiLogFile(day);
      if (!path) return;
      await this.ensureAdapterFolder(path);
      await this.app.vault.adapter.write(path, serializeAiLog(this.aiLog));
    } catch (error) {
      console.error("人生驾驶舱：AI 留痕写盘失败", error);
    }
    this.refreshUi();
  }

  private async readAiLogDay(day: string): Promise<AiLogEntry[]> {
    const path = this.aiLogFile(day);
    if (!path) return [];
    try {
      if (!(await this.app.vault.adapter.exists(path))) return [];
      return parseAiLog(await this.app.vault.adapter.read(path));
    } catch (error) {
      console.error("人生驾驶舱：AI 留痕读盘失败", error);
      return [];
    }
  }

  /** 设置页与详情窗读的都是它：今天的那几条，新的在前。 */
  async aiLogToday(): Promise<AiLogEntry[]> {
    const day = new Date().toISOString().slice(0, 10);
    if (day === this.aiLogDay) return this.aiLog;
    this.aiLog = await this.readAiLogDay(day);
    this.aiLogDay = day;
    return this.aiLog;
  }

  /** 最近几天的全部记录，新的在前。详情窗默认展示它。 */
  async aiLogRecent(): Promise<AiLogEntry[]> {
    const days = await this.aiLogDays();
    const wanted = days.slice(-Math.max(1, this.settings.aiLogKeepDays));
    const all: AiLogEntry[] = [];
    for (const day of wanted.reverse()) all.push(...(await this.readAiLogDay(day)));
    return all;
  }

  private async aiLogDays(): Promise<string[]> {
    const dir = this.aiLogDir();
    if (!dir) return [];
    const folder = normalizePath(`${dir}/${AI_LOG_DIR}`);
    try {
      if (!(await this.app.vault.adapter.exists(folder))) return [];
      const listed = await this.app.vault.adapter.list(folder);
      return listed.files
        .map((path) => aiLogDayOf(baseName(path)))
        .filter((day) => day !== "")
        .sort();
    } catch (error) {
      console.error("人生驾驶舱：AI 留痕列目录失败", error);
      return [];
    }
  }

  /** 过期的整份删。载入时跑一次就够——一天最多多留一份，没必要每次调用都扫目录。 */
  private async pruneAiLog(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const expired = expiredAiLogDays(await this.aiLogDays(), today, this.settings.aiLogKeepDays);
    for (const day of expired) {
      const path = this.aiLogFile(day);
      if (!path) continue;
      try {
        await this.app.vault.adapter.remove(path);
      } catch (error) {
        console.error(`人生驾驶舱：删不掉过期的 AI 留痕 ${path}`, error);
      }
    }
  }

  /** 全清。设置页那颗按钮走它——留痕是给自己看的，想清就该能一次清干净。 */
  async clearAiLog(): Promise<number> {
    const days = await this.aiLogDays();
    let removed = 0;
    for (const day of days) {
      const path = this.aiLogFile(day);
      if (!path) continue;
      try {
        await this.app.vault.adapter.remove(path);
        removed += 1;
      } catch (error) {
        console.error(`人生驾驶舱：删不掉 ${path}`, error);
      }
    }
    this.aiLog = [];
    this.aiLogDay = "";
    new Notice(removed ? `清掉了 ${removed} 天的 AI 调用记录。` : "本来就没有记录。");
    return removed;
  }

  /**
   * 适配器路径的建目录。**不能复用 `ensureParentFolder`**：那一个走 vault API，
   * 而 `.obsidian/` 底下的东西根本不在 vault 索引里。
   */
  private async ensureAdapterFolder(path: string): Promise<void> {
    const folder = path.split("/").slice(0, -1).join("/");
    if (!folder) return;
    if (await this.app.vault.adapter.exists(folder)) return;
    await this.app.vault.adapter.mkdir(folder);
  }

  /** 手动试推一条。设置面板上那颗按钮按下去走的就是它——配没配对，当场看得见。 */
  async testPush(): Promise<void> {
    const outcome = await this.push.push(
      {
        key: "test",
        level: "nudge",
        title: "人生驾驶舱试推",
        body: `${this.describeCurrentCell(new Date())} · 这条是手动试推的。`,
      },
      { day: this.dayKey(), at: new Date() },
    );
    new Notice(outcome.message);
    this.refreshUi();
  }

  async toggleMute(): Promise<void> {
    this.settings.nudgeMuted = !this.settings.nudgeMuted;
    await this.saveSettings();
    new Notice(this.settings.nudgeMuted ? "推送已静音。" : "推送已恢复。");
  }

  /** 段一开始要办的四件事：拦不拦、催不催、锁不锁、换不换曲子。 */
  private onSegmentStarted(kind: SegmentKind, cameFromBreak: boolean, now: number): void {
    if (kind === "work") {
      this.considerGate(cameFromBreak ? "after-break" : "after-idle", now);
      // 工作段开了却没跑起来 = 人还没复工。**待命从这一刻起算**，
      // 催促的每一轮都以它为原点。跑起来了就什么都不用做。
      if (this.timerState.status !== "running") this.markAwaiting(now);
      return;
    }
    this.nudge(
      "nudge",
      "break-start",
      "该休息了",
      kind === "long-break" ? "长休息。离开椅子，别在原地刷。" : "五分钟，起身走动一下。",
    );
    // 「进入休息时间之后——先强制进行锁屏——然后给预先设定的正常休息时间」（AME-238）。
    // 排在 considerLock 前面：它已经把倒计时立起来了，老那条路会看见 countdown 直接跳过，
    // 不会叠出第二个倒计时。
    this.runEnforceActions(
      breakStartActions(this.settings, {
        kind,
        lockSupported: this.lockSupported,
        muted: this.settings.nudgeMuted,
      }),
    );
    this.considerLock(kind, now);
  }

  // --- 复工强提醒页 ---

  private considerGate(reason: GateReason, now: number): void {
    const idleMs = this.lastIdleAt === null ? Number.POSITIVE_INFINITY : now - this.lastIdleAt;
    const due = shouldOpenGate({
      settings: this.settings,
      state: this.gate,
      reason,
      segmentKey: this.segmentKey(),
      day: this.dayKey(),
      now,
      idleMs,
    });
    if (!due) return;

    // 拦着的时候番茄必须停着：盯着这一页发呆的三分钟不该被记成专注时间。
    if (this.timerState.status === "running") this.pauseTimer(now);
    this.gate = openGate(this.gate, {
      reason,
      segmentKey: this.segmentKey(),
      now,
      // **过闸就是开工**：不管进来时这一段是在跑还是停着等人（0.8.0 起工作段
      // 一律停着等人，见 timer.ts 的 advance），点完「看完了，开工」它都得跑起来。
      // 只看「进来时在不在跑」的话，这一版里 resumeAfter 永远是 false——
      // 人点完开工，表还停在原地。
      resumeAfter: this.timerState.status !== "idle",
    });
  }

  /** 手动过一遍强提醒页。不改番茄状态——人只是想看看今天那一页。 */
  openGateNow(): void {
    if (this.gate.open) return;
    const now = Date.now();
    if (this.timerState.status === "running") this.pauseTimer(now);
    this.gate = openGate(this.gate, {
      reason: "after-idle",
      segmentKey: this.segmentKey(),
      now,
      // idle 时看完了还是 idle：人只是想翻一眼那一页，不是要开工。
      resumeAfter: this.timerState.status !== "idle",
    });
    this.markAwaiting(now);
    this.syncOverlay(now);
  }

  private passCurrentGate(skipped: boolean): void {
    const open = this.gate.open;
    if (!open) return;
    const now = Date.now();
    // 「跳过」是设置里明确开着的口子，可以不等；「开工」得等够停留时间。
    if (!skipped && !canPassGate(this.gate, this.settings, now)) return;
    if (skipped && !this.settings.gateAllowSkip) return;

    // 跳过 ≠ 看过：只收这一次的遮罩，今天那一份还欠着（AME-273 第 1 条）。
    this.gate = skipped ? skipGate(this.gate) : passGate(this.gate, this.dayKey());
    if (open.resumeAfter) this.resumeTimer(now);
    // 人点了这一下，就是「恢复继续番茄」——催促到此为止，干扰当场收摊。
    this.clearAwaiting();
    this.zen?.hide();
    this.syncOverlay(now);
    this.refreshUi();
  }

  /** 暂停 / 继续走 reduce，但不经过 dispatch——避免在事件循环里递归派发。 */
  private pauseTimer(now: number): void {
    this.timerState = reduce(this.timerConfig, this.timerState, { type: "pause", at: now }).state;
  }

  private resumeTimer(now: number): void {
    this.timerState = reduce(this.timerConfig, this.timerState, { type: "resume", at: now }).state;
  }

  // --- 强制锁屏 ---

  get lockSupported(): boolean {
    return lockSupport(currentPlatform(), this.settings.lockMethod).supported;
  }

  /** 这台机器锁不锁得动，锁不动是为什么。设置面板原样显示这句话。 */
  describeLockSupport(): string {
    return lockSupport(currentPlatform(), this.settings.lockMethod).detail;
  }

  private considerLock(kind: SegmentKind, now: number): void {
    const due = shouldOfferLock({
      settings: this.settings,
      state: this.lock,
      kind,
      segmentKey: this.segmentKey(),
      day: this.dayKey(),
      now,
      supported: this.lockSupported,
    });
    if (!due) return;

    this.lock = startCountdown(this.lock, this.settings, { segmentKey: this.segmentKey(), now });
    this.nudge(
      "hard",
      "lock-countdown",
      "要锁屏了",
      `${this.settings.lockCountdownSeconds} 秒后锁屏。回到 Obsidian 可以推迟或今天豁免。`,
    );
  }

  private checkLockCountdown(now: number): void {
    if (!countdownDue(this.lock, now)) return;
    void this.lockScreen();
  }

  /** 真的锁。锁不动就明说锁不动，不静默失败，也不假装锁上了。 */
  async lockScreen(): Promise<void> {
    this.lock = finishCountdown(this.lock);
    this.zen?.hide();
    // 屏幕马上就要锁上：从这一刻起，谁也不在看任何东西。
    this.assumeAbsentUntilRealInput();
    this.syncOverlay(Date.now());

    const platform = currentPlatform();
    const command = lockCommandFor(platform, this.settings.lockMethod);
    if (!command) {
      new Notice(`锁不了屏：${lockSupport(platform, this.settings.lockMethod).detail}`);
      return;
    }
    const result = await runCommand(command.file, command.args);
    if (!result.ok) new Notice(`锁屏没成功：${result.detail}`);
  }

  private deferLockScreen(): void {
    this.lock = deferLock(this.lock, this.settings, Date.now());
    this.zen?.hide();
    this.syncOverlay(Date.now());
    new Notice(`锁屏推迟 ${this.settings.lockDeferMinutes} 分钟。`);
  }

  private exemptLockScreen(): void {
    this.lock = exemptLockToday(this.lock, this.dayKey());
    this.zen?.hide();
    this.syncOverlay(Date.now());
    new Notice("今天不再锁屏。换天自动恢复。");
  }

  // -------------------------------------------------------------------------
  // 强制干扰（AME-238）
  //
  // 判断全在 core/enforce.ts，吵闹全在 alarm.ts，这里只做三件事：
  // **采样**（人在不在）、**转发**（把动作清单执行掉）、**收摊**（人一复工就停）。
  // -------------------------------------------------------------------------

  /**
   * 窗口内的输入采样。窗口外的输入靠系统空闲探测，两者在 attention 那层合并。
   *
   * **只认真的手上动作**（指针 / 键盘 / 滚轮）。0.7.0 还把 `window` 的 `focus`
   * 也算成一次输入，那是 AME-239 那条「催了 60 分钟之后自己变成【看完了，开工】」
   * 的来路：催促的每一轮都会 `focusMainWindow()` 把 Obsidian 拽到前台，
   * 而那一下会触发 focus 事件——**插件自己伪造了一次「人回来了」**，
   * 于是在拿不到系统空闲时间的机器上，停留倒计时被自己的催促推着走完了。
   *
   * 一句话：**焦点不是人**。窗口是可以被程序抢到前台的，手不能。
   */
  private registerAttentionProbes(): void {
    const touch = (): void => {
      this.lastInputAt = Date.now();
    };
    for (const type of ["pointerdown", "pointermove", "keydown", "wheel"] as const) {
      // capture + passive：不打扰任何人的事件处理，也不被 stopPropagation 挡掉。
      this.registerDomEvent(document, type, touch, { capture: true, passive: true });
    }
  }

  /**
   * 「从现在起当作没人在，直到真的有人动一下」。
   *
   * 刚锁完屏、刚把窗口拽到人脸前的那一刻，最后一次真实输入可能就在几秒前，
   * 于是接下来的一分钟里 attention 还会说「人在电脑前」——而实际情况是
   * 这台机器刚刚被插件自己锁掉了。系统空闲探测拿得到时它会自己纠正过来，
   * 拿不到的机器上就靠这一手：把窗口内的输入时刻清空 = 窗口空闲无穷大，
   * 第一次真实的指针 / 键盘事件会立刻把它填回去。
   */
  private assumeAbsentUntilRealInput(): void {
    this.lastInputAt = null;
  }

  private sampleAttention(now: number): void {
    const idleMs = systemIdleMs() ?? this.fallbackIdleMs(now);
    this.attention = evaluateAttention(
      {
        now,
        focused: document.hasFocus(),
        visible: document.visibilityState !== "hidden",
        lastInputAt: this.lastInputAt,
        systemIdleMs: idleMs,
      },
      this.settings,
    );
  }

  /**
   * Electron 的 powerMonitor 拿不到时的兜底：起一条 PowerShell 问 `GetLastInputInfo`。
   *
   * **只在真的要用的时候探**——强提醒页拦着、或者正在待命催促。平时每秒起一个
   * PowerShell 去问「人在不在」，比它要防的那个问题本身还糟。
   */
  private fallbackIdleMs(now: number): number | null {
    const needed = this.gate.open !== null || this.awaitingSince !== null;
    if (!needed || currentPlatform() !== "win32") return null;
    if (now - this.idleProbe.at > 10_000 && !this.idleProbing) {
      this.idleProbing = true;
      void runCommand("powershell.exe", powerShellArgs(IDLE_PROBE_SCRIPT))
        .then((result) => {
          this.idleProbe = { at: Date.now(), ms: result.ok ? parseIdleProbe(result.stdout) : null };
        })
        .finally(() => {
          this.idleProbing = false;
        });
    }
    // 探测本身是异步的，这一拍先用上一次的数；差十秒对分钟级的判断没有影响。
    return this.idleProbe.ms;
  }

  /** 让强提醒页的停留倒计时走一拍。人不在看的那一段不算数。 */
  private advanceGate(now: number): void {
    if (!this.gate.open) return;
    this.gate = advanceGateDwell(this.gate, {
      now,
      present: this.attention.attending,
      requireAttention: this.settings.gateRequireAttention,
      dwellMs: Math.max(0, this.settings.gateDwellSeconds) * 1000,
      maxStepMs: TICK_MS * 5,
    });
  }

  private stepEnforcement(now: number): void {
    const result = stepEnforce({
      settings: this.settings,
      state: this.enforce,
      now,
      timer: {
        kind: this.timerState.kind,
        status: this.timerState.status,
        remainingMs: remainingMs(this.timerState, now),
        segmentKey: this.segmentKey(),
      },
      awaitingSince: this.awaitingSince,
      attention: this.attention,
      lockSupported: this.lockSupported,
      muted: this.settings.nudgeMuted,
    });
    this.enforce = result.state;
    this.runEnforceActions(result.actions);
  }

  /** 动作清单 → 真的动作。core 只说做什么，怎么做全在这一个方法里。 */
  private runEnforceActions(actions: EnforceAction[]): void {
    for (const action of actions) {
      switch (action.type) {
        case "alarm-start":
          this.alarm?.start(action);
          break;
        case "alarm-stop":
          this.alarm?.stop();
          break;
        case "notify":
          this.nudge(action.level, action.key, action.title, action.body);
          break;
        case "lock":
          // 「推迟」和「今天豁免」是锁屏仅有的两个反悔口子，**强制干扰这一层也得认**。
          // 不认的话，人刚按下「今天豁免」，下一个休息段照样把他锁出去——
          // 那个按钮就成了摆设，而摆设按钮比没有按钮更伤人。
          if (!this.lockAllowedNow(Date.now())) break;
          if (action.seconds <= 0) void this.lockScreen();
          else this.startLockCountdown(action.seconds);
          break;
        case "open-discipline":
          void this.openDisciplinePage();
          break;
        case "focus-window":
          this.pullToFront();
          break;
      }
    }
  }

  /** 这会儿允不允许锁。人按过「推迟」或「今天豁免」就不许——那是他的明确指令。 */
  private lockAllowedNow(now: number): boolean {
    if (this.lock.exemptDay === this.dayKey()) return false;
    return this.lock.deferUntil === null || now >= this.lock.deferUntil;
  }

  /** 强制干扰要的那种锁：倒计时短，但「推迟 / 今天豁免」两个口子照留。 */
  private startLockCountdown(seconds: number): void {
    if (this.lock.countdown) return;
    const now = Date.now();
    this.lock = startCountdown(this.lock, this.settings, {
      segmentKey: this.segmentKey(),
      now,
      seconds,
    });
    this.syncOverlay(now);
  }

  /**
   * 督促自律网页。地址没配就改成把 Obsidian 拽到前台——**这一格不能是空动作**：
   * 「弹出督促页」在原话里是那一轮干扰的组成部分，缺了它人可能什么都看不到。
   */
  private async openDisciplinePage(): Promise<void> {
    const url = this.settings.enforceDisciplineUrl.trim();
    if (!url) {
      this.pullToFront();
      return;
    }
    const ok = await openExternal(url);
    if (!ok) new Notice(`打不开督促自律网页：${url}`);
  }

  /**
   * 把 Obsidian 拽到人脸前，顺带确保遮罩是最新的。
   *
   * 拽完要**明确地不把这一下当成人回来了**：窗口是插件自己抢到前台的，
   * 手还在别处（或者根本不在）。见 `assumeAbsentUntilRealInput`。
   */
  private pullToFront(): void {
    focusMainWindow();
    this.assumeAbsentUntilRealInput();
    this.syncOverlay(Date.now());
  }

  /** 待命开始。休息结束却没复工的那一刻起算，催促的每一轮都从它算。 */
  private markAwaiting(now: number): void {
    if (this.awaitingSince === null) this.awaitingSince = now;
  }

  private clearAwaiting(): void {
    if (this.awaitingSince === null) return;
    this.awaitingSince = null;
    this.enforce = createEnforceState();
    this.alarm?.stop();
  }

  /**
   * 演练一次。**这个命令是这一版最该先按的按钮**：不然要验「收工前三分钟会怎样」
   * 就得真的坐等 22 分钟，而验一次锁屏还要重新登录一次。
   */
  enforceDrill(): void {
    if (!this.settings.enforceEnabled) {
      new Notice("强制干扰关着。设置 → 人生驾驶舱 → 强提醒 · 锁屏 · 干扰。");
      return;
    }
    this.alarm?.start({
      reason: "pre-end",
      durationMs: 20_000,
      title: "这是演练",
      body: "20 秒的干扰演练：通知连击 + 蜂鸣 + 屏幕亮度闪烁。按命令面板里的「停止强制干扰」可随时叫停。",
      silent: false,
    });
    new Notice("演练开始：20 秒。亮度调不动的机器会退回遮罩闪烁。");
  }

  /** 手动叫停。人已经回来了、或者演练看够了。 */
  stopEnforcement(): void {
    this.alarm?.stop();
    this.enforce = createEnforceState();
    new Notice("强制干扰已停。");
  }

  /** 亮度探测（设置页那颗「测一次」按钮）。 */
  async probeBrightness(): Promise<void> {
    const level = await this.alarm?.probeBrightness(true);
    new Notice(
      level === null || level === undefined
        ? "亮度调不动：WMI 只认内置显示器，外接屏走 DDC/CI。会退回遮罩 + 任务栏闪烁。"
        : `亮度调得动，当前 ${level}%。`,
    );
    this.refreshUi();
  }

  describeBrightnessSupport(): string {
    return this.alarm?.describeBrightness() ?? "还没初始化。";
  }

  describeDesktopBridge(): string {
    return describeDesktopBridge();
  }

  describeAttentionNow(): string {
    return describeAttention(this.attention);
  }

  // -------------------------------------------------------------------------
  // 存在感层（AME-239）
  //
  //   「中间的提示太弱了，几乎没有存在感——我的预期，每 2 分钟 得有一个提示、提醒？」
  //
  // 判断全在 core/hud.ts，画面与进程全在 hud.ts，这里只做三件事：
  // **取数**（现在是哪一格）、**推给悬浮框**、**到点心跳**。
  // -------------------------------------------------------------------------

  /** 此刻这套系统处在哪一格。悬浮框、任务栏、心跳提醒读的都是这一份。 */
  private hudSnapshot(now: number): HudSnapshot {
    const progress = focusProgress(this.today);
    return buildHudSnapshot({
      now,
      timer: {
        kind: this.timerState.kind,
        status: this.timerState.status,
        pomodoroIndex: this.timerState.pomodoroIndex,
        remainingMs: remainingMs(this.timerState, now),
        plannedMs: this.timerState.plannedMs,
        task: this.timerState.task,
      },
      awaitingSince: this.awaitingSince,
      gateOpen: this.gate.open !== null,
      goal: this.settings.goalsEnabled
        ? this.goals.find(this.pomodoroGoalId)?.title ?? null
        : null,
      focusMinutes: progress.minutes,
      targetMinutes: progress.targetMinutes,
    });
  }

  private syncHud(now: number): void {
    const snapshot = this.hudSnapshot(now);
    this.hud?.sync(snapshot, now);
    this.runHeartbeat(snapshot, now);
  }

  /**
   * 心跳的一拍。**不走 PushHub**：那五道闸（冷却 10 分钟、每天 24 条）是防「把人
   * 吵到把功能关掉」的，而每 2 分钟一次的节拍到它手里第一拍之后就全被吃掉了。
   * 这一层只留一道闸——人明确按下的静音。
   */
  private runHeartbeat(snapshot: HudSnapshot, now: number): void {
    const result = stepHeartbeat({
      settings: this.settings,
      state: this.heartbeat,
      snapshot,
      now,
      alarmRunning: Boolean(this.alarm?.running),
    });
    this.heartbeat = result.state;
    const beat = result.beat;
    if (!beat) return;

    this.hud?.pulse();
    if (this.settings.heartbeatFlash) this.flashOnce();
    if (!this.settings.heartbeatNotify) return;
    if (this.settings.nudgeMuted && this.settings.enforceRespectMute) return;
    systemNotify(`【驾驶舱】${beat.title}`, beat.body, "life-cockpit-heartbeat");
  }

  /** 闪一下任务栏就收。一直闪着的话，它就从「提醒」退化成了背景噪音。 */
  private flashOnce(): void {
    flashTaskbar(true);
    if (this.flashTimer !== null) window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => {
      flashTaskbar(false);
      this.flashTimer = null;
    }, 5000);
  }

  /** 面板与设置页共用的一句话：这块存在感现在摆在哪儿、多久响一次。 */
  describeHud(): string {
    return describeHudPlan(this.settings, Boolean(this.hud?.desktopActive));
  }

  /** 这台机器上悬浮框到底是怎么落地的。设置页原样显示，不许粉饰。 */
  describeHudMode(): string {
    return this.hud?.describe() ?? "还没初始化。";
  }

  /** 「测一次悬浮提示」：不改任何状态，只让它当场闪一下。 */
  testHud(): void {
    if (!this.settings.hudEnabled) {
      new Notice("悬浮提示关着。设置 → 人生驾驶舱 → 界面 → 悬浮提示。");
      return;
    }
    this.syncHud(Date.now());
    this.hud?.pulse();
    new Notice(this.describeHudMode());
  }

  /** 面板上那一行：现在是什么状态、下一轮什么时候动。 */
  describeEnforcement(): string {
    if (!this.settings.enforceEnabled) return describeEnforcePlan(this.settings);
    if (this.alarm?.running) return "正在干扰中。回来点一下「看完了，开工」就停。";
    const next = nextEnforceCheckMs(this.settings, this.enforce, this.awaitingSince, Date.now());
    if (next === null) return describeEnforcePlan(this.settings);
    const rounds = this.enforce.rounds;
    return `待命中：${Math.ceil(next / 1000)} 秒后${rounds > 0 ? `催第 ${rounds + 1} 轮` : "开始催"}。`;
  }

  // --- 飞书金字塔表格（AME-258 第 19.1 条） ---

  /**
   * 读一份飞书快照。**读不到不是错误**：那一天就只是没有这一栏。
   *
   * 找文件的顺序是「今天 → latest.json → 目录里最新的那一份」。第三条是关键：
   * 快照是人（或那条导出管线）隔几天才更新一次的东西，只认当天文件的话，
   * 这一栏一年里有大半年是空的——而它要回答的「我最近都在做什么」恰恰不需要当天。
   */
  private async loadFeishu(): Promise<void> {
    if (!this.settings.feishuEnabled) {
      this.feishu = null;
      return;
    }
    const folder = this.settings.feishuSnapshotFolder.replace(/^\/+|\/+$/g, "");
    if (!folder) {
      this.feishu = null;
      return;
    }

    const today = this.dayKey();
    const dated = (await this.listJson(folder))
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .sort()
      .reverse()
      .map((name) => `${folder}/${name}`);
    for (const path of [`${folder}/${today}.json`, `${folder}/latest.json`, ...dated]) {
      const text = await this.readPath(path).catch(() => null);
      if (text === null) continue;
      const snapshot = parseFeishuSnapshot(text);
      if (!snapshot) {
        console.warn(`人生驾驶舱：飞书快照读不动，跳过：${path}`);
        continue;
      }
      // 快照里可能装着好几个月的 sheet（导出管线就是整本导的），
      // 所以「这一份对应哪一天」要从内容里挑，不是从文件名猜。
      const day = latestFeishuDay(snapshot, today) || latestFeishuDay(snapshot) || today;
      this.feishu = { snapshot, day, path };
      this.syncGoalProgressFromFeishu();
      return;
    }
    this.feishu = null;
    this.syncGoalProgressFromFeishu();
  }

  /** 快照里这一天（或最近有记录的那一天）的条目。 */
  feishuTasks(): { day: string; tasks: FeishuTask[] } | null {
    if (!this.feishu) return null;
    const day = this.feishu.day;
    return { day, tasks: feishuTasksFor(this.feishu.snapshot, day) };
  }

  /**
   * 进复盘素材包的那一栏；没快照就是 null。
   *
   * **不按账本日过滤**：快照对应哪一天由 `loadFeishu` 挑好了（可能是几天前的），
   * 而「我最近都在做什么」这一问本来就不要求当天有记录。素材包里的 `feishu.day`
   * 会把实际是哪一天写清楚，复盘正文里也会标出来。
   */
  private feishuSlice(_day: string): FeishuReviewSlice | null {
    if (!this.settings.feishuEnabled || !this.settings.feishuIntoReview) return null;
    const current = this.feishuTasks();
    if (!current || !current.tasks.length) return null;
    return feishuReviewSlice(current.day, current.tasks, {
      url: this.settings.feishuSheetUrl,
      generatedAt: this.feishu?.snapshot.generatedAt ?? "",
      limit: 20,
    });
  }

  /** 强提醒页与面板上那一段 Markdown。没配地址、没有快照就是空串。 */
  feishuMarkdown(): string {
    if (!this.settings.feishuEnabled) return "";
    const current = this.feishuTasks();
    if (!current) {
      const url = this.settings.feishuSheetUrl.trim();
      return url ? `## 飞书金字塔表格\n\n- 表格：${url}\n- 还没有快照，先按文档导一份进来。\n` : "";
    }
    return describeFeishuTasks(current.day, current.tasks, {
      url: this.settings.feishuSheetUrl,
      generatedAt: this.feishu?.snapshot.generatedAt,
      limit: 10,
    });
  }

  /** 面板上那一行；也是设置页里「现在读到了什么」那一行。 */
  describeFeishu(): string {
    if (!this.settings.feishuEnabled) return "飞书那一栏已关。";
    const current = this.feishuTasks();
    if (!current) {
      return this.settings.feishuSnapshotFolder
        ? `没读到快照（找的是 ${this.settings.feishuSnapshotFolder}/）。`
        : "没配快照目录。";
    }
    const line = feishuHeadline(current.day, summarizeFeishu(current.tasks));
    return current.day === this.dayKey() ? line : `${line}（这是表上最近有记录的一天）`;
  }

  /** 打开飞书表格。地址没配就明说没配——插件不编造地址。 */
  async openFeishu(): Promise<void> {
    const url = this.settings.feishuSheetUrl.trim();
    if (!url) {
      new Notice("还没填飞书表格地址：设置 → 人生驾驶舱 → 飞书金字塔表格。");
      return;
    }
    const ok = await openExternal(url);
    if (!ok) new Notice(`打不开：${url}`);
  }

  /**
   * 打开飞书上那一页【总结】（AME-271 第 28 条）。
   *
   * 那一页不是插件写的，是 `write_feishu_summary.py` 整页写进飞书的——
   * 所以这里**只负责点得开**，不在 Obsidian 里重画一遍。在两个地方各画一份
   * 「哪些做了哪些没做」，迟早会出现两份对不上的清单。
   */
  async openFeishuSummary(): Promise<void> {
    const url = this.settings.feishuSummarySheetUrl.trim();
    if (!url) {
      new Notice(
        "还没填总结页地址：设置 → 人生驾驶舱 → 飞书金字塔表格 → 【总结】页地址。" +
          "那一页由 write_feishu_summary.py 写出来，写完把它的地址贴过来。",
      );
      return;
    }
    const ok = await openExternal(url);
    if (!ok) new Notice(`打不开：${url}`);
  }

  /**
   * 通过 Convex 主链更新飞书【总结】页。
   *
   * 这条路径是现在的主力：Convex 负责幂等 job 和状态，配置好的自动化负责在
   * 有 lark-cli 的机器上运行 `refresh_feishu_summary.sh`。旧的 webhook + Easy Git
   * 链仍可在下面的 `pullFeishuSnapshot()` 中作为备用，但不再冒充“更新总结页”。
   */
  async refreshFeishuSummary(): Promise<void> {
    if (!this.settings.feishuEnabled) {
      new Notice("飞书那一栏已在设置里关掉了。");
      return;
    }
    const active = this.feishuSummaryJob?.status === "pending" || this.feishuSummaryJob?.status === "running";
    if (active) {
      new Notice(`总结页正在更新：${this.feishuSummaryJob?.progress || "任务进行中"}`);
      return;
    }
    if (!this.settings.convexEnabled) {
      new Notice("主路径需要先开启 Convex 同步；旧版快照链仍可作为备用。");
      return;
    }
    const status = this.convexStatus();
    if (status.phase === "missing-config" || status.phase === "disabled") {
      new Notice(`Convex 还没配好：${status.detail}`);
      return;
    }

    this.feishuSummaryJob = {
      _id: "local-request",
      kind: "feishu-snapshot",
      day: this.dayKey(),
      status: "pending",
      progress: "正在提交刷新任务……",
      lastError: null,
      attempt: 1,
      maxAttempts: 3,
    };
    this.refreshUi();

    try {
      const jobId = await this.convex.requestFeishuSummaryRefresh(this.dayKey(), true);
      this.feishuSummaryJob = {
        ...this.feishuSummaryJob,
        _id: jobId,
        progress: "已排上，等待自动化开始……",
      };
      this.watchFeishuSummaryJob(jobId);
      new Notice("已提交飞书【总结】页刷新任务；面板会显示自动化进度。", 8000);
    } catch (error) {
      this.feishuSummaryJob = null;
      this.refreshUi();
      new Notice(`提交飞书【总结】页刷新失败：${String(error).slice(0, 240)}`, 10000);
    }
  }

  /** 接住一个具体 job 直到终态；启动时从 jobs:active 找回来的也走同一条。 */
  private watchFeishuSummaryJob(jobId: string): void {
    if (this.feishuSummaryJobUnsubscribe && this.feishuSummaryWatchedJobId === jobId) return;
    this.feishuSummaryJobUnsubscribe?.();
    this.feishuSummaryWatchedJobId = jobId;
    this.feishuSummaryJobUnsubscribe = this.convex.watchJob(jobId, (job) => {
      if (!job) return;
      const previous = this.feishuSummaryJob;
      this.feishuSummaryJob = job;
      this.refreshUi();
      if (
        (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") &&
        previous?.status !== job.status
      ) {
        this.feishuSummaryJobUnsubscribe?.();
        this.feishuSummaryJobUnsubscribe = null;
        this.feishuSummaryWatchedJobId = null;
        if (job.status === "succeeded") {
          new Notice("飞书【总结】页已更新完成。", 8000);
        } else {
          new Notice(
            `飞书【总结】页更新${job.status === "cancelled" ? "已取消" : "失败"}：${
              job.lastError || job.progress
            }`,
            10000,
          );
        }
      }
    });
  }

  /** 面板和设置页显示 Convex 主链的当前进度。 */
  describeFeishuSummaryRefresh(): string {
    const job = this.feishuSummaryJob;
    if (!job) return "";
    if (job.status === "pending" || job.status === "running") {
      return `总结页更新中：${job.progress || "自动化正在执行"}`;
    }
    if (job.status === "succeeded") return `总结页最近一次更新完成：${job.progress || "成功"}`;
    if (job.status === "cancelled") return `总结页更新已取消：${job.progress || "已取消"}`;
    return `总结页更新失败：${job.lastError || job.progress || "未知错误"}`;
  }

  /** 给按钮用的忙碌状态；完成 / 失败后允许再次强制刷新。 */
  feishuSummaryRefreshActive(): boolean {
    return this.feishuSummaryJob?.status === "pending" || this.feishuSummaryJob?.status === "running";
  }

  /** 手动重读一次快照。导出管线刚推完，不用重启 Obsidian。 */
  async reloadFeishu(): Promise<void> {
    await this.loadFeishu();
    this.refreshUi();
    new Notice(this.describeFeishu());
  }

  // --- 飞书 × 目标树（AME-258 第 22.2 条第 1 点）---

  /**
   * 这一天的表按目标分了什么。目标项上的 `[飞书:: 关键词]` 决定归属，
   * 一条命中多支就每支都算——一件事推进两支目标是常态。
   */
  feishuGoalRollup(): FeishuGoalRollup | null {
    if (!this.settings.feishuEnabled || !this.settings.feishuGroupByGoal) return null;
    if (!this.settings.goalsEnabled) return null;
    const current = this.feishuTasks();
    if (!current) return null;

    // **一拍只算一次。** 目标树面板每秒会为每个节点问一次「这支目标今天几条」，
    // 不缓存的话就是「节点数 × 目标数 × 条目数」次字符串查找，每秒一遍。
    // TTL 一秒：目标树改完最迟下一拍就反映出来，人感觉不到延迟。
    const key = this.feishuKey();
    const now = Date.now();
    const cached = this.feishuRollupCache;
    if (cached && cached.key === key && now - cached.at < 1000) return cached.value;

    const bindings = walkGoals(this.goals.roots)
      .map((node) => ({ id: node.id, title: node.title, keywords: goalFeishuKeywords(node) }))
      .filter((binding) => binding.keywords.length > 0);
    const value = bindings.length ? rollupFeishuByGoal(bindings, current.tasks) : null;
    this.feishuRollupCache = { key, at: now, value };
    return value;
  }

  /**
   * **把飞书那张表上的完成情况，灌成目标树的进度**（AME-271 后续）。
   *
   *   「最好目标的完成——也可以根据【飞书Excel】上面的来？免得我在【飞书Excel上
   *    手动更改了目标完成程度】——本地OB插件还要手动来一次？」
   *
   * 两处和上面那个徽章不一样，都是有意的：
   *
   * 1. **算的是整张表，不是某一天。** 徽章回答「今天这支推了几条」，进度回答
   *    「这支目标到现在做到哪儿了」——后者跨所有日期页，只看今天会让一支
   *    推了三个月的目标显示成 0%。
   * 2. **没绑关键词的目标一条都不进来。** 没绑就是没说「这支的进度以表为准」，
   *    它照旧走度量 / 手写 / 子节点回灌，这一层不碰。
   */
  private syncGoalProgressFromFeishu(): boolean {
    if (!this.settings.goalsEnabled) return false;
    const tally = new Map<string, FeishuGoalTally>();
    // 关掉飞书、或者压根没读到快照时喂一份空的进去：**要能退回原来的算法**，
    // 而不是把上一次的战绩永远钉在那儿。
    if (this.settings.feishuEnabled && this.feishu) {
      const bindings = walkGoals(this.goals.roots)
        .map((node) => ({ id: node.id, title: node.title, keywords: goalFeishuKeywords(node) }))
        .filter((binding) => binding.keywords.length > 0);
      if (bindings.length) {
        for (const slice of rollupFeishuByGoal(bindings, this.feishu.snapshot.tasks).slices) {
          tally.set(slice.goalId, {
            done: slice.tasks.filter((task) => task.status === "已完成").length,
            partial: slice.tasks.filter((task) => task.status === "完成了一部分").length,
            total: slice.total,
          });
        }
      }
    }
    return this.goals.setFeishuTally(tally);
  }

  /** 目标树面板上那一枚徽章要的数：这支目标今天在表上有几条、成了几条。 */
  feishuGoalCounts(goalId: string): { total: number; done: number } | null {
    const rollup = this.feishuGoalRollup();
    const slice = rollup?.slices.find((item) => item.goalId === goalId);
    return slice && slice.total ? { total: slice.total, done: slice.done } : null;
  }

  private feishuGoalMarkdown(): string {
    const rollup = this.feishuGoalRollup();
    const current = this.feishuTasks();
    if (!rollup || !current) return "";
    return describeFeishuByGoal(current.day, rollup);
  }

  // --- 拉取快照（AME-258 第 22.2 条第 2 点）---

  /** 现在盘上这份快照的身份。变了 = 新的到了。 */
  private feishuKey(): string {
    const current = this.feishuTasks();
    if (!current) return "";
    return feishuSnapshotKey({
      day: current.day,
      generatedAt: this.feishu?.snapshot.generatedAt ?? "",
      taskCount: this.feishu?.snapshot.tasks.length ?? 0,
    });
  }

  private feishuPullUrl(): string {
    return resolveCredential(
      this.settings.feishuPullWebhook,
      "LIFE_COCKPIT_FEISHU_PULL_WEBHOOK",
      aiEnv(),
    );
  }

  /**
   * 面板上那一行。**闲着的时候是空串**——一条常驻的「拉取通道已配好」对谁都没用，
   * 只会把快照本身那一行挤下去。要看配没配去设置页，那儿说得全。
   */
  describeFeishuPull(): string {
    return this.feishuPull.phase === "idle" ? "" : this.feishuPull.detail;
  }

  /** 设置页上那一行：这条拉取通道现在能不能用。 */
  describeFeishuPullConfig(): string {
    const url = this.feishuPullUrl();
    if (!url) {
      return (
        "还没配 webhook 地址，【拉一份新的】按下去只会提示这句话。" +
        "配好之后按一下就能让对面那台机器去导表、推仓库，本机再拉回来。"
      );
    }
    const command = this.settings.feishuPullCommandId.trim();
    return (
      `已配好。触发之后每 30 秒看一眼快照，最多等 ${this.settings.feishuPullWaitSeconds} 秒；` +
      (command ? `等的期间会顺手跑一次「${command}」把仓库拉下来。` : "拉仓库这一步要你自己来。")
    );
  }

  /**
   * 喊一嗓子，然后等产物。整条链是：
   *
   *   插件 POST webhook → Multica 上那条自动化跑起来 → 对面导表、写 JSON、推仓库
   *   → 本机 Easy Git 拉下来 → 插件重读快照目录
   *
   * **完成信号是「盘上那份快照变新了」，不是 webhook 的响应。** 他担心
   * 「WebHook 可能不太好获得具体的一个完成状态」——对的，所以这里根本不问它要状态：
   * 产物本身就是状态。webhook 返回 2xx 只说明「这一嗓子喊出去了」，仅此而已。
   *
   * 等待期间**不阻塞**：每一拍（`tick`）顺手看一眼快照变没变，人该干嘛干嘛。
   */
  async pullFeishuSnapshot(): Promise<void> {
    const url = this.feishuPullUrl();
    if (!url) {
      new Notice(
        "还没配拉取 webhook：设置 → 交班 · 复盘 → 飞书金字塔表格 → 拉取快照的 webhook。",
      );
      return;
    }
    const baseline = this.feishuKey();
    new Notice("正在喊对面去导一份飞书快照……");
    try {
      const response = await requestUrl({
        url,
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({
          source: GENERATOR,
          reason: "feishu-snapshot-pull",
          day: this.dayKey(),
          // 对面要往哪儿写。写进 payload 而不是让它记着——那条自动化的提示词里
          // 会有同一句话，两边对不上的时候以这里为准。
          snapshotFolder: this.settings.feishuSnapshotFolder,
          at: new Date().toISOString(),
        }),
        throw: false,
      });
      if (response.status < 200 || response.status >= 300) {
        this.feishuPull = failFeishuPull(`喊不动：HTTP ${response.status}。地址对不对？`);
        new Notice(this.feishuPull.detail);
        this.refreshUi();
        return;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.feishuPull = failFeishuPull(`请求没发出去：${detail}`);
      new Notice(this.feishuPull.detail);
      this.refreshUi();
      return;
    }

    this.feishuPull = startFeishuPull(baseline, Date.now());
    new Notice(
      "喊到了。对面导完会把快照推上仓库，这边每隔一会儿自己拉一次；" +
        "等到了会弹一条通知，等不到也不算失败。",
    );
    this.refreshUi();
  }

  /**
   * 等待期间的那一拍。**每 30 秒才真的动一次**：这一拍会去跑一次 Easy Git 的同步，
   * 那是真的网络往返，每秒来一遍只会把仓库和人一起烦死。
   */
  private async probeFeishuPull(now: number): Promise<void> {
    if (this.feishuPull.phase !== "waiting") return;
    // 上一拍还没跑完（Easy Git 同步可能比 30 秒还慢）就别叠第二次。
    if (this.feishuProbing) return;
    if (now - this.lastFeishuProbeAt < 30_000) return;
    this.lastFeishuProbeAt = now;
    this.feishuProbing = true;

    try {
      // 先让 Easy Git 拉一次，再看盘。顺序反了的话，等到的永远是上一次的快照。
      await this.runFeishuPullCommand();
      await this.loadFeishu();
    } finally {
      this.feishuProbing = false;
    }

    const next = tickFeishuPull(this.feishuPull, {
      now: Date.now(),
      currentKey: this.feishuKey(),
      waitMs: this.settings.feishuPullWaitSeconds * 1000,
    });
    if (next === this.feishuPull) return;
    this.feishuPull = next;
    new Notice(next.detail);
    this.refreshUi();
  }

  /**
   * 拉仓库。**复用 Easy Git 已经配好的凭据——调它的命令，不抄它的 token。**
   *
   * 「你可以复用 EasyGit 的相关 github 的 token 的凭证？我猜」——能，但正确的方式是
   * 这一条：插件自己不存任何 GitHub 凭据，也就没有第二处会泄露的地方。
   * 命令 id 不存在（没装 Easy Git、或者它改了 id）就安静跳过，由「重读快照」兜底。
   */
  async runFeishuPullCommand(): Promise<boolean> {
    const id = this.settings.feishuPullCommandId.trim();
    if (!id) return false;
    // `app.commands` 不在官方 d.ts 里（它是稳定但未公开的那一档 API），所以这里
    // 显式收窄一次，而不是把整个 app 断言成 any——要用的就这一个方法。
    const commands = (this.app as unknown as {
      commands?: { executeCommandById?: (id: string) => boolean };
    }).commands;
    if (!commands?.executeCommandById) {
      console.warn("人生驾驶舱：这个 Obsidian 上取不到命令表，跳过自动拉取。");
      return false;
    }
    // executeCommandById 对不存在的 id 返回 false，不抛——所以不用先查一遍命令表。
    const ran = commands.executeCommandById(id);
    if (!ran) console.warn(`人生驾驶舱：拉取命令「${id}」不存在，跳过。`);
    return ran;
  }

  // --- 秒哒「5 分钟写作」（AME-272 第 26 条） ---
  //
  // 和飞书那一层**正好相反**：飞书是「插件不连 API，只读别人导好的快照」，
  // 因为那条导出管线已经跑通了、而且拿着 user token。秒哒这边没有这样一条管线，
  // 他给的就是一条现成的、只读的、匿名 key 的接口——所以这里直接拉。
  //
  // 拉回来的东西落在**给人看的那一块**，一天一页、一段写作一个大标题。
  // 之后怎么整理是他自己的事（「我可能会手动整理之后，放到飞书的 Excel 中」），
  // 所以这一层唯一的纪律是：**别跟他抢那一页**——搬走的不补写、手写的不覆盖。

  private async loadMiaoda(): Promise<void> {
    if (!this.settings.miaodaEnabled) return;
    try {
      await this.miaoda.load();
    } catch (error) {
      console.error("人生驾驶舱：秒哒同步索引读不动", error);
    }
  }

  /**
   * 拉一次。`full` = 整份重拉（把落点记录当参考而不是判据，远端有的就往页面上补）。
   *
   * **平时用增量**：索引记着上次拉到哪个 `updated_at`，这一次只问那之后动过的几条。
   * 他问过「其实可以，把 limit 放大一点、或者删除？」——不用，翻页翻到底就行，
   * 而且平时根本翻不到第二页。
   */
  async pullMiaoda(options: { full?: boolean; silent?: boolean } = {}): Promise<void> {
    const silent = options.silent === true;
    if (!this.settings.miaodaEnabled) {
      if (!silent) new Notice("秒哒那一栏已在设置里关掉了。");
      return;
    }
    const status = this.miaodaClient.status();
    if (status.state !== "ready") {
      if (!silent) new Notice(status.detail, 8000);
      return;
    }
    if (this.miaodaPulling) {
      if (!silent) new Notice("上一次还在拉，等它跑完。");
      return;
    }

    this.miaodaPulling = true;
    const notice = silent ? null : new Notice("正在拉秒哒……", 0);
    try {
      if (!this.miaoda.loaded) await this.miaoda.load();
      const since = options.full ? "" : this.miaoda.since;
      const result = await this.miaodaClient.pull(since);
      if (!result.ok) {
        notice?.hide();
        // 自动拉取失败不弹窗——外网抽风一次不该在人写东西的时候糊一脸红字。
        if (silent) console.warn(`人生驾驶舱：秒哒自动拉取没成：${result.detail}`);
        else new Notice(`秒哒拉不动：${result.detail}`, 10000);
        return;
      }
      const sync = await this.miaoda.sync(result.sessions, { full: options.full });
      notice?.hide();
      if (!silent || sync.report.added || sync.report.updated) {
        new Notice(sync.message, 8000);
      }
      this.refreshUi();
    } catch (error) {
      notice?.hide();
      console.error("人生驾驶舱：秒哒拉取失败", error);
      if (!silent) new Notice(failureNotice(error, "秒哒拉取失败，详情见开发者控制台。"));
    } finally {
      this.miaodaPulling = false;
    }
  }

  /**
   * 自动拉取那一拍（补充第 1 条：「（在 Obsidian 插件中）可以设置——自动拉取？」）。
   *
   * **启动之后先等一个间隔再拉第一次**，不在 onload 里就冲出去：开 Obsidian 那一刻
   * 网络、代理、VPN 都可能还没就绪，那一次失败除了在控制台留条噪音没有任何用处。
   */
  private async autoPullMiaoda(now: number): Promise<void> {
    if (!this.settings.miaodaEnabled || !this.settings.miaodaAutoPull) return;
    if (this.miaodaPulling || !this.miaodaClient.ready) return;
    const everyMs = Math.max(5, this.settings.miaodaAutoPullMinutes) * 60_000;
    if (!this.lastMiaodaPullAt) {
      this.lastMiaodaPullAt = now;
      return;
    }
    if (now - this.lastMiaodaPullAt < everyMs) return;
    this.lastMiaodaPullAt = now;
    await this.pullMiaoda({ silent: true });
  }

  /** 面板与设置页上那一行。 */
  describeMiaoda(): string {
    const status = this.miaodaClient?.status();
    if (status && status.state !== "ready") return status.detail;
    const auto = this.settings.miaodaAutoPull
      ? `自动拉取：每 ${this.settings.miaodaAutoPullMinutes} 分钟。`
      : "自动拉取：关（用命令面板或下面那颗按钮手动拉）。";
    // 「看着能拉、其实多半会 401」那一句排在最前面：它是这一行里唯一要人动手的信息。
    const warning = status?.warning ? `${status.warning} ` : "";
    return `${warning}${this.miaoda?.describe() ?? ""} ${auto}`.trim();
  }

  /** 打开今天那一页。没有就明说——今天还没写过东西是常态，不是错误。 */
  async openMiaodaToday(): Promise<void> {
    const path = this.miaoda.dayPath(this.dayKey());
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`今天还没有秒哒那一页：${path}。先拉一次，或者今天本来就没写。`);
      return;
    }
    await this.app.workspace.getLeaf(true).openFile(file);
  }

  // --- 每日推荐读物 ---

  /**
   * 挑推荐时要用的复盘素材。取今天的，没有就退到昨天——
   * 早上八点半推荐的时候，今天那份还没生成是常态。
   */
  private async loadReadingMaterial(): Promise<void> {
    if (!this.settings.readingEnabled) return;
    const today = this.dayKey();
    const yesterday = this.dayKey(new Date(Date.now() - 86_400_000));
    for (const day of [today, yesterday]) {
      const path = this.review.materialPath(day);
      const text = await this.readPath(path);
      if (text === null) continue;
      const material = parseReviewMaterial(text);
      if (!material) continue;
      this.readingMaterial = { material, path };
      return;
    }
    this.readingMaterial = null;
  }

  /** 今天推哪几条。料全部来自候选区、休息页、读物池和复盘素材，一条都不是现造的。 */
  todayReading(): ReadingPick[] {
    if (!this.settings.readingEnabled) return [];
    return buildReadingList(
      this.dayKey(),
      {
        digests: this.candidates.files
          .filter((file) => file.candidate.type === "news-digest")
          .map((file) => ({ day: file.day, path: file.path, candidate: file.candidate })),
        breakPages: this.settings.breakPages,
        pool: this.expandedReadingPool(),
        material: this.readingMaterial?.material ?? null,
        materialPath: this.readingMaterial?.path ?? "",
      },
      this.settings.readingCount,
    );
  }

  /**
   * 读物池里写目录的那几行展开成篇（AME-258 第 19.0 条）。
   *
   * **带一分钟的缓存。** 展开要向 vault 索引要一份全量 md 列表，而这个方法挂在
   * 强提醒页的每秒重画上——大 vault 里每秒扫一遍全部笔记，是那种平时看不出来、
   * 一旦拦着页面就一直在烧的开销。一分钟的滞后换来的是：往目录里加一篇笔记，
   * 最迟一分钟后就进池子，「当天推得到」这句仍然成立。
   *
   * 池子本身没写目录的话根本不用扫——那是最常见的情况，直接原样返回。
   */
  private expandedReadingPool(): string[] {
    const pool = this.settings.readingPool;
    if (!pool.some((entry) => !/\.md$/i.test(entry.trim()))) return pool;

    const key = pool.join("\n");
    const now = Date.now();
    const cached = this.readingPoolCache;
    if (cached && cached.key === key && now - cached.at < 60_000) return cached.paths;

    const notes = this.app.vault.getMarkdownFiles().map((file) => file.path);
    const paths = expandReadingPool(pool, notes);
    this.readingPoolCache = { key, at: now, paths };
    return paths;
  }

  /** 设置页上那一行：这几行读物池路径，现在实际展开成几篇。 */
  describeReadingPool(): string {
    const pool = this.settings.readingPool;
    if (!pool.length) return "读物池是空的。可以填笔记路径，也可以直接填一个目录。";
    const expanded = this.expandedReadingPool();
    const folders = pool.filter((entry) => !/\.md$/i.test(entry.trim())).length;
    return folders > 0
      ? `${pool.length} 行（其中 ${folders} 行是目录）→ 实际 ${expanded.length} 篇。`
      : `${expanded.length} 篇。`;
  }

  private readingMarkdown(): string {
    return describeReadingList(this.dayKey(), this.todayReading());
  }

  /** 强提醒页上的飞书那一段；开关关着、或者压根没有快照和地址，就是空串。 */
  private gateFeishuMarkdown(): string {
    if (!this.settings.feishuEnabled || !this.settings.feishuShowOnGate) return "";
    return this.feishuMarkdown();
  }

  /** 强提醒页上「飞书 × 目标树」那一段。没配关键词就是空串，不占位置。 */
  private gateFeishuGoalMarkdown(): string {
    if (!this.settings.feishuEnabled || !this.settings.feishuShowOnGate) return "";
    return this.feishuGoalMarkdown();
  }

  private checkReadingPush(date: Date): void {
    if (!this.settings.readingEnabled || !this.settings.readingPushEnabled) return;
    const atMinute = parseClock(this.settings.readingPushAt);
    if (atMinute === null) return;

    const result = tickDailySlot(this.readingSlot, {
      day: this.dayKey(date),
      minute: minuteOfDay(date),
      atMinute,
    });
    this.readingSlot = result.state;
    if (!result.due) return;

    const picks = this.todayReading();
    if (!picks.length) return;
    this.nudge("nudge", "reading", "今日推荐", summarizeReadingList(picks));
  }

  /** 手动看一眼今天推荐什么。看过就不再到点推了——人已经在看了。 */
  showReading(): void {
    const picks = this.todayReading();
    this.readingSlot = markDailySlotFired(this.dayKey());
    if (!picks.length) {
      new Notice(
        "今天没挑出可推的读物。候选区里没有夜班总结，休息页和读物池也还没配。",
      );
      return;
    }
    new Notice(`今日推荐：\n${summarizeReadingList(picks)}`);
    this.refreshUi();
  }

  // --- 运行时音乐 ---

  private syncMusic(): void {
    this.audio?.sync(this.settings, this.timerState.kind, this.timerState.status);
  }

  async toggleMusic(): Promise<void> {
    this.settings.musicEnabled = !this.settings.musicEnabled;
    await this.saveSettings();
    this.syncMusic();
    new Notice(this.settings.musicEnabled ? "运行时音乐已开。" : "运行时音乐已关。");
  }

  // -------------------------------------------------------------------------
  // 界面
  // -------------------------------------------------------------------------

  async openGoals(): Promise<void> {
    await this.revealView(VIEW_TYPE_GOALS);
  }

  async openCockpit(): Promise<void> {
    await this.revealView(VIEW_TYPE_COCKPIT);
  }

  async openCandidates(): Promise<void> {
    await this.revealView(VIEW_TYPE_CANDIDATES);
  }

  /** 画像页开在主区，和数据台一样——它是拿来读的，侧栏太窄。 */
  async openWechatPersonas(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(WECHAT_PERSONA_VIEW_TYPE);
    if (existing.length) {
      await workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = workspace.getLeaf(true);
    await leaf.setViewState({ type: WECHAT_PERSONA_VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
  }

  async openWechat(): Promise<void> {
    await this.revealView(VIEW_TYPE_WECHAT);
  }

  /** 已经开着就切过去，没开就在右栏开一个。 */
  private async revealView(type: string): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(type);
    if (existing.length) {
      await workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type, active: true });
    await workspace.revealLeaf(leaf);
  }

  /** 数据台开在主区。已经开着就切过去，不重复开。 */
  private async openDashboard(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE);
    if (existing.length > 0) {
      await workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = workspace.getLeaf("tab");
    await leaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
  }

  private refreshUi(): void {
    this.statusBar?.refresh();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_COCKPIT)) {
      const view = leaf.view;
      if (view instanceof CockpitView) view.refresh();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GOALS)) {
      const view = leaf.view;
      if (view instanceof GoalTreeView) view.refresh();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CANDIDATES)) {
      const view = leaf.view;
      if (view instanceof CandidateView) view.refresh();
    }
  }

  private registerCommands(): void {
    // id 沿用 `toggle-pomodoro`：改 id 会把人已经绑好的快捷键弄丢。
    // 名字变了是因为语义变了——这颗按钮不再暂停任何东西（AME-239）。
    this.addCommand({
      id: "open-wechat-personas",
      name: "打开微信画像（React 页）",
      callback: () => void this.openWechatPersonas(),
    });

    this.addCommand({
      id: "open-wechat",
      name: "打开微信群分析（人 / 关系 / 画像）",
      callback: () => void this.openWechat(),
    });

    this.addCommand({
      id: "toggle-pomodoro",
      name: "开工（开始 / 接着跑番茄）",
      callback: () => void this.startOrResume(),
    });

    this.addCommand({
      id: "stop-pomodoro",
      // 名字里补上「本段」两个字：0.10.0 起它结束的是这一段，不是这一天（AME-258）。
      name: "结束本段（休息照常开始，催促照常继续）",
      callback: () => void this.stopTimer(),
    });

    // 收工只在命令面板里，不进面板那两颗按钮——它是唯一能把催促停下来的动作，
    // 应该需要专门找一下才按得到。
    this.addCommand({
      id: "close-day",
      name: "今天收工（停掉今天的催促）",
      callback: () => void this.confirmCloseDay(),
    });

    this.addCommand({
      id: "open-cockpit",
      name: "打开人生驾驶舱",
      callback: () => void this.openCockpit(),
    });

    this.addCommand({
      id: "toggle-zen",
      name: "开关禅定遮罩",
      callback: () => this.toggleZen(),
    });

    this.addCommand({
      id: "switch-mode",
      name: "切换模式（思考优先 / 加速实践）",
      callback: () => {
        const next: ModeId =
          this.settings.activeMode === "thinking-first" ? "accelerated-practice" : "thinking-first";
        void this.switchMode(next);
      },
    });

    this.addCommand({
      id: "record-points",
      name: "记一笔积分",
      callback: () => this.openRecordPoints("earn"),
    });

    this.addCommand({
      id: "spend-points",
      name: "记一笔享乐消耗",
      callback: () => this.openRecordPoints("spend"),
    });

    this.addCommand({
      id: "open-points-ledger",
      name: "打开积分账本",
      callback: () => this.openPointsLedger(),
    });

    this.addCommand({
      id: "reverse-latest-points",
      name: "撤销最近一笔积分",
      callback: () => void this.reverseLatest(),
    });

    this.addCommand({
      id: "write-points-task-note",
      name: "写出积分任务表",
      callback: () => void this.ensureTaskNote(),
    });

    this.addCommand({
      id: "reload-points",
      name: "重读积分账本",
      callback: () => void this.reloadPoints(),
    });

    this.addCommand({
      id: "open-goals",
      name: "打开目标树",
      callback: () => void this.openGoals(),
    });

    this.addCommand({
      id: "attach-pomodoro-goal",
      name: "把番茄挂到某个目标上",
      callback: () => {
        if (!this.settings.goalsEnabled) {
          new Notice("目标树已在设置里关掉了。");
          return;
        }
        if (!this.goals.attachableGoals().length) {
          new Notice("树上还没有可挂的日内目标 / KPI。先去目标树面板拆一层出来。");
          return;
        }
        new GoalPickModal(this.app, this, (goalId) => this.setPomodoroGoal(goalId)).open();
      },
    });

    this.addCommand({
      id: "new-daily-goal",
      name: "新建日内目标",
      callback: () => {
        const parent = this.goals.find(this.pomodoroGoalId) ?? this.goals.attachableGoals()[0];
        new GoalEditModal(this.app, this, { parentId: parent?.id ?? null }).open();
      },
    });

    this.addCommand({
      id: "write-goal-tree",
      name: "写出目标树",
      callback: () => void this.ensureGoalNote(),
    });

    this.addCommand({
      id: "reload-goals",
      name: "重读目标树",
      callback: () => void this.reloadGoals(),
    });

    this.addCommand({
      id: "open-candidates",
      name: "打开夜班候选区",
      callback: () => void this.openCandidates(),
    });

    this.addCommand({
      id: "open-dashboard",
      name: "打开驾驶舱数据台（React）",
      // 数据台是**主区**视图，不是侧栏：它要放得下趋势图和几块面板，
      // 挤进侧栏那一条会两边都难看。
      callback: () => void this.openDashboard(),
    });

    this.addCommand({
      id: "reload-candidates",
      name: "重读夜班候选区",
      callback: () => void this.reloadCandidates(),
    });

    this.addCommand({
      id: "run-bedtime-review",
      name: "睡前复盘（取数 → 出草稿 → 投候选区）",
      callback: () => void this.runReview(),
    });

    this.addCommand({
      id: "open-review-material",
      name: "打开今天的复盘素材",
      callback: () => void this.openReviewMaterial(),
    });

    // 只取数、不出草稿。夜班要的就是这一份，人也可以随时手动补一次。
    this.addCommand({
      id: "write-review-material",
      name: "只生成复盘素材包（给夜班用，不出草稿）",
      callback: () => void this.writeReviewMaterial("manual"),
    });

    this.addCommand({
      id: "open-feishu",
      name: "打开飞书金字塔表格",
      callback: () => void this.openFeishu(),
    });

    this.addCommand({
      id: "open-feishu-summary",
      name: "打开飞书上那一页【总结】",
      callback: () => void this.openFeishuSummary(),
    });

    this.addCommand({
      id: "refresh-feishu-summary",
      name: "更新飞书【总结】页（Convex 主路径）",
      callback: () => void this.refreshFeishuSummary(),
    });

    this.addCommand({
      id: "reload-feishu",
      name: "重读飞书快照",
      callback: () => void this.reloadFeishu(),
    });

    this.addCommand({
      id: "pull-feishu",
      name: "备用：拉一份新的飞书快照（旧 webhook + Easy Git）",
      callback: () => void this.pullFeishuSnapshot(),
    });

    // 秒哒（AME-272）。手动那一条排在前面：「也可以，手动去拉取」是他的原话，
    // 而自动那一条在设置里，命令面板上不需要它的开关。
    this.addCommand({
      id: "pull-miaoda",
      name: "拉一次秒哒「5 分钟写作」",
      callback: () => void this.pullMiaoda(),
    });

    this.addCommand({
      id: "pull-miaoda-full",
      name: "整份重拉秒哒（页面看着不对时用）",
      callback: () => void this.pullMiaoda({ full: true }),
    });

    this.addCommand({
      id: "open-miaoda-today",
      name: "打开今天那一页秒哒写作",
      callback: () => void this.openMiaodaToday(),
    });

    this.addCommand({
      id: "test-ai",
      name: "测一次 AI 接口",
      callback: () => void this.testAi(),
    });

    this.addCommand({
      id: "open-ai-log",
      name: "看 AI 调用记录",
      callback: () => new AiLogModal(this.app, this).open(),
    });

    this.addCommand({
      id: "test-push",
      name: "试推一条（看看渠道通不通）",
      callback: () => void this.testPush(),
    });

    this.addCommand({
      id: "toggle-mute",
      name: "静音 / 恢复推送",
      callback: () => void this.toggleMute(),
    });

    this.addCommand({
      id: "open-gate",
      name: "现在过一遍复工强提醒页",
      callback: () => {
        if (!this.settings.gateEnabled) {
          new Notice("复工强提醒页已在设置里关掉了。");
          return;
        }
        this.openGateNow();
      },
    });

    this.addCommand({
      id: "show-reading",
      name: "今天推荐读什么",
      callback: () => this.showReading(),
    });

    this.addCommand({
      id: "lock-screen",
      name: "立刻锁屏（强制休息）",
      callback: () => {
        if (!this.lockSupported) {
          new Notice(`锁不了屏：${this.describeLockSupport()}`);
          return;
        }
        void this.lockScreen();
      },
    });

    // 演练排在最前面：验「收工前三分钟会怎样」不该要求人真的坐等 22 分钟。
    this.addCommand({
      id: "enforce-drill",
      name: "演练一次强制干扰（20 秒）",
      callback: () => this.enforceDrill(),
    });

    this.addCommand({
      id: "enforce-stop",
      name: "停止强制干扰",
      callback: () => this.stopEnforcement(),
    });

    this.addCommand({
      id: "test-hud",
      name: "测一次悬浮提示",
      callback: () => this.testHud(),
    });

    this.addCommand({
      id: "toggle-music",
      name: "开关运行时音乐",
      callback: () => void this.toggleMusic(),
    });

    this.addCommand({
      id: "show-current-cell",
      name: "报一下当前时段",
      callback: () => {
        const state = this.timerState;
        const tail =
          state.status === "idle"
            ? "番茄未开始"
            : `${SEGMENT_LABELS[state.kind]} 第 ${state.pomodoroIndex} 个`;
        new Notice(`${this.describeCurrentCell(new Date())} · ${tail}`);
      },
    });
  }
}
