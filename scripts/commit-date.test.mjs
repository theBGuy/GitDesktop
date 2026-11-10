// Pins the commit date model (src/features/history/commit-date.ts): the typed
// grammar (lenient in, canonical out), every validation sentence in its rule
// order, the editable-range boundaries, the git ISO reader, the picker mapping,
// and what a date draft sends (resolveDates).
//
// Not testable here: the field's rendering and focus behaviour; those are the
// Vitest suites' and the live drive's.
//
// The import reaches straight into `src/` under Node's type stripping, so the
// module must stay free of runtime imports.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTHOR_LATER_WARNING,
  COMMIT_DATE_MAX_EPOCH,
  commitDateFromIso,
  DATE_FORMAT_HINT,
  dateWarnings,
  describeCommitDate,
  FIX_DATE_FIRST,
  FUTURE_WARNING,
  formatCommitDate,
  inEditableRange,
  nowCommitDate,
  OUT_OF_RANGE_NOTE,
  readableCommitDate,
  readCommitDate,
  resolveDates,
  rowDateLabel,
  SAME_UNREACHABLE_NOTE,
  sameCommitDate,
  sameUnreachableNote,
  UNREADABLE_DATE_TEXT,
  withPickedDate,
  withPickedTime,
} from "../src/features/history/commit-date.ts";

const d = (epochSeconds, offsetMinutes) => ({ epochSeconds, offsetMinutes });
/** Epoch seconds of a UTC wall clock (4-digit years only). */
const utc = (y, mo, day, h = 0, mi = 0, s = 0) =>
  Date.UTC(y, mo - 1, day, h, mi, s) / 1000;

const ok = (text, fallback = 0) => {
  const r = readCommitDate(text, fallback);
  assert.equal(r.ok, true, `${text}: ${r.error}`);
  return r;
};
const err = (text, fallback = 0) => {
  const r = readCommitDate(text, fallback);
  assert.equal(r.ok, false, `${text} should not parse`);
  return r.error;
};

const SHAPE = "Use the form YYYY-MM-DD HH:MM:SS ±HH:MM.";
const YEAR = "The year must be between 1970 and 2099.";
const OFFSET_MINUTES = "Offset minutes must be 00 to 59.";
const OFFSET_RANGE = "Offsets run from -12:00 to +14:00.";
const TIME = "Time must be between 00:00:00 and 23:59:59.";
const BEFORE_EPOCH = "Dates before 1970-01-01 00:00:00 UTC can't be stored.";

const OFFSETS = [-720, -570, -480, -210, -30, 0, 345, 840];
const OFFSET_TEXT = {
  "-720": "-12:00",
  "-570": "-09:30",
  "-480": "-08:00",
  "-210": "-03:30",
  "-30": "-00:30",
  0: "+00:00",
  345: "+05:45",
  840: "+14:00",
};

test("canonical text round-trips over every offset, the sign on the whole value", () => {
  const mid = utc(2026, 11, 7, 22, 58, 4);
  for (const off of OFFSETS) {
    const text = formatCommitDate(d(mid, off));
    assert.ok(text.endsWith(` ${OFFSET_TEXT[off]}`), text);
    const r = ok(text);
    assert.deepEqual(r.date, d(mid, off));
    assert.equal(r.offsetAssumed, false);
  }
  assert.equal(formatCommitDate(d(0, -210)), "1969-12-31 20:30:00 -03:30");
  assert.equal(formatCommitDate(d(0, -30)), "1969-12-31 23:30:00 -00:30");
  assert.equal(formatCommitDate(d(0, 0)), "1970-01-01 00:00:00 +00:00");
  assert.equal(formatCommitDate(d(0, 345)), "1970-01-01 05:45:00 +05:45");
  assert.equal(
    formatCommitDate(d(COMMIT_DATE_MAX_EPOCH, -720)),
    "2099-12-31 23:59:59 -12:00",
  );
  // At the range's ends the text round-trips where its wall year stays in
  // 1970-2099 and is refused by the typed-year rule where it does not.
  for (const epoch of [0, COMMIT_DATE_MAX_EPOCH]) {
    for (const off of OFFSETS) {
      const text = formatCommitDate(d(epoch, off));
      const year = Number(text.slice(0, 4));
      if (year >= 1970 && year <= 2099) {
        assert.deepEqual(ok(text).date, d(epoch, off), text);
      } else {
        assert.equal(err(text), YEAR, text);
      }
    }
  }
});

test("typed negative non-whole-hour offsets read with the sign on the whole value", () => {
  const at = utc(2026, 11, 7, 12);
  assert.deepEqual(
    ok("2026-11-07 12:00:00 -0330").date,
    d(at + 210 * 60, -210),
  );
  assert.deepEqual(
    ok("2026-11-07 12:00:00 -09:30").date,
    d(at + 570 * 60, -570),
  );
  assert.deepEqual(ok("2026-11-07 12:00:00 -00:30").date, d(at + 30 * 60, -30));
});

test("every leniency of the grammar reads to the same instant", () => {
  const want = d(utc(2026, 11, 7, 22, 58, 4), 60);
  for (const text of [
    "2026-11-07 23:58:04 +01:00",
    "2026-11-07T23:58:04+01:00",
    "2026-11-07t23:58:04+01:00",
    "2026-11-07 23:58:04 +0100",
    "2026-11-07   23:58:04+0100",
    "  2026-11-07 23:58:04 +01:00  ",
  ]) {
    assert.deepEqual(ok(text).date, want, text);
  }
  assert.deepEqual(
    ok("2026-11-07 23:58 +01:00").date,
    d(utc(2026, 11, 7, 22, 58), 60),
  );
  for (const z of ["2026-11-07 23:58:04Z", "2026-11-07 23:58:04 z"]) {
    assert.deepEqual(ok(z).date, d(utc(2026, 11, 7, 23, 58, 4), 0), z);
  }
  // `-00:00` is a zero offset and prints `+00:00`.
  const minusZero = ok("2026-11-07 23:58:04 -00:00").date;
  assert.equal(minusZero.offsetMinutes, 0);
  assert.equal(formatCommitDate(minusZero), "2026-11-07 23:58:04 +00:00");
});

test("an omitted offset takes the fallback and says it was assumed", () => {
  const r = ok("2026-11-07 23:58:04", -210);
  assert.equal(r.offsetAssumed, true);
  assert.deepEqual(r.date, d(utc(2026, 11, 7, 23, 58, 4) + 210 * 60, -210));
});

test("each rule's sentence, first failing rule wins", () => {
  assert.equal(err(""), "Enter a date as YYYY-MM-DD HH:MM:SS ±HH:MM.");
  assert.equal(err("   "), "Enter a date as YYYY-MM-DD HH:MM:SS ±HH:MM.");
  for (const bad of [
    "abc",
    "2026-11-07",
    "2026/11/07 23:58:04",
    "2026-11-07 23:58:04.5 +01:00",
    "2026-11-07 23:58 +01",
    "2026-11-07 3:58:04",
    "2026-11-07 23:58:04 −01:00",
  ]) {
    assert.equal(err(bad), SHAPE, bad);
  }
  assert.equal(err("1969-01-01 00:00:00 +00:00"), YEAR);
  assert.equal(err("2100-01-01 00:00:00 +00:00"), YEAR);
  assert.equal(err("1969-13-40 25:00:00 +15:00"), YEAR);
  assert.equal(err("2026-13-01 00:00:00 +00:00"), "Month must be 01 to 12.");
  assert.equal(err("2026-00-01 00:00:00 +00:00"), "Month must be 01 to 12.");
  assert.equal(err("2026-02-29 00:00:00 +00:00"), "February 2026 has 28 days.");
  assert.equal(err("2026-04-31 00:00:00 +00:00"), "April 2026 has 30 days.");
  assert.equal(err("2026-04-00 00:00:00 +00:00"), "April 2026 has 30 days.");
  assert.equal(err("2026-04-31 25:00:00 +00:00"), "April 2026 has 30 days.");
  assert.equal(err("2026-11-07 24:00:00 +00:00"), TIME);
  assert.equal(err("2026-11-07 23:60:00 +00:00"), TIME);
  assert.equal(err("2026-11-07 23:59:60 +00:00"), TIME);
  for (const off of ["+05:75", "+0575", "+15:60"]) {
    assert.equal(err(`2026-11-07 12:00:00 ${off}`), OFFSET_MINUTES, off);
  }
  for (const off of ["+14:01", "-12:01", "+15:00"]) {
    assert.equal(err(`2026-11-07 12:00:00 ${off}`), OFFSET_RANGE, off);
  }
  // 7a: the user typed no offset, so rule 7 would blame one they never typed.
  assert.equal(
    err("2026-11-07 12:00:00", 900),
    "This commit's offset +15:00 can't be kept. Add an offset between -12:00 and +14:00.",
  );
  assert.equal(
    err("2026-11-07 12:00:00", -750),
    "This commit's offset -12:30 can't be kept. Add an offset between -12:00 and +14:00.",
  );
  assert.equal(err("1970-01-01 00:59:59 +01:00"), BEFORE_EPOCH);
});

// Negative control (run once, reverted): returning null from typedFields when
// INPUT_RE misses sends every default-form case below to the shape error.
test("git's default date format reads, with or without weekday and label", () => {
  const iso = ok("2026-11-09 00:28:33 -05:00");
  const want = d(utc(2026, 11, 9, 5, 28, 33), -300);
  assert.deepEqual(iso.date, want);
  for (const text of [
    "Mon Nov 9 00:28:33 2026 -0500",
    "Nov 9 00:28:33 2026 -0500",
    "Mon Nov  9 00:28:33 2026 -05:00",
    "mon NOV 09 00:28:33 2026 -0500",
    "Date:   Mon Nov 9 00:28:33 2026 -0500",
    "AuthorDate: Mon Nov 9 00:28:33 2026 -0500",
    "CommitDate: Nov 9 00:28:33 2026 -0500",
    "Date:   2026-11-09 00:28:33 -0500",
    "  Date:   Mon Nov 9 00:28:33 2026 -0500  ",
    "Date:\tMon\tNov 9 00:28:33\t2026 -0500",
  ]) {
    const r = ok(text);
    assert.deepEqual(r.date, want, text);
    assert.equal(r.offsetAssumed, false, text);
    assert.equal(formatCommitDate(r.date), formatCommitDate(iso.date), text);
  }
  // The weekday is read but never checked against the date.
  assert.deepEqual(ok("Fri Nov 9 00:28:33 2026 -0500").date, want);
  const assumed = ok("Mon Nov 9 00:28:33 2026", -300);
  assert.equal(assumed.offsetAssumed, true);
  assert.deepEqual(assumed.date, want);
});

// Negative control (run once, reverted): INPUT_RE's separators back to ` +`
// sends the tab cases to the shape error.
test("the ISO-like form takes tabs where it takes spaces", () => {
  const want = d(utc(2026, 11, 1, 3, 30, 0), 330);
  for (const text of [
    "2026-11-01\t09:00:00 +05:30",
    "2026-11-01 09:00:00\t+05:30",
    "Date:\t2026-11-01\t09:00:00\t+0530",
  ]) {
    assert.deepEqual(ok(text).date, want, text);
  }
});

test("git's default format runs the same rules in the same order", () => {
  for (const bad of [
    "Mon Foo 9 00:28:33 2026 -0500",
    "Xyz Nov 9 00:28:33 2026 -0500",
    "Mon Nov 9 00:28 2026 -0500",
    "Mon Nov 123 00:28:33 2026 -0500",
    "Mon Nov 9 00:28:33 26 -0500",
    "Mon Nov 9 00:28:33 2026 Z",
    "Date: ",
    "Author: Mon Nov 9 00:28:33 2026 -0500",
  ]) {
    assert.equal(err(bad), SHAPE, bad);
  }
  assert.equal(err("Mon Nov 9 00:28:33 2100 -0500"), YEAR);
  assert.equal(err("Wed Dec 31 23:00:00 1969 -0100"), YEAR);
  assert.equal(err("Feb 29 00:00:00 2026 +0000"), "February 2026 has 28 days.");
  assert.equal(err("Apr 0 00:00:00 2026 +0000"), "April 2026 has 30 days.");
  assert.equal(err("Nov 9 24:00:00 2026 +0000"), TIME);
  assert.equal(err("Nov 9 12:00:00 2026 +0575"), OFFSET_MINUTES);
  assert.equal(err("Nov 9 12:00:00 2026 +1500"), OFFSET_RANGE);
  assert.equal(err("Jan 1 00:59:59 1970 +0100"), BEFORE_EPOCH);
});

test("the named year-boundary cases", () => {
  assert.deepEqual(ok("1970-01-01 00:00:00 +00:00").date, d(0, 0));
  assert.equal(err("1970-01-01 00:59:59 +01:00"), BEFORE_EPOCH);
  assert.deepEqual(ok("1970-01-01 01:00:00 +01:00").date, d(0, 60));
  assert.equal(err("1969-12-31 23:00:00 -01:00"), YEAR);
  assert.deepEqual(
    ok("2099-12-31 23:59:59 -12:00").date,
    d(COMMIT_DATE_MAX_EPOCH, -720),
  );
  assert.equal(err("2100-01-01 00:00:00 +14:00"), YEAR);
  ok("2024-02-29 12:00:00 +00:00");
  assert.equal(err("2026-02-29 12:00:00 +00:00"), "February 2026 has 28 days.");
});

test("inEditableRange matches the Rust bounds", () => {
  assert.equal(inEditableRange(d(0, -720)), true);
  assert.equal(inEditableRange(d(COMMIT_DATE_MAX_EPOCH, 840)), true);
  assert.equal(inEditableRange(d(-1, 0)), false);
  assert.equal(inEditableRange(d(COMMIT_DATE_MAX_EPOCH + 1, 0)), false);
  assert.equal(inEditableRange(d(0, -721)), false);
  assert.equal(inEditableRange(d(0, 841)), false);
});

test("commitDateFromIso reads git's strict ISO output only", () => {
  assert.deepEqual(
    commitDateFromIso("2026-11-07T23:58:04+01:00"),
    d(utc(2026, 11, 7, 22, 58, 4), 60),
  );
  assert.deepEqual(
    commitDateFromIso("2026-11-07T23:58:04-03:30"),
    d(utc(2026, 11, 8, 3, 28, 4), -210),
  );
  assert.deepEqual(
    commitDateFromIso("2026-11-07T23:58:04Z"),
    d(utc(2026, 11, 7, 23, 58, 4), 0),
  );
  assert.equal(
    Object.is(commitDateFromIso("2026-11-07T23:58:04-00:00").offsetMinutes, 0),
    true,
  );
  // git stores out-of-range offsets; the reader keeps them.
  assert.deepEqual(
    commitDateFromIso("2026-11-07T23:58:04+15:00"),
    d(utc(2026, 11, 7, 8, 58, 4), 900),
  );
  for (const bad of [
    "2026-11-07T23:58:04",
    "garbage",
    "",
    "2026-11-07 23:58:04 +01:00",
    "2100-01-01T00:00:00+00:00",
    "1969-12-31T23:59:59+00:00",
    "2026-02-30T00:00:00+00:00",
    "2026-11-07T23:58:04+05:75",
  ]) {
    assert.equal(commitDateFromIso(bad), null, bad);
  }
});

test("sameCommitDate needs the same instant AND the same offset", () => {
  assert.equal(sameCommitDate(d(5, 60), d(5, 60)), true);
  assert.equal(sameCommitDate(d(5, 60), d(5, 0)), false);
  assert.equal(sameCommitDate(d(5, 60), d(6, 60)), false);
});

test("calendar text is rendered in the date's own offset", () => {
  const at = d(utc(2026, 11, 7, 22, 58, 4), 60);
  assert.equal(describeCommitDate(at), "Sat 7 Nov 2026, 23:58:04, UTC+01:00");
  assert.equal(
    describeCommitDate(d(utc(2026, 11, 8, 3, 28, 4), -210)),
    "Sat 7 Nov 2026, 23:58:04, UTC-03:30",
  );
  assert.equal(rowDateLabel(at, Date.UTC(2026, 5, 15)), "Nov 7, 23:58");
  assert.equal(rowDateLabel(at, Date.UTC(2027, 5, 15)), "Nov 7, 2026");
});

test("nowCommitDate floors to whole seconds and keeps the machine offset", () => {
  assert.deepEqual(
    nowCommitDate(1_700_000_000_999, 330),
    d(1_700_000_000, 330),
  );
});

test("a pick replaces one component and keeps the other and the offset", () => {
  const base = ok("2026-11-07 23:58:04 -03:30").date;
  assert.equal(
    formatCommitDate(withPickedDate(base, "2025-02-03")),
    "2025-02-03 23:58:04 -03:30",
  );
  assert.equal(
    formatCommitDate(withPickedTime(base, "08:15")),
    "2026-11-07 08:15:00 -03:30",
  );
  assert.equal(
    formatCommitDate(withPickedTime(base, "08:15:30")),
    "2026-11-07 08:15:30 -03:30",
  );
  for (const bad of ["", "2025-02-30", "2025-2-3", "garbage"]) {
    assert.equal(withPickedDate(base, bad), null, bad);
  }
  for (const bad of ["", "24:00", "8:15", "08:60:00"]) {
    assert.equal(withPickedTime(base, bad), null, bad);
  }
});

const EQUAL = { author: d(1_762_000_000, 60), committer: d(1_762_000_000, 60) };
const DIFFER = {
  author: d(1_762_000_000, 60),
  committer: d(1_762_100_000, -480),
};
const draft = (author, same, committer = "") => ({ author, same, committer });

test("the default is ticked iff both dates match in instant and offset", () => {
  assert.equal(resolveDates(EQUAL, undefined).same, true);
  assert.equal(resolveDates(DIFFER, undefined).same, false);
  assert.equal(
    resolveDates(
      { author: d(1_762_000_000, 60), committer: d(1_762_000_000, 0) },
      undefined,
    ).same,
    false,
  );
});

test("an untouched draft changes nothing and sends no fields", () => {
  for (const original of [EQUAL, DIFFER]) {
    const none = resolveDates(original, undefined);
    assert.equal(none.changed, false);
    assert.equal("authorDate" in none, false);
    assert.equal("committerDate" in none, false);
    assert.equal(none.authorError, null);
    assert.equal(none.committerError, null);
    const typedBack = resolveDates(
      original,
      draft(
        formatCommitDate(original.author),
        sameCommitDate(original.author, original.committer),
        formatCommitDate(original.committer),
      ),
    );
    assert.equal(typedBack.changed, false);
    assert.equal("authorDate" in typedBack, false);
    assert.equal("committerDate" in typedBack, false);
  }
  // Another spelling of the same value is untouched too.
  const respelled = resolveDates(
    EQUAL,
    draft(formatCommitDate(EQUAL.author).replace(" ", "T"), true),
  );
  assert.equal(respelled.changed, false);
});

test("an author change on an equal-dates commit sends both dates", () => {
  const r = resolveDates(EQUAL, draft("2026-01-02 03:04:05 +01:00", true));
  const want = d(utc(2026, 1, 2, 2, 4, 5), 60);
  assert.equal(r.changed, true);
  assert.deepEqual(r.authorDate, want);
  assert.deepEqual(r.committerDate, want);
  assert.deepEqual(r.planned, { author: want, committer: want });
});

test("an unticked author change sends the committer date it shows", () => {
  const r = resolveDates(
    DIFFER,
    draft("2026-01-02 03:04:05", false, formatCommitDate(DIFFER.committer)),
  );
  assert.deepEqual(r.authorDate, d(utc(2026, 1, 2, 2, 4, 5), 60));
  assert.deepEqual(r.committerDate, DIFFER.committer);
});

test("ticking on a differing commit sends only the committer date", () => {
  const r = resolveDates(DIFFER, draft(formatCommitDate(DIFFER.author), true));
  assert.equal(r.changed, true);
  assert.equal("authorDate" in r, false);
  assert.deepEqual(r.committerDate, DIFFER.author);
});

test("an untouched out-of-range original yields no error and is never sent", () => {
  const far = {
    author: d(4_102_500_000, 900),
    committer: d(4_102_500_000, 900),
  };
  const none = resolveDates(far, undefined);
  assert.equal(none.authorError, null);
  assert.equal(none.changed, false);
  assert.deepEqual(none.planned.author, far.author);

  const mixed = {
    author: d(1_762_000_000, 60),
    committer: d(1_762_000_000, 900),
  };
  const r = resolveDates(
    mixed,
    draft(
      "2026-01-02 03:04:05 +01:00",
      false,
      formatCommitDate(mixed.committer),
    ),
  );
  assert.equal(r.committerError, null);
  assert.deepEqual(r.authorDate, d(utc(2026, 1, 2, 2, 4, 5), 60));
  assert.equal("committerDate" in r, false);
});

test("a field in error sends nothing and nulls its planned value", () => {
  const r = resolveDates(EQUAL, draft("2026-02-29 00:00:00", true));
  assert.equal(r.authorError, "February 2026 has 28 days.");
  assert.equal(r.committerError, null);
  assert.equal(r.changed, true);
  assert.equal("authorDate" in r, false);
  assert.equal("committerDate" in r, false);
  assert.deepEqual(r.planned, { author: null, committer: null });

  const c = resolveDates(
    DIFFER,
    draft(formatCommitDate(DIFFER.author), false, "nope"),
  );
  assert.equal(c.authorError, null);
  assert.equal(c.committerError, SHAPE);
  assert.equal("authorDate" in c, false);
  assert.deepEqual(c.planned.author, DIFFER.author);
  assert.equal(c.planned.committer, null);
});

// Negative control (run once, reverted): dropping wallClock's invalid-Date
// check makes the formatters print NaN and rowDateLabel throw.
test("a date past the JS Date range reads as unreadable and formats without NaN", () => {
  const max = 8_640_000_000_000;
  for (const forged of [d(max, 60), d(-max, -60)]) {
    assert.equal(readableCommitDate(forged), null);
    for (const text of [
      formatCommitDate(forged),
      describeCommitDate(forged),
      rowDateLabel(forged, Date.UTC(2026, 5, 15)),
    ]) {
      assert.equal(text, UNREADABLE_DATE_TEXT);
    }
    assert.equal(withPickedDate(forged, "2026-01-02"), null);
    assert.equal(withPickedTime(forged, "08:15"), null);
  }
  assert.equal(readableCommitDate(d(Number.NaN, 0)), null);
  assert.equal(readableCommitDate(null), null);
  // The edge itself still has a wall clock.
  assert.deepEqual(readableCommitDate(d(max, 0)), d(max, 0));
  assert.deepEqual(
    commitDateFromIso("2026-11-07T23:58:04+01:00"),
    d(utc(2026, 11, 7, 22, 58, 4), 60),
  );
});

// Negative control (run once, reverted): comparing against `nowMs` with no
// slack makes the 60-second case warn.
test("dateWarnings: future only past a minute's slack, and author after committer", () => {
  const nowMs = 1_700_000_000_000;
  const now = nowMs / 1000;
  const pair = (a, c) => ({ author: a, committer: c });
  assert.deepEqual(
    dateWarnings(pair(d(now + 60, 0), d(now + 60, 0)), nowMs),
    [],
  );
  assert.deepEqual(dateWarnings(pair(d(now + 61, 0), d(now + 61, 0)), nowMs), [
    FUTURE_WARNING,
  ]);
  assert.deepEqual(dateWarnings(pair(null, d(now + 61, 0)), nowMs), [
    FUTURE_WARNING,
  ]);
  assert.deepEqual(dateWarnings(pair(d(now - 10, 0), d(now - 20, 0)), nowMs), [
    AUTHOR_LATER_WARNING,
  ]);
  assert.deepEqual(dateWarnings(pair(d(now + 99, 0), d(now + 61, 0)), nowMs), [
    FUTURE_WARNING,
    AUTHOR_LATER_WARNING,
  ]);
  assert.deepEqual(dateWarnings(pair(null, null), nowMs), []);
});

test("sameUnreachableNote names a tick that can't set the committer date", () => {
  const far = d(4_102_500_000, 900);
  const original = { author: far, committer: d(1_762_000_000, 60) };
  const ticked = resolveDates(original, draft(formatCommitDate(far), true));
  assert.equal(ticked.changed, false);
  assert.equal(sameUnreachableNote(original, ticked), SAME_UNREACHABLE_NOTE);
  const unticked = resolveDates(original, undefined);
  assert.equal(sameUnreachableNote(original, unticked), null);
  const equal = { author: far, committer: far };
  assert.equal(
    sameUnreachableNote(equal, resolveDates(equal, undefined)),
    null,
  );
  assert.equal(
    sameUnreachableNote(EQUAL, resolveDates(EQUAL, undefined)),
    null,
  );
});

test("the shared copy keeps its wording", () => {
  assert.equal(
    DATE_FORMAT_HINT,
    "Year-month-day, 24-hour time, UTC offset. Pasting a date from git log works.",
  );
  assert.equal(
    OUT_OF_RANGE_NOTE,
    "Outside the editable range, so it can't be kept: Git sets it to the time of the change.",
  );
  assert.equal(FUTURE_WARNING, "This date is in the future.");
  assert.equal(
    AUTHOR_LATER_WARNING,
    "The author date is later than the committer date.",
  );
  assert.equal(FIX_DATE_FIRST, "Fix the date first.");
});
