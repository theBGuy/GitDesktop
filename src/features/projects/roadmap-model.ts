/**
 * The roadmap layout's pure model: which fields place an item on the timeline,
 * where it lands, the axis and markers drawn over it, and what a keyboard date
 * shift writes. Runtime-import-free on purpose: `scripts/project-roadmap-model.test.mjs`
 * imports this file straight from `src/` under Node's type stripping, which
 * resolves no bundler aliases, so only `import type` may appear here.
 *
 * Every date is GitHub's bare `YYYY-MM-DD`, which compares chronologically as a
 * plain string; day arithmetic runs on UTC days, since a bare date names
 * a calendar day and no zone. The one local-zone read is {@link localDateISO}:
 * "today" is the user's own calendar day.
 */
import type {
  BoardItem,
  ProjectFieldDef,
  ProjectFieldValue,
  ProjectIterationDef,
  ProjectViewDef,
} from "@/lib/git/types";

/** Where one end of an item's span comes from. GitHub serves no roadmap date
 *  mapping (measured 2026-09-24), so this is the client's own transient pick. */
export type DateSource =
  | { kind: "date"; fieldId: string }
  | { kind: "iteration"; fieldId: string };

export interface DateSources {
  start: DateSource | null;
  target: DateSource | null;
}

export const NO_DATE_SOURCES: DateSources = { start: null, target: null };

export type Zoom = "month" | "quarter" | "year";

/** Most detailed first: zooming out walks forward, zooming in walks back. */
export const ZOOMS: readonly Zoom[] = ["month", "quarter", "year"];

/** Horizontal scale per zoom — the single tuning point for the timeline's width. */
export const PX_PER_DAY: Record<Zoom, number> = {
  month: 32,
  quarter: 8,
  year: 2,
};

/** Breathing room either side of the data, per zoom. */
const PAD_DAYS: Record<Zoom, number> = { month: 7, quarter: 21, year: 45 };

/** Half the span an EMPTY timeline shows around today. */
const WINDOW_DAYS: Record<Zoom, number> = { month: 31, quarter: 91, year: 365 };

/** The widest range the lane may draw: five years, past which the lane grows
 *  too wide for a scroll bar to navigate. */
export const MAX_RANGE_DAYS = 5 * 365 + 1;

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** `iso` as a UTC epoch-day in ms, or null when it isn't a real calendar date —
 *  the round trip rejects month 13 and February 30 alike. */
function utcMs(iso: string): number | null {
  const match = ISO_DATE.exec(iso);
  if (match === null) return null;
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  // `setUTCFullYear`, never `Date.UTC`: the latter maps years 0–99 to 1900–1999.
  const back = new Date(0);
  back.setUTCFullYear(year, month - 1, day);
  return back.getUTCFullYear() === year &&
    back.getUTCMonth() === month - 1 &&
    back.getUTCDate() === day
    ? back.getTime()
    : null;
}

function isoFromMs(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Whether `value` is a bare `YYYY-MM-DD` naming a real day. */
export function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && utcMs(value) !== null;
}

/** Whole days from `origin` to `iso` — negative when `iso` is earlier. Both must
 *  be valid ISO dates. */
export function dayOffset(iso: string, origin: string): number {
  return Math.round(((utcMs(iso) ?? 0) - (utcMs(origin) ?? 0)) / DAY_MS);
}

/** How many calendar days `start`..`end` covers, both ends included. */
export function daysBetween(start: string, end: string): number {
  return dayOffset(end, start) + 1;
}

export function addDays(iso: string, days: number): string {
  return isoFromMs((utcMs(iso) ?? 0) + days * DAY_MS);
}

/** The user's own calendar day at `ms`, in the LOCAL zone — the one place a zone
 *  applies, since "today" is where the user is. */
export function localDateISO(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 0 = Sunday … 6 = Saturday. */
function weekday(iso: string): number {
  return new Date(utcMs(iso) ?? 0).getUTCDay();
}

function monthIndex(iso: string): number {
  return Number(iso.slice(5, 7)) - 1;
}

function yearOf(iso: string): number {
  return Number(iso.slice(0, 4));
}

/** "Sep 21", with the year added when it isn't `refYear`'s. */
export function shortDate(iso: string, refYear?: number): string {
  const label = `${MONTH_NAMES[monthIndex(iso)]} ${Number(iso.slice(8, 10))}`;
  return refYear === undefined || yearOf(iso) === refYear
    ? label
    : `${label}, ${yearOf(iso)}`;
}

/** The words in a date field's name that say which end it is. A view listing
 *  `Target` before `Start` is common, so column order alone can't orient a
 *  pair. Matched as whole WORDS, plural and verb forms listed, so "Ends" and
 *  "Started" count while "Weekend" and "Restart" say nothing. */
const START_WORDS: ReadonlySet<string> = new Set([
  "start",
  "starts",
  "started",
  "begin",
  "begins",
]);
const TARGET_WORDS: ReadonlySet<string> = new Set([
  "target",
  "targets",
  "end",
  "ends",
  "ended",
  "due",
  "finish",
  "finishes",
  "finished",
  "deadline",
  "deadlines",
]);

/** A field name's words, lower-cased. Any non-letter separates words, and so
 *  does a lower-to-upper step, so `start_date`, `START_DATE` and `startDate`
 *  (the spellings API-created fields use) read like "Start date". */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z]+/)
    .filter((word) => word !== "")
    .map((word) => word.toLowerCase());
}

/**
 * The seed a roadmap view's pick starts from. The first two DATE fields among
 * the view's visible fields, in the view's order, are the pair; short of two, the
 * project's other DATE fields fill in, in definition order. The pair is then
 * ORIENTED by name: a field named like a start (`Start`, `Begin`) goes first and
 * one named like an end (`Target`, `End`, `Due`, `Finish`, `Deadline`) second,
 * wherever the other field doesn't claim the same end; neutral or conflicting
 * names keep that order. A single date field places items as points, on the
 * target end when its name says so. None at all falls to the first ITERATION
 * field for both ends, which spans each item across its iteration.
 */
export function seedDateSources(
  view: ProjectViewDef,
  fieldDefs: ProjectFieldDef[],
): DateSources {
  const dateIds = new Set(
    fieldDefs.filter((def) => def.kind === "date").map((def) => def.id),
  );
  const picked: string[] = [];
  for (const id of view.visibleFieldIds)
    if (dateIds.has(id) && !picked.includes(id)) picked.push(id);
  for (const def of fieldDefs) {
    if (picked.length >= 2) break;
    if (def.kind === "date" && !picked.includes(def.id)) picked.push(def.id);
  }
  const nameOf = (id: string | undefined) =>
    fieldDefs.find((def) => def.id === id)?.name ?? "";
  const says = (id: string | undefined, words: ReadonlySet<string>) =>
    nameWords(nameOf(id)).some((word) => words.has(word));
  const startish = (id: string | undefined) => says(id, START_WORDS);
  const targetish = (id: string | undefined) => says(id, TARGET_WORDS);
  const date = (id: string): DateSource => ({ kind: "date", fieldId: id });
  const [a, b] = picked;
  if (a !== undefined && b === undefined)
    return targetish(a) && !startish(a)
      ? { start: null, target: date(a) }
      : { start: date(a), target: null };
  if (a !== undefined && b !== undefined) {
    const backwards =
      (startish(b) && !startish(a)) || (targetish(a) && !targetish(b));
    const forwards =
      (startish(a) && !startish(b)) || (targetish(b) && !targetish(a));
    return backwards && !forwards
      ? { start: date(b), target: date(a) }
      : { start: date(a), target: date(b) };
  }
  const iteration = fieldDefs.find((def) => def.kind === "iteration");
  if (iteration === undefined) return NO_DATE_SOURCES;
  const source: DateSource = { kind: "iteration", fieldId: iteration.id };
  return { start: source, target: source };
}

/** `sources` with any pick the definitions no longer carry (a deleted field, a
 *  capped read) read as no source — never re-seeded behind the user's back. */
export function resolveDateSources(
  sources: DateSources,
  fieldDefs: ProjectFieldDef[],
): DateSources {
  const live = (source: DateSource | null): DateSource | null =>
    source !== null &&
    fieldDefs.some(
      (def) => def.id === source.fieldId && def.kind === source.kind,
    )
      ? source
      : null;
  const start = live(sources.start);
  const target = live(sources.target);
  return start === sources.start && target === sources.target
    ? sources
    : { start, target };
}

/** Each iteration field's whole calendar, completed and active together, in
 *  start-date order. */
export function iterationCalendars(
  fieldDefs: ProjectFieldDef[],
): Map<string, ProjectIterationDef[]> {
  const calendars = new Map<string, ProjectIterationDef[]>();
  for (const def of fieldDefs)
    if (def.kind === "iteration")
      calendars.set(
        def.id,
        [...def.completedIterations, ...def.iterations]
          .filter((iteration) => isIsoDate(iteration.startDate))
          .toSorted((a, b) =>
            a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0,
          ),
      );
  return calendars;
}

/** Where one item sits on the timeline. `inverted` is a target before its start,
 *  drawn as it is rather than silently swapped. */
export type ItemSpan =
  | { kind: "bar"; start: string; end: string }
  | { kind: "point"; date: string }
  | { kind: "inverted"; start: string; end: string }
  | { kind: "none" };

function dateValueOf(item: BoardItem, fieldId: string): string | null {
  for (const value of item.fieldValues)
    if (value.kind === "date" && value.fieldId === fieldId)
      return isIsoDate(value.date) ? value.date : null;
  return null;
}

function iterationValueOf(
  item: BoardItem,
  fieldId: string,
): Extract<ProjectFieldValue, { kind: "iteration" }> | null {
  for (const value of item.fieldValues)
    if (value.kind === "iteration" && value.fieldId === fieldId) return value;
  return null;
}

/** An iteration's inclusive last day. A zero-length one still covers its start. */
function iterationEnd(iteration: ProjectIterationDef): string {
  return addDays(iteration.startDate, Math.max(iteration.duration, 1) - 1);
}

/** One end of a span: the date it names, null when unset, or `dangling` for an
 *  iteration value whose id the calendar no longer defines. */
function sideDate(
  item: BoardItem,
  source: DateSource | null,
  calendars: ReadonlyMap<string, ProjectIterationDef[]>,
  end: "start" | "end",
): string | null | "dangling" {
  if (source === null) return null;
  if (source.kind === "date") return dateValueOf(item, source.fieldId);
  const value = iterationValueOf(item, source.fieldId);
  if (value === null) return null;
  const iteration = calendars
    .get(source.fieldId)
    ?.find((entry) => entry.id === value.iterationId);
  if (iteration === undefined) return "dangling";
  return end === "start" ? iteration.startDate : iterationEnd(iteration);
}

/**
 * Where `item` sits under `sources`. An iteration end spans the iteration's own
 * days, its end inclusive. An iteration value whose id the calendar no longer
 * holds reads as NO dates: GitHub clears a deleted iteration's values, but a read
 * racing that deletion can still carry one.
 */
export function itemSpan(
  item: BoardItem,
  sources: DateSources,
  calendars: ReadonlyMap<string, ProjectIterationDef[]>,
): ItemSpan {
  const start = sideDate(item, sources.start, calendars, "start");
  const end = sideDate(item, sources.target, calendars, "end");
  if (start === "dangling" || end === "dangling") return { kind: "none" };
  if (start !== null && end !== null)
    return end < start
      ? { kind: "inverted", start, end }
      : { kind: "bar", start, end };
  if (start !== null) return { kind: "point", date: start };
  if (end !== null) return { kind: "point", date: end };
  return { kind: "none" };
}

/** Every date a span draws at. */
function spanDates(span: ItemSpan): string[] {
  switch (span.kind) {
    case "bar":
    case "inverted":
      return [span.start, span.end];
    case "point":
      return [span.date];
    default:
      return [];
  }
}

/** The earliest and latest drawn day, and whether the five-year cap cut the data
 *  short — which the lane says rather than hiding. */
export interface TimelineRange {
  min: string;
  max: string;
  clamped: boolean;
}

/**
 * The days the lane covers: the data's extent together with today, padded per
 * zoom — or, with no dated item at all, a window either side of today. Quarter
 * snaps to whole Monday-started weeks and Year to whole months, so the axis
 * opens on a boundary. Capped at {@link MAX_RANGE_DAYS} around today; spans past
 * the cap draw cut at the edge.
 */
export function timelineRange(
  spans: Iterable<ItemSpan>,
  todayISO: string,
  zoom: Zoom,
): TimelineRange {
  let lo = todayISO;
  let hi = todayISO;
  let dated = false;
  for (const span of spans)
    for (const date of spanDates(span)) {
      dated = true;
      if (date < lo) lo = date;
      if (date > hi) hi = date;
    }
  const pad = dated ? PAD_DAYS[zoom] : WINDOW_DAYS[zoom];
  lo = addDays(lo, -pad);
  hi = addDays(hi, pad);
  if (zoom === "quarter") {
    lo = addDays(lo, -((weekday(lo) + 6) % 7));
    hi = addDays(hi, (7 - weekday(hi)) % 7);
  } else if (zoom === "year") {
    lo = `${lo.slice(0, 7)}-01`;
    hi = addDays(firstOfNextMonth(hi), -1);
  }
  if (daysBetween(lo, hi) <= MAX_RANGE_DAYS)
    return { min: lo, max: hi, clamped: false };
  let start = addDays(todayISO, -Math.floor(MAX_RANGE_DAYS / 2));
  if (start < lo) start = lo;
  let end = addDays(start, MAX_RANGE_DAYS - 1);
  if (end > hi) {
    end = hi;
    start = addDays(hi, -(MAX_RANGE_DAYS - 1));
  }
  // Re-snapped INWARD, so the cap still opens and closes on a boundary without
  // growing past it; the uncapped edges are boundaries already, and today sits
  // far enough from a moved edge to stay inside.
  if (zoom === "quarter") {
    start = addDays(start, (8 - weekday(start)) % 7);
    end = addDays(end, -weekday(end));
  } else if (zoom === "year") {
    if (start.slice(8) !== "01") start = firstOfNextMonth(start);
    end = addDays(`${addDays(end, 1).slice(0, 7)}-01`, -1);
  }
  return { min: start, max: end, clamped: true };
}

function firstOfNextMonth(iso: string): string {
  const month = monthIndex(iso);
  const year = yearOf(iso) + (month === 11 ? 1 : 0);
  return `${String(year).padStart(4, "0")}-${String(((month + 1) % 12) + 1).padStart(2, "0")}-01`;
}

function firstOfNextYear(iso: string): string {
  return `${String(yearOf(iso) + 1).padStart(4, "0")}-01-01`;
}

/** One labelled stretch of an axis tier, as day offsets from the range start. */
export interface AxisSegment {
  key: string;
  label: string;
  /** Days from the range's first day. */
  offset: number;
  days: number;
  /** A week's first day on the day tier: drawn with a stronger rule. */
  emphasis: boolean;
}

/** Cut `min..max` at every boundary `next` names, labelling each piece. */
function segments(
  min: string,
  max: string,
  next: (day: string) => string,
  label: (day: string) => string,
  emphasis: (day: string) => boolean = () => false,
): AxisSegment[] {
  const out: AxisSegment[] = [];
  let day = min;
  while (day <= max) {
    const boundary = next(day);
    const last = addDays(boundary, -1);
    const end = last < max ? last : max;
    out.push({
      key: day,
      label: label(day),
      offset: dayOffset(day, min),
      days: daysBetween(day, end),
      emphasis: emphasis(day),
    });
    day = boundary;
  }
  return out;
}

/** Every month names its year: the lane draws each label stuck at the rail's
 *  edge while its month is in view, so the one on screen is the only one read. */
function monthLabel(day: string): string {
  return `${MONTH_NAMES[monthIndex(day)]} ${yearOf(day)}`;
}

/** The next Monday after `day`. */
function nextMonday(day: string): string {
  return addDays(day, 7 - ((weekday(day) + 6) % 7));
}

/**
 * The axis's two tiers. The top tier names months, each with its year; Year
 * zoom's top tier names the years themselves, since its lower tier is already
 * months. The lower tier is days at Month zoom (Mondays emphasized),
 * Monday-started weeks labelled by their Monday at Quarter, and months at Year.
 */
export function axisSegments(
  min: string,
  max: string,
  zoom: Zoom,
): { top: AxisSegment[]; bottom: AxisSegment[] } {
  const months = segments(min, max, firstOfNextMonth, monthLabel);
  switch (zoom) {
    case "month":
      return {
        top: months,
        bottom: segments(
          min,
          max,
          (day) => addDays(day, 1),
          (day) => String(Number(day.slice(8, 10))),
          (day) => weekday(day) === 1,
        ),
      };
    case "quarter":
      return {
        top: months,
        bottom: segments(min, max, nextMonday, (day) =>
          weekday(day) === 1 ? shortDate(day) : "",
        ),
      };
    default:
      return {
        top: segments(min, max, firstOfNextYear, (day) => String(yearOf(day))),
        bottom: segments(
          min,
          max,
          firstOfNextMonth,
          (day) => MONTH_NAMES[monthIndex(day)],
        ),
      };
  }
}

/** One iteration drawn behind the rows, clipped to the range. `current` is the
 *  iteration today falls in. */
export interface IterationBand {
  id: string;
  title: string;
  start: string;
  end: string;
  offset: number;
  days: number;
  current: boolean;
}

export function iterationBands(
  calendar: readonly ProjectIterationDef[],
  range: { min: string; max: string },
  todayISO: string,
): IterationBand[] {
  const bands: IterationBand[] = [];
  for (const iteration of calendar) {
    const start = iteration.startDate;
    const end = iterationEnd(iteration);
    if (end < range.min || start > range.max) continue;
    const from = start < range.min ? range.min : start;
    const to = end > range.max ? range.max : end;
    bands.push({
      id: iteration.id,
      title: iteration.title,
      start,
      end,
      offset: dayOffset(from, range.min),
      days: daysBetween(from, to),
      current: start <= todayISO && todayISO <= end,
    });
  }
  return bands;
}

/** One milestone due date on the timeline. Several milestones due the same day
 *  share one marker, which names them all in `titles`. */
export interface MilestoneMarker {
  date: string;
  offset: number;
  titles: string[];
  label: string;
}

/** A milestone value's due DAY, or null where it has none GitHub gave or none
 *  that parses. `dueOn` is a timestamp; its UTC calendar day is the date
 *  GitHub's own due date names. */
function milestoneDueDate(value: ProjectFieldValue): string | null {
  if (value.kind !== "milestone" || typeof value.dueOn !== "string")
    return null;
  const date = value.dueOn.slice(0, 10);
  return isIsoDate(date) ? date : null;
}

/** The distinct milestone due dates the items carry, inside the range. A
 *  milestone with no due date draws no marker. */
export function milestoneMarkers(
  items: Iterable<BoardItem>,
  range: { min: string; max: string },
): MilestoneMarker[] {
  const byDate = new Map<string, Set<string>>();
  for (const item of items)
    for (const value of item.fieldValues) {
      const date = milestoneDueDate(value);
      if (date === null || value.kind !== "milestone") continue;
      if (date < range.min || date > range.max) continue;
      const titles = byDate.get(date) ?? new Set<string>();
      titles.add(value.title === "" ? "Untitled milestone" : value.title);
      byDate.set(date, titles);
    }
  return [...byDate.entries()]
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, set]) => {
      const titles = [...set];
      return {
        date,
        offset: dayOffset(date, range.min),
        titles,
        label: titles.length === 1 ? titles[0] : `${titles.length} milestones`,
      };
    });
}

/** Both ends moved by `deltaDays`; an unset end stays unset. */
export function shiftDates(
  dates: { start: string | null; target: string | null },
  deltaDays: number,
): { start: string | null; target: string | null } {
  return {
    start: dates.start === null ? null : addDays(dates.start, deltaDays),
    target: dates.target === null ? null : addDays(dates.target, deltaDays),
  };
}

/** The iteration before (`-1`) or after (`1`) `currentId` in `calendar`, or null
 *  at either end — the calendar doesn't wrap — and for an id it doesn't hold. */
export function adjacentIteration(
  calendar: readonly ProjectIterationDef[],
  currentId: string,
  dir: -1 | 1,
): ProjectIterationDef | null {
  const at = calendar.findIndex((iteration) => iteration.id === currentId);
  if (at === -1) return null;
  return calendar[at + dir] ?? null;
}

export const SET_DATES_FIRST_REASON = "Set dates first";
export const TARGET_BEFORE_START_REASON = "Target can't precede start";
export const ITERATION_RESIZE_REASON =
  "Dates from an iteration field can't be resized";
export const FIRST_ITERATION_REASON = "Already in the first iteration";
export const LAST_ITERATION_REASON = "Already in the last iteration";
export const MIXED_SOURCES_REASON =
  "Dates from an iteration and a date field can't shift together";
export const NO_TARGET_REASON = "Pick a target field to resize";
export const SAME_FIELD_REASON =
  "Pick different start and target fields to resize";

/** What a shift chord does: the field values it writes (and the span they draw),
 *  or why it can't. */
export type ShiftPlan =
  | { kind: "held"; reason: string }
  | { kind: "write"; values: ProjectFieldValue[]; span: ItemSpan };

/** `values` with each of `next` replacing the entry for its field in place, or
 *  appended where the item held none — so a row's other values keep their order. */
export function withFieldValues(
  values: ProjectFieldValue[],
  next: ProjectFieldValue[],
): ProjectFieldValue[] {
  const byField = new Map(
    next.flatMap((value) =>
      value.kind === "unknown" ? [] : [[value.fieldId, value] as const],
    ),
  );
  const seen = new Set<string>();
  const kept = values.map((value) => {
    if (value.kind === "unknown") return value;
    const replacement = byField.get(value.fieldId);
    if (replacement === undefined) return value;
    seen.add(value.fieldId);
    return replacement;
  });
  return [
    ...kept,
    ...[...byField.entries()]
      .filter(([fieldId]) => !seen.has(fieldId))
      .map(([, value]) => value),
  ];
}

/**
 * What one date-shift chord writes for `item`. `move` shifts every end one day
 * (an iteration end steps to the adjacent iteration); `resize` moves the target
 * alone. Held, with the reason the chord answers, where the write can't be
 * formed: no dates, a calendar end, a target that would cross its start, or
 * sources a single step can't move together.
 */
export function planShift(
  item: BoardItem,
  sources: DateSources,
  fieldDefs: ProjectFieldDef[],
  calendars: ReadonlyMap<string, ProjectIterationDef[]>,
  mode: "move" | "resize",
  dir: -1 | 1,
): ShiftPlan {
  const held = (reason: string): ShiftPlan => ({ kind: "held", reason });
  if (itemSpan(item, sources, calendars).kind === "none")
    return held(SET_DATES_FIRST_REASON);
  const { start, target } = sources;
  const defOf = (fieldId: string) =>
    fieldDefs.find((def) => def.id === fieldId);
  const kinds = new Set(
    [start?.kind, target?.kind].filter((kind) => kind !== undefined),
  );
  if (kinds.size > 1) return held(MIXED_SOURCES_REASON);
  const values: ProjectFieldValue[] = [];
  if (kinds.has("iteration")) {
    if (mode === "resize") return held(ITERATION_RESIZE_REASON);
    const fieldIds = [
      ...new Set(
        [start?.fieldId, target?.fieldId].filter((id) => id !== undefined),
      ),
    ];
    for (const fieldId of fieldIds) {
      const current = iterationValueOf(item, fieldId);
      const def = defOf(fieldId);
      if (current === null || def === undefined) continue;
      const next = adjacentIteration(
        calendars.get(fieldId) ?? [],
        current.iterationId,
        dir,
      );
      if (next === null)
        return held(dir < 0 ? FIRST_ITERATION_REASON : LAST_ITERATION_REASON);
      values.push({
        kind: "iteration",
        fieldId,
        fieldName: def.name,
        iterationId: next.id,
        title: next.title,
        startDate: next.startDate,
        duration: next.duration,
        isIssueField: false,
      });
    }
  } else {
    const dateValue = (fieldId: string, date: string): ProjectFieldValue => {
      const def = defOf(fieldId);
      return {
        kind: "date",
        fieldId,
        fieldName: def?.name ?? "",
        date,
        isIssueField: def?.kind === "date" ? def.isIssueField : false,
      };
    };
    const startDate = start === null ? null : dateValueOf(item, start.fieldId);
    const targetDate =
      target === null ? null : dateValueOf(item, target.fieldId);
    if (mode === "move") {
      const moved = shiftDates({ start: startDate, target: targetDate }, dir);
      if (start !== null && moved.start !== null)
        values.push(dateValue(start.fieldId, moved.start));
      if (
        target !== null &&
        moved.target !== null &&
        target.fieldId !== start?.fieldId
      )
        values.push(dateValue(target.fieldId, moved.target));
    } else {
      if (target === null) return held(NO_TARGET_REASON);
      if (target.fieldId === start?.fieldId) return held(SAME_FIELD_REASON);
      const base = targetDate ?? startDate;
      if (base === null) return held(SET_DATES_FIRST_REASON);
      const next = addDays(base, dir);
      if (dir < 0 && startDate !== null && next < startDate)
        return held(TARGET_BEFORE_START_REASON);
      values.push(dateValue(target.fieldId, next));
    }
  }
  if (values.length === 0) return held(SET_DATES_FIRST_REASON);
  const moved = {
    ...item,
    fieldValues: withFieldValues(item.fieldValues, values),
  };
  return { kind: "write", values, span: itemSpan(moved, sources, calendars) };
}

/** The narrowest a bar draws, so a one-day bar at Year zoom stays visible. */
export const MIN_BAR_PX = 6;

/**
 * Where a `from`..`to` span draws on a lane of `days` days, in pixels. Both ends
 * clamp into the lane, so a span wholly outside the range pins to the edge it
 * passed at the minimum width rather than drawing past the lane's end; `cutStart`
 * and `cutEnd` say which edge it runs past.
 */
export function laneBox(
  from: string,
  to: string,
  range: { min: string; max: string },
  days: number,
  pxPerDay: number,
): { left: number; width: number; cutStart: boolean; cutEnd: boolean } {
  const clampDay = (day: number) => Math.min(Math.max(day, 0), days);
  const startDay = clampDay(dayOffset(from, range.min));
  const endDay = clampDay(dayOffset(to, range.min) + 1);
  const width = Math.max((endDay - startDay) * pxPerDay, MIN_BAR_PX);
  return {
    left: Math.max(Math.min(startDay * pxPerDay, days * pxPerDay - width), 0),
    width,
    cutStart: from < range.min,
    cutEnd: to > range.max,
  };
}

/** The x of `date`'s middle on the lane, clamped to its first and last day. */
export function dayCenterPx(
  date: string,
  range: { min: string },
  days: number,
  pxPerDay: number,
): number {
  const offset = Math.min(Math.max(dayOffset(date, range.min), 0), days - 1);
  return (offset + 0.5) * pxPerDay;
}

/** One label on the marker strip's point row: the x of its mark, and the width
 *  it would take whole. A `pinned` label is never cut (today's). */
export interface StripLabel {
  key: string;
  x: number;
  width: number;
  pinned?: boolean;
}

/** The narrowest a cut label draws, so it still shows a letter or two. */
const MIN_LABEL_PX = 24;
const LABEL_GAP_PX = 4;

/**
 * The strip's point labels laid out along one row without overlapping: each
 * starts at its mark, or just past the label before it. One that would run into
 * the next is cut to the gap (its full text stays in its title) — except a
 * pinned label, which keeps its width and pushes the next one along. The last
 * label shifts left rather than run off the lane's end.
 */
export function layoutStripLabels(
  labels: readonly StripLabel[],
  laneWidth: number,
): { key: string; left: number; maxWidth: number }[] {
  const sorted = labels.toSorted((a, b) => a.x - b.x);
  const placed: { key: string; left: number; maxWidth: number }[] = [];
  let edge = 0;
  for (const [i, label] of sorted.entries()) {
    let left = Math.max(label.x, edge);
    const next = sorted[i + 1];
    const room =
      (next === undefined ? laneWidth : next.x) - left - LABEL_GAP_PX;
    const maxWidth = label.pinned
      ? label.width
      : Math.min(label.width, Math.max(room, MIN_LABEL_PX));
    if (left + maxWidth > laneWidth)
      left = Math.max(laneWidth - maxWidth, edge);
    placed.push({ key: label.key, left, maxWidth });
    edge = left + maxWidth + LABEL_GAP_PX;
  }
  return placed;
}

/** Everything the roadmap draws besides its rows, derived once per render. */
export interface RoadmapTimeline {
  zoom: Zoom;
  pxPerDay: number;
  todayISO: string;
  range: TimelineRange;
  /** Days the lane covers, both ends included. */
  days: number;
  axis: { top: AxisSegment[]; bottom: AxisSegment[] };
  bands: IterationBand[];
  markers: MilestoneMarker[];
}

/** The timeline over `items`. Its iteration bands come from the iteration field
 *  the dates are sourced from, else the project's first iteration field, so a
 *  roadmap placed by date fields still shows the sprints it runs through. */
export function roadmapTimeline(
  items: readonly BoardItem[],
  sources: DateSources,
  calendars: ReadonlyMap<string, ProjectIterationDef[]>,
  todayISO: string,
  zoom: Zoom,
): RoadmapTimeline {
  // Milestone due dates are data too: the range spans them, so a marker is
  // never dropped for falling past the items' own dates.
  const spans: ItemSpan[] = items.map((item) =>
    itemSpan(item, sources, calendars),
  );
  for (const item of items)
    for (const value of item.fieldValues) {
      const date = milestoneDueDate(value);
      if (date !== null) spans.push({ kind: "point", date });
    }
  const range = timelineRange(spans, todayISO, zoom);
  const bandField =
    [sources.start, sources.target].find(
      (source) => source?.kind === "iteration",
    )?.fieldId ?? calendars.keys().next().value;
  return {
    zoom,
    pxPerDay: PX_PER_DAY[zoom],
    todayISO,
    range,
    days: daysBetween(range.min, range.max),
    axis: axisSegments(range.min, range.max, zoom),
    bands:
      bandField === undefined
        ? []
        : iterationBands(calendars.get(bandField) ?? [], range, todayISO),
    markers: milestoneMarkers(items, range),
  };
}

/** A span in words — the lane's accessible name and the shift announcement. */
export function spanText(span: ItemSpan, todayISO: string): string {
  const year = yearOf(todayISO);
  switch (span.kind) {
    case "bar":
      return span.start === span.end
        ? shortDate(span.start, year)
        : `${shortDate(span.start, year)} to ${shortDate(span.end, year)}`;
    case "point":
      return shortDate(span.date, year);
    case "inverted":
      return `Dates reversed: starts ${shortDate(span.start, year)}, targets ${shortDate(span.end, year)}`;
    default:
      return "No dates";
  }
}
