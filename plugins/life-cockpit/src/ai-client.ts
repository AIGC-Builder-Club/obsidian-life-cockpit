import { requestUrl } from "obsidian";
import { aiStatus, buildChatRequest, parseChatResponse, resolveAiKey } from "./core/ai";
import type { AiMessage, AiReply, AiSettings, AiStatus } from "./core/ai";
import { clipForLog, formatAiMessages } from "./core/ai-log";
import type { AiLogEntry } from "./core/ai-log";

/**
 * AI 接口的执行侧。**只负责把 `core/ai.ts` 拼好的请求发出去**，
 * 拼装、解析、闸门判断一行都不在这里——那些全在 core 里，所以 node --test 跑得到。
 *
 * 走 `requestUrl` 而不是 `fetch`：Obsidian 的渲染进程有同源限制，
 * 官方给的绕过 CORS 的路就是它（和 `channels/webhook-channel.ts` 同一条）。
 *
 * 凭据只从**设置项 → 环境变量**两处取，没有第三处，也没有内置默认值。
 *
 * **每一次调用都留一条痕**（AME-258 第 22.1 条）。留痕在这里而不是在各个调用方：
 * 复盘、连接测试、以后新增的用途都从这一个口子走，写在这里才不会有哪一处漏记。
 * 连「因为缺配置根本没发出去」都记——那正是最需要被看见的一种。
 */
export function aiEnv(): Record<string, string | undefined> {
  try {
    return typeof process !== "undefined" && process.env ? process.env : {};
  } catch {
    return {};
  }
}

const env = aiEnv;

export interface AiChatOptions {
  jsonOnly?: boolean;
  /** 谁要它跑的。写进日志，回看时一眼分得出复盘和连接测试 */
  purpose?: string;
}

export type AiLogSink = (entry: AiLogEntry) => void;

export class AiClient {
  private settings: () => AiSettings;
  private sink: AiLogSink | null;
  /** 同一秒里的第几条。日志 id 靠它去重 */
  private seq = 0;

  constructor(settings: () => AiSettings, sink: AiLogSink | null = null) {
    this.settings = settings;
    this.sink = sink;
  }

  status(): AiStatus {
    return aiStatus(this.settings(), env());
  }

  get ready(): boolean {
    return this.status().state === "ready";
  }

  /**
   * 问一次。**不能用的时候不发请求，直接把「为什么不能用」原样交回去**——
   * 「AI 调用失败」这五个字对人毫无用处，缺密钥和模型名写错要分得开。
   */
  async chat(messages: AiMessage[], options: AiChatOptions = {}): Promise<AiReply> {
    const purpose = options.purpose ?? "调用";
    const startedAt = Date.now();
    const status = this.status();
    if (status.state !== "ready" || !status.profile) {
      const reply: AiReply = { ok: false, content: "", detail: status.detail, model: "", usage: null };
      // 没发出去也要记：「今天复盘为什么没走模型」的答案往往就在这一条里。
      this.record({
        purpose,
        profile: status.profile?.label ?? "（没选中档位）",
        url: "",
        status: null,
        startedAt,
        messages,
        reply,
      });
      return reply;
    }
    const profile = status.profile;
    const request = buildChatRequest(profile, messages, {
      apiKey: resolveAiKey(profile, env()),
      jsonOnly: options.jsonOnly,
    });

    try {
      const response = await requestUrl({
        url: request.url,
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
        // 非 2xx 也要拿到响应体：错误详情就在里面，抛掉了就只剩一个状态码。
        throw: false,
      });
      const reply = parseChatResponse(response.status, response.text ?? "");
      this.record({
        purpose,
        profile: profile.label,
        url: request.url,
        status: response.status,
        startedAt,
        messages,
        reply,
        // 正文为空时（额度吃光那一种）把原始响应留下来，否则日志里也只剩一句「空」。
        rawBody: reply.content ? "" : (response.text ?? ""),
      });
      return reply;
    } catch (error) {
      // 网络层直接炸（DNS、超时、证书）。这一类连状态码都没有，所以单独一句。
      const detail = error instanceof Error ? error.message : String(error);
      const reply: AiReply = {
        ok: false,
        content: "",
        detail: `请求没发出去：${detail}（地址 ${request.url}）`,
        model: "",
        usage: null,
      };
      this.record({
        purpose,
        profile: profile.label,
        url: request.url,
        status: null,
        startedAt,
        messages,
        reply,
      });
      return reply;
    }
  }

  /** 设置页上那颗「测一次」按钮。跑通与否，当场一句话说清楚。 */
  async test(): Promise<string> {
    const status = this.status();
    if (status.state !== "ready") return `连不上：${status.detail}`;
    const reply = await this.chat([{ role: "user", content: "只回复两个字：收到" }], {
      purpose: "测一次连接",
    });
    if (!reply.ok) return `连不上：${reply.detail}`;
    return `通了：${reply.detail}，回了「${reply.content.trim().slice(0, 20)}」`;
  }

  private record(input: {
    purpose: string;
    profile: string;
    url: string;
    status: number | null;
    startedAt: number;
    messages: AiMessage[];
    reply: AiReply;
    rawBody?: string;
  }): void {
    if (!this.sink || !this.settings().aiLogEnabled) return;
    const at = new Date(input.startedAt);
    this.seq += 1;
    const usage = input.reply.usage;
    // 留痕本身绝不能把调用搞挂：日志写不动是小事，复盘跑不完是大事。
    try {
      this.sink({
        id: `${stamp(at)}-${this.seq}`,
        at: at.toISOString(),
        profile: input.profile,
        model: input.reply.model,
        purpose: input.purpose,
        url: input.url,
        ok: input.reply.ok,
        status: input.status,
        durationMs: Date.now() - input.startedAt,
        detail: input.reply.detail,
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        totalTokens: usage?.totalTokens ?? 0,
        request: formatAiMessages(input.messages),
        response: input.reply.content
          ? clipForLog(input.reply.content)
          : input.rawBody
            ? `（正文为空，下面是原始响应）\n${clipForLog(input.rawBody)}`
            : "",
      });
    } catch (error) {
      console.error("人生驾驶舱：AI 调用留痕失败", error);
    }
  }
}

function stamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}
