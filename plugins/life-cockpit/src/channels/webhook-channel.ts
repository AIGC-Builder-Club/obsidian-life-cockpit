import { requestUrl } from "obsidian";
import { buildFeishuRequest, buildWebhookRequest, resolveCredential } from "../core/nudge";
import type { ChannelStatus, NudgeMessage, PushChannel, PushResult } from "../core/nudge";
import { hmacSha256Base64 } from "../desktop";

/**
 * 凭据取值只有两处：**设置项 → 环境变量**。没有第三处，也没有内置默认值。
 * 两处都空 = `missing-config`，面板上把缺的那一项名字写出来，人自己去填。
 *
 * 仓库里不留任何真实地址或密钥，测试里也不留——`test/nudge.test.js` 有一条
 * 专门守着默认值全是空串。
 */
function env(): Record<string, string | undefined> {
  try {
    return typeof process !== "undefined" && process.env ? process.env : {};
  } catch {
    return {};
  }
}

export interface FeishuConfig {
  enabled: boolean;
  webhook: string;
  secret: string;
}

/**
 * 飞书自定义机器人。走 `requestUrl` 而不是 `fetch`：Obsidian 的渲染进程有同源限制，
 * `requestUrl` 是官方给的那条绕过 CORS 的路。
 *
 * 机器人开了签名校验就配密钥，没开就留空——**两种都支持，但都不猜**。
 */
export class FeishuChannel implements PushChannel {
  readonly id = "feishu";
  readonly label = "飞书";

  private config: () => FeishuConfig;

  constructor(config: () => FeishuConfig) {
    this.config = config;
  }

  private webhook(): string {
    return resolveCredential(this.config().webhook, "LIFE_COCKPIT_FEISHU_WEBHOOK", env());
  }

  private secret(): string {
    return resolveCredential(this.config().secret, "LIFE_COCKPIT_FEISHU_SECRET", env());
  }

  status(): ChannelStatus {
    const base = { id: this.id, label: this.label };
    if (!this.config().enabled) {
      return { ...base, state: "disabled", detail: "已在设置里关掉" };
    }
    if (!this.webhook()) {
      return {
        ...base,
        state: "missing-config",
        detail: "缺 webhook 地址：设置里填，或给环境变量 LIFE_COCKPIT_FEISHU_WEBHOOK",
      };
    }
    if (this.secret() && hmacSha256Base64("probe") === null) {
      return {
        ...base,
        state: "unavailable",
        detail: "配了签名密钥，但这个环境里拿不到 crypto，签不出来。去掉密钥或换台机器。",
      };
    }
    return { ...base, state: "ready", detail: this.secret() ? "已配地址与签名密钥" : "已配地址（未开签名）" };
  }

  async send(message: NudgeMessage): Promise<PushResult> {
    const url = this.webhook();
    if (!url) return { ok: false, detail: "没有 webhook 地址" };

    const at = new Date();
    const request = buildFeishuRequest(message, { secret: this.secret(), at });
    const body: Record<string, unknown> = { ...request.body };
    if (request.signBase) {
      const sign = hmacSha256Base64(request.signBase);
      // 签不出来就别发：飞书会拒掉，只留下一条看不懂的错误码。
      if (sign === null) return { ok: false, detail: "签名算不出来（拿不到 crypto）" };
      body.sign = sign;
    }

    const response = await requestUrl({
      url,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify(body),
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, detail: `HTTP ${response.status}` };
    }
    // 飞书 HTTP 200 里也会带业务错误码，别把它当成功。
    const payload = safeJson(response.text);
    const code = typeof payload?.code === "number" ? payload.code : 0;
    if (code !== 0) {
      return { ok: false, detail: `飞书返回 code=${code} ${String(payload?.msg ?? "")}`.trim() };
    }
    return { ok: true, detail: "已送达飞书" };
  }
}

export interface WebhookConfig {
  enabled: boolean;
  url: string;
}

/**
 * 通用 webhook：POST 一份朴素 JSON 过去，**邮件网关、工单系统都从这里接**。
 *
 * 为什么邮件不做成直连 SMTP：Obsidian 插件里没有 SMTP 客户端，硬做要么引第三方依赖、
 * 要么自己写协议，还要把邮箱密码存进 vault 里的 data.json——收益和风险完全不成比例。
 * 指向一个自己的中转（哪怕是一条 n8n / 飞书机器人 / 云函数）是更短也更安全的路。
 * **这一条是明说的取舍，不是没做完。**
 */
export class WebhookChannel implements PushChannel {
  readonly id = "webhook";
  readonly label = "通用 webhook";

  private config: () => WebhookConfig;
  private source: string;

  constructor(config: () => WebhookConfig, source: string) {
    this.config = config;
    this.source = source;
  }

  private url(): string {
    return resolveCredential(this.config().url, "LIFE_COCKPIT_WEBHOOK_URL", env());
  }

  status(): ChannelStatus {
    const base = { id: this.id, label: this.label };
    if (!this.config().enabled) {
      return { ...base, state: "disabled", detail: "已在设置里关掉" };
    }
    if (!this.url()) {
      return {
        ...base,
        state: "missing-config",
        detail: "缺地址：设置里填，或给环境变量 LIFE_COCKPIT_WEBHOOK_URL",
      };
    }
    return { ...base, state: "ready", detail: "已配地址" };
  }

  async send(message: NudgeMessage): Promise<PushResult> {
    const url = this.url();
    if (!url) return { ok: false, detail: "没有 webhook 地址" };

    const response = await requestUrl({
      url,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify(buildWebhookRequest(message, { at: new Date(), source: this.source })),
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, detail: `HTTP ${response.status}` };
    }
    return { ok: true, detail: `HTTP ${response.status}` };
  }
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
