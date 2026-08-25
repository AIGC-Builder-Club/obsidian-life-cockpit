import { Notice } from "obsidian";
import { NUDGE_LEVEL_LABELS } from "../core/nudge";
import type { ChannelStatus, NudgeMessage, PushChannel, PushResult } from "../core/nudge";

/**
 * 系统通知。**唯一不需要任何凭据的渠道，所以它是第一条打通的。**
 *
 * 走的是系统级通知而不是 Obsidian 内的 Notice：Notice 只在 Obsidian 窗口里弹，
 * 人切到别处就看不见了——而「外界推着你走」要推的恰恰是已经切到别处的那个人。
 * 插件内该弹的 Notice 照旧由各处自己弹，两层不重复。
 *
 * 系统通知被系统关掉的时候退回 Notice：推不出窗口，至少别把消息丢了。
 */
export class SystemChannel implements PushChannel {
  readonly id = "system";
  readonly label = "系统通知";

  private enabled: () => boolean;

  constructor(enabled: () => boolean) {
    this.enabled = enabled;
  }

  /** 权限是 default 时先问一次。问不到就算了，状态里会如实写着。 */
  async requestPermission(): Promise<void> {
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "default") return;
    try {
      await Notification.requestPermission();
    } catch {
      // 问不出来就按当前权限办，不影响其它渠道。
    }
  }

  status(): ChannelStatus {
    const base = { id: this.id, label: this.label };
    if (!this.enabled()) {
      return { ...base, state: "disabled", detail: "已在设置里关掉" };
    }
    if (typeof Notification === "undefined") {
      return { ...base, state: "unavailable", detail: "这个环境没有系统通知接口" };
    }
    if (Notification.permission === "denied") {
      return {
        ...base,
        state: "unavailable",
        detail: "系统把 Obsidian 的通知权限关了，去系统设置里放开",
      };
    }
    return { ...base, state: "ready", detail: "不需要任何凭据" };
  }

  async send(message: NudgeMessage): Promise<PushResult> {
    const title = `【${NUDGE_LEVEL_LABELS[message.level]}】${message.title}`;
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        new Notification(title, { body: message.body });
        return { ok: true, detail: "已弹系统通知" };
      } catch (error) {
        // 弹不出来就往下走 Notice，不把这条消息丢掉。
        new Notice(`${title}\n${message.body}`);
        return {
          ok: true,
          detail: `系统通知失败（${error instanceof Error ? error.message : String(error)}），已退回窗口内提示`,
        };
      }
    }

    new Notice(`${title}\n${message.body}`);
    return { ok: true, detail: "没有系统通知权限，已退回窗口内提示" };
  }
}
