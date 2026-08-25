// 微信画像页。和数据台同一个 React 项目、同一个数据口，只是另一条路由。
//
// 为什么单独一页而不是塞进 OB 那个原生面板：画像是**读的东西**，
// 一段概括、几个话题、几条依据——那是排版活，React 干得比手搓 DOM 好。
// OB 那个原生面板留着，它擅长的是「人 / 关系」那种密集列表。
//
// 和 App.tsx 同样的三条约束：不许 import "obsidian"、颜色一律走 Obsidian 的
// CSS 变量、字号吃全局倍数。所以这一页原样搬进浏览器也能跑。
//
// **这里永远看不到聊天原文。** Convex 那一层存的就只有派生结果，
// 不是这一页做了脱敏，是它根本拿不到。

import { useEffect, useMemo, useState } from "react";
import type { ConvexBridge } from "./App";

/** 一条画像 + 从人那边并过来的显示名和度数（`wechat:personas` 的返回）。 */
export interface PersonaRow {
  person: string;
  currentName: string | null;
  wxid: string | null;
  replyOut: number;
  replyIn: number;
  replyPartners: number;
  roomCount: number;
  summary: string;
  topics: string[];
  role: string;
  activeRooms: string[];
  evidence: string[];
  generatedAt: string;
  model: string;
}

interface Stats {
  people: number;
  names: number;
  edges: number;
  personas: number;
  updatedAt: string | null;
}

function useSubscription<T>(
  bridge: ConvexBridge,
  fn: string,
  args: Record<string, unknown>,
): T | null {
  const [value, setValue] = useState<T | null>(null);
  const key = JSON.stringify(args);
  useEffect(() => {
    setValue(null);
    return bridge.subscribe<T>(fn, JSON.parse(key), setValue);
  }, [bridge, fn, key]);
  return value;
}

/** 名册里没有的人照实显示 wxid——**不要编一个「未知用户」**。 */
function displayName(row: PersonaRow): string {
  return row.currentName || row.wxid || row.person.replace(/^wechat:/, "");
}

export function WechatPersonas({ bridge }: { bridge: ConvexBridge }) {
  const [keyword, setKeyword] = useState("");
  const [openPerson, setOpenPerson] = useState<string | null>(null);

  const personas = useSubscription<PersonaRow[]>(bridge, "wechat:personas", { limit: 200 });
  const stats = useSubscription<Stats>(bridge, "wechat:stats", {});

  const filtered = useMemo(() => {
    const rows = personas ?? [];
    const wanted = keyword.trim().toLowerCase();
    if (!wanted) return rows;
    // 名字、角色、话题、群名都能搜到。**不搜 summary 和 evidence**：
    // 那两段是长文本，搜它们会让几乎每个关键词都命中全部人，等于没筛。
    return rows.filter((row) =>
      [displayName(row), row.role, ...row.topics, ...row.activeRooms]
        .join(" ")
        .toLowerCase()
        .includes(wanted),
    );
  }, [personas, keyword]);

  if (personas === null) {
    return (
      <div className="lc-dash">
        <p className="lc-dim">正在取画像……</p>
      </div>
    );
  }

  // 「还没有画像」是一种状态，不是错误——把该跑哪条命令写出来等人去补。
  if (personas.length === 0) {
    return (
      <div className="lc-dash lc-dash-empty">
        <h2>微信画像</h2>
        <p>这一层还没有画像。</p>
        <p className="lc-dim">
          在归档服务器上跑一次 <code>wechat-digest persona --out personas.json</code>，
          再 <code>wechat-digest push --personas personas.json</code> 推上来。
        </p>
      </div>
    );
  }

  const open = openPerson ? filtered.find((row) => row.person === openPerson) ?? null : null;

  return (
    <div className="lc-dash">
      <header className="lc-dash-head">
        <h2>微信画像</h2>
        <input
          className="lc-persona-search"
          type="search"
          value={keyword}
          placeholder="搜名字 / 角色 / 话题 / 群"
          onChange={(e) => setKeyword(e.currentTarget.value)}
        />
      </header>

      <p className="lc-dim">
        {stats
          ? `${stats.personas} 份画像 · 共 ${stats.people} 人 · ${stats.edges} 条关系`
          : `${personas.length} 份画像`}
        {keyword.trim() ? ` · 筛出 ${filtered.length} 份` : ""}
      </p>

      {open ? (
        <PersonaDetail row={open} onBack={() => setOpenPerson(null)} />
      ) : (
        <div className="lc-persona-grid">
          {filtered.map((row) => (
            <PersonaCard key={row.person} row={row} onOpen={() => setOpenPerson(row.person)} />
          ))}
          {filtered.length === 0 ? <p className="lc-dim">没有匹配的人。</p> : null}
        </div>
      )}
    </div>
  );
}

/** 导出是为了能被单独渲染验证：整页的数据加载走 hook，effect 在 SSR 里不跑。 */
export function PersonaCard({ row, onOpen }: { row: PersonaRow; onOpen: () => void }) {
  return (
    <section className="lc-panel lc-persona-card" onClick={onOpen}>
      <h3>{displayName(row)}</h3>
      <p className="lc-persona-role">{row.role}</p>
      <p className="lc-persona-summary">{row.summary}</p>
      <Topics topics={row.topics} />
      {/* out / in / 伙伴 三个数分开摆。合成一个「活跃度」就再也看不出
          这个人是参与者还是话题源——那正是画像要解释的东西。 */}
      <p className="lc-dim lc-persona-degree">
        主动回 {row.replyOut} · 被回 {row.replyIn} · 伙伴 {row.replyPartners} · {row.roomCount} 群
      </p>
    </section>
  );
}

export function PersonaDetail({ row, onBack }: { row: PersonaRow; onBack: () => void }) {
  return (
    <section className="lc-panel lc-persona-detail">
      <button className="lc-persona-back" onClick={onBack}>
        ← 回列表
      </button>
      <h3>{displayName(row)}</h3>
      <p className="lc-persona-role">{row.role}</p>
      <p>{row.summary}</p>

      <h4>关心的话题</h4>
      <Topics topics={row.topics} />

      <h4>活跃的群</h4>
      <p className="lc-dim">{row.activeRooms.join("、") || "（无）"}</p>

      <h4>判断依据</h4>
      {row.evidence.length ? (
        <ul className="lc-persona-evidence">
          {row.evidence.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      ) : (
        <p className="lc-dim">（模型没给依据）</p>
      )}

      <p className="lc-dim lc-persona-degree">
        主动回 {row.replyOut} · 被回 {row.replyIn} · 伙伴 {row.replyPartners} · {row.roomCount} 群
      </p>
      {/* 哪个模型、什么时候写的**必须摆出来**：换了模型口径就会变，
          不标就分不清是模型换了还是这个人变了。 */}
      <p className="lc-dim">
        {row.model} · {row.generatedAt.slice(0, 16).replace("T", " ")}
      </p>
    </section>
  );
}

function Topics({ topics }: { topics: string[] }) {
  if (!topics.length) return null;
  return (
    <div className="lc-persona-topics">
      {topics.map((topic) => (
        <span key={topic} className="lc-persona-topic">
          {topic}
        </span>
      ))}
    </div>
  );
}
