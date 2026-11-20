import { useState } from "react";
import type { MergeStrategy } from "@/lib/git/api";
import { FULL_OID_RE } from "@/lib/git/oid";
import type {
  MergeCommitKind,
  MergeMessage,
  MergeMessageDefaults,
} from "@/lib/git/types";

/** The one spelling of each strategy's label, read by both merge views. */
export const MERGE_LABEL: Record<MergeStrategy, string> = {
  merge: "Create a merge commit",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
  fast_forward: "Fast-forward",
};

/** Why an open dialog's merge method holds its confirm, worded as the Merge
 *  menu's items are, for both merge views. */
export const MERGE_METHOD_RULE_REASON =
  "A branch rule blocks this merge method.";
export const MERGE_METHOD_SETTINGS_REASON =
  "This merge method is disabled in repository settings.";

/** The head an edited merge binds to: the full commit id the plan's defaults
 *  were read at, else `undefined` (the caller keeps the view's head). */
export function planHeadSha(plan: MergeMessagePlan): string | undefined {
  if (plan.state !== "ready") return undefined;
  const sha = plan.defaults.headSha;
  return typeof sha === "string" && FULL_OID_RE.test(sha) ? sha : undefined;
}

/** What the dialog knows about the commits a merge writes. */
export type MergeMessagePlan =
  | { state: "loading" }
  | { state: "offline" }
  | { state: "failed"; onRetry: () => void }
  | { state: "ready"; defaults: MergeMessageDefaults };

/** Pure. data: ready; else failed: failed; else paused: offline; else loading. */
export function mergeMessagePlan(read: {
  data: MergeMessageDefaults | undefined;
  failed: boolean;
  paused: boolean;
  onRetry: () => void;
}): MergeMessagePlan {
  if (read.data !== undefined) return { state: "ready", defaults: read.data };
  if (read.failed) return { state: "failed", onRetry: read.onRetry };
  if (read.paused) return { state: "offline" };
  return { state: "loading" };
}

const CRLF = /\r\n/g;
const LEADING_NEWLINES = /^\n+/;

/** Rust's `char::is_whitespace` (Unicode White_Space) by code point, so both
 *  sides agree on what is empty and what is changed. JS `trim` differs: it
 *  trims U+FEFF and keeps U+0085. */
function isRustWhitespace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

function trimEndRust(s: string): string {
  let end = s.length;
  while (end > 0 && isRustWhitespace(s.charCodeAt(end - 1))) end--;
  return s.slice(0, end);
}

function trimRust(s: string): string {
  const t = trimEndRust(s);
  let start = 0;
  while (start < t.length && isRustWhitespace(t.charCodeAt(start))) start++;
  return t.slice(start);
}

/** The twin of Rust's `trim`. */
export function normalizeTitle(s: string): string {
  return trimRust(s);
}

/** CRLF to LF, every leading LF stripped, trailing whitespace trimmed: the twin
 *  of Rust's `normalize_merge_body`, so a body the dialog calls changed is the
 *  body the backend sends. */
export function normalizeBody(s: string): string {
  return trimEndRust(s.replace(CRLF, "\n").replace(LEADING_NEWLINES, ""));
}

/** Pure. `title`, or `title\n\nbody` when the normalised body is non-empty (the
 *  TS twin of Rust's merge_message_text). */
export function mergeMessageText(m: MergeMessage): string {
  const title = normalizeTitle(m.title);
  const body = normalizeBody(m.body);
  return body === "" ? title : `${title}\n\n${body}`;
}

/** The normalised title's length in code points, as the backend counts it
 *  (Rust's `chars().count()`), not in UTF-16 units. */
export function titleLength(title: string): number {
  return Array.from(normalizeTitle(title)).length;
}

/** Lines of the normalised body, blank lines included; 0 for an empty body. */
export function bodyLineCount(body: string): number {
  const normalized = normalizeBody(body);
  return normalized === "" ? 0 : normalized.split("\n").length;
}

/** One open editor: what the user typed, the default it started from, and
 *  which fields the user owns. Ownership is recorded at each change, since a
 *  newer default can briefly equal the typed text and equality would then hand
 *  the field back to the defaults. */
export type RowDraft = {
  title: string;
  body: string;
  baseline: MergeMessage | null;
  titleOwned: boolean;
  bodyOwned: boolean;
};
type MergeDraftRows = Partial<Record<MergeCommitKind, RowDraft>>;

export interface MergeMessageDraft {
  /** The plan every reader takes (the dialog, the hold, what to send): the
   *  live one, or this session's last ready one while the live read isn't. */
  plan: MergeMessagePlan;
  rows: MergeDraftRows;
  edit: (kind: MergeCommitKind) => void;
  change: (
    kind: MergeCommitKind,
    patch: Partial<Pick<RowDraft, "title" | "body">>,
  ) => void;
  resetRow: (kind: MergeCommitKind) => void;
  /** Closes every row and forgets the last ready plan. */
  reset: () => void;
}

interface MergeMessagesToSend {
  squashMessage?: MergeMessage;
  mergeMessage?: MergeMessage;
}

/** The plan's current default for `kind`: `undefined` unless a ready plan lists
 *  the kind (nothing is known), `null` when the forge's text is unknown. */
function planDefault(
  plan: MergeMessagePlan,
  kind: MergeCommitKind,
): MergeMessage | null | undefined {
  if (plan.state !== "ready") return undefined;
  const commit = plan.defaults.commits.find((c) => c.kind === kind);
  return commit === undefined ? undefined : commit.message;
}

/** Pure. The row differs from the default it last took, after normalisation. */
export function rowChanged(row: RowDraft): boolean {
  return (
    normalizeTitle(row.title) !== normalizeTitle(row.baseline?.title ?? "") ||
    normalizeBody(row.body) !== normalizeBody(row.baseline?.body ?? "")
  );
}

function sameMessage(a: MergeMessage | null, b: MergeMessage | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    normalizeTitle(a.title) === normalizeTitle(b.title) &&
    normalizeBody(a.body) === normalizeBody(b.body)
  );
}

function seeded(message: MergeMessage | null): RowDraft {
  return {
    title: message?.title ?? "",
    body: message?.body ?? "",
    baseline: message,
    titleOwned: false,
    bodyOwned: false,
  };
}

/** Pure. Applies a typed patch; a patched field is owned while its text
 *  differs from the row's current baseline (an unknown one reads as empty). */
function changed(
  row: RowDraft,
  patch: Partial<Pick<RowDraft, "title" | "body">>,
): RowDraft {
  const next = { ...row, ...patch };
  if (patch.title !== undefined)
    next.titleOwned =
      normalizeTitle(patch.title) !== normalizeTitle(row.baseline?.title ?? "");
  if (patch.body !== undefined)
    next.bodyOwned =
      normalizeBody(patch.body) !== normalizeBody(row.baseline?.body ?? "");
  return next;
}

function sameDefaults(
  a: MergeMessageDefaults | null,
  b: MergeMessageDefaults,
): boolean {
  if (a === b) return true;
  if (a === null || a.reason !== b.reason) return false;
  // The head too: a re-read at a moved head with the same text must still
  // replace the last ready plan, whose head an edited merge binds to.
  if ((a.headSha ?? null) !== (b.headSha ?? null)) return false;
  if (a.commits.length !== b.commits.length) return false;
  return a.commits.every((c, i) => {
    const d = b.commits[i];
    return (
      c.kind === d.kind &&
      c.exact === d.exact &&
      c.message?.title === d.message?.title &&
      c.message?.body === d.message?.body
    );
  });
}

const KINDS: readonly MergeCommitKind[] = ["squash", "merge"];

/** Pure. An open row whose baseline differs from a ready plan's current default
 *  for its kind follows it per field: a field the user doesn't own takes the
 *  new default's value, an owned field keeps its text and its ownership (also
 *  when the new default equals that text, which an equality test would read as
 *  untouched), and the baseline moves to the new default, so an edited message
 *  re-read at a moved head carries the head's untouched parts.
 *  A default that turns unknown under a known baseline changes nothing, so a
 *  transient read never lifts a hold or blanks a row. A plan that lists nothing
 *  leaves rows as they are. Idempotent, so the render-time update below
 *  terminates. */
function followDefaults(
  rows: MergeDraftRows,
  plan: MergeMessagePlan,
): MergeDraftRows {
  let next = rows;
  for (const kind of KINDS) {
    const row = next[kind];
    if (row === undefined) continue;
    const current = planDefault(plan, kind);
    if (current === undefined || sameMessage(row.baseline, current)) continue;
    if (current === null) continue;
    next = {
      ...next,
      [kind]: {
        title: row.titleOwned ? row.title : current.title,
        body: row.bodyOwned ? row.body : current.body,
        baseline: current,
        titleOwned: row.titleOwned,
        bodyOwned: row.bodyOwned,
      },
    };
  }
  return next;
}

type DraftState = {
  rows: MergeDraftRows;
  /** The defaults of this session's last ready plan. A read that falls back to
   *  loading, failed or offline (a cache reset on an account change) must not
   *  hide open rows, lift their hold or drop their text from the merge; the
   *  backend re-checks every message it is sent. */
  lastReady: MergeMessageDefaults | null;
};
const EMPTY: DraftState = { rows: {}, lastReady: null };

/** State lives in the calling view. Takes the CURRENT plan so an open row's
 *  untouched fields can follow a newer default. */
export function useMergeMessageDraft(
  live: MergeMessagePlan,
): MergeMessageDraft {
  const [stored, setStored] = useState<DraftState>(EMPTY);
  // A render-time adjustment that settles in one extra pass: `lastReady` is
  // compared by content, and `followDefaults` is idempotent.
  let next = stored;
  if (live.state === "ready" && !sameDefaults(next.lastReady, live.defaults))
    next = { ...next, lastReady: live.defaults };
  const plan: MergeMessagePlan =
    live.state === "ready" || next.lastReady === null
      ? live
      : { state: "ready", defaults: next.lastReady };
  const rows = followDefaults(next.rows, plan);
  if (rows !== next.rows) next = { ...next, rows };
  if (next !== stored) setStored(next);

  const setRows = (update: (r: MergeDraftRows) => MergeDraftRows) =>
    setStored((s) => {
      const r = update(s.rows);
      return r === s.rows ? s : { ...s, rows: r };
    });

  return {
    plan,
    rows,
    edit: (kind) =>
      setRows((r) => ({
        ...r,
        [kind]: seeded(planDefault(plan, kind) ?? null),
      })),
    change: (kind, patch) =>
      setRows((r) => {
        const row = r[kind];
        return row === undefined ? r : { ...r, [kind]: changed(row, patch) };
      }),
    resetRow: (kind) =>
      setRows((r) => {
        const row = r[kind];
        if (row === undefined) return r;
        // Without a known default for the kind, the default the row last took
        // is the best known one.
        return {
          ...r,
          [kind]: seeded(planDefault(plan, kind) ?? row.baseline),
        };
      }),
    reset: () => setStored(EMPTY),
  };
}

const SEND_SLOT: Record<MergeCommitKind, keyof MergeMessagesToSend> = {
  squash: "squashMessage",
  merge: "mergeMessage",
};

/** Pure. What to send: for each commit in a READY plan whose row is open and
 *  changed. A closed or unchanged row, or one the plan no longer lists, sends
 *  nothing, so the forge writes its own default. */
export function mergeMessagesToSend(
  rows: MergeDraftRows,
  plan: MergeMessagePlan,
): MergeMessagesToSend {
  const out: MergeMessagesToSend = {};
  if (plan.state !== "ready") return out;
  for (const commit of plan.defaults.commits) {
    const row = rows[commit.kind];
    if (row === undefined || !rowChanged(row)) continue;
    out[SEND_SLOT[commit.kind]] = {
      title: normalizeTitle(row.title),
      body: normalizeBody(row.body),
    };
  }
  return out;
}

/** Pure. The first changed row (in plan order) whose title is blank, or null. */
export function mergeMessageHold(
  rows: MergeDraftRows,
  plan: MergeMessagePlan,
): MergeCommitKind | null {
  if (plan.state !== "ready") return null;
  for (const commit of plan.defaults.commits) {
    const row = rows[commit.kind];
    if (
      row !== undefined &&
      rowChanged(row) &&
      normalizeTitle(row.title) === ""
    )
      return commit.kind;
  }
  return null;
}
