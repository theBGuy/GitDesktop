import { toast } from "sonner";
import { createAiClient } from "@/lib/ai/client";
import { buildAiCommentBody } from "@/lib/ai/comment-branding";
import { resolveBudgetProfile } from "@/lib/ai/context-budget";
import { resolveDocSurfacesContext } from "@/lib/ai/docs-context";
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
import { isCliProvider, isLocalProvider } from "@/lib/ai/providers";
import { reviewEffortLevel } from "@/lib/ai/review-effort";
import { reviewTimeoutSecs } from "@/lib/ai/review-timeout";
import { runCliStream } from "@/lib/ai/stream";
import { safeSlice } from "@/lib/ai/truncate";
import type { AiSettings, PromptProvider, ReviewMode } from "@/lib/ai/types";
import {
  forgePrComment,
  forgePrDiff,
  forgeStatus,
  gitBranchDiff,
  gitCommitDiff,
  readRepoInstructions,
} from "@/lib/git/api";
import { sectionFilePath } from "@/lib/git/diff-split";
import { repoIdentity } from "@/lib/git/repo-identity";
import type { DiffStatEntry } from "@/lib/git/types";
import { notifyIfUnfocused } from "@/lib/notify";
import { listLocalPrs, updateLocalPr } from "@/lib/pulls/local";
import {
  listReviews,
  type PersistedReview,
  reviewHistoryKey,
  reviewPartialKey,
  saveReview,
} from "@/lib/pulls/reviews-history";
import { queryClient } from "@/lib/query-client";
import { effectiveReviewAi, loadSettings } from "@/lib/settings/api";
import { pushNotification } from "@/lib/stores/notifications";
import {
  type ReviewTarget,
  registerAutomationRun,
  resetReview,
} from "@/lib/stores/reviews";
import { errorMessage, invoke } from "@/lib/tauri/invoke";
import { COLD_START_AUTOMATIONS_OFF } from "@/lib/test-mode";
import {
  clearDismissedHead,
  getDismissedHeadMap,
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

/** Heartbeat interval for a running automation's cross-instance claim file. Rust's
 *  `STALE_CLAIM_AGE` (automation_claims.rs) reclaims a claim after 30 minutes of silence,
 *  so 5 minutes leaves margin for a long review (the timeout setting allows 60) to keep
 *  its claim alive; without it a second instance would reclaim a LIVE run and post a
 *  duplicate paid review. Timers don't fire during OS suspend, so a 30+ minute sleep
 *  mid-run can still go stale on resume. */
const CLAIM_HEARTBEAT_MS = 5 * 60 * 1000;

/** Cap on heartbeats per run (30 × 5 min = 150 min), armed at the top of the try. It must
 *  cover the backend's 7200s max kill clamp (reachable by hand-editing settings.json; the
 *  UI tops out at 60 min) PLUS the pre-stream phase (diff load, context harvest, distill).
 *  A run still unsettled past that is wedged — an HTTP stream has no deadline, so a
 *  stalled fetch never settles and its `finally` never runs. Stopping the heartbeat lets
 *  the claim age out so a second instance can recover the head. */
const CLAIM_HEARTBEAT_MAX_BEATS = 30;

/** The store key for a PR target, used to look up its review-history records. */
function targetRef(event: PrAutomationEvent): string {
  return event.target.type === "remote"
    ? String(event.target.number)
    : event.target.id;
}

function modeLabel(mode: ReviewMode): "security audit" | "review" {
  return mode === "security" ? "security audit" : "review";
}

/** Longest whole body {@link looksLikeProviderError} will judge, and how much of it
 *  the thrown message quotes back. */
const ERROR_SHAPE_MAX_CHARS = 300;
const ERROR_SHAPE_CLIP_CHARS = 200;

/**
 * Last-resort net for a CLI/provider that reports a failure as a successful review —
 * this is the unattended path, so an error body that slips through gets posted to a
 * real PR. Scoped to a SHORT, single-paragraph WHOLE body, so a genuine review that
 * merely quotes an error can't trip it. Twins that must stay aligned: agent.rs's
 * `claude_result_is_error`/`has_blank_line` (parser side) and `terminalErrorMessage`
 * in `src/lib/ai/terminal-error.ts` (the inverse accept-gate).
 */
function looksLikeProviderError(text: string): boolean {
  const body = text.trim();
  if (body.length > ERROR_SHAPE_MAX_CHARS) return false;
  if (/\n[ \t\r]*\n/.test(body)) return false;
  return (
    body.startsWith("API Error") ||
    body.startsWith("Claude AI usage limit reached") ||
    (body.includes("limit reached") && body.includes("resets"))
  );
}

/**
 * The {@link ReviewTarget} for an automation run's ActivityDock row. DISPLAY-ONLY:
 * automation rows are removed on settle and never persisted to a "View"-able state, so
 * commit events (no PR) get a degenerate remote placeholder. `repoName` falls back to the
 * repo directory's basename — the automation event carries no repo name.
 */
function automationTarget(event: AutomationEvent): ReviewTarget {
  const repoName = event.repoPath.split(/[/\\]/).pop() ?? event.repoPath;
  // Origin-pinned like every other store touch on this path — the poller is
  // origin-scoped, so an automation row always belongs to the fork's own PR.
  if (event.kind === "commit") {
    return {
      kind: "remote",
      repoPath: event.repoPath,
      repoName,
      lens: "origin",
      ref: "",
    };
  }
  return {
    kind: event.target.type,
    repoPath: event.repoPath,
    repoName,
    lens: "origin",
    ref: targetRef(event),
  };
}

/** Derives a per-file +/- summary from unified diff text — for `gh pr diff`,
 *  which (unlike `git diff --numstat`) returns no file counts. */
function filesFromDiff(text: string): DiffStatEntry[] {
  return text
    .split(/^(?=diff --git )/m)
    .filter((s) => s.trim())
    .flatMap((section) => {
      // Same decoder `splitUnifiedDiff` keys with — a different rule here lets an
      // AI-ignored file's name and counts survive `filterDiffByAiIgnore` (a
      // C-quoted path has no bare ` b/`). Unkeyable sections are dropped, as
      // `splitUnifiedDiff` drops them, so the key sets stay identical.
      const path = sectionFilePath(section);
      if (!path) return [];
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

/** What a {@link run} pass did, so a re-run can tell outcomes apart:
 *  - `matched`: rules that exist AND apply (past the `only` + branch gates). 0 = the rule
 *    no longer applies, or automations are paused (Hide AI, or cold start without opt-in).
 *  - `attempted`: runs actually started. `matched > 0 && attempted === 0` means a claim or
 *    an already-covered head blocked it — retryable. */
interface RunOutcome {
  matched: number;
  attempted: number;
}

/**
 * Runs the automation rules matching `event`, unless AI features are hidden or this is
 * a cold-start instance without the automations opt-in — either pauses automations, so
 * it returns immediately with a zero outcome. `only` scopes a re-run to a single mode.
 * `replacesKey` is the stopped row a re-run replaces — removed the instant its
 * replacement registers, so the stopped row survives whenever nothing registers.
 * Returns a {@link RunOutcome} so a re-run can tell "rule gone" from "blocked" from
 * "started".
 */
async function run(
  event: AutomationEvent,
  only?: ReviewMode,
  replacesKey?: string,
): Promise<RunOutcome> {
  // Cold-start instances share the automation-claims dir with the real instance, so an
  // armed cold instance can win a claim meant for the real run and suppress it. First
  // gate of all, so a gated tick reads no store at all and takes no claim.
  if (COLD_START_AUTOMATIONS_OFF) return { matched: 0, attempted: 0 };
  // Hiding AI features PAUSES automations: no NEW run starts while `hideAi` is set
  // (an in-flight run still completes and delivers — deliberate). Rules are kept and
  // resume when AI is shown again.
  const settings = await loadSettings();
  if (settings.hideAi) return { matched: 0, attempted: 0 };
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

  const notify = settings.notifications.automations;
  // The gate stores, read once and shared by an event's per-action gate checks: `fresh`
  // reloads from disk and queues behind any writer, and pr-reviews.json carries every
  // review's full markdown, so sharing is what keeps a two-mode event from paying twice.
  // Taken LAZILY — an event whose actions are all filtered out reads nothing, and commit
  // events never reach the gates below.
  let gateSnapshot: {
    reviews: PersistedReview[];
    dismissed: Partial<Record<ReviewMode, string>>;
  } | null = null;
  // Memoizes the resolved object rather than the promise — the action loop is sequential,
  // so two calls can never be in flight across these awaits.
  const gateState = async (prEvent: PrAutomationEvent) => {
    if (!gateSnapshot) {
      // Separate stores with independent queues, so neither read waits on the other.
      // Origin-pinned like every other store touch on this path — the poller is
      // origin-scoped, so these gates only ever cover the fork's own PRs.
      const [reviews, dismissed] = await Promise.all([
        listReviews(
          prEvent.repoPath,
          "origin",
          prEvent.target.type,
          targetRef(prEvent),
          { fresh: true },
        ),
        getDismissedHeadMap(
          prEvent.repoPath,
          "origin",
          prEvent.target.type,
          targetRef(prEvent),
          { fresh: true },
        ),
      ]);
      gateSnapshot = { reviews, dismissed };
    }
    return gateSnapshot;
  };
  for (const { action, conditions } of actions) {
    if (only && action !== only) continue;
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
    matched++;
    // pr-sync is opt-in per PR: re-review only a PR already reviewed in this mode, and
    // never for ANY head that mode covered — a poll can re-serve an older head after a
    // push, which isn't new work. Every retained record counts, so the flap window is
    // the history store's MAX_PER_GROUP per (kind, ref, mode).
    if (event.kind === "pr-sync") {
      const headSha = event.headSha ?? "";
      const { reviews, dismissed } = await gateState(event);
      const covered = reviews.filter((r) => r.mode === action);
      // A CANCELLED re-review persists the dismissed head, so a cancelled head doesn't
      // re-fire after an app relaunch — only a genuinely newer head does.
      const dismissedHead = dismissed[action];
      // sameSha (not `===`) so a short-vs-full sha for the SAME head (Bitbucket's
      // 12-char poll head vs a full-40 seed) counts as "already reviewed" and
      // doesn't re-fire a redundant review each poll tick.
      if (
        covered.length === 0 ||
        covered.some((r) => sameSha(r.headSha, headSha)) ||
        sameSha(dismissedHead ?? "", headSha)
      ) {
        continue;
      }
    }
    // pr-open is FIRST-review per mode: skip a mode that already has a review record for
    // this PR (so real and catch-up-synthesized events are idempotent per mode), and skip
    // a head this mode already dismissed. Mirror of the pr-sync gate, inverted — pr-sync
    // requires a prior review, pr-open requires its absence.
    if (event.kind === "pr-open") {
      const { reviews, dismissed } = await gateState(event);
      // The list is newest-first, so this mode's first entry IS its latest review — the
      // same record `getLatestReview` would return.
      const prior = reviews.find((r) => r.mode === action);
      if (prior) continue;
      const dismissedHead = dismissed[action];
      if (event.headSha && sameSha(dismissedHead ?? "", event.headSha)) {
        continue;
      }
    }
    // Cross-instance dedup: claim this run atomically BEFORE any (paid) AI work, so two
    // instances watching the same repo (a main checkout + a linked worktree share a
    // worktree-stable identity) don't both post the same review. Key = (repo identity,
    // target, head, action); commit events key on their hash and skip when there's no
    // head. Fail-open — a claim-infrastructure error must never disable automations.
    // `won === false` = another instance owns this run.
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
    // Liveness heartbeat for the claim just won: refreshing the claim file's mtime makes
    // the Rust stale-reclaim window measure "this instance went quiet", not "this review
    // is slow" (a 45/60-minute review would otherwise outlive the 30-minute window).
    // Best-effort. ARMED as the try's first statement below: an interval leaked by a throw
    // outside the `finally` would refresh the claim forever, defeating both the 30-minute
    // reclaim and the 30-day sweep for the life of the process.
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
    // The AI config this mode runs under (security audits may use `securityReviewAi`).
    // Resolved once so the lane pick, the generation, the delivered comment's model label,
    // and the persisted history model all agree.
    const reviewCfg = effectiveReviewAi(settings, action);
    // Past every skip gate — counted so a Re-run that matches nothing can toast instead of
    // dying silently.
    attempted++;
    // Per-rule cancellation: HTTP providers stop via the AbortSignal, CLI providers by
    // killing the subprocess (`cancelAgentReview` once its id is known); both are driven
    // by the dock row's Cancel → `cancelReview`. `handle.isCancelled()` stays readable
    // after a cancel, so the guards below skip delivery + the failure toast.
    const controller = new AbortController();
    // Wall-clock start, mirrored into the persisted history record so an automated review
    // carries a real duration.
    const runStartedMs = Date.now();
    // Per-action, so a second mode's run never inherits the first's text or verdict.
    const progress: RunProgress = { text: "", timedOut: false };
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
    // The replacement has registered — now remove the stopped row it replaces. Done here
    // (not at the Re-run click) so a non-registering outcome keeps the row as a retry
    // target; cleared so a second registering action in this pass can't re-trigger it.
    if (staleKey) {
      resetReview(staleKey);
      staleKey = undefined;
    }
    // On cancel, persist the dismissed PR head so a cancelled re-review doesn't re-fire
    // after relaunch (cancel marks no head covered). PR events with a headSha only;
    // best-effort. Not written on non-cancel failures, which stay retryable.
    const dismissOnCancel = () => {
      if (event.kind === "commit" || !event.headSha) return;
      void setDismissedHead(
        event.repoPath,
        "origin",
        event.target.type,
        targetRef(event),
        action,
        event.headSha,
      ).catch(() => undefined);
    };
    try {
      // Armed as the try's FIRST statement so a throw can't separate arm from disarm.
      if (claimKey) {
        let beats = 0;
        heartbeat = setInterval(() => {
          // Bounded (CLAIM_HEARTBEAT_MAX_BEATS) so a wedged run can't refresh forever.
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
        progress,
      );
      if (handle.isCancelled()) {
        // The dock's Cancel already patched the row to "cancelled" (keeping its Re-run)
        // and deleted the control — do NOT settle/remove it here.
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
      // Both gates throw BEFORE deliver and persistReviewHistory, so a bad run
      // neither posts a comment nor marks this head covered for pr-sync — it lands
      // in the catch below (failure toast + inbox row with Re-run + released claim).
      if (!text.trim()) {
        throw new Error(
          `The AI ${label} run produced no text — nothing was posted.`,
        );
      }
      if (looksLikeProviderError(text)) {
        const body = text.trim();
        // Ellipsis only when the quote was actually cut, so a short error reads as the
        // complete message it is.
        const quoted =
          body.length > ERROR_SHAPE_CLIP_CHARS
            ? `${safeSlice(body, ERROR_SHAPE_CLIP_CHARS)}…`
            : body;
        throw new Error(
          `The AI ${label} run returned an error message instead of a review: "${quoted}" — nothing was posted.`,
        );
      }
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
      // Seed the review-history store so the next run (manual or auto) builds on these
      // findings and this headSha joins the heads pr-sync treats as covered. Best-effort.
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
      // A run the backend killed at its deadline keeps whatever it wrote first: nothing
      // else holds that text (the dock row is memory-only, no comment was delivered), so
      // this record is its only copy. ONLY the timeout arm — the `looksLikeProviderError`
      // throw's accumulated text is the provider's error message, not review output.
      // Coverage stays safe for free: a PARTIAL is dropped by `listReviews`, so the
      // pr-sync gate still sees this head as un-reviewed and re-reviews it.
      let keptPartial = false;
      if (
        progress.timedOut &&
        progress.text.trim() !== "" &&
        (event.kind === "pr-open" || event.kind === "pr-sync")
      ) {
        // Resolved from the write itself, so the notification below only promises kept
        // output when a record actually landed.
        keptPartial = await persistPartialReviewHistory(
          event,
          action,
          progress.text,
          reviewCfg.model,
          message,
          runStartedMs,
        )
          .then(() => true)
          .catch(() => false);
      }
      toast.error(`AI ${label} failed: ${message}`);
      // Inbox parity with manual runs (reviews.ts's notifyReviewDone): a genuine failure
      // records an inbox row too, gated on the same automations pref.
      if (notify) {
        // Carry the failure reason into the durable subtitle so the inbox row
        // (and the OS ping) say WHY — subject-only when the reason is empty.
        const subject =
          event.kind === "commit"
            ? `"${event.hash.slice(0, 7)}"`
            : `"${event.title}"`;
        const reason = message.trim() ? `${subject} — ${message}` : subject;
        // The inbox row is where a kept partial gets discovered — a durable failure that
        // doesn't mention it reads as a run with nothing to show for it.
        const subtitle = keptPartial
          ? `${reason}${reason.endsWith(".") ? "" : "."} Partial output is kept under Previous reviews.`
          : reason;
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
                  // Automations run against the fork's own PRs: the poll that
                  // feeds them pins the origin slug deliberately, so the
                  // click-through lands there too.
                  lens: "origin",
                },
              }),
          // This run's stopped dock row; passing a dismissed key is safe (resetReview
          // no-ops on a gone key).
          action: {
            label: "Re-run",
            run: () => rerunAutomation(event, mode, selfKey),
          },
          dedupeKey: `automation-failed:${event.repoPath}:${event.kind}:${
            event.kind === "commit" ? event.hash : targetRef(event)
          }:${action}`,
        });
        // Re-read rather than trust the run-start snapshot: hiding AI mid-run
        // mutes the OS ping, while the inbox row above still records the failure
        // (the dock filters that at render time, so no history is lost).
        if (!(await loadSettings().catch(() => null))?.hideAi) {
          void notifyIfUnfocused(`AI ${label} failed`, subtitle);
        }
      }
      // Persist a "Failed" stopped row (keeping its Re-run) instead of removing it.
      handle.fail(message);
    } finally {
      // Every terminal path lands here — including both `continue`s and the delivered
      // success path, which keeps its claim but must stop heartbeating it.
      stopHeartbeat();
      // This try is entered only past every gate, so reaching it means the action RAN:
      // drop the shared snapshot so the next action re-reads what happened meanwhile
      // (a delivery, or a cancel in another window flushing a dismissal).
      gateSnapshot = null;
    }
  }
  return { matched, attempted };
}

/**
 * Re-fires a stopped (cancelled/failed) automation run for exactly one mode — a stopped
 * row's Re-run. Fire-and-forget, like {@link triggerAutomations}.
 *
 * For PR events it first clears the dismissed-head watermark for this (target, mode): a
 * cancelled run wrote one, and the pr-sync `sameSha(dismissedHead, headSha)` gate would
 * otherwise make the re-run a silent no-op. The run then flows through the normal pipeline
 * scoped to `only`. If the rule was disabled since, nothing matches and we toast rather
 * than leave a dead button. While AI features are hidden — or in a cold-start instance
 * that never opted automations in — it stops before the clear: a paused re-run must not
 * consume the watermark.
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
      // The dismissal clear below mutates BEFORE run()'s own pause gate, so a paused
      // re-run has to stop here — clearing nothing and running nothing.
      if ((await loadSettings()).hideAi) {
        toast.info("Automations are paused while AI features are hidden.");
        return;
      }
      // Same reason: the clear below runs before run()'s cold-start gate, so an
      // automations-off cold instance stops here rather than consuming the watermark.
      if (COLD_START_AUTOMATIONS_OFF) {
        toast.info("Automations are off in cold-start test mode.");
        return;
      }
      // Best-effort ONLY here: a cleared-dismissal failure must not block the
      // re-run (it just means the pr-sync gate might skip; we then toast retryable).
      if (event.kind !== "commit") {
        await clearDismissedHead(
          event.repoPath,
          "origin",
          event.target.type,
          targetRef(event),
          only,
        ).catch(() => undefined);
      }
      // The stopped row is removed inside run() only when a replacement registers —
      // so every non-registering outcome below keeps it as a retry target.
      const { matched, attempted } = await run(event, only, staleKey);
      if (matched === 0) {
        // The rule genuinely no longer applies (disabled / conditions changed).
        toast.info(`Automated ${label} for this ${noun} is turned off.`);
      } else if (attempted === 0) {
        // A rule applies but a held claim or an already-covered head blocked it. The
        // stopped row is kept — retry once that clears.
        toast.info(
          `Couldn't re-run the ${label} — another run already covers this head (still finishing or ran elsewhere). The row is kept; try again in a moment.`,
        );
      }
      // attempted > 0: the fresh Running row is the feedback — no toast.
    } catch (e) {
      // A throw before/inside the loop (loadAutomations, store I/O) must not be swallowed —
      // surface it; the stopped row stays.
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

/** Live progress of one review run, owned by the CALLER so a run that throws can still
 *  read what streamed before it died — {@link generateReviewText}'s return value is
 *  reachable only on the success path. CLI providers only: the HTTP branch has no
 *  backend deadline, so it never reports a timeout and its buffer is never kept. */
interface RunProgress {
  /** The newest text the stream reported (already the agent's own output — a killed
   *  whole-message CLI's answer is adopted upstream in `runCliStream`). */
  text: string;
  /** The backend killed the run at its deadline, rather than the run failing outright. */
  timedOut: boolean;
}

/** The whole unified diff a review event covers, from whichever source can serve
 *  it — every branch here lands unfiltered text that the caller then filters. */
async function resolveDiff(
  event: AutomationEvent,
): Promise<{ text: string; truncated: boolean; files: DiffStatEntry[] }> {
  if (event.kind === "commit") {
    return gitCommitDiff(event.repoPath, event.hash, DIFF_MAX_BYTES);
  }
  if (event.kind === "pr-sync" && event.target.type === "remote") {
    // Remote pr-sync comes from the provider-neutral head-OID poll: no local base/head
    // branch, and the head may not be local (fork / pushed elsewhere). Use the provider's
    // PR diff; it has no numstat, so derive the file summary from the diff text.
    // Origin-pinned — the poller is origin-scoped, so this tracks the fork's own PRs.
    const text = await forgePrDiff(
      event.repoPath,
      event.target.number,
      "origin",
    );
    return { text, truncated: false, files: filesFromDiff(text) };
  }
  if (event.target.type === "remote") {
    // Remote pr-open: prefer the local branch diff (it carries numstat), but the head
    // branch isn't guaranteed local — catch-up / ready-flip events cover PRs opened
    // elsewhere that reach this machine before any fetch lands the ref (observed live:
    // `git diff` fails on an unfetched head). Fall back to the provider's PR diff.
    try {
      return await gitBranchDiff(
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
      return { text, truncated: false, files: filesFromDiff(text) };
    }
  }
  // Local PR targets: both branches are inherently local.
  return gitBranchDiff(event.repoPath, event.base, event.head, DIFF_MAX_BYTES);
}

/**
 * Resolves the diff, builds the prompt, and runs the model to completion.
 * `signal` aborts the HTTP stream; `onCliId` reports the CLI run's id so the
 * caller can kill the subprocess (CLI providers don't take an AbortSignal).
 * Returns the final answer plus any agentic narration, or null for no changes.
 * `progress` is filled as the run streams, so the caller's catch can keep a
 * timed-out run's output (see {@link RunProgress}).
 */
async function generateReviewText(
  ai: AiSettings,
  mode: ReviewMode,
  event: AutomationEvent,
  signal: AbortSignal,
  onCliId: (id: string) => void,
  progress: RunProgress,
): Promise<ReviewResult | null> {
  // Independent of each other, and the settings are only needed by the filter
  // below (the budget profile reuses the same read) — so they resolve alongside
  // the diff rather than in front of it.
  const [diff, appSettings] = await Promise.all([
    resolveDiff(event),
    loadSettings(),
  ]);
  if (!diff.text.trim()) return null;
  // Cancelled while the diff loaded — don't start the model.
  if (signal.aborted) return null;
  // An automated review is agentic only when the toggle is on AND the provider is
  // a CLI one: `runCliStream` honors `cliRepoAware` with a detached worktree, but
  // an automated HTTP review gets no MCP tools and no tool loop, so it can only
  // ever see the diff we hand it.
  const agenticRun = Boolean(ai.cliRepoAware) && isCliProvider(ai.provider);
  const excludePatterns = agenticRun
    ? []
    : await aiExcludePatterns(event.repoPath, appSettings.aiIgnorePatterns);
  if (signal.aborted) return null;

  // One filter for every resolution path in `resolveDiff`: each lands a whole
  // unified diff here, and only `gitBranchDiff` could have excluded server-side.
  const filtered = await filterDiffByAiIgnore({
    repoPath: event.repoPath,
    text: diff.text,
    files: diff.files,
    exclude: excludePatterns,
  });
  // Everything the change touched is AI-ignored ⇒ the empty-diff outcome (the
  // caller reports "skipped — no changes to review").
  if (!filtered.text.trim()) return null;
  if (signal.aborted) return null;

  // Build on a prior review of this PR + mode (no-op when none) so a re-review focuses on
  // new/unresolved issues — the same soft context the interactive path uses.
  const prior: PriorContext =
    event.kind === "commit"
      ? {}
      : await resolvePriorContext(
          event.repoPath,
          "origin",
          event.target.type,
          targetRef(event),
          mode,
          event.headSha,
          excludePatterns,
        );
  if (signal.aborted) return null;

  // One forge-provider resolution threaded to BOTH sinks: the external-context harvest
  // (short-circuits the doomed `gh` spawn on GitLab/Bitbucket) and buildReviewPrompt (MR
  // wording for GitLab/Bitbucket). Best-effort — a probe failure falls back to GitHub.
  const provider: PromptProvider = await forgeStatus(event.repoPath)
    .then((s) => s.provider ?? "github")
    .catch((): PromptProvider => "github");
  if (signal.aborted) return null;

  // Scale the prompt's character budgets to the reviewing model (the user's Review-context
  // knob). Resolved BEFORE the own/external harvest so the own-comments distill trigger +
  // ledger cap key off the SAME budget as the rest of the prompt; reused verbatim at
  // buildReviewPrompt below. Best-effort, never blocks the review. (external + own stay
  // separate harvests — a shared-fetch dedup is the forge-dispatch-dedup backlog item.)
  const budgetProfile = await resolveBudgetProfile(
    ai,
    appSettings.reviewContextSize,
  );
  if (signal.aborted) return null;

  // The author's reviewer notes: fresh pr-open events carry them from the create dialog;
  // catch-up / pr-sync rounds lift them from the marker comment instead (remote PRs only —
  // the runner's comment fetchers are remote-only). Event-carried notes win.
  const eventNotes =
    event.kind === "pr-open" && event.reviewNotes?.trim()
      ? { reviewNotes: event.reviewNotes }
      : undefined;

  const isRemotePr = event.kind !== "commit" && event.target.type === "remote";
  // Repo-level review context: the doc-surface roster + the repo's instructions
  // file. Both read the LOCAL working tree — whatever branch is checked out (see
  // `repoInstructionsClause`, guardrail 3) — and apply to commit and local-PR
  // reviews too, so they start outside the remote-only harvest below and are
  // awaited after it, resolving concurrently with it. Neither can reject (the
  // resolver swallows failures, the read has a `catch`), so holding it across
  // that await strands nothing.
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
          "origin",
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

  const notes = eventNotes ?? resolvedNotes;

  const { system, prompt } = buildReviewPrompt(
    {
      title: event.title,
      body: event.kind === "commit" ? "" : event.body,
      commitSubjects: event.kind === "commit" ? [] : event.commitSubjects,
      diffText: filtered.text,
      diffTruncated: diff.truncated,
      files: filtered.files.map((f) => ({
        path: f.path,
        added: f.added,
        deleted: f.deleted,
        isBinary: f.isBinary,
      })),
      excludedFiles: filtered.excludedFiles,
      provider,
      budgetProfile,
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

  // CLI providers (claude-cli/codex-cli) run as a subprocess, not the AI SDK —
  // route them the same way the interactive review does.
  if (isCliProvider(ai.provider)) {
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
      // The user's Review-effort override ("" = the CLI's own default; always ""
      // for Codex, which the setting doesn't drive).
      effort: reviewEffortLevel(ai.provider, appSettings.reviewEffort),
      // Sunk into the caller-owned `progress` rather than a local: a timed-out run
      // rejects, so a local would be unreachable exactly when the text matters most.
      // runCliStream replaces with the agent's final answer on done; the last
      // setText carries that clean review body (narration is peeled into onThoughts).
      setText: (t) => {
        progress.text = t;
      },
      setStatus: () => undefined,
      registerId: onCliId,
      onThoughts: (t) => {
        thoughts = t;
      },
      onTimedOut: () => {
        progress.timedOut = true;
      },
    });
    return { text: progress.text, thoughts };
  }

  const client = await createAiClient(ai);
  let buffer = "";
  for await (const chunk of client.stream({
    system,
    prompt,
    abortSignal: signal,
    // CLI providers are routed above (the `isCliProvider` branch); carry repoPath
    // here regardless so every stream call is uniform (ignored by HTTP providers).
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
  // Whether this delivery may ping the OS. Read fresh, not from the run-start
  // snapshot: hiding AI while a run is in flight mutes its ping, and the in-app
  // toast + inbox row below still land (the dock filters those at render time).
  // A settings-read failure counts as shown — delivery must never fail on it.
  const osPing = notify && !(await loadSettings().catch(() => null))?.hideAi;

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
    if (osPing) {
      void notifyIfUnfocused(
        `AI ${label} ready`,
        `${event.hash.slice(0, 7)} — ${event.title}`,
      );
    }
    return;
  }

  if (event.target.type === "remote") {
    // Origin-pinned: the poller is origin-scoped, so automation posts to the fork's own
    // PRs; an upstream lens is a follow-up.
    await forgePrComment(
      event.repoPath,
      event.target.number,
      body,
      true,
      "origin",
    );
    // Narrow to this PR's own key family (detail/reactions/timeline/review-threads) rather
    // than the whole-repo subtree — a posted conversation comment touches only this PR.
    // Scoped to the origin lens.
    await queryClient.invalidateQueries({
      queryKey: ["repo", event.repoPath, "pr", "origin", event.target.number],
    });
    toast.success(`AI ${label} posted on #${event.target.number}`);
    if (osPing) {
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
  if (osPing) {
    void notifyIfUnfocused(`AI ${label} finished`, `Local PR "${pr.title}"`);
  }
}

/**
 * Persists an automated PR review into the keyed history store (same shape + key the
 * interactive path uses), so the next review of that PR + mode builds on it. Keyed by
 * `(lens, kind, ref, mode)`; `text` is the raw findings, not the comment-wrapped
 * body. `thoughts` is display-only narration, never fed forward.
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
    // Origin-pinned like the rest of this path — the poller is origin-scoped.
    lens: "origin",
    mode,
    model,
    title: event.title,
    text,
    ...(thoughts.trim() ? { thoughts } : {}),
    headSha: event.headSha ?? "",
    startedAt: startedAtMs,
    finishedAt: now,
  });
  await queryClient.invalidateQueries({
    queryKey: reviewHistoryKey(event.repoPath, "origin", kind, ref),
  });
}

/**
 * Persists the output a TIMED-OUT automated review left behind, as a partial record
 * (`phase: "error"`) — the failure-path sibling of {@link persistReviewHistory}. Callers
 * must gate on the timeout arm: any other failure's accumulated text may be a provider
 * error message rather than review output, so `timedOut` is true by construction here.
 * A partial is invisible to every "previous review" read, so it neither feeds the next
 * run's context nor marks this head covered for the pr-sync gate. Both query keys are
 * invalidated — the partial key is the one the panel's restored output reads.
 */
async function persistPartialReviewHistory(
  event: PrAutomationEvent,
  mode: ReviewMode,
  text: string,
  model: string,
  /** The failure reason shown with the kept output. */
  error: string,
  startedAtMs: number,
): Promise<void> {
  if (!text.trim()) return;
  const kind = event.target.type;
  const ref = targetRef(event);
  await saveReview(event.repoPath, {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    kind,
    ref,
    // Origin-pinned like the rest of this path — the poller is origin-scoped.
    lens: "origin",
    mode,
    model,
    title: event.title,
    text,
    phase: "error",
    error,
    timedOut: true,
    headSha: event.headSha ?? "",
    startedAt: startedAtMs,
    finishedAt: Date.now(),
  });
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: reviewHistoryKey(event.repoPath, "origin", kind, ref),
    }),
    queryClient.invalidateQueries({
      queryKey: reviewPartialKey(event.repoPath, "origin", kind, ref),
    }),
  ]);
}
