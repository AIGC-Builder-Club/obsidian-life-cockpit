// AI 接口层。出处（AME-258 第 20 条）：
//
//   「对于【Obsidian 插件】，我希望，能配置 AI 接口（比如——OpenCodeGo 的
//    【DeepSeek v4 0731 Flash 模型】）。（将来，可能会增加新的 AI 模型啥的，
//    我希望都能便于配置）嗯嗯，你需要在本地源码中，有一个专门的模块——
//    并且在 Obsidian 插件中，有相关的配置。」
//
// 所以这一层是**一份可增删的档位表 + 一个统一的请求形状**，不是一处写死的地址。
// 换模型 = 在设置里加一档；换供应商 = 改那一档的 baseUrl。主体逻辑一行都不动。
//
// **它是全局的一层，不属于复盘**（AME-258 第 22.1 条）：
//
//   「现在的【DeepSeek Flash】AI 的 API 接口，仅仅在【复盘】这里放了配置————其实，
//    将来，它会变成一个【全局性】的设置————因为其它地方，可能也大量使用到 Flash AI 接口。」
//
// 0.10.0 时它确实只挂在「交班 · 复盘」那一页下面，因为当时只有复盘一个用处。
// 0.11.0 起设置页给了它**自己的一页**，`AI_CONSUMERS` 列着「谁在用它」——
// 以后加一处用途就是往那张表里加一行，配置本身不动。
//
// 三条规矩，和推动器那一层是同一套（`nudge.ts`），故意不另起：
//   1. **凭据只从「设置项 → 环境变量」两处取**，没有第三处，也没有内置默认值。
//      仓库里不留任何真实密钥——`test/ai.test.js` 有一条专门守着这件事。
//   2. **不能用就是一种状态**（`missing-config`），不是异常。面板上要说得出缺什么。
//   3. **这一层只拼请求、只读响应，不发请求。** 真正的网络调用在 `../ai-client.ts`
//      （走 Obsidian 的 `requestUrl`，渲染进程的 `fetch` 出不去），所以整套
//      拼装与解析都能在 node --test 里跑真的。
//
// 为什么统一按 OpenAI 的 `/chat/completions` 形状来：现在能接的这几家
// （OpenCode Go / DeepSeek 官方 / 各类中转）对外都是这一套，多一层自研抽象
// 只会在换供应商的那天变成两处要改。真遇到不兼容的，那时再加一个 `dialect` 字段。

import { resolveCredential } from "./nudge";
import type { ChannelState } from "./nudge";

/** 一档 AI 配置。加一个模型 = 加一条这个。 */
export interface AiProfile {
  /** 档位 id，设置里靠它选中；改名不影响引用 */
  id: string;
  /** 给人看的名字 */
  label: string;
  /** OpenAI 兼容的 base URL，如 `https://opencode.ai/zen/go/v1` */
  baseUrl: string;
  model: string;
  /** 密钥。留空则读 `apiKeyEnv` 指的环境变量 */
  apiKey: string;
  /** 环境变量名；留空表示这一档只认设置项里的密钥 */
  apiKeyEnv: string;
  /** 0–2，留 null 就不往请求里放这个字段（用服务端默认） */
  temperature: number | null;
  /** 上限；<= 0 表示不限制 */
  maxTokens: number;
  /** 超时秒数 */
  timeoutSeconds: number;
}

export interface AiSettings {
  /** 总开关。关掉之后一条请求都不发 */
  aiEnabled: boolean;
  /** 当前用哪一档；对不上任何一档时按「没配」处理，不偷偷退到第一档 */
  aiActiveProfile: string;
  aiProfiles: AiProfile[];
  /** 睡前复盘的草稿交给模型出。关掉就还是那份确定性兜底草稿 */
  aiReviewDraft: boolean;
  /**
   * 把每次调用的请求与返回记在本地（AME-258 第 22.1 条）。
   * 默认开：**看不见请求和返回的 AI 调用，出了偏差没人会发现。**
   */
  aiLogEnabled: boolean;
  /** 留几天。一天一份文件，过期整份删 */
  aiLogKeepDays: number;
}

/**
 * 预置档位。**只预置地址和模型名，密钥一律空**——
 * 仓库是公开的，写进来的密钥等于当场泄露。
 *
 * 模型名 `deepseek-v4-flash` 是 2026-08-18 直接问
 * `GET https://opencode.ai/zen/go/v1/models` 拿到的**实际 id**。
 * issue 里写的是「DeepSeek v4 0731 Flash」，但那个端点上没有
 * `deepseek-v4-0731-flash` 这个 id，只有 `deepseek-v4-flash` 和 `deepseek-v4-pro`。
 * 照人话去猜 id 会得到一个 404，所以这里以端点自报的为准。
 *
 * **`maxTokens` 给到 32768 是实测出来的，不是拍的。** 这两档都是推理模型：
 * 它会先吐一大段 `reasoning`，而那一段**同样吃 `max_tokens` 的额度**。
 * 2026-08-18 拿真实的复盘 prompt 连跑了几轮：
 *
 *   - 4096 → `finish_reason: length` + **正文完全为空**，一次成功的 HTTP 200，里面什么都没有；
 *   - 16384 → 大多数时候够，但**踩到过一次全额吃光**（同一份 prompt，同一档模型）；
 *   - 实测的 completion tokens 在 1921–7862 之间跳，reasoning 那一段 2.3k–12.3k 字符不等。
 *
 * 所以额度不是按「够用」给的，是按**最差的那一次还留着余量**给的——
 * 这一段长度每次都不一样，卡着均值给等于每隔几天空一次。
 */
export const AI_PRESETS: readonly AiProfile[] = [
  {
    id: "opencode-go-deepseek-v4-flash",
    label: "OpenCode Go · DeepSeek v4 Flash",
    baseUrl: "https://opencode.ai/zen/go/v1",
    model: "deepseek-v4-flash",
    apiKey: "",
    apiKeyEnv: "LIFE_COCKPIT_AI_API_KEY",
    temperature: 0.4,
    maxTokens: 32768,
    timeoutSeconds: 120,
  },
  {
    id: "opencode-go-deepseek-v4-pro",
    label: "OpenCode Go · DeepSeek v4 Pro",
    baseUrl: "https://opencode.ai/zen/go/v1",
    model: "deepseek-v4-pro",
    apiKey: "",
    apiKeyEnv: "LIFE_COCKPIT_AI_API_KEY",
    temperature: 0.4,
    maxTokens: 32768,
    timeoutSeconds: 180,
  },
];

export function createAiProfile(index: number): AiProfile {
  return {
    id: `ai-${index}`,
    label: `AI 档位 ${index}`,
    baseUrl: "",
    model: "",
    apiKey: "",
    apiKeyEnv: "",
    temperature: null,
    maxTokens: 4096,
    timeoutSeconds: 120,
  };
}

/** data.json 里读回来的一档可能缺字段、也可能被人手写坏，这里补齐而不是整份丢弃。 */
export function normalizeAiProfile(raw: unknown, index: number): AiProfile {
  const source = (raw ?? {}) as Partial<AiProfile>;
  const fallback = createAiProfile(index);
  const temperature =
    typeof source.temperature === "number" && Number.isFinite(source.temperature)
      ? Math.min(2, Math.max(0, source.temperature))
      : null;
  return {
    id: text(source.id, fallback.id),
    label: text(source.label, fallback.label),
    baseUrl: text(source.baseUrl, "").trim(),
    model: text(source.model, "").trim(),
    apiKey: text(source.apiKey, ""),
    apiKeyEnv: text(source.apiKeyEnv, "").trim(),
    temperature,
    maxTokens: nonNegativeInt(source.maxTokens, fallback.maxTokens),
    // 0 秒超时 = 请求立刻被判死，那是一颗定时炸弹，所以下限钉在 5 秒。
    timeoutSeconds: Math.max(5, nonNegativeInt(source.timeoutSeconds, fallback.timeoutSeconds)),
  };
}

export function findAiProfile(settings: AiSettings, id?: string): AiProfile | null {
  const wanted = (id ?? settings.aiActiveProfile).trim();
  if (!wanted) return null;
  return settings.aiProfiles.find((profile) => profile.id === wanted) ?? null;
}

/** 这一档的密钥。**设置项 → 环境变量**，两处都空就是空。 */
export function resolveAiKey(profile: AiProfile, env: Record<string, string | undefined>): string {
  if (!profile.apiKeyEnv) return profile.apiKey.trim();
  return resolveCredential(profile.apiKey, profile.apiKeyEnv, env);
}

export interface AiStatus {
  state: ChannelState;
  /** 缺什么、为什么不能用，写给人看 */
  detail: string;
  profile: AiProfile | null;
}

/**
 * 现在能不能发。四种「不能」分开说，因为该动的地方完全不同：
 * 一个是「你关的」，一个是「档位选串了」，一个是「去填密钥」。
 */
export function aiStatus(
  settings: AiSettings,
  env: Record<string, string | undefined>,
): AiStatus {
  if (!settings.aiEnabled) {
    return { state: "disabled", detail: "AI 接口已在设置里关掉", profile: null };
  }
  const profile = findAiProfile(settings);
  if (!profile) {
    return {
      state: "missing-config",
      detail: settings.aiProfiles.length
        ? `选中的档位 ${settings.aiActiveProfile || "（空）"} 不在档位表里，去设置里重新选一档`
        : "一档都没有：设置 → 人生驾驶舱 → AI 接口，先加一档",
      profile: null,
    };
  }
  if (!profile.baseUrl) {
    return { state: "missing-config", detail: `【${profile.label}】缺 base URL`, profile };
  }
  if (!profile.model) {
    return { state: "missing-config", detail: `【${profile.label}】缺模型名`, profile };
  }
  if (!resolveAiKey(profile, env)) {
    const where = profile.apiKeyEnv
      ? `设置里填，或给环境变量 ${profile.apiKeyEnv}`
      : "设置里填";
    return { state: "missing-config", detail: `【${profile.label}】缺密钥：${where}`, profile };
  }
  return { state: "ready", detail: `${profile.label} · ${profile.model}`, profile };
}

/**
 * 「谁在用这一层」。**这张表就是「全局」这两个字的落点**：设置页照它列出用途，
 * 加一处用途 = 往这里加一行，档位表和凭据一个字都不用动。
 */
export interface AiConsumer {
  id: string;
  label: string;
  /** 这一处的开关取哪个字段；null = 没有独立开关，跟总开关走 */
  toggle: keyof AiSettings | null;
  detail: string;
}

export const AI_CONSUMERS: readonly AiConsumer[] = [
  {
    id: "review-draft",
    label: "睡前复盘草稿",
    toggle: "aiReviewDraft",
    detail: "关掉就还是那份确定性兜底草稿（把数字摆齐，不产生洞见）。跑不通会退回兜底并明说。",
  },
];

/** 现在有几处用途真的开着。设置页与面板共用，免得两处口径不一致。 */
export function activeAiConsumers(settings: AiSettings): AiConsumer[] {
  return AI_CONSUMERS.filter(
    (consumer) => consumer.toggle === null || settings[consumer.toggle] === true,
  );
}

/** 设置页与面板共用的一句话，免得两处说法不一致。 */
export function describeAi(settings: AiSettings, env: Record<string, string | undefined>): string {
  const status = aiStatus(settings, env);
  if (status.state === "ready") {
    const profile = status.profile as AiProfile;
    const users = activeAiConsumers(settings);
    return (
      `当前：${profile.label}（${profile.model}）。` +
      (users.length
        ? `在用它的地方：${users.map((consumer) => consumer.label).join("、")}。`
        : "现在一处用途都没开——接口配好了，但没人调它。")
    );
  }
  return status.detail;
}

// ---------------------------------------------------------------------------
// 请求。**只拼，不发。**
// ---------------------------------------------------------------------------

export type AiRole = "system" | "user" | "assistant";

export interface AiMessage {
  role: AiRole;
  content: string;
}

export interface AiRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  timeoutMs: number;
}

/**
 * `<baseUrl>/chat/completions`。三种写法都要认得：
 * 带不带尾斜杠、以及有人直接把整条 `/chat/completions` 填进 base URL——
 * 那是填错了，但拼成 `/chat/completions/chat/completions` 只会得到一个
 * 谁都看不懂的 404，不如当场兜住。
 */
export function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${base}/chat/completions`;
}

export function buildChatRequest(
  profile: AiProfile,
  messages: AiMessage[],
  options: { apiKey: string; jsonOnly?: boolean },
): AiRequest {
  const body: Record<string, unknown> = {
    model: profile.model,
    messages,
    // 渲染进程里没有流式解析的地方，一次拿全更省事，也更好排错。
    stream: false,
  };
  if (profile.temperature !== null) body.temperature = profile.temperature;
  if (profile.maxTokens > 0) body.max_tokens = profile.maxTokens;
  // 认这个字段的服务端会直接给 JSON；不认的会忽略它，所以加着不亏。
  // 真正的兜底是 `extractJsonBlock`——不管它认不认，都能从正文里把 JSON 抠出来。
  if (options.jsonOnly) body.response_format = { type: "json_object" };

  return {
    url: chatCompletionsUrl(profile.baseUrl),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.apiKey}`,
    },
    body,
    timeoutMs: Math.max(5, profile.timeoutSeconds) * 1000,
  };
}

export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AiReply {
  ok: boolean;
  content: string;
  /** 出错时给人看的那句话；成功时是模型名 + 用量 */
  detail: string;
  model: string;
  usage: AiUsage | null;
}

/**
 * 读响应。**失败要说清楚是哪一种失败**：401 和「模型名写错」和「返回了空正文」
 * 对人来说是三件完全不同的事，糊成一句「AI 调用失败」等于什么都没说。
 */
export function parseChatResponse(status: number, rawBody: string): AiReply {
  const empty: AiUsage | null = null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    parsed = null;
  }
  const source = (parsed ?? {}) as Record<string, unknown>;

  if (status < 200 || status >= 300) {
    return {
      ok: false,
      content: "",
      detail: `HTTP ${status}：${errorMessage(source) || clip(rawBody)}`,
      model: "",
      usage: empty,
    };
  }
  const apiError = errorMessage(source);
  if (apiError) {
    return { ok: false, content: "", detail: apiError, model: "", usage: empty };
  }

  const choices = Array.isArray(source.choices) ? source.choices : [];
  const first = (choices[0] ?? {}) as Record<string, unknown>;
  const message = (first.message ?? {}) as Record<string, unknown>;
  const content = typeof message.content === "string" ? message.content : "";
  const model = typeof source.model === "string" ? source.model : "";
  const usage = readUsage(source.usage);

  if (!content.trim()) {
    const reason = text(first.finish_reason, "未知");
    // 空正文最常见的原因就写在这儿，省得人去翻控制台。**`length` 单独说**：
    // 推理模型会先吐一大段 reasoning，那一段同样吃 max_tokens——于是拿到的是
    // 一次「成功」的 HTTP 200，里面什么都没有。这一条真的发生过（AME-258 实测）。
    const hint =
      reason === "length"
        ? "额度用完了，正文一个字都没轮上——推理模型的 reasoning 也吃 max_tokens。把它调大，或者直接重跑一次：那一段的长度每次都不一样"
        : "多半是 max_tokens 太小，或者请求被服务端静默拒了";
    return {
      ok: false,
      content: "",
      detail: `模型返回了空正文（finish_reason: ${reason}）——${hint}`,
      model,
      usage,
    };
  }

  return {
    ok: true,
    content,
    detail: usage
      ? `${model || "模型"} · 用量 ${usage.totalTokens} tokens`
      : model || "已返回",
    model,
    usage,
  };
}

function readUsage(raw: unknown): AiUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const prompt = num(source.prompt_tokens);
  const completion = num(source.completion_tokens);
  const total = num(source.total_tokens);
  if (prompt === 0 && completion === 0 && total === 0) return null;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total || prompt + completion,
  };
}

function errorMessage(source: Record<string, unknown>): string {
  const error = source.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const inner = error as Record<string, unknown>;
    const message = text(inner.message, "");
    const type = text(inner.type, "");
    if (message || type) return [type, message].filter(Boolean).join("：");
  }
  // 有些中转把错误塞在顶层 message 里，且不带 choices。
  if (!Array.isArray(source.choices) && typeof source.message === "string") {
    return source.message;
  }
  return "";
}

/**
 * 从正文里把 JSON 抠出来。模型很爱在 JSON 外面裹一层 ```json 围栏，
 * 或者在前面加一句「好的，这是你要的结果：」——**这不是异常，是常态**，
 * 所以兜在这里，而不是在 prompt 里反复叮嘱它别这么干。
 *
 * 抠不出来返回空串，由调用方决定报错还是退兜底。**不猜、不修补半截 JSON。**
 */
export function extractJsonBlock(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : content).trim();
  if (!body) return "";
  if (body.startsWith("{") && body.endsWith("}")) return body;

  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return "";
  return body.slice(start, end + 1);
}

// ---------------------------------------------------------------------------

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  return Math.round(value);
}

function clip(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed || "（空响应）";
}
