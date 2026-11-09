import type { CommitDate } from "@/lib/git/types";

// Pure date model for the commit date editors. It stays free of runtime imports:
// scripts/commit-date.test.mjs loads it straight from src/ under Node's type
// stripping.

// The editable range, mirroring the Rust check in git/ops.rs. The typed-year rule
// below (1970-2099) is deliberately the narrower of the two.
export const COMMIT_DATE_MIN_EPOCH = 0;
export const COMMIT_DATE_MAX_EPOCH = 4_102_487_999;
export const COMMIT_DATE_MIN_OFFSET = -720;
export const COMMIT_DATE_MAX_OFFSET = 840;

const MIN_YEAR = 1970;
const MAX_YEAR = 2099;

export type DateRead =
  | { ok: true; date: CommitDate; offsetAssumed: boolean }
  | { ok: false; error: string };

const ERR_BLANK = "Enter a date as YYYY-MM-DD HH:MM:SS ±HH:MM.";
const ERR_SHAPE = "Use the form YYYY-MM-DD HH:MM:SS ±HH:MM.";
const ERR_YEAR = "The year must be between 1970 and 2099.";
const ERR_MONTH = "Month must be 01 to 12.";
const ERR_TIME = "Time must be between 00:00:00 and 23:59:59.";
const ERR_OFFSET_MINUTES = "Offset minutes must be 00 to 59.";
const ERR_OFFSET_RANGE = "Offsets run from -12:00 to +14:00.";
const ERR_BEFORE_EPOCH =
  "Dates before 1970-01-01 00:00:00 UTC can't be stored.";

// Copy both date editors share.
export const DATE_FORMAT_HINT =
  "Year-month-day, 24-hour time, UTC offset. Pasting a date from git log works.";
export const OUT_OF_RANGE_NOTE =
  "Outside the editable range, so it can't be kept: Git sets it to the time of the change.";
export const FUTURE_WARNING = "This date is in the future.";
export const AUTHOR_LATER_WARNING =
  "The author date is later than the committer date.";
export const FIX_DATE_FIRST = "Fix the date first.";
export const SAME_UNREACHABLE_NOTE =
  "The author date is outside the editable range, so the committer date can't be set to match it.";
/** What the formatters print for a date whose wall clock can't be computed. */
export const UNREADABLE_DATE_TEXT = "Unreadable date";

/** How far past "now" a date may sit before it warns as future: the shared
 *  clock snapshot lags the Now button by up to its 30 s refresh. */
const FUTURE_SLACK_SECONDS = 60;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// A pasted `git log` header label, stripped before either grammar is tried.
const LABEL_RE = /^(?:Date|AuthorDate|CommitDate):[ \t]+/;
// Date, then `T`/`t` or spaces, then HH:MM[:SS], then an optional offset (`Z`,
// `±HH:MM` or `±HHMM`) that spaces may precede. `git log --date=iso` and
// `--date=iso-strict` output both fit.
const INPUT_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt]| +)(\d{2}):(\d{2})(?::(\d{2}))?(?: *([Zz]|[+-]\d{2}:?\d{2}))?$/;
// git's default format: optional weekday, month name, day, HH:MM:SS, year, then
// an optional `±HHMM`/`±HH:MM` offset, fields split by spaces. Names are
// English 3-letter abbreviations in any case; the weekday is not checked
// against the date.
const DEFAULT_RE =
  /^(?:([A-Za-z]{3})[ \t]+)?([A-Za-z]{3})[ \t]+(\d{1,2})[ \t]+(\d{2}):(\d{2}):(\d{2})[ \t]+(\d{4})(?:[ \t]+([+-]\d{2}:?\d{2}))?$/;
const WEEKDAY_NAMES = WEEKDAYS.map((w) => w.toLowerCase());
const MONTH_NAMES = MONTHS.map((m) => m.slice(0, 3).toLowerCase());
// What git's %aI/%cI print. The offset is not range-checked: git stores `+15:00`.
const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/;

const pad2 = (n: number) => String(n).padStart(2, "0");

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeap(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

// setUTCFullYear, never Date.UTC: Date.UTC maps years 0-99 to 1900-1999.
function utcSeconds(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
): number {
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  t.setUTCHours(h, mi, s, 0);
  return Math.floor(t.getTime() / 1000);
}

/** Wall-clock fields of `d` in its OWN offset (never the machine's zone), or
 *  null when that instant is outside what a JS Date can hold. */
function wallClock(d: CommitDate) {
  const t = new Date((d.epochSeconds + d.offsetMinutes * 60) * 1000);
  if (Number.isNaN(t.getTime())) return null;
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
    second: t.getUTCSeconds(),
    weekday: t.getUTCDay(),
  };
}

// The sign belongs to the whole value: -210 prints `-03:30`.
function formatOffset(minutes: number): string {
  const abs = Math.abs(minutes);
  const sign = minutes < 0 ? "-" : "+";
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

function formatYear(year: number): string {
  return year < 0
    ? `-${String(-year).padStart(4, "0")}`
    : String(year).padStart(4, "0");
}

const offsetInRange = (m: number) =>
  m >= COMMIT_DATE_MIN_OFFSET && m <= COMMIT_DATE_MAX_OFFSET;

/** `d` when its wall clock can be computed, else null: every date entering the
 *  model passes this, so one forged value reads as unreadable, never NaN. */
export function readableCommitDate(d: CommitDate | null): CommitDate | null {
  if (d === null) return null;
  if (!Number.isFinite(d.epochSeconds) || !Number.isFinite(d.offsetMinutes)) {
    return null;
  }
  return wallClock(d) === null ? null : d;
}

/** Whether the backend accepts `d` (epoch and offset both in range). */
export function inEditableRange(d: CommitDate): boolean {
  return (
    d.epochSeconds >= COMMIT_DATE_MIN_EPOCH &&
    d.epochSeconds <= COMMIT_DATE_MAX_EPOCH &&
    offsetInRange(d.offsetMinutes)
  );
}

interface TypedFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** `Z`, `±HH:MM` or `±HHMM` as typed; undefined when left out. */
  offset: string | undefined;
}

/** The fields of either accepted shape, or null when `t` fits neither. */
function typedFields(t: string): TypedFields | null {
  const iso = INPUT_RE.exec(t);
  if (iso) {
    return {
      year: Number(iso[1]),
      month: Number(iso[2]),
      day: Number(iso[3]),
      hour: Number(iso[4]),
      minute: Number(iso[5]),
      second: iso[6] === undefined ? 0 : Number(iso[6]),
      offset: iso[7],
    };
  }
  const git = DEFAULT_RE.exec(t);
  if (!git) return null;
  if (git[1] !== undefined && !WEEKDAY_NAMES.includes(git[1].toLowerCase())) {
    return null;
  }
  const month = MONTH_NAMES.indexOf(git[2].toLowerCase()) + 1;
  if (month === 0) return null;
  return {
    year: Number(git[7]),
    month,
    day: Number(git[3]),
    hour: Number(git[4]),
    minute: Number(git[5]),
    second: Number(git[6]),
    offset: git[8],
  };
}

/**
 * Reads typed date text. Lenient in (a `T` separator, `±HHMM`, `Z`, missing
 * seconds, a `git log --date=iso` line, git's default `Mon Nov 9 00:28:33 2026
 * -0500` form, a leading `Date:`/`AuthorDate:`/`CommitDate:` label); the first
 * failing rule's sentence wins. A missing offset takes `fallbackOffsetMinutes`
 * (the commit's current one) and reports `offsetAssumed`.
 */
export function readCommitDate(
  text: string,
  fallbackOffsetMinutes: number,
): DateRead {
  const t = text.trim().replace(LABEL_RE, "");
  if (t === "") return { ok: false, error: ERR_BLANK };
  const m = typedFields(t);
  if (m === null) return { ok: false, error: ERR_SHAPE };
  const { year, month, day, hour, minute, second } = m;
  if (year < MIN_YEAR || year > MAX_YEAR) return { ok: false, error: ERR_YEAR };
  if (month < 1 || month > 12) return { ok: false, error: ERR_MONTH };
  const dim = daysInMonth(year, month);
  if (day < 1 || day > dim) {
    return {
      ok: false,
      error: `${MONTHS[month - 1]} ${year} has ${dim} days.`,
    };
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return { ok: false, error: ERR_TIME };
  }
  const typed = m.offset;
  let offset: number;
  if (typed === undefined) {
    if (!offsetInRange(fallbackOffsetMinutes)) {
      return {
        ok: false,
        error: `This commit's offset ${formatOffset(fallbackOffsetMinutes)} can't be kept. Add an offset between -12:00 and +14:00.`,
      };
    }
    offset = fallbackOffsetMinutes;
  } else if (typed === "Z" || typed === "z") {
    offset = 0;
  } else {
    const digits = typed.slice(1).replace(":", "");
    const oh = Number(digits.slice(0, 2));
    const om = Number(digits.slice(2));
    const total = (typed[0] === "-" ? -1 : 1) * (oh * 60 + om);
    if (om > 59) return { ok: false, error: ERR_OFFSET_MINUTES };
    if (!offsetInRange(total)) return { ok: false, error: ERR_OFFSET_RANGE };
    // `-00:00` would otherwise read as -0.
    offset = total === 0 ? 0 : total;
  }
  const epoch =
    utcSeconds(year, month, day, hour, minute, second) - offset * 60;
  if (epoch < COMMIT_DATE_MIN_EPOCH) {
    return { ok: false, error: ERR_BEFORE_EPOCH };
  }
  if (epoch > COMMIT_DATE_MAX_EPOCH) return { ok: false, error: ERR_YEAR };
  return {
    ok: true,
    date: { epochSeconds: epoch, offsetMinutes: offset },
    offsetAssumed: typed === undefined,
  };
}

/** The canonical text `YYYY-MM-DD HH:MM:SS ±HH:MM`, in the date's own offset. */
export function formatCommitDate(d: CommitDate): string {
  const w = wallClock(d);
  if (w === null) return UNREADABLE_DATE_TEXT;
  return `${formatYear(w.year)}-${pad2(w.month)}-${pad2(w.day)} ${pad2(w.hour)}:${pad2(w.minute)}:${pad2(w.second)} ${formatOffset(d.offsetMinutes)}`;
}

/**
 * Reads git's strict ISO output (%aI/%cI). Returns null for any other shape and
 * for a year outside 1970-2099: git's ISO printer is unreliable from 2100 on, so
 * such a value must not be re-sent as if it had been read.
 */
export function commitDateFromIso(iso: string): CommitDate | null {
  const m = ISO_RE.exec(iso);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  if (hour > 23 || minute > 59 || second > 59) return null;
  const z = m[7];
  let offset = 0;
  // Minutes past 59 are refused, as the backend's raw date reader refuses them.
  if (z !== "Z" && Number(z.slice(4, 6)) > 59) return null;
  const magnitude =
    z === "Z" ? 0 : Number(z.slice(1, 3)) * 60 + Number(z.slice(4, 6));
  // A zero magnitude stays +0: `-00:00` must not read as -0.
  if (magnitude !== 0) offset = z[0] === "-" ? -magnitude : magnitude;
  return readableCommitDate({
    epochSeconds:
      utcSeconds(year, month, day, hour, minute, second) - offset * 60,
    offsetMinutes: offset,
  });
}

/** Same instant AND same offset. */
export function sameCommitDate(a: CommitDate, b: CommitDate): boolean {
  return (
    a.epochSeconds === b.epochSeconds && a.offsetMinutes === b.offsetMinutes
  );
}

/** `Sat 7 Nov 2026, 23:58:04, UTC+01:00`, in the date's own offset. */
export function describeCommitDate(d: CommitDate): string {
  const w = wallClock(d);
  if (w === null) return UNREADABLE_DATE_TEXT;
  return `${WEEKDAYS[w.weekday]} ${w.day} ${MONTHS[w.month - 1].slice(0, 3)} ${formatYear(w.year)}, ${pad2(w.hour)}:${pad2(w.minute)}:${pad2(w.second)}, UTC${formatOffset(d.offsetMinutes)}`;
}

/**
 * A row's short label in the date's own offset: `Nov 7, 23:58` when its year is
 * the machine's current year (read from `nowMs`), else `Nov 7, 2025`.
 */
export function rowDateLabel(d: CommitDate, nowMs: number): string {
  const w = wallClock(d);
  if (w === null) return UNREADABLE_DATE_TEXT;
  const head = `${MONTHS[w.month - 1].slice(0, 3)} ${w.day}`;
  return w.year === new Date(nowMs).getFullYear()
    ? `${head}, ${pad2(w.hour)}:${pad2(w.minute)}`
    : `${head}, ${formatYear(w.year)}`;
}

/** "Now" in this machine's offset; `machineOffsetMinutes` is east-positive,
 *  i.e. `-new Date().getTimezoneOffset()`. */
export function nowCommitDate(
  nowMs: number,
  machineOffsetMinutes: number,
): CommitDate {
  return {
    epochSeconds: Math.floor(nowMs / 1000),
    offsetMinutes: machineOffsetMinutes,
  };
}

/** `base` with its calendar date replaced by a native date input's
 *  `YYYY-MM-DD`; time and offset kept. Null for any other value. */
export function withPickedDate(
  base: CommitDate,
  ymd: string,
): CommitDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  const w = wallClock(base);
  if (w === null) return null;
  return {
    epochSeconds:
      utcSeconds(year, month, day, w.hour, w.minute, w.second) -
      base.offsetMinutes * 60,
    offsetMinutes: base.offsetMinutes,
  };
}

/** `base` with its time replaced by a native time input's `HH:MM[:SS]`
 *  (missing seconds = 00); calendar date and offset kept. Null for any other
 *  value. */
export function withPickedTime(
  base: CommitDate,
  hms: string,
): CommitDate | null {
  const m = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(hms);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const second = m[3] === undefined ? 0 : Number(m[3]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const w = wallClock(base);
  if (w === null) return null;
  return {
    epochSeconds:
      utcSeconds(w.year, w.month, w.day, hour, minute, second) -
      base.offsetMinutes * 60,
    offsetMinutes: base.offsetMinutes,
  };
}

/** A commit's date editor draft: the typed texts and the "Same as author date"
 *  flag. */
export interface DateDraft {
  author: string;
  same: boolean;
  committer: string;
}

interface FieldRead {
  /** The field's value, or null while in error. */
  value: CommitDate | null;
  error: string | null;
}

// "Untouched" is decided on TEXT first, so an existing date outside the editable
// range opens clean and round-trips without ever being validated.
function readField(text: string, original: CommitDate): FieldRead {
  if (text === formatCommitDate(original)) {
    return { value: original, error: null };
  }
  const read = readCommitDate(text, original.offsetMinutes);
  return read.ok
    ? { value: read.date, error: null }
    : { value: null, error: read.error };
}

/**
 * What a commit's date draft means. A commit with any date change sends the
 * committer date it shows (any rewrite otherwise stamps it "now"); the author
 * date only when it differs. A value outside the editable range is never sent:
 * Rust would refuse it, and git then sets that date itself. While a field is in
 * error nothing is sent and `changed` stays true.
 */
export function resolveDates(
  original: { author: CommitDate; committer: CommitDate },
  draft: DateDraft | undefined,
): {
  changed: boolean;
  authorDate?: CommitDate;
  committerDate?: CommitDate;
  authorError: string | null;
  committerError: string | null;
  planned: { author: CommitDate | null; committer: CommitDate | null };
  same: boolean;
} {
  const same =
    draft?.same ?? sameCommitDate(original.author, original.committer);
  const author = readField(
    draft?.author ?? formatCommitDate(original.author),
    original.author,
  );
  const committer: FieldRead = same
    ? { value: author.value, error: null }
    : readField(
        draft?.committer ?? formatCommitDate(original.committer),
        original.committer,
      );
  const planned = { author: author.value, committer: committer.value };
  const base = {
    authorError: author.error,
    committerError: committer.error,
    planned,
    same,
  };
  if (author.value === null || committer.value === null) {
    return { ...base, changed: true };
  }
  const authorChanged = !sameCommitDate(author.value, original.author);
  const committerChanged = !sameCommitDate(committer.value, original.committer);
  const out: { authorDate?: CommitDate; committerDate?: CommitDate } = {};
  if (authorChanged || committerChanged) {
    if (authorChanged && inEditableRange(author.value)) {
      out.authorDate = author.value;
    }
    if (inEditableRange(committer.value)) out.committerDate = committer.value;
  }
  const changed =
    out.authorDate !== undefined || out.committerDate !== undefined;
  return { ...base, changed, ...out };
}

/** The warnings a planned pair raises, in display order. A date counts as
 *  future only past `FUTURE_SLACK_SECONDS` beyond `nowMs`. */
export function dateWarnings(
  planned: { author: CommitDate | null; committer: CommitDate | null },
  nowMs: number,
): string[] {
  const { author, committer } = planned;
  const limit = nowMs / 1000 + FUTURE_SLACK_SECONDS;
  const warnings: string[] = [];
  if (
    (author !== null && author.epochSeconds > limit) ||
    (committer !== null && committer.epochSeconds > limit)
  ) {
    warnings.push(FUTURE_WARNING);
  }
  if (
    author !== null &&
    committer !== null &&
    author.epochSeconds > committer.epochSeconds
  ) {
    warnings.push(AUTHOR_LATER_WARNING);
  }
  return warnings;
}

/** Why "Same as author date" changes nothing: ticked over an untouched author
 *  date outside the editable range, which the committer date can't be set to,
 *  while the commit's committer date differs from it. Null otherwise. */
export function sameUnreachableNote(
  original: { committer: CommitDate },
  resolved: { same: boolean; planned: { author: CommitDate | null } },
): string | null {
  const author = resolved.planned.author;
  return resolved.same &&
    author !== null &&
    !inEditableRange(author) &&
    !sameCommitDate(author, original.committer)
    ? SAME_UNREACHABLE_NOTE
    : null;
}
