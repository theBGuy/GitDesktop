import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { cancelAgentReview, providerKind } from "@/lib/ai/agent";
import { resolveBudgetProfile } from "@/lib/ai/context-budget";
import {
  type ExternalContext,
  resolveExternalContext,
} from "@/lib/ai/external-context";
import {
  type OwnCommentsContext,
  resolveOwnCommentsContext,
} from "@/lib/ai/own-context";
import { type PriorContext, resolvePriorContext } from "@/lib/ai/prior-context";
import { buildReviewPrompt } from "@/lib/ai/prompt";
import { isLocalProvider } from "@/lib/ai/providers";
import { buildReviewTools } from "@/lib/ai/review-tools";
import { streamAi } from "@/lib/ai/stream";
import type {
  AiSettings,
  PromptProvider,
  ReviewDeltaState,
  ReviewMode,
} from "@/lib/ai/types";
import type { DiffStatEntry } from "@/lib/git/types";
import { notifyIfUnfocused } from "@/lib/notify";
import { saveReview } from "@/lib/pulls/reviews-history";
import { queryClient } from "@/lib/query-client";
import { loadSettings } from "@/lib/settings/api";
import { pushNotification } from "@/lib/stores/notifications";
import { errorMessage } from "@/lib/tauri/invoke";

export interface ReviewContext {
  title: string;
  body: string;
  commitSubjects: string[];
  /** Repo working directory — the CLI agent runs here. */
  repoPath: string;
  /** Target host — swaps the change-request noun + markdown flavor in the review
   *  system prompt. Absent (local PRs / commit reviews) keeps the base GitHub
   *  wording. */
  provider?: PromptProvider;
  /** Current PR head SHA. Persisted with the review so the NEXT run can compute
   *  a "changes since" delta against it; absent for views that don't supply it. */
  headSha?: string;
  /** Lazily fetch the combined diff (only when a review is actually run). */
  loadDiff: () => Promise<{
    text: string;
    truncated: boolean;
    files: DiffStatEntry[];
  }>;
}

/** Identifies the PR a review belongs to — also the dock's "View" target. */
export interface ReviewTarget {
  kind: "remote" | "local";
  repoPath: string;
  repoName: string;
  /** Remote PR number (as a string) or local PR id. */
  ref: string;
}

export type ReviewPhase =
  | "idle"
  | "queued"
  | "running"
  | "done"
  | "error"
  | "cancelled";

/** State of one review run, keyed by repo + PR in the store. */
export interface ReviewEntry {
  phase: ReviewPhase;
  /** Transient sub-status line shown while a CLI agent works. */
  status: string;
  /** The mode of the run that produced `text` (drives the "post" label). */
  mode: ReviewMode;
  /** The model the run used, captured so the posted label stays accurate. */
  model: string;
  /** Whether this run is machine-bound (CLI agent subprocess or local Ollama)
   *  vs a cloud HTTP provider — picks its concurrency lane and groups its queue
   *  position. */
  local: boolean;
  /** PR title — the activity dock's row label. */
  title: string;
  /** Where the run came from — drives the dock's "View" navigation. */
  target: ReviewTarget;
  /** Monotonic start order — drives newest-first display and FIFO queue
   *  position exactly (a timestamp can collide within a millisecond). */
  seq: number;
  /** Failure message when `phase === "error"`. */
  error: string;
  /** When the run used prior-review context, how its "changes since" delta
   *  resolved — drives the panel's rewrite/indeterminate note. Undefined on a
   *  first run or when prior context was ignored. */
  deltaState?: ReviewDeltaState;
  /** The finished run's prompt carried a truncated diff AND the run had no tools
   *  to compensate (not agentic) — drives the panel's "enable agentic review"
   *  upgrade nudge. A tool-bearing run handles its own coverage, so this stays
   *  false there. */
  truncatedCoverage?: boolean;
  /** The agentic run's streamed working narration, set once at settle (arrives via
   *  a single patch, so it lives on the entry, not the per-token `texts` map). The
   *  panel shows it behind a "Thought process" disclosure; the dock ignores it. */
  thoughts?: string;
  /** Re-fires this run through the automation pipeline — set ONLY on automation
   *  rows (by {@link registerAutomationRun}). Its presence is the discriminator
   *  that a stopped (cancelled/error) row belongs in the dock's Stopped group: a
   *  manual panel run also reaches "cancelled"/"error" but never carries a rerun,
   *  so it's kept out. */
  rerun?: () => void;
}

/** A store entry tagged with its key — what the activity dock renders. */
export interface ReviewTask extends ReviewEntry {
  key: string;
}

const EMPTY_TARGET: ReviewTarget = {
  kind: "remote",
  repoPath: "",
  repoName: "",
  ref: "",
};

const EMPTY_ENTRY: ReviewEntry = {
  phase: "idle",
  status: "",
  mode: "general",
  model: "",
  local: false,
  title: "",
  target: EMPTY_TARGET,
  seq: 0,
  error: "",
};

/** Stable store key for a review run. */
export function reviewKey(t: {
  kind: string;
  repoPath: string;
  ref: string;
}): string {
  return `${t.kind}:${t.repoPath}#${t.ref}`;
}

interface ReviewStore {
  entries: Record<string, ReviewEntry>;
  /** In-flight review markdown, kept OUT of `entries` so the per-token streaming
   *  updates don't churn the dock-facing entry map (the activity dock renders
   *  metadata only — never the text — so it shouldn't re-render per token). */
  texts: Record<string, string>;
  patch: (key: string, p: Partial<ReviewEntry>) => void;
  setText: (key: string, text: string) => void;
  remove: (key: string) => void;
}

const useReviewStore = create<ReviewStore>((set) => ({
  entries: {},
  texts: {},
  patch: (key, p) =>
    set((s) => ({
      entries: {
        ...s.entries,
        [key]: { ...(s.entries[key] ?? EMPTY_ENTRY), ...p },
      },
    })),
  setText: (key, text) => set((s) => ({ texts: { ...s.texts, [key]: text } })),
  remove: (key) =>
    set((s) => {
      if (!(key in s.entries) && !(key in s.texts)) return s;
      const entries = { ...s.entries };
      delete entries[key];
      const texts = { ...s.texts };
      delete texts[key];
      return { entries, texts };
    }),
}));

/**
 * Non-render run handles, kept outside the store so streaming deltas don't
 * thrash it. One entry exists per *in-flight* run; it's removed on settle.
 */
interface RunControl {
  abort: AbortController | null;
  cliReviewId: string | null;
  cancelled: boolean;
  /** Whether this run currently holds a concurrency slot. */
  hasSlot: boolean;
  /** While queued, resolves the slot wait so the run can start or unwind. */
  wakeQueued: (() => void) | null;
  /** The lane this run draws its slot from (for release + queue removal). */
  lane: Limiter | null;
}

const controls = new Map<string, RunControl>();

/** Monotonic counter stamped on each run for exact start-order display. */
let reviewSeq = 0;

/** How many stopped (cancelled/error) automation rows the dock keeps at once. */
const MAX_STOPPED_ROWS = 8;

/**
 * After a transition to a stopped state, cap the retained stopped automation
 * rows — keep at most {@link MAX_STOPPED_ROWS} entries that are automation
 * (`auto:` key) AND in a stopped phase (cancelled/error), evicting the oldest by
 * `seq`. Manual panel runs and live/finished rows are never touched. Called from
 * both terminal stopped paths (cancelReview's auto arm + a run handle's fail).
 */
function enforceStoppedCap(): void {
  const { entries } = useReviewStore.getState();
  const stopped = Object.entries(entries)
    .filter(
      ([key, e]) =>
        key.startsWith("auto:") &&
        (e.phase === "cancelled" || e.phase === "error"),
    )
    .sort((a, b) => a[1].seq - b[1].seq); // oldest first
  const excess = stopped.length - MAX_STOPPED_ROWS;
  for (let i = 0; i < excess; i++) {
    useReviewStore.getState().remove(stopped[i][0]);
  }
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/**
 * Two independent concurrency lanes so kicking off reviews on several PRs at
 * once doesn't overload the machine. Runs over a lane's cap enter the `queued`
 * phase and start FIFO as slots free up; the lanes are separate so a local
 * backlog never blocks a cloud run (or vice versa).
 *
 * - The **local** lane (CLI agent subprocesses + local Ollama inference) is
 *   bound by the machine, so its cap scales conservatively with CPU cores.
 * - The **cloud** lane (Anthropic/OpenAI/OpenRouter streaming) spawns no
 *   process and isn't machine-bound, so it's far higher — its real ceiling is
 *   the provider's own rate limit, which is the user's to manage.
 */
interface Limiter {
  max: number;
  active: number;
  waiting: RunControl[];
}

const cores = Math.max(1, navigator.hardwareConcurrency || 4);
const localLane: Limiter = {
  max: clamp(Math.floor(cores / 2), 2, 8),
  active: 0,
  waiting: [],
};
const cloudLane: Limiter = {
  max: clamp(cores * 2, 8, 32),
  active: 0,
  waiting: [],
};

/** Reserves a slot in `lane`, resolving immediately if free or once one frees. */
function acquireSlot(lane: Limiter, control: RunControl): Promise<void> {
  if (lane.active < lane.max) {
    lane.active++;
    control.hasSlot = true;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    control.wakeQueued = () => {
      control.wakeQueued = null;
      resolve();
    };
    lane.waiting.push(control);
  });
}

/** Hands a freed slot to the next live waiter in `lane`, or frees it if none. */
function releaseSlot(lane: Limiter): void {
  while (lane.waiting.length > 0) {
    const next = lane.waiting.shift();
    if (!next || next.cancelled) continue; // cancelled waiters drop out
    next.hasSlot = true;
    next.wakeQueued?.();
    return; // slot handed off — lane.active unchanged
  }
  lane.active--;
}

/** OS notification when a review settles while the window is hidden (close to
 *  tray) or unfocused, gated on the user's setting. Best-effort. */
async function notifyReviewDone(
  title: string,
  mode: ReviewMode,
  ok: boolean,
  target: ReviewTarget,
): Promise<void> {
  try {
    const { notifications } = await loadSettings();
    if (!notifications.reviews) return;
    const label = mode === "security" ? "security audit" : "review";
    const headline = ok ? `AI ${label} ready` : `AI ${label} failed`;
    // Durable record in the inbox (regardless of focus), plus the OS ping when
    // the window is hidden. Both ride the same `reviews` pref.
    pushNotification({
      kind: ok ? "review-ready" : "review-failed",
      tone: ok ? "success" : "danger",
      title: headline,
      subtitle: `"${title}"`,
      repoPath: target.repoPath,
      repoName: target.repoName,
      target: { type: "pr", kind: target.kind, ref: target.ref },
      dedupeKey: `review:${target.kind}:${target.repoPath}:${target.ref}:${ok}`,
    });
    void notifyIfUnfocused(headline, `"${title}"`);
  } catch {
    // best-effort — a missed notification must never affect the review
  }
}

/**
 * Starts an AI review (general or security) for a PR, keyed so the run is
 * decoupled from the view that triggered it. The run, its result, and its
 * Cancel affordance all survive navigating away — the run lives in this module
 * + the store (surfaced by the activity dock), not in a component. Routes to
 * the Vercel AI SDK for HTTP providers or a local agent CLI for CLI providers.
 *
 * On a re-run, the PREVIOUS review's findings + a "changes since" delta ride
 * along as soft, re-verifiable context (unless `ignorePrior`); on a remote PR,
 * findings posted by third-party AI reviewers (Copilot/CodeRabbit) ride along
 * too (unless `ignoreExternal`). The result is persisted on success so the NEXT
 * run can build on it.
 */
export async function startReview(
  target: ReviewTarget,
  title: string,
  ai: AiSettings,
  mode: ReviewMode,
  context: ReviewContext,
  ignorePrior = false,
  ignoreExternal = false,
): Promise<void> {
  const key = reviewKey(target);
  // Single-flight per key — the UI hides the run buttons while generating, but
  // guard against a double-fire racing two streams into one entry (a queued run
  // counts as already-started).
  const phase = useReviewStore.getState().entries[key]?.phase;
  if (phase === "running" || phase === "queued") return;

  const patch = (p: Partial<ReviewEntry>) =>
    useReviewStore.getState().patch(key, p);
  const pushText = (t: string) => useReviewStore.getState().setText(key, t);
  const local = isLocalProvider(ai.provider);
  const lane = local ? localLane : cloudLane;
  // Register the run and mark it queued before any async work, so the
  // single-flight guard above stays atomic even if an `await` is added here.
  const control: RunControl = {
    abort: null,
    cliReviewId: null,
    cancelled: false,
    hasSlot: false,
    wakeQueued: null,
    lane,
  };
  controls.set(key, control);
  // Clear any text from a prior run on this key before the new stream appends.
  pushText("");
  patch({
    phase: "queued",
    status: "",
    mode,
    model: ai.model,
    local,
    title,
    target,
    seq: reviewSeq++,
    error: "",
    deltaState: undefined,
    truncatedCoverage: undefined,
    thoughts: undefined,
  });

  // Wall-clock start for the persisted history record (the store itself orders
  // by monotonic `seq`, not a timestamp).
  const startedAtMs = Date.now();

  // Wait for a slot in this run's lane (immediate when under the cap). A cancel
  // while queued wakes this too — `control.cancelled` then short-circuits below.
  await acquireSlot(lane, control);

  try {
    if (control.cancelled) return;
    patch({ phase: "running" });
    const diff = await context.loadDiff();
    if (control.cancelled) return;
    if (!diff.text.trim()) {
      // A no-op run shouldn't linger in the dock; a momentary toast is enough.
      toast.info("No changes to review.");
      useReviewStore.getState().remove(key);
      return;
    }
    // Soft prior-review context (skipped when the user asked to ignore it). Runs
    // on a held slot after the diff loads — never during the queued wait.
    const prior: PriorContext = ignorePrior
      ? {}
      : await resolvePriorContext(
          target.repoPath,
          target.kind,
          target.ref,
          mode,
          context.headSha,
        );
    if (control.cancelled) return;
    patch({ deltaState: prior.deltaState });
    // Scale the prompt's character budgets to the reviewing model (per the user's
    // Review-context knob) — best-effort, never throws, never blocks. Resolved
    // BEFORE the own/external harvest so the own-comments distillation trigger +
    // ledger cap key off the SAME scaled budget as the rest of the prompt; reused
    // verbatim at buildReviewPrompt below (single resolution, used twice).
    const budgetProfile = await resolveBudgetProfile(
      ai,
      (await loadSettings()).reviewContextSize,
    );
    if (control.cancelled) return;
    // Own-comments distillation runs a generation-model call that can outlast a
    // dock Cancel; the CLI/HTTP review stream only gets an abort handle later (via
    // `onAbort` at streamAi). Wire an AbortController in NOW so `cancelReview`'s
    // `control.abort?.abort()` reaches the distill immediately — `control.abort` is
    // null at this point, and streamAi reassigns it once the stream opens.
    const preAbort = new AbortController();
    control.abort = preAbort;
    // Third-party AI-reviewer findings AND GitDesktop's own prior comments on the
    // remote PR — both best-effort, remote-only soft context. Resolved
    // concurrently (independent harvests of the PR's review activity); kept
    // separate so the battle-tested external path is untouched — a shared-fetch
    // dedup is a later efficiency win (forge-dispatch-dedup backlog).
    const [external, own]: [ExternalContext, OwnCommentsContext] =
      await Promise.all([
        resolveExternalContext(
          target.repoPath,
          target.kind,
          target.ref,
          context.headSha,
          ignoreExternal,
          context.provider,
        ),
        resolveOwnCommentsContext(
          target.repoPath,
          target.kind,
          target.ref,
          context.provider,
          {
            distill: true,
            signal: preAbort.signal,
            ownBudgetChars: budgetProfile.ownCharBudget,
          },
        ),
      ]);
    if (control.cancelled) return;
    // Agentic run: in repo-aware mode the reviewer explores. A CLI provider
    // reviews with the PR's files on disk and (for the tool-capable CLIs —
    // everything but codex) GitDesktop's own read-only MCP tools attached; an
    // HTTP provider (null kind) instead drives a native AI-SDK tool loop with no
    // worktree. Computed before the prompt so it can frame truncation honestly,
    // and to gate `mcpSelf` / `reviewTools` on the stream.
    const kind = providerKind(ai.provider);
    const agenticRun = Boolean(ai.cliRepoAware);
    const mcpTools = agenticRun && kind !== null && kind !== "codex";
    const httpTools = agenticRun && kind === null;
    const agentic = agenticRun
      ? {
          // An HTTP run has no worktree even with a head, so files-on-disk needs
          // a CLI kind as well.
          filesOnDisk: Boolean(kind && context.headSha),
          mcpTools,
          httpTools,
          prNumber: target.kind === "remote" ? target.ref : undefined,
        }
      : undefined;
    // The native tool registry for an HTTP agentic run (empty otherwise).
    const reviewTools = httpTools
      ? buildReviewTools({
          repoPath: context.repoPath,
          headSha: context.headSha,
          prNumber:
            target.kind === "remote" && Number.isFinite(Number(target.ref))
              ? Number(target.ref)
              : undefined,
          provider: context.provider,
        })
      : undefined;
    const { system, prompt, coverage } = buildReviewPrompt(
      {
        title: context.title,
        body: context.body,
        commitSubjects: context.commitSubjects,
        diffText: diff.text,
        diffTruncated: diff.truncated,
        files: diff.files.map((f) => ({
          path: f.path,
          added: f.added,
          deleted: f.deleted,
          isBinary: f.isBinary,
        })),
        provider: context.provider,
        budgetProfile,
        agentic,
        ...prior,
        ...own,
        ...external,
      },
      mode,
    );

    await streamAi({
      ai,
      system,
      prompt,
      repoPath: context.repoPath,
      headSha: context.headSha,
      mcpSelf: mcpTools,
      reviewTools,
      setText: pushText,
      setStatus: (s) => patch({ status: s }),
      onThoughts: (t) => patch({ thoughts: t }),
      onCliId: (id) => {
        control.cliReviewId = id;
      },
      onAbort: (a) => {
        control.abort = a;
      },
    });
    if (control.cancelled) return;
    // A run WITH tools closes its own coverage gap, so only a non-agentic run that
    // saw a truncated diff drives the panel's upgrade nudge.
    patch({
      phase: "done",
      status: "",
      truncatedCoverage: coverage.diffTruncated && !agenticRun,
    });
    void notifyReviewDone(title, mode, true, target);
    // Persist the finished review so the NEXT run can use it as soft context.
    // The final text is read from the store (covers both the CLI and HTTP
    // paths); a cancelled run returns above, so no mid-stream fragment is ever
    // stored. Best-effort — a persistence failure must not surface to the user.
    const finalText = useReviewStore.getState().texts[key] ?? "";
    // The agentic run's narration, peeled off at settle — persisted as display-only
    // metadata (omitted when empty; the next run's soft context reads `text` alone).
    const thoughts = useReviewStore.getState().entries[key]?.thoughts;
    if (finalText.trim()) {
      void saveReview(target.repoPath, {
        schemaVersion: 1,
        id: crypto.randomUUID(),
        kind: target.kind,
        ref: target.ref,
        mode,
        model: ai.model,
        title,
        text: finalText,
        ...(thoughts?.trim() ? { thoughts } : {}),
        // Empty when the view supplied no head (degenerate no-commits state);
        // the next run then routes to the safe "indeterminate" delta path and
        // self-heals once a later review records a real SHA.
        headSha: context.headSha ?? "",
        startedAt: startedAtMs,
        finishedAt: Date.now(),
      })
        // Refresh the panel's history (banner + "Previous reviews") immediately,
        // not just on the next window focus / remount.
        .then(() =>
          queryClient.invalidateQueries({
            queryKey: [
              "review-history",
              target.repoPath,
              target.kind,
              target.ref,
            ],
          }),
        )
        .catch(() => undefined);
    }
  } catch (e) {
    if (!control.cancelled) {
      patch({
        phase: "error",
        status: "",
        // CLI failures reject with a plain AppError object (not an Error), so
        // `String(e)` would print "[object Object]" — use the shared extractor.
        error: errorMessage(e),
      });
      void notifyReviewDone(title, mode, false, target);
    }
  } finally {
    // Release the lane slot for the next queued run (only if this run actually
    // held one — a run cancelled while queued never did).
    if (control.hasSlot) {
      control.hasSlot = false;
      releaseSlot(lane);
    }
    // Only the owning run releases its handle — a cancel may have replaced us.
    if (controls.get(key) === control) controls.delete(key);
  }
}

/**
 * Cancels an in-flight run for `key`. HTTP providers stop via the AbortSignal;
 * CLI providers stop by killing the subprocess. Keeps whatever streamed so far
 * and marks the run cancelled. Safe to call when nothing is running.
 */
export function cancelReview(key: string): void {
  const control = controls.get(key);
  if (!control || control.cancelled) return;
  control.cancelled = true;
  control.abort?.abort();
  if (control.cliReviewId) {
    cancelAgentReview(control.cliReviewId).catch(() => undefined);
  }
  // If it's still queued, pull it from its lane's queue and wake its slot-wait
  // so the run unwinds — it never took a slot, so there's nothing to release.
  if (control.wakeQueued && control.lane) {
    const i = control.lane.waiting.indexOf(control);
    if (i >= 0) control.lane.waiting.splice(i, 1);
    control.wakeQueued();
  }
  // Automation rows (`auto:` keys) persist a "Cancelled" stopped row in the dock
  // (keeping their `rerun`, so Re-run/Dismiss work) — that stopped row IS the
  // cancel feedback now (the runner's toast still fires too). The runner sees
  // this patched "cancelled" phase and skips its own settle/remove for the row.
  // Both arms patch identically; the auto arm additionally caps retained stopped
  // rows so a long session can't accumulate them without bound.
  useReviewStore.getState().patch(key, { phase: "cancelled", status: "" });
  if (key.startsWith("auto:")) enforceStoppedCap();
  controls.delete(key);
}

/** Clears a finished review's text — used after posting it as a comment. */
export function resetReview(key: string): void {
  useReviewStore.getState().remove(key);
}

/**
 * Registers an automation-triggered review run in the store so it surfaces in
 * the header ActivityDock (and ActivityStrip) exactly like a manual run — a
 * "Running…" row with a working Cancel — instead of a floating persistent toast.
 *
 * Unlike {@link startReview}, the runner drives its own diff/prompt/stream and
 * sequencing, so this handle is intentionally minimal: it registers a running
 * entry + a control whose `abort` is the runner's own AbortController (so the
 * dock's Cancel aborts the HTTP stream / kills the CLI subprocess for free via
 * {@link cancelReview}), and hands back the few operations the runner needs.
 * Automation rows are never persisted to a finished state — every terminal path
 * calls `settle()` to remove the row, so its `target` is display metadata only.
 *
 * The key lives in a dedicated `auto:<n>` namespace off `reviewSeq`, which can
 * never collide with a panel run's `reviewKey` (`kind:repoPath#ref`).
 */
export function registerAutomationRun(opts: {
  title: string;
  mode: ReviewMode;
  local: boolean;
  target: ReviewTarget;
  abort: AbortController;
  /** Re-fires this exact run (event + mode) through the automation pipeline —
   *  stored on the entry so a stopped row's Re-run button can invoke it. */
  rerun: () => void;
}): {
  key: string;
  setCliId(id: string): void;
  isCancelled(): boolean;
  settle(): void;
  fail(message: string): void;
} {
  const seq = ++reviewSeq;
  const key = `auto:${seq}`;
  const control: RunControl = {
    abort: opts.abort,
    cliReviewId: null,
    cancelled: false,
    // The runner manages its own sequencing — no lane, no concurrency slot.
    hasSlot: false,
    wakeQueued: null,
    lane: null,
  };
  controls.set(key, control);
  useReviewStore.getState().patch(key, {
    phase: "running",
    status: "",
    mode: opts.mode,
    local: opts.local,
    title: opts.title,
    target: opts.target,
    seq,
    error: "",
    // Marks this as an automation row AND powers the stopped row's Re-run.
    rerun: opts.rerun,
  });
  return {
    key,
    setCliId(id) {
      control.cliReviewId = id;
    },
    // Closes over the control object, not the map: `cancelReview` sets
    // `cancelled = true` BEFORE deleting the control, so this stays readable
    // after a dock Cancel removes it from `controls`.
    isCancelled: () => control.cancelled,
    settle() {
      useReviewStore.getState().remove(key);
      // Only delete our own control — a dock Cancel may already have removed it.
      if (controls.get(key) === control) controls.delete(key);
    },
    // A genuine failure (not a user cancel): persist a "Failed" stopped row (the
    // entry keeps its `rerun`) instead of removing it, then cap retained stopped
    // rows. Deletes only our own control, mirroring settle's own-control guard.
    fail(message) {
      useReviewStore
        .getState()
        .patch(key, { phase: "error", error: message, status: "" });
      enforceStoppedCap();
      if (controls.get(key) === control) controls.delete(key);
    },
  };
}

/** The runs the activity dock shows, newest first (dismissing removes them). */
export function useReviewTasks(): ReviewTask[] {
  const entries = useReviewStore((s) => s.entries);
  return useMemo(
    () =>
      Object.entries(entries)
        .map(([key, e]) => ({ key, ...e }))
        .sort((a, b) => b.seq - a.seq),
    [entries],
  );
}

/**
 * Binds a PR's review run to a component. Reading goes through the keyed store,
 * so the run keeps streaming into the store even while this component is
 * unmounted; remounting re-attaches to the live (or finished) result.
 */
export function useReviewRun(target: ReviewTarget) {
  const key = reviewKey(target);
  const entry = useReviewStore((s) => s.entries[key]) ?? EMPTY_ENTRY;
  // Subscribed separately from `entry` so the per-token text updates re-render
  // only this panel, not the dock (which selects `entries`).
  const text = useReviewStore((s) => s.texts[key]) ?? "";
  const generate = useCallback(
    (
      ai: AiSettings,
      mode: ReviewMode,
      context: ReviewContext,
      ignorePrior?: boolean,
      ignoreExternal?: boolean,
    ) => {
      void startReview(
        target,
        context.title,
        ai,
        mode,
        context,
        ignorePrior,
        ignoreExternal,
      );
    },
    [target],
  );
  const cancel = useCallback(() => cancelReview(key), [key]);
  const reset = useCallback(() => resetReview(key), [key]);
  return {
    generate,
    cancel,
    reset,
    generating: entry.phase === "running" || entry.phase === "queued",
    text,
    status: entry.status,
    mode: entry.mode,
    model: entry.model,
    deltaState: entry.deltaState,
    /** The finished run saw a truncated diff and had no tools to compensate —
     *  drives the panel's "enable agentic review" nudge. */
    truncatedCoverage: entry.truncatedCoverage,
    /** Run phase, so the panel can show a failed run instead of silently
     *  reverting to the idle placeholder. */
    phase: entry.phase,
    /** Failure message when `phase === "error"`. */
    error: entry.error,
    /** The finished agentic run's streamed narration — shown behind a collapsed
     *  "Thought process" disclosure. Empty on non-agentic / codex runs. */
    thoughts: entry.thoughts ?? "",
  };
}
