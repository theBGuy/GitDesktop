import { useCallback } from "react";
import { toast } from "sonner";
import { useAiStream } from "@/features/conversations/useAiStream";
import { buildBranchNamePrompt, extractBranchName } from "@/lib/ai/prompt";
import {
  gitStagedDiff,
  readRepoAiIgnore,
  readRepoInstructions,
} from "@/lib/git/api";
import { sanitizeRefName } from "@/lib/git/ref-name";
import type { FileEntry } from "@/lib/git/types";

/** Raw diff bytes requested from the backend; prompt budgeting trims further. */
const RAW_DIFF_MAX_BYTES = 200_000;

/**
 * Suggests a branch name from the repo's in-progress changes (the whole working
 * tree vs HEAD, plus untracked file names), using the existing branches as a
 * convention reference. The caller gates this on having changes — there's
 * nothing to name a branch after when the tree is clean.
 */
export function useGenerateBranchName(repoPath: string) {
  const { generating, cancel, run } = useAiStream(repoPath);

  const generate = useCallback(
    async (opts: {
      entries: FileEntry[];
      recentBranches: string[];
      onName: (name: string) => void;
    }) => {
      const buffer = await run(async (settings) => {
        const repoIgnore = await readRepoAiIgnore(repoPath);
        const globalIgnore = settings.aiIgnorePatterns
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("#"));
        const exclude = [...repoIgnore, ...globalIgnore];

        const [diff, repoInstructions] = await Promise.all([
          gitStagedDiff(repoPath, {
            maxBytes: RAW_DIFF_MAX_BYTES,
            exclude,
            worktree: true,
          }),
          readRepoInstructions(repoPath),
        ]);

        // `git diff HEAD` omits untracked files; bring their names in so a
        // branch made of all-new files can still be named.
        const untrackedPaths = opts.entries
          .filter((e) => e.unstaged === "untracked")
          .map((e) => e.path);

        if (diff.files.length === 0 && untrackedPaths.length === 0) {
          toast.error(
            diff.excludedFiles > 0
              ? "All changes match your AI ignore patterns — nothing to name a branch after."
              : "No in-progress changes to name a branch after.",
          );
          return null;
        }

        return buildBranchNamePrompt({
          diffText: diff.text,
          diffTruncated: diff.truncated,
          files: diff.files,
          untrackedPaths,
          excludedFiles: diff.excludedFiles,
          recentBranches: opts.recentBranches,
          repoInstructions,
          globalInstructions: settings.globalInstructions,
        });
      });

      if (buffer === null) return;
      const name = sanitizeRefName(extractBranchName(buffer));
      if (name) opts.onName(name);
      else toast.error("Couldn't generate a branch name — try again.");
    },
    [repoPath, run],
  );

  return { generate, cancel, generating };
}
