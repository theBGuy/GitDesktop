import { useEffect, useReducer } from "react";
import { ApiError, fetchReviews } from "./api";
import { queryClient } from "./queries";

// Live agent-stream watch over Server-Sent Events. The desktop broadcasts an AI
// PR review or an agent session as a stream of `ReviewEvent`s; this hook opens the
// SSE connection, folds the events into an ordered transcript, and classifies the
// terminal / disconnected states per the epic's END-semantics contract.
//
// Wire contract (frozen; the server package guarantees it in the same PR):
//   GET /api/reviews/{id}/stream → SSE, one ReviewEvent JSON per `data:` line.
//   camelCase (`isError` / `costUsd`) — no snake_case fallback. Keep-alive comment
//   lines arrive every 15s (EventSource ignores comments natively). NO replay:
//   joining mid-run yields only events from then on.

/** One event off the wire. `nativeSession` is bookkeeping only (never displayed). */
export type ReviewEvent =
  | { kind: "delta"; text: string }
  | { kind: "status"; text: string }
  | { kind: "tool"; tool: ToolKind; target: string | null }
  | { kind: "done"; text: string; isError: boolean; costUsd: number | null }
  | { kind: "error"; message: string }
  | { kind: "nativeSession"; id: string };

export type ToolKind =
  | "read"
  | "search"
  | "list"
  | "edit"
  | "write"
  | "run"
  | "web-fetch"
  | "web-search"
  | "task"
  | "other";

const TOOL_KINDS = new Set<ToolKind>([
  "read",
  "search",
  "list",
  "edit",
  "write",
  "run",
  "web-fetch",
  "web-search",
  "task",
  "other",
]);

/** A rendered transcript row: a coalesced run of prose, or a single tool step.
 *  Consecutive `delta`s fold into one trailing `text` segment; each `tool` closes
 *  that run and appends a `step` (mirroring the desktop's transcript semantics). */
export type Segment =
  | { kind: "text"; text: string }
  | { kind: "step"; tool: ToolKind; target: string | null };

/** Terminal outcome once the run finishes. */
export type Terminal =
  | { kind: "done"; text: string; isError: boolean; costUsd: number | null }
  | { kind: "error"; message: string };

/** Connection lifecycle:
 *  - `connecting` — the EventSource is opening, nothing received yet.
 *  - `live` — receiving events; the run is in progress.
 *  - `ended` — the stream finished (a terminal event arrived, OR it closed and the
 *    run is still shared but no longer streaming).
 *  - `gone` — the stream closed with no terminal and the STREAM id is no longer
 *    shared (run ended / sharing off / device revoked), but the REPO still is.
 *  - `repoGone` — the stream closed with no terminal AND the scoped reviews probe
 *    itself 404'd `noSuchRepo`: the whole repository stopped being shared from the
 *    desktop. Distinct from `gone` because the teaching state differs — the watch
 *    offers "Choose repository" (→ `#repos`), not just "Back to agents". */
export type Phase = "connecting" | "live" | "ended" | "gone" | "repoGone";

export interface StreamState {
  segments: Segment[];
  /** The current transient progress note (replaced by each `status`, cleared by a
   *  `delta`/`tool`). Never persisted into `segments`. */
  statusText: string | null;
  terminal: Terminal | null;
  phase: Phase;
}

type Action =
  | { type: "opened" }
  | { type: "event"; event: ReviewEvent }
  | { type: "closed" }
  | { type: "gone" }
  | { type: "repoGone" };

const initialState: StreamState = {
  segments: [],
  statusText: null,
  terminal: null,
  phase: "connecting",
};

function reducer(state: StreamState, action: Action): StreamState {
  switch (action.type) {
    case "opened":
      // The SSE connection is open. Move connecting → live so the UI leaves the
      // skeleton even before the first event (keep-alive comments never surface
      // through EventSource). ONLY from connecting — never resurrect a terminal
      // (`ended`/`gone`) state if `onopen` somehow fires after a close.
      return state.phase === "connecting" ? { ...state, phase: "live" } : state;
    case "closed":
      // A terminal event already settled the outcome → keep `ended`; otherwise the
      // probe (dispatched by the effect) will refine `ended`↔`gone`.
      return state.terminal ? state : { ...state, phase: "ended" };
    case "gone":
      return { ...state, phase: "gone" };
    case "repoGone":
      return { ...state, phase: "repoGone" };
    case "event": {
      const ev = action.event;
      switch (ev.kind) {
        case "delta": {
          // Coalesce into the trailing text run, or open a new one.
          const segs = state.segments;
          const last = segs[segs.length - 1];
          const nextSegs: Segment[] =
            last && last.kind === "text"
              ? [
                  ...segs.slice(0, -1),
                  { kind: "text", text: last.text + ev.text },
                ]
              : [...segs, { kind: "text", text: ev.text }];
          return {
            ...state,
            segments: nextSegs,
            statusText: null,
            phase: "live",
          };
        }
        case "tool":
          // A tool step closes the current text run and appends a step row.
          return {
            ...state,
            segments: [
              ...state.segments,
              { kind: "step", tool: ev.tool, target: ev.target },
            ],
            statusText: null,
            phase: "live",
          };
        case "status":
          return { ...state, statusText: ev.text, phase: "live" };
        case "done":
          return {
            ...state,
            terminal: {
              kind: "done",
              text: ev.text,
              isError: ev.isError,
              costUsd: ev.costUsd,
            },
            statusText: null,
            phase: "ended",
          };
        case "error":
          return {
            ...state,
            terminal: { kind: "error", message: ev.message },
            statusText: null,
            phase: "ended",
          };
        default:
          // `nativeSession` (and any future kind) — ignore for display.
          return state;
      }
    }
    default:
      return state;
  }
}

/** Parse one SSE `data:` payload into a {@link ReviewEvent}, with per-field
 *  `typeof` guards (repo convention for untrusted JSON derivers). Returns null for
 *  anything malformed — the caller drops it silently. */
function parseEvent(raw: string): ReviewEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const o = data as Record<string, unknown>;
  switch (o.kind) {
    case "delta":
      return typeof o.text === "string"
        ? { kind: "delta", text: o.text }
        : null;
    case "status":
      return typeof o.text === "string"
        ? { kind: "status", text: o.text }
        : null;
    case "tool": {
      if (typeof o.tool !== "string" || !TOOL_KINDS.has(o.tool as ToolKind)) {
        return null;
      }
      const target = typeof o.target === "string" ? o.target : null;
      return { kind: "tool", tool: o.tool as ToolKind, target };
    }
    case "done":
      return typeof o.text === "string" && typeof o.isError === "boolean"
        ? {
            kind: "done",
            text: o.text,
            isError: o.isError,
            costUsd: typeof o.costUsd === "number" ? o.costUsd : null,
          }
        : null;
    case "error":
      return typeof o.message === "string"
        ? { kind: "error", message: o.message }
        : null;
    case "nativeSession":
      return typeof o.id === "string"
        ? { kind: "nativeSession", id: o.id }
        : null;
    default:
      return null;
  }
}

/** Watch a live agent stream by id, scoped to `repoId`. Opens an EventSource
 *  (relative same-origin URL — the `gd_lan` cookie rides automatically; the page
 *  CSP `connect-src 'self'` covers it) and folds events into transcript state.
 *  Idempotent under StrictMode's double-mount: the effect closes its own
 *  EventSource on cleanup, and re-subscribes if `repoId`/`id` change. */
export function useReviewStream(repoId: string, id: string): StreamState {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    let terminalSeen = false;
    // `closed` guards `onerror` against double-handling the permanent close.
    // `cancelled` is a separate teardown flag flipped ONLY by the cleanup below —
    // `closed` can't serve for the async probe guard because `onerror` sets it true
    // before firing the probe, so a `closed` check there would always short-circuit.
    let closed = false;
    let cancelled = false;
    const es = new EventSource(
      `/api/repos/${encodeURIComponent(repoId)}/reviews/${encodeURIComponent(id)}/stream`,
    );

    es.onopen = () => {
      // Connection established. Leave the connecting skeleton even before the first
      // event (keep-alive comments don't surface through EventSource). The reducer
      // only advances connecting → live, so this never resurrects a closed state.
      if (!cancelled) dispatch({ type: "opened" });
    };

    es.onmessage = (e) => {
      const event = parseEvent(e.data);
      if (!event) return; // drop unparseable frames silently
      if (event.kind === "done" || event.kind === "error") {
        terminalSeen = true;
      }
      dispatch({ type: "event", event });
    };

    es.onerror = () => {
      // EventSource fires `onerror` on every transient reconnect too; only a
      // permanently-CLOSED source is a real end. The server closes the stream
      // after a terminal event / lifecycle cut / channel close; the browser then
      // reconnects, hits a non-200 (404 gone / 401 revoked), and goes CLOSED.
      if (es.readyState !== EventSource.CLOSED || closed) return;
      closed = true;
      es.close();
      dispatch({ type: "closed" });

      // 1. Terminal already received → the finished state stands; no probe.
      if (terminalSeen) return;

      // 2. Closed without a terminal → classify via react-query (NOT a raw fetch,
      //    so a 401 routes through the central QueryCache → `#pair`). `staleTime: 0`
      //    forces a network round-trip: without it, `fetchQuery` serves the still-
      //    fresh list cache (default staleTime 10_000) and no-ops — so a revoke or a
      //    run ending within ~10s of the list rendering would never be observed (no
      //    401 reaches the handler, the stale list still holds the id, `gone` never
      //    fires, and the screen froze on "ended"). The probe deliberately bypasses
      //    freshness so a revoke/end is always seen. The key is repo-scoped
      //    (`["reviews", repoId]`) so it round-trips the SAME scoped route the list
      //    uses — a shared cache across repos would misclassify.
      queryClient
        .fetchQuery({
          queryKey: ["reviews", repoId],
          queryFn: () => fetchReviews(repoId),
          staleTime: 0,
        })
        .then((reviews) => {
          if (cancelled) return; // unmounted / superseded — don't dispatch
          if (!reviews.some((r) => r.id === id)) {
            dispatch({ type: "gone" });
          }
        })
        .catch((err) => {
          if (cancelled) return;
          // The probe itself 404'd `noSuchRepo` → the whole repo stopped being
          // shared. Classify as `repoGone` (distinct from a stream-only `gone`) so
          // the watch offers "Choose repository" rather than "Back to agents". A
          // 401 already redirected via the QueryCache; any OTHER probe failure
          // leaves the calmer `ended` state in place (we can't prove it's gone).
          if (err instanceof ApiError && err.isNoSuchRepo) {
            dispatch({ type: "repoGone" });
          }
        });
    };

    return () => {
      closed = true;
      cancelled = true;
      es.close();
    };
  }, [repoId, id]);

  return state;
}

/** The desktop's tool-verb labels, mirrored for the transcript step rows. */
export const TOOL_VERB: Record<ToolKind, string> = {
  read: "Read",
  search: "Searched",
  list: "Listed",
  edit: "Edited",
  write: "Wrote",
  run: "Ran",
  "web-fetch": "Fetched",
  "web-search": "Searched the web",
  task: "Delegated",
  other: "Used",
};
