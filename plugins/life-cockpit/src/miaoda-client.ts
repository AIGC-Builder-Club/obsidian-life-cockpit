import { requestUrl } from "obsidian";
import { miaodaPullUrl, parseMiaodaRows } from "./core/miaoda";
import { cleanSecretValue, looksLikeJwt } from "./core/secret";
import type { MiaodaSession } from "./core/miaoda";
import type { LifeCockpitSettings } from "./core/settings";

/**
 * 秒哒的执行侧。**只负责把 `core/miaoda.ts` 拼好的地址请求出去**，
 * 落盘、合并、判重一行都不在这里——那些全在 core 里，所以 node --test 跑得到。
 * 形状照 `ai-client.ts`：拼装与解析在 core，发请求在外面这一层。
 *
 * 走 `requestUrl` 而不是 `fetch`：Obsidian 的渲染进程有同源限制，
 * 官方给的绕过 CORS 的路就是它（和 AI 接口、webhook 渠道同一条）。
 *
 * 凭据只从**设置项 → 环境变量**两处取，没有第三处，也没有内置默认值——
 * 这个仓库是公开的，issue 里贴过的那把 key 一个字符都不进代码。
 */

/** 一次翻页最多翻多少轮。防的是远端把 limit 当摆设时的死循环，不是数据量。 */
const MAX_PAGES = 50;

export interface MiaodaPullResult {
  ok: boolean;
  sessions: MiaodaSession[];
  /** 给人看的一句话，成功失败都有 */
  detail: string;
  /** 翻了几页。看不懂为什么慢的时候，这一个数字最有用 */
  pages: number;
}

export function miaodaEnv(): Record<string, string | undefined> {
  try {
    return typeof process !== "undefined" && process.env ? process.env : {};
  } catch {
    return {};
  }
}

export function resolveMiaodaKey(
  settings: LifeCockpitSettings,
  env: Record<string, string | undefined>,
): string {
  // 洗而不只是 trim。**这一步是必须的，不是保险**：手抄进来的那把 key 常带一个换行，
  // 而带换行的 key 换来的是一个 401——401 长得和「key 填错了」一模一样（AME-273 第 2 条）。
  // 环境变量那一路更是常态：`export LIFE_COCKPIT_MIAODA_KEY=$(cat key.txt)` 就带着换行。
  return cleanSecretValue(settings.miaodaApiKey) || cleanSecretValue(env.LIFE_COCKPIT_MIAODA_KEY ?? "");
}

export type MiaodaConfigState = "disabled" | "missing-endpoint" | "missing-key" | "ready";

export interface MiaodaStatus {
  state: MiaodaConfigState;
  detail: string;
  /**
   * 能拉，但有句话得先说（现在只有一种：key 的形状不像 JWT）。没话说就是空串。
   * **和 `detail` 分开**：`detail` 只在拉不动时才会被显示出来，而这句话恰恰是
   * 「看着能拉、其实多半会 401」的那一种，必须挂在面板上（AME-273 第 2 条）。
   */
  warning: string;
}

/** 能不能拉。**不能拉的时候要说清楚缺什么**，「拉取失败」四个字对人没有用。 */
export function miaodaStatus(
  settings: LifeCockpitSettings,
  env: Record<string, string | undefined> = miaodaEnv(),
): MiaodaStatus {
  if (!settings.miaodaEnabled) {
    return { state: "disabled", detail: "秒哒那一栏已关。", warning: "" };
  }
  // 地址排在 key 前面：没有地址，key 填了也没有去处。
  // 0.19.0 起插件不再预置地址——预置它等于把某个秒哒项目暴露在公开仓库里
  // （AME-315 审查 S2），所以「还没填」是一台新机器的正常起点，不是故障。
  const endpoint = settings.miaodaEndpoint.trim();
  if (!endpoint) {
    return {
      state: "missing-endpoint",
      detail:
        "还没填接口地址。填在 设置 → 秒哒 → 接口地址：你那个秒哒应用的 PostgREST 地址，" +
        "指向写作记录那张表（形如 https://…/rest/v1/<表名>）。地址里带着项目 ID，" +
        "所以得由你自己填，插件不猜。",
      warning: "",
    };
  }
  const key = resolveMiaodaKey(settings, env);
  if (!key) {
    return {
      state: "missing-key",
      detail:
        "还没填 apikey。填在设置里，或者设环境变量 LIFE_COCKPIT_MIAODA_KEY——" +
        "插件不内置任何密钥（这个仓库是公开的）。",
      warning: "",
    };
  }
  // 形状不对**照样让它拉**——判死的是远端，不是这里。但先把话说在前面：
  // 一把缺了半截的 key 换回来的是 401，而 401 不会告诉人他复制少了东西。
  return {
    state: "ready",
    detail: `准备好了：${endpoint}`,
    warning: looksLikeJwt(key)
      ? ""
      : "这把 apikey 不像 JWT（正常是 `eyJ…` 开头、两个点分成三段），多半是复制少了半截。",
  };
}

export class MiaodaClient {
  private settings: () => LifeCockpitSettings;

  constructor(settings: () => LifeCockpitSettings) {
    this.settings = settings;
  }

  status(): MiaodaStatus {
    return miaodaStatus(this.settings(), miaodaEnv());
  }

  get ready(): boolean {
    return this.status().state === "ready";
  }

  /**
   * 拉。`since` 非空就是增量——只要那个时刻之后更新过的那几条。
   *
   * 翻页翻到底：一页拿不满就说明拉完了。这是「把 limit 放大一点、或者删除？」
   * 那个问题的正解——不去赌一个够大的数字，而是问到没有为止。
   */
  async pull(since: string): Promise<MiaodaPullResult> {
    const settings = this.settings();
    const status = this.status();
    if (status.state !== "ready") {
      return { ok: false, sessions: [], detail: status.detail, pages: 0 };
    }

    const key = resolveMiaodaKey(settings, miaodaEnv());
    const pageSize = settings.miaodaPageSize;
    const sessions: MiaodaSession[] = [];
    // 同一条可能在两页里各出现一次（`gte` 的边界、翻页途中远端又改了一条），
    // 所以这里按 id 收口——重复的以后来的那份为准。
    const seen = new Map<string, number>();
    let pages = 0;

    for (let offset = 0; pages < MAX_PAGES; offset += pageSize) {
      const url = miaodaPullUrl(settings.miaodaEndpoint, { since, limit: pageSize, offset });
      let response;
      try {
        response = await requestUrl({
          url,
          method: "GET",
          headers: {
            accept: "application/json",
            "accept-profile": "public",
            apikey: key,
            authorization: `Bearer ${key}`,
          },
          // 非 2xx 也要拿到响应体：PostgREST 的错误详情就在里面。
          throw: false,
        });
      } catch (error) {
        // 网络层直接炸（DNS、超时、证书）。这一类连状态码都没有。
        const detail = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          sessions,
          detail: `请求没发出去：${detail}（地址 ${url}）`,
          pages,
        };
      }
      pages += 1;

      if (response.status < 200 || response.status >= 300) {
        return {
          ok: false,
          sessions,
          detail:
            `远端回了 HTTP ${response.status}：${clip(response.text ?? "")}` +
            keyHint(response.status, key),
          pages,
        };
      }
      const rows = parseMiaodaRows(response.text ?? "");
      if (rows === null) {
        return { ok: false, sessions, detail: `读不动远端的返回：${clip(response.text ?? "")}`, pages };
      }
      for (const row of rows) {
        const at = seen.get(row.id);
        if (at === undefined) {
          seen.set(row.id, sessions.length);
          sessions.push(row);
        } else {
          sessions[at] = row;
        }
      }
      // 没拿满一页 = 拉完了。正好拿满时再问一次，那一次会返回空数组。
      if (rows.length < pageSize) {
        return {
          ok: true,
          sessions,
          detail: `拉到 ${sessions.length} 条${since ? "（增量）" : "（整份）"}。`,
          pages,
        };
      }
    }

    return {
      ok: true,
      sessions,
      detail: `拉到 ${sessions.length} 条，翻满了 ${MAX_PAGES} 页就停了——` +
        "还有更多的话，再拉一次会接着往下走。",
      pages,
    };
  }
}

/**
 * 401 / 403 的时候把话说全（AME-273 第 2 条）。
 *
 * 远端只会回一句「Invalid API key」，而人这边可能有三种错法：复制少了半截、
 * 复制到了别的字段、或者这把 key 本来就过期了。**只有前两种插件看得出来**——
 * 看得出来就要说，说不出来就闭嘴，不要拿一句「请检查密钥」把三种情况糊成一种。
 */
function keyHint(status: number, key: string): string {
  if (status !== 401 && status !== 403) return "";
  if (!looksLikeJwt(key)) {
    return `（这把 key 不像 JWT：${key.length} 字符、${key.split(".").length} 段。` +
      "正常是 `eyJ…` 开头、两个点分成三段——多半是复制少了半截。）";
  }
  return "（形状是对的，所以多半不是复制出的问题：要么这把 key 换过了，要么它没有读这张表的权限。）";
}

function clip(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 200 ? `${one.slice(0, 200)}…` : one;
}
