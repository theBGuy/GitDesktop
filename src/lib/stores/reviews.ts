import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { cancelAgentReview, providerKind } from "@/lib/ai/agent";
import { resolveBudgetProfile } from "@/lib/ai/context-budget";
import {
  type DocSurfacesContext,
  resolveDocSurfacesContext,
} from "@/lib/ai/docs-context";
import {
  type ExternalContext,
  resolveExternalContext,
} from "@/lib/ai/external-context";
import { aiExcludePatterns, filterDiffByAiIgnore } from "@/lib/ai/ignore";
import { resolveReviewerNotesContext } from "@/lib/ai/notes-context";
import {
  type OwnCommentsContext,
  resolveOwnCommentsContext,
} from "@/lib/ai/own-context";
import { type PriorContext, resolvePriorContext } from "@/lib/ai/prior-context";
import { buildReviewPrompt } from "@/lib/ai/prompt";
import { isLocalProvider } from "@/lib/ai/providers";
import { reviewTimeoutSecs } from "@/lib/ai/review-timeout";
import { buildReviewTools } from "@/lib/ai/review-tools";
import { streamAi } from "@/lib/ai/stream";
import type {
  AiSettings,
  PromptProvider,
  ReviewDeltaState,
  ReviewMode,
} from "@/lib/ai/types";
import { track } from "@/lib/analytics";
import { readRepoInstructions } from "@/lib/git/api";
import type { DiffStatEntry, RemoteLens } from "@/lib/git/types";
import { notifyIfUnfocused } from "@/lib/notify";
import {
  reviewHistoryKey,
  reviewPartialKey,
  saveReview,
} from "@/lib/pulls/reviews-history";
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
  /** The origin|upstream lens the PR was opened under — scopes every per-PR store
   *  this run touches (prior reviews, the own-comments digest), since a fork's two
   *  lenses surface DIFFERENT PRs under the same number. "origin" for local PRs,
   *  which have no forge lens. */
  lens: RemoteLens;
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

/** Identifies the PR a review belongs to — also where its notification row navigates. */
export interface ReviewTarget {
  kind: "remote" | "local";
  repoPath: string;
  repoName: string;
  /** The lens the PR was opened under — part of the identity, since a fork's two
   *  lenses surface different PRs at the same `ref`. "origin" for local PRs. */
  lens: RemoteLens;
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
  /** Transient sub-status line shown while a CLI agent works or the context
   *  harvest distills. */
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
  /** Where the run came from — drives its notification row's click-through. */
  target: ReviewTarget;
  /** Monotonic start order — drives newest-first display and FIFO queue
   *  position exactly (a timestamp can collide within a millisecond). */
  seq: number;
  /** Epoch ms stamped when the run actually enters "running" — the queue wait is
   *  EXCLUDED, so the live elapsed measures real work time. Absent while queued. */
  startedAt?: number;
  /** Epoch ms stamped when the run reaches a terminal state (done/error/cancel).
   *  With `startedAt` it yields the run's total duration. */
  endedAt?: number;
  /** Failure message when `phase === "error"`. */
  error: string;
  /** When the run used prior-review context, how its "changes since" delta
   *  resolved — drives the panel's rewrite/indeterminate note. Undefined on a
   *  first run or when prior context was ignored. */
  deltaState?: ReviewDeltaState;
  /** The finished run's prompt carried a truncated diff AND the run had no tools to
   *  compensate — drives the panel's "enable agentic review" nudge. A tool-bearing run
   *  handles its own coverage, so this stays false there. */
  truncatedCoverage?: boolean;
  /** The agentic run's streamed working narration, set once at settle (arrives via
   *  a single patch, so it lives on the entry, not the per-token `texts` map). The
   *  panel shows it behind a "Thought process" disclosure; the dock ignores it. */
  thoughts?: string;
  /** The OTHER review mode a user queued behind this in-flight run — drives the panel's
   *  "runs next" chip. Set only while this entry is running/queued; cleared when the
   *  queued run starts or is dismissed. */
  queuedMode?: ReviewMode;
  /** Re-fires this run through the automation pipeline — set ONLY on automation rows
   *  (by {@link registerAutomationRun}). Its presence is the discriminator that a
   *  stopped row belongs in the dock's Stopped group: a manual run also reaches
   *  cancelled/error but never carries a rerun. */
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
  lens: "origin",
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

/** Stable store key for a review run. The lens segment keeps a fork's origin and
 *  upstream PRs — same number, different repos — on separate runs. */
export function reviewKey(t: {
  kind: string;
  repoPath: string;
  lens: RemoteLens;
  ref: string;
}): string {
  return `${t.kind}:${t.repoPath}#${t.lens}#${t.ref}`;
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

/** Per-run opt-outs for {@link startReview}'s soft context. One object rather than
 *  a tail of same-typed booleans: transposing two positional flags would silently
 *  suppress the WRONG context with no type error. Every field defaults to false
 *  (nothing suppressed). */
export interface ReviewIgnoreOptions {
  /** Skip the previous review's findings + the "changes since" delta. */
  ignorePrior?: boolean;
  /** Skip third-party AI-reviewer findings (Copilot/CodeRabbit/…). */
  ignoreExternal?: boolean;
  /** Skip the author's "Notes for reviewers". */
  ignoreNotes?: boolean;
}

/** A queued second review mode + the config captured when the user requested it.
 *  Same target/key as the in-flight run — only the mode and its settings differ. */
interface QueuedRun {
  ai: AiSettings;
  mode: ReviewMode;
  context: ReviewContext;
  title: string;
  /** The opt-outs as they stood when the user queued this run — replayed verbatim
   *  when it drains, so the queued run honors the toggles it was requested with. */
  opts: ReviewIgnoreOptions;
}

const controls = new Map<string, RunControl>();

/**
 * A second review mode queued behind an in-flight run, keyed by reviewKey — the interim
 * single-output-surface queue. Kept OUT of {@link RunControl} on purpose:
 * `cancelReview` detaches the control immediately, so a control-bound queue couldn't be
 * cleared by `dismissQueuedReview` in the cancel→settle window. Keying it here lets
 * Dismiss drop it — and the settle drain read it — regardless of the control's lifecycle.
 */
const queuedRuns = new Map<string, QueuedRun>();

/** Monotonic counter stamped on each run for exact start-order display. */
let reviewSeq = 0;

/** How many stopped (cancelled/error) automation rows the dock keeps at once. */
const MAX_STOPPED_ROWS = 8;

/**
 * After a transition to a stopped state, keep at most {@link MAX_STOPPED_ROWS} entries
 * that are automation (`auto:` key) AND stopped (cancelled/error), evicting the oldest
 * by `seq`. Manual panel runs and live/finished rows are never touched.
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
 * Two independent concurrency lanes so kicking off reviews on several PRs at once
 * doesn't overload the machine. Runs over a lane's cap enter the `queued` phase and
 * start FIFO as slots free; separate lanes so a local backlog never blocks a cloud run.
 *
 * - **local** (CLI agent subprocesses + local Ollama) is machine-bound, so its cap
 *   scales conservatively with CPU cores.
 * - **cloud** (streaming HTTP providers) spawns no process, so it's far higher — its
 *   real ceiling is the provider's rate limit, which is the user's to manage.
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
  /** Failure reason (from `errorMessage`), carried into the failed row's subtitle so the
   *  durable inbox record says WHY. Ignored on success. No Re-run action here (unlike
   *  automation): a manual re-fire closure would capture a stale AiSettings snapshot,
   *  whereas the panel's Run button re-resolves fresh config. */
  error?: string,
): Promise<void> {
  try {
    const { notifications } = await loadSettings();
    if (!notifications.reviews) return;
    const label = mode === "security" ? "security audit" : "review";
    const headline = ok ? `AI ${label} ready` : `AI ${label} failed`;
    // A failed review carries its reason in the subtitle; success stays subject-only.
    const subtitle =
      !ok && error?.trim() ? `"${title}" — ${error}` : `"${title}"`;
    // Durable record in the inbox (regardless of focus), plus the OS ping when
    // the window is hidden. Both ride the same `reviews` pref.
    pushNotification({
      kind: ok ? "review-ready" : "review-failed",
      tone: ok ? "success" : "danger",
      title: headline,
      subtitle,
      repoPath: target.repoPath,
      repoName: target.repoName,
      target: { type: "pr", kind: target.kind, ref: target.ref },
      // The lens is in the dedupe key because a fork's origin and upstream PRs share
      // a number: without it, two reviews settling in the same window collapse into
      // one notification. (The `target` above carries no lens, so the click-through
      // still lands on whichever lens the repo is currently set to.)
      dedupeKey: `review:${target.kind}:${target.repoPath}:${target.lens}:${target.ref}:${ok}`,
    });
    void notifyIfUnfocused(headline, subtitle);
  } catch {
    // best-effort — a missed notification must never affect the review
  }
}

/**
 * Starts an AI review (general or security) for a PR, keyed so the run is decoupled
 * from the view that triggered it: the run, its result, and its Cancel all survive
 * navigating away, because they live in this module + the store (surfaced by the
 * activity dock), not in a component. Routes to the Vercel AI SDK for HTTP providers or
 * a local agent CLI for CLI providers.
 *
 * On a re-run the PREVIOUS review's findings + a "changes since" delta ride along as
 * soft, re-verifiable context; on a remote PR so do third-party AI findings, our own
 * prior GitDesktop comments, and the author's "Notes for reviewers". Prior, external and
 * notes are each suppressed by their own flag in {@link ReviewIgnoreOptions}. The result
 * is persisted on success so the NEXT run can build on it.
 */
export async function startReview(
  target: ReviewTarget,
  title: string,
  ai: AiSettings,
  mode: ReviewMode,
  context: ReviewContext,
  opts: ReviewIgnoreOptions = {},
): Promise<void> {
  const {
    ignorePrior = false,
    ignoreExternal = false,
    ignoreNotes = false,
  } = opts;
  const key = reviewKey(target);
  // Single-flight per key — one review streams into the single per-PR entry at a
  // time. A request for the OTHER mode while a run is in flight isn't dropped: it's
  // remembered in `queuedRuns` (keyed by key, independent of the run's control) and
  // drained when this run settles (interim single-output-surface queue). A repeat of
  // the running mode is a no-op, and the cap is one queued — there are only two modes.
  const activeEntry = useReviewStore.getState().entries[key];
  if (activeEntry?.phase === "running" || activeEntry?.phase === "queued") {
    // The control check ensures there's a real in-flight run to queue behind.
    if (controls.has(key) && mode !== activeEntry.mode) {
      queuedRuns.set(key, {
        ai,
        mode,
        context,
        title,
        // The destructured defaults, not the raw `opts` — a queued run replays
        // exactly the flags this call resolved.
        opts: { ignorePrior, ignoreExternal, ignoreNotes },
      });
      useReviewStore.getState().patch(key, { queuedMode: mode });
    }
    return;
  }

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
  // A fresh run owns the key now: drop any queue left behind by a cancelled/superseded
  // predecessor, so that stale queued mode can't later drain onto THIS run (the
  // cancel-then-fresh-run resurrection guard, on the queuedRuns side).
  queuedRuns.delete(key);
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
    // A fresh run has nothing queued behind it yet; if this IS the drained queued
    // run, clear the chip now that it has become the active run.
    queuedMode: undefined,
    // Clear a prior run's stamps on this key so a re-run's live elapsed and
    // persisted duration start fresh (stamped at the running transition below).
    startedAt: undefined,
    endedAt: undefined,
  });

  // Wait for a slot in this run's lane (immediate when under the cap). A cancel
  // while queued wakes this too — `control.cancelled` then short-circuits below.
  await acquireSlot(lane, control);

  // Both read by the catch below, which persists whatever a failed run produced —
  // so they live outside the try. `startedAtMs` stays undefined for a failure that
  // never reached the stream (there's no run to have timed the span of).
  let startedAtMs: number | undefined;
  let timedOut = false;
  try {
    if (control.cancelled) return;
    // Wall-clock start, stamped once the run leaves the queue — the queue wait is
    // excluded. One value feeds both the live entry and the persisted record, so they
    // measure the same span.
    startedAtMs = Date.now();
    patch({ phase: "running", startedAt: startedAtMs });
    // Count a review when it actually starts — covers manual runs AND a drained queued
    // run, and skips a queued-then-dismissed one (which never reaches here).
    const tierModel = ai.model.toLowerCase();
    track({
      name: "ai_review_triggered",
      properties: {
        provider: ai.provider,
        model_tier:
          tierModel.includes("haiku") ||
          tierModel.includes("mini") ||
          tierModel.includes("flash")
            ? "fast"
            : tierModel.includes("opus") ||
                tierModel.includes("gpt-4o") ||
                tierModel.includes("sonnet-4")
              ? "powerful"
              : ai.provider === "ollama"
                ? "local"
                : "balanced",
      },
    });
    // Agentic run: in repo-aware mode the reviewer explores (what it can
    // actually reach is worked out with the prompt below).
    const agenticRun = Boolean(ai.cliRepoAware);
    // Independent of each other, and the settings are only needed by the filter
    // below — so they ride alongside the diff rather than in front of it.
    const [loaded, appSettings] = await Promise.all([
      context.loadDiff(),
      loadSettings(),
    ]);
    if (control.cancelled) return;
    // Applied to a NON-agentic review's diff, so a file withheld from generation
    // is withheld from review too. An agentic run is deliberately unfiltered —
    // its agent reads the checked-out worktree (CLI) or holds
    // `read_file`/`grep`/`pull_request_diff` (HTTP), so filtering the diff we
    // hand it would protect nothing.
    const excludePatterns = agenticRun
      ? []
      : await aiExcludePatterns(target.repoPath, appSettings.aiIgnorePatterns);
    if (control.cancelled) return;
    const filtered = await filterDiffByAiIgnore({
      repoPath: target.repoPath,
      text: loaded.text,
      files: loaded.files,
      exclude: excludePatterns,
    });
    if (control.cancelled) return;
    const diff = {
      text: filtered.text,
      truncated: loaded.truncated,
      files: filtered.files,
    };
    if (!diff.text.trim()) {
      // A no-op run shouldn't linger in the dock; a momentary toast is enough. Drop any
      // queued second mode too — same PR, same empty diff, so it would only load nothing
      // and toast "No changes" a second time. An all-excluded diff lands here too, and
      // says so rather than claiming a PR with visible changes has none.
      toast.info(
        filtered.excludedFiles > 0
          ? "Every changed file matches your AI ignore patterns — nothing to review."
          : "No changes to review.",
      );
      queuedRuns.delete(key);
      useReviewStore.getState().remove(key);
      return;
    }
    // Soft prior-review context (skipped when the user asked to ignore it). Runs
    // on a held slot after the diff loads — never during the queued wait.
    const prior: PriorContext = ignorePrior
      ? {}
      : await resolvePriorContext(
          target.repoPath,
          context.lens,
          target.kind,
          target.ref,
          mode,
          context.headSha,
          excludePatterns,
        );
    if (control.cancelled) return;
    patch({ deltaState: prior.deltaState });
    // Scale the prompt's character budgets to the reviewing model (per the user's
    // Review-context knob) — best-effort, never throws. Resolved BEFORE the own/external
    // harvest so the own-comments distill trigger + ledger cap key off the SAME scaled
    // budget, and reused verbatim at buildReviewPrompt (one resolution, used twice).
    const budgetProfile = await resolveBudgetProfile(
      ai,
      appSettings.reviewContextSize,
    );
    // The user's Review-timeout override (null = the backend's tier defaults).
    // CLI providers only; the HTTP path ignores it.
    const timeoutSecs = reviewTimeoutSecs(appSettings.reviewTimeout);
    if (control.cancelled) return;
    // Own-comments distillation runs a generation-model call that can outlast a dock
    // Cancel, and the review stream only gets an abort handle later (via `onAbort`).
    // Wire an AbortController in NOW so `cancelReview`'s `control.abort?.abort()`
    // reaches the distill; streamAi reassigns `control.abort` once the stream opens.
    const preAbort = new AbortController();
    control.abort = preAbort;
    // Third-party AI findings, GitDesktop's own prior comments, AND the author's "Notes
    // for reviewers" — all best-effort, remote-only soft context, resolved concurrently
    // (independent harvests of the PR's review activity). Kept as separate fetches; a
    // shared-fetch dedup is a later efficiency win.
    //
    // The doc-surface roster and the repo's instructions file ride along here: both
    // read the local working tree — whatever branch is checked out (see
    // `repoInstructionsClause`, guardrail 3) — and both apply to local PRs, so
    // neither is gated on `target.kind` the way the notes fetch above is.
    const [external, own, notes, docs, repoInstructions]: [
      ExternalContext,
      OwnCommentsContext,
      { reviewNotes?: string },
      DocSurfacesContext,
      string | null,
    ] = await Promise.all([
      resolveExternalContext(
        target.repoPath,
        target.kind,
        target.ref,
        context.headSha,
        ignoreExternal,
        context.provider,
        { budgetChars: budgetProfile.externalCharBudget },
      ),
      resolveOwnCommentsContext(
        target.repoPath,
        context.lens,
        target.kind,
        target.ref,
        context.provider,
        {
          distill: true,
          signal: preAbort.signal,
          ownBudgetChars: budgetProfile.ownCharBudget,
          // Distillation can hold this harvest for minutes on a CLI model. Surface it in
          // the dock's status row so the wait reads as work, not a hang. Gated on
          // `cancelled` like every other patch here: the callback fires after awaits
          // inside the distiller, so an un-gated write could stamp a cancelled row — or
          // a successor run for the same PR.
          onStatus: (s) => {
            if (!control.cancelled) patch({ status: s });
          },
        },
      ),
      // Notes are lifted from the marker comment the Create-PR dialog (or an MCP client)
      // posted, author-gated inside the resolver. Mode-agnostic — they ground a security
      // audit exactly as a general review. Bitbucket's conversation harvest yields
      // nothing here, so it's skipped.
      target.kind === "remote" &&
      /^\d+$/.test(target.ref) &&
      context.provider !== "bitbucket" &&
      !ignoreNotes
        ? resolveReviewerNotesContext(target.repoPath, Number(target.ref))
        : Promise.resolve({}),
      resolveDocSurfacesContext(target.repoPath),
      // Best-effort like every other read here: a missing or unreadable
      // `.gitdesktop/instructions.md` contributes nothing rather than failing review.
      readRepoInstructions(target.repoPath).catch(() => null),
    ]);
    if (control.cancelled) return;
    // Clear any distillation status the harvest set — the next writer is the review
    // stream's own `setStatus`. AFTER the cancel check, like every other post-await
    // patch: otherwise a cancel-then-rerun would blank the successor's status.
    patch({ status: "" });
    // What an agentic run (`agenticRun`, resolved above) can actually do. A CLI
    // provider reviews with the PR's files on disk and (for the tool-capable CLIs —
    // everything but codex) GitDesktop's own read-only MCP tools attached; an
    // HTTP provider (null kind) instead drives a native AI-SDK tool loop with no
    // worktree. Computed before the prompt so it can frame truncation honestly,
    // and to gate `mcpSelf` / `reviewTools` on the stream.
    const kind = providerKind(ai.provider);
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
        excludedFiles: filtered.excludedFiles,
        provider: context.provider,
        budgetProfile,
        agentic,
        repoInstructions,
        // Both instruction sources, exactly as every sibling prompt takes them.
        globalInstructions: appSettings.globalInstructions,
        ...prior,
        ...own,
        ...external,
        ...notes,
        ...docs,
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
      timeoutSecs,
      timeoutConfigurable: true,
      reviewTools,
      setText: pushText,
      setStatus: (s) => patch({ status: s }),
      onThoughts: (t) => patch({ thoughts: t }),
      onTimedOut: () => {
        timedOut = true;
      },
      onCliId: (id) => {
        control.cliReviewId = id;
      },
      onAbort: (a) => {
        control.abort = a;
      },
    });
    if (control.cancelled) return;
    // The stream's final text, read from the store so it covers the CLI and HTTP paths
    // alike; a cancelled run returned above, so this is never a mid-stream fragment.
    const finalText = useReviewStore.getState().texts[key] ?? "";
    // A run that settled with nothing failed, however the provider reported it — throw
    // so it rides the catch below (error phase + inbox row) rather than settling "done"
    // and announcing a review that isn't there.
    if (!finalText.trim()) throw new Error("The review run produced no text.");
    // A run WITH tools closes its own coverage gap, so only a non-agentic run that
    // saw a truncated diff drives the panel's upgrade nudge.
    patch({
      phase: "done",
      status: "",
      truncatedCoverage: coverage.diffTruncated && !agenticRun,
      endedAt: Date.now(),
    });
    void notifyReviewDone(title, mode, true, target);
    // Persist the finished review so the NEXT run can use it as soft context.
    // Best-effort.
    // The agentic run's narration, peeled off at settle — persisted as display-only
    // metadata (omitted when empty; the next run's soft context reads `text` alone).
    const thoughts = useReviewStore.getState().entries[key]?.thoughts;
    if (finalText.trim()) {
      void saveReview(target.repoPath, {
        schemaVersion: 1,
        id: crypto.randomUUID(),
        kind: target.kind,
        ref: target.ref,
        lens: context.lens,
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
            queryKey: reviewHistoryKey(
              target.repoPath,
              context.lens,
              target.kind,
              target.ref,
            ),
          }),
        )
        .catch(() => undefined);
    }
  } catch (e) {
    if (!control.cancelled) {
      // CLI failures reject with a plain AppError object (not an Error), so `String(e)`
      // would print "[object Object]" — use the shared extractor. Computed once: the
      // store patch and the inbox subtitle read the same reason.
      const message = errorMessage(e);
      patch({
        phase: "error",
        status: "",
        error: message,
        endedAt: Date.now(),
      });
      void notifyReviewDone(title, mode, false, target, message);
      // Whatever the run produced before it failed — this store is memory-only, so
      // without a record a timed-out 20-minute run is gone at the next restart. Saved
      // as a PARTIAL record (`phase`), which the history reads exclude: it's kept
      // output, never a review the next run may build on.
      const partial = useReviewStore.getState().texts[key] ?? "";
      if (partial.trim() && startedAtMs !== undefined) {
        void saveReview(target.repoPath, {
          schemaVersion: 1,
          id: crypto.randomUUID(),
          kind: target.kind,
          ref: target.ref,
          lens: context.lens,
          mode,
          model: ai.model,
          title,
          text: partial,
          phase: "error",
          error: message,
          ...(timedOut ? { timedOut: true } : {}),
          headSha: context.headSha ?? "",
          startedAt: startedAtMs,
          finishedAt: Date.now(),
        })
          .then(() =>
            queryClient.invalidateQueries({
              queryKey: reviewPartialKey(
                target.repoPath,
                context.lens,
                target.kind,
                target.ref,
              ),
            }),
          )
          .catch(() => undefined);
      }
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
    // Drain the queued second mode on ANY terminal outcome incl. user-cancel (it's
    // independent work the user asked for; the chip's Dismiss is the only stop). Only
    // when the key is now unclaimed — if a DIFFERENT run has since claimed it (cancel
    // then fresh review), that run owns the queue and draining would resurrect ours.
    if (!controls.has(key)) {
      const next = queuedRuns.get(key);
      queuedRuns.delete(key);
      if (next) {
        void startReview(
          target,
          next.title,
          next.ai,
          next.mode,
          next.context,
          next.opts,
        );
      }
    }
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
  // Automation rows (`auto:` keys) persist a "Cancelled" stopped row in the dock,
  // keeping their `rerun` so Re-run/Dismiss work — that row IS the cancel feedback. The
  // runner sees this patched "cancelled" phase and skips its own settle/remove. Both
  // arms patch identically; the auto arm additionally caps retained stopped rows.
  useReviewStore
    .getState()
    .patch(key, { phase: "cancelled", status: "", endedAt: Date.now() });
  if (key.startsWith("auto:")) enforceStoppedCap();
  controls.delete(key);
}

/** Clears a finished review's text — used after posting it as a comment. */
export function resetReview(key: string): void {
  useReviewStore.getState().remove(key);
}

/**
 * Drops a review mode queued behind an in-flight run before it starts — the chip's
 * Dismiss action. Safe to call when nothing is queued.
 */
export function dismissQueuedReview(key: string): void {
  // Drop the queued run regardless of the control's lifecycle — reachable even after
  // `cancelReview` has detached the control (the cancel→settle window).
  queuedRuns.delete(key);
  // Only clear the chip when the entry actually exists: patch() would otherwise
  // synthesize a phantom idle entry (EMPTY_ENTRY) that useReviewTasks renders.
  if (useReviewStore.getState().entries[key]) {
    useReviewStore.getState().patch(key, { queuedMode: undefined });
  }
}

/**
 * Registers an automation-triggered review run in the store so it surfaces in the header
 * ActivityDock (and ActivityStrip) exactly like a manual run — a "Running…" row with a
 * working Cancel.
 *
 * Unlike {@link startReview}, the runner drives its own diff/prompt/stream and
 * sequencing, so this handle is intentionally minimal: it registers a running entry + a
 * control whose `abort` is the runner's own AbortController (so the dock's Cancel aborts
 * the stream / kills the CLI subprocess via {@link cancelReview}), and hands back the few
 * operations the runner needs. A clean terminal path calls `settle()` to remove the row;
 * `fail()` instead keeps it as a stopped "Failed" row.
 *
 * The key lives in a dedicated `auto:<n>` namespace off `reviewSeq`, which can never
 * collide with a panel run's `reviewKey` (`kind:repoPath#lens#ref`).
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
    // Automation rows are running from the moment they register — registration
    // IS their start, so stamp it here (there's no queue wait to exclude).
    startedAt: Date.now(),
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
    // A genuine failure (not a user cancel): keep a "Failed" stopped row (the entry
    // keeps its `rerun`) instead of removing it, then cap retained stopped rows.
    fail(message) {
      useReviewStore.getState().patch(key, {
        phase: "error",
        error: message,
        status: "",
        endedAt: Date.now(),
      });
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
      opts?: ReviewIgnoreOptions,
    ) => {
      void startReview(target, context.title, ai, mode, context, opts);
    },
    [target],
  );
  const cancel = useCallback(() => cancelReview(key), [key]);
  const reset = useCallback(() => resetReview(key), [key]);
  const dismissQueued = useCallback(() => dismissQueuedReview(key), [key]);
  return {
    generate,
    cancel,
    reset,
    dismissQueued,
    generating: entry.phase === "running" || entry.phase === "queued",
    /** The OTHER review mode queued behind the in-flight run (interim
     *  single-output-surface queue) — drives the "runs next" chip; undefined when
     *  nothing is queued. */
    queuedMode: entry.queuedMode,
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
    /** Epoch ms when the run entered "running" (queue wait excluded) — the anchor
     *  for a live elapsed/duration surface. Absent while queued or idle. */
    startedAt: entry.startedAt,
    /** Epoch ms when the run reached a terminal state — with `startedAt` yields
     *  the run's total duration. Absent while still running. */
    endedAt: entry.endedAt,
  };
}
