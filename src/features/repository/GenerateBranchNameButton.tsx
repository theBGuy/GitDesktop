import { SparkleIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { FileEntry } from "@/lib/git/types";
import {
  type CommittedNameSource,
  useGenerateBranchName,
} from "./useGenerateBranchName";

/** What the generated name has to describe — decides whether the working tree
 *  counts as a source and whether the branch's commit subjects describe it. */
export type BranchNameTarget =
  /** A new branch off the picked base (create dialog): the working tree comes
   *  along, but the current branch's commits describe the parent, not it. */
  | "new-branch"
  /** The checked-out branch (rename): its working tree AND its commits both
   *  describe it. */
  | "checked-out-branch"
  /** A branch that isn't checked out (rename from a row's menu): only its own
   *  commits describe it — the working tree belongs to someone else. */
  | "other-branch";

/**
 * The "✧ Generate from changes" affordance shared by the create- and
 * rename-branch dialogs: suggests a branch name from the working-tree changes
 * (when they describe the branch being named) — or, failing that, from that
 * branch's committed work (`committedFallback`) — or points the user at AI
 * setup when no provider is connected. Renders nothing when AI is disabled.
 * Owns its own generation stream, so each dialog only says what's being named
 * (`nameTarget`), where the name lands (`onName`), and how to reach AI settings
 * (`onSetupAi`).
 */
export function GenerateBranchNameButton({
  repoPath,
  aiEnabled,
  aiConfigured,
  hasChanges,
  headExists,
  entries,
  recentBranches,
  nameTarget,
  committedFallback,
  committedPending,
  onName,
  onSetupAi,
}: {
  repoPath: string;
  aiEnabled: boolean;
  aiConfigured: boolean;
  hasChanges: boolean;
  headExists: boolean;
  entries: FileEntry[];
  /** Existing branch names, used as a naming-convention reference (capped). */
  recentBranches: string[];
  /** What the name must describe — see {@link BranchNameTarget}. */
  nameTarget: BranchNameTarget;
  /** The committed work of the branch being named, vs the default branch. Null
   *  when it has none, when no default branch resolves, or when the host dialog
   *  suppresses it (a create whose base isn't the branch you're on). */
  committedFallback: CommittedNameSource | null;
  /** Whether `committedFallback` is still being resolved — a null fallback
   *  doesn't yet mean there's no committed work, so the button must say it's
   *  still checking rather than claim there's nothing. */
  committedPending: boolean;
  onName: (name: string) => void;
  /** Close the host dialog and open AI settings. */
  onSetupAi: () => void;
}) {
  const branchNameGen = useGenerateBranchName(repoPath);
  if (!aiEnabled) return null;
  // The working tree belongs to the checked-out branch, so it can only name a
  // new branch or that branch itself.
  const useWorkingTree = nameTarget !== "other-branch";
  const fromWorkingTree = useWorkingTree && hasChanges;
  const canGenerate =
    headExists && (fromWorkingTree || committedFallback !== null);
  const reason = !headExists
    ? "Make your first commit before branching from changes"
    : fromWorkingTree
      ? "Suggest a name from your in-progress changes"
      : committedFallback
        ? "Suggest a name from this branch's committed changes"
        : committedPending
          ? "Checking this branch's committed work…"
          : useWorkingTree
            ? "No in-progress changes and no committed work vs the default branch — nothing to name a branch after"
            : "This branch has no commits the default branch doesn't — nothing to name it after";
  return (
    <div className="flex justify-end">
      {!aiConfigured ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="text-muted-foreground"
          title="Connect an AI provider to generate branch names"
          onClick={onSetupAi}
        >
          <SparkleIcon data-icon="inline-start" />
          Set up AI to name branches
        </Button>
      ) : branchNameGen.generating ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="text-muted-foreground"
          onClick={branchNameGen.cancel}
        >
          <Spinner data-icon="inline-start" />
          Generating…
        </Button>
      ) : (
        // Wrap so the reason still shows when the button is disabled — a
        // native-disabled button swallows the tooltip.
        <span className="inline-flex" title={reason}>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            disabled={!canGenerate}
            onClick={() =>
              branchNameGen.generate({
                entries,
                recentBranches: recentBranches.slice(0, 20),
                useWorkingTree,
                // Only when naming the very branch those commits sit on.
                workingTreeSubjects:
                  nameTarget === "checked-out-branch"
                    ? (committedFallback?.subjects ?? [])
                    : [],
                committedFallback,
                onName,
              })
            }
          >
            <SparkleIcon data-icon="inline-start" />
            Generate from changes
          </Button>
        </span>
      )}
    </div>
  );
}
