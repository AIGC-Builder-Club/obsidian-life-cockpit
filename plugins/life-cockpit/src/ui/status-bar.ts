import { formatDuration, SEGMENT_LABELS } from "../core/timer";
import type { TimerState } from "../core/timer";

export interface StatusSnapshot {
  timer: TimerState;
  now: number;
  /** 当日已专注分钟 */
  focusMinutes: number;
  targetMinutes: number;
  modeLabel: string;
  /** 积分余额；账本关掉时为 null */
  balance: number | null;
}

/**
 * 状态栏：剩余时间 + 当前第几个番茄 + 当日 560 分钟进度。
 * 每秒刷新，点一下打开驾驶舱。
 */
export class StatusBarIndicator {
  private el: HTMLElement;
  private getSnapshot: () => StatusSnapshot;

  constructor(parent: HTMLElement, getSnapshot: () => StatusSnapshot, onClick: () => void) {
    this.el = parent;
    this.el.addClass("life-cockpit-status");
    this.getSnapshot = getSnapshot;
    this.el.addEventListener("click", () => onClick());
    this.refresh();
  }

  refresh(): void {
    const { timer, now, focusMinutes, targetMinutes, modeLabel, balance } = this.getSnapshot();
    this.el.removeClass("is-work", "is-break", "is-paused", "is-idle");
    this.el.empty();

    const daily = `今日 ${Math.floor(focusMinutes)}/${targetMinutes} 分钟`;
    const points = balance === null ? "" : ` · ${balance} 分`;

    if (timer.status === "idle") {
      this.el.addClass("is-idle");
      this.el.setText(`🍅 未开始 · ${daily}${points} · ${modeLabel}`);
      this.el.setAttr("aria-label", "人生驾驶舱：点击打开");
      return;
    }

    const remaining = formatDuration(Math.max(0, timer.plannedMs - elapsed(timer, now)));
    const kindLabel = SEGMENT_LABELS[timer.kind];
    const paused = timer.status === "paused" ? "⏸ " : "";

    this.el.addClass(timer.kind === "work" ? "is-work" : "is-break");
    if (timer.status === "paused") this.el.addClass("is-paused");

    this.el.setText(
      `🍅 ${paused}${remaining} · ${kindLabel} · 第 ${timer.pomodoroIndex} 个 · ${daily}${points}`,
    );
    this.el.setAttr("aria-label", `人生驾驶舱 · ${modeLabel}：点击打开`);
  }
}

function elapsed(timer: TimerState, now: number): number {
  const running = timer.status === "running" && timer.legStartedAt !== null;
  return timer.accumulatedMs + (running ? Math.max(0, now - (timer.legStartedAt as number)) : 0);
}
