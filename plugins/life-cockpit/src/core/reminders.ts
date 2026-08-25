// 提醒主题节律：每隔 reminderIntervalMinutes 推一条主题，主题在 themeCycle 里轮换。
// 切模式会同时改间隔和主题表——这就是「模式切换会改提醒主题节律」的落点。

import type { ModeSetting } from "./settings";

export interface ReminderState {
  lastFiredAt: number | null;
  cursor: number;
}

export function createReminderState(): ReminderState {
  return { lastFiredAt: null, cursor: 0 };
}

export interface ReminderTick {
  state: ReminderState;
  theme: string | null;
}

/**
 * 到点就返回一条主题，没到点返回 null。
 * 第一次 tick 只对表，不弹——刚打开 Obsidian 就糊一脸提醒很烦。
 * 睡了几个小时回来也只补一条，不把攒下的全倒出来。
 */
export function tickReminder(
  mode: ModeSetting,
  state: ReminderState,
  now: number,
): ReminderTick {
  const intervalMs = Math.max(1, Math.round(mode.reminderIntervalMinutes * 60_000));

  if (state.lastFiredAt === null) {
    return { state: { ...state, lastFiredAt: now }, theme: null };
  }
  if (now - state.lastFiredAt < intervalMs) {
    return { state, theme: null };
  }

  const themes = mode.themeCycle.length ? mode.themeCycle : ["回到眼前这件事"];
  const theme = themes[state.cursor % themes.length];
  return {
    state: { lastFiredAt: now, cursor: (state.cursor + 1) % themes.length },
    theme,
  };
}

/** 切模式时重新对表：新间隔从此刻起算，主题回到第一条。 */
export function resetReminderState(now: number): ReminderState {
  return { lastFiredAt: now, cursor: 0 };
}

export function nextReminderAt(mode: ModeSetting, state: ReminderState): number | null {
  if (state.lastFiredAt === null) return null;
  return state.lastFiredAt + Math.max(1, Math.round(mode.reminderIntervalMinutes * 60_000));
}
