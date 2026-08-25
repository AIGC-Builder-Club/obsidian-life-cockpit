// 每日专注趋势。
//
// **为什么改用 Recharts**（AME-267）：上一版是手画 SVG。仓库主人的判断是
// 「该用 UI 组件库就去用——运行时的损耗和体积几乎可以忽略不计；而全部手画
// 其实会消耗很多 token 在这个上面」。他是对的：手画一根柱子很便宜，
// 但坐标轴刻度取整、响应式重排、hover 命中区、tooltip 定位这些**每一样都要
// 重新写一遍**，而且写出来的必然比库差。
//
// 形状是先定下来的，不是库给什么用什么：
//
// - **柱状而不是折线。** 数据是按天的离散桶，而且**空档必须读成「那天没干活」**，
//   不能被折线插值连起来——折线会把没上班的周末画成一条平滑的下坡。
// - **单序列。** 只画「每天专注了多少分钟」这一个量，所以**不摆图例**
//   （只有一种颜色时，标题已经说清楚画的是什么，一个单格图例只是重复标题还占地方）。
// - **颜色只有一个色相**，取自 Obsidian 的 `--interactive-accent`，
//   所以换主题、换深浅色自动跟着走。用 Obsidian 默认强调色对着浅底和深底各验过一次：
//   亮度带、彩度下限、与底色对比度全部通过。
//
// 三条 mark 规格照办：柱子**最粗 24px**（不填满整格，留白是设计的一部分）、
// **顶端 4px 圆角、贴基线那头是方的**、网格线是**一格灰的 1 像素实线**（不用虚线）。

import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface TrendPoint {
  day: string;
  focusMinutes: number;
  completedPomodoros: number;
  startedPomodoros: number;
  onGoal: number;
  earned: number;
  spent: number;
}

/** Y 轴刻度取整到干净的数字。`147.12 分钟` 这种刻度没人想读。 */
function niceTicks(max: number): number[] {
  const step = max <= 60 ? 15 : max <= 180 ? 30 : max <= 360 ? 60 : 120;
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top; v += step) out.push(v);
  return out;
}

/**
 * Tooltip。**值在前、名字在后**——图例的层级在这里是反的：
 * 读者已经知道自己指着哪一天，他要的是那个数。
 *
 * 文字一律用文字色（`--text-normal` / `--text-muted`），**不穿数据的颜色**。
 */
function TrendTooltip({ active, payload }: {
  active?: boolean;
  payload?: Array<{ payload: TrendPoint }>;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="lc-tip">
      <div className="lc-tip-head">{p.day}</div>
      <div className="lc-tip-row">
        <span className="lc-tip-key" aria-hidden="true" />
        <strong>{Math.round(p.focusMinutes)} 分钟</strong>
        <span className="lc-dim">专注</span>
      </div>
      <div className="lc-tip-row">
        <strong>{p.completedPomodoros} / {p.startedPomodoros}</strong>
        <span className="lc-dim">番茄跑满 / 开了</span>
      </div>
      <div className="lc-tip-row">
        <strong>{p.onGoal}</strong>
        <span className="lc-dim">挂到目标上</span>
      </div>
      {(p.earned > 0 || p.spent > 0) && (
        <div className="lc-tip-row">
          <strong>+{p.earned} / −{p.spent}</strong>
          <span className="lc-dim">积分入账 / 出账</span>
        </div>
      )}
    </div>
  );
}

export function TrendChart({ points }: { points: TrendPoint[] }) {
  // 表格视图。**tooltip 只是增强，不是唯一通道**——
  // 每一个能 hover 出来的数，不 hover 也要拿得到。
  const [showTable, setShowTable] = useState(false);

  const { max, peakDay } = useMemo(() => {
    let max = 0;
    let peakDay = "";
    for (const p of points) {
      if (p.focusMinutes > max) {
        max = p.focusMinutes;
        peakDay = p.day;
      }
    }
    return { max, peakDay };
  }, [points]);

  if (points.length === 0) return <p className="lc-dim">还没有数据。</p>;

  const ticks = niceTicks(Math.max(max, 60));

  return (
    <div className="lc-chart">
      <div style={{ width: "100%", height: "9em" }}>
        <ResponsiveContainer>
          <BarChart
            data={points}
            margin={{ top: 14, right: 4, bottom: 0, left: -18 }}
            // 相邻柱子之间留一条底色的缝：**靠缝分开，不靠描边**。
            // 描边是给不是数据的东西加数据的墨。
            barCategoryGap={2}
          >
            {/* 网格线一格灰、1 像素实线、只留横向——竖线对按天读数没有帮助 */}
            <CartesianGrid
              vertical={false}
              stroke="var(--background-modifier-border)"
              strokeWidth={1}
            />
            <XAxis
              dataKey="day"
              // 日期只留月-日；一整年的 `2026-` 前缀对读图没有信息
              tickFormatter={(d: string) => d.slice(5)}
              tick={{ fill: "var(--text-muted)", fontSize: "0.72em" }}
              tickLine={false}
              axisLine={{ stroke: "var(--background-modifier-border)" }}
              // 天数多的时候让 Recharts 自己隔着标，别把刻度挤成一坨
              interval="preserveStartEnd"
              minTickGap={14}
            />
            <YAxis
              ticks={ticks}
              domain={[0, ticks[ticks.length - 1]]}
              tick={{ fill: "var(--text-muted)", fontSize: "0.72em" }}
              tickLine={false}
              axisLine={false}
              width={40}
            />
            <Tooltip
              content={<TrendTooltip />}
              // 命中区比柱子本身大一圈——瞄准 2 像素的东西没人瞄得准
              cursor={{ fill: "var(--background-modifier-hover)" }}
            />
            <Bar
              dataKey="focusMinutes"
              // 顶端 4px 圆角，贴基线那头是方的
              radius={[4, 4, 0, 0]}
              // 最粗 24px：不填满整格，剩下的是留白
              maxBarSize={24}
              isAnimationActive={false}
              fill="var(--interactive-accent)"
            >
              {points.map((p) => (
                <Cell
                  key={p.day}
                  // 一整天一个番茄都没跑满的日子要看得出来，否则趋势图会骗人。
                  // 用同一色相的**淡一档**（不是第二个色相）——它不是另一个序列，
                  // 是同一个量的一种状态。
                  fill={
                    p.completedPomodoros > 0
                      ? "var(--interactive-accent)"
                      : "var(--background-modifier-border)"
                  }
                />
              ))}
              {/* **只标极值，不是每根都标。** 每个点都挂数字是噪音，没人读 */}
              <LabelList
                dataKey="focusMinutes"
                position="top"
                content={(props: {
                  x?: string | number;
                  y?: string | number;
                  width?: string | number;
                  index?: number;
                }) => {
                  const i = props.index ?? -1;
                  const p = points[i];
                  if (!p || p.day !== peakDay || max <= 0) return null;
                  const x = Number(props.x ?? 0) + Number(props.width ?? 0) / 2;
                  const y = Number(props.y ?? 0) - 4;
                  return (
                    <text
                      x={x}
                      y={y}
                      textAnchor="middle"
                      // 文字穿文字色，不穿数据色
                      fill="var(--text-normal)"
                      fontSize="0.72em"
                      fontWeight={600}
                    >
                      {Math.round(max)}
                    </text>
                  );
                }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="lc-chart-axis">
        <span className="lc-dim">柱子淡的那几天：一个番茄都没跑满</span>
        <button className="lc-linkish" onClick={() => setShowTable((v) => !v)}>
          {showTable ? "收起表格" : "看表格"}
        </button>
      </div>

      {showTable && (
        <table className="lc-table">
          <caption className="lc-dim">每日专注（分钟）与番茄数</caption>
          <thead>
            <tr>
              <th scope="col">日期</th>
              <th scope="col">专注</th>
              <th scope="col">跑满 / 开了</th>
              <th scope="col">挂目标</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.day}>
                <th scope="row">{p.day}</th>
                <td>{Math.round(p.focusMinutes)}</td>
                <td>{p.completedPomodoros} / {p.startedPomodoros}</td>
                <td>{p.onGoal}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
