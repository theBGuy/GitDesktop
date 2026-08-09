import { useCallback } from "react";
import { toast } from "sonner";
import { useAiStream } from "@/features/conversations/useAiStream";
import { aiExcludePatterns, filterPathsByAiIgnore } from "@/lib/ai/ignore";
import { buildBranchNamePrompt, extractBranchName } from "@/lib/ai/prompt";
import {
  gitBranchDiff,
  gitStagedDiff,
  readRepoInstructions,
} from "@/lib/git/api";
import { sanitizeRefName } from "@/lib/git/ref-name";
import type { FileEntry } from "@/lib/git/types";

/** Raw diff bytes requested from the backend; prompt budgeting trims further. */
const RAW_DIFF_MAX_BYTES = 200_000;

/** The committed work of the ref being named: its three-dot diff against
 *  `base` plus the subjects of the commits `compare` has that `base` doesn't.
 *  `compare` is the ref being named — the checked-out branch's NAME when
 *  creating (the literal `HEAD` only when HEAD is detached; keying on a name
 *  keeps a branch switch from serving the previous branch's commits), the
 *  target branch when renaming. */
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
        const exclude = await aiExcludePatterns(
          repoPath,
          settings.aiIgnorePatterns,
        );

        // `git diff HEAD` omits untracked files; bring their names in so a
        // branch made of all-new files can still be named.
        const untrackedPaths = opts.useWorkingTree
          ? opts.entries
              .filter((e) => e.unstaged === "untracked")
              .map((e) => e.path)
          : [];

        const [diff, repoInstructions, untracked] = await Promise.all([
          opts.useWorkingTree
            ? gitStagedDiff(repoPath, {
                maxBytes: RAW_DIFF_MAX_BYTES,
                exclude,
                worktree: true,
              })
            : null,
          readRepoInstructions(repoPath),
          // Untracked names never pass through a diff, so the ignore patterns
          // have to be applied to them here — a name is disclosure too.
          filterPathsByAiIgnore({ repoPath, paths: untrackedPaths, exclude }),
        ]);

        if (diff && (diff.files.length > 0 || untracked.paths.length > 0)) {
          return buildBranchNamePrompt({
            diffText: diff.text,
            diffTruncated: diff.truncated,
            files: diff.files,
            untrackedPaths: untracked.paths,
            excludedFiles: diff.excludedFiles + untracked.excluded,
            unreadableFiles: untracked.unreadable,
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
            // Both sides' hidden files, plus the working tree's hidden
            // untracked names. A file hidden in BOTH diffs counts twice —
            // deliberately: the sum errs toward disclosing more than is hidden,
            // never less, and there's no per-path list to dedupe on.
            excludedFiles:
              committed.excludedFiles +
              (diff?.excludedFiles ?? 0) +
              untracked.excluded,
            unreadableFiles: untracked.unreadable,
            commitSubjects: fallback.subjects,
            recentBranches: opts.recentBranches,
            repoInstructions,
            globalInstructions: settings.globalInstructions,
          });
        }

        // Nothing to name it after — say which side (if either) was emptied by
        // the ignore patterns rather than genuinely having no changes. Only the
        // PATTERN-hidden files may be attributed to the patterns: an unreadable
        // name is hidden with no pattern configured at all, and blaming the
        // user's list would send them to an empty settings page.
        const treeHidden =
          diff !== null &&
          (diff.excludedFiles > 0 ||
            untracked.excluded - untracked.unreadable > 0);
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
        } else if (untracked.unreadable > 0) {
          message = fallback
            ? `The only in-progress changes are new files whose names aren't readable text, and there are no net changes vs ${fallback.base} to name a branch after.`
            : "Nothing to name a branch after — the only new files have names that aren't readable text.";
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
        // A pattern arm cited one cause; unreadable names are a second one, and
        // the arms below it are only reachable when there are none.
        if (untracked.unreadable > 0 && (treeHidden || committedHidden)) {
          message +=
            " Some new files were also left out because their names aren't readable text.";
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

/** The generation stream, owned by the host dialog rather than the button, so
 *  the dialog can block its own submit while a name is still being generated. */
export type BranchNameGenerator = ReturnType<typeof useGenerateBranchName>;
