import { useCallback } from "react";
import { toast } from "sonner";
import { useAiStream } from "@/features/conversations/useAiStream";
import { buildBranchNamePrompt, extractBranchName } from "@/lib/ai/prompt";
import {
  gitBranchDiff,
  gitStagedDiff,
  readRepoAiIgnore,
  readRepoInstructions,
} from "@/lib/git/api";
import { sanitizeRefName } from "@/lib/git/ref-name";
import type { FileEntry } from "@/lib/git/types";

/** Raw diff bytes requested from the backend; prompt budgeting trims further. */
const RAW_DIFF_MAX_BYTES = 200_000;

/** The committed work of the ref being named: its three-dot diff against
 *  `base` plus the subjects of the commits `compare` has that `base` doesn't.
 *  `compare` is the ref being named — HEAD when creating a branch, the target
 *  branch when renaming one that isn't checked out. */
export interface CommittedNameSource {
  base: string;
  compare: string;
  subjects: string[];
}

/**
 * Suggests a name for a branch from the repo's in-progress changes (the whole
 * working tree vs HEAD, plus untracked file names), using the existing branches
 * as a convention reference. When the tree is clean — or when the branch being
 * named isn't the checked-out one, so the working tree doesn't describe it at
 * all (`useWorkingTree: false`) — it names the branch from `committedFallback`
 * instead. The caller gates the affordance on at least one source being
 * available and decides which of them the commit subjects describe.
 */
export function useGenerateBranchName(repoPath: string) {
  const { generating, cancel, run } = useAiStream(repoPath);

  const generate = useCallback(
    async (opts: {
      entries: FileEntry[];
      recentBranches: string[];
      /** Whether the working tree describes the branch being named. False when
       *  renaming a branch that isn't checked out — its working tree belongs to
       *  the checked-out branch, so it must not be read at all. */
      useWorkingTree: boolean;
      /** Subjects to accompany the WORKING-TREE prompt. Empty unless the
       *  branch's commits describe the same work as the in-progress changes
       *  (renaming the checked-out branch) — in the create dialog they describe
       *  the parent branch and would bias the name away from the new work. */
      workingTreeSubjects: string[];
      /** The committed work of the branch being named, when it has any. */
      committedFallback: CommittedNameSource | null;
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
          opts.useWorkingTree
            ? gitStagedDiff(repoPath, {
                maxBytes: RAW_DIFF_MAX_BYTES,
                exclude,
                worktree: true,
              })
            : null,
          readRepoInstructions(repoPath),
        ]);

        // `git diff HEAD` omits untracked files; bring their names in so a
        // branch made of all-new files can still be named.
        const untrackedPaths = opts.useWorkingTree
          ? opts.entries
              .filter((e) => e.unstaged === "untracked")
              .map((e) => e.path)
          : [];

        if (diff && (diff.files.length > 0 || untrackedPaths.length > 0)) {
          return buildBranchNamePrompt({
            diffText: diff.text,
            diffTruncated: diff.truncated,
            files: diff.files,
            untrackedPaths,
            excludedFiles: diff.excludedFiles,
            commitSubjects: opts.workingTreeSubjects,
            recentBranches: opts.recentBranches,
            repoInstructions,
            globalInstructions: settings.globalInstructions,
          });
        }

        // No usable working tree: name the branch from what it has already
        // committed — the three-dot diff vs the default branch, the same set a
        // PR would show, taken against the ref actually being named.
        const fallback = opts.committedFallback;
        const committed = fallback
          ? await gitBranchDiff(
              repoPath,
              fallback.base,
              fallback.compare,
              RAW_DIFF_MAX_BYTES,
              exclude,
            )
          : null;
        if (
          fallback &&
          committed &&
          (committed.files.length > 0 || committed.text !== "")
        ) {
          return buildBranchNamePrompt({
            diffText: committed.text,
            diffTruncated: committed.truncated,
            files: committed.files,
            untrackedPaths: [],
            // Both sides' hidden files. A file hidden in BOTH diffs counts
            // twice — deliberately: the sum errs toward disclosing more than is
            // hidden, never less, and there's no per-path list to dedupe on.
            excludedFiles: committed.excludedFiles + (diff?.excludedFiles ?? 0),
            commitSubjects: fallback.subjects,
            recentBranches: opts.recentBranches,
            repoInstructions,
            globalInstructions: settings.globalInstructions,
          });
        }

        // Nothing to name it after — say which side (if either) was emptied by
        // the ignore patterns rather than genuinely having no changes.
        const treeHidden = diff !== null && diff.excludedFiles > 0;
        const committedHidden =
          committed !== null && committed.excludedFiles > 0;
        let message: string;
        if (treeHidden && committedHidden) {
          message =
            "All changes match your AI ignore patterns — nothing left in your working tree or this branch's commits to name it after.";
        } else if (committedHidden) {
          message =
            "This branch's committed changes all match your AI ignore patterns — nothing to name it after.";
        } else if (treeHidden) {
          message = fallback
            ? `All your in-progress changes match your AI ignore patterns, and there are no net changes vs ${fallback.base} to name a branch after.`
            : "All changes match your AI ignore patterns — nothing to name a branch after.";
        } else if (fallback) {
          message = opts.useWorkingTree
            ? `No in-progress changes, and no net changes vs ${fallback.base} to name a branch after.`
            : `No net changes vs ${fallback.base} to name this branch after.`;
        } else if (opts.useWorkingTree) {
          message = "No in-progress changes to name a branch after.";
        } else {
          // Defensive: the caller disables the affordance in this state, and
          // with no working tree read there are no in-progress changes to cite.
          message = "Nothing to name this branch after.";
        }
        toast.error(message);
        return null;
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
