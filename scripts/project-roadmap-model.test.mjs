// Pins the roadmap layout's pure model: which fields a roadmap view seeds its
// dates from, where each item lands, the axis and markers, and what a keyboard
// date shift writes. A wrong answer here draws a bar on the wrong day or writes
// the wrong date to GitHub, and neither fails loudly — so each arm is a case.
//
// The import below reaches straight into `src/` and relies on Node's default type
// stripping (>= 23.6), which resolves no bundler aliases: `roadmap-model.ts` must
// hold type-only imports alone. A runtime import added there fails this file.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addDays,
  adjacentIteration,
  axisSegments,
  dayCenterPx,
  dayOffset,
  daysBetween,
  FIRST_ITERATION_REASON,
  ITERATION_RESIZE_REASON,
  isIsoDate,
  itemSpan,
  iterationBands,
  iterationCalendars,
  LAST_ITERATION_REASON,
  laneBox,
  layoutStripLabels,
  localDateISO,
  MAX_RANGE_DAYS,
  MIN_BAR_PX,
  MIXED_SOURCES_REASON,
  milestoneMarkers,
  NO_TARGET_REASON,
  planShift,
  resolveDateSources,
  roadmapTimeline,
  SAME_FIELD_REASON,
  SET_DATES_FIRST_REASON,
  seedDateSources,
  shiftDates,
  spanText,
  TARGET_BEFORE_START_REASON,
  timelineRange,
  withFieldValues,
} from "../src/features/projects/roadmap-model.ts";

const START = { kind: "date", id: "start", name: "Start", isIssueField: false };
const TARGET = {
  kind: "date",
  id: "target",
  name: "Target",
  isIssueField: false,
};
const SPRINT = {
  kind: "iteration",
  id: "sprint",
  name: "Sprint",
  iterations: [
    { id: "s2", title: "Sprint 2", startDate: "2026-09-21", duration: 14 },
    { id: "s3", title: "Sprint 3", startDate: "2026-10-05", duration: 14 },
  ],
  completedIterations: [
    { id: "s1", title: "Sprint 1", startDate: "2026-09-07", duration: 14 },
  ],
};
const STATUS = {
  kind: "singleSelect",
  id: "status",
  name: "Status",
  options: [],
  isIssueField: false,
};
const TITLE = { kind: "system", id: "title", name: "Title", dataType: "TITLE" };

const view = (visibleFieldIds) => ({
  id: "v",
  name: "Roadmap",
  layout: "roadmap",
  filter: null,
  groupFieldIds: [],
  verticalGroupFieldIds: [],
  sortBy: [],
  visibleFieldIds,
});

const date = (fieldId, value) => ({
  kind: "date",
  fieldId,
  fieldName: fieldId,
  date: value,
  isIssueField: false,
});
const iter = (iterationId) => ({
  kind: "iteration",
  fieldId: "sprint",
  fieldName: "Sprint",
  iterationId,
  title: iterationId,
  startDate: "2026-01-01",
  duration: 14,
  isIssueField: false,
});
const item = (...fieldValues) => ({
  itemId: "item",
  isArchived: false,
  content: { kind: "redacted" },
  fieldValues,
  addedAt: "2026-09-01T00:00:00Z",
});

const DATES = {
  start: { kind: "date", fieldId: "start" },
  target: { kind: "date", fieldId: "target" },
};
const ITERATIONS = {
  start: { kind: "iteration", fieldId: "sprint" },
  target: { kind: "iteration", fieldId: "sprint" },
};
const DEFS = [TITLE, STATUS, START, TARGET, SPRINT];
const CALENDARS = iterationCalendars(DEFS);
const TODAY = "2026-09-24";

test("seeding: the view's visible date fields come first, oriented by name", () => {
  // Target listed before Start still seeds Start as the start.
  assert.deepEqual(
    seedDateSources(view(["title", "target", "start"]), DEFS),
    DATES,
  );
  // A repeated id is one field.
  assert.deepEqual(
    seedDateSources(view(["start", "start", "status"]), DEFS).target,
    { kind: "date", fieldId: "target" },
  );
});

test("seeding: short of two visible dates, the project's own fill in", () => {
  // Only Target shown: Start fills in from the project, and goes first.
  assert.deepEqual(seedDateSources(view(["target"]), DEFS), DATES);
  assert.deepEqual(seedDateSources(view([]), DEFS), DATES);
});

const dateDef = (id, name) => ({ kind: "date", id, name, isIssueField: false });

test("seeding: orientation reads each end's words, and neutral names keep order", () => {
  const due = dateDef("due", "Due date");
  const begin = dateDef("begin", "Begin");
  const kickoff = dateDef("kickoff", "Kickoff");
  const ship = dateDef("ship", "Ship");
  const pair = (s, t) => ({
    start: { kind: "date", fieldId: s },
    target: { kind: "date", fieldId: t },
  });
  // An end-worded field first, a start-worded one second: swapped.
  assert.deepEqual(
    seedDateSources(view([]), [due, begin]),
    pair("begin", "due"),
  );
  // One side's word alone decides: Due first beside a neutral name moves last.
  assert.deepEqual(
    seedDateSources(view([]), [due, kickoff]),
    pair("kickoff", "due"),
  );
  assert.deepEqual(
    seedDateSources(view([]), [kickoff, begin]),
    pair("begin", "kickoff"),
  );
  // Neutral names keep the view's order, then the definitions'.
  assert.deepEqual(
    seedDateSources(view(["ship", "kickoff"]), [kickoff, ship]),
    pair("ship", "kickoff"),
  );
  assert.deepEqual(
    seedDateSources(view([]), [kickoff, ship]),
    pair("kickoff", "ship"),
  );
  // Both ends claimed by both names: ambiguous, so order stands.
  const both1 = dateDef("x", "Start to end");
  const both2 = dateDef("y", "Start or end");
  assert.deepEqual(seedDateSources(view([]), [both1, both2]), pair("x", "y"));
  // One side both backwards AND forwards (it says start and end): the
  // conflict keeps the order rather than swapping.
  assert.deepEqual(
    seedDateSources(view([]), [kickoff, both1]),
    pair("kickoff", "x"),
  );
  // A word inside another word is not that word.
  const weekend = dateDef("weekend", "Weekend");
  const restart = dateDef("restart", "Restart");
  for (const inner of [weekend, restart])
    assert.deepEqual(
      seedDateSources(view([]), [inner, kickoff]),
      pair(inner.id, "kickoff"),
    );
  // Plural and verb forms orient like the base words.
  const ends = dateDef("ends", "Ends");
  const starts = dateDef("starts", "Starts");
  assert.deepEqual(
    seedDateSources(view([]), [ends, starts]),
    pair("starts", "ends"),
  );
  const finished = dateDef("finished", "Finished");
  const started = dateDef("started", "Started");
  assert.deepEqual(
    seedDateSources(view([]), [finished, started]),
    pair("started", "finished"),
  );
  // API-created spellings split into words too: snake, SCREAMING and camel case.
  for (const [s, t] of [
    ["start_date", "due_date"],
    ["START_DATE", "DUE_DATE"],
    ["startDate", "dueDate"],
    ["StartDate", "TargetDate"],
  ])
    assert.deepEqual(
      seedDateSources(view([]), [dateDef("t", t), dateDef("s", s)]),
      pair("s", "t"),
      `${s} / ${t}`,
    );
});

test("seeding: one date field places points; none falls to an iteration", () => {
  assert.deepEqual(seedDateSources(view([]), [TITLE, START, SPRINT]), {
    start: { kind: "date", fieldId: "start" },
    target: null,
  });
  // A lone end-worded field is the target end, so a resize moves it.
  assert.deepEqual(seedDateSources(view([]), [TITLE, TARGET]), {
    start: null,
    target: { kind: "date", fieldId: "target" },
  });
  assert.deepEqual(seedDateSources(view([]), [TITLE, SPRINT]), ITERATIONS);
  assert.deepEqual(seedDateSources(view(["status"]), [TITLE, STATUS]), {
    start: null,
    target: null,
  });
  assert.deepEqual(seedDateSources(view([]), []), {
    start: null,
    target: null,
  });
});

test("a pick the definitions no longer carry reads as no source", () => {
  assert.equal(resolveDateSources(DATES, DEFS), DATES);
  assert.deepEqual(resolveDateSources(DATES, [START]), {
    start: DATES.start,
    target: null,
  });
  // The same id under another kind is not that field.
  assert.deepEqual(
    resolveDateSources(
      { start: { kind: "iteration", fieldId: "start" }, target: null },
      DEFS,
    ),
    { start: null, target: null },
  );
});

test("span kinds: bar, point either end, inverted, none", () => {
  const span = (...values) => itemSpan(item(...values), DATES, CALENDARS);
  assert.deepEqual(
    span(date("start", "2026-09-21"), date("target", "2026-10-04")),
    {
      kind: "bar",
      start: "2026-09-21",
      end: "2026-10-04",
    },
  );
  assert.deepEqual(
    span(date("start", "2026-09-21"), date("target", "2026-09-21")),
    {
      kind: "bar",
      start: "2026-09-21",
      end: "2026-09-21",
    },
  );
  assert.deepEqual(span(date("start", "2026-09-21")), {
    kind: "point",
    date: "2026-09-21",
  });
  assert.deepEqual(span(date("target", "2026-10-03")), {
    kind: "point",
    date: "2026-10-03",
  });
  assert.deepEqual(
    span(date("start", "2026-10-05"), date("target", "2026-09-30")),
    {
      kind: "inverted",
      start: "2026-10-05",
      end: "2026-09-30",
    },
  );
  assert.deepEqual(span(), { kind: "none" });
  // A value that isn't a real calendar day is no value.
  assert.deepEqual(span(date("start", "2026-02-30")), { kind: "none" });
  assert.deepEqual(
    itemSpan(
      item(date("start", "2026-09-21")),
      { start: null, target: null },
      CALENDARS,
    ),
    { kind: "none" },
  );
});

test("span kinds: an iteration spans its own days, and a deleted one is none", () => {
  assert.deepEqual(itemSpan(item(iter("s2")), ITERATIONS, CALENDARS), {
    kind: "bar",
    start: "2026-09-21",
    end: "2026-10-04",
  });
  assert.deepEqual(itemSpan(item(iter("gone")), ITERATIONS, CALENDARS), {
    kind: "none",
  });
  const zero = iterationCalendars([
    {
      ...SPRINT,
      iterations: [
        { id: "z", title: "Z", startDate: "2026-09-21", duration: 0 },
      ],
      completedIterations: [],
    },
  ]);
  assert.deepEqual(itemSpan(item(iter("z")), ITERATIONS, zero), {
    kind: "bar",
    start: "2026-09-21",
    end: "2026-09-21",
  });
});

test("calendars merge completed and active iterations in start order", () => {
  assert.deepEqual(
    CALENDARS.get("sprint").map((i) => i.id),
    ["s1", "s2", "s3"],
  );
  assert.equal(CALENDARS.has("start"), false);
});

test("day math: offsets across month, year and leap-day boundaries", () => {
  assert.equal(dayOffset("2026-02-01", "2026-01-31"), 1);
  assert.equal(dayOffset("2027-01-01", "2026-12-31"), 1);
  assert.equal(dayOffset("2028-03-01", "2028-02-28"), 2);
  assert.equal(dayOffset("2026-03-01", "2026-02-28"), 1);
  assert.equal(dayOffset("2026-09-21", "2026-10-04"), -13);
  assert.equal(daysBetween("2026-09-21", "2026-10-04"), 14);
  assert.equal(daysBetween("2026-09-21", "2026-09-21"), 1);
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
});

test("day math: years before 100 are real years, not 19xx", () => {
  for (const early of ["0001-01-01", "0099-12-31", "0100-01-01", "0004-02-29"])
    assert.equal(isIsoDate(early), true, early);
  assert.equal(addDays("0099-12-31", 1), "0100-01-01");
  assert.equal(dayOffset("0100-01-01", "0099-12-31"), 1);
  // 1900 is no leap year, so a 0-99 mapped to 19xx would have failed this.
  assert.equal(isIsoDate("0000-02-29"), true);
  assert.equal(isIsoDate("0001-02-29"), false);
});

test("day math: only real bare dates count", () => {
  assert.equal(isIsoDate("2028-02-29"), true);
  for (const bad of [
    "2026-02-29",
    "2026-13-01",
    "2026-9-01",
    "2026-09-21T00:00:00Z",
    "",
    null,
    20260921,
  ])
    assert.equal(isIsoDate(bad), false, String(bad));
});

test("today is the local calendar day", () => {
  assert.equal(
    localDateISO(new Date(2026, 8, 24, 23, 59).getTime()),
    "2026-09-24",
  );
  assert.equal(
    localDateISO(new Date(2027, 0, 1, 0, 0).getTime()),
    "2027-01-01",
  );
});

const bar = (start, end) => ({ kind: "bar", start, end });

test("range: the data and today, padded per zoom", () => {
  const spans = [bar("2026-09-21", "2026-10-04"), { kind: "none" }];
  assert.deepEqual(timelineRange(spans, TODAY, "month"), {
    min: "2026-09-14",
    max: "2026-10-11",
    clamped: false,
  });
  // Today outside the data still draws.
  assert.deepEqual(
    timelineRange([bar("2026-11-01", "2026-11-02")], TODAY, "month"),
    {
      min: "2026-09-17",
      max: "2026-11-09",
      clamped: false,
    },
  );
});

test("range: Quarter snaps to whole weeks, Year to whole months", () => {
  assert.deepEqual(
    timelineRange([bar("2026-09-23", "2026-10-01")], TODAY, "quarter"),
    {
      min: "2026-08-31",
      max: "2026-10-25",
      clamped: false,
    },
  );
  assert.deepEqual(
    timelineRange([bar("2026-09-21", "2026-10-04")], TODAY, "year"),
    {
      min: "2026-08-01",
      max: "2026-11-30",
      clamped: false,
    },
  );
});

test("range: nothing dated is a window around today", () => {
  assert.deepEqual(timelineRange([], TODAY, "month"), {
    min: "2026-08-24",
    max: "2026-10-25",
    clamped: false,
  });
  assert.deepEqual(timelineRange([{ kind: "none" }], TODAY, "month"), {
    min: "2026-08-24",
    max: "2026-10-25",
    clamped: false,
  });
});

test("range: past five years the lane is capped around today, and says so", () => {
  const wide = timelineRange(
    [
      { kind: "point", date: "2016-01-01" },
      { kind: "point", date: "2040-01-01" },
    ],
    TODAY,
    "month",
  );
  assert.equal(wide.clamped, true);
  assert.equal(daysBetween(wide.min, wide.max), MAX_RANGE_DAYS);
  assert.ok(wide.min <= TODAY && TODAY <= wide.max);
  // Near the data's own edge the cap keeps that edge rather than empty days.
  const edge = timelineRange(
    [
      { kind: "point", date: "2026-09-01" },
      { kind: "point", date: "2040-01-01" },
    ],
    TODAY,
    "month",
  );
  assert.equal(edge.min, "2026-08-25");
  assert.equal(daysBetween(edge.min, edge.max), MAX_RANGE_DAYS);
  // Exactly at the cap is not clamped.
  const exact = timelineRange(
    [
      { kind: "point", date: addDays("2026-09-01", 7) },
      { kind: "point", date: addDays("2026-09-01", 7 + MAX_RANGE_DAYS - 15) },
    ],
    "2026-09-10",
    "month",
  );
  assert.equal(daysBetween(exact.min, exact.max), MAX_RANGE_DAYS);
  assert.equal(exact.clamped, false);
});

test("range: a capped Quarter or Year still opens and closes on a boundary", () => {
  const spans = [
    { kind: "point", date: "2016-01-01" },
    { kind: "point", date: "2040-01-01" },
  ];
  const quarter = timelineRange(spans, TODAY, "quarter");
  assert.equal(quarter.clamped, true);
  assert.equal(new Date(`${quarter.min}T00:00:00Z`).getUTCDay(), 1);
  assert.equal(new Date(`${quarter.max}T00:00:00Z`).getUTCDay(), 0);
  assert.ok(daysBetween(quarter.min, quarter.max) <= MAX_RANGE_DAYS);
  assert.ok(quarter.min <= TODAY && TODAY <= quarter.max);
  const year = timelineRange(spans, TODAY, "year");
  assert.equal(year.clamped, true);
  assert.equal(year.min.slice(8), "01");
  assert.equal(addDays(year.max, 1).slice(8), "01");
  assert.ok(daysBetween(year.min, year.max) <= MAX_RANGE_DAYS);
  assert.ok(year.min <= TODAY && TODAY <= year.max);
  // Capped at the data's own edge, which is a boundary already.
  const edge = timelineRange(
    [
      { kind: "point", date: "2026-09-01" },
      { kind: "point", date: "2040-01-01" },
    ],
    TODAY,
    "year",
  );
  assert.equal(edge.min, "2026-07-01");
  assert.equal(addDays(edge.max, 1).slice(8), "01");
});

test("lane geometry: spans inside, cut at one edge, and wholly outside", () => {
  const range = { min: "2026-09-14", max: "2026-10-11" };
  const days = 28;
  const px = 32;
  assert.deepEqual(laneBox("2026-09-21", "2026-10-04", range, days, px), {
    left: 7 * px,
    width: 14 * px,
    cutStart: false,
    cutEnd: false,
  });
  assert.deepEqual(laneBox("2026-09-01", "2026-09-15", range, days, px), {
    left: 0,
    width: 2 * px,
    cutStart: true,
    cutEnd: false,
  });
  // Wholly past the range: pinned to the right edge, never past the lane.
  const after = laneBox("2027-03-01", "2027-03-05", range, days, px);
  assert.deepEqual(after, {
    left: days * px - MIN_BAR_PX,
    width: MIN_BAR_PX,
    cutStart: false,
    cutEnd: true,
  });
  assert.ok(after.left + after.width <= days * px);
  // Wholly before it: pinned to the left edge.
  assert.deepEqual(laneBox("2025-01-01", "2025-01-02", range, days, px), {
    left: 0,
    width: MIN_BAR_PX,
    cutStart: true,
    cutEnd: false,
  });
  // A one-day bar at Year zoom keeps the minimum width.
  assert.equal(
    laneBox("2026-09-21", "2026-09-21", range, days, 2).width,
    MIN_BAR_PX,
  );
  assert.equal(dayCenterPx("2026-09-14", range, days, px), 16);
  assert.equal(dayCenterPx("2030-01-01", range, days, px), 27.5 * px);
  assert.equal(dayCenterPx("2020-01-01", range, days, px), 16);
});

const covered = (segs) => segs.reduce((n, seg) => n + seg.days, 0);

test("axis at Month: months over days, Mondays emphasized, year at January", () => {
  const { top, bottom } = axisSegments("2026-12-30", "2027-01-05", "month");
  assert.deepEqual(
    top.map((s) => [s.label, s.offset, s.days]),
    [
      ["Dec 2026", 0, 2],
      ["Jan 2027", 2, 5],
    ],
  );
  assert.equal(bottom.length, 7);
  assert.deepEqual(
    bottom.map((s) => s.label),
    ["30", "31", "1", "2", "3", "4", "5"],
  );
  assert.deepEqual(
    bottom.filter((s) => s.emphasis).map((s) => s.key),
    ["2027-01-04"],
  );
  assert.equal(covered(top), 7);
  // Every month names its year: its label is the one read while it's on screen.
  const mid = axisSegments("2026-09-14", "2026-10-11", "month").top;
  assert.deepEqual(
    mid.map((s) => s.label),
    ["Sep 2026", "Oct 2026"],
  );
});

test("axis at Quarter: weeks labelled by their Monday", () => {
  const { top, bottom } = axisSegments("2026-08-31", "2026-10-25", "quarter");
  assert.deepEqual(
    top.map((s) => s.label),
    ["Aug 2026", "Sep 2026", "Oct 2026"],
  );
  assert.equal(bottom.length, 8);
  assert.deepEqual(
    bottom.slice(0, 2).map((s) => [s.label, s.days]),
    [
      ["Aug 31", 7],
      ["Sep 7", 7],
    ],
  );
  assert.equal(covered(bottom), daysBetween("2026-08-31", "2026-10-25"));
  // A range opening mid-week leaves its partial week unlabelled.
  assert.equal(
    axisSegments("2026-09-24", "2026-10-04", "quarter").bottom[0].label,
    "",
  );
});

test("axis at Year: years over months, across the rollover", () => {
  const { top, bottom } = axisSegments("2026-11-01", "2027-02-28", "year");
  assert.deepEqual(
    top.map((s) => [s.label, s.days]),
    [
      ["2026", 61],
      ["2027", 59],
    ],
  );
  assert.deepEqual(
    bottom.map((s) => s.label),
    ["Nov", "Dec", "Jan", "Feb"],
  );
  assert.equal(covered(bottom), covered(top));
});

test("iteration bands clip to the range and mark today's", () => {
  const bands = iterationBands(
    CALENDARS.get("sprint"),
    { min: "2026-09-14", max: "2026-10-11" },
    TODAY,
  );
  assert.deepEqual(
    bands.map((b) => [b.id, b.offset, b.days, b.current]),
    [
      ["s1", 0, 7, false],
      ["s2", 7, 14, true],
      ["s3", 21, 7, false],
    ],
  );
  // The band keeps its own dates even where the drawing is clipped.
  assert.equal(bands[0].start, "2026-09-07");
  assert.deepEqual(
    iterationBands(
      CALENDARS.get("sprint"),
      { min: "2027-01-01", max: "2027-02-01" },
      TODAY,
    ),
    [],
  );
  assert.deepEqual(
    iterationBands([], { min: "2026-01-01", max: "2026-12-31" }, TODAY),
    [],
  );
});

const milestone = (title, dueOn) => ({
  kind: "milestone",
  fieldId: "m",
  fieldName: "Milestone",
  title,
  ...(dueOn === undefined ? {} : { dueOn }),
  isIssueField: false,
});

test("milestone markers: one per due date, several on a day share one", () => {
  const items = [
    item(milestone("v1.0", "2026-10-05T07:00:00Z")),
    item(milestone("v1.0", "2026-10-05T07:00:00Z")),
    item(milestone("Beta", "2026-10-05T00:00:00Z")),
    item(milestone("Alpha", "2026-09-30T07:00:00Z")),
    item(milestone("Someday")),
    item(milestone("Late", "2027-06-01T00:00:00Z")),
    item(milestone("Broken", "not a date")),
  ];
  const markers = milestoneMarkers(items, {
    min: "2026-09-14",
    max: "2026-10-11",
  });
  assert.deepEqual(
    markers.map((m) => [m.date, m.offset, m.label, m.titles]),
    [
      ["2026-09-30", 16, "Alpha", ["Alpha"]],
      ["2026-10-05", 21, "2 milestones", ["v1.0", "Beta"]],
    ],
  );
  assert.deepEqual(
    milestoneMarkers([], { min: "2026-09-14", max: "2026-10-11" }),
    [],
  );
});

test("a shift moves both ends across a month boundary; unset stays unset", () => {
  assert.deepEqual(
    shiftDates({ start: "2026-09-30", target: "2026-10-31" }, 1),
    {
      start: "2026-10-01",
      target: "2026-11-01",
    },
  );
  assert.deepEqual(shiftDates({ start: null, target: "2026-10-01" }, -1), {
    start: null,
    target: "2026-09-30",
  });
});

test("adjacent iterations stop at the calendar's ends", () => {
  const cal = CALENDARS.get("sprint");
  assert.equal(adjacentIteration(cal, "s2", 1).id, "s3");
  assert.equal(adjacentIteration(cal, "s2", -1).id, "s1");
  assert.equal(adjacentIteration(cal, "s1", -1), null);
  assert.equal(adjacentIteration(cal, "s3", 1), null);
  assert.equal(adjacentIteration(cal, "gone", 1), null);
  assert.equal(adjacentIteration([], "s1", 1), null);
});

const plan = (values, sources, mode, dir) =>
  planShift(item(...values), sources, DEFS, CALENDARS, mode, dir);
const writes = (p) =>
  p.kind === "write"
    ? p.values.map((v) => [v.fieldId, v.date ?? v.iterationId])
    : p;

test("planShift: a move writes both ends one day, in one plan", () => {
  const p = plan(
    [date("start", "2026-09-30"), date("target", "2026-10-04")],
    DATES,
    "move",
    1,
  );
  assert.deepEqual(writes(p), [
    ["start", "2026-10-01"],
    ["target", "2026-10-05"],
  ]);
  assert.deepEqual(p.span, {
    kind: "bar",
    start: "2026-10-01",
    end: "2026-10-05",
  });
  assert.equal(p.values[0].fieldName, "Start");
  // A point moves its one date.
  assert.deepEqual(
    writes(plan([date("target", "2026-10-03")], DATES, "move", -1)),
    [["target", "2026-10-02"]],
  );
  // Both ends on one field write that field once.
  const same = { start: DATES.start, target: DATES.start };
  assert.deepEqual(
    writes(plan([date("start", "2026-10-03")], same, "move", 1)),
    [["start", "2026-10-04"]],
  );
});

test("planShift: a resize moves the target alone, never before the start", () => {
  const values = [date("start", "2026-09-21"), date("target", "2026-09-22")];
  assert.deepEqual(writes(plan(values, DATES, "resize", 1)), [
    ["target", "2026-09-23"],
  ]);
  assert.deepEqual(writes(plan(values, DATES, "resize", -1)), [
    ["target", "2026-09-21"],
  ]);
  const oneDay = [date("start", "2026-09-21"), date("target", "2026-09-21")];
  assert.deepEqual(plan(oneDay, DATES, "resize", -1), {
    kind: "held",
    reason: TARGET_BEFORE_START_REASON,
  });
  // A start-only point grows a target the day after; never the day before.
  assert.deepEqual(
    writes(plan([date("start", "2026-09-21")], DATES, "resize", 1)),
    [["target", "2026-09-22"]],
  );
  assert.equal(
    plan([date("start", "2026-09-21")], DATES, "resize", -1).reason,
    TARGET_BEFORE_START_REASON,
  );
  // Reversed dates may still widen back toward valid.
  const reversed = [date("start", "2026-10-05"), date("target", "2026-09-30")];
  assert.deepEqual(writes(plan(reversed, DATES, "resize", 1)), [
    ["target", "2026-10-01"],
  ]);
  assert.equal(
    plan(reversed, DATES, "resize", -1).reason,
    TARGET_BEFORE_START_REASON,
  );
});

test("planShift: an iteration moves to its neighbour and holds at the ends", () => {
  const p = plan([iter("s2")], ITERATIONS, "move", 1);
  assert.deepEqual(writes(p), [["sprint", "s3"]]);
  assert.deepEqual(p.span, {
    kind: "bar",
    start: "2026-10-05",
    end: "2026-10-18",
  });
  assert.equal(
    plan([iter("s1")], ITERATIONS, "move", -1).reason,
    FIRST_ITERATION_REASON,
  );
  assert.equal(
    plan([iter("s3")], ITERATIONS, "move", 1).reason,
    LAST_ITERATION_REASON,
  );
  assert.equal(
    plan([iter("s2")], ITERATIONS, "resize", 1).reason,
    ITERATION_RESIZE_REASON,
  );
});

test("planShift: holds with a reason rather than writing a guess", () => {
  assert.equal(plan([], DATES, "move", 1).reason, SET_DATES_FIRST_REASON);
  assert.equal(
    plan([iter("gone")], ITERATIONS, "move", 1).reason,
    SET_DATES_FIRST_REASON,
  );
  const mixed = { start: DATES.start, target: ITERATIONS.target };
  assert.equal(
    plan([date("start", "2026-09-21"), iter("s2")], mixed, "move", 1).reason,
    MIXED_SOURCES_REASON,
  );
  const pointOnly = { start: DATES.start, target: null };
  assert.equal(
    plan([date("start", "2026-09-21")], pointOnly, "resize", 1).reason,
    NO_TARGET_REASON,
  );
  const same = { start: DATES.start, target: DATES.start };
  assert.equal(
    plan([date("start", "2026-09-21")], same, "resize", 1).reason,
    SAME_FIELD_REASON,
  );
});

test("field values are replaced in place, or appended", () => {
  const values = [
    date("start", "2026-01-01"),
    { kind: "unknown", fieldName: "?" },
    date("x", "2026-01-02"),
  ];
  assert.deepEqual(
    withFieldValues(values, [
      date("start", "2026-02-01"),
      date("target", "2026-03-01"),
    ]),
    [
      date("start", "2026-02-01"),
      { kind: "unknown", fieldName: "?" },
      date("x", "2026-01-02"),
      date("target", "2026-03-01"),
    ],
  );
  assert.deepEqual(withFieldValues([], []), []);
});

test("the timeline bands the sourced iteration field, else the first one", () => {
  const items = [
    item(date("start", "2026-09-21"), date("target", "2026-10-04")),
  ];
  const byDate = roadmapTimeline(items, DATES, CALENDARS, TODAY, "month");
  assert.deepEqual(byDate.range, {
    min: "2026-09-14",
    max: "2026-10-11",
    clamped: false,
  });
  assert.equal(byDate.days, 28);
  assert.equal(byDate.pxPerDay, 32);
  assert.deepEqual(
    byDate.bands.map((b) => b.id),
    ["s1", "s2", "s3"],
  );
  const bare = roadmapTimeline(
    [],
    { start: null, target: null },
    new Map(),
    TODAY,
    "year",
  );
  assert.deepEqual(bare.bands, []);
  assert.deepEqual(bare.markers, []);
  assert.equal(bare.range.min <= TODAY && TODAY <= bare.range.max, true);
});

test("a milestone due past the items' dates widens the range to draw it", () => {
  const items = [
    item(
      date("start", "2026-09-21"),
      date("target", "2026-10-02"),
      milestone("Beta", "2026-10-10T07:00:00Z"),
    ),
  ];
  const month = roadmapTimeline(items, DATES, CALENDARS, TODAY, "month");
  assert.equal(month.range.max, "2026-10-17");
  assert.deepEqual(
    month.markers.map((m) => m.label),
    ["Beta"],
  );
  // Before the items too, and a milestone with no due date moves nothing.
  const early = roadmapTimeline(
    [
      item(milestone("Alpha", "2026-08-01T00:00:00Z")),
      item(milestone("Someday")),
    ],
    DATES,
    CALENDARS,
    TODAY,
    "month",
  );
  assert.equal(early.range.min, "2026-07-25");
  assert.deepEqual(
    early.markers.map((m) => m.label),
    ["Alpha"],
  );
});

test("strip labels never overlap: cut to the gap, today pushes past", () => {
  const lay = (labels, lane = 1000) =>
    layoutStripLabels(labels, lane).map((p) => [p.key, p.left, p.maxWidth]);
  // Apart: each whole, at its mark.
  assert.deepEqual(
    lay([
      { key: "a", x: 0, width: 50 },
      { key: "b", x: 100, width: 50 },
    ]),
    [
      ["a", 0, 50],
      ["b", 100, 50],
    ],
  );
  // Too close: the earlier one is cut to the gap before the next mark.
  assert.deepEqual(
    lay([
      { key: "b", x: 60, width: 80 },
      { key: "a", x: 0, width: 80 },
    ]),
    [
      ["a", 0, 56],
      ["b", 60, 80],
    ],
  );
  // Today is never cut: the next label starts past it instead.
  assert.deepEqual(
    lay([
      { key: "today", x: 0, width: 50, pinned: true },
      { key: "m", x: 20, width: 60 },
    ]),
    [
      ["today", 0, 50],
      ["m", 54, 60],
    ],
  );
  // A cut never goes below a readable sliver, and the next still clears it.
  const tight = lay([
    { key: "a", x: 0, width: 80 },
    { key: "b", x: 10, width: 40 },
  ]);
  assert.deepEqual(tight, [
    ["a", 0, 24],
    ["b", 28, 40],
  ]);
  // The last label shifts left rather than run off the lane.
  assert.deepEqual(lay([{ key: "z", x: 990, width: 50, pinned: true }]), [
    ["z", 950, 50],
  ]);
  assert.deepEqual(lay([]), []);
});

test("spans in words", () => {
  assert.equal(
    spanText(bar("2026-09-21", "2026-10-04"), TODAY),
    "Sep 21 to Oct 4",
  );
  assert.equal(spanText(bar("2026-09-21", "2026-09-21"), TODAY), "Sep 21");
  assert.equal(spanText({ kind: "point", date: "2026-10-03" }, TODAY), "Oct 3");
  assert.equal(
    spanText({ kind: "point", date: "2027-01-03" }, TODAY),
    "Jan 3, 2027",
  );
  assert.equal(
    spanText(
      { kind: "inverted", start: "2026-10-05", end: "2026-09-30" },
      TODAY,
    ),
    "Dates reversed: starts Oct 5, targets Sep 30",
  );
  assert.equal(spanText({ kind: "none" }, TODAY), "No dates");
});
