// 纯数据：设置结构与默认值。core 下不许 import "obsidian"，否则 node --test 跑不起来。

import { isNudgeLevel } from "./nudge";
import { cleanSecretValue } from "./secret";
import type { NudgeSettings } from "./nudge";
import { isGateFrequency } from "./gate";
import type { GateSettings } from "./gate";
import { isLockMethod, isLockTrigger } from "./lock";
import type { LockSettings } from "./lock";
import type { MusicSettings } from "./music";
import type { EnforceSettings } from "./enforce";
import type { AttentionSettings } from "./attention";
import { isHudCorner } from "./hud";
import type { HudSettings } from "./hud";
import { isExpertise } from "./expertise";
import type { ExpertiseSettings } from "./expertise";
import type { SessionSettings } from "./session";
import { AI_PRESETS, normalizeAiProfile } from "./ai";
import type { AiSettings } from "./ai";

/**
 * data.json 的当前世代。加一档就要在 `normalizeSettings` 里补一段迁移，
 * 并且那段迁移必须**只认没被人改过的值**——改过就是有意的，不许动。
 *
 * 1 = 0.9.0（AME-244）：两种模式的基准时长对调。
 * 2 = 0.19.0（AME-317）：默认数据根换成中性的 `LifeCockpit/`。
 *     显式存过的路径一个字不动；data.json 里**缺失**的路径项按世代 1 的位置
 *     原样钉住（`pinV1DefaultPaths`）——那是他盘上文件此刻就在的地方。
 */
export const SETTINGS_VERSION = 2;

export type ModeId = "thinking-first" | "accelerated-practice";

export const MODE_IDS: ModeId[] = ["thinking-first", "accelerated-practice"];

export const MODE_LABELS: Record<ModeId, string> = {
  "thinking-first": "思考优先",
  "accelerated-practice": "加速实践",
};

export interface ModeSetting {
  workMinutes: number;
  breakMinutes: number;
  /** 每 pomodorosPerLongBreak 个番茄之后的长休息 */
  longBreakMinutes: number;
  pomodorosPerLongBreak: number;
  /** 提醒主题节律：多久推一次主题提醒 */
  reminderIntervalMinutes: number;
  /** 主题按此列表轮换。默认取日记模板《今日每日任务》的六维。 */
  themeCycle: string[];
}

export interface BreakPageSetting {
  id: string;
  label: string;
  /** vault 内笔记路径；留空则该页只显示标题 */
  notePath: string;
}

export interface RhythmSegmentSetting {
  id: string;
  label: string;
  /** "HH:MM"，end <= start 视为跨零点 */
  start: string;
  end: string;
}

/** 五行列如何对应到日期。 */
export type PhaseMapping = "weekday" | "cycle5";

export interface LifeCockpitSettings
  extends NudgeSettings,
    GateSettings,
    LockSettings,
    MusicSettings,
    EnforceSettings,
    AttentionSettings,
    HudSettings,
    ExpertiseSettings,
    SessionSettings,
    AiSettings {
  /**
   * data.json 的世代号。**只用来跑一次性迁移**，不是功能开关。
   *
   * 加它是因为「改默认值救不回已经存过一次的机器」（AME-239 的教训）：
   * 0.9.0 把两种模式的基准时长对调了（AME-244），而对调之后新旧两组值都是
   * 合法配置——没有世代号的话，迁移要么不敢做，要么会在以后某天把人**手动**
   * 调回旧值的设置又悄悄翻一次。
   */
  settingsVersion: number;
  /**
   * 首次运行引导放过了没有。**只要弹过一次就置真**——跳过也算做过选择，
   * 不许每次启动都拦人。想重来的人删掉 data.json 里这一个键。
   */
  onboardingDone: boolean;
  activeMode: ModeId;
  modes: Record<ModeId, ModeSetting>;
  /**
   * 间歇节奏（AME-244）：单数番茄跑基准时长，双数番茄按 `pomodoroAlternateRatio` 缩短。
   * 判定在 `timer.ts` 的 `cycleRatio`。默认关——它是一种节奏偏好，不是默认作息。
   */
  pomodoroAlternateEnabled: boolean;
  /** 双数番茄的倍数，0.1–1。原话是「一半」，所以默认 0.5 */
  pomodoroAlternateRatio: number;
  /** 14 小时工作制拆出来的番茄目标分钟数 */
  dailyFocusTargetMinutes: number;
  /** 14 小时窗口，仅用于显示当日节奏 */
  dailyWindowHours: number;
  /**
   * 界面字号缩放。驾驶舱、目标树、候选区、遮罩、悬浮框全走这一个倍数。
   *
   * 出处（AME-239）：「整体的字体，应该要大一点——因为我的 Obsidian 面板的
   * 【Interface——Advanced——Zoom Level】，是缩放到了【83%】左右。」
   * 所以默认 1.2 ≈ 1 / 0.83：把那道全局缩放抵回来。
   *
   * 它是**每台机器一份的偏好**，不是内容——换一台电脑就该重新调，
   * 所以放在设置里、单独一页，不写进任何落盘的数据。
   */
  uiFontScale: number;
  zenEnabled: boolean;
  /**
   * 工作段也盖遮罩。**默认关**：Obsidian 是工作台，工作的时候把工作台盖住是本末倒置。
   * 禅定是「一段活干完之后的休息与静心」，所以遮罩默认只在休息段出现。
   * 想要工作段也进全屏的人可以自己打开——那是偏好，不是默认。
   */
  zenCoverWork: boolean;
  breakPages: BreakPageSetting[];
  rhythmSegments: RhythmSegmentSetting[];
  rhythmNoticesEnabled: boolean;
  themeNoticesEnabled: boolean;
  phaseMapping: PhaseMapping;
  /** phaseMapping = cycle5 时的锚点日期与该日所在列（0 = 金一） */
  cycleAnchorDate: string;
  cycleAnchorPhase: number;
  /** 番茄流水落盘目录（vault 相对路径） */
  ledgerFolder: string;
  /** 几点算新的一天。14 小时工作制会跨零点，所以默认 4 点而不是 0 点。 */
  dayRolloverHour: number;

  // --- 积分账本（R2） ---
  pointsEnabled: boolean;
  /** 月账 Markdown 落盘目录（vault 相对路径），一个月一份 */
  pointsFolder: string;
  /** 预设任务与分值维护在这篇笔记里 */
  pointsTaskNote: string;
  /** 番茄跑满自动入账 */
  pomodoroAutoAward: boolean;
  /** 番茄没选任务时按哪一项计分 */
  pomodoroDefaultTaskId: string;
  /** 把当日积分快照镜像进 R1 日档 JSON 的 points 位，给 R5 复盘一次读全 */
  mirrorPointsIntoDayLedger: boolean;

  // --- 目标树（R3） ---
  goalsEnabled: boolean;
  /** 整棵目标树落在这一篇笔记里（缩进列表 Markdown，人可读可改） */
  goalTreeNote: string;
  /**
   * 番茄 / 记账挂了目标时，这一笔的「任务」写成 `goal:<节点 id>` 指回目标树。
   * 关掉的话账本照旧按计分规则记，目标只留在番茄流水的 goalId 上。
   */
  attributePointsToGoal: boolean;

  // --- 夜班候选区（R4） ---
  candidatesEnabled: boolean;
  /** 夜班产物落这里，一天一个日期目录；拍板后原件移进它下面的 `_归档/` */
  candidatesFolder: string;
  /** 拍板留痕里的「操作者」。默认就是坐在 Obsidian 前面的那个人。 */
  candidateActor: string;

  // --- 睡前复盘（R5） ---
  reviewEnabled: boolean;
  /** 当日日记所在目录，一天一篇 `YYYY-MM-DD.md`。复盘正文的落点。 */
  reviewJournalFolder: string;
  /** 取数汇总落这里，一天一份 JSON。**AI 那一侧读的就是它** */
  reviewMaterialFolder: string;
  /** 「不贰过」写进这一篇。宁可少记，不要把错题本灌成流水账。 */
  reviewMistakeNote: string;
  /** 睡前提醒时间 "HH:MM"。默认对齐节律表里睡觉段的起点。 */
  reviewReminderAt: string;
  reviewReminderEnabled: boolean;
  /**
   * 到了睡前提醒那一刻**自动把素材包写出来**（AME-258 第 19.2 条）。
   *
   * 起因是夜班连着几天报「没有素材包：……/复盘素材/2026-08-17.json 不存在」。
   * 原因不是 bug：素材包以前只在人**手动发起复盘**那一刻才写，人没发起就没有文件，
   * 23:30 的夜班自然什么都读不到。于是那条链的第一环挂在「人今晚记不记得点一下」上。
   *
   * 打开之后素材包每天到点自己落盘（只取数、只写这一个 JSON，**不出草稿、不投候选区**
   * ——那两件事仍然是人发起的）。默认开：一份没人看的取数 JSON 不值得让整条夜班停摆。
   */
  reviewMaterialAutoWrite: boolean;

  // --- 飞书金字塔表格（AME-258 第 19.1 条） ---
  // 「我仍然在飞书表格上面做记录」——所以插件**不**在这里造第二张任务表，
  // 只做两件事：给一个点得开的入口，读一份别人导出好的快照。
  feishuEnabled: boolean;
  /** 表格 / 文档地址。强提醒页、面板、命令面板上点得开的就是它 */
  feishuSheetUrl: string;
  /**
   * 【总结】那一页的地址（AME-271 第 28 条），形如 `<表格地址>?sheet=<sheetId>`。
   *
   * 那一页由 `write_feishu_summary.py` 写出来，插件负责点得开并通过 Convex 主链触发刷新。
   * 地址仍然手填：飞书页面本身要能「不开 Obsidian、不开后端也能看」，Convex 只负责
   * 编排和回执，不成为查看页面的前置依赖。
   */
  feishuSummarySheetUrl: string;
  /** 快照目录，一天一份 `YYYY-MM-DD.json`；也认目录里那份 `latest.json` */
  feishuSnapshotFolder: string;
  /** 复工强提醒页上列出当天的表格条目 */
  feishuShowOnGate: boolean;
  /** 进复盘素材包，AI 那一侧就看得到「今天到底在做什么事」 */
  feishuIntoReview: boolean;
  /**
   * 按目标树分组显示（AME-258 第 22.2 条第 1 点）。目标项上的
   * `[飞书:: 关键词]` 决定哪条算在哪支目标上。
   */
  feishuGroupByGoal: boolean;
  /**
   * 旧版拉取快照的 webhook 地址（AME-258 第 22.2 条第 2 点）。
   *
   * 这是 Convex 主链不可用时的下位补充：按一下，对面那台机器去导飞书表、
   * 把 JSON 写进仓库、推上去。**留空则读环境变量 `LIFE_COCKPIT_FEISHU_PULL_WEBHOOK`**，
   * 两处都空就是「没配这条备用路」——面板照实说，不猜地址。
   */
  feishuPullWebhook: string;
  /**
   * 触发之后等多少秒。等的是**盘上那份快照变新**，不是对面回话——
   * 「WebHook 不太好获得具体的一个完成状态」这一条，答案是不去问它。
   */
  feishuPullWaitSeconds: number;
  // --- 秒哒「5 分钟写作」（AME-272 第 26 条） ---
  // 「把秒哒应用——接口，给直接接过来？ 放到 Obsidian 的插件中去」。
  // 拉回来的是头脑风暴的毛坯（含手机语音识别的错字），落到给人看的那一块，
  // 一天一页、一段写作一个大标题。**搬走的段落不会被再拉回来**。
  miaodaEnabled: boolean;
  /**
   * 表 `writing_sessions` 的 PostgREST 地址。**没有预置值**（AME-315 审查 S2）：
   * 这个仓库是公开的，而地址路径里嵌着秒哒项目的 ID——预置它等于把项目暴露出去。
   * 空串是合法状态＝「还没配」，面板会照实说、不会拿半截地址发请求。
   */
  miaodaEndpoint: string;
  /**
   * Supabase 的 apikey（同时用作 Bearer）。**没有内置默认值**：仓库是公开的。
   * 留空则读环境变量 `LIFE_COCKPIT_MIAODA_KEY`，两处都空就是「没配这条路」。
   */
  miaodaApiKey: string;
  /** 落点目录，一天一份 `YYYY-MM-DD.md`，同步索引也在这里面 */
  miaodaFolder: string;
  /** 「（在 Obsidian 插件中）可以设置——自动拉取？」——就是它，默认关 */
  miaodaAutoPull: boolean;
  /** 多久自动拉一次 */
  miaodaAutoPullMinutes: number;
  /**
   * 一页拉几条。分页靠它，拉多少条不靠它——「其实可以，把 limit 放大一点、
   * 或者删除？」的答案是：不用放大，翻页翻到底，而且平时只拉动过的那几条。
   */
  miaodaPageSize: number;
  /**
   * 连空白记录也写进来。实测 188 条里有 27 条是**点开了没写**（正文空、字数 0），
   * 默认不落盘——落地区里塞 27 个空壳，人第一眼看到的就是噪音。
   * 打开它这些也会补上（跳过的从不进同步索引，所以补得回来）。
   */
  miaodaIncludeEmpty: boolean;
  /**
   * Convex 同步（AME-267）。默认**关**——它要一个服务地址和一个令牌，
   * 而这两样都该由人明确点头，和 AI 接口那一层同一条规矩。
   *
   * ⚠️ **它是同步层，不是运行时依赖。** 关着、连不上、令牌过期——
   * 番茄照跑，一个功能都不少。落盘那条路一个字都没改。
   */
  convexEnabled: boolean;
  /**
   * 形如 `https://<部署名>.convex.cloud`。**留空则读环境变量
   * `LIFE_COCKPIT_CONVEX_URL`**，两处都空就是「没配」——面板照实说，不猜地址。
   */
  convexUrl: string;
  /**
   * 设备令牌。**凭据只有设置项和环境变量两处来源**
   * （`LIFE_COCKPIT_CONVEX_TOKEN`），没有第三处，也没有内置默认值。
   *
   * 它落在 vault 的 `.obsidian/plugins/life-cockpit/data.json`，
   * **不在 2A-META 仓库内**，不会随仓库公开。
   */
  convexToken: string;
  /** 多久推一次出站队列。默认 30 秒——人感觉不到，断网攒着也不会堆太久。 */
  convexSyncSeconds: number;
  /**
   * 等到之前先跑一下这条命令把仓库拉下来。默认 Easy Git 的「Sync all mappings」。
   *
   * **复用 Easy Git 已经配好的 GitHub 凭据，插件自己一个 token 都不存**——
   * 「你可以复用 EasyGit 的相关 github 的 token 的凭证？我猜」，能，但方式是
   * 调它的命令，不是抄它的密钥。命令 id 认不出来就退回「你自己去 Easy Git 拉一下」。
   */
  feishuPullCommandId: string;

  // --- 推动器（R6） ---
  // 分级、静音、免打扰、冷却、配额这五项在 NudgeSettings 里；渠道配置在这儿。
  // **凭据一律没有默认值**：留空就是缺配置，插件停下来说缺什么，不猜也不写死。
  /** 系统通知（Electron / 浏览器 Notification）。唯一不需要凭据的渠道 */
  nudgeSystemEnabled: boolean;
  /** 飞书自定义机器人 */
  nudgeFeishuEnabled: boolean;
  /** webhook 地址；留空则读环境变量 LIFE_COCKPIT_FEISHU_WEBHOOK */
  nudgeFeishuWebhook: string;
  /** 签名密钥；机器人没开签名校验就留空。留空则读 LIFE_COCKPIT_FEISHU_SECRET */
  nudgeFeishuSecret: string;
  /** 通用 webhook：邮件网关、工单系统之类，POST 一份 JSON 过去 */
  nudgeWebhookEnabled: boolean;
  /** 留空则读环境变量 LIFE_COCKPIT_WEBHOOK_URL */
  nudgeWebhookUrl: string;

  // --- 复工强提醒页（R6） ---
  // 频率、停留秒数、能否跳过、闲置阈值在 GateSettings 里；页面在这儿。
  /** 强提醒页轮换的页面。结构和休息页一样，但两者各配各的 */
  gatePages: BreakPageSetting[];
  /** 强提醒页上一并列出今日推荐 */
  gateShowReading: boolean;

  // --- 每日推荐读物（R6） ---
  readingEnabled: boolean;
  /** 一天推几条 */
  readingCount: number;
  /** 读物池：一串 vault 笔记路径，可空 */
  readingPool: string[];
  readingPushEnabled: boolean;
  /** 到点推一次今日推荐 "HH:MM" */
  readingPushAt: string;

  // --- 强制干扰（AME-238） ---
  // 开关与节奏在 EnforceSettings 里，判「人在不在」的口径在 AttentionSettings 里。
  //
  // **这一组的默认值是开的，而且不看老的 `lockEnabled`。** 两个原因：
  //   1. AME-238 的原话是「那这里的强约束的用处何在」——默认关掉的强制约束
  //      等于没有这个功能；
  //   2. `lockEnabled` 在已经装过 0.6.x 的机器上早就以 false 存进 data.json 了，
  //      改它的默认值对那台机器一点作用都没有。新键才吃得到新默认值。
  //   老的 `lockEnabled` / `lockTrigger` 管的仍然是 R6 那条「休息段提议锁屏」，
  //   两条路互不干扰，各有各的开关。
}

/** 日记模板《今日每日任务》的六维，原样搬过来做提醒主题。 */
export const SIX_DIMENSIONS = [
  "诚 · 精诚所至，金石为开",
  "爱 · 主动珍视某个对象，并愿意被它改变",
  "当 · 回到此身、此刻、此事",
  "意 · 把自己从惯性中夺回",
  "诚 · 不欺心回看：今天哪些是真做",
  "体 · 热爱密度的肉身底盘",
];

/**
 * 驾驶舱数据区的**默认**根目录。名字是中性的——这是给陌生人的：装上插件，
 * vault 里长出来的应该是 `LifeCockpit/`，而不是以别人私人知识库命名的文件夹
 * （AME-317）。「有一块地方是 AI 够得着的」这个概念不变，换掉的只是那块地的名字；
 * 首次运行引导里「数据落在哪个文件夹」一问改的就是它（`OnboardingModal`）。
 *
 * 老机器什么都不用做：data.json 里存着显式路径，升级一个字都不会动——
 * 世代 2 的迁移把这条锁死（见 `pinV1DefaultPaths`）。仓库主人自己的 vault
 * 继续由他自己的配置说话。
 */
export const COCKPIT_ROOT = "LifeCockpit";

/** 本插件自己落盘的每一项。全部挂在同一个根之下，子结构固定。 */
export interface CockpitPaths {
  ledgerFolder: string;
  pointsFolder: string;
  pointsTaskNote: string;
  goalTreeNote: string;
  candidatesFolder: string;
  reviewJournalFolder: string;
  reviewMaterialFolder: string;
  /** 错题本是复盘回写的去处之一；新装用户默认落在自己的数据区里 */
  reviewMistakeNote: string;
  feishuSnapshotFolder: string;
  miaodaFolder: string;
}

/**
 * 由根目录推出整组落盘路径。默认值和首次运行引导共用这一个函数，
 * 所以不管根叫什么，底下长出来的子结构永远是同一套：
 * 番茄流水/ 积分账本/ 目标树.md 候选区/ 复盘日记/ 复盘素材/ 飞书快照/ 秒哒写作/。
 * 根为空或只剩斜杠时退回中性默认。
 */
export function cockpitPaths(root: string): CockpitPaths {
  const base = root.trim().replace(/\/+$/, "") || COCKPIT_ROOT;
  return {
    ledgerFolder: `${base}/番茄流水`,
    pointsFolder: `${base}/积分账本`,
    pointsTaskNote: `${base}/积分账本/积分任务表.md`,
    goalTreeNote: `${base}/目标树.md`,
    candidatesFolder: `${base}/候选区`,
    reviewJournalFolder: `${base}/复盘日记`,
    reviewMaterialFolder: `${base}/复盘素材`,
    reviewMistakeNote: `${base}/AI时代错题本-不贰过.md`,
    feishuSnapshotFolder: `${base}/飞书快照`,
    miaodaFolder: `${base}/秒哒写作`,
  };
}

const CURRENT_PATHS = cockpitPaths(COCKPIT_ROOT);

/**
 * 世代 1 的默认路径（0.19.0 之前）。那时的默认根带着仓库主人私人知识库的名字。
 * 这张表**只给世代迁移用**（`pinV1DefaultPaths`）：升级上来、又没显式存过
 * 某条路径的机器，缺哪项按这一代的原样补哪项——补的不是新默认值，
 * 是他盘上文件此刻就在的位置。
 */
const V1_DEFAULT_PATHS: CockpitPaths = {
  ...cockpitPaths("Root/【2A-META】AI-First时代，知识库（toAI完全公开）/驾驶舱运行区"),
  // 错题本当年不在运行区，在主干知识（AI史书）里——照旧。
  reviewMistakeNote:
    "Root/【2A-META】AI-First时代，知识库（toAI完全公开）/AI史书/AI时代错题本-不贰过.md",
};

/**
 * 反推数据根用的「路径尾缀」。首次运行引导拿它预填「数据落在哪个文件夹」：
 * 老机器显示自己现在真正的根（确认不动就一个字不改），新机器显示中性默认。
 *
 * 错题本不参加投票：它历史上就长在根之外（AI史书），投了只会捣乱。
 */
const ROOT_VOTE_SUFFIXES: ReadonlyArray<readonly [keyof CockpitPaths, string]> = [
  ["ledgerFolder", "/番茄流水"],
  ["pointsFolder", "/积分账本"],
  ["goalTreeNote", "/目标树.md"],
  ["candidatesFolder", "/候选区"],
  ["reviewJournalFolder", "/复盘日记"],
  ["reviewMaterialFolder", "/复盘素材"],
  ["feishuSnapshotFolder", "/飞书快照"],
  ["miaodaFolder", "/秒哒写作"],
];

/**
 * 从现有设置反推「数据根」。十条路径挂在同一个根下才推得出来；
 * 手工改乱了的配置（两条路径各奔东西）没有唯一答案，返回 null——调用方退回中性默认。
 */
export function inferCockpitRoot(settings: LifeCockpitSettings): string | null {
  const votes = new Map<string, number>();
  for (const [key, suffix] of ROOT_VOTE_SUFFIXES) {
    const value = settings[key];
    if (typeof value !== "string" || !value.endsWith(suffix)) continue;
    const root = value.slice(0, -suffix.length);
    votes.set(root, (votes.get(root) ?? 0) + 1);
  }
  if (votes.size !== 1) return null;
  const [root] = votes.keys();
  return root || null;
}

/**
 * 0.6.x 之前的落盘位置全在仓库外。这里把旧默认值一一对到当前的位置，
 * 在 `normalizeSettings` 里做一次性迁移。
 *
 * **只认「一字不差等于旧默认值」**——自己在设置里改过的路径不动，改过就是有意的。
 */
const LEGACY_PATHS: Readonly<Record<string, string>> = {
  "Root/每日Journal/番茄流水": CURRENT_PATHS.ledgerFolder,
  "Root/每日Journal/积分账本": CURRENT_PATHS.pointsFolder,
  "Root/每日Journal/积分账本/积分任务表.md": CURRENT_PATHS.pointsTaskNote,
  "Root/每日Journal/目标树.md": CURRENT_PATHS.goalTreeNote,
  "Root/候选区": CURRENT_PATHS.candidatesFolder,
  "Root/每日Journal/日记": CURRENT_PATHS.reviewJournalFolder,
  "Root/每日Journal/复盘素材": CURRENT_PATHS.reviewMaterialFolder,
};

/**
 * 0.9.0 起两种模式的基准时长对调了（AME-244）：
 *
 *   「我想了一下，似乎【思考优先】应该是 25 分钟的时长基准；而【加速实践】应该是
 *    45 分钟的时长基准。（思考需要更多的思考和调节时间、连续思考 45 分钟是不现实的；
 *    而【加速实践】更多的是一种冲劲，连续 45 分钟是一种正常的表现。）」
 *
 * 对调的是**整组节奏**（工作 / 休息 / 长休息 / 几个一轮 / 提醒间隔），不是只挪一个数字：
 * 25 分钟的段配 30 分钟的提醒、45 分钟的段配 45 分钟的提醒，这两对本来就是配好的，
 * 拆开会得到「一段跑 45 分钟、中间被提醒打断两次」这种谁都不想要的组合。
 * **提醒主题（themeCycle）不跟着走**——那几句写的是这个模式的心法，和它跑多久无关。
 */
const OLD_MODE_TIMINGS: Readonly<Record<ModeId, Omit<ModeSetting, "themeCycle">>> = {
  "accelerated-practice": {
    workMinutes: 25,
    breakMinutes: 5,
    longBreakMinutes: 15,
    pomodorosPerLongBreak: 4,
    reminderIntervalMinutes: 30,
  },
  "thinking-first": {
    workMinutes: 45,
    breakMinutes: 10,
    longBreakMinutes: 25,
    pomodorosPerLongBreak: 3,
    reminderIntervalMinutes: 45,
  },
};

export const DEFAULT_SETTINGS: LifeCockpitSettings = {
  settingsVersion: SETTINGS_VERSION,
  onboardingDone: false,
  activeMode: "accelerated-practice",
  modes: {
    // 加速实践 = 一股冲劲跑到底：45 + 10，三个一轮。「连续 45 分钟是一种正常的表现。」
    "accelerated-practice": {
      workMinutes: 45,
      breakMinutes: 10,
      longBreakMinutes: 25,
      pomodorosPerLongBreak: 3,
      reminderIntervalMinutes: 45,
      themeCycle: [
        "诚 · 真做：30 分钟干真活，不换题、不刷信息",
        "意 · 一轮 25 分钟推进，不换目标、不刷信息",
        "体 · 起身：一次哑铃 / 拉伸 / 走动",
        "爱 · 为它做 30 分钟真实投入",
      ],
    },
    // 思考优先 = 日记模板写死的 25 + 5。「连续思考 45 分钟是不现实的。」
    "thinking-first": {
      workMinutes: 25,
      breakMinutes: 5,
      longBreakMinutes: 15,
      pomodorosPerLongBreak: 4,
      // 「每半个小时，提供一波想法。」
      reminderIntervalMinutes: 30,
      themeCycle: [
        "当 · 10 分钟无输入临在：不手机、不 AI、不资料",
        "意 · 我选择 ___，放弃 ___",
        "诚 · 今天我最该认真对待的一件真事是什么",
        "爱 · 今天我愿意热爱的是 ___，因为 ___",
      ],
    },
  },
  // 间歇节奏默认关：它是一种节奏偏好，不是默认作息（AME-244 说的是「增加一个【切换】」）。
  pomodoroAlternateEnabled: false,
  pomodoroAlternateRatio: 0.5,
  // 「重启 Obsidian 是像家常便饭一样的事情」——所以接得回来是默认行为，不是选项。
  sessionRestoreEnabled: true,
  sessionGraceMinutes: 5,
  // 「默认是【新手-开箱即用模式】」——原话。
  expertise: "beginner",
  dailyFocusTargetMinutes: 560,
  dailyWindowHours: 14,
  // 1 / 0.83 ≈ 1.2：把 Obsidian 那道 83% 的全局缩放抵回来（AME-239）。
  uiFontScale: 1.2,
  zenEnabled: true,
  zenCoverWork: false,
  breakPages: [
    { id: "meditation", label: "冥想", notePath: "" },
    { id: "reading", label: "精品阅读", notePath: "" },
    { id: "health", label: "健康养生", notePath: "" },
  ],
  // 日记模板那张表的行：其它(早起) / 09-12 / 13-17 / 18-22 / 其它(睡觉)。
  // 12-13 和 17-18 表里是空的，这里也不补——空档就是没有时段。
  rhythmSegments: [
    { id: "morning", label: "早起", start: "05:00", end: "09:00" },
    { id: "three-hour", label: "三小时工作日", start: "09:00", end: "12:00" },
    { id: "even-day", label: "双数日", start: "13:00", end: "17:00" },
    { id: "odd-day", label: "单数日", start: "18:00", end: "22:00" },
    { id: "sleep", label: "睡觉", start: "22:00", end: "05:00" },
  ],
  rhythmNoticesEnabled: true,
  themeNoticesEnabled: true,
  phaseMapping: "weekday",
  cycleAnchorDate: "2026-01-01",
  cycleAnchorPhase: 0,
  ledgerFolder: CURRENT_PATHS.ledgerFolder,
  dayRolloverHour: 4,
  pointsEnabled: true,
  pointsFolder: CURRENT_PATHS.pointsFolder,
  pointsTaskNote: CURRENT_PATHS.pointsTaskNote,
  pomodoroAutoAward: true,
  pomodoroDefaultTaskId: "pomodoro",
  mirrorPointsIntoDayLedger: true,
  goalsEnabled: true,
  goalTreeNote: CURRENT_PATHS.goalTreeNote,
  attributePointsToGoal: true,
  candidatesEnabled: true,
  // 新装用户的候选区在自己数据区里；仓库主人那份和 tools/news-inbox 共址，
  // 由他 data.json 里的显式路径说话，不靠这里的默认值。
  candidatesFolder: CURRENT_PATHS.candidatesFolder,
  candidateActor: "人",
  reviewEnabled: true,
  // 驾驶舱自己的复盘日记。复盘是人机共有的产物（AI 出草稿、人拍板），
  // 落在人的数据区里；`Root/每日Journal/` 那种私人日记目录，插件一个字都不往那儿写。
  reviewJournalFolder: CURRENT_PATHS.reviewJournalFolder,
  reviewMaterialFolder: CURRENT_PATHS.reviewMaterialFolder,
  reviewMistakeNote: CURRENT_PATHS.reviewMistakeNote,
  // 节律表里睡觉段 22:00 起，睡前复盘就卡在这个点上。
  reviewReminderAt: "22:00",
  reviewReminderEnabled: true,
  reviewMaterialAutoWrite: true,

  // 飞书那一摊默认开着但**一处地址都没填**——和推动器的凭据同一个规矩：
  // 插件不编造地址。没填就是「没有这一栏」，别的照跑。
  feishuEnabled: true,
  feishuSheetUrl: "",
  feishuSummarySheetUrl: "",
  feishuSnapshotFolder: CURRENT_PATHS.feishuSnapshotFolder,
  feishuShowOnGate: true,
  feishuIntoReview: true,
  feishuGroupByGoal: true,
  feishuPullWebhook: "",
  // 对面要开一台机器、跑一次导出、推一次仓库，本机再拉一次。三分钟是留了余量的等法；
  // 超时也不算失败（见 tickFeishuPull），所以宁可等长一点，不要早早报一句「没成」。
  feishuPullWaitSeconds: 180,
  feishuPullCommandId: "easy-git:sync-all",

  // 秒哒：默认开着但**没有 key**——和飞书那一摊同一个规矩，开着不等于会发请求。
  // 自动拉取默认关：定时往外网发请求这件事，该由人明确点头。
  miaodaEnabled: true,
  miaodaEndpoint: "",
  miaodaApiKey: "",
  miaodaFolder: CURRENT_PATHS.miaodaFolder,
  miaodaAutoPull: false,
  // 一小时一次。那个 APP 一天也就写几段，更密只是在空跑；增量拉一次几乎不花什么。
  miaodaAutoPullMinutes: 60,
  miaodaPageSize: 200,
  miaodaIncludeEmpty: false,

  // Convex 同步：默认**关**，且一处凭据都没预置（仓库是公开的）。
  convexEnabled: false,
  convexUrl: "",
  convexToken: "",
  convexSyncSeconds: 30,

  // AI 接口：默认**关**。它要花钱、要密钥，而这两样都该由人明确点头。
  // 预置档位只带地址和模型名，密钥一律空（仓库是公开的）。
  aiEnabled: false,
  aiActiveProfile: AI_PRESETS[0].id,
  aiProfiles: AI_PRESETS.map((profile) => ({ ...profile })),
  aiReviewDraft: true,
  // 留痕默认开：它只落在插件自己的目录里（不进 2A-META 仓库），不花钱、不发请求，
  // 而「看不见请求和返回」正是 AME-258 第 22.1 条要解决的事。
  aiLogEnabled: true,
  aiLogKeepDays: 7,

  nudgeEnabled: true,
  nudgeMuted: false,
  // 默认从最低一级开始推。嫌吵先往上调阈值，再考虑整个关掉。
  nudgeMinLevel: "info",
  // 免打扰对齐节律表的睡觉段：22:00 睡、05:00 起。
  nudgeQuietFrom: "22:00",
  nudgeQuietTo: "05:00",
  nudgeQuietBypassHard: true,
  nudgeCooldownMinutes: 10,
  // 一天 24 条：14 小时工作制下大约每小时不到两条。超了就攒着，不炸。
  nudgeDailyCap: 24,
  nudgeSystemEnabled: true,
  nudgeFeishuEnabled: false,
  nudgeFeishuWebhook: "",
  nudgeFeishuSecret: "",
  nudgeWebhookEnabled: false,
  nudgeWebhookUrl: "",

  gateEnabled: true,
  gateFrequency: "every-resume",
  gateDwellSeconds: 8,
  gateAllowSkip: true,
  gateIdleMinutes: 20,
  gateRequireAttention: true,
  // 默认指向日记模板里那张每日任务清单——「每天去看」的就是它。路径由人自己填。
  gatePages: [{ id: "daily", label: "今日每日任务", notePath: "" }],
  gateShowReading: true,

  readingEnabled: true,
  readingCount: 3,
  readingPool: [],
  readingPushEnabled: true,
  // 三小时工作日开工前半小时推一次，人坐下来的时候清单已经在了。
  readingPushAt: "08:30",

  // 锁屏是不可逆的打断，默认关。开之前先把倒计时和豁免看一眼。
  lockEnabled: false,
  lockTrigger: "long-break",
  lockCountdownSeconds: 20,
  lockMethod: "auto",
  lockDeferMinutes: 10,

  // 强制干扰：默认开着，见 LifeCockpitSettings 里那一段为什么。
  enforceEnabled: true,
  // 「3 分钟的高频次系统通知」——原话。
  enforcePreEndSeconds: 180,
  // 「每 1 秒到每 2 秒提醒一次」——取 2 秒：每秒一条在 Windows 上会把通知中心刷爆，
  // 而连击的效果差别不大。想要更凶的自己调到 1。
  enforceBurstSeconds: 2,
  enforceBeep: true,
  enforceFlicker: true,
  // 「100 - 80 - 60 - 40 - 20 - 0 - 20 - 40 - 60 - 80 - 100」——原话给的波形，
  // 谷底就是 0：暗到底才叫干扰，暗一半只会被当成屏幕保护。
  enforceFlickerLow: 0,
  enforceFlickerHigh: 100,
  // 每档 400 毫秒 × 10 档 = 一圈 4 秒。缓速闪烁，不是频闪。
  enforceFlickerStepMs: 400,
  enforceLockAtBreakStart: true,
  // 「先强制进行锁屏」——留 5 秒，够按一下「推迟」，不够拖延。
  enforceBreakLockSeconds: 5,
  enforceAwaitGraceSeconds: 60,
  // 「每 1 分钟检查一次」——原话。
  enforceCheckSeconds: 60,
  enforceAwaitAlarmSeconds: 20,
  enforceIdleSeconds: 60,
  enforceAwaitLock: true,
  // 督促自律网页由人自己填（插件不编造地址）。留空时改成把 Obsidian 拉到前台。
  enforceDisciplineUrl: "",
  // 「该开工而没开工，就应该永远提示」（AME-239）：默认不收手。
  // 想给自己留退路的，把这个开关打开，下面那个时限才算数。
  enforceGiveUpEnabled: false,
  enforceStopAfterMinutes: 60,
  enforceRespectMute: true,

  // 存在感层（AME-239）：默认全开。
  // 「中间的提示太弱了，几乎没有存在感」——默认关掉的存在感等于没有这个功能。
  hudEnabled: true,
  hudDesktopWindow: true,
  hudCorner: "top-right",
  hudOpacity: 0.92,
  taskbarProgressEnabled: true,
  heartbeatEnabled: true,
  // 「我的预期，每 2 分钟 得有一个提示、提醒」——原话。
  heartbeatMinutes: 2,
  heartbeatNotify: true,
  heartbeatFlash: true,
  heartbeatWhileRunning: true,

  musicEnabled: false,
  musicWorkTrack: "",
  musicBreakTrack: "",
  musicVolume: 0.6,
  musicLoop: true,
};

/** data.json 可能来自旧版本或被手工改坏，这里补齐缺失字段而不是整份丢弃。 */
export function normalizeSettings(raw: unknown): LifeCockpitSettings {
  // 浅拷一份再进门：世代迁移要往里补缺失的路径项（pinV1DefaultPaths），
  // 补在**拷贝**上——调用手的原始对象一个键都不能多出来。
  const source = { ...(raw ?? {}) } as Partial<LifeCockpitSettings>;
  const version = clampInt(source.settingsVersion, 0, SETTINGS_VERSION, 0);
  // 世代 2：把缺失的路径项按旧世代的位置钉住。必须在逐项归一化之前做——
  // 不然缺的哪项会吃新默认值，盘上的文件就被人搬走了。source 是本次
  // loadData 新解析出来的对象，在这里就地补齐没有副作用。
  pinV1DefaultPaths(source, version);
  const modes = {} as Record<ModeId, ModeSetting>;
  for (const id of MODE_IDS) {
    const fallback = DEFAULT_SETTINGS.modes[id];
    const given = source.modes?.[id];
    modes[id] = {
      workMinutes: positive(given?.workMinutes, fallback.workMinutes),
      breakMinutes: positive(given?.breakMinutes, fallback.breakMinutes),
      longBreakMinutes: positive(given?.longBreakMinutes, fallback.longBreakMinutes),
      pomodorosPerLongBreak: positiveInt(
        given?.pomodorosPerLongBreak,
        fallback.pomodorosPerLongBreak,
      ),
      reminderIntervalMinutes: positive(
        given?.reminderIntervalMinutes,
        fallback.reminderIntervalMinutes,
      ),
      themeCycle: nonEmptyStrings(given?.themeCycle) ?? fallback.themeCycle,
    };
  }
  migrateModeTimings(modes, version);

  return {
    settingsVersion: SETTINGS_VERSION,
    onboardingDone: bool(source.onboardingDone, DEFAULT_SETTINGS.onboardingDone),
    activeMode: MODE_IDS.includes(source.activeMode as ModeId)
      ? (source.activeMode as ModeId)
      : DEFAULT_SETTINGS.activeMode,
    modes,
    dailyFocusTargetMinutes: positive(
      source.dailyFocusTargetMinutes,
      DEFAULT_SETTINGS.dailyFocusTargetMinutes,
    ),
    dailyWindowHours: positive(source.dailyWindowHours, DEFAULT_SETTINGS.dailyWindowHours),
    pomodoroAlternateEnabled: bool(
      source.pomodoroAlternateEnabled,
      DEFAULT_SETTINGS.pomodoroAlternateEnabled,
    ),
    // 封在 0.1–1：比 1 大就不叫「间歇」了，比 0.1 小会造出一段几十秒的番茄。
    pomodoroAlternateRatio: clampNumber(
      source.pomodoroAlternateRatio,
      0.1,
      1,
      DEFAULT_SETTINGS.pomodoroAlternateRatio,
    ),
    sessionRestoreEnabled: bool(
      source.sessionRestoreEnabled,
      DEFAULT_SETTINGS.sessionRestoreEnabled,
    ),
    sessionGraceMinutes: nonNegative(
      source.sessionGraceMinutes,
      DEFAULT_SETTINGS.sessionGraceMinutes,
    ),
    expertise: isExpertise(source.expertise) ? source.expertise : DEFAULT_SETTINGS.expertise,
    // 缩放封在 0.6–2.5：再小读不了，再大一屏放不下两行字。
    uiFontScale: clampNumber(source.uiFontScale, 0.6, 2.5, DEFAULT_SETTINGS.uiFontScale),
    zenEnabled: bool(source.zenEnabled, DEFAULT_SETTINGS.zenEnabled),
    zenCoverWork: bool(source.zenCoverWork, DEFAULT_SETTINGS.zenCoverWork),
    breakPages: Array.isArray(source.breakPages) && source.breakPages.length
      ? source.breakPages.map((page, index) => ({
          id: str(page?.id, `page-${index + 1}`),
          label: str(page?.label, `休息页 ${index + 1}`),
          notePath: str(page?.notePath, ""),
        }))
      : DEFAULT_SETTINGS.breakPages.map((page) => ({ ...page })),
    rhythmSegments: Array.isArray(source.rhythmSegments) && source.rhythmSegments.length
      ? source.rhythmSegments.map((segment, index) => ({
          id: str(segment?.id, `segment-${index + 1}`),
          label: str(segment?.label, `时段 ${index + 1}`),
          start: str(segment?.start, "00:00"),
          end: str(segment?.end, "00:00"),
        }))
      : DEFAULT_SETTINGS.rhythmSegments.map((segment) => ({ ...segment })),
    rhythmNoticesEnabled: bool(
      source.rhythmNoticesEnabled,
      DEFAULT_SETTINGS.rhythmNoticesEnabled,
    ),
    themeNoticesEnabled: bool(source.themeNoticesEnabled, DEFAULT_SETTINGS.themeNoticesEnabled),
    phaseMapping: source.phaseMapping === "cycle5" ? "cycle5" : "weekday",
    cycleAnchorDate: str(source.cycleAnchorDate, DEFAULT_SETTINGS.cycleAnchorDate),
    cycleAnchorPhase: clampInt(source.cycleAnchorPhase, 0, 4, DEFAULT_SETTINGS.cycleAnchorPhase),
    ledgerFolder: vaultPath(source.ledgerFolder, DEFAULT_SETTINGS.ledgerFolder),
    dayRolloverHour: clampInt(source.dayRolloverHour, 0, 23, DEFAULT_SETTINGS.dayRolloverHour),
    pointsEnabled: bool(source.pointsEnabled, DEFAULT_SETTINGS.pointsEnabled),
    pointsFolder: vaultPath(source.pointsFolder, DEFAULT_SETTINGS.pointsFolder),
    pointsTaskNote: vaultPath(source.pointsTaskNote, DEFAULT_SETTINGS.pointsTaskNote),
    pomodoroAutoAward: bool(source.pomodoroAutoAward, DEFAULT_SETTINGS.pomodoroAutoAward),
    pomodoroDefaultTaskId: str(
      source.pomodoroDefaultTaskId,
      DEFAULT_SETTINGS.pomodoroDefaultTaskId,
    ),
    mirrorPointsIntoDayLedger: bool(
      source.mirrorPointsIntoDayLedger,
      DEFAULT_SETTINGS.mirrorPointsIntoDayLedger,
    ),
    goalsEnabled: bool(source.goalsEnabled, DEFAULT_SETTINGS.goalsEnabled),
    goalTreeNote: vaultPath(source.goalTreeNote, DEFAULT_SETTINGS.goalTreeNote),
    attributePointsToGoal: bool(
      source.attributePointsToGoal,
      DEFAULT_SETTINGS.attributePointsToGoal,
    ),
    candidatesEnabled: bool(source.candidatesEnabled, DEFAULT_SETTINGS.candidatesEnabled),
    candidatesFolder: vaultPath(source.candidatesFolder, DEFAULT_SETTINGS.candidatesFolder),
    candidateActor: str(source.candidateActor, DEFAULT_SETTINGS.candidateActor),
    reviewEnabled: bool(source.reviewEnabled, DEFAULT_SETTINGS.reviewEnabled),
    reviewJournalFolder: vaultPath(
      source.reviewJournalFolder,
      DEFAULT_SETTINGS.reviewJournalFolder,
    ),
    reviewMaterialFolder: vaultPath(
      source.reviewMaterialFolder,
      DEFAULT_SETTINGS.reviewMaterialFolder,
    ),
    reviewMistakeNote: vaultPath(source.reviewMistakeNote, DEFAULT_SETTINGS.reviewMistakeNote),
    reviewReminderAt: str(source.reviewReminderAt, DEFAULT_SETTINGS.reviewReminderAt),
    reviewReminderEnabled: bool(
      source.reviewReminderEnabled,
      DEFAULT_SETTINGS.reviewReminderEnabled,
    ),
    reviewMaterialAutoWrite: bool(
      source.reviewMaterialAutoWrite,
      DEFAULT_SETTINGS.reviewMaterialAutoWrite,
    ),
    feishuEnabled: bool(source.feishuEnabled, DEFAULT_SETTINGS.feishuEnabled),
    feishuSheetUrl: str(source.feishuSheetUrl, DEFAULT_SETTINGS.feishuSheetUrl).trim(),
    feishuSummarySheetUrl: str(
      source.feishuSummarySheetUrl,
      DEFAULT_SETTINGS.feishuSummarySheetUrl,
    ).trim(),
    feishuSnapshotFolder: vaultPath(
      source.feishuSnapshotFolder,
      DEFAULT_SETTINGS.feishuSnapshotFolder,
    ),
    feishuShowOnGate: bool(source.feishuShowOnGate, DEFAULT_SETTINGS.feishuShowOnGate),
    feishuIntoReview: bool(source.feishuIntoReview, DEFAULT_SETTINGS.feishuIntoReview),
    feishuGroupByGoal: bool(source.feishuGroupByGoal, DEFAULT_SETTINGS.feishuGroupByGoal),
    feishuPullWebhook: str(source.feishuPullWebhook, DEFAULT_SETTINGS.feishuPullWebhook).trim(),
    // 下限 10 秒：拉一次仓库都不止这么久，比这更短的等待只会次次「没等到」。
    feishuPullWaitSeconds: Math.max(
      10,
      nonNegative(source.feishuPullWaitSeconds, DEFAULT_SETTINGS.feishuPullWaitSeconds),
    ),
    // 允许留空 = 「不要替我拉仓库」，所以不能拿默认值把空串顶回去。
    feishuPullCommandId: str(source.feishuPullCommandId, DEFAULT_SETTINGS.feishuPullCommandId).trim(),
    miaodaEnabled: bool(source.miaodaEnabled, DEFAULT_SETTINGS.miaodaEnabled),
    // 地址允许改（换一个秒哒项目就是换这一行）。**空是合法状态**＝「还没配」：
    // 0.19.0 起没有预置地址可退（AME-315 审查 S2），空着的时候状态行会照实说。
    miaodaEndpoint: str(source.miaodaEndpoint, "").trim(),
    miaodaApiKey: cleanSecretValue(str(source.miaodaApiKey, DEFAULT_SETTINGS.miaodaApiKey)),
    miaodaFolder: vaultPath(source.miaodaFolder, DEFAULT_SETTINGS.miaodaFolder),
    miaodaAutoPull: bool(source.miaodaAutoPull, DEFAULT_SETTINGS.miaodaAutoPull),
    // 下限 5 分钟：比这更密就是在空跑，那个 APP 一天也写不了几段。
    miaodaAutoPullMinutes: Math.max(
      5,
      positive(source.miaodaAutoPullMinutes, DEFAULT_SETTINGS.miaodaAutoPullMinutes),
    ),
    miaodaPageSize: clampInt(source.miaodaPageSize, 10, 1000, DEFAULT_SETTINGS.miaodaPageSize),
    miaodaIncludeEmpty: bool(source.miaodaIncludeEmpty, DEFAULT_SETTINGS.miaodaIncludeEmpty),
    convexEnabled: bool(source.convexEnabled, DEFAULT_SETTINGS.convexEnabled),
    // 允许留空 = 「读环境变量」，所以不能拿默认值把空串顶回去
    convexUrl: str(source.convexUrl, DEFAULT_SETTINGS.convexUrl).trim(),
    convexToken: str(source.convexToken, DEFAULT_SETTINGS.convexToken).trim(),
    convexSyncSeconds: clampNumber(
      source.convexSyncSeconds,
      10,
      3600,
      DEFAULT_SETTINGS.convexSyncSeconds,
    ),
    aiEnabled: bool(source.aiEnabled, DEFAULT_SETTINGS.aiEnabled),
    aiActiveProfile: str(source.aiActiveProfile, DEFAULT_SETTINGS.aiActiveProfile),
    // 档位表可以整份清空——「一档都不要」是合法配置，别拿预置值顶回来；
    // 顶回来的话，删掉某一档的人下次启动会发现它自己长回来了。
    aiProfiles: Array.isArray(source.aiProfiles)
      ? source.aiProfiles.map((profile, index) => normalizeAiProfile(profile, index + 1))
      : DEFAULT_SETTINGS.aiProfiles.map((profile) => ({ ...profile })),
    aiReviewDraft: bool(source.aiReviewDraft, DEFAULT_SETTINGS.aiReviewDraft),
    aiLogEnabled: bool(source.aiLogEnabled, DEFAULT_SETTINGS.aiLogEnabled),
    // 下限 1 天：0 天 = 记完立刻删，那是个没有意义的配置。
    aiLogKeepDays: Math.max(1, clampInt(source.aiLogKeepDays, 1, 365, DEFAULT_SETTINGS.aiLogKeepDays)),
    nudgeEnabled: bool(source.nudgeEnabled, DEFAULT_SETTINGS.nudgeEnabled),
    nudgeMuted: bool(source.nudgeMuted, DEFAULT_SETTINGS.nudgeMuted),
    nudgeMinLevel: isNudgeLevel(source.nudgeMinLevel)
      ? source.nudgeMinLevel
      : DEFAULT_SETTINGS.nudgeMinLevel,
    nudgeQuietFrom: str(source.nudgeQuietFrom, DEFAULT_SETTINGS.nudgeQuietFrom),
    nudgeQuietTo: str(source.nudgeQuietTo, DEFAULT_SETTINGS.nudgeQuietTo),
    nudgeQuietBypassHard: bool(
      source.nudgeQuietBypassHard,
      DEFAULT_SETTINGS.nudgeQuietBypassHard,
    ),
    nudgeCooldownMinutes: nonNegative(
      source.nudgeCooldownMinutes,
      DEFAULT_SETTINGS.nudgeCooldownMinutes,
    ),
    nudgeDailyCap: nonNegative(source.nudgeDailyCap, DEFAULT_SETTINGS.nudgeDailyCap),
    nudgeSystemEnabled: bool(source.nudgeSystemEnabled, DEFAULT_SETTINGS.nudgeSystemEnabled),
    nudgeFeishuEnabled: bool(source.nudgeFeishuEnabled, DEFAULT_SETTINGS.nudgeFeishuEnabled),
    nudgeFeishuWebhook: str(source.nudgeFeishuWebhook, DEFAULT_SETTINGS.nudgeFeishuWebhook),
    nudgeFeishuSecret: str(source.nudgeFeishuSecret, DEFAULT_SETTINGS.nudgeFeishuSecret),
    nudgeWebhookEnabled: bool(source.nudgeWebhookEnabled, DEFAULT_SETTINGS.nudgeWebhookEnabled),
    nudgeWebhookUrl: str(source.nudgeWebhookUrl, DEFAULT_SETTINGS.nudgeWebhookUrl),
    gateEnabled: bool(source.gateEnabled, DEFAULT_SETTINGS.gateEnabled),
    gateFrequency: isGateFrequency(source.gateFrequency)
      ? source.gateFrequency
      : DEFAULT_SETTINGS.gateFrequency,
    gateDwellSeconds: nonNegative(source.gateDwellSeconds, DEFAULT_SETTINGS.gateDwellSeconds),
    gateAllowSkip: bool(source.gateAllowSkip, DEFAULT_SETTINGS.gateAllowSkip),
    gateIdleMinutes: nonNegative(source.gateIdleMinutes, DEFAULT_SETTINGS.gateIdleMinutes),
    gateRequireAttention: bool(
      source.gateRequireAttention,
      DEFAULT_SETTINGS.gateRequireAttention,
    ),
    // 页面表可以整份清空——「一页都不看」是合法配置，别拿默认值顶回来。
    gatePages: Array.isArray(source.gatePages)
      ? source.gatePages.map((page, index) => ({
          id: str(page?.id, `gate-${index + 1}`),
          label: str(page?.label, `强提醒页 ${index + 1}`),
          notePath: str(page?.notePath, ""),
        }))
      : DEFAULT_SETTINGS.gatePages.map((page) => ({ ...page })),
    gateShowReading: bool(source.gateShowReading, DEFAULT_SETTINGS.gateShowReading),
    readingEnabled: bool(source.readingEnabled, DEFAULT_SETTINGS.readingEnabled),
    readingCount: nonNegative(source.readingCount, DEFAULT_SETTINGS.readingCount),
    readingPool: Array.isArray(source.readingPool)
      ? source.readingPool.filter((item): item is string => typeof item === "string")
      : DEFAULT_SETTINGS.readingPool.slice(),
    readingPushEnabled: bool(source.readingPushEnabled, DEFAULT_SETTINGS.readingPushEnabled),
    readingPushAt: str(source.readingPushAt, DEFAULT_SETTINGS.readingPushAt),
    lockEnabled: bool(source.lockEnabled, DEFAULT_SETTINGS.lockEnabled),
    lockTrigger: isLockTrigger(source.lockTrigger)
      ? source.lockTrigger
      : DEFAULT_SETTINGS.lockTrigger,
    lockCountdownSeconds: positiveInt(
      source.lockCountdownSeconds,
      DEFAULT_SETTINGS.lockCountdownSeconds,
    ),
    lockMethod: isLockMethod(source.lockMethod) ? source.lockMethod : DEFAULT_SETTINGS.lockMethod,
    lockDeferMinutes: positiveInt(source.lockDeferMinutes, DEFAULT_SETTINGS.lockDeferMinutes),
    enforceEnabled: bool(source.enforceEnabled, DEFAULT_SETTINGS.enforceEnabled),
    enforcePreEndSeconds: nonNegative(
      source.enforcePreEndSeconds,
      DEFAULT_SETTINGS.enforcePreEndSeconds,
    ),
    enforceBurstSeconds: positiveInt(
      source.enforceBurstSeconds,
      DEFAULT_SETTINGS.enforceBurstSeconds,
    ),
    enforceBeep: bool(source.enforceBeep, DEFAULT_SETTINGS.enforceBeep),
    enforceFlicker: bool(source.enforceFlicker, DEFAULT_SETTINGS.enforceFlicker),
    // 谷底 0 是合法值（全黑），所以走 clampInt 而不是 positive。
    enforceFlickerLow: clampInt(source.enforceFlickerLow, 0, 100, DEFAULT_SETTINGS.enforceFlickerLow),
    enforceFlickerHigh: clampInt(
      source.enforceFlickerHigh,
      0,
      100,
      DEFAULT_SETTINGS.enforceFlickerHigh,
    ),
    enforceFlickerStepMs: positiveInt(
      source.enforceFlickerStepMs,
      DEFAULT_SETTINGS.enforceFlickerStepMs,
    ),
    enforceLockAtBreakStart: bool(
      source.enforceLockAtBreakStart,
      DEFAULT_SETTINGS.enforceLockAtBreakStart,
    ),
    enforceBreakLockSeconds: nonNegative(
      source.enforceBreakLockSeconds,
      DEFAULT_SETTINGS.enforceBreakLockSeconds,
    ),
    enforceAwaitGraceSeconds: nonNegative(
      source.enforceAwaitGraceSeconds,
      DEFAULT_SETTINGS.enforceAwaitGraceSeconds,
    ),
    enforceCheckSeconds: positiveInt(
      source.enforceCheckSeconds,
      DEFAULT_SETTINGS.enforceCheckSeconds,
    ),
    enforceAwaitAlarmSeconds: positiveInt(
      source.enforceAwaitAlarmSeconds,
      DEFAULT_SETTINGS.enforceAwaitAlarmSeconds,
    ),
    enforceIdleSeconds: positiveInt(source.enforceIdleSeconds, DEFAULT_SETTINGS.enforceIdleSeconds),
    enforceAwaitLock: bool(source.enforceAwaitLock, DEFAULT_SETTINGS.enforceAwaitLock),
    enforceDisciplineUrl: str(source.enforceDisciplineUrl, DEFAULT_SETTINGS.enforceDisciplineUrl),
    enforceGiveUpEnabled: bool(source.enforceGiveUpEnabled, DEFAULT_SETTINGS.enforceGiveUpEnabled),
    enforceStopAfterMinutes: nonNegative(
      source.enforceStopAfterMinutes,
      DEFAULT_SETTINGS.enforceStopAfterMinutes,
    ),
    enforceRespectMute: bool(source.enforceRespectMute, DEFAULT_SETTINGS.enforceRespectMute),
    hudEnabled: bool(source.hudEnabled, DEFAULT_SETTINGS.hudEnabled),
    hudDesktopWindow: bool(source.hudDesktopWindow, DEFAULT_SETTINGS.hudDesktopWindow),
    hudCorner: isHudCorner(source.hudCorner) ? source.hudCorner : DEFAULT_SETTINGS.hudCorner,
    hudOpacity: clampNumber(source.hudOpacity, 0.2, 1, DEFAULT_SETTINGS.hudOpacity),
    taskbarProgressEnabled: bool(
      source.taskbarProgressEnabled,
      DEFAULT_SETTINGS.taskbarProgressEnabled,
    ),
    heartbeatEnabled: bool(source.heartbeatEnabled, DEFAULT_SETTINGS.heartbeatEnabled),
    // 分钟数允许小数（0.5 = 30 秒），所以走 positive 而不是 positiveInt。
    heartbeatMinutes: positive(source.heartbeatMinutes, DEFAULT_SETTINGS.heartbeatMinutes),
    heartbeatNotify: bool(source.heartbeatNotify, DEFAULT_SETTINGS.heartbeatNotify),
    heartbeatFlash: bool(source.heartbeatFlash, DEFAULT_SETTINGS.heartbeatFlash),
    heartbeatWhileRunning: bool(
      source.heartbeatWhileRunning,
      DEFAULT_SETTINGS.heartbeatWhileRunning,
    ),
    musicEnabled: bool(source.musicEnabled, DEFAULT_SETTINGS.musicEnabled),
    musicWorkTrack: str(source.musicWorkTrack, DEFAULT_SETTINGS.musicWorkTrack),
    musicBreakTrack: str(source.musicBreakTrack, DEFAULT_SETTINGS.musicBreakTrack),
    musicVolume: clamp01(source.musicVolume, DEFAULT_SETTINGS.musicVolume),
    musicLoop: bool(source.musicLoop, DEFAULT_SETTINGS.musicLoop),
  };
}

export function activeModeSetting(settings: LifeCockpitSettings): ModeSetting {
  return settings.modes[settings.activeMode];
}

/**
 * 世代 0 → 1（AME-244）：把两种模式的基准时长换过来。
 *
 * **只认一字不差等于旧默认值的那一台机器**——五个数字全对得上才动，
 * 差一个都不动。理由和 `LEGACY_PATHS` 一样：自己调过的设置就是有意的，
 * 迁移没有资格覆盖它。改完写下世代号，所以这件事一台机器上只发生一次。
 */
function migrateModeTimings(modes: Record<ModeId, ModeSetting>, version: number): void {
  if (version >= 1) return;
  for (const id of MODE_IDS) {
    if (!sameTimings(modes[id], OLD_MODE_TIMINGS[id])) return;
  }
  for (const id of MODE_IDS) {
    const target = DEFAULT_SETTINGS.modes[id];
    modes[id] = { ...modes[id], ...timingsOf(target) };
  }
}

/**
 * 世代 < 2 → 2（AME-317）：默认数据根换成中性的 `LifeCockpit/`。
 *
 * 只对**真的有一份配置**的机器生效——raw 里一个键都没有的（首次安装、
 * data.json 被清空）不算「已有配置」，直接吃新默认值，这正是这次改动
 * 要给陌生人的东西。生效时只补 data.json 里**缺失**的路径项，按世代 1 的
 * 位置原样补；显式存着的值一个字都不碰——不管它是不是恰好等于旧默认值，
 * 存下来就是有意的。迁移改的是设置里的字符串，不搬盘上的文件。
 */
function pinV1DefaultPaths(source: Partial<LifeCockpitSettings>, version: number): void {
  if (version >= SETTINGS_VERSION || Object.keys(source).length === 0) return;
  const writable = source as Record<string, unknown>;
  for (const [key, v1] of Object.entries(V1_DEFAULT_PATHS)) {
    const current = writable[key];
    if (typeof current === "string" && current.length > 0) continue;
    writable[key] = v1;
  }
}

function timingsOf(mode: ModeSetting): Omit<ModeSetting, "themeCycle"> {
  return {
    workMinutes: mode.workMinutes,
    breakMinutes: mode.breakMinutes,
    longBreakMinutes: mode.longBreakMinutes,
    pomodorosPerLongBreak: mode.pomodorosPerLongBreak,
    reminderIntervalMinutes: mode.reminderIntervalMinutes,
  };
}

function sameTimings(mode: ModeSetting, other: Omit<ModeSetting, "themeCycle">): boolean {
  const left = timingsOf(mode);
  return (
    left.workMinutes === other.workMinutes &&
    left.breakMinutes === other.breakMinutes &&
    left.longBreakMinutes === other.longBreakMinutes &&
    left.pomodorosPerLongBreak === other.pomodorosPerLongBreak &&
    left.reminderIntervalMinutes === other.reminderIntervalMinutes
  );
}

/**
 * 落盘路径的读法。除了 `str` 的兜底，还多做一件事：**把 0.6.x 之前那批仓库外的
 * 旧默认值迁到运行区**。判断只认「一字不差等于旧默认值」——自己改过的路径原样留着。
 *
 * 迁的是设置里那个字符串，不搬盘上的文件：旧位置的东西还在，人自己挪（或者不挪）。
 */
function vaultPath(value: unknown, fallback: string): string {
  const raw = str(value, fallback);
  return LEGACY_PATHS[raw] ?? raw;
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInt(value: unknown, fallback: number): number {
  const n = positive(value, fallback);
  return Math.max(1, Math.round(n));
}

/** 0 是合法值（配额 0 = 不限、冷却 0 = 不冷却），所以不能复用 positive。 */
function nonNegative(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function clamp01(value: unknown, fallback: number): number {
  return clampNumber(value, 0, 1, fallback);
}

/** 带上下限的小数。字号缩放、不透明度这类「有意义区间」的设置走它。 */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function nonEmptyStrings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const list = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return list.length ? list : null;
}
