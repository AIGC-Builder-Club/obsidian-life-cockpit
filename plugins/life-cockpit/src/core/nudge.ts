// 推动器的闸门与渠道口。出处是仓库主人自己的话（《笔记思想集》）：
//
//   「老板叫回去开会」的「清醒行动迅速」其实是【外界推着你走】
//
// 前五轮造的是**内部**：时间、状态、结构、交班、收口。全都要人先坐下来看一眼才生效。
// 这一层造的是**外界**——人飘掉的时候，由它推一把。
//
// 但推动器最容易死在两件事上，所以闸门写在推送之前而不是之后：
//   1. **推不动人的推送等于噪音**——推了不看，等于没推；
//   2. **推太多会被整个关掉**——一旦被关，前面五轮攒的东西一起失效。
//
// 于是每一条都要过五道闸：全局静音 → 分级阈值 → 免打扰时段 → 同键冷却 → 每日配额。
// 任何一道拦下来都**明确记下拦它的理由**，不静默丢——「今天怎么没推」得答得出来。
//
// 渠道本身是接口。`PushChannel` 只要求四件事（id、标签、状态、发送），
// 谁实现都行：系统通知不需要凭据，飞书 / 邮件网关 / 工单系统按同一个接口接。
// 凭据缺失不是错误，是一种**状态**（`missing-config`）——面板上要说得出缺什么。

import { parseClock } from "./rhythm";
import { cleanSecretValue } from "./secret";

export type NudgeLevel = "info" | "nudge" | "hard";

export const NUDGE_LEVELS: NudgeLevel[] = ["info", "nudge", "hard"];

export const NUDGE_LEVEL_LABELS: Record<NudgeLevel, string> = {
  info: "提示",
  nudge: "推一把",
  hard: "强制",
};

const LEVEL_RANK: Record<NudgeLevel, number> = { info: 0, nudge: 1, hard: 2 };

export function isNudgeLevel(value: unknown): value is NudgeLevel {
  return typeof value === "string" && NUDGE_LEVELS.includes(value as NudgeLevel);
}

export interface NudgeMessage {
  /** 同一件事复用同一个 key：冷却与去重都按它算 */
  key: string;
  level: NudgeLevel;
  title: string;
  body: string;
}

/** 被拦下来的原因。每一种都要能对人说清楚，所以是枚举不是布尔。 */
export type NudgeSuppression =
  | "disabled"
  | "muted"
  | "below-threshold"
  | "quiet-hours"
  | "cooldown"
  | "daily-cap"
  | "no-channel";

export const SUPPRESSION_LABELS: Record<NudgeSuppression, string> = {
  disabled: "推动器已关",
  muted: "已静音",
  "below-threshold": "低于当前分级阈值",
  "quiet-hours": "免打扰时段",
  cooldown: "同一件事还在冷却里",
  "daily-cap": "今天的推送配额用完了",
  "no-channel": "没有一条可用渠道",
};

/** 推送闸门要读的设置。整份 LifeCockpitSettings 不进这一层，测试里好造。 */
export interface NudgeSettings {
  nudgeEnabled: boolean;
  /** 一键静音：人明确要求安静，那就一条都不推，`hard` 也不例外 */
  nudgeMuted: boolean;
  /** 低于这一级的一律不推 */
  nudgeMinLevel: NudgeLevel;
  /** 免打扰时段 "HH:MM"，from === to 视为不设 */
  nudgeQuietFrom: string;
  nudgeQuietTo: string;
  /** 免打扰时段里 `hard` 是否照推。锁屏 / 强制休息属于 hard。 */
  nudgeQuietBypassHard: boolean;
  /** 同一个 key 多久之内不重复推；0 = 不冷却 */
  nudgeCooldownMinutes: number;
  /** 一天最多推几条（`hard` 不计入也不受限）；0 = 不限 */
  nudgeDailyCap: number;
}

export interface NudgeState {
  /** 配额按账本日算，换天清零 */
  day: string;
  /** 今天已经推出去的 info + nudge 条数 */
  count: number;
  /** key → 上一次真的推出去的时刻 */
  lastAt: Record<string, number>;
}

export function createNudgeState(): NudgeState {
  return { day: "", count: 0, lastAt: {} };
}

export interface NudgeContext {
  /** 账本日，配额按它清零 */
  day: string;
  /** 当前分钟数（距零点），免打扰时段按它判 */
  minute: number;
  now: number;
  /** 现在有几条渠道是 ready 的 */
  readyChannels: number;
}

export interface NudgeDecision {
  state: NudgeState;
  deliver: boolean;
  /** 拦下来的理由；推出去了就是 null */
  suppressed: NudgeSuppression | null;
}

/**
 * 五道闸，顺序是有讲究的：**先判「人明确要求的安静」，再判「系统自己攒的限额」**。
 * 反过来的话，静音期间的消息会白白吃掉配额，解除静音后反而推不动。
 *
 * `hard` 只豁免两道：免打扰时段（可配）和每日配额。全局静音和冷却对它一视同仁——
 * 前者是人的明确指令，后者防的是同一件事连着炸十遍，两样都不该被「重要」二字绕过。
 */
export function routeNudge(
  settings: NudgeSettings,
  state: NudgeState,
  message: NudgeMessage,
  context: NudgeContext,
): NudgeDecision {
  // 换天先清账，任何一道闸都不该看着昨天的数字做判断。
  const base: NudgeState =
    state.day === context.day ? state : { day: context.day, count: 0, lastAt: {} };
  const hard = message.level === "hard";
  const stop = (suppressed: NudgeSuppression): NudgeDecision => ({
    state: base,
    deliver: false,
    suppressed,
  });

  if (!settings.nudgeEnabled) return stop("disabled");
  if (settings.nudgeMuted) return stop("muted");
  if (LEVEL_RANK[message.level] < LEVEL_RANK[settings.nudgeMinLevel]) {
    return stop("below-threshold");
  }
  if (inQuietHours(context.minute, settings.nudgeQuietFrom, settings.nudgeQuietTo)) {
    if (!hard || !settings.nudgeQuietBypassHard) return stop("quiet-hours");
  }

  const cooldownMs = Math.max(0, settings.nudgeCooldownMinutes) * 60_000;
  const last = base.lastAt[message.key];
  if (cooldownMs > 0 && last !== undefined && context.now - last < cooldownMs) {
    return stop("cooldown");
  }

  if (!hard && settings.nudgeDailyCap > 0 && base.count >= settings.nudgeDailyCap) {
    return stop("daily-cap");
  }
  if (context.readyChannels <= 0) return stop("no-channel");

  return {
    state: {
      day: context.day,
      // hard 不吃配额：强制那一级本来就该少，靠冷却限它，不靠配额。
      count: hard ? base.count : base.count + 1,
      lastAt: { ...base.lastAt, [message.key]: context.now },
    },
    deliver: true,
    suppressed: null,
  };
}

/**
 * 免打扰时段判定。跨零点（22:00 → 07:00）是常态而不是例外，所以按 rhythm 那边
 * 同一套左闭右开 + 跨零点的规矩来，两处对同一个时刻不会给出两种答案。
 */
export function inQuietHours(minute: number, from: string, to: string): boolean {
  const start = parseClock(from);
  const end = parseClock(to);
  if (start === null || end === null || start === end) return false;
  if (end < start) return minute >= start || minute < end;
  return minute >= start && minute < end;
}

/** 剩几条配额。面板上直接显示这个数——「还能推几条」比「推了几条」有用。 */
export function remainingQuota(settings: NudgeSettings, state: NudgeState, day: string): number {
  if (settings.nudgeDailyCap <= 0) return Number.POSITIVE_INFINITY;
  const used = state.day === day ? state.count : 0;
  return Math.max(0, settings.nudgeDailyCap - used);
}

// ---------------------------------------------------------------------------
// 渠道。接口只有四件事，凭据缺失是状态不是异常。
// ---------------------------------------------------------------------------

/**
 * `ready` 能发；`disabled` 人自己关的；`missing-config` 缺凭据 / 缺地址，**补上就能用**；
 * `unavailable` 这台机器上根本没有（比如非 Electron 环境下的系统通知）。
 *
 * 三种「不能发」分开写，是因为面板上该说的话完全不同：
 * 一个是「你关的」，一个是「去填」，一个是「别等了」。糊成一种，人就不知道该动哪儿。
 */
export type ChannelState = "ready" | "disabled" | "missing-config" | "unavailable";

export const CHANNEL_STATE_LABELS: Record<ChannelState, string> = {
  ready: "可用",
  disabled: "已关",
  "missing-config": "缺配置",
  unavailable: "不可用",
};

export interface ChannelStatus {
  id: string;
  label: string;
  state: ChannelState;
  /** 缺什么、为什么不可用，写给人看 */
  detail: string;
}

export interface PushResult {
  ok: boolean;
  detail: string;
}

export interface PushChannel {
  readonly id: string;
  readonly label: string;
  status(): ChannelStatus;
  send(message: NudgeMessage): Promise<PushResult>;
}

export interface ChannelOutcome {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface PushOutcome {
  delivered: ChannelOutcome[];
  suppressed: NudgeSuppression | null;
  /** 给人看的一句话，推没推出去都有 */
  message: string;
}

export interface PushHubDeps {
  settings: () => NudgeSettings;
  channels: () => PushChannel[];
}

/**
 * 闸门 + 渠道的收口点。插件那一侧只管喊 `push(...)`，
 * 「该不该推、推给谁、推不出去怎么说」全在这里。
 *
 * 渠道由外面注入，所以 node --test 里拿两个假渠道就能把整条链路跑真的——
 * 这也是为什么闸门逻辑一行都不写在 main.ts 里。
 */
export class PushHub {
  private deps: PushHubDeps;
  private state: NudgeState = createNudgeState();
  /** 最近几条的去向，面板上要能回答「刚才那条推出去了没有」 */
  private log: PushLogEntry[] = [];

  constructor(deps: PushHubDeps) {
    this.deps = deps;
  }

  get recent(): PushLogEntry[] {
    return this.log;
  }

  get counters(): NudgeState {
    return this.state;
  }

  statuses(): ChannelStatus[] {
    return this.deps.channels().map((channel) => channel.status());
  }

  readyChannels(): PushChannel[] {
    return this.deps.channels().filter((channel) => channel.status().state === "ready");
  }

  async push(message: NudgeMessage, context: { day: string; at: Date }): Promise<PushOutcome> {
    const settings = this.deps.settings();
    const ready = this.readyChannels();
    const decision = routeNudge(settings, this.state, message, {
      day: context.day,
      minute: context.at.getHours() * 60 + context.at.getMinutes(),
      now: context.at.getTime(),
      readyChannels: ready.length,
    });
    this.state = decision.state;

    if (!decision.deliver) {
      const outcome: PushOutcome = {
        delivered: [],
        suppressed: decision.suppressed,
        message: `没推：${SUPPRESSION_LABELS[decision.suppressed ?? "disabled"]}`,
      };
      this.remember(message, context.at, outcome);
      return outcome;
    }

    const delivered: ChannelOutcome[] = [];
    for (const channel of ready) {
      // 一条渠道炸了不该带走其它渠道：飞书挂了，系统通知照样得弹出来。
      try {
        const result = await channel.send(message);
        delivered.push({ id: channel.id, label: channel.label, ...result });
      } catch (error) {
        delivered.push({
          id: channel.id,
          label: channel.label,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const outcome: PushOutcome = { delivered, suppressed: null, message: describe(delivered) };
    this.remember(message, context.at, outcome);
    return outcome;
  }

  private remember(message: NudgeMessage, at: Date, outcome: PushOutcome): void {
    this.log = [
      { key: message.key, level: message.level, title: message.title, at, outcome },
      ...this.log,
    ].slice(0, 20);
  }
}

export interface PushLogEntry {
  key: string;
  level: NudgeLevel;
  title: string;
  at: Date;
  outcome: PushOutcome;
}

function describe(delivered: ChannelOutcome[]): string {
  const ok = delivered.filter((item) => item.ok);
  const failed = delivered.filter((item) => !item.ok);
  if (!failed.length) return `已推 ${ok.map((item) => item.label).join(" / ")}`;
  if (!ok.length) return `全部失败：${failed.map((item) => `${item.label}（${item.detail}）`).join("；")}`;
  return (
    `已推 ${ok.map((item) => item.label).join(" / ")}；` +
    `失败 ${failed.map((item) => `${item.label}（${item.detail}）`).join("；")}`
  );
}

// ---------------------------------------------------------------------------
// 飞书自定义机器人。**这一层只拼请求，不发请求，也不碰任何真实密钥。**
// 地址和签名密钥一律由设置或环境变量提供，缺了就是 `missing-config`。
// ---------------------------------------------------------------------------

export interface FeishuRequest {
  /** POST 的 JSON 体 */
  body: Record<string, unknown>;
  /** 需要签名时的待签串；不签名就是 null */
  signBase: string | null;
  timestamp: number;
}

/**
 * 飞书自定义机器人的 `interactive` 卡片太重，纯文本 `text` 类型足够——
 * 推动器要的是「一句话把人叫回来」，不是排版。
 *
 * 签名走飞书的规矩：`{timestamp}\n{secret}` 当**密钥**、空串当消息做 HMAC-SHA256。
 * 这里只交出待签串，真正的 HMAC 由桌面端那一侧算（core 不引 node:crypto，
 * 否则浏览器目标的打包会当场断掉）。
 */
export function buildFeishuRequest(
  message: NudgeMessage,
  options: { secret?: string; at: Date },
): FeishuRequest {
  const timestamp = Math.floor(options.at.getTime() / 1000);
  const secret = (options.secret ?? "").trim();
  const body: Record<string, unknown> = {
    msg_type: "text",
    content: { text: `【${NUDGE_LEVEL_LABELS[message.level]}】${message.title}\n${message.body}` },
  };
  if (secret) {
    body.timestamp = String(timestamp);
  }
  return { body, signBase: secret ? `${timestamp}\n${secret}` : null, timestamp };
}

/** 通用 webhook 的载荷。邮件网关 / 工单系统各自的字段名不同，这里给最朴素的一份。 */
export function buildWebhookRequest(
  message: NudgeMessage,
  options: { at: Date; source: string },
): Record<string, unknown> {
  return {
    source: options.source,
    level: message.level,
    levelLabel: NUDGE_LEVEL_LABELS[message.level],
    key: message.key,
    title: message.title,
    body: message.body,
    at: options.at.toISOString(),
  };
}

/**
 * 凭据取值顺序：设置项 → 环境变量。**没有第三处，也没有内置默认值。**
 * 两处都空就是 `missing-config`，由调用方停下来说清楚缺什么——不猜、不写死。
 */
export function resolveCredential(
  fromSettings: string,
  envKey: string,
  env: Record<string, string | undefined>,
): string {
  // 洗而不只是 trim：环境变量从 shell profile / `$(cat key.txt)` 里来时，
  // 末尾那个换行是常态；设置项里则是手抄粘进来的引号和 `Bearer`（AME-273 第 2 条）。
  const configured = cleanSecretValue(fromSettings);
  if (configured) return configured;
  return cleanSecretValue(env[envKey] ?? "");
}
