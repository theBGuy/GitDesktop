import { toast } from "sonner";
import { cancelAgentReview } from "@/lib/ai/agent";
import { createAiClient } from "@/lib/ai/client";
import {
  type ExternalContext,
  resolveExternalContext,
} from "@/lib/ai/external-context";
import { type PriorContext, resolvePriorContext } from "@/lib/ai/prior-context";
import { buildReviewPrompt } from "@/lib/ai/prompt";
import { isCliProvider } from "@/lib/ai/providers";
import { runCliStream } from "@/lib/ai/stream";
import type { AiSettings, PromptProvider, ReviewMode } from "@/lib/ai/types";
import {
  forgePrComment,
  forgePrDiff,
  forgeStatus,
  gitBranchDiff,
  gitCommitDiff,
} from "@/lib/git/api";
import type { DiffStatEntry } from "@/lib/git/types";
import { notifyIfUnfocused } from "@/lib/notify";
import { listLocalPrs, updateLocalPr } from "@/lib/pulls/local";
import { getLatestReview, saveReview } from "@/lib/pulls/reviews-history";
import { queryClient } from "@/lib/query-client";
import { loadSettings } from "@/lib/settings/api";
import { useAutomationResults } from "./results";
import { loadAutomations } from "./store";
import { sameSha } from "./sync";
import { effectiveRules } from "./types";

export type AutomationEvent =
  | {
      kind: "commit";
      repoPath: string;
      hash: string;
      title: string;
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

function modeLabel(mode: ReviewMode): string {
  return mode === "security" ? "security audit" : "review";
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
  const rules = effectiveRules(config, event.repoPath, event.kind);
  if (rules.length === 0) return;

  const settings = await loadSettings();
  const notify = settings.notifications.automations;
  for (const rule of rules) {
    // pr-sync is opt-in per PR: re-review only a PR already reviewed in this
    // mode, and only once its head has advanced past the last-reviewed commit
    // (the persisted review's headSha is the per-mode watermark). This scopes
    // auto re-review to PRs you're actively iterating on and avoids re-firing
    // for a head that mode already covered.
    if (event.kind === "pr-sync") {
      const prior = await getLatestReview(
        event.repoPath,
        event.target.type,
        targetRef(event),
        rule.action,
      );
      // sameSha (not `===`) so a short-vs-full sha for the SAME head (Bitbucket's
      // 12-char poll head vs a full-40 seed) counts as "already reviewed" and
      // doesn't re-fire a redundant review each poll tick.
      if (!prior || sameSha(prior.headSha, event.headSha ?? "")) continue;
    }
    const label = modeLabel(rule.action);
    // Per-rule cancellation: HTTP providers stop via the AbortSignal; CLI
    // providers stop by killing the subprocess (`cancelAgentReview` once we
    // know its id). `cancelled` lets the run guards below skip delivery and the
    // failure toast — an abort surfaces as a thrown error or an early return.
    const controller = new AbortController();
    const cli: { id: string | null } = { id: null };
    let cancelled = false;

    const toastId = toast.loading(
      `Running AI ${label} of ${event.kind === "commit" ? event.hash.slice(0, 7) : `"${event.title}"`}…`,
      {
        action: {
          label: "Cancel",
          onClick: (e) => {
            // Keep the toast mounted so we can update it in place.
            e.preventDefault();
            if (cancelled) return;
            cancelled = true;
            controller.abort();
            if (cli.id) cancelAgentReview(cli.id).catch(() => undefined);
            toast.info(`AI ${label} cancelled.`, {
              id: toastId,
              duration: 4000,
            });
          },
        },
      },
    );
    try {
      const text = await generateReviewText(
        settings.reviewAi,
        rule.action,
        event,
        controller.signal,
        (id) => {
          cli.id = id;
        },
      );
      if (cancelled) continue;
      if (text === null) {
        toast.info(`AI ${label} skipped — no changes to review.`, {
          id: toastId,
        });
        continue;
      }
      const body = `**AI ${label} (${settings.reviewAi.model})** · automated\n\n${text}`;
      await deliver(event, rule.action, body, text, toastId, notify);
      // Seed the review-history store so an automated review participates in the
      // iterative loop — the next run (manual or auto) builds on these findings,
      // and its headSha becomes the pr-sync watermark. Best-effort: a
      // persistence failure must never fail a delivered review.
      if (event.kind === "pr-open" || event.kind === "pr-sync") {
        await persistReviewHistory(
          event,
          rule.action,
          text,
          settings.reviewAi.model,
        ).catch(() => undefined);
      }
    } catch (e) {
      if (cancelled) continue;
      toast.error(`AI ${label} failed: ${e instanceof Error ? e.message : e}`, {
        id: toastId,
      });
      if (notify) {
        void notifyIfUnfocused(`AI ${label} failed`, `"${event.title}"`);
      }
    }
  }
}

/**
 * Resolves the diff, builds the prompt, and runs the model to completion.
 * `signal` aborts the HTTP stream; `onCliId` reports the CLI run's id so the
 * caller can kill the subprocess (CLI providers don't take an AbortSignal).
 */
async function generateReviewText(
  ai: AiSettings,
  mode: ReviewMode,
  event: AutomationEvent,
  signal: AbortSignal,
  onCliId: (id: string) => void,
): Promise<string | null> {
  let diff: { text: string; truncated: boolean; files: DiffStatEntry[] };
  if (event.kind === "commit") {
    diff = await gitCommitDiff(event.repoPath, event.hash, DIFF_MAX_BYTES);
  } else if (event.kind === "pr-sync" && event.target.type === "remote") {
    // Remote pr-sync is detected via the provider-neutral head-OID poll, which
    // carries no local base/head branch and whose head may not be local (fork /
    // pushed elsewhere). Use the provider's authoritative PR diff; it has no
    // numstat, so derive the file summary from the diff text. (pr-open and local
    // pr-sync keep the local branch diff below, which already includes file counts.)
    const text = await forgePrDiff(event.repoPath, event.target.number);
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

  // Third-party AI-reviewer findings (Copilot/CodeRabbit) on the remote PR, so an
  // automated re-review weighs them too — same soft context the interactive path
  // uses. Remote PRs only; best-effort.
  const external: ExternalContext =
    event.kind !== "commit" && event.target.type === "remote"
      ? await resolveExternalContext(
          event.repoPath,
          "remote",
          targetRef(event),
          event.headSha,
          false,
          provider,
        )
      : {};
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
      ...prior,
      ...external,
    },
    mode,
  );

  // CLI providers (claude-cli/codex-cli) run as a subprocess, not the AI SDK —
  // route them the same way the interactive review does.
  if (isCliProvider(ai.provider)) {
    let result = "";
    await runCliStream({
      ai,
      system,
      prompt,
      repoPath: event.repoPath,
      // Read the reviewed commit / PR-head's files in a worktree, not whatever
      // branch happens to be checked out.
      headSha: event.kind === "commit" ? event.hash : event.headSha,
      // runCliStream accumulates; the last setText carries the full text.
      setText: (t) => {
        result = t;
      },
      setStatus: () => undefined,
      registerId: onCliId,
    });
    return result;
  }

  const client = await createAiClient(ai);
  let buffer = "";
  for await (const chunk of client.stream({
    system,
    prompt,
    abortSignal: signal,
  })) {
    buffer += chunk;
  }
  return buffer;
}

async function deliver(
  event: AutomationEvent,
  mode: ReviewMode,
  body: string,
  rawText: string,
  toastId: string | number,
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
      id: toastId,
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
    await forgePrComment(event.repoPath, event.target.number, body);
    await queryClient.invalidateQueries({
      queryKey: ["repo", event.repoPath],
    });
    toast.success(`AI ${label} posted on #${event.target.number}`, {
      id: toastId,
    });
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
    toast.error(`AI ${label} finished, but the local PR no longer exists.`, {
      id: toastId,
    });
    return;
  }
  await updateLocalPr(event.repoPath, targetId, (cur) => ({
    ...cur,
    comments: [
      ...cur.comments,
      { id: crypto.randomUUID(), body, createdAt: new Date().toISOString() },
    ],
  }));
  await queryClient.invalidateQueries({
    queryKey: ["local-prs", event.repoPath],
  });
  toast.success(`AI ${label} added to "${pr.title}"`, { id: toastId });
  if (notify) {
    void notifyIfUnfocused(`AI ${label} finished`, `Local PR "${pr.title}"`);
  }
}

/**
 * Persists an automated PR review into the keyed history store (same shape +
 * key the interactive path uses), so the next review of that PR + mode builds
 * on it. Keyed by `(kind, ref, mode)`; `text` is the raw findings, not the
 * comment-wrapped body. Invalidates the panel's history query so an open Review
 * tab reflects it immediately.
 */
async function persistReviewHistory(
  event: PrAutomationEvent,
  mode: ReviewMode,
  text: string,
  model: string,
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
    headSha: event.headSha ?? "",
    startedAt: now,
    finishedAt: now,
  });
  await queryClient.invalidateQueries({
    queryKey: ["review-history", event.repoPath, kind, ref],
  });
}
