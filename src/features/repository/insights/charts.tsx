import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import type { CodeFreqPoint, TrafficPoint, WeekCount } from "@/lib/git/types";
import { ChartFigure, fmt } from "./primitives";

/** "2025-07" → "W7"; the year still shows in the tooltip/table. */
function weekTick(week: string): string {
  const w = week.split("-")[1] ?? week;
  return `W${Number(w)}`;
}

/** Compact axis labels so large churn ("219,364") fits a narrow Y axis ("219K"). */
const compact = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

function DataTable({
  headers,
  rows,
}: {
  headers: string[];
  rows: (string | number)[][];
}) {
  return (
    <table className="w-full border-collapse text-left tabular-nums">
      <thead>
        <tr className="text-muted-foreground">
          {headers.map((h) => (
            <th key={h} className="border-b py-1 pr-3 font-medium">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={String(r[0])}>
            {r.map((cell, i) => (
              <td
                key={headers[i] ?? i}
                className="border-b border-border/50 py-1 pr-3"
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const commitConfig = {
  commits: { label: "Commits", color: "var(--primary)" },
} satisfies ChartConfig;

export function CommitActivityChart({ data }: { data: WeekCount[] }) {
  const total = data.reduce((n, d) => n + d.commits, 0);
  return (
    <ChartFigure
      caption={`${fmt(total)} commit${total === 1 ? "" : "s"} across ${data.length} active week${data.length === 1 ? "" : "s"}.`}
      table={
        <DataTable
          headers={["Week", "Commits"]}
          rows={data.map((d) => [d.week, fmt(d.commits)])}
        />
      }
    >
      <ChartContainer config={commitConfig} className="aspect-auto h-40 w-full">
        <BarChart data={data} accessibilityLayer margin={{ left: 4, right: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="week"
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            minTickGap={20}
            tickFormatter={weekTick}
          />
          <YAxis
            width={38}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            tickFormatter={(v: number) => compact.format(v)}
          />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar dataKey="commits" fill="var(--color-commits)" radius={2} />
        </BarChart>
      </ChartContainer>
    </ChartFigure>
  );
}

const codeFreqConfig = {
  additions: { label: "Additions", color: "var(--primary)" },
  deletions: { label: "Deletions", color: "var(--chart-2)" },
} satisfies ChartConfig;

export function CodeFrequencyChart({ data }: { data: CodeFreqPoint[] }) {
  // Deletions plotted negative so they mirror below the zero line — the meaning
  // is carried by position + labels, not by color alone.
  const chartData = data.map((d) => ({
    week: d.week,
    additions: d.additions,
    deletions: -Number(d.deletions),
  }));
  const adds = data.reduce((n, d) => n + d.additions, 0);
  const dels = data.reduce((n, d) => n + d.deletions, 0);
  return (
    <ChartFigure
      caption={`+${fmt(adds)} / -${fmt(dels)} lines across ${data.length} active week${data.length === 1 ? "" : "s"} (deletions shown below the line).`}
      table={
        <DataTable
          headers={["Week", "Additions", "Deletions"]}
          rows={data.map((d) => [d.week, fmt(d.additions), fmt(d.deletions)])}
        />
      }
    >
      <ChartContainer
        config={codeFreqConfig}
        className="aspect-auto h-40 w-full"
      >
        <AreaChart data={chartData} accessibilityLayer margin={{ right: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="week"
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            minTickGap={20}
            tickFormatter={weekTick}
          />
          <YAxis
            width={46}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => compact.format(Math.abs(v))}
          />
          <ReferenceLine y={0} stroke="var(--border)" />
          <ChartTooltip
            content={
              <ChartTooltipContent
                formatter={(value, name) => (
                  <span className="flex w-full justify-between gap-3">
                    <span className="text-muted-foreground">
                      {name === "additions" ? "Additions" : "Deletions"}
                    </span>
                    <span className="font-mono font-medium tabular-nums">
                      {fmt(Math.abs(Number(value)))}
                    </span>
                  </span>
                )}
              />
            }
          />
          <Area
            dataKey="additions"
            type="monotone"
            fill="var(--color-additions)"
            fillOpacity={0.25}
            stroke="var(--color-additions)"
          />
          <Area
            dataKey="deletions"
            type="monotone"
            fill="var(--color-deletions)"
            fillOpacity={0.25}
            stroke="var(--color-deletions)"
          />
        </AreaChart>
      </ChartContainer>
    </ChartFigure>
  );
}

const actionsConfig = {
  minutes: { label: "Minutes", color: "var(--primary)" },
} satisfies ChartConfig;

export interface RunDurationPoint {
  run: string;
  minutes: number;
  conclusion: string;
}

export function ActionsDurationChart({ data }: { data: RunDurationPoint[] }) {
  return (
    <ChartFigure
      caption="Run duration (start → finish) for the most recent runs, oldest first."
      table={
        <DataTable
          headers={["Run", "Minutes", "Result"]}
          rows={data.map((d) => [d.run, d.minutes.toFixed(1), d.conclusion])}
        />
      }
    >
      <ChartContainer
        config={actionsConfig}
        className="aspect-auto h-40 w-full"
      >
        <BarChart data={data} accessibilityLayer margin={{ left: 4, right: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="run"
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            minTickGap={16}
          />
          <YAxis
            width={30}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => `${v}m`}
          />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar dataKey="minutes" fill="var(--color-minutes)" radius={2} />
        </BarChart>
      </ChartContainer>
    </ChartFigure>
  );
}

const trafficConfig = {
  views: { label: "Views", color: "var(--primary)" },
  clones: { label: "Clones", color: "var(--chart-2)" },
} satisfies ChartConfig;

/** "2025-06-21T00:00:00Z" → "6/21". */
function dayTick(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : `${d.getMonth() + 1}/${d.getDate()}`;
}

interface TrafficDay {
  timestamp: string;
  views: number;
  viewsUniques: number;
  clones: number;
  clonesUniques: number;
}

/** Views and clones come as separate per-day arrays; align them by day. */
function mergeTraffic(
  views: TrafficPoint[],
  clones: TrafficPoint[],
): TrafficDay[] {
  const byDay = new Map<string, TrafficDay>();
  const blank = (timestamp: string): TrafficDay => ({
    timestamp,
    views: 0,
    viewsUniques: 0,
    clones: 0,
    clonesUniques: 0,
  });
  for (const v of views) {
    const e = byDay.get(v.timestamp) ?? blank(v.timestamp);
    e.views = v.count;
    e.viewsUniques = v.uniques;
    byDay.set(v.timestamp, e);
  }
  for (const c of clones) {
    const e = byDay.get(c.timestamp) ?? blank(c.timestamp);
    e.clones = c.count;
    e.clonesUniques = c.uniques;
    byDay.set(c.timestamp, e);
  }
  return [...byDay.values()].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );
}

/** Daily views + git clones over the trailing 14 days; unique counts surface in
 *  the hover tooltip and the data table (the 14-day totals are in the stat row). */
export function TrafficChart({
  views,
  clones,
}: {
  views: TrafficPoint[];
  clones: TrafficPoint[];
}) {
  const data = mergeTraffic(views, clones);
  return (
    <ChartFigure
      caption="Daily views and git clones over the last 14 days (hover for unique counts)."
      table={
        <DataTable
          headers={["Day", "Views", "Unique", "Clones", "Unique"]}
          rows={data.map((d) => [
            dayTick(d.timestamp),
            fmt(d.views),
            fmt(d.viewsUniques),
            fmt(d.clones),
            fmt(d.clonesUniques),
          ])}
        />
      }
    >
      <ChartContainer
        config={trafficConfig}
        className="aspect-auto h-36 w-full"
      >
        <AreaChart data={data} accessibilityLayer margin={{ right: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="timestamp"
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            minTickGap={24}
            tickFormatter={dayTick}
          />
          <YAxis
            width={32}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            tickFormatter={(v: number) => compact.format(v)}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(value) => dayTick(String(value))}
                formatter={(value, name, item) => {
                  const day = item?.payload as TrafficDay | undefined;
                  const uniques =
                    name === "views" ? day?.viewsUniques : day?.clonesUniques;
                  return (
                    <span className="flex w-full justify-between gap-3">
                      <span className="text-muted-foreground">
                        {name === "views" ? "Views" : "Clones"}
                      </span>
                      <span className="font-mono font-medium tabular-nums">
                        {fmt(Number(value))}
                        {typeof uniques === "number" && (
                          <span className="ml-1 font-sans text-muted-foreground">
                            · {fmt(uniques)} unique
                          </span>
                        )}
                      </span>
                    </span>
                  );
                }}
              />
            }
          />
          <Area
            dataKey="views"
            type="monotone"
            fill="var(--color-views)"
            fillOpacity={0.2}
            stroke="var(--color-views)"
          />
          <Area
            dataKey="clones"
            type="monotone"
            fill="var(--color-clones)"
            fillOpacity={0.2}
            stroke="var(--color-clones)"
          />
        </AreaChart>
      </ChartContainer>
    </ChartFigure>
  );
}
