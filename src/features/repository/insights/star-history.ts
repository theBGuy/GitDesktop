// The Star history card's derivations, pure. React-free and import-free so
// scripts/star-history.test.mjs loads it under Node's type stripping, which
// resolves no aliases; the wire shapes are declared structurally here.

/** A wire week: GitHub's Sunday 00:00 UTC epoch in seconds and the stars
 *  gained that week. */
export interface StarWeekInput {
  week: number;
  total: number;
}

/** The slice of a star-history page the derivations read. */
export interface StarPageInput {
  available: boolean;
  weeks: readonly StarWeekInput[];
  /** The wire's next page; the read follows only the page after this one. */
  nextPage: number | null;
  lastPage: number | null;
  stargazersCount: number | null;
}

/** One week of the curve: that week's gain and the running total after it. */
export interface StarPoint {
  week: number;
  total: number;
  stars: number;
}

export interface StarSeries {
  /** Oldest week first. */
  points: StarPoint[];
  baseline: number;
}

/** The board's window: the newest weeks of the all-time series. */
export const STAR_WINDOW_WEEKS = 52;

const WEEK_SECONDS = 7 * 86_400;

/** The shortest trailing run of zero weeks the card calls out. */
export const STAR_FLAT_TAIL_MIN = 4;

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function readWeek(w: unknown): StarWeekInput | null {
  if (typeof w !== "object" || w === null) return null;
  const { week, total } = w as Record<string, unknown>;
  return typeof week === "number" && Number.isFinite(week) && isCount(total)
    ? { week, total }
    : null;
}

/** Page 1's live stargazers count, or null when GitHub didn't send one. */
export function liveStarCount(
  pages: readonly Pick<StarPageInput, "stargazersCount">[],
): number | null {
  const count = pages[0]?.stargazersCount;
  return isCount(count) ? count : null;
}

/**
 * The cumulative curve over every loaded week, which arrive newest first. A
 * week no older than the last one kept is dropped: a Sunday rollover between
 * page fetches shifts every page boundary, repeating a week. The baseline is
 * the live count minus the loaded weeks (0 without a count, clamped at 0), so
 * the curve ends at the live count and the window is the all-time tail.
 */
export function buildStarSeries(
  pages: readonly Pick<StarPageInput, "weeks" | "stargazersCount">[],
): StarSeries {
  const weeks: StarWeekInput[] = [];
  for (const page of pages) {
    if (!Array.isArray(page?.weeks)) continue;
    for (const raw of page.weeks) {
      const week = readWeek(raw);
      const last = weeks[weeks.length - 1];
      if (week && (last === undefined || week.week < last.week))
        weeks.push(week);
    }
  }
  weeks.reverse();
  let sum = 0;
  for (const w of weeks) sum += w.total;
  const count = liveStarCount(pages);
  const baseline = count === null ? 0 : Math.max(0, count - sum);
  let stars = baseline;
  const points = weeks.map(({ week, total }) => {
    stars += total;
    return { week, total, stars };
  });
  return { points, baseline };
}

/** The newest `windowWeeks` points: the window's slice of the all-time curve. */
export function windowSlice(
  points: readonly StarPoint[],
  windowWeeks = STAR_WINDOW_WEEKS,
): StarPoint[] {
  return windowWeeks > 0 ? points.slice(-windowWeeks) : [];
}

/** Stars gained across the window. */
export function windowGain(
  points: readonly StarPoint[],
  windowWeeks = STAR_WINDOW_WEEKS,
): number {
  let gain = 0;
  for (const p of windowSlice(points, windowWeeks)) gain += p.total;
  return gain;
}

/** How many of the newest weeks gained no stars. */
export function trailingZeroWeeks(points: readonly StarPoint[]): number {
  let run = 0;
  for (let i = points.length - 1; i >= 0 && points[i].total === 0; i--) run++;
  return run;
}

/** Whole-number steps of 1, 2 or 5 per power of ten, about four per range. */
function niceStep(range: number): number {
  const rough = range / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const nice = [1, 2, 5].find((n) => rough / pow <= n + 1e-9) ?? 10;
  return Math.max(1, Math.round(nice * pow));
}

/** The window's Y axis: labelled ticks spanning the values' own range. A flat
 *  series pads one star either side (never below 0), so it still draws. */
export function windowAxis(values: readonly number[]): {
  domain: [number, number];
  ticks: number[];
} {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return { domain: [0, 1], ticks: [0, 1] };
  let min = finite[0];
  let max = finite[0];
  for (const v of finite) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const flat = min === max;
  const step = flat ? 1 : niceStep(max - min);
  const lo = flat ? Math.max(0, min - 1) : Math.floor(min / step) * step;
  const hi = flat ? max + 1 : Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = lo; t <= hi; t += step) ticks.push(t);
  return { domain: [lo, hi], ticks };
}

const COMPACT = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
const compactCount = (v: number) => COMPACT.format(v);
const fullCount = (v: number) => v.toLocaleString();

/** The Y axis the card draws, labels and width included. */
export interface StarYAxis {
  domain: [number, number] | [number, "auto"];
  /** Undefined: Recharts picks them. */
  ticks: number[] | undefined;
  format: (v: number) => string;
  width: number;
}

/** Compact labels ("252K") unless two of the ticks would read the same, as a
 *  zoomed window's close steps do past 1K; then full counts, the axis widened
 *  to the longest. */
function labelledAxis(domain: [number, number], ticks: number[]): StarYAxis {
  const compact = ticks.map(compactCount);
  const distinct = new Set(compact).size === compact.length;
  const format = distinct ? compactCount : fullCount;
  const longest = Math.max(...ticks.map((t) => format(t).length));
  return { domain, ticks, format, width: Math.max(44, 8 + 7 * longest) };
}

/** The window spans its values' own range; All time starts at 0, and a
 *  history with no stars pads to [0, 1] as the window's flat guard does. */
export function starYAxis(
  view: StarView,
  values: readonly number[],
): StarYAxis {
  if (view === "window") {
    const { domain, ticks } = windowAxis(values);
    return labelledAxis(domain, ticks);
  }
  const max = Math.max(0, ...values.filter((v) => Number.isFinite(v)));
  return max > 0
    ? { domain: [0, "auto"], ticks: undefined, format: compactCount, width: 44 }
    : labelledAxis([0, 1], [0, 1]);
}

/** What the card draws: the window, or every loaded week. All time draws the
 *  loaded weeks once nothing more will load (no page remains, or the read
 *  failed), and keeps them while a Retry resumes (`spanHeld`), so the curve
 *  never steps back to the window between the span and the whole. A first
 *  load of older weeks, or one parked offline, keeps the window up. */
export type StarView = "window" | "all";

export function starView(
  allTime: boolean,
  hasMore: boolean,
  partial: boolean,
  spanHeld: boolean,
): StarView {
  return allTime && (!hasMore || partial || spanHeld) ? "all" : "window";
}

/** Whether All time holds the loaded span on the next render: from the
 *  partial view of a failed read until the load completes or All time is left. */
export function starSpanHeld(
  allTime: boolean,
  hasMore: boolean,
  partial: boolean,
  held: boolean,
): boolean {
  return allTime && hasMore && (partial || held);
}

/** What the header slot, the figcaption and the note line read: one shape, so
 *  they can't drift. */
export interface StarSummaryInput {
  /** The loaded pages, page 1 first. */
  pages: readonly StarPageInput[];
  /** `buildStarSeries(pages)`. */
  series: StarSeries;
  /** More pages remain (the read's `hasNextPage`). */
  hasMore: boolean;
  view: StarView;
  /** All time is loading older weeks right now. */
  driving: boolean;
}

/** The points the card draws for `input.view`. */
export function visibleStarPoints(input: StarSummaryInput): StarPoint[] {
  return input.view === "window"
    ? windowSlice(input.series.points)
    : input.series.points;
}

/** The count to show: the live one, else the loaded weeks' total once every
 *  page is in. Null while it isn't known. */
export function starDisplayCount(input: StarSummaryInput): number | null {
  const live = liveStarCount(input.pages);
  if (live !== null) return live;
  if (input.hasMore) return null;
  const { points, baseline } = input.series;
  return points.length > 0 ? points[points.length - 1].stars : baseline;
}

/** The window's gain, only while the window is drawn and holds a full 52 loaded
 *  weeks: a partial window would understate it, and a history shorter than the
 *  window gained everything in it, which the count already says. */
function shownWindowGain(input: StarSummaryInput): number | null {
  if (input.view !== "window") return null;
  const { points } = input.series;
  return points.length >= STAR_WINDOW_WEEKS ? windowGain(points) : null;
}

function answered(input: StarSummaryInput): boolean {
  return input.pages.length > 0 && input.pages[0].available !== false;
}

/** Older weeks exist that aren't loaded: pages remain, or (defense in depth,
 *  since the backend refuses such a page) the last page names a next page
 *  the read won't follow. */
function spanOwed(input: StarSummaryInput): boolean {
  const tail = input.pages[input.pages.length - 1];
  return input.hasMore || (tail !== undefined && tail.nextPage !== null);
}

/** An answered history with no stars at all: the note says so, alone. */
function noStarsYet(input: StarSummaryInput): boolean {
  return (
    answered(input) &&
    starDisplayCount(input) === 0 &&
    input.series.points.every((p) => p.total === 0)
  );
}

function starsText(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "star" : "stars"}`;
}

export type StarHeaderSlot =
  | { kind: "none" }
  | { kind: "counter"; loaded: number; of: number | null; text: string }
  | { kind: "stats"; count: number | null; gain: number | null; text: string };

/** The card's header slot. Nothing before an answer, for an unavailable
 *  history, or at 0 stars; the page counter while All time loads (page 1's
 *  `lastPage` is the only page total, so a later page's never stands in);
 *  otherwise the count, plus the window's gain while the window is drawn. */
export function starHeaderSlot(input: StarSummaryInput): StarHeaderSlot {
  if (!answered(input)) return { kind: "none" };
  const count = starDisplayCount(input);
  if (count === 0) return { kind: "none" };
  if (input.driving) {
    const loaded = input.pages.length;
    const last = input.pages[0].lastPage;
    const of = isCount(last) && last > loaded ? last : null;
    const text =
      of === null
        ? "Loading older weeks…"
        : `Loading older weeks · ${loaded.toLocaleString()} of ${of.toLocaleString()}`;
    return { kind: "counter", loaded, of, text };
  }
  const gain = shownWindowGain(input);
  const parts = [
    count === null ? null : starsText(count),
    gain === null ? null : `+${gain.toLocaleString()} in 52 weeks`,
  ].filter((p) => p !== null);
  if (parts.length === 0) return { kind: "none" };
  return { kind: "stats", count, gain, text: parts.join(" · ") };
}

const FIGCAPTION_LEAD = "Today's stargazers by the week they starred";

const FIGCAPTION: Record<StarView, (input: StarSummaryInput) => string> = {
  window: (input) => {
    const count = starDisplayCount(input);
    const gain = shownWindowGain(input);
    const parts = [
      count === null ? null : starsText(count),
      gain === null ? null : `+${gain.toLocaleString()} in the last 52 weeks`,
    ].filter((p) => p !== null);
    return parts.length === 0
      ? `${FIGCAPTION_LEAD}.`
      : `${FIGCAPTION_LEAD}. ${parts.join(", ")}.`;
  },
  // A span short of the whole history dates the weeks, never the stars: the
  // baseline holds the stars of the weeks it leaves out.
  all: (input) => {
    const count = starDisplayCount(input);
    const stars = count === null ? "" : `. ${starsText(count)}`;
    const oldest = input.series.points[0];
    if (!oldest) return `${FIGCAPTION_LEAD}${stars}.`;
    const month = monthYearLabel(oldest.week);
    if (spanOwed(input))
      return `${FIGCAPTION_LEAD}${stars}; showing weeks since ${month}.`;
    return count === null
      ? `${FIGCAPTION_LEAD}, since ${month}.`
      : `${FIGCAPTION_LEAD}${stars} since ${month}.`;
  },
};

/** The figure's caption for what it draws; the count and gain follow the
 *  header's rules. With no stars yet it is the lead alone. */
export function starFigcaption(input: StarSummaryInput): string {
  return noStarsYet(input)
    ? `${FIGCAPTION_LEAD}.`
    : FIGCAPTION[input.view](input);
}

export type StarNote =
  | { kind: "none" }
  | { kind: "unavailable"; text: string }
  | { kind: "noStars"; text: string }
  | { kind: "flatTail"; weeks: number; text: string };

const NOTE_TEXT = {
  unavailable: "Star history isn't available for this repository.",
  noStars: "No stars yet.",
} as const;

/** The note line under the figure, from a read that answered so. A trailing
 *  zero run counts the newest week, which is still in progress. */
export function starNote(input: StarSummaryInput): StarNote {
  if (input.pages.length === 0) return { kind: "none" };
  if (!answered(input))
    return { kind: "unavailable", text: NOTE_TEXT.unavailable };
  if (noStarsYet(input)) return { kind: "noStars", text: NOTE_TEXT.noStars };
  const weeks = trailingZeroWeeks(visibleStarPoints(input));
  return weeks >= STAR_FLAT_TAIL_MIN
    ? {
        kind: "flatTail",
        weeks,
        text: `No new stars in the last ${weeks} weeks.`,
      }
    : { kind: "none" };
}

/** The in-card line over a partial history: where the loaded span starts. */
export function starPartialLine(points: readonly StarPoint[]): string | null {
  const oldest = points[0];
  return oldest
    ? `Showing since ${monthYearLabel(oldest.week)} — couldn't load older weeks.`
    : null;
}

/** The slice of the infinite read the card decides on: the structurally
 *  shared data plus primitives, so an unchanged read derives nothing anew. */
export interface StarReadInput {
  data: { pages: readonly StarPageInput[] } | undefined;
  hasNextPage: boolean;
  isError: boolean;
  isPaused: boolean;
}

export interface StarCardState {
  summary: StarSummaryInput;
  /** Pages are owed and the read is in error (not parked): All time draws the
   *  loaded span. Read off the state, not the failed fetch's direction, which
   *  a later refetch's failure overwrites. */
  partial: boolean;
  /** The partial line, while the failure leaves out weeks the view would draw:
   *  All time's span, or a window short of 52 weeks. Its Retry shows with it. */
  partialLine: string | null;
  /** The window's first draw still waits on pages, so the card holds a
   *  skeleton rather than drawing a page and then reflowing. */
  awaitingWindow: boolean;
  /** All time loads older weeks over a drawn curve, so the body dims. */
  stale: boolean;
  /** Another page is owed once no fetch is in flight. A failed page, a failed
   *  refresh, or a park stops it until a Retry or the reconnect. */
  wantsPage: boolean;
}

/** What the card and its header draw for a read, in one place. `windowDrawn`:
 *  the window has drawn for this repo, so a resumed page never swaps it back
 *  to the skeleton. */
export function starCardState(
  read: StarReadInput,
  allTime: boolean,
  spanHeld: boolean,
  windowDrawn: boolean,
): StarCardState {
  const pages = read.data?.pages ?? [];
  const series = buildStarSeries(pages);
  const hasMore = read.hasNextPage;
  const partial =
    read.data !== undefined && hasMore && read.isError && !read.isPaused;
  const view = starView(allTime, hasMore, partial, spanHeld);
  const settled = !read.isError && !read.isPaused;
  const short = series.points.length < STAR_WINDOW_WEEKS;
  const driving = allTime && hasMore && settled;
  const awaitingWindow =
    view === "window" && short && hasMore && settled && !windowDrawn;
  return {
    summary: { pages, series, hasMore, view, driving },
    partial,
    partialLine:
      partial && (view === "all" || short)
        ? starPartialLine(series.points)
        : null,
    awaitingWindow,
    stale: driving && !awaitingWindow,
    wantsPage: hasMore && settled && (allTime || short),
  };
}

// Week epochs name a calendar date at Sunday 00:00 UTC, so they format in UTC
// with date parts only: local time west of UTC would show the Saturday before.
function utcFormat(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(undefined, { ...options, timeZone: "UTC" });
}

const WEEK_DATE = utcFormat({
  month: "short",
  day: "numeric",
  year: "numeric",
});
const MONTH_YEAR = utcFormat({ month: "short", year: "numeric" });
const DAY_TICK = utcFormat({ month: "short", day: "numeric" });
const YEAR_TICK = utcFormat({ year: "numeric" });

/** The calendar date a week names, as the parts `weekLabel` prints. */
export function weekDateParts(week: number): {
  year: string;
  month: string;
  day: string;
} {
  const parts = WEEK_DATE.formatToParts(week * 1000);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return { year: part("year"), month: part("month"), day: part("day") };
}

/** "Week of Nov 1, 2026" in the user's locale. */
export function weekLabel(week: number): string {
  return `Week of ${WEEK_DATE.format(week * 1000)}`;
}

/** Ticks by the week under 13 weeks ("Aug 2"), by the month to 3 years
 *  ("Nov 2025"), then by the year ("2021"). */
function tickGrain(spanWeeks: number): Intl.DateTimeFormat {
  if (spanWeeks < 13) return DAY_TICK;
  if (spanWeeks <= 156) return MONTH_YEAR;
  return YEAR_TICK;
}

/** The X axis: a tick on the first loaded week of each day, month or year
 *  label, so no label repeats. Grouping reads the label itself, so it shares
 *  the label's UTC calendar. */
export function starXAxis(weeks: readonly number[]): {
  ticks: number[];
  format: (week: number) => string;
} {
  const span =
    weeks.length === 0
      ? 0
      : (weeks[weeks.length - 1] - weeks[0]) / WEEK_SECONDS + 1;
  const grain = tickGrain(span);
  const format = (week: number) => grain.format(week * 1000);
  const ticks: number[] = [];
  let previous: string | null = null;
  for (const week of weeks) {
    const label = format(week);
    if (label !== previous) ticks.push(week);
    previous = label;
  }
  return { ticks, format };
}

/** "Mar 2021": the month ticks, the partial line and the All-time caption. */
export function monthYearLabel(week: number): string {
  return MONTH_YEAR.format(week * 1000);
}
