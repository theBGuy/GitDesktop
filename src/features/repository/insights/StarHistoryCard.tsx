import type { ReactNode, Ref } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { DEGRADED_ACTION_CLASS } from "@/features/conversations/remote-section-state";
import {
  ARIA_DISABLED_CLASS,
  useDisabledReason,
} from "@/lib/use-disabled-reason";
import { cn } from "@/lib/utils";
import { DataTable } from "./charts";
import { ChartFigure, Empty, fmt, useChartLabel } from "./primitives";
import {
  STAR_LOADING_TEXT,
  type StarCardState,
  type StarMode,
  type StarPoint,
  type StarView,
  starFigcaption,
  starMode,
  starNote,
  starXAxis,
  starYAxis,
  visibleStarPoints,
  weekLabel,
} from "./star-history";

const starConfig = {
  stars: { label: "Stars", color: "var(--primary)" },
  total: { label: "New stars", color: "var(--primary)" },
} satisfies ChartConfig;

/** What each mode plots, tabulates and says on hover. */
const SERIES: Record<
  StarMode,
  {
    dataKey: "stars" | "total";
    headers: string[];
    row: (p: StarPoint) => string[];
    tooltip: (p: StarPoint) => ReactNode;
  }
> = {
  cumulative: {
    dataKey: "stars",
    headers: ["Week", "New stars", "Total"],
    row: (p) => [weekLabel(p.week), fmt(p.total), fmt(p.stars)],
    tooltip: (p) => (
      <>
        <span className="text-muted-foreground">Stars</span>
        <span className="font-mono font-medium tabular-nums">
          {fmt(p.stars)}
          <span className="font-sans text-muted-foreground">
            {` · +${fmt(p.total)} that week`}
          </span>
        </span>
      </>
    ),
  },
  gains: {
    dataKey: "total",
    headers: ["Week", "New stars"],
    row: (p) => [weekLabel(p.week), fmt(p.total)],
    tooltip: (p) => (
      <>
        <span className="text-muted-foreground">New stars</span>
        <span className="font-mono font-medium tabular-nums">
          +{fmt(p.total)}
          <span className="font-sans text-muted-foreground">
            {" that week"}
          </span>
        </span>
      </>
    ),
  },
};

/** The Star history card's body over a loaded first page; the board drives
 *  the pages. `retryRef` is the board's focus rescue for the partial line's
 *  Retry, whose host sits outside the dimmed body. */
export function StarHistoryCard({
  state,
  onRetry,
  retryRef,
}: {
  state: StarCardState;
  onRetry: () => void;
  retryRef: Ref<HTMLButtonElement>;
}) {
  const note = starNote(state.summary);
  if (note.kind === "unavailable") return <Empty>{note.text}</Empty>;
  if (state.awaitingWindow) return <Skeleton className="w-full flex-1" />;
  return (
    <div className="flex flex-col gap-2">
      <StarChart
        points={visibleStarPoints(state.summary)}
        view={state.summary.view}
        mode={starMode(state.summary)}
        caption={starFigcaption(state.summary)}
      />
      {state.partialLine !== null && (
        <p className="text-[11px] text-muted-foreground">
          {state.partialLine}{" "}
          <StarRetry
            held={state.retryHeld}
            onRetry={onRetry}
            retryRef={retryRef}
          />
        </p>
      )}
      {note.kind !== "none" && (
        <p className="text-[11px] text-muted-foreground">{note.text}</p>
      )}
    </div>
  );
}

/** The partial line's Retry. Held while its read fetches: it stays focusable
 *  and mounted (the focus rescue keys on the line), and a press does nothing. */
function StarRetry({
  held,
  onRetry,
  retryRef,
}: {
  held: boolean;
  onRetry: () => void;
  retryRef: Ref<HTMLButtonElement>;
}) {
  const { blockedReason, reasonId, wrapperTitle, describedBy, nativeProps } =
    useDisabledReason({
      disabled: held,
      reason: STAR_LOADING_TEXT,
      onClick: onRetry,
    });
  return (
    <span
      className={cn(blockedReason && "cursor-not-allowed")}
      title={wrapperTitle}
    >
      <button
        ref={retryRef}
        type="button"
        aria-label="Retry loading older weeks"
        aria-describedby={describedBy}
        {...nativeProps}
        className={cn(DEGRADED_ACTION_CLASS, ARIA_DISABLED_CLASS)}
      >
        Retry
      </button>
      {blockedReason ? (
        <span id={reasonId} className="sr-only">
          {blockedReason}
        </span>
      ) : null}
    </span>
  );
}

/** One tooltip row for a week. The spaces are text, not margins, so the
 *  row reads as words to assistive tech and in copied text. */
export function StarTooltipRow({
  mode,
  point,
}: {
  mode: StarMode;
  point: StarPoint;
}) {
  return (
    <span className="flex w-full justify-between gap-3">
      {SERIES[mode].tooltip(point)}
    </span>
  );
}

/** The cumulative curve, or each week's new stars while the count is unknown
 *  with weeks owed; one point still paints, as a dot. */
function StarChart({
  points,
  view,
  mode,
  caption,
}: {
  points: StarPoint[];
  view: StarView;
  mode: StarMode;
  caption: string;
}) {
  const series = SERIES[mode];
  const chartLabel = useChartLabel();
  const y = starYAxis(
    view,
    points.map((p) => p[series.dataKey]),
    mode,
  );
  const x = starXAxis(points.map((p) => p.week));
  return (
    <ChartFigure
      caption={caption}
      table={
        <DataTable headers={series.headers} rows={points.map(series.row)} />
      }
    >
      <ChartContainer config={starConfig} className="aspect-auto h-40 w-full">
        <AreaChart
          data={points}
          accessibilityLayer
          aria-label={chartLabel}
          margin={{ left: 4, right: 8 }}
        >
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="week"
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            minTickGap={24}
            ticks={x.ticks}
            tickFormatter={x.format}
          />
          <YAxis
            width={y.width}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            domain={y.domain}
            ticks={y.ticks}
            tickFormatter={y.format}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(_, payload) => {
                  const point = payload?.[0]?.payload as StarPoint | undefined;
                  return point ? weekLabel(point.week) : null;
                }}
                formatter={(_value, _name, item) => {
                  const point = item?.payload as StarPoint | undefined;
                  return point ? (
                    <StarTooltipRow mode={mode} point={point} />
                  ) : null;
                }}
              />
            }
          />
          <Area
            dataKey={series.dataKey}
            type="monotone"
            fill={`var(--color-${series.dataKey})`}
            fillOpacity={0.2}
            stroke={`var(--color-${series.dataKey})`}
            dot={points.length === 1}
          />
        </AreaChart>
      </ChartContainer>
    </ChartFigure>
  );
}
