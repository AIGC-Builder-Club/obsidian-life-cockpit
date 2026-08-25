import { ItemView, WorkspaceLeaf } from "obsidian";
import type LifeCockpitPlugin from "../main";

export const VIEW_TYPE_WECHAT = "life-cockpit-wechat";

/**
 * 微信群分析面板：人 / 关系 / 画像。
 *
 * 数据全在 Convex 的 `wechat*` 那几张表里，**这个面板只读**——
 * 写入是服务器上那条归档流水线的事，面板碰不到，也不该碰。
 *
 * 一条边界：**这里永远看不到聊天原文**。Convex 那一层存的就只有派生结果
 * （谁是谁、谁回过谁、模型对一个人的概括），原文留在服务器的 SQLite 里。
 * 所以这个面板不需要任何脱敏逻辑——不是它做得好，是它根本拿不到。
 */

type Tab = "people" | "graph" | "persona";
type EdgeKind = "reply" | "mention" | "copresence";

interface PersonRow {
  person: string;
  wxid: string;
  currentName: string | null;
  roomCount: number;
  replyOut: number;
  replyIn: number;
  replyPartners: number;
  updatedAt: string;
}

interface EdgeRow {
  kind: EdgeKind;
  from: string;
  to: string;
  room: string | null;
  weight: number;
  firstAt: string | null;
  lastAt: string | null;
}

interface NameRow {
  name: string;
  kind: "group_nickname" | "account_name";
  room: string | null;
  firstSeen: string;
  lastSeen: string;
}

interface PersonaRow {
  summary: string;
  topics: string[];
  role: string;
  activeRooms: string[];
  evidence: string[];
  generatedAt: string;
  model: string;
}

interface PersonDetail extends PersonRow {
  names: NameRow[];
  persona: PersonaRow | null;
  edges: { out: EdgeRow[]; in: EdgeRow[] };
}

interface Stats {
  people: number;
  names: number;
  edges: number;
  personas: number;
  updatedAt: string | null;
}

const TAB_LABELS: Record<Tab, string> = {
  people: "人",
  graph: "关系",
  persona: "画像",
};

/**
 * 三种边的可信度差一个量级，所以**选项上就写清楚**，不要让人自己去猜。
 * 一个 500 人群自己就能产生十几万条共现——不写明白，看图的人会把
 * 「恰好在同一个群」读成「这两人很熟」。
 */
const EDGE_LABELS: Record<EdgeKind, string> = {
  reply: "引用回复（确凿）",
  mention: "@ 提及（要反查名字）",
  copresence: "同群共现（只说明有机会说上话）",
};

export class WechatView extends ItemView {
  private plugin: LifeCockpitPlugin;
  private tab: Tab = "people";
  private edgeKind: EdgeKind = "reply";
  private selected: string | null = null;

  private people: PersonRow[] = [];
  private edges: EdgeRow[] = [];
  private stats: Stats | null = null;
  private detail: PersonDetail | null = null;

  private unsubscribes: Array<() => void> = [];
  private edgeUnsubscribe: (() => void) | null = null;
  private detailUnsubscribe: (() => void) | null = null;

  private tabsEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private bodyEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: LifeCockpitPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_WECHAT;
  }

  getDisplayText(): string {
    return "微信群分析";
  }

  getIcon(): string {
    return "users";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("life-cockpit-wechat-view");

    this.tabsEl = root.createDiv({ cls: "life-cockpit-wechat-tabs" });
    this.statusEl = root.createDiv({ cls: "life-cockpit-wechat-status" });
    this.bodyEl = root.createDiv({ cls: "life-cockpit-wechat-body" });

    this.renderTabs();
    this.subscribe();
    this.render();
  }

  async onClose(): Promise<void> {
    this.teardown();
  }

  private teardown(): void {
    for (const unsub of this.unsubscribes) unsub();
    this.unsubscribes = [];
    this.edgeUnsubscribe?.();
    this.edgeUnsubscribe = null;
    this.detailUnsubscribe?.();
    this.detailUnsubscribe = null;
  }

  /**
   * 三条订阅一次性挂上，切 tab 只换渲染不换订阅。
   *
   * 人列表在「关系」tab 里也要用——边上只有 `wechat:<wxid>`，
   * 要靠它翻成人看得懂的名字。所以它不能跟着 tab 走。
   */
  private subscribe(): void {
    this.teardown();
    const bridge = this.plugin.convexReader();

    this.unsubscribes.push(bridge.subscribe<PersonRow[]>("wechat:people", { limit: 300 }, (rows) => {
      this.people = Array.isArray(rows) ? rows : [];
      this.render();
    }));
    this.unsubscribes.push(bridge.subscribe<Stats>("wechat:stats", {}, (value) => {
      this.stats = value ?? null;
      this.render();
    }));
    this.subscribeEdges();
  }

  /** 边这一条单独拿着退订函数：换边类型只该重挂它，不该动人列表和详情。 */
  private subscribeEdges(): void {
    this.edgeUnsubscribe?.();
    this.edgeUnsubscribe = this.plugin.convexReader().subscribe<EdgeRow[]>(
      "wechat:graph",
      { kind: this.edgeKind, limit: 200 },
      (rows) => {
        this.edges = Array.isArray(rows) ? rows : [];
        this.render();
      },
    );
  }

  private select(person: string | null): void {
    this.selected = person;
    this.detail = null;
    this.detailUnsubscribe?.();
    this.detailUnsubscribe = null;

    if (person) {
      this.detailUnsubscribe = this.plugin.convexReader().subscribe<PersonDetail | null>(
        "wechat:person",
        { person, topEdges: 12 },
        (value) => {
          this.detail = value ?? null;
          this.render();
        },
      );
    }
    this.render();
  }

  private renderTabs(): void {
    this.tabsEl.empty();
    for (const tab of ["people", "graph", "persona"] as Tab[]) {
      const button = this.tabsEl.createEl("button", { text: TAB_LABELS[tab] });
      if (tab === this.tab) button.addClass("is-active");
      button.onclick = () => {
        this.tab = tab;
        // 换 tab 时把详情收起来：三个 tab 看的是三件事，
        // 留着上一个 tab 点开的人只会让人以为筛选还生效着。
        this.select(null);
        this.renderTabs();
        this.render();
      };
    }
  }

  private nameOf(person: string): string {
    const row = this.people.find((item) => item.person === person);
    // 名册里没有的人照实显示 wxid——**不要编一个「未知用户」**，
    // 那会把「这个人没同步到」和「这个人叫未知用户」混成一件事。
    return row?.currentName || row?.wxid || person.replace(/^wechat:/, "");
  }

  private render(): void {
    if (!this.bodyEl) return;
    this.renderStatus();
    this.bodyEl.empty();

    if (this.notReady()) return;
    if (this.tab === "people") this.renderPeople();
    else if (this.tab === "graph") this.renderGraph();
    else this.renderPersona();
  }

  private renderStatus(): void {
    this.statusEl.empty();
    const status = this.plugin.convexReader().status();
    const bits: string[] = [`Convex：${status.detail}`];
    if (this.stats) {
      bits.push(
        `${this.stats.people} 人 · ${this.stats.edges} 条边 · ${this.stats.personas} 份画像`,
      );
      if (this.stats.updatedAt) bits.push(`更新于 ${this.stats.updatedAt.slice(0, 16).replace("T", " ")}`);
    }
    this.statusEl.setText(bits.join("　|　"));
  }

  /**
   * 「还没准备好」是一种状态，不是错误——把缺的那一样写出来等人去补，
   * 别画一个空列表让人以为数据是空的。
   */
  private notReady(): boolean {
    const status = this.plugin.convexReader().status();
    if (status.phase === "disabled" || status.phase === "missing-config") {
      this.bodyEl.createDiv({ cls: "life-cockpit-wechat-empty", text: `连不上：${status.detail}` });
      return true;
    }
    if (this.stats && this.stats.people === 0) {
      this.bodyEl.createDiv({
        cls: "life-cockpit-wechat-empty",
        text: "这一层还没有数据。服务器上跑一次 `wechat-digest people` 并把结果推上来之后，这里就有了。",
      });
      return true;
    }
    return false;
  }

  private renderPeople(): void {
    if (this.selected && this.detail) {
      this.renderDetail(this.detail);
      return;
    }

    const hint = this.bodyEl.createDiv({ cls: "life-cockpit-wechat-hint" });
    hint.setText("按对话度数排。out=主动回别人，in=被回，伙伴=聊过的人数——这三个数分开看才看得出角色。");

    const list = this.bodyEl.createDiv({ cls: "life-cockpit-wechat-list" });
    for (const row of this.people) {
      const item = list.createDiv({ cls: "life-cockpit-wechat-row" });
      item.createSpan({ cls: "life-cockpit-wechat-name", text: this.nameOf(row.person) });
      item.createSpan({
        cls: "life-cockpit-wechat-meta",
        text: `out ${row.replyOut} · in ${row.replyIn} · 伙伴 ${row.replyPartners} · ${row.roomCount} 群`,
      });
      item.onclick = () => this.select(row.person);
    }
  }

  private renderGraph(): void {
    const picker = this.bodyEl.createDiv({ cls: "life-cockpit-wechat-hint" });
    const select = picker.createEl("select");
    for (const kind of ["reply", "mention", "copresence"] as EdgeKind[]) {
      const option = select.createEl("option", { text: EDGE_LABELS[kind], value: kind });
      if (kind === this.edgeKind) option.selected = true;
    }
    select.onchange = () => {
      this.edgeKind = select.value as EdgeKind;
      this.edges = [];
      // 只重挂边这一条订阅：人列表和 stats 跟边类型无关，重挂它们
      // 会让整个面板闪一下，而且白花一次往返。
      this.subscribeEdges();
      this.render();
    };

    const list = this.bodyEl.createDiv({ cls: "life-cockpit-wechat-list" });
    for (const edge of this.edges) {
      const item = list.createDiv({ cls: "life-cockpit-wechat-row" });
      item.createSpan({
        cls: "life-cockpit-wechat-name",
        text: `${this.nameOf(edge.from)} → ${this.nameOf(edge.to)}`,
      });
      item.createSpan({ cls: "life-cockpit-wechat-meta", text: `${edge.weight}` });
      item.onclick = () => {
        this.tab = "people";
        this.renderTabs();
        this.select(edge.from);
      };
    }
    if (!this.edges.length) {
      list.createDiv({ cls: "life-cockpit-wechat-empty", text: "这一类边还没有数据。" });
    }
  }

  private renderPersona(): void {
    if (this.selected && this.detail) {
      this.renderDetail(this.detail);
      return;
    }

    // 列的是全部人，不是「有画像的人」——`wechat:people` 不带这个标记，
    // 而为了给列表加个角标去逐人查一次画像，是拿 N 次往返换一个角标。
    // 谁有画像点进去就知道，没有的会写明「还没画像」。
    this.bodyEl.createDiv({
      cls: "life-cockpit-wechat-hint",
      text: this.stats?.personas
        ? `已生成 ${this.stats.personas} 份画像（共 ${this.stats.people} 人）。点一个人看他的那份。`
        : "还没有任何画像。服务器上跑一次 `wechat-digest persona` 并推上来。",
    });

    const list = this.bodyEl.createDiv({ cls: "life-cockpit-wechat-list" });
    for (const row of this.people) {
      const item = list.createDiv({ cls: "life-cockpit-wechat-row" });
      item.createSpan({ cls: "life-cockpit-wechat-name", text: this.nameOf(row.person) });
      item.createSpan({ cls: "life-cockpit-wechat-meta", text: `${row.roomCount} 群` });
      item.onclick = () => this.select(row.person);
    }
  }

  private renderDetail(detail: PersonDetail): void {
    const back = this.bodyEl.createEl("button", { text: "← 回列表" });
    back.onclick = () => this.select(null);

    const head = this.bodyEl.createDiv({ cls: "life-cockpit-wechat-detail-head" });
    head.createEl("h3", { text: this.nameOf(detail.person) });
    head.createDiv({
      cls: "life-cockpit-wechat-meta",
      text: `${detail.wxid} · out ${detail.replyOut} · in ${detail.replyIn} · 伙伴 ${detail.replyPartners} · ${detail.roomCount} 群`,
    });

    // 名字历史。**改过名的两条都在**——「他八月叫什么」和「他现在叫什么」
    // 是两个都要答得上的问题，覆盖掉旧名字，历史消息就再也没法按当时的称呼看了。
    const names = this.bodyEl.createDiv({ cls: "life-cockpit-wechat-section" });
    names.createEl("h4", { text: "叫过的名字" });
    for (const row of detail.names) {
      const scope = row.kind === "account_name" ? "微信昵称" : `群昵称${row.room ? `（${row.room}）` : ""}`;
      names.createDiv({
        cls: "life-cockpit-wechat-row",
        text: `${row.name}　${scope}　${row.firstSeen.slice(0, 10)} → ${row.lastSeen.slice(0, 10)}`,
      });
    }
    if (!detail.names.length) names.createDiv({ cls: "life-cockpit-wechat-empty", text: "还没有名字观测。" });

    const persona = this.bodyEl.createDiv({ cls: "life-cockpit-wechat-section" });
    persona.createEl("h4", { text: "画像" });
    if (detail.persona) {
      persona.createDiv({ text: detail.persona.summary });
      persona.createDiv({ cls: "life-cockpit-wechat-meta", text: `角色：${detail.persona.role}` });
      if (detail.persona.topics.length) {
        persona.createDiv({ cls: "life-cockpit-wechat-meta", text: `关心：${detail.persona.topics.join("、")}` });
      }
      for (const line of detail.persona.evidence) {
        persona.createDiv({ cls: "life-cockpit-wechat-meta", text: `· ${line}` });
      }
      // 画像是模型写的，**把是哪个模型、什么时候写的摆出来**——
      // 换了模型之后口径会变，不标出来就分不清是模型换了还是人变了。
      persona.createDiv({
        cls: "life-cockpit-wechat-meta",
        text: `${detail.persona.model} · ${detail.persona.generatedAt.slice(0, 16).replace("T", " ")}`,
      });
    } else {
      persona.createDiv({ cls: "life-cockpit-wechat-empty", text: "还没画像。" });
    }

    const edges = this.bodyEl.createDiv({ cls: "life-cockpit-wechat-section" });
    edges.createEl("h4", { text: "最强的关系" });
    this.renderEdgeList(edges, "他回别人", detail.edges.out, (edge) => this.nameOf(edge.to));
    this.renderEdgeList(edges, "别人回他", detail.edges.in, (edge) => this.nameOf(edge.from));
  }

  private renderEdgeList(
    parent: HTMLElement,
    title: string,
    rows: EdgeRow[],
    label: (edge: EdgeRow) => string,
  ): void {
    parent.createDiv({ cls: "life-cockpit-wechat-meta", text: title });
    if (!rows.length) {
      parent.createDiv({ cls: "life-cockpit-wechat-empty", text: "（没有）" });
      return;
    }
    for (const edge of rows) {
      parent.createDiv({
        cls: "life-cockpit-wechat-row",
        // 边类型要标出来：reply 和 copresence 摆在一起而不标注，
        // 会让「真的聊过」和「恰好同群」看起来是一回事。
        text: `${label(edge)}　${edge.weight}　${EDGE_LABELS[edge.kind].split("（")[0]}`,
      });
    }
  }
}
