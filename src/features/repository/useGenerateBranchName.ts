import { useCallback } from "react";
import { toast } from "sonner";
import { useAiStream } from "@/features/conversations/useAiStream";
import {
  aiExcludePatterns,
  filterPathsByAiIgnore,
  lossyListingRows,
} from "@/lib/ai/ignore";
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

/** What one side (working tree, or committed work) of an empty branch-name run
 *  held: changes the patterns hid, only files whose names aren't readable text,
 *  or nothing at all. */
type SideState = "patterns" | "unreadable" | "none";

function sideState(patternHidden: boolean, unreadable: number): SideState {
  if (patternHidden) return "patterns";
  return unreadable > 0 ? "unreadable" : "none";
}

/** Empty-state copy with no committed work to fall back on, by working tree. */
const NO_FALLBACK_COPY: Record<SideState, string> = {
  patterns:
    "All changes match your AI ignore patterns — nothing to name a branch after.",
  unreadable:
    "Nothing to name a branch after — the only changed files have names that aren't readable text.",
  none: "No in-progress changes to name a branch after.",
};

/** Empty-state copy naming a branch that isn't checked out, by its committed
 *  work vs `base`. */
const COMMITTED_ONLY_COPY: Record<SideState, (base: string) => string> = {
  patterns: () =>
    "This branch's committed changes all match your AI ignore patterns — nothing to name it after.",
  unreadable: (base) =>
    `The only net changes vs ${base} are files whose names aren't readable text — nothing to name this branch after.`,
  none: (base) => `No net changes vs ${base} to name this branch after.`,
};

/** Empty-state copy by `<working tree>-<committed work>` state. A side holding
 *  only unreadable names is never described as having no changes. */
const BOTH_SIDES_COPY: Record<
  `${SideState}-${SideState}`,
  (base: string) => string
> = {
  "patterns-patterns": () =>
    "All changes match your AI ignore patterns — nothing left in your working tree or this branch's commits to name it after.",
  "unreadable-patterns": () =>
    "This branch's committed changes all match your AI ignore patterns, and the only in-progress changes are files whose names aren't readable text — nothing to name it after.",
  "none-patterns": () =>
    "This branch's committed changes all match your AI ignore patterns — nothing to name it after.",
  "patterns-unreadable": (base) =>
    `All your in-progress changes match your AI ignore patterns, and the only net changes vs ${base} are files whose names aren't readable text — nothing to name a branch after.`,
  "patterns-none": (base) =>
    `All your in-progress changes match your AI ignore patterns, and there are no net changes vs ${base} to name a branch after.`,
  "unreadable-unreadable": (base) =>
    `The only changes, in progress or committed vs ${base}, are files whose names aren't readable text — nothing to name a branch after.`,
  "unreadable-none": (base) =>
    `The only in-progress changes are files whose names aren't readable text, and there are no net changes vs ${base} to name a branch after.`,
  "none-unreadable": (base) =>
    `No in-progress changes, and the only net changes vs ${base} are files whose names aren't readable text — nothing to name a branch after.`,
  "none-none": (base) =>
    `No in-progress changes, and no net changes vs ${base} to name a branch after.`,
};

/** The committed work of the ref being named: its three-dot diff against
 *  `base` plus the subjects of the commits `compare` has that `base` doesn't.
 *  `compare` is the ref being named — the checked-out branch's full
 *  `refs/heads/` ref when creating (the literal `HEAD` only when HEAD is
 *  detached; keying on the ref keeps a branch switch from serving the previous
 *  branch's commits, and the full form keeps a same-named tag from capturing
 *  the rev), the target branch when renaming. `base` is the default branch's
 *  SHORT name, for copy only; `baseRev` is the same ref spelled in full, which
 *  the diff takes so it reads the range the subjects came from (a short
 *  `origin/main` resolves to a same-named tag first). */
export interface CommittedNameSource {
  base: string;
  baseRev: string;
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
          filterPathsByAiIgnore({
            repoPath,
            paths: lossyListingRows(untrackedPaths),
            exclude,
          }),
        ]);

        // Every pair summed below is wire-subset (`StagedDiff` and
        // `filterPathsByAiIgnore` counts), so the sums stay subset too.
        if (diff && (diff.files.length > 0 || untracked.paths.length > 0)) {
          return buildBranchNamePrompt({
            diffText: diff.text,
            diffTruncated: diff.truncated,
            files: diff.files,
            untrackedPaths: untracked.paths,
            excludedFiles: diff.excludedFiles + untracked.excluded,
            unreadableFiles: diff.unreadableFiles + untracked.unreadable,
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
              fallback.baseRev,
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
            unreadableFiles:
              committed.unreadableFiles +
              (diff?.unreadableFiles ?? 0) +
              untracked.unreadable,
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
        const treeUnreadable =
          (diff?.unreadableFiles ?? 0) + untracked.unreadable;
        const committedUnreadable = committed?.unreadableFiles ?? 0;
        const treeHidden =
          diff !== null &&
          diff.excludedFiles -
            diff.unreadableFiles +
            (untracked.excluded - untracked.unreadable) >
            0;
        const committedHidden =
          committed !== null &&
          committed.excludedFiles - committed.unreadableFiles > 0;
        const tree = sideState(treeHidden, treeUnreadable);
        const committedSide = sideState(committedHidden, committedUnreadable);
        let message: string;
        if (fallback && opts.useWorkingTree) {
          message = BOTH_SIDES_COPY[`${tree}-${committedSide}`](fallback.base);
        } else if (fallback) {
          message = COMMITTED_ONLY_COPY[committedSide](fallback.base);
        } else if (opts.useWorkingTree) {
          message = NO_FALLBACK_COPY[tree];
        } else {
          // Defensive: the caller disables the affordance in this state, and
          // with no working tree read there are no in-progress changes to cite.
          message = "Nothing to name this branch after.";
        }
        // A side labelled by its patterns may also hold unreadable names; say so
        // unless the copy already names that cause for a side.
        const hiddenUnreadable =
          (tree === "patterns" && treeUnreadable > 0) ||
          (committedSide === "patterns" && committedUnreadable > 0);
        if (
          hiddenUnreadable &&
          tree !== "unreadable" &&
          committedSide !== "unreadable"
        ) {
          message +=
            " Some files were also left out because their names aren't readable text.";
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
