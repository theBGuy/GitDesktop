import { useCallback } from "react";
import { toast } from "sonner";
import { useAiStream } from "@/features/conversations/useAiStream";
import { buildPrPrompt, extractPrDraft } from "@/lib/ai/prompt";
import type { PromptProvider } from "@/lib/ai/types";
import {
  gitBranchDiff,
  readRepoAiIgnore,
  readRepoInstructions,
} from "@/lib/git/api";
import type { AppSettings } from "@/lib/settings/api";

/** Raw diff bytes requested from the backend; prompt budgeting trims further. */
const RAW_DIFF_MAX_BYTES = 200_000;

/** The diff shape a supplier must yield — matches `buildPrPrompt`'s `files`. */
interface SuppliedDiff {
  text: string;
  truncated: boolean;
  files: { path: string; added: number; deleted: number; isBinary: boolean }[];
  /** Changed files the user's AI-ignore patterns hid, when the supplier applies
   *  them. Absent (remote-PR diffs) ⇒ nothing was hidden to disclose. */
  excludedFiles?: number;
}

/** A repo label the model may propose from — name plus its stated purpose. The
 *  description is threaded into the prompt; the parser validates on name only. */
interface AvailableLabel {
  name: string;
  description?: string | null;
}

/** A validated real issue the model may link (fed as a grounded candidate). The
 *  parser validates a proposed link's number against this set. */
interface IssueCandidate {
  number: number;
  title: string;
  state: string;
}

/** A mention-only Jira candidate from the repo's linked project (Bitbucket
 *  repos). The parser validates a proposed `Relates:` key against this set. */
interface JiraCandidate {
  key: string;
  summary: string;
  statusCategory: string;
}

/** The parsed draft streamed to `onUpdate` — title/body plus the validated
 *  labels, the model's proposed `Closes:` / `Relates:` issue numbers, and any
 *  validated linked-Jira mention keys. */
interface PrDraft {
  title: string;
  body: string;
  labels: string[];
  closes: number[];
  relates: number[];
  jiraMentions: string[];
}

/**
 * Streams an AI-written PR title + body from the branch diff and the commits
 * the PR would introduce. `onUpdate` fires with the parsed draft on each chunk.
 */
export function useGeneratePrDescription(repoPath: string) {
  const { generating, cancel, run } = useAiStream(repoPath);

  /** Shared streaming core: gets the diff from `getDiff` (handed the loaded
   *  settings, so a supplier can honor the user's AI-ignore patterns), budgets
   *  it into a PR prompt, and streams the parsed title/body/labels draft to
   *  `onUpdate`. `availableLabels` are the repo's existing label names the model
   *  may propose from (validated in the parser — invented labels are dropped). */
  const runFromDiff = useCallback(
    async (
      getDiff: (settings: AppSettings) => Promise<SuppliedDiff>,
      base: string,
      head: string,
      commitSubjects: string[],
      onUpdate: (draft: PrDraft) => void,
      availableLabels: AvailableLabel[],
      provider?: PromptProvider,
      /** Author's "Notes for reviewers" — reflected into the description. */
      reviewNotes?: string,
      /** Validated real issues the model may link (grounded candidates). Empty ⇒
       *  no issue links proposed. */
      issueCandidates?: IssueCandidate[],
      /** Mention-only Jira candidates (Bitbucket repos with a linked project).
       *  Empty ⇒ no Jira mentions proposed. Mutually exclusive with
       *  `issueCandidates` — `buildPrPrompt` gives natives precedence. */
      jiraCandidates?: JiraCandidate[],
    ) => {
      await run(
        async (settings) => {
          const [diff, repoInstructions] = await Promise.all([
            getDiff(settings),
            readRepoInstructions(repoPath),
          ]);
          if (diff.files.length === 0) {
            toast.error(
              (diff.excludedFiles ?? 0) > 0
                ? "All changes between these branches match your AI ignore patterns — nothing to describe."
                : "No changes between these branches to describe.",
            );
            return null;
          }
          return buildPrPrompt({
            diffText: diff.text,
            diffTruncated: diff.truncated,
            files: diff.files,
            excludedFiles: diff.excludedFiles,
            commitSubjects,
            baseBranch: base,
            headBranch: head,
            repoInstructions,
            globalInstructions: settings.globalInstructions,
            reviewNotes,
            availableLabels,
            issueCandidates,
            jiraCandidates,
            provider,
          });
        },
        {
          onChunk: (buffer) =>
            onUpdate(
              extractPrDraft(
                buffer,
                availableLabels.map((l) => l.name),
                (issueCandidates ?? []).map((c) => c.number),
                (jiraCandidates ?? []).map((c) => c.key),
              ),
            ),
        },
      );
    },
    [repoPath, run],
  );

  /** Branch-diff path (Create dialogs + local PRs): resolves the diff from the
   *  local `base..head` refs. Head must exist locally. */
  const generate = useCallback(
    (
      base: string,
      head: string,
      commitSubjects: string[],
      onUpdate: (draft: PrDraft) => void,
      /** Target host — swaps the change-request noun + markdown flavor in the
       *  prompt. Omit (local PRs) to keep the base GitHub wording. */
      provider?: PromptProvider,
      /** The repo's existing labels (name + description) to propose from. Empty ⇒
       *  no labels proposed. Invented labels the model returns are dropped by the
       *  parser (which validates on name only). */
      availableLabels: AvailableLabel[] = [],
      /** Author's "Notes for reviewers" — reflected into the description. */
      reviewNotes?: string,
      /** Validated real issues the model may link (grounded candidates). */
      issueCandidates?: IssueCandidate[],
      /** Mention-only Jira candidates (Bitbucket + linked project). */
      jiraCandidates?: JiraCandidate[],
    ) =>
      runFromDiff(
        async (settings) => {
          const repoIgnore = await readRepoAiIgnore(repoPath);
          const globalIgnore = settings.aiIgnorePatterns
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith("#"));
          const exclude = [...repoIgnore, ...globalIgnore];
          return gitBranchDiff(
            repoPath,
            base,
            head,
            RAW_DIFF_MAX_BYTES,
            exclude,
          );
        },
        base,
        head,
        commitSubjects,
        onUpdate,
        availableLabels,
        provider,
        reviewNotes,
        issueCandidates,
        jiraCandidates,
      ),
    [repoPath, runFromDiff],
  );

  /** Explicit-supplier path (remote PRs): the caller provides the diff — e.g. an
   *  existing PR's own diff query — so it works even when the head branch isn't
   *  present locally (fork PRs, unfetched branches). */
  const generateFromDiff = useCallback(
    (
      getDiff: () => Promise<SuppliedDiff>,
      base: string,
      head: string,
      commitSubjects: string[],
      onUpdate: (draft: PrDraft) => void,
      provider?: PromptProvider,
      /** The repo's existing labels (name + description) to propose from. Empty ⇒
       *  no labels proposed. Invented labels the model returns are dropped by the
       *  parser (which validates on name only). */
      availableLabels: AvailableLabel[] = [],
      /** Author's "Notes for reviewers" — reflected into the description. */
      reviewNotes?: string,
      /** Validated real issues the model may link (grounded candidates). */
      issueCandidates?: IssueCandidate[],
      /** Mention-only Jira candidates (Bitbucket + linked project). */
      jiraCandidates?: JiraCandidate[],
    ) =>
      runFromDiff(
        getDiff,
        base,
        head,
        commitSubjects,
        onUpdate,
        availableLabels,
        provider,
        reviewNotes,
        issueCandidates,
        jiraCandidates,
      ),
    [runFromDiff],
  );

  return { generate, generateFromDiff, cancel, generating };
}
