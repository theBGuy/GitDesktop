// How one streaming agent-CLI run settles: the channel gate the agent commands'
// wrappers put in front of their caller, and the settle machine runCliStream
// drives. Free of `@/` aliases and runtime tauri imports so
// scripts/stream-settle.test.mjs loads it under Node's type stripping.
import type { AgentToolKind, ReviewEvent } from "./agent.ts";
import { terminalErrorMessage } from "./terminal-error.ts";

const isTerminal = (event: ReviewEvent) =>
  event.kind === "done" || event.kind === "error";

export interface ChannelGateOptions {
  /** The caller's consumer: every event the gate lets through, in channel
   *  order, ending with at most one terminal (none for a cancelled run, whose
   *  late deltas still pass). */
  deliver: (event: ReviewEvent) => void;
  /** How long a returned terminal waits for the channel's own copy before the
   *  returned one is replayed. */
  boundMs: number;
}

export interface ChannelGate {
  /** The channel's `onmessage`. */
  onMessage: (event: ReviewEvent) => void;
  /** Feeds the command's return value. Settles once a terminal has reached
   *  `deliver`, or at once for a `null` (cancelled) return. */
  finish: (returned: ReviewEvent | null) => Promise<void>;
}

/**
 * Hands the caller one terminal, after every delta the channel delivers before
 * it. The backend sends its terminal on the channel before returning it and the
 * channel delivers in order, so a returned terminal waits up to `boundMs` for the
 * channel's copy (a lost large-payload fetch leaves an index gap that never
 * fills), then is replayed. The latch is set before `deliver` runs, so a
 * throwing consumer can't earn a second terminal.
 */
export function createChannelGate({
  deliver,
  boundMs,
}: ChannelGateOptions): ChannelGate {
  let sawTerminal = false;
  let waiting: {
    timer: ReturnType<typeof setTimeout>;
    release: () => void;
  } | null = null;
  const deliverTerminal = (event: ReviewEvent) => {
    sawTerminal = true;
    const pending = waiting;
    waiting = null;
    if (pending) clearTimeout(pending.timer);
    try {
      deliver(event);
    } finally {
      pending?.release();
    }
  };
  return {
    onMessage: (event) => {
      if (sawTerminal) return;
      if (isTerminal(event)) deliverTerminal(event);
      else deliver(event);
    },
    finish: (returned) => {
      if (returned === null || sawTerminal) return Promise.resolve();
      return new Promise<void>((release) => {
        waiting = {
          timer: setTimeout(() => deliverTerminal(returned), boundMs),
          release,
        };
      });
    },
  };
}

/** How a run ended, for runCliStream to map onto resolve / reject. */
export type CliSettleOutcome =
  /** The final answer is already in `setText`; `thoughts` is the peeled
   *  narration, "" when there is none. */
  | { kind: "done"; costUsd: number | null; thoughts: string }
  /** `costUsd` is present only for an errored `done`, which reports one. */
  | {
      kind: "failed";
      message: string;
      timedOut: boolean;
      costUsd?: number | null;
    }
  | { kind: "cancelled" }
  | { kind: "incomplete" };

export interface CliSettleCallbacks {
  setText: (text: string) => void;
  setStatus: (status: string) => void;
}

/** A short, human status line for a tool step, from the normalized kind + target
 *  (the `target` may be null — degrade to the bare verb). Surfaces the agentic
 *  run's exploration in the panel's existing status line. */
function toolStatusLine(tool: AgentToolKind, target: string | null): string {
  const at = target?.trim();
  switch (tool) {
    case "read":
      return at ? `Reading ${at}…` : "Reading a file…";
    case "search":
      return at ? `Searching ${at}…` : "Searching…";
    case "list":
      return at ? `Listing ${at}…` : "Listing files…";
    case "web-fetch":
    case "web-search":
      return "Searching the web…";
    case "run":
      return "Running a command…";
    default:
      return "Working…";
  }
}

export interface CliSettle {
  /** Feeds one channel event; returns the outcome when this event settles the run. */
  onEvent: (event: ReviewEvent) => CliSettleOutcome | null;
  /** Feeds the command's return value; returns the outcome when it settles the run.
   *  `cancelRequested` is undefined when the caller has no cancel predicate. */
  finish: (
    returned: ReviewEvent | null,
    cancelRequested?: boolean,
  ) => CliSettleOutcome | null;
}

/** One run's settle state: the accumulated delta buffer and the settled latch.
 *  The run settles at most once; every event after that is a no-op. */
export function createCliSettle({
  setText,
  setStatus,
}: CliSettleCallbacks): CliSettle {
  let buffer = "";
  let settled = false;
  const onEvent = (event: ReviewEvent): CliSettleOutcome | null => {
    if (settled) return null;
    if (event.kind === "delta") {
      buffer += event.text;
      setText(buffer);
    } else if (event.kind === "status") {
      setStatus(event.text);
    } else if (event.kind === "tool") {
      setStatus(toolStatusLine(event.tool, event.target));
    } else if (event.kind === "done") {
      settled = true;
      // An errored run keeps whatever streamed — partial text plus the error, no strip.
      // Surface the terminal text as the reason only when it's error-shaped
      // (terminalErrorMessage refuses run output, e.g. a body ended by session.error).
      if (event.isError) {
        return {
          kind: "failed",
          message: terminalErrorMessage(event.text),
          timedOut: false,
          costUsd: event.costUsd,
        };
      }
      // The terminal event's text IS the agent's final answer. The delta buffer
      // additionally holds any tool-using narration ("Let me check…") that streamed
      // ahead of it, and adopting the buffer here leaks that narration into the review
      // — so the final answer wins (buffer only as a fallback for a degenerate empty
      // terminal event) and the narration is peeled off as separate "thoughts".
      const final = event.text.trim() ? event.text : buffer;
      setText(final);
      // Peel narration ONLY on a genuine suffix match (deltas may prepend a separator
      // before the final answer). A mismatched buffer is NOT narration — it's a
      // fallen-short delta stream or a drifted wire format, and a spurious "thoughts"
      // copy of the review body is worse than no thoughts.
      let thoughts = "";
      if (
        event.text.trim() &&
        buffer !== event.text &&
        buffer.endsWith(event.text)
      ) {
        thoughts = buffer.slice(0, buffer.length - event.text.length).trim();
      }
      return { kind: "done", costUsd: event.costUsd, thoughts };
    } else if (event.kind === "error") {
      settled = true;
      // A whole-message CLI (Codex) streams no deltas, so a killed run's output
      // arrives only here — adopt it when nothing streamed, so the failure keeps
      // the work instead of discarding it.
      const partial = event.partialText?.trim() ? event.partialText : "";
      if (partial && !buffer) {
        buffer = partial;
        setText(buffer);
      }
      return {
        kind: "failed",
        message: event.message,
        timedOut: event.timedOut,
      };
    }
    // nativeSession (the CLI's turn-1 resume id) is session-only — reviews ignore it.
    return null;
  };
  return {
    onEvent,
    finish: (returned, cancelRequested) => {
      if (settled) return null;
      // The gate delivers a returned terminal through onEvent before the command
      // settles, so this arm only covers a caller fed without one.
      if (returned) {
        const outcome = onEvent(returned);
        if (outcome) return outcome;
      }
      settled = true;
      // The backend returns no terminal only from its cancel arm. Without a cancel
      // request on our side that is drift, and the cut buffer must not pass as a
      // finished run; a caller with no predicate trusts the backend.
      return returned === null && cancelRequested !== false
        ? { kind: "cancelled" }
        : { kind: "incomplete" };
    },
  };
}
