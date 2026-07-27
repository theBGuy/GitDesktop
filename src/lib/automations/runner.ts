import { toast } from "sonner";
import { createAiClient } from "@/lib/ai/client";
import { buildAiCommentBody } from "@/lib/ai/comment-branding";
import { resolveBudgetProfile } from "@/lib/ai/context-budget";
import { resolveDocSurfacesContext } from "@/lib/ai/docs-context";
import {
  type ExternalContext,
  resolveExternalContext,
} from "@/lib/ai/external-context";
import { resolveReviewerNotesContext } from "@/lib/ai/notes-context";
import {
  type OwnCommentsContext,
  resolveOwnCommentsContext,
} from "@/lib/ai/own-context";
import { type PriorContext, resolvePriorContext } from "@/lib/ai/prior-context";
import { buildReviewPrompt } from "@/lib/ai/prompt";
import { isCliProvider, isLocalProvider } from "@/lib/ai/providers";
import { reviewTimeoutSecs } from "@/lib/ai/review-timeout";
import { runCliStream } from "@/lib/ai/stream";
import type { AiSettings, PromptProvider, ReviewMode } from "@/lib/ai/types";
import {
  forgePrComment,
  forgePrDiff,
  forgeStatus,
  gitBranchDiff,
  gitCommitDiff,
  readRepoInstructions,
} from "@/lib/git/api";
import { repoIdentity } from "@/lib/git/repo-identity";
import type { DiffStatEntry } from "@/lib/git/types";
import { notifyIfUnfocused } from "@/lib/notify";
import { listLocalPrs, updateLocalPr } from "@/lib/pulls/local";
import { getLatestReview, saveReview } from "@/lib/pulls/reviews-history";
import { queryClient } from "@/lib/query-client";
import { effectiveReviewAi, loadSettings } from "@/lib/settings/api";
import { pushNotification } from "@/lib/stores/notifications";
import {
  type ReviewTarget,
  registerAutomationRun,
  resetReview,
} from "@/lib/stores/reviews";
import { errorMessage, invoke } from "@/lib/tauri/invoke";
import {
  clearDismissedHead,
  getDismissedHead,
  setDismissedHead,
} from "./dismissals";
import { useAutomationResults } from "./results";
import { loadAutomations, repoAutomationsFor } from "./store";
import { sameSha } from "./sync";
import { branchConditionsPass, effectiveActions } from "./types";

export type AutomationEvent =
  | {
      kind: "commit";
      repoPath: string;
      hash: string;
      title: string;
      /** Current branch at commit time; "" when detached/unknown. */
      branch: string;
    }
  | {
      kind: "pr-open";
      repoPath: string;
      base: string;
      head: string;
      /** Head commit SHA at trigger time — the delta anchor persisted so a later
       *  (manual or automated) re-review can compute "what changed since". */
      headSha?: string;
      title: string;
      body: string;
      commitSubjects: string[];
      /** The author's "Notes for reviewers", carried straight from the Create-PR
       *  dialogs so the review that fires on open sees them without a comment
       *  round-trip. Absent on catch-up / synthesized events (those recover the
       *  notes from the marker comment via `resolveReviewerNotesContext`). */
      reviewNotes?: string;
      target:
        | { type: "remote"; number: number }
        | { type: "local"; id: string };
    }
  | {
      kind: "pr-sync";
      repoPath: string;
      base: string;
      head: string;
      /** The PR head's CURRENT tip SHA (the new commits). The runner re-reviews
       *  only when this is past the last-reviewed head for the rule's mode. */
      headSha?: string;
      title: string;
      body: string;
      commitSubjects: string[];
      target:
        | { type: "remote"; number: number }
        | { type: "local"; id: string };
    };

/** PR-targeted events (pr-open + pr-sync) share delivery, persistence, and
 *  prior-context handling — only their trigger semantics differ. */
type PrAutomationEvent = Extract<
  AutomationEvent,
  { kind: "pr-open" | "pr-sync" }
>;

const DIFF_MAX_BYTES = 200_000;

/** How often a running automation refreshes its cross-instance claim file's mtime.
 *  Rust's `STALE_CLAIM_AGE` (automation_claims.rs) reclaims a claim after 30 minutes
 *  of silence, so 5 minutes (30/6) leaves a generous margin for timer drift while a
 *  long review — the Review-timeout setting allows up to 60 minutes — keeps its
 *  claim alive. Without it, a second instance would reclaim a LIVE run and post a
 *  duplicate paid review. (Timers don't fire during OS suspend, so a 30+ minute
 *  sleep mid-run can still go stale on resume — the same bounded single-duplicate
 *  residual as before the heartbeat.) */
const CLAIM_HEARTBEAT_MS = 5 * 60 * 1000;

/** Upper bound on heartbeats per run: 30 × 5 min = 150 minutes. The cap runs from
 *  the heartbeat's ARM (top of the try, before prompt building), so it must cover
 *  the backend's 7200s max kill clamp — reachable by hand-editing settings.json;
 *  the UI tops out at 60 min — PLUS the pre-stream phase (diff load, context
 *  harvest, distill), with margin. A run still unsettled past that is wedged — an
 *  HTTP stream has no deadline at all, and a stalled fetch (e.g. a LAN Ollama box
 *  asleep mid-stream) never settles, so its `finally` never runs. Stopping the
 *  heartbeat lets the claim age out (`STALE_CLAIM_AGE` + this cap) so a second
 *  instance can recover the head — the recovery the stale-reclaim exists for. */
const CLAIM_HEARTBEAT_MAX_BEATS = 30;

/** The store key for a PR target, used to look up its review-history watermark. */
function targetRef(event: PrAutomationEvent): string {
  return event.target.type === "remote"
    ? String(event.target.number)
    : event.target.id;
}

function modeLabel(mode: ReviewMode): "security audit" | "review" {
  return mode === "security" ? "security audit" : "review";
}

/**
 * Builds the {@link ReviewTarget} for an automation run's ActivityDock row. For
 * PR events it's a real target (its `kind`/`ref`/repo drive the row's label +
 * "View" metadata); commit events have no PR, so their target is a degenerate
 * remote placeholder. Either way it's DISPLAY-ONLY: automation rows are removed
 * on settle and never persisted to a finished/"View"-able state. `repoName`
 * falls back to the repo directory's basename (the app's idiom), since the
 * automation event carries no repo name.
 */
function automationTarget(event: AutomationEvent): ReviewTarget {
  const repoName = event.repoPath.split(/[/\\]/).pop() ?? event.repoPath;
  if (event.kind === "commit") {
    return { kind: "remote", repoPath: event.repoPath, repoName, ref: "" };
  }
  return {
    kind: event.target.type,
    repoPath: event.repoPath,
    repoName,
    ref: targetRef(event),
  };
}

/** Derives a per-file +/- summary from unified diff text — for `gh pr diff`,
 *  which (unlike `git diff --numstat`) returns no file counts. */
function filesFromDiff(text: string): DiffStatEntry[] {
  return text
    .split(/^(?=diff --git )/m)
    .filter((s) => s.trim())
    .map((section) => {
      const header = section.slice(0, section.indexOf("\n"));
      const path = header.match(/ b\/(.+)$/)?.[1] ?? header;
      let added = 0;
      let deleted = 0;
      for (const line of section.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) added++;
        else if (line.startsWith("-") && !line.startsWith("---")) deleted++;
      }
      return {
        path,
        added,
        deleted,
        isBinary: section.includes("\nBinary files "),
      };
    });
}

/**
 * Fire-and-forget entry point: runs every automation rule matching the
 * event, sequentially (one model stream at a time). Each rule reports its
 * own progress toast; a failing rule never blocks the action that
 * triggered it or the remaining rules.
 */
export function triggerAutomations(event: AutomationEvent): void {
  void run(event).catch(() => undefined);
}

/** What a {@link run} pass did, so a re-run can tell the outcomes apart:
 *  - `matched`: rules that exist AND apply to this event (past the `only` +
 *    branch-condition gates). 0 means the rule genuinely no longer applies
 *    (e.g. disabled since) — the honest "turned off" case.
 *  - `attempted`: runs actually started (past every gate incl. sync watermark +
 *    cross-instance claim). `matched > 0 && attempted === 0` means a rule applies
 *    but a claim/watermark blocked it — a retryable "already covered" case. */
interface RunOutcome {
  matched: number;
  attempted: number;
}

/**
 * Runs the automation rules matching `event`. When `only` is set (a re-run of a
 * single stopped row), every rule whose mode differs is skipped, so exactly that
 * one mode re-fires. `replacesKey` is the stopped row a re-run replaces — removed
 * the instant its replacement run registers (see below), so the stopped row never
 * lingers next to its fresh Running row and is kept when nothing registers.
 * Returns a {@link RunOutcome} so a re-run can distinguish "rule gone" from
 * "blocked but retryable" from "started".
 */
async function run(
  event: AutomationEvent,
  only?: ReviewMode,
  replacesKey?: string,
): Promise<RunOutcome> {
  const config = await loadAutomations();
  const repo = await repoAutomationsFor(config, event.repoPath);
  const actions = effectiveActions(config, repo, event.kind);
  if (actions.length === 0) return { matched: 0, attempted: 0 };
  let matched = 0;
  let attempted = 0;
  // Cleared once consumed so a second registering action can't double-remove
  // (harmless — resetReview no-ops on a missing key — but keeps intent explicit).
  let staleKey = replacesKey;

  // The branch(es) a branch-condition is tested against. Commit events carry the
  // committed branch; PR events carry head/base (added by the poll payload).
  const branch = event.kind === "commit" ? event.branch : undefined;
  const head = event.kind === "commit" ? undefined : event.head;
  const base = event.kind === "commit" ? undefined : event.base;

  const settings = await loadSettings();
  const notify = settings.notifications.automations;
  for (const { action, conditions } of actions) {
    // Re-run scoping: a stopped-row Re-run targets exactly one mode, so skip every
    // other rule this event would otherwise fire. Normal triggers pass `only`
    // undefined and run every matching rule.
    if (only && action !== only) continue;
    // Branch scoping: skip an action whose include/exclude globs don't admit
    // this event's branch(es). Undefined conditions always pass.
    if (
      !branchConditionsPass(conditions, {
        kind: event.kind,
        branch,
        head,
        base,
      })
    ) {
      continue;
    }
    // Past the mode + branch gates — this rule exists AND applies. Counted so a
    // re-run can tell "rule genuinely gone" (matched 0) from "rule applies but a
    // claim/watermark blocked it" (matched > 0, attempted 0 → retryable).
    matched++;
    // pr-sync is opt-in per PR: re-review only a PR already reviewed in this
    // mode, and only once its head has advanced past the last-reviewed commit
    // (the persisted review's headSha is the per-mode watermark). This scopes
    // auto re-review to PRs you're actively iterating on and avoids re-firing
    // for a head that mode already covered.
    if (event.kind === "pr-sync") {
      const headSha = event.headSha ?? "";
      const prior = await getLatestReview(
        event.repoPath,
        event.target.type,
        targetRef(event),
        action,
      );
      // A CANCELLED re-review persists the dismissed head (see below), so a
      // cancelled head doesn't re-fire after an app relaunch — only a genuinely
      // newer head does.
      const dismissedHead = await getDismissedHead(
        event.repoPath,
        event.target.type,
        targetRef(event),
        action,
      );
      // sameSha (not `===`) so a short-vs-full sha for the SAME head (Bitbucket's
      // 12-char poll head vs a full-40 seed) counts as "already reviewed" and
      // doesn't re-fire a redundant review each poll tick.
      if (
        !prior ||
        sameSha(prior.headSha, headSha) ||
        sameSha(dismissedHead ?? "", headSha)
      ) {
        continue;
      }
    }
    // pr-open is FIRST-review per mode: skip any mode that already has a review record
    // for this PR (real pr-open events are then idempotent per mode, and per-mode
    // catch-up synthesis is safe — a synthesized pr-open re-fires only the mode(s) that
    // still have no record). Also skip a head this mode already dismissed. Mirrors the
    // pr-sync gate above; the difference is pr-sync requires a prior (re-review), while
    // pr-open requires the ABSENCE of one (first review).
    if (event.kind === "pr-open") {
      const prior = await getLatestReview(
        event.repoPath,
        event.target.type,
        targetRef(event),
        action,
      );
      if (prior) continue;
      const dismissedHead = await getDismissedHead(
        event.repoPath,
        event.target.type,
        targetRef(event),
        action,
      );
      if (event.headSha && sameSha(dismissedHead ?? "", event.headSha)) {
        continue;
      }
    }
    // Cross-instance dedup: claim this exact run atomically BEFORE any (paid) AI
    // work, so two instances watching the same repo (a main checkout + a linked
    // worktree share a worktree-stable identity) don't both post the same review.
    // The claim key is (repo identity, target, head, action); commit events have no
    // PR target and key on their commit hash as the head. Skipped when there's no
    // meaningful head to key on (status-quo behavior). Fail-open: a claim
    // infrastructure error must never disable automations. `won === false` means
    // another instance already owns this run — skip it here.
    const headSha =
      event.kind === "commit" ? event.hash : (event.headSha ?? "");
    const claimTarget = event.kind === "commit" ? "" : targetRef(event);
    // The resolved worktree-stable key the claim was made under — reused verbatim for
    // release so both target the SAME claim file (releasing under the raw path would
    // miss it). Empty until a claim is actually taken.
    let claimKey = "";
    if (headSha) {
      const repoKey = await repoIdentity(event.repoPath);
      let won = true;
      try {
        won = await invoke<boolean>("claim_automation_run", {
          repoKey,
          target: claimTarget,
          headSha,
          action,
        });
      } catch {
        // fail open — a claim-infrastructure error must not disable automations
      }
      if (!won) continue; // another instance owns this run
      claimKey = repoKey;
    }
    // Liveness heartbeat for the claim we just won: while this run is in flight we
    // refresh its claim file's mtime, so the Rust stale-reclaim window measures "this
    // instance went quiet" rather than "this review is slow". A 45/60-minute Review
    // timeout would otherwise outlive the 30-minute window and let a second instance
    // reclaim a LIVE run. Best-effort, like claim/release. Declared here, ARMED as the
    // `try`'s first statement below: an interval leaked by a throw outside the
    // `finally` would refresh the claim forever, defeating both the 30-minute reclaim
    // and the 30-day sweep (both mtime-keyed) for the life of the process.
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const stopHeartbeat = () => {
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
    };
    // Release this instance's claim (best-effort) so a non-delivering terminal path
    // (failure/cancel/no-op) doesn't permanently suppress the automation for this
    // head across instances. A successfully DELIVERED review keeps its claim.
    const releaseClaim = () => {
      if (!claimKey) return;
      void invoke("release_automation_claim", {
        repoKey: claimKey,
        target: claimTarget,
        headSha,
        action,
      }).catch(() => undefined);
    };

    const label = modeLabel(action);
    // The AI config this rule's mode runs under: security audits use the
    // dedicated `securityReviewAi` when configured, else fall back to `reviewAi`
    // (general reviews always use `reviewAi`). Resolved once so the lane pick,
    // the review generation, the delivered comment's model label, and the
    // persisted history model all agree.
    const reviewCfg = effectiveReviewAi(settings, action);
    // Per-rule cancellation: HTTP providers stop via the AbortSignal; CLI
    // providers stop by killing the subprocess (`cancelAgentReview` once we know
    // its id). Both are driven by the shared reviews store: the run registers a
    // "Running…" row in the header ActivityDock, and the dock's Cancel calls
    // `cancelReview`, which aborts THIS controller and kills the CLI subprocess —
    // no floating persistent toast. `handle.isCancelled()` stays readable after a
    // dock Cancel, so the guards below skip delivery + the failure toast.
    // Past every skip gate — this run is actually attempted (counted so a
    // Re-run that matches nothing can toast instead of dying silently).
    attempted++;
    const controller = new AbortController();
    // Wall-clock run start, mirrored into the persisted history record so an
    // automated review carries a real duration (registerAutomationRun stamps
    // the live dock entry's own `startedAt` at the same moment).
    const runStartedMs = Date.now();
    // Let-box so the rerun closure carries THIS run's own key (assigned right
    // after registration): a re-run of the fresh row must replace the fresh row,
    // not the stale one it grew from.
    let selfKey = "";
    const handle = registerAutomationRun({
      // TaskRow already prefixes the mode name, so pass the bare subject.
      title: event.kind === "commit" ? event.hash.slice(0, 7) : event.title,
      mode: action,
      // Same provider-kind signal the manual panel path uses to pick its lane.
      local: isLocalProvider(reviewCfg.provider),
      target: automationTarget(event),
      abort: controller,
      // Re-fires THIS event + mode (closes over this iteration's action) when the
      // run's stopped row's Re-run is clicked, passing its own row key so the
      // fresh run removes THIS row when it registers.
      rerun: () => rerunAutomation(event, action, selfKey),
    });
    selfKey = handle.key;
    // The replacement run has now registered its fresh Running row — remove the
    // stopped row it replaces (a re-run only). Done here (not at the Re-run click)
    // so the old row is kept whenever nothing registers (rule gone / blocked),
    // giving the user a retry target. Cleared so a second registering action in
    // the same pass can't re-trigger the removal.
    if (staleKey) {
      resetReview(staleKey);
      staleKey = undefined;
    }
    // On cancel, persist the dismissed PR head so a cancelled re-review doesn't
    // re-fire after an app relaunch (cancel advances no history watermark). PR
    // events with a headSha only; best-effort — a persistence failure must never
    // change the cancel outcome. Not written on non-cancel failures, which stay
    // retryable.
    const dismissOnCancel = () => {
      if (event.kind === "commit" || !event.headSha) return;
      void setDismissedHead(
        event.repoPath,
        event.target.type,
        targetRef(event),
        action,
        event.headSha,
      ).catch(() => undefined);
    };
    try {
      // First statement inside the try, so the arm and the `finally`'s disarm can
      // never be separated by a throw (see the heartbeat comment above).
      if (claimKey) {
        let beats = 0;
        heartbeat = setInterval(() => {
          // Bounded so a wedged, never-settling run can't keep its claim fresh
          // forever (see CLAIM_HEARTBEAT_MAX_BEATS).
          if (beats >= CLAIM_HEARTBEAT_MAX_BEATS) {
            stopHeartbeat();
            return;
          }
          beats += 1;
          void invoke("touch_automation_claim", {
            repoKey: claimKey,
            target: claimTarget,
            headSha,
            action,
          }).catch(() => undefined);
        }, CLAIM_HEARTBEAT_MS);
      }
      const result = await generateReviewText(
        reviewCfg,
        action,
        event,
        controller.signal,
        handle.setCliId,
      );
      if (handle.isCancelled()) {
        // The dock's Cancel already patched the row to "cancelled" (keeping its
        // Re-run) and deleted the control — do NOT settle/remove it here. Keep
        // the claim release + dismissed-head persist + toast exactly as before.
        releaseClaim();
        dismissOnCancel();
        toast.info(`AI ${label} cancelled.`, { duration: 4000 });
        continue;
      }
      if (result === null) {
        releaseClaim();
        toast.info(`AI ${label} skipped — no changes to review.`);
        handle.settle(); // no-op run: remove the row as before
        continue;
      }
      const { text, thoughts } = result;
      // The delivered comment body carries the final review text ONLY — the
      // agentic narration is persisted to history for later inspection, never
      // posted (buildAiCommentBody + deliver both take `text`).
      const body = buildAiCommentBody({
        kind: label,
        model: reviewCfg.model,
        automated: true,
        text,
      });
      await deliver(event, action, body, text, notify);
      // Seed the review-history store so an automated review participates in the
      // iterative loop — the next run (manual or auto) builds on these findings,
      // and its headSha becomes the pr-sync watermark. Best-effort: a
      // persistence failure must never fail a delivered review.
      if (event.kind === "pr-open" || event.kind === "pr-sync") {
        await persistReviewHistory(
          event,
          action,
          text,
          reviewCfg.model,
          thoughts,
          runStartedMs,
        ).catch(() => undefined);
      }
      // Success: remove the dock row — a delivered review lands in Notifications.
      handle.settle();
    } catch (e) {
      // Release the claim on every failure/cancel path so a transient error doesn't
      // permanently suppress this automation for this head across instances.
      releaseClaim();
      if (handle.isCancelled()) {
        // Cancelled mid-stream: same as the post-generate cancel arm — the dock
        // already owns the "cancelled" row, so leave it (do not settle).
        dismissOnCancel();
        toast.info(`AI ${label} cancelled.`, { duration: 4000 });
        continue;
      }
      // errorMessage unwraps AppError/Error shapes — a raw interpolation renders
      // Tauri invoke rejections as "[object Object]" (observed live).
      const message = errorMessage(e);
      toast.error(`AI ${label} failed: ${message}`);
      // Inbox parity with manual runs (which land a review-failed inbox row via
      // reviews.ts's notifyReviewDone): a genuine automation failure records one
      // too, gated on the same automations pref. Commit events have no PR target;
      // PR events carry a navigable one.
      if (notify) {
        // Carry the failure reason into the durable subtitle so the inbox row
        // (and the OS ping) say WHY — subject-only when the reason is empty.
        const subject =
          event.kind === "commit"
            ? `"${event.hash.slice(0, 7)}"`
            : `"${event.title}"`;
        const subtitle = message.trim() ? `${subject} — ${message}` : subject;
        // Local alias for the loop's `action: ReviewMode` — the Re-run closure's
        // `run` body sees the outer `action` fine, but aliasing keeps the object
        // literal (which also has a field named `action`) unambiguous to read.
        const mode = action;
        pushNotification({
          kind: "review-failed",
          tone: "danger",
          title: `AI ${label} failed`,
          subtitle,
          repoPath: event.repoPath,
          repoName: event.repoPath.split(/[/\\]/).pop() ?? event.repoPath,
          ...(event.kind === "commit"
            ? {}
            : {
                target: {
                  type: "pr",
                  kind: event.target.type,
                  ref: targetRef(event),
                },
              }),
          // Re-fires exactly this event + mode. `selfKey` is this run's stopped
          // dock row (already assigned); passing it when the row was dismissed is
          // safe — resetReview no-ops on a gone key.
          action: {
            label: "Re-run",
            run: () => rerunAutomation(event, mode, selfKey),
          },
          dedupeKey: `automation-failed:${event.repoPath}:${event.kind}:${
            event.kind === "commit" ? event.hash : targetRef(event)
          }:${action}`,
        });
        void notifyIfUnfocused(`AI ${label} failed`, subtitle);
      }
      // Persist a "Failed" stopped row (keeping its Re-run) instead of removing it.
      handle.fail(message);
    } finally {
      // Every terminal path lands here — including the `continue`s in both arms and
      // the delivered-success path, which keeps its claim but must still stop
      // heartbeating it.
      stopHeartbeat();
    }
  }
  return { matched, attempted };
}

/**
 * Re-fires a stopped (cancelled/failed) automation run for exactly one mode —
 * invoked by a stopped row's Re-run button. Fire-and-forget, like
 * {@link triggerAutomations}.
 *
 * For PR events it first clears the dismissed-head watermark for this (target,
 * mode): a cancelled run wrote one, and without clearing it the re-run would
 * silently no-op at the runner's `sameSha(dismissedHead, headSha)` pr-sync gate.
 * The run then flows through the normal pipeline scoped to `only`, so it
 * re-claims (canceled/failed runs released their claim) and re-reviews just that
 * mode. If the rule was disabled since the run stopped, nothing matches and we
 * surface an informative toast rather than a silent dead button.
 */
export function rerunAutomation(
  event: AutomationEvent,
  only: ReviewMode,
  staleKey: string,
): void {
  const label = modeLabel(only);
  const noun = event.kind === "commit" ? "commit" : "pull request";
  void (async () => {
    try {
      // Best-effort ONLY here: a cleared-dismissal failure must not block the
      // re-run (it just means the pr-sync gate might skip; we then toast retryable).
      if (event.kind !== "commit") {
        await clearDismissedHead(
          event.repoPath,
          event.target.type,
          targetRef(event),
          only,
        ).catch(() => undefined);
      }
      // The stopped row is removed inside run() the instant its replacement
      // registers — so every non-registering outcome below keeps it as a retry
      // target.
      const { matched, attempted } = await run(event, only, staleKey);
      if (matched === 0) {
        // The rule genuinely no longer applies (disabled / conditions changed).
        toast.info(`Automated ${label} for this ${noun} is turned off.`);
      } else if (attempted === 0) {
        // A rule applies, but a still-held claim or a sync watermark blocked the
        // run (a canceled sibling still unwinding, or another instance covering
        // this head). The stopped row is kept — retry once that clears.
        toast.info(
          `Couldn't re-run the ${label} — another run already covers this head (still finishing or ran elsewhere). The row is kept; try again in a moment.`,
        );
      }
      // attempted > 0: the fresh Running row is the feedback — no toast.
    } catch (e) {
      // A throw anywhere (loadAutomations / store I/O before the loop, etc.) used
      // to be swallowed, leaving no feedback. Surface it; the stopped row stays.
      toast.error(`Couldn't re-run the ${label}: ${errorMessage(e)}`);
    }
  })();
}

/** A completed automated review: the final answer `text` plus any agentic
 *  narration `thoughts` (empty for non-agentic / codex / HTTP-text runs). */
interface ReviewResult {
  text: string;
  thoughts: string;
}

/**
 * Resolves the diff, builds the prompt, and runs the model to completion.
 * `signal` aborts the HTTP stream; `onCliId` reports the CLI run's id so the
 * caller can kill the subprocess (CLI providers don't take an AbortSignal).
 * Returns the final answer plus any agentic narration, or null for no changes.
 */
async function generateReviewText(
  ai: AiSettings,
  mode: ReviewMode,
  event: AutomationEvent,
  signal: AbortSignal,
  onCliId: (id: string) => void,
): Promise<ReviewResult | null> {
  let diff: { text: string; truncated: boolean; files: DiffStatEntry[] };
  if (event.kind === "commit") {
    diff = await gitCommitDiff(event.repoPath, event.hash, DIFF_MAX_BYTES);
  } else if (event.kind === "pr-sync" && event.target.type === "remote") {
    // Remote pr-sync is detected via the provider-neutral head-OID poll, which
    // carries no local base/head branch and whose head may not be local (fork /
    // pushed elsewhere). Use the provider's authoritative PR diff; it has no
    // numstat, so derive the file summary from the diff text. (pr-open and local
    // pr-sync keep the local branch diff below, which already includes file counts.)
    // Origin-pinned (package B2 recorded gap): pr-sync automation tracks the
    // fork's own PRs (the poller is origin-scoped); upstream-lens is a follow-up.
    const text = await forgePrDiff(
      event.repoPath,
      event.target.number,
      "origin",
    );
    diff = { text, truncated: false, files: filesFromDiff(text) };
  } else if (event.target.type === "remote") {
    // Remote pr-open: prefer the local branch diff (it carries numstat), but the
    // head branch isn't guaranteed local — catch-up and ready-flip events cover
    // PRs opened elsewhere (teammate / web), which reach this machine via the
    // poller before any fetch lands the ref (observed live: `git diff` fails on
    // an unfetched head). Fall back to the provider's authoritative PR diff,
    // the same source the remote pr-sync arm above uses unconditionally.
    try {
      diff = await gitBranchDiff(
        event.repoPath,
        event.base,
        event.head,
        DIFF_MAX_BYTES,
      );
    } catch {
      const text = await forgePrDiff(
        event.repoPath,
        event.target.number,
        "origin",
      );
      diff = { text, truncated: false, files: filesFromDiff(text) };
    }
  } else {
    // Local PR targets: both branches are inherently local.
    diff = await gitBranchDiff(
      event.repoPath,
      event.base,
      event.head,
      DIFF_MAX_BYTES,
    );
  }
  if (!diff.text.trim()) return null;
  // Cancelled while the diff loaded — don't start the model.
  if (signal.aborted) return null;

  // Build on a prior review of this PR + mode (a no-op when none exists), so an
  // auto re-review acknowledges what was fixed and focuses on new/unresolved
  // issues — the same soft context the interactive path uses.
  const prior: PriorContext =
    event.kind === "commit"
      ? {}
      : await resolvePriorContext(
          event.repoPath,
          event.target.type,
          targetRef(event),
          mode,
          event.headSha,
        );
  if (signal.aborted) return null;

  // Resolve the forge provider once and thread it to BOTH review sinks: the
  // external-context harvest (to short-circuit the doomed `gh` spawn on
  // GitLab/Bitbucket) AND the prompt builder (so the system prompt uses MR
  // wording/markdown for GitLab/Bitbucket, not GitHub's). Needed even when
  // external context is ignored, because buildReviewPrompt always wants it.
  // Best-effort: a status-probe failure falls back to GitHub, the prior behavior.
  const provider: PromptProvider = await forgeStatus(event.repoPath)
    .then((s) => s.provider ?? "github")
    .catch((): PromptProvider => "github");
  if (signal.aborted) return null;

  // Third-party AI-reviewer findings (Copilot/CodeRabbit) AND GitDesktop's own
  // prior comments on the remote PR — so an automated re-review weighs both, the
  // same soft context the interactive path uses. Remote PRs only; best-effort;
  // resolved concurrently (independent harvests, kept separate from the external
  // path — a shared-fetch dedup is a later win, forge-dispatch-dedup backlog).
  // Scale the prompt's character budgets to the reviewing model (per the user's
  // Review-context knob) — best-effort, never throws, never blocks the review.
  // Resolved BEFORE the own/external harvest so the own-comments distillation
  // trigger + ledger cap key off the SAME scaled budget as the rest of the prompt;
  // reused verbatim at buildReviewPrompt below (single resolution, used twice).
  const appSettings = await loadSettings();
  const budgetProfile = await resolveBudgetProfile(
    ai,
    appSettings.reviewContextSize,
  );
  if (signal.aborted) return null;

  // The author's reviewer notes. Fresh pr-open events carry them straight from
  // the create dialog (no round-trip); catch-up / pr-sync rounds have no such
  // event, so fall back to lifting them from the marker comment the dialog posted
  // (remote PRs only — the runner's comment fetchers are remote-only). The
  // event-carried notes win when present.
  const eventNotes =
    event.kind === "pr-open" && event.reviewNotes?.trim()
      ? { reviewNotes: event.reviewNotes }
      : undefined;

  const isRemotePr = event.kind !== "commit" && event.target.type === "remote";
  // Repo-level review context: the documentation-surface roster and the repo's own
  // instructions file. Both read the local working tree — whatever branch is checked
  // out (see `repoInstructionsClause`, guardrail 3) — and both apply to a commit or
  // local-PR review as much as a remote one, so they sit OUTSIDE the remote-only
  // harvest below: started here and awaited after it, so they still resolve
  // concurrently with it. Neither promise can reject (the resolver swallows its own
  // failures; the read has a `catch`), so holding it across the await below can't
  // strand a rejection.
  const repoContext = Promise.all([
    resolveDocSurfacesContext(event.repoPath),
    readRepoInstructions(event.repoPath).catch(() => null),
  ]);
  // Resolve external + own + (when not event-carried) reviewer-notes context in
  // parallel — all three are independent, best-effort remote harvests.
  const [external, own, resolvedNotes]: [
    ExternalContext,
    OwnCommentsContext,
    { reviewNotes?: string },
  ] = isRemotePr
    ? await Promise.all([
        resolveExternalContext(
          event.repoPath,
          "remote",
          targetRef(event),
          event.headSha,
          false,
          provider,
          { budgetChars: budgetProfile.externalCharBudget },
        ),
        resolveOwnCommentsContext(
          event.repoPath,
          "remote",
          targetRef(event),
          provider,
          {
            distill: true,
            signal,
            ownBudgetChars: budgetProfile.ownCharBudget,
          },
        ),
        // Skip the fetch when the event already carries the notes.
        eventNotes
          ? Promise.resolve({})
          : resolveReviewerNotesContext(
              event.repoPath,
              (event.target as { type: "remote"; number: number }).number,
            ),
      ])
    : [{}, {}, {}];
  const [docs, repoInstructions] = await repoContext;
  if (signal.aborted) return null;

  // Event-carried notes take precedence over the lifted marker comment.
  const notes = eventNotes ?? resolvedNotes;

  const { system, prompt } = buildReviewPrompt(
    {
      title: event.title,
      body: event.kind === "commit" ? "" : event.body,
      commitSubjects: event.kind === "commit" ? [] : event.commitSubjects,
      diffText: diff.text,
      diffTruncated: diff.truncated,
      files: diff.files.map((f) => ({
        path: f.path,
        added: f.added,
        deleted: f.deleted,
        isBinary: f.isBinary,
      })),
      provider,
      budgetProfile,
      repoInstructions,
      // Both instruction sources, exactly as every sibling prompt takes them —
      // already loaded above, so this costs no extra read.
      globalInstructions: appSettings.globalInstructions,
      ...prior,
      ...own,
      ...external,
      ...notes,
      ...docs,
    },
    mode,
  );

  // CLI providers (claude-cli/codex-cli) run as a subprocess, not the AI SDK —
  // route them the same way the interactive review does.
  if (isCliProvider(ai.provider)) {
    let result = "";
    let thoughts = "";
    await runCliStream({
      ai,
      system,
      prompt,
      repoPath: event.repoPath,
      // Read the reviewed commit / PR-head's files in a worktree, not whatever
      // branch happens to be checked out.
      headSha: event.kind === "commit" ? event.hash : event.headSha,
      // The user's Review-timeout override (null = the backend's tier defaults).
      timeoutSecs: reviewTimeoutSecs(appSettings.reviewTimeout),
      timeoutConfigurable: true,
      // runCliStream replaces with the agent's final answer on done; the last
      // setText carries that clean review body (narration is peeled into onThoughts).
      setText: (t) => {
        result = t;
      },
      setStatus: () => undefined,
      registerId: onCliId,
      onThoughts: (t) => {
        thoughts = t;
      },
    });
    return { text: result, thoughts };
  }

  const client = await createAiClient(ai);
  let buffer = "";
  for await (const chunk of client.stream({
    system,
    prompt,
    abortSignal: signal,
    // CLI providers are routed at L461; carry repoPath here regardless so every
    // stream call is uniform (ignored by HTTP providers).
    repoPath: event.repoPath,
  })) {
    buffer += chunk;
  }
  // The plain HTTP text path has no tool narration.
  return { text: buffer, thoughts: "" };
}

async function deliver(
  event: AutomationEvent,
  mode: ReviewMode,
  body: string,
  rawText: string,
  notify: boolean,
): Promise<void> {
  const label = modeLabel(mode);

  if (event.kind === "commit") {
    // Commits have no comment surface — keep the result in-session and let
    // the toast open it.
    const result = {
      id: crypto.randomUUID(),
      repoPath: event.repoPath,
      subject: event.title,
      mode,
      text: rawText,
      createdAt: new Date().toISOString(),
    };
    useAutomationResults.getState().add(result);
    toast.success(`AI ${label} of ${event.hash.slice(0, 7)} ready`, {
      duration: 15_000,
      action: {
        label: "View",
        onClick: () => useAutomationResults.getState().setOpen(result.id),
      },
    });
    if (notify) {
      void notifyIfUnfocused(
        `AI ${label} ready`,
        `${event.hash.slice(0, 7)} — ${event.title}`,
      );
    }
    return;
  }

  if (event.target.type === "remote") {
    // Origin-pinned (package B2 recorded gap): automation posts to the fork's own
    // PRs (the poller is origin-scoped); upstream-lens is a follow-up.
    await forgePrComment(
      event.repoPath,
      event.target.number,
      body,
      true,
      "origin",
    );
    // Narrow to the PR's own key family (prefix-matches its detail/reactions/
    // timeline/review-threads) rather than the whole-repo subtree — a posted
    // conversation comment only touches this PR. Mirrors the local-target path
    // below, which invalidates just its own store. Scoped to the origin lens (the
    // PR the comment landed on).
    await queryClient.invalidateQueries({
      queryKey: ["repo", event.repoPath, "pr", "origin", event.target.number],
    });
    toast.success(`AI ${label} posted on #${event.target.number}`);
    if (notify) {
      void notifyIfUnfocused(
        `AI ${label} posted on #${event.target.number}`,
        event.title,
      );
    }
    return;
  }

  // Hoisted: the narrowing to the local target doesn't flow into closures.
  const targetId = event.target.id;
  const prs = await listLocalPrs(event.repoPath);
  const pr = prs.find((p) => p.id === targetId);
  if (!pr) {
    toast.error(`AI ${label} finished, but the local PR no longer exists.`);
    return;
  }
  await updateLocalPr(event.repoPath, targetId, (cur) => ({
    ...cur,
    comments: [
      ...cur.comments,
      {
        id: crypto.randomUUID(),
        body,
        createdAt: new Date().toISOString(),
        author: "GitDesktop",
      },
    ],
  }));
  await queryClient.invalidateQueries({
    queryKey: ["local-prs", event.repoPath],
  });
  toast.success(`AI ${label} added to "${pr.title}"`);
  if (notify) {
    void notifyIfUnfocused(`AI ${label} finished`, `Local PR "${pr.title}"`);
  }
}

/**
 * Persists an automated PR review into the keyed history store (same shape +
 * key the interactive path uses), so the next review of that PR + mode builds
 * on it. Keyed by `(kind, ref, mode)`; `text` is the raw findings, not the
 * comment-wrapped body. `thoughts` is the agentic narration (display-only, never
 * fed forward). Invalidates the panel's history query so an open Review tab
 * reflects it immediately.
 */
async function persistReviewHistory(
  event: PrAutomationEvent,
  mode: ReviewMode,
  text: string,
  model: string,
  thoughts: string,
  /** The run's wall-clock start — persisted so history shows a real duration. */
  startedAtMs: number,
): Promise<void> {
  if (!text.trim()) return;
  const kind = event.target.type;
  const ref = targetRef(event);
  const now = Date.now();
  await saveReview(event.repoPath, {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    kind,
    ref,
    mode,
    model,
    title: event.title,
    text,
    // Display-only narration (omitted when empty; never fed to the next run).
    ...(thoughts.trim() ? { thoughts } : {}),
    headSha: event.headSha ?? "",
    startedAt: startedAtMs,
    finishedAt: now,
  });
  await queryClient.invalidateQueries({
    queryKey: ["review-history", event.repoPath, kind, ref],
  });
}
