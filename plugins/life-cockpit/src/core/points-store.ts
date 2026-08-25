// 账本的读写层。故意不 import "obsidian"：文件访问全部走注入的 VaultIo，
// 所以整条落盘链路（月账写盘幂等、日档镜像、撤销留痕）都能在 node --test 里跑真的。
//
// 内存里始终持有全账。月账文件一个月一份、体量很小，全读进来之后
// 任意区间查询、跨月余额都是纯计算，不用维护任何增量缓存去和源头对账。

import type { DayLedger } from "./ledger";
import { createDayLedger, parseDayLedger, serializeDayLedger } from "./ledger";
import type { LifeCockpitSettings } from "./settings";
import { StaleMissingError } from "./vault-io";
import type { VaultIo } from "./vault-io";
import {
  addEntry,
  createBook,
  createEntry,
  dayPointsMirror,
  defaultTasks,
  entriesForMonth,
  findTask,
  goalRef,
  hasPomodoroEntry,
  monthFileName,
  monthOf,
  monthsIn,
  parseMonth,
  parseTaskTable,
  reverseEntry,
  serializeMonth,
  serializeTaskTable,
  sessionPoints,
} from "./points";
import type {
  EntryDraft,
  PointsBook,
  PointsDirection,
  PointsEntry,
  PointsTask,
  ReverseResult,
} from "./points";

export interface PointsStoreDeps {
  io: VaultIo;
  generator: string;
  /** 取当前设置，不做快照——设置改了下一次读写立刻生效 */
  settings: () => LifeCockpitSettings;
  /** R1 日档 JSON 的路径 */
  dayLedgerPath: (day: string) => string;
}

export interface ManualEntryInput {
  direction: PointsDirection;
  amount: number;
  reason: string;
  taskId?: string | null;
  /** 这一笔在推进哪个目标树节点（R3）；填了就按目标记账 */
  goalId?: string | null;
  at?: Date;
}

export interface PomodoroAward {
  sessionId: string;
  endedAt: Date;
  /** 番茄面板上选中的预设任务；没选就走设置里的默认任务 */
  taskId?: string | null;
  /** 这个番茄挂在哪个目标树节点上（R3） */
  goalId?: string | null;
  fallbackReason: string;
}

const MONTH_FILE = /^\d{4}-\d{2}\.md$/;

export class PointsStore {
  private deps: PointsStoreDeps;
  private currentBook: PointsBook = createBook();
  private currentTasks: PointsTask[] = defaultTasks();
  private taskQuarantine: string[] = [];
  /** 任务表笔记还不存在——面板上要能提示「去建一份」 */
  private taskNoteMissing = true;
  /** 这次载入实际读到过的月账文件。手工把某行挪走之后，空掉的那份也要被重写。 */
  private loadedMonths = new Set<string>();

  constructor(deps: PointsStoreDeps) {
    this.deps = deps;
  }

  get book(): PointsBook {
    return this.currentBook;
  }

  get tasks(): PointsTask[] {
    return this.currentTasks;
  }

  get hasTaskNote(): boolean {
    return !this.taskNoteMissing;
  }

  earnTasks(): PointsTask[] {
    return this.currentTasks.filter((task) => task.active && task.direction === "earn");
  }

  spendTasks(): PointsTask[] {
    return this.currentTasks.filter((task) => task.active && task.direction === "spend");
  }

  // -------------------------------------------------------------------------
  // 载入
  // -------------------------------------------------------------------------

  async load(): Promise<void> {
    await this.loadTasks();
    await this.loadBook();
  }

  async loadTasks(): Promise<void> {
    const path = this.settings.pointsTaskNote.trim();
    const text = path ? await this.deps.io.read(path) : null;
    if (text === null) {
      this.taskNoteMissing = true;
      this.currentTasks = defaultTasks();
      this.taskQuarantine = [];
      return;
    }
    const parsed = parseTaskTable(text);
    this.taskNoteMissing = false;
    // 表在、但一条都读不出来，多半是被改坏了：这时用默认表兜底，
    // 原文照旧留在《待修复》里，不覆盖人写的东西。
    this.currentTasks = parsed.tasks.length ? parsed.tasks : defaultTasks();
    this.taskQuarantine = parsed.quarantine;
  }

  async loadBook(): Promise<void> {
    const folder = this.pointsFolder;
    const files = await this.deps.io.listMarkdown(folder);
    const book = createBook();
    const entries: PointsEntry[] = [];
    const quarantine: Record<string, string[]> = {};

    this.loadedMonths.clear();
    for (const name of files.filter((file) => MONTH_FILE.test(file)).sort()) {
      const text = await this.deps.io.read(folder ? `${folder}/${name}` : name);
      if (text === null) continue;
      const month = name.replace(/\.md$/, "");
      this.loadedMonths.add(month);
      const parsed = parseMonth(text);
      entries.push(...parsed.entries);
      if (parsed.quarantine.length) quarantine[month] = parsed.quarantine;
    }

    this.currentBook = { ...book, quarantine };
    for (const entry of entries) this.currentBook = addEntry(this.currentBook, entry);
  }

  /** 任务表笔记不在就建一份默认的；已经在了就按当前内存里的表重写（修表头用）。 */
  async writeTaskNote(): Promise<boolean> {
    const path = this.settings.pointsTaskNote.trim();
    if (!path) return false;
    // 「以为不在」判断错了就是拿默认表盖掉人改过的分值。冷启动时 vault 索引还没
    // 建好、读回 null，正是这个判断出错的场面（AME-227）。落盘前再问一次盘。
    if (this.taskNoteMissing && (await this.deps.io.read(path)) !== null) {
      throw new StaleMissingError(
        `积分任务表 ${path} 已经在盘上了，但这次载入没读到它。` +
          `先跑一次「重读积分账本」，别拿默认表覆盖它。`,
      );
    }
    const written = await this.deps.io.writeIfChanged(
      path,
      serializeTaskTable(this.currentTasks, this.taskQuarantine),
    );
    this.taskNoteMissing = false;
    return written;
  }

  // -------------------------------------------------------------------------
  // 记账
  // -------------------------------------------------------------------------

  /** 随手记一笔。预设任务与临时任务走同一条路，区别只在 taskId 有没有值。 */
  async record(input: ManualEntryInput): Promise<PointsEntry> {
    const at = input.at ?? new Date();
    const entry = this.append({
      at,
      rolloverHour: this.settings.dayRolloverHour,
      direction: input.direction,
      amount: input.amount,
      reason: input.reason,
      source: "manual",
      taskId: this.attribution(input.goalId, input.taskId ?? null),
      ref: null,
    });
    await this.flush([entry.day]);
    return entry;
  }

  /**
   * 番茄跑完自动入账。同一段重复调用只会入账一次——ref 认的是番茄段 id。
   * 选中的任务如果是享乐项（出账），退回默认任务：番茄不该扣分。
   */
  async awardPomodoro(award: PomodoroAward): Promise<PointsEntry | null> {
    if (!this.settings.pointsEnabled || !this.settings.pomodoroAutoAward) return null;
    if (hasPomodoroEntry(this.currentBook, award.sessionId)) return null;

    const task = this.resolveEarnTask(award.taskId);
    if (!task) return null;

    const entry = this.append({
      at: award.endedAt,
      rolloverHour: this.settings.dayRolloverHour,
      direction: "earn",
      amount: task.points,
      reason: `完成番茄：${task.label}${award.fallbackReason ? ` · ${award.fallbackReason}` : ""}`,
      source: "pomodoro",
      taskId: this.attribution(award.goalId, task.id),
      ref: award.sessionId,
    });
    await this.flush([entry.day]);
    return entry;
  }

  /** 撤销：写一笔反向流水，原笔留在账上。 */
  async reverse(entryId: string, note?: string, at: Date = new Date()): Promise<ReverseResult> {
    const target = this.currentBook.entries.find((entry) => entry.id === entryId);
    const result = reverseEntry(this.currentBook, entryId, {
      at,
      rolloverHour: this.settings.dayRolloverHour,
      note,
    });
    if (!result.ok) return result;

    this.currentBook = result.book;
    const days = new Set<string>([result.entry.day]);
    if (target) days.add(target.day);
    await this.flush([...days]);
    return result;
  }

  /** 全账重写一遍。手工改过账本、或者换了流水目录之后用。 */
  async rewriteAll(): Promise<void> {
    await this.flush(this.currentBook.entries.map((entry) => entry.day));
  }

  // -------------------------------------------------------------------------
  // 落盘
  // -------------------------------------------------------------------------

  /**
   * 写盘。所有月份整份重算重写，改动过的日子刷一遍日档镜像。
   * 两边都走 writeIfChanged，所以「全部重写」实际只会落笔到真的变了的那几份。
   *
   * 为什么不只写改动的那个月：余额是全账累计的，插一笔会改后面所有月份；
   * 而且人手工把某一行挪到别的月账文件里之后，两边都得重排才能自愈。
   */
  private async flush(days: string[]): Promise<void> {
    const touched = new Set(days);
    const months = new Set([...monthsIn(this.currentBook), ...this.loadedMonths]);
    for (const day of touched) months.add(monthOf(day));

    for (const month of [...months].sort()) {
      await this.writeMonth(month);
    }
    if (this.settings.mirrorPointsIntoDayLedger) {
      for (const day of [...touched].sort()) {
        await this.writeDayMirror(day);
      }
    }
  }

  private async writeMonth(month: string): Promise<void> {
    const folder = this.pointsFolder;
    const path = folder ? `${folder}/${monthFileName(month)}` : monthFileName(month);
    const entries = entriesForMonth(this.currentBook, month);
    const quarantine = this.currentBook.quarantine[month] ?? [];
    // 空月份只有在文件已经存在时才写：不给没发生过的月份凭空造账本，
    // 但已经存在、被搬空了的那份要落成空账，否则旧行会留在盘上。
    if (!entries.length && !quarantine.length && !this.loadedMonths.has(month)) return;

    // 月账是整份重算重写的，所以写一个本次载入没读到过的月份之前得先确认盘上真没有。
    // 冷启动时 vault 索引还没建好、列目录列了个空（AME-227），接着记的第一笔
    // 就会把那个月的旧流水整份顶掉——余额还会跟着算错。
    if (!this.loadedMonths.has(month) && (await this.deps.io.read(path)) !== null) {
      throw new StaleMissingError(
        `月账 ${path} 已经在盘上了，但这次载入没读到它。` +
          `先跑一次「重读积分账本」，别拿半本账覆盖它。`,
      );
    }

    this.loadedMonths.add(month);
    const opening = this.openingBalanceOf(month);
    await this.deps.io.writeIfChanged(
      path,
      serializeMonth(month, entries, { opening, generator: this.deps.generator, quarantine }),
    );
  }

  private openingBalanceOf(month: string): number {
    let balance = 0;
    for (const entry of this.currentBook.entries) {
      if (monthOf(entry.day) >= month) continue;
      balance += entry.direction === "earn" ? entry.amount : -entry.amount;
    }
    return Math.round(balance * 100) / 100;
  }

  /**
   * 把当日积分快照写进 R1 的日档 JSON。派生数据，每次整体重算。
   * 日档读不动就跳过——那是 R1 的文件，不替它做决定。
   */
  private async writeDayMirror(day: string): Promise<void> {
    const path = this.deps.dayLedgerPath(day);
    const text = await this.deps.io.read(path);

    let ledger: DayLedger;
    if (text === null) {
      // 那天只花了分、没跑番茄，也要留下一份日档，否则 R5 复盘会看不见这笔。
      ledger = createDayLedger(day, {
        targetMinutes: this.settings.dailyFocusTargetMinutes,
        windowHours: this.settings.dailyWindowHours,
        generator: this.deps.generator,
      });
    } else {
      const parsed = parseDayLedger(text);
      if (!parsed) return;
      ledger = parsed;
    }

    await this.deps.io.writeIfChanged(path, serializeDayLedger(this.applyMirror(ledger)));
  }

  /**
   * 日档里的积分位：当日汇总 + 当日流水 + 每个番茄段实际到手的分。
   *
   * 日档 JSON 的每一次写入都要过这里（插件侧的 persist 和这里的 writeDayMirror
   * 都走同一条），否则两边会互相把对方写的内容盖掉。
   */
  applyMirror(day: DayLedger): DayLedger {
    if (!this.settings.mirrorPointsIntoDayLedger) return day;
    const sessions = day.sessions.map((session) => {
      const scored = sessionPoints(this.currentBook, session.id);
      if (scored.points === null) return session;
      return { ...session, points: scored.points, pointsRule: scored.rule };
    });
    return { ...day, sessions, points: dayPointsMirror(this.currentBook, day.date) };
  }

  // -------------------------------------------------------------------------

  private append(draft: EntryDraft): PointsEntry {
    const entry = createEntry(this.currentBook, draft);
    this.currentBook = addEntry(this.currentBook, entry);
    return entry;
  }

  /**
   * 这一笔记在谁头上。挂了目标就指回目标树节点（R3 验收条件 5），没挂还按预设任务记。
   * 计分规则给的是金额，目标给的是去处——一个位只能写一个，复盘更想看去处。
   */
  private attribution(goalId: string | null | undefined, taskId: string | null): string | null {
    if (goalId && this.settings.goalsEnabled && this.settings.attributePointsToGoal) {
      return goalRef(goalId);
    }
    return taskId;
  }

  private resolveEarnTask(taskId: string | null | undefined): PointsTask | null {
    const chosen = findTask(this.currentTasks, taskId ?? null);
    if (chosen && chosen.active && chosen.direction === "earn") return chosen;
    const fallback = findTask(this.currentTasks, this.settings.pomodoroDefaultTaskId);
    if (fallback && fallback.direction === "earn") return fallback;
    return this.earnTasks()[0] ?? null;
  }

  private get settings(): LifeCockpitSettings {
    return this.deps.settings();
  }

  private get pointsFolder(): string {
    return this.settings.pointsFolder.replace(/^\/+|\/+$/g, "");
  }
}
