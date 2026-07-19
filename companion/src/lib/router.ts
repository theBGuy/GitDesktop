import { useMemo, useSyncExternalStore } from "react";

// Hash routing ONLY — the LAN server serves a single `index.html` and does no
// history-API rewriting, so every route lives in `location.hash`.
//
// The selected repository is a first-class, URL-persisted concept (slice 4). The
// canonical scoped forms carry it:
//   #r/{repoId}/status · #r/{repoId}/prs · #r/{repoId}/prs/{n} · #r/{repoId}/ci ·
//   #r/{repoId}/ci/{id} · #r/{repoId}/agents · #r/{repoId}/agents/{streamId}
// Plus two global (repo-less) routes:
//   #pair   — the pairing takeover (unchanged)
//   #repos  — the repo picker
// Legacy single-repo hashes (`#status`, `#prs/{n}`, `#ci/{id}`, `#agents/{id}`)
// still parse — with `repoId: null` — so old bookmarks keep working; the shell
// redirects them to the scoped equivalent once it knows which repo to use.
// Default (empty / unknown hash) resolves to #status with a null repoId.

export type Tab = "status" | "prs" | "ci" | "agents";

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
  /** The raw normalized hash (without the leading `#`). */
  raw: string;
}

/** Parse the `{tab}[/detail]` portion shared by both the legacy and scoped forms
 *  into `{ tab, detailId, streamId }`. `head` is the tab segment, `tail` the
 *  optional detail segment. */
function parseTab(
  head: string | undefined,
  tail: string | undefined,
): { tab: Tab; detailId: number | null; streamId: string | null } {
  const detailId = tail && /^\d+$/.test(tail) ? Number(tail) : null;
  switch (head) {
    case "prs":
      return { tab: "prs", detailId, streamId: null };
    case "ci":
      return { tab: "ci", detailId, streamId: null };
    case "agents": {
      // Stream ids are strings, so `detailId` never applies here; a tail that
      // fails the charset guard falls back to the list (streamId null).
      const streamId = tail && STREAM_ID_RE.test(tail) ? tail : null;
      return { tab: "agents", detailId: null, streamId };
    }
    default:
      return { tab: "status", detailId: null, streamId: null };
  }
}

function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  if (raw === "pair") {
    return {
      tab: "status",
      isPairing: true,
      isRepos: false,
      repoId: null,
      detailId: null,
      streamId: null,
      raw,
    };
  }
  if (raw === "repos") {
    return {
      tab: "status",
      isPairing: false,
      isRepos: true,
      repoId: null,
      detailId: null,
      streamId: null,
      raw,
    };
  }
  const parts = raw.split("/");
  // Scoped form: `r/{repoId}/{tab}[/{detail}]`. A malformed repoId segment falls
  // through to the legacy parse below (repoId stays null), so it degrades to the
  // legacy meaning rather than routing to a repo that can't exist.
  if (parts[0] === "r" && parts[1] && REPO_ID_RE.test(parts[1])) {
    const { tab, detailId, streamId } = parseTab(parts[2], parts[3]);
    return {
      tab,
      isPairing: false,
      isRepos: false,
      repoId: parts[1],
      detailId,
      streamId,
      raw,
    };
  }
  // Legacy single-repo form: `{tab}[/{detail}]` with no repo scope.
  const { tab, detailId, streamId } = parseTab(parts[0], parts[1]);
  return {
    tab,
    isPairing: false,
    isRepos: false,
    repoId: null,
    detailId,
    streamId,
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
