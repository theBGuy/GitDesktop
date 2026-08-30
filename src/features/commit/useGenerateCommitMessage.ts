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
import { resolveDraftKey, useUiStore } from "@/lib/stores/ui";

/** Raw diff bytes requested from the backend; prompt budgeting trims further. */
const RAW_DIFF_MAX_BYTES = 200_000;

/**
 * Aborts the one generation that can be in flight — `generating` is a single
 * store flag every Generate affordance gates on, so there is never more than
 * one. Module scope rather than per-instance because the inline commit box and
 * the pop-out dialog each mount their own hook instance over that one flag: a
 * Cancel in the surface that didn't start the run would otherwise abort its own
 * idle controller and silently do nothing. Written and read from callbacks
 * only — a render read would go stale under the React Compiler.
 */
let liveCancel: (() => void) | null = null;

export function useGenerateCommitMessage(repoPath: string) {
  const { cancel: cancelOwn, run } = useAiStream(repoPath);
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
    // On a move, cancelOwn() always aborts THIS run: a second generation can't
    // start while `generating` is set (both commit surfaces gate their button
    // and hotkey on it). The test is draft identity, not key equality: a branch
    // rename re-keys the same draft, so resolve the captured key through the
    // store's rename remaps.
    const keyMoved = () => {
      const s = useUiStore.getState();
      return resolveDraftKey(s.draftKeyRemaps, startKey) !== s.activeDraftKey;
    };
    setGenerating(true);
    // Publish this run's abort while the flag is up, so either surface's Cancel
    // reaches it — including after the starting surface unmounts.
    liveCancel = cancelOwn;
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
            cancelOwn();
            return;
          }
          const { title, body } = splitCommitMessage(buffer);
          setCommitDraft(title, body);
        },
      },
    );
    // Retire the entry with the flag it shadows, and only if it is still this
    // run's — anything else there belongs to a run that came after.
    if (liveCancel === cancelOwn) liveCancel = null;
    // A non-null buffer means the stream ran to completion (not aborted, not
    // bailed) — mark the draft as AI-generated just as the old skeleton did.
    if (buffer !== null && !keyMoved()) setCommitAiGenerated(true);
    setGenerating(false);
  }, [
    repoPath,
    run,
    cancelOwn,
    setCommitDraft,
    setGenerating,
    setCommitAiGenerated,
  ]);

  // Every surface's Cancel aborts whichever run is live, not the one this
  // instance happens to own.
  const cancel = useCallback(() => {
    liveCancel?.();
  }, []);

  return { generate, cancel, generating };
}
