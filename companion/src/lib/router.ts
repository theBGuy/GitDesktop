import { useMemo, useSyncExternalStore } from "react";

// Hash routing ONLY — the LAN server serves a single `index.html` and does no
// history-API rewriting, so every route lives in `location.hash`. Routes:
//   #pair · #status · #prs · #prs/{n} · #ci · #ci/{id}
// Default (empty / unknown hash) resolves to #status.

export type Tab = "status" | "prs" | "ci";

export interface Route {
  /** The active bottom-tab. Pair is not a tab (it's a full-screen takeover). */
  tab: Tab;
  /** True when on the pairing screen (`#pair`). */
  isPairing: boolean;
  /** A selected PR number (`#prs/{n}`) or CI run id (`#ci/{id}`), else null. */
  detailId: number | null;
  /** The raw normalized hash (without the leading `#`). */
  raw: string;
}

function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  if (raw === "pair") {
    return { tab: "status", isPairing: true, detailId: null, raw };
  }
  const [head, tail] = raw.split("/", 2);
  const detailId = tail && /^\d+$/.test(tail) ? Number(tail) : null;
  switch (head) {
    case "prs":
      return { tab: "prs", isPairing: false, detailId, raw };
    case "ci":
      return { tab: "ci", isPairing: false, detailId, raw };
    default:
      return { tab: "status", isPairing: false, detailId: null, raw };
  }
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

/** Navigate by setting the hash (adds a history entry so Back works). */
export function navigate(hash: string): void {
  window.location.hash = hash.startsWith("#") ? hash : `#${hash}`;
}
