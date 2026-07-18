import { toast } from "sonner";
import { createAiClient } from "@/lib/ai/client";
import { buildAiCommentBody } from "@/lib/ai/comment-branding";
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
import { isCliProvider, isLocalProvider } from "@/lib/ai/providers";
import { runCliStream } from "@/lib/ai/stream";
import type { AiSettings, PromptProvider, ReviewMode } from "@/lib/ai/types";
import {
  forgePrComment,
  forgePrDiff,
  forgeStatus,
  gitBranchDiff,
  gitCommitDiff,
} from "@/lib/git/api";
import { repoIdentity } from "@/lib/git/repo-identity";
import type { DiffStatEntry } from "@/lib/git/types";
import { notifyIfUnfocused } from "@/lib/notify";
import { listLocalPrs, updateLocalPr } from "@/lib/pulls/local";
import { getLatestReview, saveReview } from "@/lib/pulls/reviews-history";
import { queryClient } from "@/lib/query-client";
import { loadSettings } from "@/lib/settings/api";
import { type ReviewTarget, registerAutomationRun } from "@/lib/stores/reviews";
import { invoke } from "@/lib/tauri/invoke";
import { getDismissedHead, setDismissedHead } from "./dismissals";
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

async function run(event: AutomationEvent): Promise<void> {
  const config = await loadAutomations();
  const repo = await repoAutomationsFor(config, event.repoPath);
  const actions = effectiveActions(config, repo, event.kind);
  if (actions.length === 0) return;

  // The branch(es) a branch-condition is tested against. Commit events carry the
  // committed branch; PR events carry head/base (added by the poll payload).
  const branch = event.kind === "commit" ? event.branch : undefined;
  const head = event.kind === "commit" ? undefined : event.head;
  const base = event.kind === "commit" ? undefined : event.base;

  const settings = await loadSettings();
  const notify = settings.notifications.automations;
  for (const { action, conditions } of actions) {
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
    // Per-rule cancellation: HTTP providers stop via the AbortSignal; CLI
    // providers stop by killing the subprocess (`cancelAgentReview` once we know
    // its id). Both are driven by the shared reviews store: the run registers a
    // "Running…" row in the header ActivityDock, and the dock's Cancel calls
    // `cancelReview`, which aborts THIS controller and kills the CLI subprocess —
    // no floating persistent toast. `handle.isCancelled()` stays readable after a
    // dock Cancel, so the guards below skip delivery + the failure toast.
    const controller = new AbortController();
    const handle = registerAutomationRun({
      // TaskRow already prefixes the mode name, so pass the bare subject.
      title: event.kind === "commit" ? event.hash.slice(0, 7) : event.title,
      mode: action,
      // Same provider-kind signal the manual panel path uses to pick its lane.
      local: isLocalProvider(settings.reviewAi.provider),
      target: automationTarget(event),
      abort: controller,
    });
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
      const result = await generateReviewText(
        settings.reviewAi,
        action,
        event,
        controller.signal,
        handle.setCliId,
      );
      if (handle.isCancelled()) {
        releaseClaim();
        dismissOnCancel();
        toast.info(`AI ${label} cancelled.`, { duration: 4000 });
        continue;
      }
      if (result === null) {
        releaseClaim();
        toast.info(`AI ${label} skipped — no changes to review.`);
        continue;
      }
      const { text, thoughts } = result;
      // The delivered comment body carries the final review text ONLY — the
      // agentic narration is persisted to history for later inspection, never
      // posted (buildAiCommentBody + deliver both take `text`).
      const body = buildAiCommentBody({
        kind: label,
        model: settings.reviewAi.model,
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
          settings.reviewAi.model,
          thoughts,
        ).catch(() => undefined);
      }
    } catch (e) {
      // Release the claim on every failure/cancel path so a transient error doesn't
      // permanently suppress this automation for this head across instances.
      releaseClaim();
      if (handle.isCancelled()) {
        dismissOnCancel();
        toast.info(`AI ${label} cancelled.`, { duration: 4000 });
        continue;
      }
      toast.error(`AI ${label} failed: ${e instanceof Error ? e.message : e}`);
      if (notify) {
        void notifyIfUnfocused(`AI ${label} failed`, `"${event.title}"`);
      }
    } finally {
      // Every terminal path (success, skip, error, cancelled, thrown) removes the
      // dock row — automation runs never linger in a finished state.
      handle.settle();
    }
  }
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
  } else {
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

  const isRemotePr = event.kind !== "commit" && event.target.type === "remote";
  const [external, own]: [ExternalContext, OwnCommentsContext] = isRemotePr
    ? await Promise.all([
        resolveExternalContext(
          event.repoPath,
          "remote",
          targetRef(event),
          event.headSha,
          false,
          provider,
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
      ])
    : [{}, {}];
  if (signal.aborted) return null;

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
      ...prior,
      ...own,
      ...external,
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
    startedAt: now,
    finishedAt: now,
  });
  await queryClient.invalidateQueries({
    queryKey: ["review-history", event.repoPath, kind, ref],
  });
}
