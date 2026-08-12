import { useCallback } from "react";
import { toast } from "sonner";
import { useAiStream } from "@/features/conversations/useAiStream";
import { aiExcludePatterns } from "@/lib/ai/ignore";
import { buildCommitPrompt, splitCommitMessage } from "@/lib/ai/prompt";
import {
  gitRecentCommits,
  gitStagedDiff,
  readRepoInstructions,
} from "@/lib/git/api";
import { useUiStore } from "@/lib/stores/ui";

/** Raw diff bytes requested from the backend; prompt budgeting trims further. */
const RAW_DIFF_MAX_BYTES = 200_000;

export function useGenerateCommitMessage(repoPath: string) {
  const { cancel, run } = useAiStream(repoPath);
  const setCommitDraft = useUiStore((s) => s.setCommitDraft);
  const setGenerating = useUiStore((s) => s.setGenerating);
  const setCommitAiGenerated = useUiStore((s) => s.setCommitAiGenerated);
  // The commit box shares one global `generating` flag with the rest of the UI
  // (it also gates the commit button), so the flag lives in the store rather
  // than in useAiStream's local state.
  const generating = useUiStore((s) => s.generating);

  const generate = useCallback(async () => {
    // The key is captured at start and re-checked at every write: setDraftFields
    // mirrors into commitDrafts under the LIVE key, so a moved key means the user
    // switched repo or branch — drop the remaining writes and abort the stream.
    const startKey = useUiStore.getState().activeDraftKey;
    // A null startKey (pre-branch-resolution) treats any later key as a move.
    const keyMoved = () => useUiStore.getState().activeDraftKey !== startKey;
    setGenerating(true);
    const buffer = await run(
      async (settings) => {
        const exclude = await aiExcludePatterns(
          repoPath,
          settings.aiIgnorePatterns,
        );

        const [staged, commits, repoInstructions] = await Promise.all([
          gitStagedDiff(repoPath, { maxBytes: RAW_DIFF_MAX_BYTES, exclude }),
          gitRecentCommits(repoPath, 10),
          readRepoInstructions(repoPath),
        ]);
        if (staged.files.length === 0) {
          toast.error(
            staged.excludedFiles > 0
              ? "All staged changes match your AI ignore patterns — nothing to describe."
              : "Nothing is staged — stage some changes first.",
          );
          return null;
        }

        return buildCommitPrompt({
          diffText: staged.text,
          diffTruncated: staged.truncated,
          files: staged.files,
          excludedFiles: staged.excludedFiles,
          recentSubjects: commits.map((c) => c.subject),
          repoInstructions,
          globalInstructions: settings.globalInstructions,
        });
      },
      {
        onChunk: (buffer) => {
          if (keyMoved()) {
            cancel();
            return;
          }
          const { title, body } = splitCommitMessage(buffer);
          setCommitDraft(title, body);
        },
      },
    );
    // A non-null buffer means the stream ran to completion (not aborted, not
    // bailed) — mark the draft as AI-generated just as the old skeleton did.
    if (buffer !== null && !keyMoved()) setCommitAiGenerated(true);
    setGenerating(false);
  }, [
    repoPath,
    run,
    cancel,
    setCommitDraft,
    setGenerating,
    setCommitAiGenerated,
  ]);

  return { generate, cancel, generating };
}
