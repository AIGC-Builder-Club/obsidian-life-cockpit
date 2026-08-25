// 禅定遮罩盖不盖这一段。纯判断，抽出来是为了能测——这块屏幕盖错了代价不小。
//
// **禅定是什么**：一段活干完之后的休息、静心、把心态收回来。它是**工作结束之后**
// 那一段，不是「远离电脑」。电脑和 Obsidian 是工作台，是干活的地方，不是要躲开的
// 东西；要躲的是手机那类娱乐工具，而那个恰恰是这块遮罩盖不着的。
//
// 所以默认只盖休息段。工作段要盖，得有明确的意思表示：设置里长开
// （`zenCoverWork`），或者用「开关禅定遮罩」命令临时叫一次（`forced`，换段即失效）。
//
// 顺带记一句这块遮罩的边界：它只盖得住 Obsidian 这一个窗口，挡不住浏览器、
// 挡不住手机。**它是休息页，不是锁屏**——真锁屏是 R6 `lock.ts` 那条系统级的路。

import { isBreak } from "./timer";
import type { SegmentKind, TimerStatus } from "./timer";

export interface ZenScopeInput {
  zenEnabled: boolean;
  /** 工作段也盖。默认 false */
  zenCoverWork: boolean;
  kind: SegmentKind;
  status: TimerStatus;
  /** 这一段被「开关禅定遮罩」命令手动叫出过 */
  forced: boolean;
  /** 这一段被 Esc 退出过，同一段不再弹回来 */
  dismissed: boolean;
}

export type ZenSegmentInput = Pick<ZenScopeInput, "kind" | "zenCoverWork" | "forced">;

/** 这一段该不该盖。休息段一律盖；工作段只在长开或手动叫过时盖。 */
export function zenCoversSegment(input: ZenSegmentInput): boolean {
  if (isBreak(input.kind)) return true;
  if (input.zenCoverWork) return true;
  return input.forced;
}

/** 此时此刻遮罩该不该在屏幕上。idle 时没东西可盖，退出过的那一段不弹回来。 */
export function shouldShowZen(input: ZenScopeInput): boolean {
  if (!input.zenEnabled) return false;
  if (input.status === "idle") return false;
  if (input.dismissed) return false;
  return zenCoversSegment(input);
}
