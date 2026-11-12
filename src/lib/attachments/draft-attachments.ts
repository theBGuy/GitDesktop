// The attachment store's pure transitions. Import-free, so the installless
// `scripts/attachment-drafts.test.mjs` suite loads it under type stripping; the
// store applies each result's side effects (discards, revokes, held copies).

export interface StagedRecord {
  name: string;
  mime: string;
  size: number;
  width: number;
  height: number;
  /** The one object URL every local render of this image reads. */
  url: string;
}

export interface DraftStatus {
  tone: "warning" | "info";
  text: string;
  /** A held attach's reason: it reads only while that same reason still holds
   *  the draft, and retires once it no longer does. */
  held?: true;
}

export interface DraftEntry {
  /** The host instance whose draft this is; any other owner reads it as absent. */
  owner: object;
  /** Fresh per draft: a stage started under another gen lands nowhere. */
  gen: object;
  /** Rust's staging session, null until the first stage returns. */
  session: string | null;
  images: StagedRecord[];
  /** The names riding this draft's in-flight post; empty when none. */
  posting: string[];
  notice: { failed: string[] } | null;
  status: DraftStatus | null;
  /** An end asked for mid-post, run at the post's settle. */
  releaseDeferred: boolean;
  /** Names staged since the current attach gesture began: their references
   *  may not have reached the text yet, so a cap reclaim never takes them. */
  fresh: string[];
  /** Names a cap reclaim discarded. A post whose text still references one
   *  sends it, so Rust refuses it as no longer attached. */
  reclaimed: string[];
}

export function newEntry(owner: object): DraftEntry {
  return {
    owner,
    gen: {},
    session: null,
    images: [],
    posting: [],
    notice: null,
    status: null,
    releaseDeferred: false,
    fresh: [],
    reclaimed: [],
  };
}

/** A stage's record joins the entry; one already holding its name is replaced
 *  (a swept session numbers from `image-1` again), and its URL revoked. The
 *  name is fresh for the gesture and, once reclaimed, is a live record again. */
export function withStaged(
  entry: DraftEntry,
  session: string,
  record: StagedRecord,
): { entry: DraftEntry; revoke: string[] } {
  const revoke = entry.images
    .filter((i) => i.name === record.name)
    .map((i) => i.url);
  return {
    entry: {
      ...entry,
      session,
      images: [...entry.images.filter((i) => i.name !== record.name), record],
      fresh: [...entry.fresh.filter((n) => n !== record.name), record.name],
      reclaimed: entry.reclaimed.filter((n) => n !== record.name),
    },
    revoke,
  };
}

/** A new attach gesture's boundary: the fresh set clears only when no stage is
 *  in flight, so an overlapping gesture never exposes another's fresh names. */
export function startGesture(
  entry: DraftEntry,
  stagesInFlight: number,
): DraftEntry {
  return {
    ...entry,
    status: null,
    fresh: stagesInFlight === 0 ? [] : entry.fresh,
  };
}

/** The staged names a cap reclaim may discard: neither referenced by the text
 *  nor fresh. None while a post is in flight. */
export function reclaimable(
  entry: DraftEntry,
  referenced: readonly string[],
): string[] {
  if (entry.posting.length > 0) return [];
  return entry.images
    .map((i) => i.name)
    .filter((n) => !referenced.includes(n) && !entry.fresh.includes(n));
}

/** Drops discarded records from the entry and remembers their names. Every
 *  set here compares names exactly: a case variant is another file, and a
 *  folded match would drop a reference Rust must refuse. */
export function withoutRecords(
  entry: DraftEntry,
  names: readonly string[],
): { entry: DraftEntry; revoke: string[] } {
  const gone = entry.images.filter((i) => names.includes(i.name));
  const remembered = gone
    .map((i) => i.name)
    .filter((n) => !entry.reclaimed.includes(n));
  return {
    entry: {
      ...entry,
      images: entry.images.filter((i) => !names.includes(i.name)),
      reclaimed: [...entry.reclaimed, ...remembered],
    },
    revoke: gone.map((i) => i.url),
  };
}

/** The names a post may send: the live records', then each reclaimed name no
 *  live record holds. */
export function postCandidates(entry: DraftEntry): string[] {
  const live = entry.images.map((i) => i.name);
  return [...live, ...entry.reclaimed.filter((r) => !live.includes(r))];
}

/** What ending a draft does, or the deferral a post in flight forces. */
export type EndResult =
  | { deferred: true; entry: DraftEntry }
  | { deferred: false; session: string | null; revoke: string[] };

export function endTransition(entry: DraftEntry): EndResult {
  if (entry.posting.length > 0)
    return { deferred: true, entry: { ...entry, releaseDeferred: true } };
  return {
    deferred: false,
    session: entry.session,
    revoke: entry.images.map((i) => i.url),
  };
}

/** Marks a post of `names` in flight, or null when nothing staged rides it or a
 *  post is already in flight. */
export function beginTransition(
  entry: DraftEntry,
  names: readonly string[],
): DraftEntry | null {
  if (entry.posting.length > 0 || names.length === 0 || entry.session === null)
    return null;
  return { ...entry, posting: [...names], notice: null, status: null };
}

export interface SettleOutcome {
  posted: boolean;
  failed: readonly string[];
  /** End everything and discard the whole session (Create PR's partial). */
  discardFailed?: boolean;
}

export interface SettleResult {
  /** The entry after the settle; null when the draft ended. */
  entry: DraftEntry | null;
  /** Names to discard, the whole session, or nothing. */
  discard: string[] | "session" | null;
  /** Posted records whose URLs outlive the entry on a comment surface. */
  hold: StagedRecord[];
  /** URLs to revoke now. */
  revoke: string[];
}

/**
 * A post's settle. Not posted: the draft is as it was (Rust kept every file).
 * Landed: the entry ends, unless some images failed, which stay as the draft
 * with a notice while every other record is discarded (removed chips included,
 * so no hidden file counts toward the cap). A deferred end runs here.
 */
export function settleTransition(
  entry: DraftEntry,
  ticketNames: readonly string[],
  outcome: SettleOutcome,
): SettleResult {
  const failed = new Set(outcome.failed);
  const cleared = { ...entry, posting: [] };
  if (!outcome.posted) {
    if (!entry.releaseDeferred)
      return { entry: cleared, discard: null, hold: [], revoke: [] };
    return {
      entry: null,
      discard: entry.session === null ? null : "session",
      hold: [],
      revoke: entry.images.map((i) => i.url),
    };
  }
  const posted = entry.images.filter(
    (i) => ticketNames.includes(i.name) && !failed.has(i.name),
  );
  const endAll =
    failed.size === 0 ||
    outcome.discardFailed === true ||
    entry.releaseDeferred;
  if (endAll)
    return {
      entry: null,
      discard: entry.session === null ? null : "session",
      hold: posted,
      revoke: entry.images.filter((i) => !posted.includes(i)).map((i) => i.url),
    };
  const kept = entry.images.filter((i) => failed.has(i.name));
  const dropped = entry.images.filter((i) => !failed.has(i.name));
  return {
    entry: {
      ...cleared,
      images: kept,
      notice: { failed: kept.map((i) => i.name) },
      status: null,
    },
    discard: dropped.length > 0 ? dropped.map((i) => i.name) : null,
    hold: posted,
    revoke: dropped.filter((i) => !posted.includes(i)).map((i) => i.url),
  };
}
