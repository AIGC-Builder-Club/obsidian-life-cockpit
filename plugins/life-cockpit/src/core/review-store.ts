// 睡前复盘的读写层。和 PointsStore / GoalStore / CandidateStore 一样：文件访问全部走注入的
// VaultIo，故意不 import "obsidian"，所以「取数 → 落素材包 → 投候选区 → 读裁决」整条链路
// 都能在 node --test 里跑真的。
//
// 三条规矩：
//   1. **回写只走候选区**——复盘自己一个字都不往主干写。写主干是 R4 采纳那一下的事，
//      也就是人按下按钮的那一刻。这一层只把草稿投进去；
//   2. **重跑安全**——同一天重跑覆盖自己上次投的草稿，**已经拍过板的一律跳过**。
//      夜班可以放绿灯，但绿灯不包括抹掉人的决定；
//   3. **不静默丢东西**——采纳过的候选项已经躺在 `_归档/` 里，重跑不会把它复活成一条新待办。

import type { VaultIo } from "./vault-io";
import type { LifeCockpitSettings } from "./settings";
import type { PointsStore } from "./points-store";
import type { GoalStore } from "./goal-store";
import type { CandidateStore } from "./candidate-store";
import { ARCHIVE_FOLDER } from "./candidate-store";
import { CANDIDATE_PENDING, parseCandidate, serializeCandidate } from "./candidates";
import { parseDayLedger } from "./ledger";
import type { DayLedger } from "./ledger";
import {
  collectReview,
  fallbackReviewDraft,
  isReviewCandidate,
  reviewCandidates,
  serializeReviewMaterial,
} from "./review";
import type {
  ReviewCandidateFile,
  ReviewDraft,
  ReviewMaterial,
  ReviewRejection,
  ReviewSlot,
} from "./review";
import type { FeishuReviewSlice } from "./feishu";

export interface ReviewStoreDeps {
  io: VaultIo;
  generator: string;
  /** 取当前设置，不做快照——设置改了下一次读写立刻生效 */
  settings: () => LifeCockpitSettings;
  points: PointsStore;
  goals: GoalStore;
  candidates: CandidateStore;
  /** R1 日档 JSON 的路径 */
  dayLedgerPath: (day: string) => string;
  /**
   * 飞书快照那一栏（AME-258 第 19.1 条）。**注入而不是自己读**：
   * 快照是插件那一侧从 vault 读进来的，这一层只负责把它摆进素材包。
   * 不给、或者给 null，素材包里就没有这一栏。
   */
  feishu?: (day: string) => FeishuReviewSlice | null;
}

export type DeliveryState = "written" | "unchanged" | "skipped";

export interface ReviewDelivered {
  slot: ReviewSlot;
  id: string;
  path: string;
  state: DeliveryState;
  /** 跳过的原因；写进去的那几条是空串 */
  reason: string;
}

export interface ReviewRun {
  day: string;
  material: ReviewMaterial;
  materialPath: string;
  draft: ReviewDraft;
  delivered: ReviewDelivered[];
  /** 给人看的一句话 */
  message: string;
}

export interface ReviewRunOptions {
  at?: Date;
  /** AI 那一侧交回来的草稿；不给就用兜底 */
  draft?: ReviewDraft;
  /**
   * 看着刚落下的素材包现出一份草稿。**返回 null 就是「这次没出来」**，
   * 由这一层退回兜底草稿——调用方负责把「为什么没出来」说给人听。
   * 出草稿要吃素材包，所以它只能在素材包落盘之后才跑得了。
   */
  draftFrom?: (material: ReviewMaterial) => Promise<ReviewDraft | null>;
}

export class ReviewStore {
  private deps: ReviewStoreDeps;

  constructor(deps: ReviewStoreDeps) {
    this.deps = deps;
  }

  // -------------------------------------------------------------------------
  // 路径
  // -------------------------------------------------------------------------

  /** 当日日记。复盘正文的落点，一天一篇。 */
  journalPath(day: string): string {
    const folder = trim(this.settings.reviewJournalFolder);
    return folder ? `${folder}/${day}.md` : `${day}.md`;
  }

  /** 素材包。**AI 那一侧读的就是这个文件**——换模型换渠道不该动主体逻辑。 */
  materialPath(day: string): string {
    const folder = trim(this.settings.reviewMaterialFolder);
    return folder ? `${folder}/${day}.json` : `${day}.json`;
  }

  mistakePath(): string {
    return this.settings.reviewMistakeNote.trim();
  }

  /** 候选项落在候选区的账本日目录下，和夜班产物排在一起。 */
  candidateFolder(day: string): string {
    const root = trim(this.settings.candidatesFolder);
    return root ? `${root}/${day}` : day;
  }

  // -------------------------------------------------------------------------
  // 取数
  // -------------------------------------------------------------------------

  /**
   * 上一轮复盘被打回的理由。**这是「别在同一个地方栽第二次」的落点**：
   * R4 打回时不归档、文件留在原地，所以下一轮扫候选区就能读回来。
   *
   * 只挑复盘自己投出去的那几条——别人的打回理由跟这一轮没关系。
   */
  rejections(limit = 5): ReviewRejection[] {
    const found: ReviewRejection[] = [];
    for (const file of this.deps.candidates.files) {
      if (!isReviewCandidate(file.candidate)) continue;
      for (const decision of file.candidate.decisions) {
        if (decision.action !== "打回") continue;
        found.push({ at: decision.at, reason: decision.reason ?? "", from: file.name });
      }
    }
    return found.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  }

  /** 当日日档。没跑过番茄就是 null——那也是一种复盘结论，不当错误处理。 */
  async readDayLedger(day: string): Promise<DayLedger | null> {
    const text = await this.deps.io.read(this.deps.dayLedgerPath(day));
    return text === null ? null : parseDayLedger(text);
  }

  /** 把 R1 / R2 / R3 三处汇到一处。人不用自己翻，AI 也不用自己拼。 */
  async collect(day: string): Promise<ReviewMaterial> {
    return collectReview({
      day,
      generator: this.deps.generator,
      ledger: await this.readDayLedger(day),
      book: this.deps.points.book,
      roots: this.deps.goals.roots,
      progress: this.deps.goals.progress,
      overall: this.deps.goals.overall,
      targetMinutes: this.settings.dailyFocusTargetMinutes,
      rejections: this.rejections(),
      feishu: this.deps.feishu?.(day) ?? null,
    });
  }

  /**
   * 只取数、只写素材包。**这是夜班唯一需要的那一环**（AME-258 第 19.2 条）——
   * 出草稿是判断、投候选区是交班，这一步一件都不做。
   *
   * 单独一个方法而不是让调用方自己拼「collect + write」：素材包的路径与序列化
   * 只该有一处说了算，两处各写一遍迟早会写出两种字节，然后天天刷空 commit。
   */
  async writeMaterial(
    day: string,
  ): Promise<{ material: ReviewMaterial; path: string; written: boolean }> {
    const material = await this.collect(day);
    const path = this.materialPath(day);
    const written = await this.deps.io.writeIfChanged(path, serializeReviewMaterial(material));
    return { material, path, written };
  }

  // -------------------------------------------------------------------------
  // 发起一轮复盘
  // -------------------------------------------------------------------------

  /**
   * 取数 → 落素材包 → 出草稿 → 投候选区。睡前提醒和手动发起走的是同一条。
   *
   * 不给 `draft` 就用兜底草稿：确定性，不需要模型。**AI 那一侧接在这里**——
   * 读素材包、出一份 ReviewDraft 交回来，别的一个字都不用改。
   */
  async run(day: string, options: ReviewRunOptions = {}): Promise<ReviewRun> {
    const at = options.at ?? new Date();
    const { material, path: materialPath } = await this.writeMaterial(day);

    // 草稿可以由调用方现给，也可以**看着刚落下的素材包现出一份**（AME-258 第 20 条）：
    // 模型要吃的就是这一份，所以顺序是「先落盘、再问模型」，不是反过来。
    const drafted = options.draftFrom ? await options.draftFrom(material) : undefined;
    const draft = options.draft ?? drafted ?? fallbackReviewDraft(material);
    const delivered = await this.deliver(day, draft, at);

    return { day, material, materialPath, draft, delivered, message: describe(delivered) };
  }

  /**
   * 把草稿投进候选区。已经拍过板的那几条**一律不覆盖**，也不复活：
   * 采纳过的原件躺在 `_归档/` 里，重跑不该在原地再刷一条待办出来。
   */
  async deliver(day: string, draft: ReviewDraft, at: Date): Promise<ReviewDelivered[]> {
    const files = reviewCandidates(draft, {
      day,
      at,
      journalNote: this.journalPath(day),
      mistakeNote: this.mistakePath(),
    });

    const results: ReviewDelivered[] = [];
    for (const file of files) {
      results.push(await this.deliverOne(day, file));
    }
    return results;
  }

  private async deliverOne(day: string, file: ReviewCandidateFile): Promise<ReviewDelivered> {
    const path = `${this.candidateFolder(day)}/${file.name}`;
    const base = { slot: file.slot, id: file.candidate.id, path };

    const archived = this.archivePath(day, file.name);
    if ((await this.deps.io.read(archived)) !== null) {
      return { ...base, state: "skipped", reason: `已经采纳过了，原件在 ${archived}` };
    }

    const existing = await this.deps.io.read(path);
    if (existing !== null) {
      const current = parseCandidate(existing);
      if (current.decisions.length || current.status !== CANDIDATE_PENDING) {
        return { ...base, state: "skipped", reason: `人已经拍过板了（${current.status}）` };
      }
    }

    const written = await this.deps.io.writeIfChanged(path, serializeCandidate(file.candidate));
    return { ...base, state: written ? "written" : "unchanged", reason: "" };
  }

  /** 采纳过的原件在 `_归档/<日期>/` 下；同名退位的 `-2`、`-3` 都以第一份存在为前提。 */
  private archivePath(day: string, name: string): string {
    const root = trim(this.settings.candidatesFolder);
    return root ? `${root}/${ARCHIVE_FOLDER}/${day}/${name}` : `${ARCHIVE_FOLDER}/${day}/${name}`;
  }

  private get settings(): LifeCockpitSettings {
    return this.deps.settings();
  }
}

// ---------------------------------------------------------------------------

function describe(delivered: ReviewDelivered[]): string {
  const written = delivered.filter((item) => item.state === "written").length;
  const skipped = delivered.filter((item) => item.state === "skipped").length;
  const unchanged = delivered.filter((item) => item.state === "unchanged").length;

  const parts = [`复盘草稿已投候选区：新写 ${written} 条`];
  if (unchanged) parts.push(`${unchanged} 条没变`);
  if (skipped) parts.push(`${skipped} 条跳过（已拍过板）`);
  return `${parts.join("，")}。去「夜班候选区」拍板。`;
}

function trim(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}
