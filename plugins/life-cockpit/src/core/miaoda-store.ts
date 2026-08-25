// 秒哒落盘层。和 PointsStore / GoalStore / CandidateStore 一样：文件访问全走注入的
// VaultIo，故意不 import "obsidian"，所以「拉回来 → 并进当天那一页 → 更新同步索引」
// 整条链路都能在 node --test 里跑真的。
//
// 这一层只做落盘。**发请求那一半在 `src/miaoda-client.ts`**——core 下不发网络请求，
// 和 AI 接口那一层同一个形状（拼装、解析、判断在 core，把请求发出去在外面一层）。

import type { VaultIo } from "./vault-io";
import type { LifeCockpitSettings } from "./settings";
import {
  createMiaodaIndex,
  describeMiaodaReport,
  mergeMiaodaDay,
  parseMiaodaDay,
  parseMiaodaIndex,
  planMiaodaSync,
  removeMiaodaSections,
  serializeMiaodaIndex,
} from "./miaoda";
import type { MiaodaIndex, MiaodaReport, MiaodaSession, MiaodaSyncPlan } from "./miaoda";

/** 同步索引的文件名。下划线开头，和候选区的 `_归档/` 同一个意思：这是工具区。 */
export const MIAODA_INDEX_FILE = "_同步索引.json";

export interface MiaodaStoreDeps {
  io: VaultIo;
  generator: string;
  /** 取当前设置，不做快照——路径改了下一次读写立刻生效 */
  settings: () => LifeCockpitSettings;
}

export interface MiaodaSyncResult {
  report: MiaodaReport;
  /** 真的写进去的那几份（内容没变的不算） */
  wrote: string[];
  /** 给人看的一行 */
  message: string;
}

export class MiaodaStore {
  private deps: MiaodaStoreDeps;
  private index: MiaodaIndex;
  /** 索引读过没有。没读过就贸然增量拉，会把整段历史漏掉 */
  private indexLoaded = false;

  get loaded(): boolean {
    return this.indexLoaded;
  }

  constructor(deps: MiaodaStoreDeps) {
    this.deps = deps;
    this.index = createMiaodaIndex(deps.generator);
  }

  private get settings(): LifeCockpitSettings {
    return this.deps.settings();
  }

  get folder(): string {
    return this.settings.miaodaFolder.replace(/^\/+|\/+$/g, "");
  }

  get indexPath(): string {
    return `${this.folder}/${MIAODA_INDEX_FILE}`;
  }

  dayPath(day: string): string {
    return `${this.folder}/${day}.md`;
  }

  /** 已经写过多少段。设置页和面板上那一行报的就是它 */
  get knownCount(): number {
    return Object.keys(this.index.sessions).length;
  }

  /**
   * 下一次增量从哪儿接着拉。**索引没读进来之前一律返回空串**——
   * 那时候「没有上次」和「还不知道有没有上次」长得一样，而这两种的正确行为相反：
   * 前者该整份拉，后者拉了就会把历史漏掉。
   */
  get since(): string {
    return this.indexLoaded ? this.index.lastUpdatedAt : "";
  }

  async load(): Promise<void> {
    const text = await this.deps.io.read(this.indexPath).catch(() => null);
    this.index = parseMiaodaIndex(text, this.deps.generator);
    this.indexLoaded = true;
  }

  /**
   * 把这一批拉回来的写进 vault。
   *
   * `full` = 整份重拉：把索引里的落点记录当成参考而不是判据，远端有的就往页面上补。
   * 平时不用它——它存在是为了「页面看着不对，重来一次」这种时刻。
   */
  async sync(sessions: MiaodaSession[], options: { full?: boolean } = {}): Promise<MiaodaSyncResult> {
    if (!this.indexLoaded) await this.load();

    const plan = planMiaodaSync(sessions, options.full ? this.freshIndex() : this.index, {
      rolloverHour: this.settings.dayRolloverHour,
      includeEmpty: this.settings.miaodaIncludeEmpty,
    });

    const moved = await this.detachMoved(plan);
    const wrote = moved.wrote;
    const report: MiaodaReport = {
      added: 0,
      updated: 0,
      unchanged: plan.unchanged,
      vanished: 0,
      skippedEmpty: plan.skippedEmpty,
      days: plan.byDay.map((bucket) => bucket.day),
    };

    for (const bucket of plan.byDay) {
      const path = this.dayPath(bucket.day);
      const existing = await this.deps.io.read(path).catch(() => null);
      const merged = mergeMiaodaDay(bucket.day, existing, bucket.items, {
        rolloverHour: this.settings.dayRolloverHour,
      });
      report.added += merged.added;
      report.updated += merged.updated;
      report.vanished += merged.vanished;

      if (await this.deps.io.writeIfChanged(path, merged.text)) wrote.push(path);

      // 记账只记**真的落在页面上的那几段**。搬走了没补写的那种不进索引也不改索引——
      // 它在索引里本来就有一条旧记录，留着正好继续挡住下一次的补写。
      const present = new Set(
        parseMiaodaDay(merged.text).sections.map((section) => section.id).filter(Boolean),
      );
      for (const item of bucket.items) {
        if (!present.has(item.session.id)) continue;
        this.index.sessions[item.session.id] = {
          day: bucket.day,
          updatedAt: item.session.updatedAt,
        };
      }
    }

    if (plan.latestUpdatedAt > this.index.lastUpdatedAt) {
      this.index.lastUpdatedAt = plan.latestUpdatedAt;
    }
    if (await this.deps.io.writeIfChanged(this.indexPath, serializeMiaodaIndex(this.index))) {
      wrote.push(this.indexPath);
    }

    return { report, wrote, message: describeMiaodaReport(report) };
  }

  /**
   * 换天了的那几段：先从旧的那一页拿走。
   *
   * 什么时候会发生：他把「几点算新的一天」从 04:00 改成 00:00（或者反过来）。
   * 不处理的话，深夜写的那几段会在旧页和新页各留一份——而这是一个**静默**的重复，
   * 人多半要过很久才发现。
   */
  private async detachMoved(plan: MiaodaSyncPlan): Promise<{ wrote: string[] }> {
    const wrote: string[] = [];
    const byOldDay = new Map<string, Set<string>>();
    for (const bucket of plan.byDay) {
      for (const item of bucket.items) {
        if (!item.previousDay || item.previousDay === item.day) continue;
        const bag = byOldDay.get(item.previousDay) ?? new Set<string>();
        bag.add(item.session.id);
        byOldDay.set(item.previousDay, bag);
        // 旧的那一份已经不在了，所以到了新的那一页它就是新的一段，该追加而不是「找不着」。
        item.change = "new";
      }
    }

    for (const [day, ids] of byOldDay) {
      const path = this.dayPath(day);
      const existing = await this.deps.io.read(path).catch(() => null);
      if (existing === null) continue;
      const result = removeMiaodaSections(existing, ids);
      if (!result.removed) continue;
      if (result.empty) {
        await this.deps.io.remove(path).catch(() => false);
        wrote.push(path);
        continue;
      }
      if (await this.deps.io.writeIfChanged(path, result.text)) wrote.push(path);
    }
    return { wrote };
  }

  /** 整份重拉用的空索引：落点记录清掉，`lastUpdatedAt` 也清掉（否则增量条件还在）。 */
  private freshIndex(): MiaodaIndex {
    return createMiaodaIndex(this.deps.generator);
  }

  /** 设置页和面板上那一行。 */
  describe(): string {
    if (!this.settings.miaodaEnabled) return "秒哒那一栏已关。";
    if (!this.indexLoaded) return "还没读过同步索引。";
    if (!this.knownCount) return `还没拉过（落点：${this.folder}/）。`;
    const last = this.index.lastUpdatedAt ? `，最新一条更新于 ${this.index.lastUpdatedAt.slice(0, 10)}` : "";
    return `已写下 ${this.knownCount} 段${last}。落点：${this.folder}/`;
  }
}
