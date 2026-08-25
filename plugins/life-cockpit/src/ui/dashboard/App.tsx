// 插件里那张 React 页。
//
// 定位很窄，值得先写清楚，免得它长成第二个驾驶舱面板：
//
//   **Obsidian 原生视图管「操作」，这一页管「看」。**
//   开工、结束、拍板这些动作留在原生面板上（它们要和计时器、遮罩、强制干扰联动）；
//   这一页负责汇总、趋势、分布——那些「很硬、不过没那么美观」的东西。
//
// 三条实现上的硬约束：
//
// 1. **该用库就用库，但主题色一律取自 Obsidian 的 CSS 变量。**
//    这一条上一版写反了（写的是「不用任何 UI 组件库」）——仓库主人纠正得对：
//    运行时损耗和体积几乎可以忽略，而手画会把大量精力耗在坐标轴取整、
//    响应式重排、hover 命中区这些**库早就做好、自己写必然更差**的地方。
//    真正不能让步的不是「不用库」，是**颜色和字号必须跟着 Obsidian 主题走**：
//    所有颜色写成 `var(--interactive-accent)` 这类变量，换主题、换深浅色自动跟着变。
//    趋势图用 Recharts（见 `TrendChart.tsx`）；统计块这类纯排版的东西继续用 CSS，
//    那儿引组件库换不来任何东西。
// 2. **它有拆成独立网站的潜力，所以不许 import "obsidian"。** 数据全部由外面
//    注入（`ConvexBridge`），换成浏览器里的 ConvexReactClient 就能独立跑。
// 3. **字号吃全局那个倍数**（`--life-cockpit-scale`），和插件其它界面一致——
//    那台机器的 Obsidian Zoom Level 是 83%。

import { useEffect, useMemo, useState } from "react";
import { TrendChart, TrendPoint } from "./TrendChart";
import { WechatPersonas } from "./WechatPersonas";

// ---------------------------------------------------------------------------
// 数据口。**这一层就是「将来拆成网站」的接缝**：
// 插件里塞的是 ConvexSync，浏览器里塞 ConvexReactClient，这一页一个字都不用改。
// ---------------------------------------------------------------------------

export interface ConvexBridge {
  subscribe<T>(fn: string, args: Record<string, unknown>, cb: (v: T) => void): () => void;
  mutate(fn: string, args: Record<string, unknown>): Promise<unknown>;
  status(): { phase: string; detail: string };
}

export interface DaySnapshot {
  day: string;
  focus: {
    focusMinutes: number;
    targetMinutes: number;
    completedPomodoros: number;
    startedPomodoros: number;
    onGoal: number;
    breakSeconds: number;
    byTask: Array<{ task: string; minutes: number; completed: number }>;
  };
  points: { earned: number; spent: number; net: number; count: number; voided: number };
  goals: Array<{
    goalId: string;
    title: string;
    depth: number;
    mark: string;
    progress: number;
  }>;
  pendingCandidates: Array<{
    candidateId: string;
    type: string;
    source: string;
    summary: string;
  }>;
  feishu: { day: string; generatedAt: string; taskCount: number } | null;
  /** 写回飞书的【总结】页的回执（AME-271 第 28 条）。**是回执不是内容**——内容在飞书上 */
  feishuSummary: {
    day: string;
    writtenAt: string;
    sheetTitle: string;
    url: string;
    total: number;
    done: number;
    pendingTotal: number;
  } | null;
  hasReviewPack: boolean;
  activeJobs: Array<{
    _id: string;
    kind: string;
    day: string | null;
    status: string;
    progress: string;
    attempt: number;
    maxAttempts: number;
    lastError: string | null;
  }>;
}

// TrendPoint 的定义跟着图表走，见 ./TrendChart.tsx
export type { TrendPoint };
// ---------------------------------------------------------------------------

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

/** 最近 N 天的账本日列表，最新的在最后。 */
function recentDays(today: string, n: number): string[] {
  const out: string[] = [];
  const t = Date.parse(`${today}T00:00:00Z`);
  for (let i = n - 1; i >= 0; i--) {
    out.push(new Date(t - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * 这个项目里的路由。**没有 URL 可用**（它挂在 Obsidian 的一个 leaf 里），
 * 所以路由就是一个 state + 一排导航按钮，不引 react-router——
 * 那个库带来的是 URL 同步和嵌套路由，这两样在这儿都用不上。
 *
 * 将来拆成独立网站时，把这个 state 换成 `useSearchParams` 即可，
 * 下面两个页面组件一个字都不用改。
 */
export type Route = "dashboard" | "wechat";

const ROUTE_LABELS: Record<Route, string> = {
  dashboard: "驾驶舱数据台",
  wechat: "微信画像",
};

export function App({
  bridge,
  today,
  route: initialRoute = "dashboard",
}: {
  bridge: ConvexBridge;
  today: string;
  route?: Route;
}) {
  const [route, setRoute] = useState<Route>(initialRoute);
  // 外面（Obsidian 那层）换了路由要跟上：两个 ItemView 共用这一个 App，
  // 打开哪个 view 就该落在哪一页。
  useEffect(() => setRoute(initialRoute), [initialRoute]);

  const status = bridge.status();
  if (status.phase === "disabled" || status.phase === "missing-config") {
    return (
      <div className="lc-dash lc-dash-empty">
        <h2>{ROUTE_LABELS[route]}</h2>
        <p>{status.detail}</p>
        <p className="lc-dim">
          设置 → Convex 同步，填服务地址和设备令牌。填好之后这一页会自己亮起来。
        </p>
      </div>
    );
  }

  return (
    <div className="lc-routes">
      <nav className="lc-route-nav">
        {(["dashboard", "wechat"] as Route[]).map((r) => (
          <button
            key={r}
            className={r === route ? "lc-on" : ""}
            onClick={() => setRoute(r)}
          >
            {ROUTE_LABELS[r]}
          </button>
        ))}
      </nav>
      {route === "dashboard" ? (
        <DashboardPage bridge={bridge} today={today} />
      ) : (
        <WechatPersonas bridge={bridge} />
      )}
    </div>
  );
}

function DashboardPage({ bridge, today }: { bridge: ConvexBridge; today: string }) {
  const [range, setRange] = useState(14);
  const days = useMemo(() => recentDays(today, range), [today, range]);

  const snapshot = useSubscription<DaySnapshot>(bridge, "today:snapshot", {
    day: today,
  });
  const trend = useSubscription<TrendPoint[]>(bridge, "today:trend", { days });

  return (
    <div className="lc-dash">
      <header className="lc-dash-head">
        <h2>驾驶舱数据台 · {today}</h2>
        <div className="lc-dash-range">
          {[7, 14, 30].map((n) => (
            <button
              key={n}
              className={n === range ? "lc-on" : ""}
              onClick={() => setRange(n)}
            >
              {n} 天
            </button>
          ))}
        </div>
      </header>

      {/* 在跑的活。**排在最前面**——「昨晚那一班到底成没成」是打开这一页
          最常见的第一个问题，而它现在终于答得上了。 */}
      <JobStrip jobs={snapshot?.activeJobs ?? []} />

      {snapshot === null ? (
        <p className="lc-dim">正在取数……</p>
      ) : (
        <>
          <StatRow snapshot={snapshot} />
          <div className="lc-grid">
            <Panel title="最近专注趋势">
              <TrendChart points={trend ?? []} />
            </Panel>
            <Panel title="今天的时间去了哪儿">
              <TaskBars tasks={snapshot.focus.byTask} />
            </Panel>
            <Panel title="目标树">
              <GoalTree goals={snapshot.goals} />
            </Panel>
            <Panel title={`等你拍板（${snapshot.pendingCandidates.length}）`}>
              <Candidates items={snapshot.pendingCandidates} />
            </Panel>
            <Panel title="飞书【总结】页">
              <FeishuSummary
                summary={snapshot.feishuSummary}
                activeJobs={snapshot.activeJobs}
                bridge={bridge}
                today={today}
              />
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="lc-panel">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function StatRow({ snapshot }: { snapshot: DaySnapshot }) {
  const f = snapshot.focus;
  const ratio = f.targetMinutes > 0 ? (f.focusMinutes / f.targetMinutes) * 100 : 0;
  const stats = [
    { label: "专注", value: `${Math.round(f.focusMinutes)}`, unit: `/ ${f.targetMinutes} 分钟` },
    { label: "番茄", value: `${f.completedPomodoros}`, unit: `/ ${f.startedPomodoros} 个跑满` },
    { label: "挂到目标", value: `${f.onGoal}`, unit: `/ ${f.startedPomodoros} 个` },
    { label: "积分", value: `${snapshot.points.net >= 0 ? "+" : ""}${snapshot.points.net}`, unit: `今日净额` },
  ];
  return (
    <div className="lc-stats">
      {stats.map((s) => (
        <div className="lc-stat" key={s.label}>
          <div className="lc-stat-label">{s.label}</div>
          <div className="lc-stat-value">{s.value}</div>
          <div className="lc-stat-unit">{s.unit}</div>
        </div>
      ))}
      <div className="lc-stat lc-stat-wide">
        <div className="lc-stat-label">当日进度</div>
        <Meter ratio={ratio} />
        <div className="lc-stat-unit">{ratio.toFixed(1)}%</div>
      </div>
    </div>
  );
}

function Meter({ ratio }: { ratio: number }) {
  const clamped = Math.max(0, Math.min(100, ratio));
  return (
    <div
      className="lc-meter"
      role="meter"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="lc-meter-fill" style={{ width: `${clamped}%` }} />
    </div>
  );
}

function TaskBars({ tasks }: { tasks: DaySnapshot["focus"]["byTask"] }) {
  if (tasks.length === 0) return <p className="lc-dim">今天还没有跑过番茄。</p>;
  const max = Math.max(...tasks.map((t) => t.minutes));
  return (
    <ul className="lc-bars">
      {tasks.slice(0, 8).map((t) => (
        <li key={t.task}>
          <span className="lc-bars-label" title={t.task}>{t.task}</span>
          <span className="lc-bars-track">
            <span className="lc-bars-fill" style={{ width: `${(t.minutes / max) * 100}%` }} />
          </span>
          <span className="lc-bars-value">{Math.round(t.minutes)} 分</span>
        </li>
      ))}
    </ul>
  );
}

function GoalTree({ goals }: { goals: DaySnapshot["goals"] }) {
  if (goals.length === 0) return <p className="lc-dim">目标树是空的。</p>;
  return (
    <ul className="lc-goals">
      {goals.map((g) => (
        <li key={g.goalId} style={{ paddingLeft: `${g.depth * 0.9}em` }}>
          <span className={`lc-mark lc-mark-${g.mark}`} aria-hidden="true" />
          <span className="lc-goal-title" title={g.title}>{g.title}</span>
          <span className="lc-goal-progress">{g.progress.toFixed(0)}%</span>
        </li>
      ))}
    </ul>
  );
}

function Candidates({ items }: { items: DaySnapshot["pendingCandidates"] }) {
  if (items.length === 0) return <p className="lc-dim">没有待拍板的。</p>;
  return (
    <ul className="lc-candidates">
      {items.map((c) => (
        <li key={c.candidateId}>
          <span className="lc-tag">{c.type}</span>
          <span>{c.summary}</span>
          <span className="lc-dim">{c.source}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * 飞书【总结】页的回执（AME-271 第 28 条）。
 *
 * **这一格只回答「那一页新不新、还欠多少」，不把清单在这儿再画一遍。**
 * 那一页的权威源是飞书上那张表，在这里复述一份，两处迟早对不上——
 * 而对不上的两份清单比只有一份坏得多。所以这里给的是一条点过去的路。
 */
function FeishuSummary({
  summary,
  activeJobs,
  bridge,
  today,
}: {
  summary: DaySnapshot["feishuSummary"];
  activeJobs: DaySnapshot["activeJobs"];
  bridge: ConvexBridge;
  today: string;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const active = activeJobs.find((job) => job.kind === "feishu-snapshot" && job.day === today);

  async function refreshSummary(): Promise<void> {
    if (active || submitting) return;
    setSubmitting(true);
    setMessage("正在提交刷新任务……");
    try {
      await bridge.mutate("feishu:requestPull", { day: today, force: true });
      setMessage("已排上，自动化会拉表并写回【总结】页。");
    } catch (error) {
      setMessage(`提交失败：${String(error).slice(0, 180)}`);
    } finally {
      setSubmitting(false);
    }
  }

  if (!summary) {
    return (
      <div className="lc-feishu-summary">
        <p className="lc-dim">还没写过【总结】页。</p>
        <FeishuRefreshControls
          active={active}
          submitting={submitting}
          message={message}
          onRefresh={() => void refreshSummary()}
        />
      </div>
    );
  }
  return (
    <div className="lc-feishu-summary">
      <FeishuRefreshControls
        active={active}
        submitting={submitting}
        message={message}
        onRefresh={() => void refreshSummary()}
      />
      <div className="lc-stats">
        <div className="lc-stat">
          <div className="lc-stat-label">还欠</div>
          <div className="lc-stat-value">{summary.pendingTotal}</div>
          <div className="lc-stat-unit">条</div>
        </div>
        <div className="lc-stat">
          <div className="lc-stat-label">已完成</div>
          <div className="lc-stat-value">{summary.done}</div>
          <div className="lc-stat-unit">/ {summary.total} 条</div>
        </div>
      </div>
      <p className="lc-dim">
        用 {summary.day} 那份快照写的，写于 {summary.writtenAt.slice(0, 16).replace("T", " ")}
      </p>
      {summary.url && (
        <p>
          <a href={summary.url} target="_blank" rel="noreferrer">
            打开飞书上的【{summary.sheetTitle}】
          </a>
        </p>
      )}
    </div>
  );
}

function FeishuRefreshControls({
  active,
  submitting,
  message,
  onRefresh,
}: {
  active: DaySnapshot["activeJobs"][number] | undefined;
  submitting: boolean;
  message: string;
  onRefresh: () => void;
}) {
  return (
    <div className="lc-feishu-summary-actions">
      <button type="button" onClick={onRefresh} disabled={submitting || Boolean(active)}>
        {active ? "更新中……" : "更新总结页"}
      </button>
      {active && <p className="lc-dim">{active.progress}</p>}
      {message && <p className="lc-dim">{message}</p>}
    </div>
  );
}

/**
 * 在跑的活。
 *
 * **这一条是整套改造最直接的体感落点。** 从前飞书那条链只能显示
 * 「已经喊了一嗓子，等新的快照落地……」——因为拿不到对面的状态。
 * 现在显示的是对面报回来的真话，外加第几次尝试、上次错在哪。
 */
function JobStrip({ jobs }: { jobs: DaySnapshot["activeJobs"] }) {
  if (jobs.length === 0) return null;
  return (
    <ul className="lc-jobs">
      {jobs.map((j) => (
        <li key={j._id} className={`lc-job lc-job-${j.status}`}>
          <span className="lc-job-kind">{j.kind}</span>
          <span className="lc-job-progress">{j.progress}</span>
          {j.attempt > 1 && (
            <span className="lc-dim">第 {j.attempt}/{j.maxAttempts} 次</span>
          )}
          {j.lastError && <span className="lc-job-error">{j.lastError}</span>}
        </li>
      ))}
    </ul>
  );
}
