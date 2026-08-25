import { App, PluginSettingTab, Setting } from "obsidian";
import type LifeCockpitPlugin from "./main";
import { MODE_IDS, MODE_LABELS } from "./core/settings";
import type { ModeId } from "./core/settings";
import {
  canEditSetting,
  describeExpertise,
  EXPERTISE_IDS,
  EXPERTISE_LABELS,
  isExpertise,
} from "./core/expertise";
import { parseClock } from "./core/rhythm";
import { CHANNEL_STATE_LABELS, NUDGE_LEVEL_LABELS, NUDGE_LEVELS } from "./core/nudge";
import type { NudgeLevel } from "./core/nudge";
import { GATE_FREQUENCIES, GATE_FREQUENCY_LABELS } from "./core/gate";
import type { GateFrequency } from "./core/gate";
import { HUD_CORNER_LABELS, HUD_CORNERS, isHudCorner } from "./core/hud";
import { LOCK_METHOD_LABELS, LOCK_METHODS, LOCK_TRIGGER_LABELS, LOCK_TRIGGERS } from "./core/lock";
import type { LockMethodId, LockTrigger } from "./core/lock";
import { AI_CONSUMERS, createAiProfile } from "./core/ai";
import type { AiProfile } from "./core/ai";
import { describeAiLogEntry, summarizeAiLog } from "./core/ai-log";
import { cleanSecret, describeSecretNoise, secretShape } from "./core/secret";
import type { SecretNoise } from "./core/secret";
import { AiLogModal } from "./ui/ai-log-modal";

/** 设置页的二十个小节。id 是「只重画这一节」的钥匙。 */
type SectionId =
  | "appearance"
  | "hud"
  | "mode"
  | "daily"
  | "session"
  | "zen"
  | "rhythm"
  | "ledger"
  | "points"
  | "goals"
  | "candidates"
  | "review"
  | "feishu"
  | "ai"
  | "ai-log"
  | "miaoda"
  | "convex"
  | "nudge"
  | "gate"
  | "reading"
  | "lock"
  | "enforce"
  | "music";

/** 七个标签页。二十节按「你在什么场景下会来改它」分进这七页。 */
type TabId =
  | "convex"
  | "interface"
  | "pomodoro"
  | "focus"
  | "records"
  | "handoff"
  | "ai"
  | "push"
  | "force";

interface SectionSpec {
  id: SectionId;
  title: string;
  /** 跟在小节标题后面的一行状态；null = 这一节没有总开关，不摆状态 */
  status: () => string | null;
  render: (body: HTMLElement) => void;
}

interface TabSpec {
  id: TabId;
  label: string;
  sections: SectionId[];
}

const OFF_LABEL = "已关";

/**
 * 「这一项在新手模式下也能改」的记号。**在建这一项的时候标**（`openInBeginner`），
 * 不按名字对表——按名字对表的话，改一句文案就会有一项悄悄地锁死。
 */
const BEGINNER_OPEN_CLASS = "life-cockpit-setting-open";

/** 说明在上、输入框在下、输入框占满整行。多行输入的那几项都戴这个（见 `stacked`）。 */
const STACKED_CLASS = "life-cockpit-setting-stacked";

/**
 * 标签页与小节的归属。
 *
 * 「运行时音乐」在文档里属于 R6 推动器，这里却放进「节律 · 禅定」：改它的时候
 * 想的是工作段听什么，不是「怎么把消息推出去」。设置页按使用场景分，不按代码分层。
 */
const TABS: TabSpec[] = [
  // 「界面」排第一：字号和悬浮提示是**换一台电脑就要重调**的两件事
  // （AME-239：「此类配置，也可以单独放到一个 配置面板」），
  // 而其它几页大多是一次配好就不再动的。
  { id: "interface", label: "界面", sections: ["appearance", "hud"] },
  { id: "pomodoro", label: "番茄", sections: ["mode", "daily", "session", "ledger"] },
  { id: "focus", label: "节律 · 禅定", sections: ["rhythm", "zen", "music"] },
  { id: "records", label: "账本 · 目标", sections: ["points", "goals"] },
  // 飞书归「交班 · 复盘」：它是这一天做了什么的来源，只在「收口」这件事上出现。
  // 秒哒归「交班 · 复盘」，理由和飞书一样：它是「这一天到底想了什么」的来源，
  // 只在收口这件事上出现。飞书那一栏答的是「做了什么」，秒哒答的是「想了什么」。
  { id: "handoff", label: "交班 · 复盘", sections: ["candidates", "review", "feishu", "miaoda"] },
  // **AI 自己一页**（AME-258 第 22.1 条）。0.10.0 时它挂在「交班 · 复盘」下面，
  // 因为当时只有复盘一个用处；而原话是「将来，它会变成一个【全局性】的设置——
  // 因为其它地方，可能也大量使用到 Flash AI 接口」。一层被好几处共用的东西，
  // 藏在其中一处的下面，第二处接进来的那天就必然要搬家——不如现在就摆正。
  { id: "ai", label: "AI 接口", sections: ["ai", "ai-log"] },
  { id: "convex", label: "Convex 同步", sections: ["convex"] },
  { id: "push", label: "推送 · 推荐", sections: ["nudge", "reading"] },
  { id: "force", label: "强提醒 · 锁屏 · 干扰", sections: ["gate", "lock", "enforce"] },
];

export class LifeCockpitSettingTab extends PluginSettingTab {
  private plugin: LifeCockpitPlugin;
  /**
   * 当前在看哪一页。挂在 tab 实例上，所以关掉设置窗再打开还停在原来那一页；
   * 重启 Obsidian 回到第一页——UI 状态不值得占 data.json 的位置。
   */
  private activeTab: TabId = TABS[0].id;
  private navButtons = new Map<TabId, HTMLElement>();
  private pane: HTMLElement | null = null;
  /** 小节 id → 那一节的容器，`refreshSection` 靠它只重画一节 */
  private bodies = new Map<SectionId, HTMLElement>();
  /**
   * 上一次往密钥框里粘东西时洗掉了什么（AME-273 第 2 条）。
   * 挂在 tab 上而不是设置里：这是**这一次粘贴**的事，不该跟着 data.json 过夜。
   */
  private secretNoise = new Map<string, SecretNoise[]>();

  constructor(app: App, plugin: LifeCockpitPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.navButtons.clear();
    this.bodies.clear();

    this.renderExpertiseBar(containerEl);
    this.renderNav(containerEl);
    this.pane = containerEl.createDiv({ cls: "life-cockpit-settings-pane" });
    this.pane.setAttr("role", "tabpanel");
    this.renderPane();
  }

  /**
   * 档位切换条。**排在标签页之上、每一页都看得见**（AME-244）。
   *
   * 位置不是随便挑的：新手模式下满屏的设置都是灰的，如果切档的开关自己也躲在
   * 某一页里，人就会以为这个插件坏了。它必须是这一页上第一眼看到的东西，
   * 而且它自己永远不许被锁。
   */
  private renderExpertiseBar(containerEl: HTMLElement): void {
    const bar = containerEl.createDiv({ cls: "life-cockpit-settings-expertise" });
    new Setting(bar)
      .setName("设置面")
      .setDesc(describeExpertise(this.plugin.settings.expertise))
      .addDropdown((dropdown) => {
        for (const id of EXPERTISE_IDS) dropdown.addOption(id, EXPERTISE_LABELS[id]);
        dropdown.setValue(this.plugin.settings.expertise);
        dropdown.onChange(async (value) => {
          this.plugin.settings.expertise = isExpertise(value) ? value : "beginner";
          await this.plugin.saveSettings();
          // 整页重画：灰不灰是每一项都要重算的，而这一下人是有意换档，
          // 回到顶部不算「被甩回去」。
          this.display();
        });
      });
  }

  hide(): void {
    super.hide();
    // 容器交给基类清；这里只把指向它的引用放掉，别攥着已经拆下来的节点。
    this.navButtons.clear();
    this.bodies.clear();
    this.pane = null;
  }

  // -------------------------------------------------------------------------
  // 标签页骨架
  //
  // 十五节全摊在一页上，翻到最后要滚很久；而且以前每个开关改完都 `this.display()`
  // 整页重建，滚动位置直接甩回最顶上，想挨个检查设置根本没法看（AME-227 Bug2）。
  // 所以：顶上一排标签页，一次只画当前那一页；改开关只重画它自己那一小节。
  //
  // Obsidian 1.13 起有一套声明式设置 API（`getSettingDefinitions()`），自带搜索与
  // 分组。但它要求 minAppVersion 抬到 1.13.0，而这个插件要继续照顾旧版本，所以
  // 标签页是自己搭的、照旧走 `display()`——官方文档也明说 display() 就是留给
  // 「需要支持 1.13.0 以前版本」的插件的兜底路径。代价是这些设置进不了 1.13 设置
  // 窗的全局搜索（在此之前也一直进不去，不是这一版才有的）。
  // -------------------------------------------------------------------------

  private renderNav(containerEl: HTMLElement): void {
    const nav = containerEl.createDiv({ cls: "life-cockpit-settings-nav" });
    nav.setAttr("role", "tablist");

    for (const tab of TABS) {
      const button = nav.createEl("button", {
        cls: "life-cockpit-settings-nav__tab",
        text: tab.label,
        attr: { type: "button", role: "tab" },
      });
      button.addEventListener("click", () => this.selectTab(tab.id));
      this.navButtons.set(tab.id, button);
    }
    this.paintNav();
  }

  private paintNav(): void {
    for (const [id, button] of this.navButtons) {
      const active = id === this.activeTab;
      button.toggleClass("is-active", active);
      button.setAttr("aria-selected", String(active));
    }
  }

  /** 换页只重画内容区，导航条原地改高亮——焦点留在刚点的那个标签上。 */
  private selectTab(id: TabId): void {
    if (id === this.activeTab) return;
    const host = this.scrollHost();

    this.activeTab = id;
    this.paintNav();
    this.renderPane();

    // 换了一页就是要从头看，这一下回顶部是对的。
    if (host) host.scrollTop = 0;
  }

  private renderPane(): void {
    const pane = this.pane;
    if (!pane) return;

    pane.empty();
    this.bodies.clear();

    const specs = new Map(this.sections().map((spec) => [spec.id, spec]));
    const tab = TABS.find((item) => item.id === this.activeTab) ?? TABS[0];
    for (const id of tab.sections) {
      const spec = specs.get(id);
      if (!spec) continue;
      const body = pane.createDiv({ cls: "life-cockpit-settings-section" });
      this.bodies.set(id, body);
      this.paintSection(spec, body);
    }
  }

  private paintSection(spec: SectionSpec, body: HTMLElement): void {
    body.empty();

    const heading = new Setting(body).setName(spec.title).setHeading();
    const status = spec.status();
    if (status) {
      const label = heading.nameEl.createSpan({
        cls: "life-cockpit-settings-section__status",
        text: status,
      });
      label.toggleClass("is-off", status === OFF_LABEL);
    }

    spec.render(body);
    // 画完再锁：每一项自己知道「新手模式下让不让改」，这里只按那个记号统一处理，
    // 于是新增一项的默认结果是**锁上**——漏标了顶多是「改不了」，不会变成「悄悄能改」。
    this.applyExpertise(body);
  }

  /**
   * 新手模式下把没标记号的那些项灰掉：**只读，不隐藏**。
   *
   *   「大部分设置选项，是灰色的不许修改、仅查看；少部分设置，是可以手动修改的。」
   *
   * 藏起来的话，人连「原来这个东西可以调」都不知道——那是另一种复杂。
   */
  private applyExpertise(body: HTMLElement): void {
    const expertise = this.plugin.settings.expertise;
    const items = Array.from(body.querySelectorAll<HTMLElement>(".setting-item"));
    for (const item of items) {
      // 小标题也是一个 .setting-item，但它没有控件——灰掉它只会让人以为整节没了。
      if (item.hasClass("setting-item-heading")) continue;
      const locked = !canEditSetting(expertise, item.hasClass(BEGINNER_OPEN_CLASS));
      item.toggleClass("life-cockpit-setting-locked", locked);
      const controls = Array.from(
        item.querySelectorAll<
          HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement
        >(
          ".setting-item-control input, .setting-item-control select," +
            " .setting-item-control textarea, .setting-item-control button",
        ),
      );
      // `disabled` 管住键盘和读屏；`addExtraButton` 那种 div 按钮由 CSS 的
      // `pointer-events: none` 挡住（见 styles.css 里 .life-cockpit-setting-locked）。
      for (const control of controls) control.disabled = locked;
    }
  }

  /** 标出「这一项在新手模式下也能改」。划线的规矩见 core/expertise.ts 抬头。 */
  private openInBeginner(setting: Setting): Setting {
    setting.settingEl.addClass(BEGINNER_OPEN_CLASS);
    return setting;
  }

  /**
   * 说明在上、输入框在下，输入框占满整行（AME-258 第 22.3 条）。
   *
   *   「读物池，右侧的输入框 被挤压的过窄（可能因为左侧的字较多；字较多我认为是可以
   *    接受的，因为确实有这么多信息、但右侧的输入栏 可以宽一点）。」
   *
   * Obsidian 的设置项默认是左右分栏，说明和输入框抢同一行的宽度——说明越长，
   * 输入框越窄。**多行输入这件事和「说明写多长」不该是此消彼长的关系**，
   * 所以这一类整个换成上下排，说明照写，输入框拿满整行。
   */
  private stacked(setting: Setting): Setting {
    setting.settingEl.addClass(STACKED_CLASS);
    return setting;
  }

  /**
   * 只重画一小节。以前这里一律 `this.display()`：整页重建，滚动位置归零，
   * 点一个开关就被甩回最上面。现在只动这一节，上面的内容原地不动。
   */
  private refreshSection(id: SectionId): void {
    const spec = this.sections().find((item) => item.id === id);
    const body = this.bodies.get(id);
    if (!spec || !body) return;

    this.keepScroll(() => this.paintSection(spec, body));
  }

  /**
   * 真正滚动的是设置窗里某个祖先元素，不是 `containerEl` 自己，
   * 所以往上找第一个滚得动的。内容还没长到要滚就返回 null。
   */
  private scrollHost(): HTMLElement | null {
    let host: HTMLElement | null = this.containerEl;
    while (host && host.scrollHeight <= host.clientHeight + 1) host = host.parentElement;
    return host;
  }

  /** 重画期间钉住滚动位置。 */
  private keepScroll(mutate: () => void): void {
    const host = this.scrollHost();
    const top = host?.scrollTop ?? 0;
    mutate();
    if (host) host.scrollTop = top;
  }

  private sections(): SectionSpec[] {
    // 取当前设置，不做快照——状态是画标题那一下现算的，改完开关立刻要对。
    const settings = () => this.plugin.settings;
    const onOff = (on: boolean): string => (on ? "已开" : OFF_LABEL);

    return [
      {
        id: "appearance",
        title: "字号",
        status: () => `${Math.round(settings().uiFontScale * 100)}%`,
        render: (body) => this.renderAppearanceSection(body),
      },
      {
        id: "hud",
        title: "悬浮提示 · 心跳提醒",
        status: () =>
          !settings().hudEnabled
            ? OFF_LABEL
            : settings().heartbeatEnabled
              ? `开 · 每 ${settings().heartbeatMinutes} 分钟`
              : "开 · 不心跳",
        render: (body) => this.renderHudSection(body),
      },
      {
        id: "mode",
        title: "模式",
        status: () =>
          `${MODE_LABELS[settings().activeMode]}${settings().pomodoroAlternateEnabled ? " · 间歇节奏" : ""}`,
        render: (body) => this.renderModeSection(body),
      },
      {
        id: "daily",
        title: "当日累计",
        status: () => `${settings().dailyFocusTargetMinutes} 分钟 / ${settings().dailyWindowHours} 小时`,
        render: (body) => this.renderDailySection(body),
      },
      {
        id: "session",
        title: "重启与状态延续",
        status: () =>
          settings().sessionRestoreEnabled
            ? `开 · 宽限 ${settings().sessionGraceMinutes} 分钟`
            : OFF_LABEL,
        render: (body) => this.renderSessionSection(body),
      },
      {
        id: "zen",
        title: "禅定模式",
        status: () =>
          settings().zenEnabled
            ? settings().zenCoverWork
              ? "开 · 工作段也盖"
              : "开 · 只盖休息段"
            : onOff(false),
        render: (body) => this.renderZenSection(body),
      },
      {
        id: "rhythm",
        title: "五行节律表",
        status: () => `${settings().rhythmSegments.length} 个时段`,
        render: (body) => this.renderRhythmSection(body),
      },
      {
        id: "ledger",
        title: "番茄流水",
        status: () => null,
        render: (body) => this.renderLedgerSection(body),
      },
      {
        id: "points",
        title: "积分账本",
        status: () => onOff(settings().pointsEnabled),
        render: (body) => this.renderPointsSection(body),
      },
      {
        id: "goals",
        title: "目标树",
        status: () => onOff(settings().goalsEnabled),
        render: (body) => this.renderGoalsSection(body),
      },
      {
        id: "candidates",
        title: "夜班候选区",
        status: () => onOff(settings().candidatesEnabled),
        render: (body) => this.renderCandidatesSection(body),
      },
      {
        id: "review",
        title: "睡前复盘",
        status: () => onOff(settings().reviewEnabled),
        render: (body) => this.renderReviewSection(body),
      },
      {
        id: "feishu",
        title: "飞书金字塔表格",
        status: () => onOff(settings().feishuEnabled),
        render: (body) => this.renderFeishuSection(body),
      },
      {
        id: "miaoda",
        title: "秒哒「5 分钟写作」",
        status: () => {
          if (!settings().miaodaEnabled) return OFF_LABEL;
          if (!this.plugin.miaodaClient.ready) return "已开（缺 apikey）";
          return settings().miaodaAutoPull
            ? `已开 · 每 ${settings().miaodaAutoPullMinutes} 分钟`
            : "已开 · 手动拉";
        },
        render: (body) => this.renderMiaodaSection(body),
      },
      {
        id: "convex",
        title: "Convex 同步",
        status: () => {
          const st = this.plugin.convexStatus();
          if (st.phase === "disabled") return OFF_LABEL;
          if (st.phase === "missing-config") return "已开（缺配置）";
          if (st.phase === "error") return "已开（连不上）";
          return "已开";
        },
        render: (body) => this.renderConvexSection(body),
      },
      {
        id: "ai",
        title: "AI 接口",
        status: () =>
          !settings().aiEnabled ? OFF_LABEL : this.plugin.ai.ready ? "已开" : "已开（缺配置）",
        render: (body) => this.renderAiSection(body),
      },
      {
        id: "ai-log",
        title: "调用记录",
        status: () =>
          settings().aiLogEnabled ? `留 ${settings().aiLogKeepDays} 天` : OFF_LABEL,
        render: (body) => this.renderAiLogSection(body),
      },
      {
        id: "nudge",
        title: "主动推送",
        // 静音是「开着但一条都不推」，和关掉不是一回事，标题上就得分得清。
        status: () =>
          !settings().nudgeEnabled ? OFF_LABEL : settings().nudgeMuted ? "静音中" : "已开",
        render: (body) => this.renderNudgeSection(body),
      },
      {
        id: "gate",
        title: "复工强提醒页",
        status: () => onOff(settings().gateEnabled),
        render: (body) => this.renderGateSection(body),
      },
      {
        id: "reading",
        title: "每日推荐读物",
        status: () => onOff(settings().readingEnabled),
        render: (body) => this.renderReadingSection(body),
      },
      {
        id: "lock",
        title: "强制休息与锁屏",
        // 这台机器锁不动的话，开着也没用——标题上就要说明白。
        status: () =>
          !settings().lockEnabled ? OFF_LABEL : this.plugin.lockSupported ? "已开" : "已开（锁不动）",
        render: (body) => this.renderLockSection(body),
      },
      {
        id: "enforce",
        title: "强制干扰",
        status: () => onOff(settings().enforceEnabled),
        render: (body) => this.renderEnforceSection(body),
      },
      {
        id: "music",
        title: "运行时音乐",
        status: () => onOff(settings().musicEnabled),
        render: (body) => this.renderMusicSection(body),
      },
    ];
  }

  // -------------------------------------------------------------------------
  // 界面：字号
  //
  // 「整体的字体，应该要大一点——因为我的 Obsidian 面板的【Zoom Level】，
  //  是缩放到了【83%】左右。」（AME-239）
  //
  // 所以这是**一个全局倍数**，不是一堆各自为政的字号：一台电脑一个值，
  // 换机器就改这一个数。落点在 styles.css 里那一组 `--life-cockpit-scale`。
  // -------------------------------------------------------------------------

  private renderAppearanceSection(containerEl: HTMLElement): void {
    const percent = Math.round(this.plugin.settings.uiFontScale * 100);

    this.openInBeginner(new Setting(containerEl))
      .setName("界面字号")
      .setDesc(
        `当前 ${percent}%。驾驶舱、目标树、候选区、全屏遮罩、悬浮提示、弹窗一起跟着变；` +
          "Obsidian 自己的界面不受影响。把 Obsidian 的 Zoom Level 调小过的机器，" +
          "在这里把它抵回来（缩到 83% 就调到 120% 左右）。",
      )
      .addSlider((slider) => {
        slider.setLimits(60, 250, 5);
        slider.setValue(percent);
        slider.setDynamicTooltip();
        slider.onChange(async (value) => {
          this.plugin.settings.uiFontScale = value / 100;
          await this.plugin.saveSettings();
          this.refreshSection("appearance");
        });
      })
      .addExtraButton((button) => {
        button.setIcon("rotate-ccw");
        button.setTooltip("恢复默认 120%");
        button.onClick(async () => {
          this.plugin.settings.uiFontScale = 1.2;
          await this.plugin.saveSettings();
          this.refreshSection("appearance");
        });
      });

    const preview = containerEl.createDiv({ cls: "life-cockpit-scaled" });
    preview.createDiv({
      cls: "life-cockpit-time",
      text: "25:00",
    });
    preview.createDiv({
      cls: "life-cockpit-hint",
      text: "这一行和上面那个数字，就是面板上的实际大小。改完滑块当场看这里。",
    });
  }

  // -------------------------------------------------------------------------
  // 界面：悬浮提示 · 心跳提醒（AME-239）
  // -------------------------------------------------------------------------

  private renderHudSection(containerEl: HTMLElement): void {
    this.openInBeginner(new Setting(containerEl))
      .setName("启用悬浮提示")
      .setDesc(
        "桌面上一块置顶、点击穿透的小贴纸：现在是工作还是休息、还剩多久、有没有欠着一次开工。" +
          "它不接受任何点击，只负责一直在。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.hudEnabled);
        toggle.onChange(async (value) => {
          this.plugin.settings.hudEnabled = value;
          await this.plugin.saveSettings();
          this.refreshSection("hud");
        });
      });

    containerEl.createDiv({
      cls: "life-cockpit-enforce-plan",
      text: this.plugin.describeHud(),
    });

    if (!this.plugin.settings.hudEnabled) return;

    containerEl.createDiv({
      cls: "life-cockpit-hint",
      text: `这台机器上：${this.plugin.describeHudMode()}`,
    });

    new Setting(containerEl)
      .setName("开一扇真正的桌面悬浮窗")
      .setDesc(
        "开：什么窗口在前台都看得见（Electron 置顶窗）。" +
          "关、或者这台机器开不出来：退回画在 Obsidian 窗口里——那时切走就看不见了。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.hudDesktopWindow);
        toggle.onChange(async (value) => {
          this.plugin.settings.hudDesktopWindow = value;
          await this.plugin.saveSettings();
          this.refreshSection("hud");
        });
      });

    new Setting(containerEl)
      .setName("贴在哪个角")
      .addDropdown((dropdown) => {
        for (const corner of HUD_CORNERS) dropdown.addOption(corner, HUD_CORNER_LABELS[corner]);
        dropdown.setValue(this.plugin.settings.hudCorner);
        dropdown.onChange(async (value) => {
          this.plugin.settings.hudCorner = isHudCorner(value) ? value : "top-right";
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("不透明度")
      .setDesc("太透会看不见，太实会挡视线。默认 92%。")
      .addSlider((slider) => {
        slider.setLimits(20, 100, 5);
        slider.setValue(Math.round(this.plugin.settings.hudOpacity * 100));
        slider.setDynamicTooltip();
        slider.onChange(async (value) => {
          this.plugin.settings.hudOpacity = value / 100;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("任务栏上也显示")
      .setDesc(
        "任务栏按钮上画一条进度：工作蓝、休息黄、欠着开工红。" +
          "插件够不到真正的系统托盘图标（那要主进程），任务栏是这条路上够得着的那一半。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.taskbarProgressEnabled);
        toggle.onChange(async (value) => {
          this.plugin.settings.taskbarProgressEnabled = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("测一次")
      .setDesc("让悬浮提示当场闪一下，并把这台机器上的实际形态说给你听。")
      .addButton((button) => {
        button.setButtonText("闪一下");
        button.onClick(() => {
          this.plugin.testHud();
          this.refreshSection("hud");
        });
      });

    new Setting(containerEl).setName("心跳提醒").setHeading();

    new Setting(containerEl)
      .setName("每隔一阵提醒一次")
      .setDesc(
        "原话：「我的预期，每 2 分钟 得有一个提示、提醒」。" +
          "它绕开推送闸门（冷却 / 配额），只认你按下的静音——所以它是节拍，不是通知。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.heartbeatEnabled);
        toggle.onChange(async (value) => {
          this.plugin.settings.heartbeatEnabled = value;
          await this.plugin.saveSettings();
          this.refreshSection("hud");
        });
      });

    if (!this.plugin.settings.heartbeatEnabled) return;

    this.numberSetting(
      containerEl,
      "间隔（分钟）",
      "默认 2。可以填小数：0.5 = 30 秒。",
      this.plugin.settings.heartbeatMinutes,
      async (value) => {
        this.plugin.settings.heartbeatMinutes = Math.max(0.1, value);
        await this.plugin.saveSettings();
        this.refreshSection("hud");
      },
    );

    new Setting(containerEl)
      .setName("番茄正常跑着时也提醒")
      .setDesc("关掉的话，只有「该开工却没开工」时才会响——那一条永远不关。")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.heartbeatWhileRunning);
        toggle.onChange(async (value) => {
          this.plugin.settings.heartbeatWhileRunning = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("每一拍弹系统通知")
      .setDesc("关掉之后只剩悬浮框闪一下和任务栏闪一下。")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.heartbeatNotify);
        toggle.onChange(async (value) => {
          this.plugin.settings.heartbeatNotify = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("每一拍闪一下任务栏")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.heartbeatFlash);
        toggle.onChange(async (value) => {
          this.plugin.settings.heartbeatFlash = value;
          await this.plugin.saveSettings();
        });
      });
  }

  // -------------------------------------------------------------------------
  // 模式
  // -------------------------------------------------------------------------

  private renderModeSection(containerEl: HTMLElement): void {
    this.openInBeginner(new Setting(containerEl))
      .setName("当前模式")
      .setDesc(
        "思考优先 = 25 + 5（连续思考 45 分钟不现实）；加速实践 = 45 + 10（一股冲劲跑到底）。" +
          "切模式会同时改工作 / 休息时长与提醒主题节律。",
      )
      .addDropdown((dropdown) => {
        for (const id of MODE_IDS) dropdown.addOption(id, MODE_LABELS[id]);
        dropdown.setValue(this.plugin.settings.activeMode);
        dropdown.onChange(async (value) => {
          await this.plugin.switchMode(value as ModeId);
          this.refreshSection("mode");
        });
      });

    // --- 间歇节奏（AME-244）---
    this.openInBeginner(new Setting(containerEl))
      .setName("间歇节奏")
      .setDesc(
        "开：单数番茄跑基准时长，双数番茄减半，跟着的那一小段休息一起减半。" +
          "长休息不缩——和长休息的轮数无关。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.pomodoroAlternateEnabled);
        toggle.onChange(async (value) => {
          this.plugin.settings.pomodoroAlternateEnabled = value;
          await this.plugin.saveSettings();
          this.refreshSection("mode");
        });
      });

    containerEl.createDiv({
      cls: "life-cockpit-enforce-plan",
      text: this.plugin.describePomodoroRhythm(),
    });

    if (this.plugin.settings.pomodoroAlternateEnabled) {
      new Setting(containerEl)
        .setName("双数番茄按几折")
        .setDesc("默认 50%（原话「第二次一半的分钟数」）。已经在跑的那一段不受影响，下一段起算。")
        .addSlider((slider) => {
          slider.setLimits(10, 100, 5);
          slider.setValue(Math.round(this.plugin.settings.pomodoroAlternateRatio * 100));
          slider.setDynamicTooltip();
          slider.onChange(async (value) => {
            this.plugin.settings.pomodoroAlternateRatio = value / 100;
            await this.plugin.saveSettings();
            this.refreshSection("mode");
          });
        });
    }

    for (const id of MODE_IDS) {
      new Setting(containerEl).setName(MODE_LABELS[id]).setHeading();
      const mode = this.plugin.settings.modes[id];

      this.numberSetting(containerEl, "工作时长（分钟）", "", mode.workMinutes, async (value) => {
        mode.workMinutes = value;
        await this.plugin.saveSettings();
      });

      this.numberSetting(containerEl, "休息时长（分钟）", "", mode.breakMinutes, async (value) => {
        mode.breakMinutes = value;
        await this.plugin.saveSettings();
      });

      this.numberSetting(
        containerEl,
        "长休息时长（分钟）",
        "",
        mode.longBreakMinutes,
        async (value) => {
          mode.longBreakMinutes = value;
          await this.plugin.saveSettings();
        },
      );

      this.numberSetting(
        containerEl,
        "几个番茄后长休息",
        "",
        mode.pomodorosPerLongBreak,
        async (value) => {
          mode.pomodorosPerLongBreak = Math.max(1, Math.round(value));
          await this.plugin.saveSettings();
        },
      );

      this.numberSetting(
        containerEl,
        "提醒间隔（分钟）",
        "提醒主题节律：多久推一条主题。",
        mode.reminderIntervalMinutes,
        async (value) => {
          mode.reminderIntervalMinutes = value;
          await this.plugin.saveSettings();
        },
      );

      this.stacked(new Setting(containerEl))
        .setName("提醒主题")
        .setDesc("一行一条，按顺序轮换。默认取日记模板《今日每日任务》的六维。")
        .addTextArea((text) => {
          text.inputEl.rows = 4;
          text.setValue(mode.themeCycle.join("\n"));
          text.onChange(async (value) => {
            mode.themeCycle = value
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0);
            await this.plugin.saveSettings();
          });
        });
    }
  }

  // -------------------------------------------------------------------------
  // 当日
  // -------------------------------------------------------------------------

  private renderDailySection(containerEl: HTMLElement): void {
    this.numberSetting(
      containerEl,
      "当日番茄目标（分钟）",
      "日记模板里的 560 分钟番茄时间。",
      this.plugin.settings.dailyFocusTargetMinutes,
      async (value) => {
        this.plugin.settings.dailyFocusTargetMinutes = value;
        await this.plugin.saveSettings();
      },
    );

    this.numberSetting(
      containerEl,
      "工作窗口（小时）",
      "14 小时工作制，只用于显示。",
      this.plugin.settings.dailyWindowHours,
      async (value) => {
        this.plugin.settings.dailyWindowHours = value;
        await this.plugin.saveSettings();
      },
    );

    // 这里从前有一个「自动开始下一段」的开关。0.8.0 删掉了，**不是改默认值**：
    // 「【开工】永远是 人类手动的行为（【自动开工】永远是无法被接受的！）」（AME-239）。
    // 一个能被打开的自动开工开关，迟早会被打开。休息段一律自跑那一侧没变。
    containerEl.createDiv({
      cls: "life-cockpit-hint",
      text:
        "休息跑完之后，工作段一律停着等你手动开工——这一条没有开关。" +
        "休息段仍然一律自跑：休息的钟在工作结束那一刻就开始走了，不等人点。",
    });
  }

  // -------------------------------------------------------------------------
  // 重启与状态延续（AME-244）
  //
  //   「我是一个会经常折腾 Obsidian、包括重启 Obsidian 来让各种插件调整和生效的人；
  //    所以【Obsidian】重启，是像家常便饭一样的事情。」
  //
  // 所以这一节的默认值是「接得回来」，而不是「每次从头开始」。
  // -------------------------------------------------------------------------

  private renderSessionSection(containerEl: HTMLElement): void {
    this.openInBeginner(new Setting(containerEl))
      .setName("重启之后接着上次")
      .setDesc(
        "挂着的任务与目标、跑到一半的番茄，重启 Obsidian 之后原样接回来——" +
          "不用每次重开都重挑一遍。关掉的话，每次启动都是一张干净的表。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.sessionRestoreEnabled);
        toggle.onChange(async (value) => {
          this.plugin.settings.sessionRestoreEnabled = value;
          await this.plugin.saveSettings();
          this.refreshSection("session");
        });
      });

    if (!this.plugin.settings.sessionRestoreEnabled) return;

    this.numberSetting(
      containerEl,
      "宽限期（分钟）",
      "工作段跑着的时候关掉 Obsidian：这个时间之内回来，中间那点时间照算（重启一次通常十几秒）；" +
        "超过就一秒都不算，番茄停在关掉那一刻等你按开工。默认 5。",
      this.plugin.settings.sessionGraceMinutes,
      async (value) => {
        this.plugin.settings.sessionGraceMinutes = Math.max(0, value);
        await this.plugin.saveSettings();
        this.refreshSection("session");
      },
    );

    containerEl.createDiv({
      cls: "life-cockpit-hint",
      text:
        "休息段不看宽限期：休息按墙上的钟走，人不在正好是在休息。" +
        "离开期间休息跑完了，那一段会照实补记，然后停在「等你开工」——开工永远是手动的。" +
        "跨过归日点（凌晨 4 点）的那一段不往新的一天搬，也不回头补记。",
    });
  }

  // -------------------------------------------------------------------------
  // 禅定模式
  // -------------------------------------------------------------------------

  private renderZenSection(containerEl: HTMLElement): void {
    this.openInBeginner(new Setting(containerEl))
      .setName("启用禅定模式")
      .setDesc(
        "禅定 = 一段活干完之后的休息与静心：休息段全屏轮换休息页，倒计时在上面走。" +
          "Esc 随时退出，退出不停表；系统级强制锁屏见下面「强制休息与锁屏」一节。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.zenEnabled);
        toggle.onChange(async (value) => {
          this.plugin.settings.zenEnabled = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("工作段也盖遮罩")
      .setDesc(
        "默认关。Obsidian 是工作台，工作的时候把工作台盖住是本末倒置——遮罩只在休息段出现。" +
          "偶尔想要工作段也进全屏，用命令面板的「开关禅定遮罩」叫一次就够，不必长开。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.zenCoverWork);
        toggle.onChange(async (value) => {
          this.plugin.settings.zenCoverWork = value;
          await this.plugin.saveSettings();
        });
      });

    for (const page of this.plugin.settings.breakPages) {
      new Setting(containerEl)
        .setName(`休息页 · ${page.label}`)
        .setDesc("vault 内笔记路径，例如 Root/每日Journal/休息/冥想.md")
        .addText((text) => {
          text.setPlaceholder("留空则只显示标题");
          text.setValue(page.notePath);
          text.onChange(async (value) => {
            page.notePath = value.trim();
            await this.plugin.saveSettings();
          });
        });
    }
  }

  // -------------------------------------------------------------------------
  // 五行节律表
  // -------------------------------------------------------------------------

  private renderRhythmSection(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("五行列如何对应日期")
      .setDesc(
        "weekday：金一到土五 = 周一到周五，周末没有列；cycle5：从锚点日起五天一轮，不管星期。",
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("weekday", "周一到周五");
        dropdown.addOption("cycle5", "五天一轮");
        dropdown.setValue(this.plugin.settings.phaseMapping);
        dropdown.onChange(async (value) => {
          this.plugin.settings.phaseMapping = value === "cycle5" ? "cycle5" : "weekday";
          await this.plugin.saveSettings();
          this.refreshSection("rhythm");
        });
      });

    if (this.plugin.settings.phaseMapping === "cycle5") {
      new Setting(containerEl)
        .setName("锚点日期")
        .setDesc("YYYY-MM-DD，这一天算作下面选的那一列。")
        .addText((text) => {
          text.setValue(this.plugin.settings.cycleAnchorDate);
          text.onChange(async (value) => {
            this.plugin.settings.cycleAnchorDate = value.trim();
            await this.plugin.saveSettings();
          });
        });

      new Setting(containerEl).setName("锚点日所在列").addDropdown((dropdown) => {
        const labels = ["金一", "木二", "水三", "火四", "土五"];
        labels.forEach((label, index) => dropdown.addOption(String(index), label));
        dropdown.setValue(String(this.plugin.settings.cycleAnchorPhase));
        dropdown.onChange(async (value) => {
          this.plugin.settings.cycleAnchorPhase = Number(value);
          await this.plugin.saveSettings();
        });
      });
    }

    this.plugin.settings.rhythmSegments.forEach((segment, index) => {
      const setting = new Setting(containerEl)
        .setName(`时段 ${index + 1}`)
        .setDesc("名称、开始、结束（HH:MM）。结束早于开始视为跨零点。");

      setting.addText((text) => {
        text.setPlaceholder("名称");
        text.setValue(segment.label);
        text.onChange(async (value) => {
          segment.label = value;
          await this.plugin.saveSettings();
        });
      });

      setting.addText((text) => {
        text.setPlaceholder("09:00");
        text.setValue(segment.start);
        text.inputEl.addClass("life-cockpit-clock-input");
        text.onChange(async (value) => {
          segment.start = value.trim();
          text.inputEl.toggleClass("is-invalid", parseClock(segment.start) === null);
          await this.plugin.saveSettings();
        });
      });

      setting.addText((text) => {
        text.setPlaceholder("12:00");
        text.setValue(segment.end);
        text.inputEl.addClass("life-cockpit-clock-input");
        text.onChange(async (value) => {
          segment.end = value.trim();
          text.inputEl.toggleClass("is-invalid", parseClock(segment.end) === null);
          await this.plugin.saveSettings();
        });
      });
    });

    new Setting(containerEl)
      .setName("进入 / 离开时段时提醒")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.rhythmNoticesEnabled);
        toggle.onChange(async (value) => {
          this.plugin.settings.rhythmNoticesEnabled = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("按节律推送主题提醒")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.themeNoticesEnabled);
        toggle.onChange(async (value) => {
          this.plugin.settings.themeNoticesEnabled = value;
          await this.plugin.saveSettings();
        });
      });
  }

  // -------------------------------------------------------------------------
  // 流水
  // -------------------------------------------------------------------------

  private renderLedgerSection(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("流水目录")
      .setDesc("vault 相对路径，一天一个 JSON 文件。内容没变不会写盘。")
      .addText((text) => {
        text.setValue(this.plugin.settings.ledgerFolder);
        text.onChange(async (value) => {
          this.plugin.settings.ledgerFolder = value.trim().replace(/^\/+|\/+$/g, "");
          await this.plugin.saveSettings();
        });
      });

    this.numberSetting(
      containerEl,
      "几点算新的一天",
      "14 小时工作制会跨零点，凌晨收工的番茄默认记在前一天。",
      this.plugin.settings.dayRolloverHour,
      async (value) => {
        this.plugin.settings.dayRolloverHour = Math.min(23, Math.max(0, Math.round(value)));
        await this.plugin.saveSettings();
      },
    );
  }

  // -------------------------------------------------------------------------
  // 积分账本
  // -------------------------------------------------------------------------

  private renderPointsSection(containerEl: HTMLElement): void {
    this.openInBeginner(new Setting(containerEl))
      .setName("启用积分账本")
      .setDesc("完成任务入账、享乐出账。一个月一份 Markdown 账本，落在下面的目录里。")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.pointsEnabled);
        toggle.onChange(async (value) => {
          this.plugin.settings.pointsEnabled = value;
          await this.plugin.saveSettings();
          this.refreshSection("points");
        });
      });

    if (!this.plugin.settings.pointsEnabled) return;

    new Setting(containerEl)
      .setName("账本目录")
      .setDesc("vault 相对路径，一个月一个 YYYY-MM.md。内容没变不会写盘。")
      .addText((text) => {
        text.setValue(this.plugin.settings.pointsFolder);
        text.onChange(async (value) => {
          this.plugin.settings.pointsFolder = value.trim().replace(/^\/+|\/+$/g, "");
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("任务表笔记")
      .setDesc("预设任务与分值维护在这篇笔记里，改完保存即刻生效。")
      .addText((text) => {
        text.setValue(this.plugin.settings.pointsTaskNote);
        text.onChange(async (value) => {
          this.plugin.settings.pointsTaskNote = value.trim();
          await this.plugin.saveSettings();
        });
      })
      .addButton((button) => {
        button.setButtonText(this.plugin.points.hasTaskNote ? "重写" : "新建");
        button.onClick(async () => {
          await this.plugin.ensureTaskNote();
          this.refreshSection("points");
        });
      });

    new Setting(containerEl)
      .setName("番茄跑满自动入账")
      .setDesc("跑满才算，手动结束或跳过不计分。同一段只入一次账。")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.pomodoroAutoAward);
        toggle.onChange(async (value) => {
          this.plugin.settings.pomodoroAutoAward = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("番茄默认任务")
      .setDesc("驾驶舱面板上没挑任务时按这一项计分。")
      .addDropdown((dropdown) => {
        const tasks = this.plugin.points.earnTasks();
        for (const task of tasks) {
          dropdown.addOption(task.id, `${task.label}（${task.points}）`);
        }
        // 任务表里改过 ID 的话，这里要如实显示「找不到」，而不是默默停在第一项。
        const current = this.plugin.settings.pomodoroDefaultTaskId;
        if (!tasks.some((task) => task.id === current)) {
          dropdown.addOption(current, `${current}（任务表里没有这一项）`);
        }
        dropdown.setValue(current);
        dropdown.onChange(async (value) => {
          this.plugin.settings.pomodoroDefaultTaskId = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("把当日积分写进番茄流水日档")
      .setDesc(
        "在 R1 日档 JSON 的 points 位上写一份当日快照，睡前复盘（R5）打开一个文件就能拿全。" +
          "派生数据，源头始终是账本 Markdown。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.mirrorPointsIntoDayLedger);
        toggle.onChange(async (value) => {
          this.plugin.settings.mirrorPointsIntoDayLedger = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("重读账本")
      .setDesc("在 vault 里手工改过账本或任务表之后，按一下让插件重新读盘。")
      .addButton((button) => {
        button.setButtonText("重读");
        button.onClick(async () => {
          await this.plugin.reloadPoints();
          this.refreshSection("points");
        });
      });
  }

  // -------------------------------------------------------------------------
  // 目标树
  // -------------------------------------------------------------------------

  private renderGoalsSection(containerEl: HTMLElement): void {
    this.openInBeginner(new Setting(containerEl))
      .setName("启用目标树")
      .setDesc("《知识库》「全目标管理」那六层：宇宙 / 人生 / 大阶段 / OKR / KPI / 日内目标。")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.goalsEnabled);
        toggle.onChange(async (value) => {
          this.plugin.settings.goalsEnabled = value;
          await this.plugin.saveSettings();
          this.refreshSection("goals");
        });
      });

    if (!this.plugin.settings.goalsEnabled) return;

    new Setting(containerEl)
      .setName("目标树笔记")
      .setDesc("整棵树落在这一篇里，缩进列表 Markdown，可以直接在 Obsidian 里改。内容没变不会写盘。")
      .addText((text) => {
        text.setValue(this.plugin.settings.goalTreeNote);
        text.onChange(async (value) => {
          this.plugin.settings.goalTreeNote = value.trim();
          await this.plugin.saveSettings();
        });
      })
      .addButton((button) => {
        button.setButtonText(this.plugin.goals.hasNote ? "重写" : "新建");
        button.onClick(async () => {
          await this.plugin.ensureGoalNote();
          this.refreshSection("goals");
        });
      });

    new Setting(containerEl)
      .setName("按目标记账")
      .setDesc(
        "番茄 / 记账挂了目标时，账本里那一笔的「任务」写成 goal:<节点 id> 指回目标树。" +
          "关掉的话账本照旧按计分规则记，目标只留在番茄流水的 goalId 上。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.attributePointsToGoal);
        toggle.onChange(async (value) => {
          this.plugin.settings.attributePointsToGoal = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("重读目标树")
      .setDesc("在 vault 里手工改过目标树之后，按一下让插件重新读盘。")
      .addButton((button) => {
        button.setButtonText("重读");
        button.onClick(async () => {
          await this.plugin.reloadGoals();
          this.refreshSection("goals");
        });
      });
  }

  // -------------------------------------------------------------------------
  // 夜班候选区
  // -------------------------------------------------------------------------

  private renderCandidatesSection(containerEl: HTMLElement): void {
    this.openInBeginner(new Setting(containerEl))
      .setName("启用候选区")
      .setDesc(
        "人机交班面：夜里 Agent 的产物落候选区、不直接改主干，白天你在拍板面上逐条采纳 / 打回 / 改写。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.candidatesEnabled);
        toggle.onChange(async (value) => {
          this.plugin.settings.candidatesEnabled = value;
          await this.plugin.saveSettings();
          if (value) await this.plugin.reloadCandidates();
          this.refreshSection("candidates");
        });
      });

    if (!this.plugin.settings.candidatesEnabled) return;

    new Setting(containerEl)
      .setName("候选区目录")
      .setDesc(
        "一天一个日期目录，拍板后原件移进它下面的 _归档/。和 tools/news-inbox 的 candidatesFolder 要一致。",
      )
      .addText((text) => {
        text.setValue(this.plugin.settings.candidatesFolder);
        text.onChange(async (value) => {
          this.plugin.settings.candidatesFolder = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("拍板留痕的操作者")
      .setDesc("写进候选项 裁决 里的「操作者」。是你自己拍的板，就写你。")
      .addText((text) => {
        text.setValue(this.plugin.settings.candidateActor);
        text.onChange(async (value) => {
          this.plugin.settings.candidateActor = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("重读候选区")
      .setDesc("夜班刚跑完、或者手工往候选区扔过东西，按一下重新扫一遍。")
      .addButton((button) => {
        button.setButtonText("重读");
        button.onClick(async () => {
          await this.plugin.reloadCandidates();
          this.refreshSection("candidates");
        });
      });
  }

  // -------------------------------------------------------------------------
  // 睡前复盘
  // -------------------------------------------------------------------------

  private renderReviewSection(containerEl: HTMLElement): void {
    this.openInBeginner(new Setting(containerEl))
      .setName("启用睡前复盘")
      .setDesc(
        "取数汇总当日番茄 / 积分 / 目标树，出一版草稿投进夜班候选区；结论由你在拍板面上采纳，才会回写日记、目标树与错题本。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.reviewEnabled);
        toggle.onChange(async (value) => {
          this.plugin.settings.reviewEnabled = value;
          await this.plugin.saveSettings();
          this.refreshSection("review");
        });
      });

    if (!this.plugin.settings.reviewEnabled) return;

    new Setting(containerEl)
      .setName("到点提醒")
      .setDesc("一个账本日只提醒一次。凌晨还没睡的话，进门就会补提醒一次。")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.reviewReminderEnabled);
        toggle.onChange(async (value) => {
          this.plugin.settings.reviewReminderEnabled = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("睡前提醒时间")
      .setDesc("HH:MM。默认 22:00，对齐节律表里睡觉段的起点。")
      .addText((text) => {
        text.setPlaceholder("22:00");
        text.setValue(this.plugin.settings.reviewReminderAt);
        text.onChange(async (value) => {
          if (parseClock(value) === null) return;
          this.plugin.settings.reviewReminderAt = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("日记目录")
      .setDesc("复盘正文的落点，一天一篇 YYYY-MM-DD.md。采纳时是追加，不覆盖你自己写的。")
      .addText((text) => {
        text.setValue(this.plugin.settings.reviewJournalFolder);
        text.onChange(async (value) => {
          this.plugin.settings.reviewJournalFolder = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("复盘素材目录")
      .setDesc("取数汇总落这里，一天一份 JSON。夜班 Agent 读的就是它——换模型换渠道不用改这里。")
      .addText((text) => {
        text.setValue(this.plugin.settings.reviewMaterialFolder);
        text.onChange(async (value) => {
          this.plugin.settings.reviewMaterialFolder = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("错题本笔记")
      .setDesc("「不贰过」采纳后追加进这一篇。不是每天都有这一级的教训，宁可少记。")
      .addText((text) => {
        text.setValue(this.plugin.settings.reviewMistakeNote);
        text.inputEl.addClass("life-cockpit-wide-input");
        text.onChange(async (value) => {
          this.plugin.settings.reviewMistakeNote = value.trim();
          await this.plugin.saveSettings();
        });
      });

    this.openInBeginner(new Setting(containerEl))
      .setName("到点自动落一份素材包")
      .setDesc(
        "到睡前提醒那一刻自动取数、把素材包写出来（只写这一个 JSON，不出草稿、不投候选区）。" +
          "夜班 Agent 读的就是它——关掉的话，你哪天忘了手动发起复盘，那一晚的夜班就什么都读不到。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.reviewMaterialAutoWrite);
        toggle.onChange(async (value) => {
          this.plugin.settings.reviewMaterialAutoWrite = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("现在复盘")
      .setDesc("不用等到点。取数 → 出草稿 → 投候选区，然后去拍板面收。")
      .addButton((button) => {
        button.setButtonText("睡前复盘");
        button.onClick(async () => {
          await this.plugin.runReview();
        });
      })
      .addButton((button) => {
        button.setButtonText("只生成素材包");
        button.onClick(async () => {
          await this.plugin.writeReviewMaterial("manual");
        });
      });
  }

  // -------------------------------------------------------------------------
  // 飞书金字塔表格（AME-258 第 19.1 条）
  //
  // 「我仍然在飞书表格上面做记录」——所以这里**没有**任何一项是在 Obsidian 里
  // 重造那张表。只有两件事：一个点得开的地址，一个读得到的快照目录。
  // -------------------------------------------------------------------------

  private renderFeishuSection(containerEl: HTMLElement): void {
    this.openInBeginner(new Setting(containerEl))
      .setName("启用飞书那一栏")
      .setDesc(
        "复工强提醒页和复盘里多一栏「今天表上安排了什么、做完没有」。" +
          "更新【总结】页走 Convex job，由有 lark-cli 的机器执行；插件不在本地保存飞书凭据。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.feishuEnabled);
        toggle.onChange(async (value) => {
          this.plugin.settings.feishuEnabled = value;
          await this.plugin.saveSettings();
          this.refreshSection("feishu");
        });
      });

    if (!this.plugin.settings.feishuEnabled) return;

    this.openInBeginner(new Setting(containerEl))
      .setName("表格 / 文档地址")
      .setDesc(
        "复工强提醒页、驾驶舱面板、命令面板「打开飞书金字塔表格」都用它。留空就不显示这一条。",
      )
      .addText((text) => {
        text.setPlaceholder("https://my.feishu.cn/wiki/...");
        text.inputEl.addClass("life-cockpit-wide-input");
        text.setValue(this.plugin.settings.feishuSheetUrl);
        text.onChange(async (value) => {
          this.plugin.settings.feishuSheetUrl = value.trim();
          await this.plugin.saveSettings();
        });
      });

    // 【总结】页（AME-271 第 28 条）。**这是飞书那一层第一次有「写」的方向**，
    // 但写的人不是插件，是那台有 lark 凭据的机器上的 py 脚本；插件只存一个入口地址。
    this.openInBeginner(new Setting(containerEl))
      .setName("【总结】页地址")
      .setDesc(
        "整张表的「哪些做了、哪些没做」由 backend/life-cockpit/scripts/write_feishu_summary.py " +
          "整页写进飞书自己的一页里（未完成清单点一下就跳到那一天）。" +
          "脚本跑完会打印那一页的地址，形如 …?sheet=xxxx，贴到这里，面板和命令面板就点得开。" +
          "留空就不显示【打开总结页】那颗按钮。",
      )
      .addText((text) => {
        text.setPlaceholder("https://my.feishu.cn/wiki/...?sheet=...");
        text.inputEl.addClass("life-cockpit-wide-input");
        text.setValue(this.plugin.settings.feishuSummarySheetUrl);
        text.onChange(async (value) => {
          this.plugin.settings.feishuSummarySheetUrl = value.trim();
          await this.plugin.saveSettings();
        });
      });

    containerEl.createDiv({
      cls: "life-cockpit-hint",
      text:
        "主路径是下面的【更新总结页】：插件调用 Convex 的 feishu-snapshot job，" +
        "自动化在 Mac 上跑 refresh_feishu_summary.sh，完成后通过 jobs:watch 报回进度。" +
        "Convex 未配置时，旧版 webhook + Easy Git 只作为下位补充。",
    });

    new Setting(containerEl)
      .setName("更新总结页（主路径）")
      .setDesc(
        "强制创建一次新的 Convex job：拉最新飞书表、推送快照、写回【总结】页。" +
          "先在「Convex 同步」里开启并配好设备令牌；重复点击会在任务结束后才允许再次提交。",
      )
      .addButton((button) => {
        button.setButtonText("更新总结页").setCta();
        button.onClick(async () => {
          button.setDisabled(true).setButtonText("提交中……");
          await this.plugin.refreshFeishuSummary();
          this.refreshSection("feishu");
        });
      })
      .addButton((button) => {
        button.setButtonText("打开总结页");
        button.onClick(() => void this.plugin.openFeishuSummary());
      });

    containerEl.createDiv({
      cls: "life-cockpit-hint",
      text: this.plugin.describeFeishuSummaryRefresh(),
    });

    new Setting(containerEl)
      .setName("快照目录")
      .setDesc(
        "一天一份 YYYY-MM-DD.json，也认目录里的 latest.json；当天没有就退到最近的一份。" +
          "格式直接吃导出管线产的 all_tasks.json，一个字节都不用改。",
      )
      .addText((text) => {
        text.inputEl.addClass("life-cockpit-wide-input");
        text.setValue(this.plugin.settings.feishuSnapshotFolder);
        text.onChange(async (value) => {
          this.plugin.settings.feishuSnapshotFolder = value.trim();
          await this.plugin.saveSettings();
        });
      });

    // 旧版补充链（Convex 主链不可用时才用）：它只负责把仓库里的快照拉回来，
    // 不负责更新【总结】页，也不应再被当成日常主路径。
    containerEl.createDiv({
      cls: "life-cockpit-hint",
      text:
        "这个目录里的快照不是插件生成的。备用链是：插件 POST webhook → 对面导表并推仓库 → " +
        "Easy Git 拉回 → 插件重读目录；没有 webhook 时就手动导出并拷入。",
    });

    this.openInBeginner(new Setting(containerEl))
      .setName("备用：拉取快照的 webhook")
      .setDesc(
        "Multica 上那条 webhook 自动化的地址。留空则读环境变量 LIFE_COCKPIT_FEISHU_PULL_WEBHOOK；" +
          "两处都空就是没有这条路——插件不编造地址。",
      )
      .addText((text) => {
        text.setPlaceholder("https://multica.ai/api/webhooks/...");
        text.inputEl.type = "password";
        text.inputEl.addClass("life-cockpit-wide-input");
        text.setValue(this.plugin.settings.feishuPullWebhook);
        text.onChange(async (value) => {
          this.plugin.settings.feishuPullWebhook = value.trim();
          await this.plugin.saveSettings();
          this.refreshSection("feishu");
        });
      });

    new Setting(containerEl)
      .setName("备用：等新快照的命令")
      .setDesc(
        "等的期间每 30 秒跑一次它，把仓库拉下来。默认是 Easy Git 的「Sync all mappings」。" +
          "**复用 Easy Git 已经配好的 GitHub 凭据——调它的命令，不抄它的 token**，" +
          "所以插件自己一个密钥都不存。留空 = 拉仓库这一步你自己来。",
      )
      .addText((text) => {
        text.setPlaceholder("easy-git:sync-all");
        text.inputEl.addClass("life-cockpit-wide-input");
        text.setValue(this.plugin.settings.feishuPullCommandId);
        text.onChange(async (value) => {
          this.plugin.settings.feishuPullCommandId = value.trim();
          await this.plugin.saveSettings();
          this.refreshSection("feishu");
        });
      });

    this.numberSetting(
      containerEl,
      "最多等几秒",
      "等的是「盘上那份快照变新了」，不是 webhook 回话——完成状态由产物本身回答。" +
        "等不到不算失败，过一会儿按【重读快照】再看一眼就行。",
      this.plugin.settings.feishuPullWaitSeconds,
      async (value) => {
        this.plugin.settings.feishuPullWaitSeconds = Math.max(10, Math.round(value));
        await this.plugin.saveSettings();
        this.refreshSection("feishu");
      },
    );

    containerEl
      .createDiv({ cls: "life-cockpit-hint" })
      .setText(this.plugin.describeFeishuPullConfig());

    new Setting(containerEl)
      .setName("按目标树分组")
      .setDesc(
        "目标项上填一行【飞书关键词】，表上正文含那几个词的条目就算在那支目标名下；" +
          "强提醒页和目标树面板上会按目标列出来。去目标树面板 → 编辑某个目标 → 飞书关键词。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.feishuGroupByGoal);
        toggle.onChange(async (value) => {
          this.plugin.settings.feishuGroupByGoal = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("在复工强提醒页上列出来")
      .setDesc("被拦下来的那几秒，是一天里最可能真的看一眼「今天答应过要做什么」的时刻。")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.feishuShowOnGate);
        toggle.onChange(async (value) => {
          this.plugin.settings.feishuShowOnGate = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("进复盘素材包")
      .setDesc(
        "复盘那一侧就看得到「今天具体在做什么事」——番茄流水记的是时间去处，这一栏记的是事情本身。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.feishuIntoReview);
        toggle.onChange(async (value) => {
          this.plugin.settings.feishuIntoReview = value;
          await this.plugin.saveSettings();
        });
      });

    const status = containerEl.createDiv({ cls: "life-cockpit-hint" });
    status.setText(this.plugin.describeFeishu());

    new Setting(containerEl)
      .setName("现在读一次")
      .addButton((button) => {
        button.setButtonText("重读快照");
        button.onClick(async () => {
          await this.plugin.reloadFeishu();
          this.refreshSection("feishu");
        });
      })
      .addButton((button) => {
        button.setButtonText("备用：拉一份快照");
        button.onClick(async () => {
          await this.plugin.pullFeishuSnapshot();
          this.refreshSection("feishu");
        });
      })
      .addButton((button) => {
        button.setButtonText("打开表格");
        button.onClick(() => void this.plugin.openFeishu());
      });
  }

  /**
   * 秒哒「5 分钟写作」那一节（AME-272 第 26 条）。
   *
   * 两颗按钮对应他补充的那两条：「可以设置——自动拉取」和「也可以，手动去拉取」。
   * 中间那一堆框只有一个是真的要他填的——**apikey**。地址预置好了，落点预置好了。
   */
  private renderMiaodaSection(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;

    this.openInBeginner(new Setting(containerEl))
      .setName("启用秒哒那一栏")
      .setDesc(
        "把秒哒「5 分钟写作」里的记录拉进 vault：一天一页、一段写作一个大标题、原文一字不改。" +
          "落在给人看的那一块，随手改、随手搬走都行——**搬走的段落不会被再拉回来**。",
      )
      .addToggle((toggle) => {
        toggle.setValue(settings.miaodaEnabled);
        toggle.onChange(async (value) => {
          settings.miaodaEnabled = value;
          await this.plugin.saveSettings();
          this.refreshSection("miaoda");
        });
      });

    if (!settings.miaodaEnabled) return;

    this.openInBeginner(new Setting(containerEl))
      .setName("apikey")
      .setDesc(
        "秒哒那个 Supabase 项目的匿名 key（同时用作 Bearer）。**插件不内置任何密钥**——" +
          "这个仓库是公开的。留空则读环境变量 LIFE_COCKPIT_MIAODA_KEY，两处都空就是没配这条路。" +
          "格式是一段 JWT：`eyJhbGciOi….<中间一段>.<签名>`——`eyJ` 开头、两个点分成三段、不含任何空白。" +
          "**粘进来带的换行、空格、引号、`Bearer ` 前缀会被自动去掉**，不用自己先收拾干净。",
      )
      .addText((text) => {
        text.setPlaceholder("eyJhbGciOi....<中间一段>.<签名>");
        text.inputEl.type = "password";
        text.inputEl.addClass("life-cockpit-wide-input");
        text.setValue(settings.miaodaApiKey);
        text.onChange(async (value) => {
          // 洗在**存之前**：脏的那一份一秒钟都不该进 data.json，否则下次打开
          // 看到的还是那一份，而人以为自己填的是干净的（AME-273 第 2 条）。
          const cleaned = cleanSecret(value);
          settings.miaodaApiKey = cleaned.value;
          this.rememberSecretNoise("miaoda", cleaned.removed);
          if (cleaned.changed) text.setValue(cleaned.value);
          await this.plugin.saveSettings();
          this.refreshSection("miaoda");
        });
      });

    // 密钥不回显，但**形状要看得见**：填对没有，这一行是唯一能当场知道的地方。
    this.secretHint(containerEl, "miaoda", settings.miaodaApiKey, true);

    new Setting(containerEl)
      .setName("落点目录")
      .setDesc("一天一份 YYYY-MM-DD.md；同步索引（记着哪一段写过）也在这个目录里。")
      .addText((text) => {
        text.inputEl.addClass("life-cockpit-wide-input");
        text.setValue(settings.miaodaFolder);
        text.onChange(async (value) => {
          settings.miaodaFolder = value.trim();
          await this.plugin.saveSettings();
          this.refreshSection("miaoda");
        });
      });

    new Setting(containerEl)
      .setName("接口地址")
      .setDesc("秒哒应用的 PostgREST 地址，指向写作记录那张表。地址里带着项目 ID，所以插件不预置、由你自己填（公开仓库不替你暴露项目）。")
      .addText((text) => {
        text.inputEl.addClass("life-cockpit-wide-input");
        text.setValue(settings.miaodaEndpoint);
        text.onChange(async (value) => {
          settings.miaodaEndpoint = value.trim();
          await this.plugin.saveSettings();
        });
      });

    this.openInBeginner(new Setting(containerEl))
      .setName("自动拉取")
      .setDesc(
        "开着的话每隔一段时间自己拉一次（只拉动过的那几条，不是每次都把整张表搬一遍）。" +
          "关着也不影响手动拉——命令面板搜「拉一次秒哒」。",
      )
      .addToggle((toggle) => {
        toggle.setValue(settings.miaodaAutoPull);
        toggle.onChange(async (value) => {
          settings.miaodaAutoPull = value;
          await this.plugin.saveSettings();
          this.refreshSection("miaoda");
        });
      });

    if (settings.miaodaAutoPull) {
      this.numberSetting(
        containerEl,
        "多久拉一次（分钟）",
        "下限 5 分钟。那个 APP 一天也写不了几段，太密只是在空跑。",
        settings.miaodaAutoPullMinutes,
        async (value) => {
          settings.miaodaAutoPullMinutes = Math.max(5, Math.round(value));
          await this.plugin.saveSettings();
          this.refreshSection("miaoda");
        },
      );
    }

    new Setting(containerEl)
      .setName("连空白记录也写进来")
      .setDesc(
        "点开了没写的那种（正文空、字数 0）。实测 188 条里有 27 条是这样，所以默认不写——" +
          "落地区里塞一堆空壳，第一眼看到的全是噪音。打开之后这些会补上。",
      )
      .addToggle((toggle) => {
        toggle.setValue(settings.miaodaIncludeEmpty);
        toggle.onChange(async (value) => {
          settings.miaodaIncludeEmpty = value;
          await this.plugin.saveSettings();
        });
      });

    containerEl.createDiv({
      cls: "life-cockpit-hint",
      text:
        "日期按驾驶舱的账本日分桶（设置 → 番茄 → 番茄流水里那个换日点，默认 04:00），" +
        "而且按「开始写」那一刻算，不按远端的 updated_at——" +
        "远端做过一次批量迁移，拿 updated_at 分桶会把七月的记录整片扔进八月。",
    });

    containerEl.createDiv({ cls: "life-cockpit-hint" }).setText(this.plugin.describeMiaoda());

    new Setting(containerEl)
      .setName("现在拉一次")
      .addButton((button) => {
        button.setButtonText("拉一次").setCta();
        button.onClick(async () => {
          await this.plugin.pullMiaoda();
          this.refreshSection("miaoda");
        });
      })
      .addButton((button) => {
        button.setButtonText("整份重拉");
        button.onClick(async () => {
          await this.plugin.pullMiaoda({ full: true });
          this.refreshSection("miaoda");
        });
      })
      .addButton((button) => {
        button.setButtonText("打开今天那一页");
        button.onClick(() => void this.plugin.openMiaodaToday());
      });
  }

  // -------------------------------------------------------------------------
  // AI 接口（AME-258 第 20 条 / 第 22.1 条）
  //
  // 「将来，可能会增加新的 AI 模型啥的，我希望都能便于配置」——所以这一节的形状是
  // **一张可增删的档位表**，加一个模型就是加一行，不是改代码。
  //
  // 0.11.0 起它有**自己一页**：「其实，将来，它会变成一个【全局性】的设置——
  // 因为其它地方，可能也大量使用到 Flash AI 接口。」用途表（`AI_CONSUMERS`）在下面，
  // 加一处用途就是加一行，档位和密钥一个字都不用动。
  // -------------------------------------------------------------------------

  /**
   * Convex 同步那一节。
   *
   * **这一节的设计目标只有一个：不让人碰命令行。** 上一版要求在 Win10 上
   * clone 仓库再跑 `npx convex run devices:issue`——那是把「填两个框」的事
   * 变成了搭一套开发环境，仓库主人指出这一点是对的。
   *
   * 现在只有三个框：地址、配对码（一次性）、以及配完之后自己填好的令牌。
   */
  private renderConvexSection(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;

    this.openInBeginner(new Setting(containerEl))
      .setName("开启 Convex 同步")
      .setDesc(
        "把番茄流水、积分、目标树同步到后端，数据台那一页才有东西。"
        + "**它是同步层不是运行时依赖**——关掉、连不上、没网，番茄都照跑。",
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.convexEnabled).onChange(async (value) => {
          settings.convexEnabled = value;
          await this.plugin.saveSettings();
          this.plugin.applyConvexConfig();
          this.refreshSection("convex");
        }),
      );

    if (!settings.convexEnabled) return;

    new Setting(containerEl)
      .setName("服务地址")
      .setDesc("形如 https://xxx-yyy-123.convex.cloud。留空则读环境变量 LIFE_COCKPIT_CONVEX_URL。")
      .addText((text) =>
        text
          .setPlaceholder("https://....convex.cloud")
          .setValue(settings.convexUrl)
          .onChange(async (value) => {
            settings.convexUrl = value.trim();
            await this.plugin.saveSettings();
            this.plugin.applyConvexConfig();
          }),
      );

    // 状态那一行：**「一切正常」也要说出来**，否则人不知道它在不在跑
    const status = this.plugin.convexStatus();
    new Setting(containerEl)
      .setName("状态")
      .setDesc(`${status.detail}　${this.plugin.outboxSummary()}`)
      .addButton((button) =>
        button.setButtonText("刷新").onClick(() => this.refreshSection("convex")),
      )
      // 客户端是懒的，没订阅就不会去连——所以「填完了但通没通」这一问
      // 必须有一颗按钮当场回答，不能让人等到第一个番茄跑完才知道
      .addButton((button) =>
        button.setButtonText("测一次连接").onClick(async () => {
          button.setDisabled(true).setButtonText("测试中……");
          await this.plugin.probeConvex();
          this.refreshSection("convex");
        }),
      );

    const paired = settings.convexToken !== "";
    new Setting(containerEl)
      .setName(paired ? "已配对" : "配对这台机器")
      .setDesc(
        paired
          ? "这台机器已经有设备令牌了。想换一个（比如令牌泄露、或者换了机器）就再配一次——"
            + "新令牌会顶掉同名的旧令牌。"
          : "**不需要 clone 仓库，也不需要命令行。** 去 Convex Dashboard → Settings → "
            + "Environment Variables 加一个 LIFE_COCKPIT_PAIR_CODE（至少 16 位），"
            + "把它填在下面按【配对】。配完就可以把那个变量删掉——它只在这一下需要。",
      );

    let pairCode = "";
    let deviceLabel = "win10-obsidian";
    new Setting(containerEl)
      .setName("配对码")
      .addText((text) =>
        text.setPlaceholder("Dashboard 里那一串").onChange((value) => {
          pairCode = value.trim();
        }),
      )
      .addText((text) =>
        text
          .setPlaceholder("这台机器叫什么")
          .setValue(deviceLabel)
          .onChange((value) => {
            deviceLabel = value.trim() || "未命名设备";
          }),
      )
      .addButton((button) =>
        button
          .setButtonText("配对")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true).setButtonText("配对中……");
            await this.plugin.pairConvexDevice(pairCode, deviceLabel);
            this.refreshSection("convex");
          }),
      );

    new Setting(containerEl)
      .setName("多久推一次")
      .setDesc("出站队列的节拍。默认 30 秒——人感觉不到，断网攒着也不会堆太久。")
      .addSlider((slider) =>
        slider
          .setLimits(10, 300, 10)
          .setValue(settings.convexSyncSeconds)
          .setDynamicTooltip()
          .onChange(async (value) => {
            settings.convexSyncSeconds = value;
            await this.plugin.saveSettings();
          }),
      );
  }

  private renderAiSection(containerEl: HTMLElement): void {
    containerEl.createDiv({
      cls: "life-cockpit-hint",
      text:
        "这一页是全局的一层：底下所有用得上模型的地方共用这里的档位和密钥，" +
        "换模型只改这一处。",
    });

    this.openInBeginner(new Setting(containerEl))
      .setName("启用 AI 接口")
      .setDesc(
        "默认关：它要花钱、要密钥，这两样都该由你明确点头。开了之后，下面「谁在用它」里那几处才真的会去调模型。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.aiEnabled);
        toggle.onChange(async (value) => {
          this.plugin.settings.aiEnabled = value;
          await this.plugin.saveSettings();
          this.refreshSection("ai");
        });
      });

    const status = containerEl.createDiv({ cls: "life-cockpit-hint" });
    status.setText(this.plugin.describeAiStatus());

    if (!this.plugin.settings.aiEnabled) return;

    this.openInBeginner(new Setting(containerEl))
      .setName("用哪一档")
      .addDropdown((dropdown) => {
        for (const profile of this.plugin.settings.aiProfiles) {
          dropdown.addOption(profile.id, `${profile.label}（${profile.model || "没填模型"}）`);
        }
        if (!this.plugin.settings.aiProfiles.length) dropdown.addOption("", "一档都没有");
        dropdown.setValue(this.plugin.settings.aiActiveProfile);
        dropdown.onChange(async (value) => {
          this.plugin.settings.aiActiveProfile = value;
          await this.plugin.saveSettings();
          this.refreshSection("ai");
        });
      });

    // 「谁在用它」。这张表就是「全局」两个字的落点——以后加一处用途，
    // 是往 `AI_CONSUMERS` 里加一行，不是在这一页上再堆一个开关。
    new Setting(containerEl).setName("谁在用它").setHeading();
    for (const consumer of AI_CONSUMERS) {
      const row = new Setting(containerEl).setName(consumer.label).setDesc(consumer.detail);
      const key = consumer.toggle;
      if (key === null) continue;
      row.addToggle((toggle) => {
        toggle.setValue(this.plugin.settings[key] === true);
        toggle.onChange(async (value) => {
          // 用途表里的开关都是 boolean 字段，这里的赋值只对这一类成立。
          (this.plugin.settings as unknown as Record<string, boolean>)[key] = value;
          await this.plugin.saveSettings();
          this.refreshSection("ai");
        });
      });
    }

    new Setting(containerEl)
      .setName("测一次")
      .setDesc("现在就问模型一句，通没通当场看得见。")
      .addButton((button) => {
        button.setButtonText("测一次连接");
        button.onClick(async () => {
          await this.plugin.testAi();
          this.refreshSection("ai");
        });
      })
      .addButton((button) => {
        button.setButtonText("加一档");
        button.onClick(async () => {
          const index = this.plugin.settings.aiProfiles.length + 1;
          this.plugin.settings.aiProfiles.push(createAiProfile(index));
          await this.plugin.saveSettings();
          this.refreshSection("ai");
        });
      });

    for (const profile of this.plugin.settings.aiProfiles) {
      this.renderAiProfile(containerEl, profile);
    }
  }

  /** 一档的全部字段。**密钥这一格是 password 类型**，设置页上不明文摆着。 */
  private renderAiProfile(containerEl: HTMLElement, profile: AiProfile): void {
    const box = containerEl.createDiv({ cls: "life-cockpit-settings-section" });
    const active = profile.id === this.plugin.settings.aiActiveProfile;
    new Setting(box).setName(`${profile.label}${active ? "（当前）" : ""}`).setHeading();

    const save = async (): Promise<void> => {
      await this.plugin.saveSettings();
    };

    new Setting(box).setName("名字").addText((text) => {
      text.setValue(profile.label);
      text.onChange(async (value) => {
        profile.label = value;
        await save();
      });
    });

    new Setting(box)
      .setName("base URL")
      .setDesc("OpenAI 兼容的地址，末尾不带 /chat/completions。")
      .addText((text) => {
        text.setPlaceholder("https://opencode.ai/zen/go/v1");
        text.inputEl.addClass("life-cockpit-wide-input");
        text.setValue(profile.baseUrl);
        text.onChange(async (value) => {
          profile.baseUrl = value.trim();
          await save();
        });
      });

    new Setting(box)
      .setName("模型")
      .setDesc("填端点自己认的那个 id。OpenCode Go 上的 Flash 是 deepseek-v4-flash。")
      .addText((text) => {
        text.setPlaceholder("deepseek-v4-flash");
        text.setValue(profile.model);
        text.onChange(async (value) => {
          profile.model = value.trim();
          await save();
        });
      });

    const keySetting = new Setting(box)
      .setName("密钥")
      .setDesc(
        "存在 vault 内的 data.json 里（不在 2A-META 仓库内，不会随仓库公开）。" +
          "不想落盘的话这里留空，改用下面那个环境变量。" +
          "**粘进来带的换行、空格、引号、`Bearer ` 前缀会被自动去掉**（AME-273 第 2 条）。",
      );
    const keyHintEl = this.secretHint(box, `ai:${profile.id}`, profile.apiKey, false);
    keySetting.addText((text) => {
      text.inputEl.type = "password";
      text.inputEl.addClass("life-cockpit-wide-input");
      text.setValue(profile.apiKey);
      text.onChange(async (value) => {
        const cleaned = cleanSecret(value);
        profile.apiKey = cleaned.value;
        this.rememberSecretNoise(`ai:${profile.id}`, cleaned.removed);
        if (cleaned.changed) text.setValue(cleaned.value);
        this.paintSecretHint(keyHintEl, `ai:${profile.id}`, cleaned.value, false);
        await save();
      });
    });

    new Setting(box)
      .setName("密钥环境变量名")
      .setDesc("上面留空时读它。两处都空就是「缺配置」，插件停下来说缺什么，不猜。")
      .addText((text) => {
        text.setPlaceholder("LIFE_COCKPIT_AI_API_KEY");
        text.setValue(profile.apiKeyEnv);
        text.onChange(async (value) => {
          profile.apiKeyEnv = value.trim();
          await save();
        });
      });

    this.numberSetting(box, "超时（秒）", "问不出结果就别一直等着。", profile.timeoutSeconds, async (value) => {
      profile.timeoutSeconds = Math.max(5, Math.round(value));
      await save();
    });

    this.numberSetting(
      box,
      "max_tokens",
      "0 = 不限。复盘草稿是整篇 Markdown，太小会被截断成空正文。",
      profile.maxTokens,
      async (value) => {
        profile.maxTokens = Math.max(0, Math.round(value));
        await save();
      },
    );

    new Setting(box).setName("删掉这一档").addButton((button) => {
      button.setButtonText("删掉").setWarning();
      button.onClick(async () => {
        this.plugin.settings.aiProfiles = this.plugin.settings.aiProfiles.filter(
          (item) => item !== profile,
        );
        await this.plugin.saveSettings();
        this.refreshSection("ai");
      });
    });
  }

  // -------------------------------------------------------------------------
  // AI 调用记录（AME-258 第 22.1 条）
  //
  // 「目前 Flash 的执行——其实我看不到【请求和返回】，这样，如果出现了错误或者偏离；
  //  我是意识不到的？（可能，需要存储 N 天之内的记录，在本地；然后插件设置里，
  //  有一个开关，可以简单列表式的预览一下。）」——这一节就是那个开关和那份列表。
  // -------------------------------------------------------------------------

  private renderAiLogSection(containerEl: HTMLElement): void {
    this.openInBeginner(new Setting(containerEl))
      .setName("记下每次调用的请求与返回")
      .setDesc(
        "默认开。**只落在本机**：插件自己的目录里（和 data.json 同级），" +
          "不在 2A-META 仓库内，不会随仓库公开。**密钥不进日志。**",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.aiLogEnabled);
        toggle.onChange(async (value) => {
          this.plugin.settings.aiLogEnabled = value;
          await this.plugin.saveSettings();
          this.refreshSection("ai-log");
        });
      });

    if (!this.plugin.settings.aiLogEnabled) {
      containerEl.createDiv({
        cls: "life-cockpit-hint",
        text: "关着的时候一条都不记——出了偏差只能靠开发者控制台，而那个是不留存的。",
      });
      return;
    }

    this.numberSetting(
      containerEl,
      "留几天",
      "一天一份文件，过期的那一份整份删。默认 7 天。",
      this.plugin.settings.aiLogKeepDays,
      async (value) => {
        this.plugin.settings.aiLogKeepDays = Math.min(365, Math.max(1, Math.round(value)));
        await this.plugin.saveSettings();
        this.refreshSection("ai-log");
      },
    );

    // 简单列表式的预览：最近几条直接摆在设置页上，点【看全部】才开详情窗。
    const preview = containerEl.createDiv({ cls: "life-cockpit-hint" });
    preview.setText("正在读记录……");
    void this.plugin.aiLogToday().then((entries) => {
      preview.empty();
      preview.setText(summarizeAiLog(entries));
      if (!entries.length) return;
      const list = containerEl.createDiv({ cls: "life-cockpit-ai-log-preview" });
      for (const entry of entries.slice(0, 5)) {
        const row = list.createDiv({ cls: "life-cockpit-ai-log-line" });
        row.toggleClass("is-failed", !entry.ok);
        row.setText(`${describeAiLogEntry(entry)} — ${entry.detail}`);
      }
    });

    new Setting(containerEl)
      .setName("翻记录")
      .setDesc("一行一条，点开看得到当时发出去的完整 prompt 和收回来的正文。")
      .addButton((button) => {
        button.setButtonText("看全部");
        button.onClick(() => new AiLogModal(this.app, this.plugin).open());
      })
      .addButton((button) => {
        button.setButtonText("全清").setWarning();
        button.onClick(async () => {
          await this.plugin.clearAiLog();
          this.refreshSection("ai-log");
        });
      });
  }

  // -------------------------------------------------------------------------
  // 推动器
  // -------------------------------------------------------------------------

  private renderNudgeSection(containerEl: HTMLElement): void {
    this.openInBeginner(new Setting(containerEl))
      .setName("启用推动器")
      .setDesc(
        "把番茄、节律、睡前复盘这些事推到 Obsidian 窗口之外去。" +
          "推不动人的推送等于噪音，推太多会被整个关掉——所以下面那几道闸都是认真的。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.nudgeEnabled);
        toggle.onChange(async (value) => {
          this.plugin.settings.nudgeEnabled = value;
          await this.plugin.saveSettings();
          this.refreshSection("nudge");
        });
      });

    if (!this.plugin.settings.nudgeEnabled) return;

    // 渠道状态先摆出来：配没配对、缺什么，一眼看得见，不用去试。
    const status = containerEl.createDiv({ cls: "life-cockpit-channel-status" });
    for (const channel of this.plugin.push.statuses()) {
      const row = status.createDiv({ cls: "life-cockpit-channel-row" });
      row.addClass(`is-${channel.state}`);
      row.createSpan({ cls: "life-cockpit-channel-name", text: channel.label });
      row.createSpan({
        cls: "life-cockpit-channel-state",
        text: CHANNEL_STATE_LABELS[channel.state],
      });
      row.createSpan({ cls: "life-cockpit-channel-detail", text: channel.detail });
    }

    this.openInBeginner(new Setting(containerEl))
      .setName("静音")
      .setDesc("人明确要求安静时按这个。静音期间一条都不推，强制级也不例外。")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.nudgeMuted);
        toggle.onChange(async (value) => {
          this.plugin.settings.nudgeMuted = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("最低分级")
      .setDesc("低于这一级的一律不推。嫌吵先往上调这一项，再考虑整个关掉。")
      .addDropdown((dropdown) => {
        for (const level of NUDGE_LEVELS) dropdown.addOption(level, NUDGE_LEVEL_LABELS[level]);
        dropdown.setValue(this.plugin.settings.nudgeMinLevel);
        dropdown.onChange(async (value) => {
          this.plugin.settings.nudgeMinLevel = value as NudgeLevel;
          await this.plugin.saveSettings();
        });
      });

    const quiet = new Setting(containerEl)
      .setName("免打扰时段")
      .setDesc("HH:MM 到 HH:MM，结束早于开始视为跨零点。默认对齐节律表的睡觉段。");
    quiet.addText((text) => {
      text.setPlaceholder("22:00");
      text.inputEl.addClass("life-cockpit-clock-input");
      text.setValue(this.plugin.settings.nudgeQuietFrom);
      text.onChange(async (value) => {
        this.plugin.settings.nudgeQuietFrom = value.trim();
        text.inputEl.toggleClass("is-invalid", parseClock(value.trim()) === null);
        await this.plugin.saveSettings();
      });
    });
    quiet.addText((text) => {
      text.setPlaceholder("05:00");
      text.inputEl.addClass("life-cockpit-clock-input");
      text.setValue(this.plugin.settings.nudgeQuietTo);
      text.onChange(async (value) => {
        this.plugin.settings.nudgeQuietTo = value.trim();
        text.inputEl.toggleClass("is-invalid", parseClock(value.trim()) === null);
        await this.plugin.saveSettings();
      });
    });

    new Setting(containerEl)
      .setName("免打扰时段里仍推「强制」级")
      .setDesc("锁屏倒计时这类走强制级。关掉之后，夜里连它也不推。")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.nudgeQuietBypassHard);
        toggle.onChange(async (value) => {
          this.plugin.settings.nudgeQuietBypassHard = value;
          await this.plugin.saveSettings();
        });
      });

    this.numberSetting(
      containerEl,
      "同一件事的冷却（分钟）",
      "同一个事由多久之内不重复推。0 = 不冷却。强制级也守这一条。",
      this.plugin.settings.nudgeCooldownMinutes,
      async (value) => {
        this.plugin.settings.nudgeCooldownMinutes = value;
        await this.plugin.saveSettings();
      },
    );

    this.numberSetting(
      containerEl,
      "每日配额",
      "一天最多推几条。0 = 不限。强制级不吃配额——它靠冷却限，不靠配额。",
      this.plugin.settings.nudgeDailyCap,
      async (value) => {
        this.plugin.settings.nudgeDailyCap = value;
        await this.plugin.saveSettings();
      },
    );

    new Setting(containerEl)
      .setName("系统通知")
      .setDesc("不需要任何凭据，所以它是第一条打通的通道。Obsidian 不在最前也看得见。")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.nudgeSystemEnabled);
        toggle.onChange(async (value) => {
          this.plugin.settings.nudgeSystemEnabled = value;
          await this.plugin.saveSettings();
          this.refreshSection("nudge");
        });
      });

    new Setting(containerEl)
      .setName("飞书")
      .setDesc(
        "飞书自定义机器人。地址与签名密钥写在下面，或改用环境变量 " +
          "LIFE_COCKPIT_FEISHU_WEBHOOK / LIFE_COCKPIT_FEISHU_SECRET。" +
          "两处都空就是缺配置，插件会明说缺什么，不会去猜。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.nudgeFeishuEnabled);
        toggle.onChange(async (value) => {
          this.plugin.settings.nudgeFeishuEnabled = value;
          await this.plugin.saveSettings();
          this.refreshSection("nudge");
        });
      });

    if (this.plugin.settings.nudgeFeishuEnabled) {
      new Setting(containerEl)
        .setName("飞书 webhook 地址")
        .setDesc("机器人的 webhook。写在这里等于写进 vault 里的 data.json，自己掂量。")
        .addText((text) => {
          text.setPlaceholder("留空则读 LIFE_COCKPIT_FEISHU_WEBHOOK");
          text.inputEl.addClass("life-cockpit-wide-input");
          text.setValue(this.plugin.settings.nudgeFeishuWebhook);
          text.onChange(async (value) => {
            this.plugin.settings.nudgeFeishuWebhook = value.trim();
            await this.plugin.saveSettings();
          });
        });

      new Setting(containerEl)
        .setName("飞书签名密钥")
        .setDesc("机器人开了签名校验才需要。没开就留空。")
        .addText((text) => {
          text.setPlaceholder("留空则读 LIFE_COCKPIT_FEISHU_SECRET");
          text.inputEl.type = "password";
          text.inputEl.addClass("life-cockpit-wide-input");
          text.setValue(this.plugin.settings.nudgeFeishuSecret);
          text.onChange(async (value) => {
            this.plugin.settings.nudgeFeishuSecret = value.trim();
            await this.plugin.saveSettings();
          });
        });
    }

    new Setting(containerEl)
      .setName("通用 webhook")
      .setDesc(
        "POST 一份 JSON 到你自己的地址：邮件网关、工单系统都从这里接。" +
          "插件不内置 SMTP——把邮箱密码存进 vault 换一个直连，不值。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.nudgeWebhookEnabled);
        toggle.onChange(async (value) => {
          this.plugin.settings.nudgeWebhookEnabled = value;
          await this.plugin.saveSettings();
          this.refreshSection("nudge");
        });
      });

    if (this.plugin.settings.nudgeWebhookEnabled) {
      new Setting(containerEl)
        .setName("webhook 地址")
        .addText((text) => {
          text.setPlaceholder("留空则读 LIFE_COCKPIT_WEBHOOK_URL");
          text.inputEl.addClass("life-cockpit-wide-input");
          text.setValue(this.plugin.settings.nudgeWebhookUrl);
          text.onChange(async (value) => {
            this.plugin.settings.nudgeWebhookUrl = value.trim();
            await this.plugin.saveSettings();
          });
        });
    }

    new Setting(containerEl)
      .setName("试推一条")
      .setDesc("当场看渠道通不通。被闸门拦下来也会如实告诉你是哪一道。")
      .addButton((button) => {
        button.setButtonText("试推");
        button.onClick(async () => {
          await this.plugin.testPush();
          this.refreshSection("nudge");
        });
      });
  }

  // -------------------------------------------------------------------------
  // 复工强提醒页
  // -------------------------------------------------------------------------

  private renderGateSection(containerEl: HTMLElement): void {
    this.openInBeginner(new Setting(containerEl))
      .setName("启用复工强提醒页")
      .setDesc(
        "从休息回到工作之前，先过一页。拦着的时候番茄是停的——" +
          "盯着这一页发呆的时间不该被记成专注。用的是禅定那块遮罩，不是另一层窗。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.gateEnabled);
        toggle.onChange(async (value) => {
          this.plugin.settings.gateEnabled = value;
          await this.plugin.saveSettings();
          this.refreshSection("gate");
        });
      });

    if (!this.plugin.settings.gateEnabled) return;

    new Setting(containerEl)
      .setName("拦的频率")
      .addDropdown((dropdown) => {
        for (const id of GATE_FREQUENCIES) dropdown.addOption(id, GATE_FREQUENCY_LABELS[id]);
        dropdown.setValue(this.plugin.settings.gateFrequency);
        dropdown.onChange(async (value) => {
          this.plugin.settings.gateFrequency = value as GateFrequency;
          await this.plugin.saveSettings();
        });
      });

    this.numberSetting(
      containerEl,
      "最短停留（秒）",
      "按钮在这之前是灰的。秒过等于没看。",
      this.plugin.settings.gateDwellSeconds,
      async (value) => {
        this.plugin.settings.gateDwellSeconds = value;
        await this.plugin.saveSettings();
      },
    );

    new Setting(containerEl)
      .setName("倒计时只在你真的看着时才走")
      .setDesc(
        "关掉的话它按墙上的钟走：人去做家务、睡了两个小时，回来这一页已经自己变成" +
          "「看完了，开工」了——那一页根本没人看过（AME-238）。" +
          `现在：${this.plugin.describeAttentionNow()}`,
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.gateRequireAttention);
        toggle.onChange(async (value) => {
          this.plugin.settings.gateRequireAttention = value;
          await this.plugin.saveSettings();
          this.refreshSection("gate");
        });
      });

    new Setting(containerEl)
      .setName("允许跳过")
      .setDesc(
        "留一个「这次先跳过」。锁死的界面第二天就会被整个关掉，这个口子最好别堵。" +
          "**它只跳过这一次**——下一段休息完照样拦；想整天不被拦，关上面那个总开关。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.gateAllowSkip);
        toggle.onChange(async (value) => {
          this.plugin.settings.gateAllowSkip = value;
          await this.plugin.saveSettings();
        });
      });

    this.numberSetting(
      containerEl,
      "离开多久算「复工」（分钟）",
      "从头开始一个番茄时，离上一次收工超过这么久才拦。",
      this.plugin.settings.gateIdleMinutes,
      async (value) => {
        this.plugin.settings.gateIdleMinutes = value;
        await this.plugin.saveSettings();
      },
    );

    this.plugin.settings.gatePages.forEach((page, index) => {
      const setting = new Setting(containerEl)
        .setName(`强提醒页 ${index + 1}`)
        .setDesc("名称 + vault 内笔记路径。多页按天轮换：同一天同一页，换一天换一页。");
      setting.addText((text) => {
        text.setPlaceholder("名称");
        text.setValue(page.label);
        text.onChange(async (value) => {
          page.label = value;
          await this.plugin.saveSettings();
        });
      });
      setting.addText((text) => {
        text.setPlaceholder("Root/每日Journal/日记/日记模板.md");
        text.inputEl.addClass("life-cockpit-wide-input");
        text.setValue(page.notePath);
        text.onChange(async (value) => {
          page.notePath = value.trim();
          await this.plugin.saveSettings();
        });
      });
      setting.addExtraButton((button) => {
        button.setIcon("trash");
        button.setTooltip("删掉这一页");
        button.onClick(async () => {
          this.plugin.settings.gatePages.splice(index, 1);
          await this.plugin.saveSettings();
          this.refreshSection("gate");
        });
      });
    });

    new Setting(containerEl)
      .setName("加一页")
      .addButton((button) => {
        button.setButtonText("新增强提醒页");
        button.onClick(async () => {
          const next = this.plugin.settings.gatePages.length + 1;
          this.plugin.settings.gatePages.push({
            id: `gate-${next}`,
            label: `强提醒页 ${next}`,
            notePath: "",
          });
          await this.plugin.saveSettings();
          this.refreshSection("gate");
        });
      });

    new Setting(containerEl)
      .setName("一并列出今日推荐")
      .setDesc("被拦下来的这几秒，是一天里最可能真的看一眼推荐的时刻。")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.gateShowReading);
        toggle.onChange(async (value) => {
          this.plugin.settings.gateShowReading = value;
          await this.plugin.saveSettings();
        });
      });
  }

  // -------------------------------------------------------------------------
  // 每日推荐读物
  // -------------------------------------------------------------------------

  private renderReadingSection(containerEl: HTMLElement): void {
    this.openInBeginner(new Setting(containerEl))
      .setName("启用每日推荐")
      .setDesc(
        "料全部来自现成的地方：候选区里夜班的 N 次方总结、休息页、复盘素材，" +
          "外加下面这个可选的读物池。按天轮换，不随机。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.readingEnabled);
        toggle.onChange(async (value) => {
          this.plugin.settings.readingEnabled = value;
          await this.plugin.saveSettings();
          this.refreshSection("reading");
        });
      });

    if (!this.plugin.settings.readingEnabled) return;

    this.numberSetting(
      containerEl,
      "一天推几条",
      "四类轮着取，不让资讯把精品阅读和复盘挤没。",
      this.plugin.settings.readingCount,
      async (value) => {
        this.plugin.settings.readingCount = Math.max(0, Math.round(value));
        await this.plugin.saveSettings();
      },
    );

    this.stacked(new Setting(containerEl))
      .setName("读物池")
      .setDesc(
        "一行一条，可以留空。**不以 .md 结尾的一行按目录展开**，目录里的每篇笔记都进池子，" +
          "以后往目录里加笔记不用回来改这里。比如整个「人文社会科学」目录填一行就够。",
      )
      .addTextArea((text) => {
        text.inputEl.addClass("life-cockpit-textarea");
        text.inputEl.placeholder =
          "Root/【2A-META】AI-First时代，知识库（toAI完全公开）/AI-First时代，知识库（toAI完全公开）/人文社会科学";
        text.setValue(this.plugin.settings.readingPool.join("\n"));
        text.onChange(async (value) => {
          this.plugin.settings.readingPool = value
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== "");
          await this.plugin.saveSettings();
        });
      });

    // 填完当场告诉他展开成了几篇。路径写错最常见的表现就是「一篇都没展开」，
    // 而那件事在推荐清单里是看不出来的——它只会安静地少几条。
    containerEl
      .createDiv({ cls: "life-cockpit-hint" })
      .setText(this.plugin.describeReadingPool());

    new Setting(containerEl)
      .setName("到点推一次")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.readingPushEnabled);
        toggle.onChange(async (value) => {
          this.plugin.settings.readingPushEnabled = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("推送时间")
      .setDesc("HH:MM。默认 08:30，三小时工作日开工前半小时。一个账本日只推一次。")
      .addText((text) => {
        text.setPlaceholder("08:30");
        text.inputEl.addClass("life-cockpit-clock-input");
        text.setValue(this.plugin.settings.readingPushAt);
        text.onChange(async (value) => {
          if (parseClock(value.trim()) === null) return;
          this.plugin.settings.readingPushAt = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("看看今天推什么")
      .addButton((button) => {
        button.setButtonText("今日推荐");
        button.onClick(() => this.plugin.showReading());
      });
  }

  // -------------------------------------------------------------------------
  // 强制休息与锁屏
  // -------------------------------------------------------------------------

  private renderLockSection(containerEl: HTMLElement): void {
    this.openInBeginner(new Setting(containerEl))
      .setName("休息段锁屏")
      .setDesc(
        "这是整个插件里唯一不可逆的动作，所以默认关着。开之前先看清楚：" +
          "锁之前有倒计时，倒计时里能推迟、能今天豁免；锁错时机比不锁更糟。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.lockEnabled);
        toggle.onChange(async (value) => {
          this.plugin.settings.lockEnabled = value;
          await this.plugin.saveSettings();
          this.refreshSection("lock");
        });
      });

    const support = containerEl.createDiv({ cls: "life-cockpit-lock-support" });
    support.toggleClass("is-unsupported", !this.plugin.lockSupported);
    support.setText(
      this.plugin.lockSupported
        ? `这台机器：${this.plugin.describeLockSupport()}`
        : `这台机器锁不动：${this.plugin.describeLockSupport()}`,
    );

    if (!this.plugin.settings.lockEnabled) return;

    new Setting(containerEl)
      .setName("哪种休息段锁")
      .addDropdown((dropdown) => {
        for (const id of LOCK_TRIGGERS) dropdown.addOption(id, LOCK_TRIGGER_LABELS[id]);
        dropdown.setValue(this.plugin.settings.lockTrigger);
        dropdown.onChange(async (value) => {
          this.plugin.settings.lockTrigger = value as LockTrigger;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("锁屏方式")
      .setDesc(
        "macOS 与 Windows 各有实现，Linux 没做——桌面环境太杂，没在真机上验过的命令不写进来充数。",
      )
      .addDropdown((dropdown) => {
        for (const id of LOCK_METHODS) dropdown.addOption(id, LOCK_METHOD_LABELS[id]);
        dropdown.setValue(this.plugin.settings.lockMethod);
        dropdown.onChange(async (value) => {
          this.plugin.settings.lockMethod = value as LockMethodId;
          await this.plugin.saveSettings();
          this.refreshSection("lock");
        });
      });

    this.numberSetting(
      containerEl,
      "倒计时（秒）",
      "真锁之前留给你反悔的时间。这段时间里 Esc = 推迟。",
      this.plugin.settings.lockCountdownSeconds,
      async (value) => {
        this.plugin.settings.lockCountdownSeconds = Math.max(1, Math.round(value));
        await this.plugin.saveSettings();
      },
    );

    this.numberSetting(
      containerEl,
      "推迟多久（分钟）",
      "按一次「推迟」往后推多久不再提。",
      this.plugin.settings.lockDeferMinutes,
      async (value) => {
        this.plugin.settings.lockDeferMinutes = Math.max(1, Math.round(value));
        await this.plugin.saveSettings();
      },
    );
  }

  /**
   * 强制干扰（AME-238）。
   *
   * 这一节和上面那节「强制休息与锁屏」是两条路，各有各的开关，**故意不合并**：
   * 上面那条是 R6 的「休息段提议锁屏」，默认关着；这一条是「人不听的时候怎么办」，
   * 默认开着。合成一个开关的话，已经装过 0.6.x 的机器上 `lockEnabled: false`
   * 早就存进 data.json 了，新功能会一出生就是哑的——那正是这条 issue 抱怨的事。
   */
  private renderEnforceSection(containerEl: HTMLElement): void {
    this.openInBeginner(new Setting(containerEl))
      .setName("启用强制干扰")
      .setDesc(
        "番茄快跑完时连击通知 + 屏幕亮度缓速闪烁；进入休息先锁屏；" +
          "休息结束还没复工就每隔一阵催一轮，空闲的话连锁屏。" +
          "推不动人的提醒等于没提醒——这一层就是那个「推得动」。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.enforceEnabled);
        toggle.onChange(async (value) => {
          this.plugin.settings.enforceEnabled = value;
          await this.plugin.saveSettings();
          this.refreshSection("enforce");
        });
      });

    if (!this.plugin.settings.enforceEnabled) return;

    const plan = containerEl.createDiv({ cls: "life-cockpit-enforce-plan" });
    plan.setText(this.plugin.describeEnforcement());

    const bridge = containerEl.createDiv({ cls: "life-cockpit-lock-support" });
    bridge.setText(
      `这台机器：${this.plugin.describeDesktopBridge()} · ${this.plugin.describeBrightnessSupport()}`,
    );

    new Setting(containerEl)
      .setName("先演练一次")
      .setDesc(
        "20 秒的干扰演练。**先按这个**——不然要验「收工前会怎样」得真的坐等二十几分钟，" +
          "而验锁屏还得重新登录一次。",
      )
      .addButton((button) => {
        button.setButtonText("演练 20 秒");
        button.onClick(() => this.plugin.enforceDrill());
      })
      .addButton((button) => {
        button.setButtonText("立刻停");
        button.onClick(() => this.plugin.stopEnforcement());
      })
      .addButton((button) => {
        button.setButtonText("测一次亮度");
        button.onClick(() => {
          void this.plugin.probeBrightness().then(() => this.refreshSection("enforce"));
        });
      });

    // --- 临近收工 ---

    this.numberSetting(
      containerEl,
      "收工前多少秒开始连击",
      "原话是 3 分钟（180 秒）。0 = 不做这一段。",
      this.plugin.settings.enforcePreEndSeconds,
      async (value) => {
        this.plugin.settings.enforcePreEndSeconds = Math.round(value);
        await this.plugin.saveSettings();
        this.refreshSection("enforce");
      },
    );

    this.numberSetting(
      containerEl,
      "连击间隔（秒）",
      "1–2 秒是原话的口径。通知走同一个 tag：每次都响，但通知中心里只留一条——" +
        "刷屏的下场是人去系统里把 Obsidian 的通知整个关掉。",
      this.plugin.settings.enforceBurstSeconds,
      async (value) => {
        this.plugin.settings.enforceBurstSeconds = Math.max(1, Math.round(value));
        await this.plugin.saveSettings();
        this.refreshSection("enforce");
      },
    );

    new Setting(containerEl)
      .setName("响一声")
      .setDesc("每一档顺带蜂鸣。人背对着屏幕的时候，只有声音还够得着。")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.enforceBeep);
        toggle.onChange(async (value) => {
          this.plugin.settings.enforceBeep = value;
          await this.plugin.saveSettings();
        });
      });

    // --- 亮度闪烁 ---

    new Setting(containerEl)
      .setName("屏幕亮度缓速闪烁")
      .setDesc(
        "Windows 走 WMI，只管内置显示器；外接屏（DDC/CI）调不动，会退回遮罩 + 任务栏闪烁。" +
          "macOS 那一端还没做——先把一端做稳。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.enforceFlicker);
        toggle.onChange(async (value) => {
          this.plugin.settings.enforceFlicker = value;
          await this.plugin.saveSettings();
          this.refreshSection("enforce");
        });
      });

    if (this.plugin.settings.enforceFlicker) {
      this.numberSetting(
        containerEl,
        "波谷亮度（%）",
        "0 = 暗到底。暗一半会被当成屏保，暗到底才是干扰。",
        this.plugin.settings.enforceFlickerLow,
        async (value) => {
          this.plugin.settings.enforceFlickerLow = Math.min(100, Math.round(value));
          await this.plugin.saveSettings();
        },
      );

      this.numberSetting(
        containerEl,
        "波峰亮度（%）",
        "闪烁跑完会还原到开始前那一档，不是还原到这个数。",
        this.plugin.settings.enforceFlickerHigh,
        async (value) => {
          this.plugin.settings.enforceFlickerHigh = Math.min(100, Math.round(value));
          await this.plugin.saveSettings();
        },
      );

      this.numberSetting(
        containerEl,
        "每档停留（毫秒）",
        "默认 400：一圈 10 档约 4 秒，缓速闪烁而不是频闪。",
        this.plugin.settings.enforceFlickerStepMs,
        async (value) => {
          this.plugin.settings.enforceFlickerStepMs = Math.max(60, Math.round(value));
          await this.plugin.saveSettings();
        },
      );
    }

    // --- 进入休息 ---

    new Setting(containerEl)
      .setName("进入休息先锁屏")
      .setDesc(
        "「先强制进行锁屏，然后给预先设定的正常休息时间」。" +
          "锁不动的机器上会明说锁不动，不假装。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.enforceLockAtBreakStart);
        toggle.onChange(async (value) => {
          this.plugin.settings.enforceLockAtBreakStart = value;
          await this.plugin.saveSettings();
          this.refreshSection("enforce");
        });
      });

    if (this.plugin.settings.enforceLockAtBreakStart) {
      this.numberSetting(
        containerEl,
        "锁之前留几秒",
        "0 = 立刻锁。留几秒是为了「正在开会 / 正在录屏」那几次能按下推迟——" +
          "锁错时机比不锁糟得多。",
        this.plugin.settings.enforceBreakLockSeconds,
        async (value) => {
          this.plugin.settings.enforceBreakLockSeconds = Math.max(0, Math.round(value));
          await this.plugin.saveSettings();
        },
      );
    }

    // --- 休息结束还没复工 ---

    this.numberSetting(
      containerEl,
      "休息结束后宽限（秒）",
      "过了这一段还没点「看完了，开工」，就开始催。",
      this.plugin.settings.enforceAwaitGraceSeconds,
      async (value) => {
        this.plugin.settings.enforceAwaitGraceSeconds = Math.max(0, Math.round(value));
        await this.plugin.saveSettings();
        this.refreshSection("enforce");
      },
    );

    this.numberSetting(
      containerEl,
      "每隔多少秒催一轮",
      "原话是每 1 分钟检查一次。",
      this.plugin.settings.enforceCheckSeconds,
      async (value) => {
        this.plugin.settings.enforceCheckSeconds = Math.max(5, Math.round(value));
        await this.plugin.saveSettings();
        this.refreshSection("enforce");
      },
    );

    this.numberSetting(
      containerEl,
      "每轮干扰持续（秒）",
      "一轮吵这么久然后安静，等下一轮。全程不停地吵只会被整个关掉。",
      this.plugin.settings.enforceAwaitAlarmSeconds,
      async (value) => {
        this.plugin.settings.enforceAwaitAlarmSeconds = Math.max(3, Math.round(value));
        await this.plugin.saveSettings();
      },
    );

    this.numberSetting(
      containerEl,
      "多久没输入算「空闲」（秒）",
      "锁屏只锁空闲的机器。人在别的窗口里干活时锁屏，锁掉的是他正在做的事。",
      this.plugin.settings.enforceIdleSeconds,
      async (value) => {
        this.plugin.settings.enforceIdleSeconds = Math.max(5, Math.round(value));
        await this.plugin.saveSettings();
      },
    );

    new Setting(containerEl)
      .setName("空闲且没复工就锁屏")
      .setDesc("【空闲 + 未恢复工作】那一条。人在电脑前但没复工的话不锁，只把窗口拽到前面。")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.enforceAwaitLock);
        toggle.onChange(async (value) => {
          this.plugin.settings.enforceAwaitLock = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("督促自律网页")
      .setDesc(
        "每一轮催促时用系统默认浏览器打开它。留空就改成把 Obsidian 拽到前台——" +
          "这一格不会是空动作，但地址得你自己填，插件不编造。",
      )
      .addText((text) => {
        text.setPlaceholder("https://…");
        text.setValue(this.plugin.settings.enforceDisciplineUrl);
        text.onChange(async (value) => {
          this.plugin.settings.enforceDisciplineUrl = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("催不到人就收手")
      .setDesc(
        "默认关：该开工而没开工，就一直催下去（AME-239 原话——「则应该 永远是提示」）。" +
          "打开之后，催满下面那个时限就安静下来，番茄仍然停在原地等你。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.enforceGiveUpEnabled);
        toggle.onChange(async (value) => {
          this.plugin.settings.enforceGiveUpEnabled = value;
          await this.plugin.saveSettings();
          this.refreshSection("enforce");
        });
      });

    if (this.plugin.settings.enforceGiveUpEnabled) {
      this.numberSetting(
        containerEl,
        "催满多少分钟收手",
        "催到这个时限还没等到人，就停下来并留一条话。",
        this.plugin.settings.enforceStopAfterMinutes,
        async (value) => {
          this.plugin.settings.enforceStopAfterMinutes = Math.max(0, Math.round(value));
          await this.plugin.saveSettings();
          this.refreshSection("enforce");
        },
      );
    }

    new Setting(containerEl)
      .setName("静音时不响")
      .setDesc(
        "按下静音之后：通知和蜂鸣停，**亮度闪烁和锁屏照旧**——" +
          "静音管的是「别吵」，不是「别管我」。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.enforceRespectMute);
        toggle.onChange(async (value) => {
          this.plugin.settings.enforceRespectMute = value;
          await this.plugin.saveSettings();
        });
      });
  }

  // -------------------------------------------------------------------------
  // 运行时音乐
  // -------------------------------------------------------------------------

  private renderMusicSection(containerEl: HTMLElement): void {
    this.openInBeginner(new Setting(containerEl))
      .setName("启用运行时音乐")
      .setDesc(
        "工作段一首、休息段另一首，跟着番茄自己换。曲子放在 vault 里，插件不内置任何音频。",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.musicEnabled);
        toggle.onChange(async (value) => {
          this.plugin.settings.musicEnabled = value;
          await this.plugin.saveSettings();
          this.refreshSection("music");
        });
      });

    if (!this.plugin.settings.musicEnabled) return;

    new Setting(containerEl)
      .setName("工作段曲目")
      .setDesc("vault 内音频路径，例如 Root/音乐/常成 - 狮子吼六字真言.mp3。留空则工作段不放。")
      .addText((text) => {
        text.inputEl.addClass("life-cockpit-wide-input");
        text.setValue(this.plugin.settings.musicWorkTrack);
        text.onChange(async (value) => {
          this.plugin.settings.musicWorkTrack = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("休息段曲目")
      .setDesc("留空则休息段不放。长休息用的是同一首。")
      .addText((text) => {
        text.inputEl.addClass("life-cockpit-wide-input");
        text.setValue(this.plugin.settings.musicBreakTrack);
        text.onChange(async (value) => {
          this.plugin.settings.musicBreakTrack = value.trim();
          await this.plugin.saveSettings();
        });
      });

    this.numberSetting(
      containerEl,
      "音量（0 到 1）",
      "",
      this.plugin.settings.musicVolume,
      async (value) => {
        this.plugin.settings.musicVolume = Math.min(1, Math.max(0, value));
        await this.plugin.saveSettings();
      },
    );

    new Setting(containerEl)
      .setName("循环")
      .setDesc("一段没走完就把这首从头再放。")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.musicLoop);
        toggle.onChange(async (value) => {
          this.plugin.settings.musicLoop = value;
          await this.plugin.saveSettings();
        });
      });
  }

  // -------------------------------------------------------------------------

  /**
   * 密钥框下面那一行（AME-273 第 2 条）。**它是「填对了没有」唯一能当场看见的反馈**：
   * 密钥框是 password 型的，人自己看不见里面到底是什么，而远端只会回一个 401。
   *
   * 只说形状（是不是 JWT、多少字符、首尾几位），**不回显密钥**——
   * 设置页是会被截图、会被录屏的地方。
   */
  private secretHint(
    containerEl: HTMLElement,
    id: string,
    value: string,
    expectJwt: boolean,
  ): HTMLElement {
    const el = containerEl.createDiv({ cls: "life-cockpit-hint" });
    this.paintSecretHint(el, id, value, expectJwt);
    return el;
  }

  /** 重画那一行。粘完当场变，不等这一节重画——AI 那一节根本不重画。 */
  private paintSecretHint(el: HTMLElement, id: string, value: string, expectJwt: boolean): void {
    const noise = describeSecretNoise(this.secretNoise.get(id) ?? []);
    const shape = secretShape(value, expectJwt);
    el.setText(noise ? `${noise}现在是：${shape}` : `现在是：${shape}`);
  }

  /** 记下这一次粘贴洗掉了什么。洗干净的那一次要把上一次的话擦掉，否则它会一直挂在那儿。 */
  private rememberSecretNoise(id: string, removed: SecretNoise[]): void {
    if (removed.length) this.secretNoise.set(id, removed);
    else this.secretNoise.delete(id);
  }

  private numberSetting(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    value: number,
    onChange: (value: number) => Promise<void>,
  ): void {
    const setting = new Setting(containerEl).setName(name);
    if (desc) setting.setDesc(desc);
    setting.addText((text) => {
      text.inputEl.type = "number";
      text.inputEl.addClass("life-cockpit-number-input");
      text.setValue(String(value));
      text.onChange(async (raw) => {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < 0) return;
        await onChange(parsed);
      });
    });
  }
}
