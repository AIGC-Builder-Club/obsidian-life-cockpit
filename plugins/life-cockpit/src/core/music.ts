// 运行时音乐切换。R1 的遗留项，出处是日记模板那一行：
//
//   - [ ] 更改【运行时】音乐，为【常成 - 狮子吼六字真言】。
//
// 「运行时」是关键词：不是放一首歌，是**工作段一种声音、休息段另一种声音**，
// 跟着番茄自己换。所以这一层要回答的只有两个问题——这一段该放什么、要不要换。
//
// **不内置任何音频文件。** 曲目路径指向 vault 内的文件，由仓库主人自己放进去；
// 默认空 = 不放。往插件里塞一首谁的曲子既不合适也没必要。
//
// 「要不要换」单独算，是因为番茄每秒 tick 一次：每次都重设 src 的话，
// 同一首歌会被每秒重头播一遍。判定写成纯函数就能被测到。

import type { SegmentKind } from "./timer";

export interface MusicSettings {
  musicEnabled: boolean;
  /** 工作段曲目（vault 内相对路径）；空 = 工作段不放 */
  musicWorkTrack: string;
  /** 休息段曲目；空 = 休息段不放 */
  musicBreakTrack: string;
  /** 0..1 */
  musicVolume: number;
  /** 一段没放完就循环 */
  musicLoop: boolean;
}

export interface MusicTrack {
  path: string;
  volume: number;
  loop: boolean;
}

/**
 * 这一段该放什么。暂停 / 未开始一律不放——番茄停着还在响，比不放更烦。
 * 长休息按休息处理：两者的区别在时长，不在该听什么。
 */
export function trackForSegment(
  settings: MusicSettings,
  kind: SegmentKind,
  status: "idle" | "running" | "paused",
): MusicTrack | null {
  if (!settings.musicEnabled) return null;
  if (status !== "running") return null;
  const path = (kind === "work" ? settings.musicWorkTrack : settings.musicBreakTrack).trim();
  if (!path) return null;
  return {
    path,
    volume: clamp01(settings.musicVolume),
    loop: settings.musicLoop,
  };
}

export type MusicAction = "none" | "start" | "switch" | "stop";

/**
 * 从正在放的那首到该放的那首，要做什么动作。
 * **同一首继续放**是最常见的情况（每秒 tick 一次都会问一遍），所以它必须返回 `none`。
 */
export function musicAction(current: string | null, next: MusicTrack | null): MusicAction {
  if (!next) return current ? "stop" : "none";
  if (!current) return "start";
  return current === next.path ? "none" : "switch";
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}
