// 每天推荐读物与学习资料。出处是《知识库》那一行：「每天推荐读物、推荐学习资料」。
//
// **不另造内容源。** 料已经在仓库里了，这一层只负责挑和排：
//   - S1 夜班的 N 次方总结，落在候选区里，`类型: news-digest`——今天的资讯；
//   - R1 休息页里的「精品阅读」那一栏，指向 vault 内某篇笔记——常读的那几篇；
//   - R5 的复盘素材包——昨天的自己写给今天的；
//   - 读物池：设置里一串笔记路径，默认空。**它是可选的第四处**，
//     前三处不填也能推得出来，所以它不是新造的依赖。
//
// 挑选**按天确定性轮换，不随机**。随机推荐这件事在个人系统里是有毒的：
// 今天推没推过、看没看完，第二天全说不清；按天轮换的话，同一天里反复看到同一份，
// 换一天必然换一份——「每天推荐」这四个字才落得下来。

import { candidateTitle } from "./candidates";
import type { Candidate } from "./candidates";
import { dayIndex } from "./gate";
import type { BreakPageSetting } from "./settings";
import type { ReviewMaterial } from "./review";

export type ReadingKind = "资讯" | "精品阅读" | "读物池" | "复盘回看";

/** 轮着来的顺序。资讯最新鲜排头，复盘回看压尾——它是补充，不是主菜。 */
export const READING_KINDS: ReadingKind[] = ["资讯", "精品阅读", "读物池", "复盘回看"];

export interface ReadingPick {
  kind: ReadingKind;
  title: string;
  /** vault 内路径。点得开才叫推荐 */
  path: string;
  /** 为什么今天推这一条。推荐不给理由等于广告 */
  reason: string;
}

export interface ReadingDigest {
  /** 候选区里的日期目录 */
  day: string;
  path: string;
  candidate: Candidate;
}

export interface ReadingSource {
  /** 候选区里 `类型: news-digest` 的那几条 */
  digests: ReadingDigest[];
  /** R1 的休息页。只取填了笔记路径的 */
  breakPages: BreakPageSetting[];
  /** 读物池：设置里维护的一串 vault 笔记路径 */
  pool: string[];
  /** 上一份复盘素材包；没有就是 null */
  material: ReviewMaterial | null;
  materialPath: string;
}

/**
 * 今天推哪几条。四类**轮着取**而不是按类排队：资讯多的时候，
 * 按类排队会把精品阅读和复盘挤得永远轮不上，那这个功能就退化成了资讯推送。
 */
export function buildReadingList(
  day: string,
  source: ReadingSource,
  count: number,
): ReadingPick[] {
  const limit = Math.max(0, Math.round(count));
  if (limit === 0) return [];

  const buckets: ReadingPick[][] = [
    digestPicks(source.digests),
    rotate(breakPagePicks(source.breakPages), day),
    rotate(poolPicks(source.pool), day),
    materialPicks(source.material, source.materialPath),
  ];

  const picked: ReadingPick[] = [];
  const seen = new Set<string>();
  for (let round = 0; picked.length < limit; round += 1) {
    let advanced = false;
    for (const bucket of buckets) {
      const item = bucket[round];
      if (!item) continue;
      advanced = true;
      // 同一篇笔记既在读物池又在休息页：只推一次，按先轮到的那一类算。
      if (seen.has(item.path)) continue;
      seen.add(item.path);
      picked.push(item);
      if (picked.length >= limit) break;
    }
    if (!advanced) break;
  }
  return picked;
}

function digestPicks(digests: ReadingDigest[]): ReadingPick[] {
  // 新的排前面。资讯的价值随时间掉得最快，这一类不做轮换。
  const sorted = [...digests].sort(
    (a, b) => b.day.localeCompare(a.day) || a.path.localeCompare(b.path),
  );
  return sorted.map((item) => ({
    kind: "资讯" as const,
    title: candidateTitle(item.candidate),
    path: item.path,
    reason: coverageReason(item),
  }));
}

function coverageReason(item: ReadingDigest): string {
  const coverage = item.candidate.coverage;
  const covered = coverage && coverage > 0 ? `，覆盖 ${coverage} 条原始条目` : "";
  return `${item.day} 夜班的 N 次方总结${covered}`;
}

function breakPagePicks(pages: BreakPageSetting[]): ReadingPick[] {
  return pages
    .filter((page) => page.notePath.trim() !== "")
    .map((page) => ({
      kind: "精品阅读" as const,
      title: page.label,
      path: page.notePath.trim(),
      reason: "休息页常读的那几篇之一",
    }));
}

/**
 * 读物池里可以直接写**目录**。出处（AME-258 第 19.0 条）：
 *
 *   「我每天读的那些素材啊，就是除开那些资讯之外的。可以从【……/人文社会科学】
 *    这个儒释道这三块去取啊。……我目前还没摸索怎么去配置，然后这块的话你可以
 *    嗯，看，顺便教我一下也行。或者你检查一下现在的是否支持这个方式。」
 *
 * 查过了：**以前不支持**——读物池是一行一个 `.md` 路径，要读一整个目录就得
 * 把里面每一篇都手抄一遍，目录里多一篇笔记就得回来改一次设置。那不是配置，
 * 那是维护。所以这里加一条：**不以 `.md` 结尾的那一行按目录展开**。
 *
 * 展开结果**按路径排序**，不按 vault 给的顺序：轮换是按天取第 N 个
 * （见 `rotate`），顺序不稳定的话「换一天必然换一篇」就不成立了。
 *
 * 目录是空的、或者根本不存在，就展开成零条——**不报错**。读物池整个是可选的，
 * 一条路径填错不该把当天的推荐一起带走。
 */
export function expandReadingPool(entries: string[], notePaths: string[]): string[] {
  const sortedNotes = [...notePaths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    out.push(path);
  };

  for (const raw of entries) {
    const entry = raw.trim().replace(/^\/+/, "");
    if (!entry) continue;
    if (/\.md$/i.test(entry)) {
      push(entry);
      continue;
    }
    const prefix = `${entry.replace(/\/+$/, "")}/`;
    for (const note of sortedNotes) {
      if (note.startsWith(prefix)) push(note);
    }
  }
  return out;
}

function poolPicks(pool: string[]): ReadingPick[] {
  return pool
    .map((path) => path.trim())
    .filter((path) => path !== "")
    .map((path) => ({
      kind: "读物池" as const,
      title: baseName(path),
      path,
      reason: "读物池里轮到的一篇",
    }));
}

/**
 * 昨天的自己写给今天。**只在昨天真的有内容时才推**——
 * 一份空素材包推出来是「今天也读一下昨天的零」，纯噪音。
 */
function materialPicks(material: ReviewMaterial | null, path: string): ReadingPick[] {
  if (!material || !path.trim()) return [];
  const focus = material.focus;
  const touched = material.goals.touched.length;
  if (focus.started === 0 && touched === 0 && material.rejections.length === 0) return [];

  const parts: string[] = [];
  if (focus.started > 0) parts.push(`专注 ${focus.minutes} 分钟`);
  if (touched > 0) parts.push(`动过 ${touched} 支目标`);
  if (material.rejections.length) parts.push(`还有 ${material.rejections.length} 条打回的话`);
  return [
    {
      kind: "复盘回看",
      title: `${material.day} 的复盘素材`,
      path: path.trim(),
      reason: parts.join("、"),
    },
  ];
}

/** 常青的那几类按天转一格，保证换一天必然换一篇。 */
function rotate<T>(items: T[], day: string): T[] {
  if (items.length <= 1) return items;
  const offset = dayIndex(day, items.length);
  return [...items.slice(offset), ...items.slice(0, offset)];
}

function baseName(path: string): string {
  const name = path.split("/").filter(Boolean).at(-1) ?? path;
  return name.replace(/\.md$/i, "");
}

/** 推荐清单 → Markdown。强提醒页上渲染的就是它，推送正文里也用同一份措辞。 */
export function describeReadingList(day: string, picks: ReadingPick[]): string {
  if (!picks.length) {
    return (
      `## ${day} 今日推荐\n\n` +
      "今天没挑出东西可推。候选区里没有夜班总结，休息页和读物池也都还没配——" +
      "去设置 → 人生驾驶舱 → 每日推荐里补一条路径就有了。\n"
    );
  }
  const lines = [`## ${day} 今日推荐`, ""];
  for (const pick of picks) {
    lines.push(`- **${pick.kind}** · [[${wikiTarget(pick.path)}|${pick.title}]]`);
    lines.push(`    - ${pick.reason}`);
  }
  return `${lines.join("\n")}\n`;
}

/** 推送正文。一行一条，渠道那边不认 Markdown，所以这里不带链接语法。 */
export function summarizeReadingList(picks: ReadingPick[]): string {
  if (!picks.length) return "今天没挑出可推的读物。";
  return picks.map((pick) => `${pick.kind}：${pick.title}`).join("\n");
}

/** `[[路径|标题]]` 里的路径部分：Obsidian 的内链不带扩展名。 */
function wikiTarget(path: string): string {
  return path.replace(/\.md$/i, "");
}

// ---------------------------------------------------------------------------
// 到点推一次。一个账本日只推一次，换天自动重置。
// ---------------------------------------------------------------------------

export interface DailySlotState {
  /** 已经推过的那个账本日；null = 这一天还没推过 */
  firedFor: string | null;
}

export function createDailySlotState(): DailySlotState {
  return { firedFor: null };
}

/**
 * 到点了没有。和睡前复盘那条（`tickBedtime`）**故意不共用**：
 * 睡点有「凌晨一点半还没睡的人更需要这条提醒」的补推规则，
 * 早上的推荐读物没有——08:30 的提醒在 00:30 弹出来只会是骚扰。
 */
export function tickDailySlot(
  state: DailySlotState,
  input: { day: string; minute: number; atMinute: number },
): { state: DailySlotState; due: boolean } {
  if (state.firedFor === input.day) return { state, due: false };
  if (input.minute < input.atMinute) return { state, due: false };
  return { state: { firedFor: input.day }, due: true };
}

/** 手动看过一次就别再推了——人已经在看了。 */
export function markDailySlotFired(day: string): DailySlotState {
  return { firedFor: day };
}
