import { SparkleIcon } from "@phosphor-icons/react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { FileEntry } from "@/lib/git/types";
import type {
  BranchNameGenerator,
  CommittedNameSource,
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

/** The working tree belongs to the checked-out branch, so it can only name a
 *  new branch or that branch itself. */
function usesWorkingTree(nameTarget: BranchNameTarget): boolean {
  return nameTarget !== "other-branch";
}

/** The one generate pair the button and the host dialog's generate chord both
 *  consume — see {@link useBranchNameGenerateAction}. */
export interface BranchNameGenerateAction {
  /** Starts the generation with the sources `nameTarget` says apply. */
  run: () => void;
  /** Whether generating is possible right now — the button's enabled state, and
   *  the only gate the chord may run under. */
  enabled: boolean;
}

/**
 * Derives the branch-name generation — its prompt sources and its enabled
 * gate — once per host dialog, so the Generate button and the dialog's generate
 * chord can't drift apart on either. The dialog owns the stream (`gen`) so it
 * can block its own submit while a name is still generating.
 */
export function useBranchNameGenerateAction({
  gen,
  aiEnabled,
  aiConfigured,
  hasChanges,
  headExists,
  entries,
  recentBranches,
  nameTarget,
  committedFallback,
  onName,
}: {
  gen: BranchNameGenerator;
  aiEnabled: boolean;
  aiConfigured: boolean;
  hasChanges: boolean;
  headExists: boolean;
  entries: FileEntry[];
  /** Existing branch names, used as a naming-convention reference (capped). */
  recentBranches: string[];
  nameTarget: BranchNameTarget;
  committedFallback: CommittedNameSource | null;
  onName: (name: string) => void;
}): BranchNameGenerateAction {
  const useWorkingTree = usesWorkingTree(nameTarget);
  return {
    enabled:
      aiEnabled &&
      aiConfigured &&
      !gen.generating &&
      headExists &&
      ((useWorkingTree && hasChanges) || committedFallback !== null),
    run: () =>
      gen.generate({
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
      }),
  };
}

/**
 * The "✧ Generate from changes" affordance shared by the create- and
 * rename-branch dialogs: suggests a branch name from the working-tree changes
 * (when they describe the branch being named) — or, failing that, from that
 * branch's committed work (`committedFallback`) — or points the user at AI
 * setup when no provider is connected. Renders nothing when AI is disabled.
 * The host dialog owns the generation stream (`gen`) so it can block its own
 * submit while a name is still being generated, and hands down the `action` it
 * shares with its generate chord; the button adds only the explanatory copy for
 * why generating is (or isn't) available.
 */
export function GenerateBranchNameButton({
  gen,
  action,
  hint,
  aiEnabled,
  aiConfigured,
  hasChanges,
  headExists,
  nameTarget,
  committedFallback,
  committedStatus,
  basedElsewhere,
  onSetupAi,
}: {
  /** Owned by the host dialog — see {@link BranchNameGenerator}. */
  gen: BranchNameGenerator;
  /** Shared with the host dialog's generate chord — see
   *  {@link useBranchNameGenerateAction}. */
  action: BranchNameGenerateAction;
  /** The generate chord's " (Ctrl+G)" hint; "" when it's unbound. */
  hint: string;
  aiEnabled: boolean;
  aiConfigured: boolean;
  hasChanges: boolean;
  headExists: boolean;
  /** What the name must describe — see {@link BranchNameTarget}. */
  nameTarget: BranchNameTarget;
  /** The committed work of the branch being named, vs the default branch. Null
   *  when it has none, when no default branch resolves, or when the host dialog
   *  suppresses it (a create whose base isn't the branch you're on). */
  committedFallback: CommittedNameSource | null;
  /** How the committed-work lookup stands. Only `"ready"` makes a null
   *  `committedFallback` mean "there is none" — while it's `"pending"` or
   *  `"error"` the button must say so instead of claiming there's nothing. */
  committedStatus: "ready" | "pending" | "error";
  /** The base a new branch will start from, when that base ISN'T the branch
   *  you're on — the committed fallback can't apply (the new branch contains
   *  none of that work), and the disabled state must say THAT rather than
   *  claim there's no committed work. Null whenever the fallback does apply. */
  basedElsewhere: string | null;
  /** Close the host dialog and open AI settings. */
  onSetupAi: () => void;
}) {
  if (!aiEnabled) return null;
  const useWorkingTree = usesWorkingTree(nameTarget);
  const fromWorkingTree = useWorkingTree && hasChanges;
  const reason = !headExists
    ? "Make your first commit before branching from changes"
    : fromWorkingTree
      ? "Suggest a name from your in-progress changes"
      : committedFallback
        ? "Suggest a name from this branch's committed changes"
        : committedStatus === "pending"
          ? "Checking this branch's committed work…"
          : committedStatus === "error"
            ? "Couldn't check this branch's committed work"
            : basedElsewhere
              ? `Branching from ${basedElsewhere} — a name can only come from your in-progress changes`
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
      ) : gen.generating ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="text-muted-foreground"
          onClick={gen.cancel}
        >
          <Spinner data-icon="inline-start" />
          Generating…
        </Button>
      ) : (
        <DisabledReasonButton
          type="button"
          variant="ghost"
          size="xs"
          className="text-muted-foreground"
          disabled={!action.enabled}
          reason={reason}
          // `reason` doubles as the enabled-state hint ("Suggest a name from…"),
          // which is where the chord belongs — a disabled button's shortcut does
          // nothing, so it isn't offered.
          title={action.enabled ? `${reason}${hint}` : reason}
          onClick={action.run}
        >
          <SparkleIcon data-icon="inline-start" />
          Generate from changes
        </DisabledReasonButton>
      )}
    </div>
  );
}
