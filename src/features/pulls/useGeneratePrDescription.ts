import { useCallback } from "react";
import { toast } from "sonner";
import { useAiStream } from "@/features/conversations/useAiStream";
import { buildPrPrompt, splitCommitMessage } from "@/lib/ai/prompt";
import type { PromptProvider } from "@/lib/ai/types";
import { gitBranchDiff, readRepoInstructions } from "@/lib/git/api";

/** Raw diff bytes requested from the backend; prompt budgeting trims further. */
const RAW_DIFF_MAX_BYTES = 200_000;

/** The diff shape a supplier must yield — matches `buildPrPrompt`'s `files`. */
interface SuppliedDiff {
  text: string;
  truncated: boolean;
  files: { path: string; added: number; deleted: number; isBinary: boolean }[];
}

/**
 * Streams an AI-written PR title + body from the branch diff and the commits
 * the PR would introduce. `onUpdate` fires with the parsed draft on each chunk.
 */
export function useGeneratePrDescription(repoPath: string) {
  const { generating, cancel, run } = useAiStream();

  /** Shared streaming core: gets the diff from `getDiff`, budgets it into a PR
   *  prompt, and streams the parsed title/body draft to `onUpdate`. */
  const runFromDiff = useCallback(
    async (
      getDiff: () => Promise<SuppliedDiff>,
      base: string,
      head: string,
      commitSubjects: string[],
      onUpdate: (draft: { title: string; body: string }) => void,
      provider?: PromptProvider,
    ) => {
      await run(
        async (settings) => {
          const [diff, repoInstructions] = await Promise.all([
            getDiff(),
            readRepoInstructions(repoPath),
          ]);
          if (diff.files.length === 0) {
            toast.error("No changes between these branches to describe.");
            return null;
          }
          return buildPrPrompt({
            diffText: diff.text,
            diffTruncated: diff.truncated,
            files: diff.files,
            commitSubjects,
            baseBranch: base,
            headBranch: head,
            repoInstructions,
            globalInstructions: settings.globalInstructions,
            provider,
          });
        },
        { onChunk: (buffer) => onUpdate(splitCommitMessage(buffer)) },
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
      onUpdate: (draft: { title: string; body: string }) => void,
      /** Target host — swaps the change-request noun + markdown flavor in the
       *  prompt. Omit (local PRs) to keep the base GitHub wording. */
      provider?: PromptProvider,
    ) =>
      runFromDiff(
        () => gitBranchDiff(repoPath, base, head, RAW_DIFF_MAX_BYTES),
        base,
        head,
        commitSubjects,
        onUpdate,
        provider,
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
      onUpdate: (draft: { title: string; body: string }) => void,
      provider?: PromptProvider,
    ) => runFromDiff(getDiff, base, head, commitSubjects, onUpdate, provider),
    [runFromDiff],
  );

  return { generate, generateFromDiff, cancel, generating };
}
