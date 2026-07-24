import { useMemo, useSyncExternalStore } from "react";

// Hash routing ONLY — the LAN server serves a single `index.html` and does no
// history-API rewriting, so every route lives in `location.hash`.
//
// The selected repository is a first-class, URL-persisted concept (slice 4). The
// canonical scoped forms carry it:
//   #r/{repoId}/status · #r/{repoId}/prs · #r/{repoId}/prs/{n} · #r/{repoId}/ci ·
//   #r/{repoId}/ci/{id} · #r/{repoId}/agents · #r/{repoId}/agents/{streamId}
// Slice 6 adds four read-only surfaces (SCOPED-ONLY — no legacy repo-less forms):
//   #r/{repoId}/changes · #r/{repoId}/changes/{section}/{encodedFile}
//   #r/{repoId}/history · #r/{repoId}/history/{sha} · #r/{repoId}/history/{sha}/{encodedFile}
//   #r/{repoId}/branches
//   #r/{repoId}/issues · #r/{repoId}/issues/{n}
// The companion-extras slice adds three more read-only surfaces (also SCOPED-ONLY):
//   #r/{repoId}/tags
//   #r/{repoId}/todos
//   #r/{repoId}/discussions · #r/{repoId}/discussions/{n}
// Plus two global (repo-less) routes:
//   #pair   — the pairing takeover (unchanged)
//   #repos  — the repo picker
// Legacy single-repo hashes (`#status`, `#prs/{n}`, `#ci/{id}`, `#agents/{id}`)
// still parse — with `repoId: null` — so old bookmarks keep working; the shell
// redirects them to the scoped equivalent once it knows which repo to use. The
// slice-6 tabs are deliberately NOT part of the legacy grammar (an unknown head on
// the legacy branch degrades to status, exactly as before).
// Default (empty / unknown hash) resolves to #status with a null repoId.

export type Tab =
  | "status"
  | "prs"
  | "ci"
  | "agents"
  | "changes"
  | "history"
  | "branches"
  | "issues"
  | "tags"
  | "todos"
  | "discussions";

/** The working-tree section a Changes file-diff is scoped to. `unstaged` and
 *  `untracked` both map to the working-tree side server-side, but they're distinct
 *  routes so the file-diff fetch can pass the right `staged`/`untracked` flags. */
export type ChangesSection = "staged" | "unstaged" | "untracked";

const CHANGES_SECTIONS: readonly ChangesSection[] = [
  "staged",
  "unstaged",
  "untracked",
];

// A commit sha segment: 7–64 hex chars (64 covers SHA-256 object-format repos). A tail that fails this guard is treated as
// absent (`sha: null`) — the same "unknown detail → list" degradation the other
// tabs use — so a malformed sha never reaches a scoped commit URL.
const SHA_RE = /^[0-9a-f]{7,64}$/i;

// Agent-stream ids are opaque UUID-like STRINGS (not numbers like PR/CI ids), so
// they parse into their own `streamId` field. A conservative charset guard keeps
// a malformed tail from ever reaching an EventSource URL.
const STREAM_ID_RE = /^[0-9a-zA-Z-]{1,64}$/;

// A repo id is exactly 16 lowercase hex chars (the server's contract). A segment
// that fails this guard is treated as absent (`repoId: null`) — never trusted
// into a scoped URL — so a malformed `#r/…` tail degrades to the legacy meaning
// rather than crashing or hitting a route that can't exist.
const REPO_ID_RE = /^[0-9a-f]{16}$/;

/** Whether a string is a well-formed repo id (16 lowercase hex chars). Callers
 *  that build a scoped hash from a server-supplied id use this to avoid emitting
 *  a `#r/{bad}/…` that would just parse back to `repoId: null` and re-trigger a
 *  redirect loop. Shares the router's single grammar (never duplicate the RE). */
export function isRepoId(id: string): boolean {
  return REPO_ID_RE.test(id);
}

export interface Route {
  /** The active bottom-tab. Pair/repos are not tabs (full-screen takeovers). */
  tab: Tab;
  /** True when on the pairing screen (`#pair`). */
  isPairing: boolean;
  /** True when on the repo picker (`#repos`). */
  isRepos: boolean;
  /** The selected repository id (`#r/{repoId}/…`), else null. Null on the legacy
   *  single-repo hashes and the global `#pair`/`#repos` routes. Always either a
   *  valid 16-hex-char id or null — a malformed segment parses as null. */
  repoId: string | null;
  /** A selected PR number (`#…/prs/{n}`) or CI run id (`#…/ci/{id}`), else null. */
  detailId: number | null;
  /** A selected agent-stream id (`#…/agents/{id}`), else null. String because
   *  stream ids are UUID-like, not numeric. Only parsed on the agents tab. */
  streamId: string | null;
  /** The working-tree section a Changes file-diff is scoped to
   *  (`#…/changes/{section}/{file}`), else null. Null on every route but a
   *  changes file-diff route with a recognized section. */
  section: ChangesSection | null;
  /** A selected file path (`#…/changes/{section}/{file}`,
   *  `#…/history/{sha}/{file}`), already `decodeURIComponent`-decoded, else null. */
  filePath: string | null;
  /** A selected commit sha (`#…/history/{sha}[/…]`), else null. Only ever a
   *  7–64 hex-char string or null — a malformed sha segment parses as null. */
  sha: string | null;
  /** The raw normalized hash (without the leading `#`). */
  raw: string;
}

/** The tab-and-detail portion shared by both forms. Legacy hashes never carry a
 *  `section`/`filePath`/`sha` (the slice-6 tabs are scoped-only), so those stay
 *  null there; the scoped parse fills them from the trailing segments. */
interface TabParse {
  tab: Tab;
  detailId: number | null;
  streamId: string | null;
  section: ChangesSection | null;
  filePath: string | null;
  sha: string | null;
}

/** The all-null detail defaults every branch spreads over — keeps each `case`
 *  focused on the one or two fields its tab actually uses. */
const NO_DETAIL = {
  detailId: null,
  streamId: null,
  section: null,
  filePath: null,
  sha: null,
} as const;

/** Parse the `{tab}[/detail…]` portion shared by both the legacy and scoped forms.
 *  `head` is the tab segment, `tail` the first detail segment, `extra` the segment
 *  after that (only the scoped slice-6 file-diff routes reach for it — a file path
 *  under `changes/{section}/{file}` or `history/{sha}/{file}`).
 *
 *  `scoped` marks the caller as the scoped `#r/{id}/…` branch. The slice-6 tabs
 *  (changes/history/branches/issues) and the companion-extras tabs
 *  (tags/todos/discussions) are SCOPED-ONLY: on the legacy branch (`scoped: false`)
 *  their heads are unknown and degrade to status, exactly like any other unknown
 *  legacy head — the legacy grammar is deliberately NOT extended. The original tabs
 *  (prs/ci/agents/status) parse identically under either branch. */
function parseTab(
  head: string | undefined,
  tail: string | undefined,
  extra: string | undefined,
  scoped: boolean,
): TabParse {
  const detailId = tail && /^\d+$/.test(tail) ? Number(tail) : null;
  switch (head) {
    case "prs":
      return { ...NO_DETAIL, tab: "prs", detailId };
    case "ci":
      return { ...NO_DETAIL, tab: "ci", detailId };
    case "agents": {
      // Stream ids are strings, so `detailId` never applies here; a tail that
      // fails the charset guard falls back to the list (streamId null).
      const streamId = tail && STREAM_ID_RE.test(tail) ? tail : null;
      return { ...NO_DETAIL, tab: "agents", streamId };
    }
    case "changes": {
      if (!scoped) break; // scoped-only → unknown on the legacy branch
      // `changes/{section}/{encodedFile}` → a file-diff route; `changes` alone →
      // the list. A tail outside the three-value section set (or a missing file
      // segment) is an unknown detail: fall back to the list, exactly as an
      // unknown PR/CI tail does.
      const section =
        tail && (CHANGES_SECTIONS as readonly string[]).includes(tail)
          ? (tail as ChangesSection)
          : null;
      const filePath = section && extra ? decodeSegment(extra) : null;
      // A section without a file segment isn't a valid file-diff route; drop both
      // so it renders the list (never a half-formed detail).
      return filePath
        ? { ...NO_DETAIL, tab: "changes", section, filePath }
        : { ...NO_DETAIL, tab: "changes" };
    }
    case "history": {
      if (!scoped) break; // scoped-only
      // `history/{sha}[/{encodedFile}]`. A tail that isn't a 7–64 hex sha is an
      // unknown detail → the list (sha null); a valid sha may carry a file tail.
      const sha = tail && SHA_RE.test(tail) ? tail : null;
      const filePath = sha && extra ? decodeSegment(extra) : null;
      return { ...NO_DETAIL, tab: "history", sha, filePath };
    }
    case "branches":
      if (!scoped) break; // scoped-only
      return { ...NO_DETAIL, tab: "branches" };
    case "issues":
      if (!scoped) break; // scoped-only
      // Numeric detail → the issue number (`detailId`), exactly like prs.
      return { ...NO_DETAIL, tab: "issues", detailId };
    case "tags":
      if (!scoped) break; // scoped-only
      return { ...NO_DETAIL, tab: "tags" };
    case "todos":
      if (!scoped) break; // scoped-only
      return { ...NO_DETAIL, tab: "todos" };
    case "discussions":
      if (!scoped) break; // scoped-only
      // Numeric detail → the discussion number (`detailId`), exactly like issues;
      // a malformed tail degrades to the list (detailId null).
      return { ...NO_DETAIL, tab: "discussions", detailId };
  }
  // Unknown head (or a scoped-only tab reached via the legacy branch) → status.
  return { ...NO_DETAIL, tab: "status" };
}

/** Decode one `encodeURIComponent`-encoded path segment back to its raw path. A
 *  malformed escape (a hand-crafted hash) throws in `decodeURIComponent`; treat
 *  that as no file (null-equivalent "") rather than crashing the whole parse. */
function decodeSegment(seg: string): string | null {
  try {
    return decodeURIComponent(seg);
  } catch {
    return null;
  }
}

/** Encode a file path into a single hash segment (`encodeURIComponent` exactly
 *  once, so `/` and other path chars survive the round-trip through the hash).
 *  The inverse of the parser's `decodeSegment`. */
export function encodeFileSegment(path: string): string {
  return encodeURIComponent(path);
}

function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  if (raw === "pair") {
    return {
      tab: "status",
      isPairing: true,
      isRepos: false,
      repoId: null,
      ...NO_DETAIL,
      raw,
    };
  }
  if (raw === "repos") {
    return {
      tab: "status",
      isPairing: false,
      isRepos: true,
      repoId: null,
      ...NO_DETAIL,
      raw,
    };
  }
  const parts = raw.split("/");
  // Scoped form: `r/{repoId}/{tab}[/{detail}[/{extra}]]`. A malformed repoId segment
  // falls through to the legacy parse below (repoId stays null), so it degrades to
  // the legacy meaning rather than routing to a repo that can't exist. The scoped
  // form is the ONLY one that passes `parts[4]` (the file segment) — the slice-6
  // file-diff routes are scoped-only.
  if (parts[0] === "r" && parts[1] && REPO_ID_RE.test(parts[1])) {
    return {
      ...parseTab(parts[2], parts[3], parts[4], true),
      isPairing: false,
      isRepos: false,
      repoId: parts[1],
      raw,
    };
  }
  // Legacy single-repo form: `{tab}[/{detail}]` with no repo scope. `scoped: false`
  // and no `extra` segment: the slice-6 tabs (changes/history/branches/issues) are
  // scoped-only, so a legacy head that isn't status/prs/ci/agents degrades to status
  // as before.
  return {
    ...parseTab(parts[0], parts[1], undefined, false),
    isPairing: false,
    isRepos: false,
    repoId: null,
    raw,
  };
}

function subscribe(cb: () => void): () => void {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

const getSnapshot = () => window.location.hash;

/** The current parsed route, re-rendering on `hashchange`. The external-store
 *  snapshot is the raw hash STRING (stable across renders); the parsed `Route`
 *  object is derived via `useMemo` so callers get a referentially-stable value
 *  per hash. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => parseHash(hash), [hash]);
}

/** Build the scoped hash for a repo + tab tail (with a leading `#`). Tail is the
 *  `{tab}[/{detail}]` portion, e.g. `"prs/4"`; defaults to `status`. */
export function repoHash(repoId: string, tail = "status"): string {
  return `#r/${repoId}/${tail}`;
}

/** Navigate by setting the hash (adds a history entry so Back works). */
export function navigate(hash: string): void {
  window.location.hash = hash.startsWith("#") ? hash : `#${hash}`;
}

/** Navigate WITHOUT adding a history entry (replaces the current one). Used for
 *  the legacy→scoped bootstrap redirect so Back doesn't bounce onto the bare
 *  legacy hash that would just redirect straight back again. */
export function replace(hash: string): void {
  const h = hash.startsWith("#") ? hash : `#${hash}`;
  window.location.replace(
    `${window.location.pathname}${window.location.search}${h}`,
  );
}
