import type { Ref } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { DEGRADED_ACTION_CLASS } from "@/features/conversations/remote-section-state";
import { DataTable } from "./charts";
import { ChartFigure, Empty, fmt } from "./primitives";
import {
  type StarCardState,
  type StarPoint,
  type StarView,
  starFigcaption,
  starNote,
  starXAxis,
  starYAxis,
  visibleStarPoints,
  weekLabel,
} from "./star-history";

const starConfig = {
  stars: { label: "Stars", color: "var(--primary)" },
} satisfies ChartConfig;

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
        caption={starFigcaption(state.summary)}
      />
      {state.partialLine !== null && (
        <p className="text-[11px] text-muted-foreground">
          {state.partialLine}{" "}
          <button
            ref={retryRef}
            type="button"
            aria-label="Retry loading older weeks"
            onClick={onRetry}
            className={DEGRADED_ACTION_CLASS}
          >
            Retry
          </button>
        </p>
      )}
      {note.kind !== "none" && (
        <p className="text-[11px] text-muted-foreground">{note.text}</p>
      )}
    </div>
  );
}

/** The cumulative curve; one point still paints, as a dot. */
function StarChart({
  points,
  view,
  caption,
}: {
  points: StarPoint[];
  view: StarView;
  caption: string;
}) {
  const y = starYAxis(
    view,
    points.map((p) => p.stars),
  );
  const x = starXAxis(points.map((p) => p.week));
  return (
    <ChartFigure
      caption={caption}
      table={
        <DataTable
          headers={["Week", "New stars", "Total"]}
          rows={points.map((p) => [
            weekLabel(p.week),
            fmt(p.total),
            fmt(p.stars),
          ])}
        />
      }
    >
      <ChartContainer config={starConfig} className="aspect-auto h-40 w-full">
        <AreaChart
          data={points}
          accessibilityLayer
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
                formatter={(value, _name, item) => {
                  const point = item?.payload as StarPoint | undefined;
                  return (
                    <span className="flex w-full justify-between gap-3">
                      <span className="text-muted-foreground">Stars</span>
                      <span className="font-mono font-medium tabular-nums">
                        {fmt(Number(value))}
                        {typeof point?.total === "number" && (
                          <span className="ml-1 font-sans text-muted-foreground">
                            · +{fmt(point.total)} that week
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
            dataKey="stars"
            type="monotone"
            fill="var(--color-stars)"
            fillOpacity={0.2}
            stroke="var(--color-stars)"
            dot={points.length === 1}
          />
        </AreaChart>
      </ChartContainer>
    </ChartFigure>
  );
}
