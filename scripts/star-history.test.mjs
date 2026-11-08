// Pins the Star history card's derivations
// (src/features/repository/insights/star-history.ts): the cumulative curve
// anchored to the live count, the 52-week window as the all-time curve's tail,
// the zoomed Y axis, the header slot, figcaption and note copy, and the
// UTC-pinned week labels. The wire facts behind the fixtures: weeks arrive
// newest first within and across pages of up to 30, dense back to the repo's
// first week; the live count comes on page 1 only and can differ from the
// weeks' sum either way; page 1's lastPage is the only page total.
//
// Each guard has a mutant of the live source that must fail the same checks,
// and the label checks run in a child process pinned to a zone west of UTC,
// where a week's Sunday epoch read in local time falls on the Saturday before.
//
// Not testable here: what the card draws from these values, the page driver,
// the Retry wiring and the focus rescues. The Vitest suites drive those.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import * as live from "../src/features/repository/insights/star-history.ts";

const MODULE = "src/features/repository/insights/star-history.ts";
const MODULE_URL = new URL(`../${MODULE}`, import.meta.url);
const WEEK = 7 * 86_400;
/** Sunday 1 November 2026, 00:00 UTC. */
const NEWEST = Date.UTC(2026, 10, 1) / 1000;

/** Wire weeks for `totals`, newest first. */
const weeksOf = (totals, newest = NEWEST) =>
  totals.map((total, i) => ({ week: newest - i * WEEK, total }));

/** The wire's pages for `totals` (newest first): 30 weeks each, the count on
 *  page 1 only, and rel="last" on every page but the real last one. */
function pagesOf(totals, count) {
  const weeks = weeksOf(totals);
  const pages = [];
  for (let i = 0; i < weeks.length; i += 30) pages.push(weeks.slice(i, i + 30));
  if (pages.length === 0) pages.push([]);
  const n = pages.length;
  return pages.map((w, i) => ({
    available: true,
    weeks: w,
    nextPage: i + 1 < n ? i + 2 : null,
    lastPage: n > 1 && i + 1 < n ? n : null,
    stargazersCount: i === 0 ? count : null,
  }));
}

const fill = (n, v) => Array.from({ length: n }, () => v);

/** Runs `fn` with Array pushes capped, so a runaway tick loop throws instead
 *  of hanging the suite. */
function withPushBudget(fn, budget = 1000) {
  const push = Array.prototype.push;
  let left = budget;
  Array.prototype.push = function (...items) {
    if (--left < 0) throw new Error("push budget spent");
    return push.apply(this, items);
  };
  try {
    return fn();
  } finally {
    Array.prototype.push = push;
  }
}
/** The card's compact count format, for the axis controls. */
const compact = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
/** 60 weeks, newest first: 34 stars in the newest 52, 16 in the 8 before. */
const MATURE_60 = [...fill(34, 1), ...fill(18, 0), ...fill(8, 2)];
/** 930 weeks (31 pages): MATURE_60, then 196 older stars, then quiet years. */
const OLD_930 = [...MATURE_60, ...fill(196, 1), ...fill(674, 0)];
/** 21 weeks summing to 246. */
const YOUNG_21 = [...fill(20, 12), 6];

/** The infinite read over `pages`, settled unless `over` says otherwise. */
const readOf = (pages, over = {}) => ({
  data: { pages },
  hasNextPage: pages.at(-1)?.nextPage != null,
  isError: false,
  isPaused: false,
  ...over,
});

function summary(mod, pages, over = {}) {
  return {
    pages,
    series: mod.buildStarSeries(pages),
    hasMore: false,
    view: "window",
    driving: false,
    ...over,
  };
}

/** Every check below, run against `mod`; the names of those that fail. */
function problems(mod) {
  const checks = {
    "weeks reverse to oldest first": () => {
      const s = mod.buildStarSeries(pagesOf([3, 2, 1, 0], 6));
      assert.deepEqual(
        s.points.map((p) => p.total),
        [0, 1, 2, 3],
      );
      assert.deepEqual(
        s.points.map((p) => p.stars),
        [0, 1, 3, 6],
      );
      assert.ok(s.points[0].week < s.points[3].week);
    },
    "a residual folds into the baseline": () => {
      // Count 51 over a 50-star history: the curve still ends at 51.
      const s = mod.buildStarSeries(pagesOf([...fill(50, 1)], 51));
      assert.equal(s.baseline, 1);
      assert.equal(s.points.at(-1).stars, 51);
    },
    "a history past the count clamps the baseline": () => {
      const s = mod.buildStarSeries(pagesOf([...fill(51, 1)], 50));
      assert.equal(s.baseline, 0);
      assert.equal(s.points[0].stars, 1);
      assert.equal(s.points.at(-1).stars, 51);
    },
    "no count anchors at 0": () => {
      const s = mod.buildStarSeries(pagesOf([2, 3], null));
      assert.equal(s.baseline, 0);
      assert.deepEqual(
        s.points.map((p) => p.stars),
        [3, 5],
      );
    },
    "unloaded older weeks sit in the baseline": () => {
      const twoPages = pagesOf(OLD_930, 246).slice(0, 2);
      const s = mod.buildStarSeries(twoPages);
      assert.equal(s.points.length, 60);
      assert.equal(s.baseline, 196);
      assert.equal(s.points.at(-1).stars, 246);
    },
    "an empty page past the last changes nothing": () => {
      const pages = pagesOf(MATURE_60, 100);
      const padded = [...pages, { ...pages[1], weeks: [] }];
      assert.deepEqual(mod.buildStarSeries(padded), mod.buildStarSeries(pages));
    },
    "malformed weeks are skipped": () => {
      const pages = pagesOf([1, 2, 3], 6);
      pages[0].weeks = [
        pages[0].weeks[0],
        { week: pages[0].weeks[1].week, total: "2" },
        null,
        { week: Number.NaN, total: 1 },
        { week: NEWEST, total: -4 },
        "x",
        pages[0].weeks[2],
      ];
      const s = mod.buildStarSeries(pages);
      assert.deepEqual(
        s.points.map((p) => p.total),
        [3, 1],
      );
      assert.ok(s.points.every((p) => Number.isFinite(p.stars)));
      assert.deepEqual(
        mod.buildStarSeries([{ weeks: "nope", stargazersCount: 5 }]),
        { points: [], baseline: 5 },
      );
    },
    "the window is the all-time curve's tail": () => {
      for (const count of [246, 247]) {
        const all = mod.buildStarSeries(pagesOf(OLD_930, count));
        const two = mod.buildStarSeries(pagesOf(OLD_930, count).slice(0, 2));
        assert.equal(all.points.length, 930);
        assert.deepEqual(
          mod.windowSlice(two.points),
          mod.windowSlice(all.points),
        );
        assert.equal(mod.windowSlice(all.points).length, 52);
        assert.equal(mod.windowSlice(all.points).at(-1).week, NEWEST);
      }
      // A short series is its own window.
      const young = mod.buildStarSeries(pagesOf(YOUNG_21, 246));
      assert.deepEqual(mod.windowSlice(young.points), young.points);
    },
    "window gain sums the newest 52 weeks": () => {
      const s = mod.buildStarSeries(pagesOf(MATURE_60, 246));
      assert.equal(mod.windowGain(s.points), 34);
      assert.equal(mod.windowGain(s.points, 60), 50);
    },
    "the trailing zero run": () => {
      const run = (totals) =>
        mod.trailingZeroWeeks(
          mod.buildStarSeries(pagesOf(totals, null)).points,
        );
      assert.equal(run([5, 1, 2]), 0);
      assert.equal(run([0, 0, 0, 7, 1]), 3);
      assert.equal(run([0, 0, 0, 0, 7, 0]), 4);
      assert.equal(run([0, 0, 0]), 3);
      assert.equal(mod.trailingZeroWeeks([]), 0);
    },
    "the window axis spans its own range in nice steps": () => {
      const axis = (values) => mod.windowAxis(values);
      assert.deepEqual(axis([212, 230, 246]), {
        domain: [210, 250],
        ticks: [210, 220, 230, 240, 250],
      });
      assert.deepEqual(axis([200_000, 252_389]).domain, [200_000, 260_000]);
      for (const values of [
        [0, 3],
        [1, 2],
        [10, 11, 37],
        [46_000, 46_913],
        [0, 252_389],
      ]) {
        const { domain, ticks } = axis(values);
        assert.ok(domain[0] >= 0 && domain[0] < domain[1], String(values));
        assert.ok(domain[0] <= Math.min(...values), String(values));
        assert.ok(domain[1] >= Math.max(...values), String(values));
        assert.equal(ticks[0], domain[0]);
        assert.equal(ticks.at(-1), domain[1]);
        assert.ok(ticks.length >= 2 && ticks.length <= 7, String(values));
        assert.ok(ticks.every((t) => Number.isInteger(t)));
        const gaps = new Set(ticks.slice(1).map((t, i) => t - ticks[i]));
        assert.equal(gaps.size, 1, String(values));
      }
    },
    "a flat or single-point window still has a range": () => {
      assert.deepEqual(mod.windowAxis([246, 246, 246]), {
        domain: [245, 247],
        ticks: [245, 246, 247],
      });
      assert.deepEqual(mod.windowAxis([0, 0]), {
        domain: [0, 1],
        ticks: [0, 1],
      });
      assert.deepEqual(mod.windowAxis([7]).domain, [6, 8]);
      assert.deepEqual(mod.windowAxis([]).domain, [0, 1]);
      assert.deepEqual(mod.windowAxis([Number.NaN, 4]).domain, [3, 5]);
    },
    "the window axis ends past float precision": () => {
      for (const values of [
        [2 ** 53, 2 ** 53],
        [2 ** 60, 2 ** 60 + 256],
        [Number.MAX_SAFE_INTEGER - 3, Number.MAX_SAFE_INTEGER],
      ]) {
        const { ticks } = withPushBudget(() => mod.windowAxis(values));
        assert.ok(ticks.length <= 7, String(values));
        assert.equal(new Set(ticks).size, ticks.length, String(values));
      }
    },
    "the view: All time draws every week only once nothing more loads": () => {
      assert.equal(mod.starView(false, false, false, false), "window");
      assert.equal(mod.starView(false, true, true, true), "window");
      assert.equal(mod.starView(true, true, false, false), "window");
      assert.equal(mod.starView(true, false, false, false), "all");
      assert.equal(mod.starView(true, true, true, false), "all");
      // A Retry's resume keeps the span the failure showed.
      assert.equal(mod.starView(true, true, false, true), "all");
    },
    "the span holds from a failed page to the load's end or All time's": () => {
      assert.equal(mod.starSpanHeld(true, true, true, false), true);
      assert.equal(mod.starSpanHeld(true, true, false, true), true);
      assert.equal(mod.starSpanHeld(true, true, false, false), false);
      assert.equal(mod.starSpanHeld(false, true, true, true), false);
      assert.equal(mod.starSpanHeld(true, false, false, true), false);
    },
    "card: a marker is weeks owed, never drawn, and stops the drive": () => {
      const old = pagesOf(OLD_930, 246);
      const marker = { failed: true, page: 3, reason: new Error("x") };
      const pages = [...old.slice(0, 2), marker];
      assert.deepEqual(mod.buildStarSeries(pages), mod.buildStarSeries(old.slice(0, 2)));
      const read = readOf(pages, { hasNextPage: false, isFetching: false });
      const all = mod.starCardState(read, true, false);
      assert.equal(all.marker, marker);
      assert.equal(all.partial, true);
      assert.equal(all.summary.view, "all");
      assert.equal(all.summary.hasMore, true);
      assert.equal(all.summary.pages.length, 2);
      assert.equal(all.wantsPage, false);
      assert.equal(all.pageDemand, true);
      assert.notEqual(all.partialLine, null);
      // A full window owes nothing it draws, so neither the line nor demand.
      const window = mod.starCardState(read, false, false);
      assert.equal(window.partialLine, null);
      assert.equal(window.pageDemand, false);
      // Without a count the owed span reads as gains.
      const uncounted = [...pagesOf(OLD_930, null).slice(0, 2), marker];
      const gains = mod.starCardState(readOf(uncounted, { hasNextPage: false }), true, false);
      assert.equal(mod.starMode(gains.summary), "gains");
    },
    "card: a marker's Retry holds the line only on the page it asked for": () => {
      const old = pagesOf(OLD_930, 246);
      const asked = readOf(old.slice(0, 2), { isFetching: true, retryingPage: 3 });
      const held = mod.starCardState(asked, true, true);
      assert.equal(held.partial, true);
      assert.equal(held.retryHeld, true);
      assert.equal(held.wantsPage, false);
      // Landed: the next page is owed, so the same Retry no longer holds it.
      const landed = readOf(old.slice(0, 3), { isFetching: true, retryingPage: 3 });
      assert.equal(mod.starCardState(landed, true, true).partial, false);
      const idle = readOf(old.slice(0, 2), { isFetching: false, retryingPage: 3 });
      assert.equal(mod.starCardState(idle, true, true).partial, false);
    },
    "card: the window waits for 52 weeks, then draws once": () => {
      const old = pagesOf(OLD_930, 246);
      const one = mod.starCardState(readOf(old.slice(0, 1)), false, false);
      assert.equal(one.awaitingWindow, true);
      assert.equal(one.wantsPage, true);
      assert.equal(one.stale, false);
      const two = mod.starCardState(readOf(old.slice(0, 2)), false, false);
      assert.equal(two.awaitingWindow, false);
      assert.equal(two.wantsPage, false);
      assert.equal(two.summary.view, "window");
      const young = mod.starCardState(
        readOf(pagesOf(YOUNG_21, 246)),
        false,
        false,
      );
      assert.equal(young.awaitingWindow, false);
      assert.equal(young.wantsPage, false);
    },
    "card: All time dims the window while older pages load": () => {
      const old = pagesOf(OLD_930, 246);
      const first = mod.starCardState(readOf(old.slice(0, 1)), true, false);
      assert.equal(first.awaitingWindow, true);
      assert.equal(first.stale, false);
      assert.equal(first.summary.driving, true);
      const drawn = mod.starCardState(readOf(old.slice(0, 3)), true, false);
      assert.equal(drawn.summary.view, "window");
      assert.equal(drawn.stale, true);
      assert.equal(drawn.wantsPage, true);
      const done = mod.starCardState(readOf(old), true, false);
      assert.equal(done.summary.view, "all");
      assert.equal(done.stale, false);
      assert.equal(done.wantsPage, false);
    },
    "card: a failed page stops the drive and shows the span": () => {
      const old = pagesOf(OLD_930, 246);
      const failed = { isError: true };
      const all = mod.starCardState(
        readOf(old.slice(0, 3), failed),
        true,
        false,
      );
      assert.equal(all.partial, true);
      assert.equal(all.summary.view, "all");
      assert.equal(
        all.partialLine,
        mod.starPartialLine(all.summary.series.points),
      );
      assert.equal(all.wantsPage, false);
      assert.equal(all.stale, false);
      const short = mod.starCardState(
        readOf(old.slice(0, 1), failed),
        false,
        false,
      );
      assert.equal(short.awaitingWindow, false);
      assert.notEqual(short.partialLine, null);
      // A full window loses nothing to an older page's failure.
      const full = mod.starCardState(
        readOf(old.slice(0, 3), failed),
        false,
        false,
      );
      assert.equal(full.partial, true);
      assert.equal(full.partialLine, null);
      const parked = mod.starCardState(
        readOf(old.slice(0, 3), { ...failed, isPaused: true }),
        true,
        false,
      );
      assert.equal(parked.partial, false);
      assert.equal(parked.partialLine, null);
    },
    "weeks past JS Date's range are skipped, so no label throws": () => {
      const pages = pagesOf([1, 2, 3], 6);
      pages[0].weeks = [
        pages[0].weeks[0],
        { week: 8640000000001, total: 1 },
        { week: -8640000000001, total: 1 },
        { week: Number.POSITIVE_INFINITY, total: 1 },
        pages[0].weeks[2],
      ];
      const s = mod.buildStarSeries(pages);
      assert.deepEqual(
        s.points.map((p) => p.total),
        [3, 1],
      );
      for (const p of s.points) {
        assert.doesNotThrow(() => mod.weekLabel(p.week));
        assert.doesNotThrow(() => mod.monthYearLabel(p.week));
      }
      // The range's own edge (±8.64e15 ms) is a date.
      const edge = pagesOf([1], 1);
      edge[0].weeks = [{ week: 8640000000000, total: 1 }];
      assert.equal(mod.buildStarSeries(edge).points.length, 1);
    },
    "card: the page demand ignores what the read is doing": () => {
      const old = pagesOf(OLD_930, 246);
      const demand = (pages, allTime, over = {}) =>
        mod.starCardState(readOf(pages, over), allTime, false, false)
          .pageDemand;
      for (const over of [{}, { isPaused: true }, { isError: true }]) {
        const tag = JSON.stringify(over);
        assert.equal(demand(old.slice(0, 3), true, over), true, tag);
        assert.equal(demand(old.slice(0, 1), false, over), true, tag);
        assert.equal(demand(old.slice(0, 3), false, over), false, tag);
        assert.equal(demand(old, true, over), false, tag);
      }
    },
    "card: a failed refresh or a park stops the drive": () => {
      const pages = pagesOf(OLD_930, 246).slice(0, 2);
      for (const over of [{ isError: true }, { isPaused: true }]) {
        const s = mod.starCardState(readOf(pages, over), true, false, false);
        assert.equal(s.wantsPage, false, JSON.stringify(over));
        assert.equal(s.stale, false, JSON.stringify(over));
      }
      // Any failure with pages owed is partial, whichever fetch failed last;
      // a park is not, and neither is a failure with nothing owed.
      const failed = mod.starCardState(
        readOf(pages, { isError: true }),
        true,
        false,
        false,
      );
      assert.equal(failed.partial, true);
      assert.equal(failed.summary.view, "all");
      assert.notEqual(failed.partialLine, null);
      const parked = { isError: true, isPaused: true };
      assert.equal(
        mod.starCardState(readOf(pages, parked), true, false, false).partial,
        false,
      );
      const whole = pagesOf(YOUNG_21, 246);
      assert.equal(
        mod.starCardState(readOf(whole, { isError: true }), true, false, false)
          .partial,
        false,
      );
      assert.equal(
        mod.starCardState(
          { ...readOf(pages, { isError: true }), data: undefined },
          true,
          false,
          false,
        ).partial,
        false,
      );
    },
    "card: a drawn window never steps back to the skeleton": () => {
      const one = pagesOf(OLD_930, 246).slice(0, 1);
      const resumed = mod.starCardState(readOf(one), false, false, true);
      assert.equal(resumed.awaitingWindow, false);
      assert.equal(resumed.wantsPage, true);
      assert.equal(resumed.stale, false);
      assert.equal(
        mod.starCardState(readOf(one), false, false, false).awaitingWindow,
        true,
      );
    },
    "series: a repeated or out-of-order week is dropped": () => {
      const [a, b, c] = weeksOf([3, 2, 1]);
      const pages = [
        { weeks: [a, b], stargazersCount: 6 },
        { weeks: [b, c], stargazersCount: null },
      ];
      const s = mod.buildStarSeries(pages);
      assert.deepEqual(
        s.points.map((p) => p.week),
        [c.week, b.week, a.week],
      );
      assert.equal(s.baseline, 0);
      assert.equal(s.points.at(-1).stars, 6);
      const shuffled = mod.buildStarSeries([
        { weeks: [a, c, b], stargazersCount: null },
      ]);
      assert.deepEqual(
        shuffled.points.map((p) => p.week),
        [c.week, a.week],
      );
    },
    "Y axis: the window's labels never repeat": () => {
      const ranges = {
        "1200-1260": [1200, 1215, 1260],
        "20000-20150": [20000, 20070, 20150],
        "flat 5000": [5000, 5000],
      };
      for (const [name, values] of Object.entries(ranges)) {
        const axis = mod.starYAxis("window", values);
        assert.deepEqual(axis.ticks, mod.windowAxis(values).ticks, name);
        // The case is live: compact labels collide on these ticks.
        const squeezed = axis.ticks.map((v) => compact.format(v));
        assert.notEqual(new Set(squeezed).size, squeezed.length, name);
        const labels = axis.ticks.map(axis.format);
        assert.equal(new Set(labels).size, labels.length, `${name}: ${labels}`);
        const longest = Math.max(...labels.map((l) => l.length));
        assert.ok(axis.width >= 8 + 7 * longest, name);
      }
      // Wide steps keep the compact labels.
      const wide = mod.starYAxis("window", [100_000, 252_000]);
      assert.equal(wide.format(200_000), compact.format(200_000));
      assert.equal(wide.width, 44);
    },
    "Y axis: All time starts at 0 and pads a starless history": () => {
      assert.deepEqual(mod.starYAxis("all", [0, 3, 9]).domain, [0, "auto"]);
      for (const values of [[0, 0, 0], []]) {
        const axis = mod.starYAxis("all", values);
        assert.deepEqual(axis.domain, [0, 1]);
        assert.deepEqual(axis.ticks, [0, 1]);
      }
    },
    "X axis: one tick per label, distinct": () => {
      const series = (n) =>
        weeksOf(fill(n, 0))
          .map((w) => w.week)
          .reverse();
      // References through the module's own Intl path, so any locale passes.
      const utc = (o) =>
        new Intl.DateTimeFormat(undefined, { ...o, timeZone: "UTC" });
      const grains = {
        10: utc({ month: "short", day: "numeric" }),
        14: utc({ month: "short", year: "numeric" }),
        52: utc({ month: "short", year: "numeric" }),
        370: utc({ year: "numeric" }),
      };
      for (const [n, grain] of Object.entries(grains)) {
        const weeks = series(Number(n));
        const { ticks, format } = mod.starXAxis(weeks);
        const labels = ticks.map(format);
        assert.equal(new Set(labels).size, labels.length, `${n}: ${labels}`);
        assert.deepEqual(
          labels,
          ticks.map((t) => grain.format(t * 1000)),
          `${n}: ${labels}`,
        );
        assert.equal(ticks[0], weeks[0], n);
        // Each tick is the first loaded week under its label.
        for (const tick of ticks) {
          const i = weeks.indexOf(tick);
          assert.ok(i === 0 || format(weeks[i - 1]) !== format(tick), n);
        }
      }
      assert.equal(mod.starXAxis(series(52)).ticks.length, 13);
      assert.deepEqual(mod.starXAxis([]).ticks, []);
    },
    "card: a resumed span stays drawn and dims": () => {
      const old = pagesOf(OLD_930, 246);
      const resumed = mod.starCardState(readOf(old.slice(0, 3)), true, true);
      assert.equal(resumed.summary.view, "all");
      assert.equal(resumed.summary.series.points.length, 90);
      assert.equal(resumed.stale, true);
      assert.equal(resumed.summary.driving, true);
      const short = mod.starCardState(readOf(old.slice(0, 1)), true, true);
      assert.equal(short.awaitingWindow, false);
      assert.equal(short.stale, true);
    },
    "header: nothing without an answer, unavailable, or at rest at 0 stars":
      () => {
        assert.deepEqual(mod.starHeaderSlot(summary(mod, [])), {
          kind: "none",
        });
        const unavailable = [
          {
            available: false,
            weeks: [],
            nextPage: null,
            lastPage: null,
            stargazersCount: null,
          },
        ];
        assert.deepEqual(mod.starHeaderSlot(summary(mod, unavailable)), {
          kind: "none",
        });
        const zero = pagesOf(fill(930, 0), 0);
        for (const over of [{}, { view: "all" }])
          assert.deepEqual(
            mod.starHeaderSlot(summary(mod, zero.slice(0, 3), over)),
            { kind: "none" },
          );
        // All time still counts its pages over a starless history.
        assert.equal(
          mod.starHeaderSlot(
            summary(mod, zero.slice(0, 3), { driving: true, hasMore: true }),
          ).text,
          "Loading older weeks · 3 of 31",
        );
      },
    "header: the page counter reads page 1's total": () => {
      const pages = pagesOf(OLD_930, 246).slice(0, 9);
      const driving = { driving: true, hasMore: true };
      const slot = mod.starHeaderSlot(summary(mod, pages, driving));
      assert.equal(slot.kind, "counter");
      assert.equal(slot.text, "Loading older weeks · 9 of 31");
      // A later page's total never stands in for page 1's.
      const unread = pages.map((p, i) =>
        i === 8 ? { ...p, lastPage: null } : p,
      );
      assert.equal(
        mod.starHeaderSlot(summary(mod, unread, driving)).text,
        "Loading older weeks · 9 of 31",
      );
      const grown = pages.map((p, i) => (i === 8 ? { ...p, lastPage: 32 } : p));
      assert.equal(
        mod.starHeaderSlot(summary(mod, grown, driving)).text,
        "Loading older weeks · 9 of 31",
      );
      const unknown = pages.map((p, i) =>
        i === 0 ? { ...p, lastPage: null } : p,
      );
      assert.equal(
        mod.starHeaderSlot(summary(mod, unknown, driving)).text,
        "Loading older weeks…",
      );
      // A count unknown while pages remain still shows the counter.
      const noCount = pages.map((p, i) =>
        i === 0 ? { ...p, stargazersCount: null } : p,
      );
      assert.equal(
        mod.starHeaderSlot(summary(mod, noCount, driving)).kind,
        "counter",
      );
    },
    "header: the window's gain only over a full window": () => {
      const all = pagesOf(OLD_930, 246);
      assert.equal(
        mod.starHeaderSlot(summary(mod, all.slice(0, 2), { hasMore: true }))
          .text,
        "246 stars · +34 in 52 weeks",
      );
      // One page in, more owed: the window isn't full.
      assert.equal(
        mod.starHeaderSlot(summary(mod, all.slice(0, 1), { hasMore: true }))
          .text,
        "246 stars",
      );
      // A history shorter than the window: the count already says it.
      assert.equal(
        mod.starHeaderSlot(summary(mod, pagesOf(YOUNG_21, 246))).text,
        "246 stars",
      );
      assert.equal(
        mod.starHeaderSlot(summary(mod, pagesOf([1], 1))).text,
        "1 star",
      );
    },
    "header: All time shows the count alone": () => {
      const slot = mod.starHeaderSlot(
        summary(mod, pagesOf(OLD_930, 246), { view: "all" }),
      );
      assert.deepEqual(slot, {
        kind: "stats",
        count: 246,
        gain: null,
        text: "246 stars",
      });
    },
    "header: no count until every page is in": () => {
      const all = pagesOf(OLD_930, null);
      assert.deepEqual(
        mod.starHeaderSlot(summary(mod, all.slice(0, 2), { hasMore: true })),
        { kind: "stats", count: null, gain: 34, text: "+34 in 52 weeks" },
      );
      assert.deepEqual(
        mod.starHeaderSlot(summary(mod, all.slice(0, 1), { hasMore: true })),
        { kind: "none" },
      );
      assert.equal(
        mod.starHeaderSlot(summary(mod, all, { view: "all" })).text,
        "246 stars",
      );
    },
    "header: a clamped history still shows the live count": () => {
      const pages = pagesOf([...fill(51, 1), ...fill(9, 0)], 50);
      const input = summary(mod, pages, { view: "all" });
      assert.equal(input.series.points.at(-1).stars, 51);
      assert.equal(mod.starHeaderSlot(input).text, "50 stars");
      assert.match(mod.starFigcaption(input), / 50 stars since /);
    },
    "figcaption: the count, the full window's gain, the oldest week": () => {
      const lead = "Today's stargazers by the week they starred";
      const all = pagesOf(OLD_930, 246);
      assert.equal(
        mod.starFigcaption(summary(mod, all.slice(0, 2), { hasMore: true })),
        `${lead}. 246 stars, +34 in the last 52 weeks.`,
      );
      assert.equal(
        mod.starFigcaption(summary(mod, pagesOf(YOUNG_21, 246))),
        `${lead}. 246 stars.`,
      );
      const noCount = pagesOf(OLD_930, null).slice(0, 1);
      assert.equal(
        mod.starFigcaption(summary(mod, noCount, { hasMore: true })),
        `${lead}, as new stars per week.`,
      );
      const oldest = NEWEST - 929 * WEEK;
      assert.equal(
        mod.starFigcaption(summary(mod, all, { view: "all" })),
        `${lead}. 246 stars since ${mod.monthYearLabel(oldest)}.`,
      );
      // A partial All-time span with the count unknown reads as gains.
      const partial = pagesOf(OLD_930, null).slice(0, 5);
      assert.equal(
        mod.starFigcaption(
          summary(mod, partial, { view: "all", hasMore: true }),
        ),
        `${lead}, as new stars per week; showing weeks since ${mod.monthYearLabel(NEWEST - 149 * WEEK)}.`,
      );
      // The gains window dates nothing: the axis does.
      assert.equal(
        mod.starFigcaption(summary(mod, partial, { hasMore: true })),
        `${lead}, as new stars per week.`,
      );
      // The cap owes weeks too.
      assert.match(
        mod.starFigcaption(summary(mod, partial.slice(0, 2), { view: "all" })),
        /, as new stars per week; showing weeks since /,
      );
      // Pages owed date the weeks, never the stars.
      const owed = all.slice(0, 2);
      assert.equal(
        mod.starFigcaption(summary(mod, owed, { view: "all", hasMore: true })),
        `${lead}. 246 stars; showing weeks since ${mod.monthYearLabel(NEWEST - 59 * WEEK)}.`,
      );
      // Defense in depth: a next page the read won't follow still owes weeks.
      assert.match(
        mod.starFigcaption(summary(mod, owed, { view: "all" })),
        /; showing weeks since /,
      );
      // No stars yet: the note carries it, so the caption is the lead alone.
      const zero = pagesOf(fill(21, 0), 0);
      for (const view of ["window", "all"])
        assert.equal(
          mod.starFigcaption(summary(mod, zero, { view })),
          `${lead}.`,
          view,
        );
      // A count of 0 over starred weeks keeps it: no note says so.
      assert.equal(
        mod.starFigcaption(summary(mod, pagesOf([1, 0], 0))),
        `${lead}. 0 stars.`,
      );
    },
    "note: unavailable, no stars, a flat tail": () => {
      const unavailable = [
        {
          available: false,
          weeks: [],
          nextPage: null,
          lastPage: null,
          stargazersCount: null,
        },
      ];
      assert.equal(
        mod.starNote(summary(mod, unavailable)).text,
        "Star history isn't available for this repository.",
      );
      assert.deepEqual(mod.starNote(summary(mod, [])), { kind: "none" });
      assert.equal(
        mod.starNote(summary(mod, pagesOf(fill(60, 0), 0), { hasMore: true }))
          .text,
        "No stars yet.",
      );
      // An unknown count with pages owed claims nothing.
      assert.equal(
        mod.starNote(
          summary(mod, pagesOf(fill(60, 0), null).slice(0, 1), {
            hasMore: true,
          }),
        ).kind,
        "flatTail",
      );
      assert.equal(
        mod.starNote(summary(mod, pagesOf([0, 0, 0, 0, 3, 1], 4))).text,
        "No new stars in the last 4 weeks.",
      );
      assert.deepEqual(
        mod.starNote(summary(mod, pagesOf([0, 0, 0, 3, 1], 4))),
        { kind: "none" },
      );
      // The window shows at most 52 of a longer quiet run.
      const quiet = pagesOf([...fill(80, 0), 5], 5);
      assert.equal(mod.starNote(summary(mod, quiet)).weeks, 52);
      assert.equal(
        mod.starNote(summary(mod, quiet, { view: "all" })).weeks,
        80,
      );
    },
    "note: a curve past the count says why": () => {
      const above = {
        kind: "aboveCount",
        text: "The star count and the chart come from separate reads, so the curve can end above the count.",
      };
      // 51 loaded stars against a count of 50: the baseline clamps.
      const past = summary(mod, pagesOf(fill(51, 1), 50));
      assert.equal(past.series.baseline, 0);
      assert.deepEqual(mod.starNote(past), above);
      assert.deepEqual(mod.starNote({ ...past, view: "all" }), above);
      // A curve ending at the count, a residual, or no count says nothing.
      for (const [totals, count] of [
        [fill(50, 1), 50],
        [fill(50, 1), 51],
        [fill(51, 1), null],
      ])
        assert.deepEqual(
          mod.starNote(summary(mod, pagesOf(totals, count))),
          { kind: "none" },
          String(count),
        );
      // Offline outranks it; it outranks a quiet tail.
      const parked = { pageParked: true, hasMore: true };
      assert.equal(mod.starNote({ ...past, ...parked }).kind, "offline");
      const quiet = summary(mod, pagesOf([...fill(8, 0), ...fill(51, 1)], 50));
      assert.equal(mod.starNote(quiet).kind, "aboveCount");
      assert.equal(
        mod.starNote(summary(mod, pagesOf([...fill(8, 0), 1], 1))).kind,
        "flatTail",
      );
    },
    "mode: gains while the count is unknown and weeks are owed": () => {
      const all = pagesOf(OLD_930, null);
      const owed = summary(mod, all.slice(0, 2), { hasMore: true });
      assert.equal(mod.starMode(owed), "gains");
      assert.equal(mod.starDisplayCount(owed), null);
      // The cap: no page follows, yet the last one names a next.
      const capped = summary(mod, all.slice(0, 2));
      assert.equal(mod.starMode(capped), "gains");
      assert.equal(mod.starDisplayCount(capped), null);
      // A gain of 0 says nothing in gains mode; the quiet-tail note covers
      // it. The running total keeps its "+0".
      const still = [...fill(52, 0), ...fill(8, 1)];
      assert.deepEqual(
        mod.starHeaderSlot(
          summary(mod, pagesOf(still, null).slice(0, 2), { hasMore: true }),
        ),
        { kind: "none" },
      );
      assert.equal(
        mod.starHeaderSlot(
          summary(mod, pagesOf(still, 8).slice(0, 2), { hasMore: true }),
        ).text,
        "8 stars · +0 in 52 weeks",
      );
      // Gains keep the window's gain, never a count.
      assert.equal(mod.starHeaderSlot(capped).text, "+34 in 52 weeks");
      assert.deepEqual(
        mod.starHeaderSlot(summary(mod, all.slice(0, 1), { hasMore: true })),
        { kind: "none" },
      );
      // Every page in: the running total returns, the count its sum.
      const done = summary(mod, all, { view: "all" });
      assert.equal(mod.starMode(done), "cumulative");
      assert.equal(mod.starDisplayCount(done), 246);
      // A young history the window loads whole draws the total at once; one
      // whose next page is owed plots gains.
      const young = pagesOf(fill(40, 1), null);
      assert.equal(young.length, 2);
      assert.equal(mod.starMode(summary(mod, young)), "cumulative");
      assert.equal(
        mod.starMode(summary(mod, young.slice(0, 1), { hasMore: true })),
        "gains",
      );
      // A live count anchors the total whatever is owed.
      const counted = pagesOf(OLD_930, 246).slice(0, 2);
      assert.equal(
        mod.starMode(summary(mod, counted, { hasMore: true })),
        "cumulative",
      );
      // Gains plot from 0, in the window too.
      assert.equal(mod.starYAxis("window", [5, 6, 7], "gains").domain[0], 0);
      assert.notEqual(
        mod.starYAxis("window", [5, 6, 7], "cumulative").domain[0],
        0,
      );
    },
    "note: offline while a wanted page is parked": () => {
      const offline =
        "You're offline — older weeks will load once you're back online.";
      const parked = { pageParked: true, hasMore: true };
      const page1 = pagesOf(MATURE_60, 50).slice(0, 1);
      assert.deepEqual(mod.starNote(summary(mod, page1, parked)), {
        kind: "offline",
        text: offline,
      });
      // It outranks a quiet tail.
      const quiet = pagesOf([...fill(10, 0), ...fill(50, 1)], 50).slice(0, 1);
      assert.equal(
        mod.starNote(summary(mod, quiet, { hasMore: true })).kind,
        "flatTail",
      );
      assert.equal(mod.starNote(summary(mod, quiet, parked)).kind, "offline");
      // No stars yet still says so.
      const zero = pagesOf(fill(60, 0), 0).slice(0, 1);
      assert.equal(mod.starNote(summary(mod, zero, parked)).kind, "noStars");
      // The card state parks a page only while one is wanted: All time, or a
      // window short of 52 weeks, with pages owed.
      const note = (pages, over, allTime) =>
        mod.starNote(
          mod.starCardState(
            readOf(pages, { isPaused: true, ...over }),
            allTime,
            false,
            false,
          ).summary,
        ).kind;
      const full = pagesOf(MATURE_60, 50);
      assert.equal(note(page1, { hasNextPage: true }, false), "offline");
      assert.equal(
        note(full.slice(0, 2), { hasNextPage: true }, true),
        "offline",
      );
      assert.equal(
        note(full.slice(0, 2), { hasNextPage: true }, false),
        "none",
      );
      assert.equal(note(full, { hasNextPage: false }, true), "none");
      assert.equal(
        note(full.slice(0, 2), { hasNextPage: true, isPaused: false }, true),
        "none",
      );
    },
    "card state: the partial line's Retry holds while the read fetches": () => {
      const failed = { hasNextPage: true, isError: true };
      const state = (pages, over) =>
        mod.starCardState(
          readOf(pages, { ...failed, ...over }),
          false,
          false,
          false,
        );
      const page1 = pagesOf(MATURE_60, 50).slice(0, 1);
      assert.equal(state(page1, { isFetching: true }).retryHeld, true);
      assert.equal(state(page1, { isFetching: false }).retryHeld, false);
      // No partial line, nothing to hold.
      const full = state(pagesOf(MATURE_60, 50).slice(0, 2), {
        isFetching: true,
      });
      assert.equal(full.partialLine, null);
      assert.equal(full.retryHeld, false);
    },
    "the partial line names the oldest loaded week": () => {
      const s = mod.buildStarSeries(pagesOf(OLD_930, 246).slice(0, 3));
      assert.equal(
        mod.starPartialLine(s.points),
        `Showing since ${mod.monthYearLabel(NEWEST - 89 * WEEK)} — couldn't load older weeks.`,
      );
      assert.equal(mod.starPartialLine([]), null);
    },
  };
  const failed = [];
  for (const [name, check] of Object.entries(checks)) {
    try {
      check();
    } catch {
      failed.push(name);
    }
  }
  return failed;
}

const liveSource = () =>
  readFileSync(MODULE_URL, "utf8").replace(/\r\n/g, "\n");

test("the derivations hold", () => {
  assert.deepEqual(problems(live), []);
});

test("a deriver that drops a guard fails the checks", async () => {
  const src = liveSource();
  const swap = (from, to) => {
    assert.ok(src.includes(from), `mutant anchor missing: ${from}`);
    return src.replace(from, to);
  };
  const mutants = {
    "no reverse": swap("weeks.reverse();", ""),
    "unclamped baseline": swap("Math.max(0, count - sum)", "count - sum"),
    "no residual": swap(
      "count === null ? 0 : Math.max(0, count - sum)",
      "count === null ? 0 : 0",
    ),
    "weeks past Date's range kept": swap(
      "!Number.isNaN(new Date(week * 1000).getTime())",
      "Number.isFinite(week)",
    ),
    "page demand while parked only": swap(
      "pageDemand: hasMore && (short || allTime)",
      "pageDemand: hasMore && (short || allTime) && settled",
    ),
    "page demand on a full window": swap(
      "pageDemand: hasMore && (short || allTime)",
      "pageDemand: hasMore",
    ),
    "unguarded weeks": swap(
      "const week = readWeek(raw);",
      "const week = /** @type {any} */ (raw);",
    ),
    "window from the head": swap(
      "points.slice(-windowWeeks)",
      "points.slice(0, windowWeeks)",
    ),
    "zero run counts every week": swap(
      "points[i].total === 0; i--",
      "points[i].total >= 0; i--",
    ),
    "flat axis unpadded": swap(
      "const flat = min === max;",
      "const flat = false;",
    ),
    "axis below 0": swap("Math.max(0, min - 1)", "min - 1"),
    "unsafe axis values kept": swap(
      "finite.some((v) => Math.abs(v) > Number.MAX_SAFE_INTEGER)",
      "false",
    ),
    "no note over the count": swap("if (curveAboveCount(input))", "if (false)"),
    "counter reads the newest loaded page": swap(
      "const last = input.pages[0].lastPage;",
      "const last = input.pages[input.pages.length - 1].lastPage;",
    ),
    "no counter at 0 stars": swap(
      'return { kind: "none" };\n  if (input.driving) {',
      'return { kind: "none" };\n  if (starDisplayCount(input) === 0) return { kind: "none" };\n  if (input.driving) {',
    ),
    "gains mode off": swap(
      "liveStarCount(input.pages) === null && spanOwed(input)",
      "false",
    ),
    "gains only while pages remain": swap(
      "liveStarCount(input.pages) === null && spanOwed(input)",
      "liveStarCount(input.pages) === null && input.hasMore",
    ),
    "no gain in gains mode": swap(
      'if (input.view !== "window") return null;',
      'if (input.view !== "window" || starMode(input) === "gains") return null;',
    ),
    "gains header drops the gain": swap(
      "gains: (_count, gain) => [gain === 0 ? null : gainText(gain)],",
      "gains: () => [],",
    ),
    "gains header counts": swap(
      "gains: (_count, gain) => [gain === 0 ? null : gainText(gain)],",
      "gains: (count, gain) => [String(count), gainText(gain)],",
    ),
    "gains axis zoomed": swap(
      'view === "window" && mode === "cumulative"',
      'view === "window"',
    ),
    "gains caption dropped": swap(
      'if (starMode(input) === "gains") return gainsCaption(input);',
      "",
    ),
    "gains span undated": swap('input.view === "all" && oldest', "false"),
    "gains window dated": swap('input.view === "all" && oldest', "oldest"),
    "gains header says +0": swap(
      "gain === 0 ? null : gainText(gain)",
      "gainText(gain)",
    ),
    "offline note dropped": swap(
      "if (input.pageParked) return",
      "if (false) return",
    ),
    "offline over a full window's refresh": swap(
      "read.isPaused && hasMore && (short || allTime)",
      "read.isPaused && hasMore",
    ),
    "offline with nothing owed": swap(
      "read.isPaused && hasMore && (short || allTime)",
      "read.isPaused && (short || allTime)",
    ),
    "offline only short of the window": swap(
      "read.isPaused && hasMore && (short || allTime)",
      "read.isPaused && hasMore && short",
    ),
    "offline over no stars": swap(
      'if (noStarsYet(input)) return { kind: "noStars", text: NOTE_TEXT.noStars };\n  if (input.pageParked) return { kind: "offline", text: NOTE_TEXT.offline };',
      'if (input.pageParked) return { kind: "offline", text: NOTE_TEXT.offline };\n  if (noStarsYet(input)) return { kind: "noStars", text: NOTE_TEXT.noStars };',
    ),
    "park not carried": swap(
      "pageParked: read.isPaused && hasMore && (short || allTime)",
      "pageParked: false",
    ),
    "retry never held": swap(
      "retryHeld: partialLine !== null && read.isFetching",
      "retryHeld: false",
    ),
    "retry held off the line": swap(
      "retryHeld: partialLine !== null && read.isFetching",
      "retryHeld: read.isFetching",
    ),
    "gain over a short window": swap(
      "points.length >= STAR_WINDOW_WEEKS ? windowGain(points) : null",
      "windowGain(points)",
    ),
    "gain on All time": swap('if (input.view !== "window") return null;', ""),
    "count before every page": swap(
      'if (starMode(input) === "gains") return null;',
      "",
    ),
    "flat tail from 3": swap(
      "STAR_FLAT_TAIL_MIN = 4",
      "STAR_FLAT_TAIL_MIN = 3",
    ),
    "All time draws mid-load": swap(
      "(!hasMore || partial || spanHeld)",
      "true",
    ),
    "span dropped on resume": swap(
      "(!hasMore || partial || spanHeld)",
      "(!hasMore || partial)",
    ),
    "span held outside All time": swap(
      "return allTime && hasMore && (partial || held);",
      "return hasMore && (partial || held);",
    ),
    "span held past the load": swap(
      "return allTime && hasMore && (partial || held);",
      "return allTime && (partial || held);",
    ),
    "drive past a failed refresh": swap(
      "const settled = !read.isPaused && !failing;",
      "const settled = !read.isPaused;",
    ),
    "drive while parked": swap(
      "const settled = !read.isPaused && !failing;",
      "const settled = !failing;",
    ),
    "partial while parked": swap(
      "!read.isPaused && (read.isError || marker !== null || retrying)",
      "(read.isError || marker !== null || retrying)",
    ),
    "partial with nothing owed": swap(
      "read.data !== undefined && hasMore && failing",
      "read.data !== undefined && failing",
    ),
    "drawn window steps back": swap("settled && !windowDrawn", "settled"),
    "repeated week kept": swap(
      "if (week && (last === undefined || week.week < last.week))",
      "if (week)",
    ),
    "compact labels always": swap(
      "const format = distinct ? compactCount : fullCount;",
      "const format = compactCount;",
    ),
    "starless All time unpadded": swap(
      ": labelledAxis([0, 1], [0, 1]);",
      ': { domain: [0, "auto"], ticks: undefined, format: compactCount, width: 44 };',
    ),
    "owed span dated as the stars": swap("if (spanOwed(input))", "if (false)"),
    "the cap reads as complete": swap(
      "input.hasMore || (tail !== undefined && tail.nextPage !== null)",
      "input.hasMore",
    ),
    "0 stars said twice": swap(
      "if (noStarsYet(input)) return `",
      "if (false) return `",
    ),
    "a tick every week": swap(
      "if (label !== previous) ticks.push(week);",
      "ticks.push(week);",
    ),
    "month ticks on a long span": swap(
      "if (spanWeeks <= 156) return MONTH_YEAR;",
      "return MONTH_YEAR;",
    ),
    "day ticks on a short span": swap(
      "if (spanWeeks < 13) return DAY_TICK;",
      "",
    ),
    "window drive past 52 weeks": swap("(allTime || short)", "true"),
    "skeleton over a failure": swap(
      "short && hasMore && settled",
      "short && hasMore",
    ),
    "partial line over a full window": swap(
      'partial && (view === "all" || short)',
      "partial",
    ),
    "dim over the skeleton": swap(
      "stale: driving && !awaitingWindow",
      "stale: driving",
    ),
    "no singular": swap('count === 1 ? "star" : "stars"', '"stars"'),
    "unavailable ignored": swap(
      "input.pages[0].available !== false",
      "input.pages[0] !== undefined",
    ),
  };
  const dir = mkdtempSync(join(tmpdir(), "star-history-"));
  try {
    for (const [name, text] of Object.entries(mutants)) {
      assert.notEqual(text, src, name);
      // .mts: tmpdir has no package.json naming the module type.
      const file = join(dir, `${name.replace(/\W+/g, "-")}.mts`);
      writeFileSync(file, text);
      const mod = await import(pathToFileURL(file).href);
      assert.notDeepEqual(problems(mod), [], name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Runs in the child: refuses unless the zone really is west of UTC, then
// reports the module's labels beside references built from the Sunday's own
// local calendar date (noon, so no zone puts it on another day).
const CHILD = `
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
if (zone !== "America/Los_Angeles") {
  console.error("TZ precondition failed: the child runs in " + zone);
  process.exit(3);
}
const mod = await import(process.argv[1]);
const week = ${NEWEST};
const sunday = new Date(2026, 10, 1, 12);
// Sunday 1 January 2023, 00:00 UTC: a year that starts on a week boundary.
const newYear = ${Date.UTC(2023, 0, 1) / 1000};
const run = (n, newest) =>
  Array.from({ length: n }, (_, i) => newest - (n - 1 - i) * ${WEEK});
const last = ({ ticks, format }) => format(ticks[ticks.length - 1]);
const local = (o) => new Intl.DateTimeFormat(undefined, o);
const date = local({ month: "short", day: "numeric", year: "numeric" });
const parts = (d) => {
  const p = date.formatToParts(d);
  const of = (t) => p.find((x) => x.type === t)?.value ?? "";
  return { year: of("year"), month: of("month"), day: of("day") };
};
console.log(JSON.stringify({
  parts: mod.weekDateParts(week),
  label: mod.weekLabel(week),
  monthTick: last(mod.starXAxis(run(14, week))),
  dayTick: last(mod.starXAxis(run(5, week))),
  yearTick: last(mod.starXAxis(run(400, newYear))),
  newYearRef: local({ year: "numeric" }).format(new Date(2023, 0, 1, 12)),
  monthYear: mod.monthYearLabel(week),
  sunday: parts(sunday),
  epochLocal: parts(new Date(week * 1000)),
  monthTickRef: local({ month: "short", year: "numeric" }).format(sunday),
  dayTickRef: local({ month: "short", day: "numeric" }).format(sunday),
  monthYearRef: local({ month: "short", year: "numeric" }).format(sunday),
}));
`;

function labelsIn(moduleHref) {
  const run = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", CHILD, moduleHref],
    {
      env: { ...process.env, TZ: "America/Los_Angeles" },
      encoding: "utf8",
    },
  );
  assert.equal(run.status, 0, `child failed: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

function labelProblems(out) {
  const failed = [];
  const parts = ["year", "month", "day"];
  if (
    !parts.every((k) => out.parts[k] !== "" && out.parts[k] === out.sunday[k])
  )
    failed.push("week parts");
  if (!parts.every((k) => out.label.includes(out.sunday[k])))
    failed.push("week label");
  if (!out.label.startsWith("Week of ")) failed.push("week label lead");
  if (out.monthTick !== out.monthTickRef) failed.push("month tick");
  if (out.dayTick !== out.dayTickRef) failed.push("day tick");
  if (out.yearTick !== out.newYearRef) failed.push("year tick");
  if (out.monthYear !== out.monthYearRef) failed.push("month label");
  return failed;
}

test("week labels name the Sunday west of UTC", () => {
  const out = labelsIn(MODULE_URL.href);
  // The trap is live in the child: the epoch read in local time is Saturday.
  assert.notDeepEqual(out.epochLocal, out.sunday);
  assert.deepEqual(labelProblems(out), []);
});

test("labels read in local time fail west of UTC", () => {
  const src = liveSource();
  const from = '{ ...options, timeZone: "UTC" }';
  assert.ok(src.includes(from));
  const dir = mkdtempSync(join(tmpdir(), "star-history-tz-"));
  try {
    const file = join(dir, "local-time.mts");
    writeFileSync(file, src.replace(from, "{ ...options }"));
    const out = labelsIn(pathToFileURL(file).href);
    assert.deepEqual(labelProblems(out), [
      "week parts",
      "week label",
      "month tick",
      "day tick",
      "year tick",
      "month label",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the module stays import-free", () => {
  // Type stripping resolves no aliases, and a mutant copy loads from tmpdir.
  assert.doesNotMatch(liveSource(), /^\s*(import|export\s.*\sfrom)\s/m);
});
