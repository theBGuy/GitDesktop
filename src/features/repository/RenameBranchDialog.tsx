import { useEffect, useEffectEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { required, useAppForm } from "@/lib/form";
import { useRenameBranch } from "@/lib/git/queries";
import { refNameWarning, sanitizeRefName } from "@/lib/git/ref-name";
import type { FileEntry } from "@/lib/git/types";
import { toastError } from "@/lib/toast";
import { useRetained } from "@/lib/use-retained";
import { GenerateBranchNameButton } from "./GenerateBranchNameButton";
import {
  type BranchNameGenerator,
  type CommittedNameSource,
  useGenerateBranchName,
} from "./useGenerateBranchName";

/**
 * Rename-branch dialog. Open when `target` is the branch being renamed (null =
 * closed). Owns its own form + the rename mutation; seeds the field with the
 * current name on open so the user edits from there. The target need not be the
 * checked-out branch — every branch row's context menu opens this — so AI name
 * generation reads the working tree only when it is.
 */
export function RenameBranchDialog({
  repoPath,
  target,
  currentName,
  onClose,
  aiEnabled,
  aiConfigured,
  hasChanges,
  headExists,
  entries,
  allBranchNames,
  committedFallback,
  committedStatus,
  onOpenSettings,
}: {
  repoPath: string;
  target: string | null;
  /** The checked-out branch — decides whether `target`'s working tree is its
   *  own (null when HEAD is detached, which is never the rename target). */
  currentName: string | null;
  onClose: () => void;
  aiEnabled: boolean;
  aiConfigured: boolean;
  hasChanges: boolean;
  headExists: boolean;
  entries: FileEntry[];
  allBranchNames: string[];
  /** The committed work of the branch being renamed, vs the default branch —
   *  compared against `target` itself, not HEAD. */
  committedFallback: CommittedNameSource | null;
  /** How the committed-work lookup stands (pending/error are surfaced rather
   *  than read as "there is none"). */
  committedStatus: "ready" | "pending" | "error";
  onOpenSettings: (section: "ai") => void;
}) {
  const renameBranch = useRenameBranch(repoPath);
  const branchNameGen = useGenerateBranchName(repoPath);
  // The Generate affordance's copy — and so its enabled state — is retained
  // through the close fade below, so the dispatch carries the liveness: a click
  // after close would start an uncancellable generation whose name lands in the
  // next open's field.
  const guardedGen: BranchNameGenerator = {
    ...branchNameGen,
    generate: async (opts) => {
      if (target === null) return;
      await branchNameGen.generate(opts);
    },
  };
  // Every close path routes through here: the dialog stays mounted, so an
  // in-flight suggestion would otherwise land in the field on the NEXT open,
  // which may be naming a different branch.
  const closeDialog = () => {
    branchNameGen.cancel();
    onClose();
  };
  const shownTarget = useRetained(target);
  // The parent's committed-work lookup collapses when the dialog closes, so
  // these two retain on the dialog's own discriminant rather than their values:
  // null / "ready" are legitimate while it's open (a branch with no commits).
  const shownCommittedFallback = useRetained(
    committedFallback,
    target !== null,
  );
  const shownCommittedStatus = useRetained(committedStatus, target !== null);
  // Only the checked-out branch's own working tree describes it.
  const targetIsCurrent = shownTarget !== null && shownTarget === currentName;

  const renameForm = useAppForm({
    defaultValues: { name: "" },
    onSubmit: async ({ value }) => {
      if (!target) return;
      const newName = sanitizeRefName(value.name);
      try {
        await renameBranch.mutateAsync({ oldName: target, newName });
        toast.success(`Renamed to ${newName}`);
        onClose();
      } catch (e) {
        toastError(e);
      }
    },
  });

  // NOTE: seeding resets must pass keepDefaultValues — otherwise reset()
  // rewrites the form's defaultValues, and react-form's per-render options
  // sync sees "different defaults + untouched form" and clobbers the seeded
  // values right back on the next render.
  const seedOnOpen = useEffectEvent((name: string) => {
    renameForm.reset({ name }, { keepDefaultValues: true });
  });
  useEffect(() => {
    if (target !== null) seedOnOpen(target);
  }, [target]);

  // Generations are bound to the target they were started for: the rename
  // hotkey stays live over the open dialog, so `target` can swap mid-stream and
  // a suggestion for the old branch would otherwise land in a form that is now
  // renaming a different one. `cancel` is stable (a no-dep `useCallback` in
  // `useAiStream`), so this re-runs only on a target change. Closing cancels
  // here as well as in `closeDialog` — aborting twice is a no-op.
  const cancelGenerate = branchNameGen.cancel;
  useEffect(() => {
    if (target === null) return;
    return () => cancelGenerate();
  }, [target, cancelGenerate]);

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(o) => {
        if (!o) closeDialog();
      }}
    >
      <DialogContent>
        <form
          // min-w-0: DialogContent is display:grid, so this grid item must be
          // allowed to shrink below its content — otherwise a long branch name
          // pushes the form past the dialog's max-width and the text overflows.
          className="min-w-0 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            // Enter submits even while the submit button is disabled, so an
            // in-flight name generation has to be checked here too.
            if (branchNameGen.generating) return;
            renameForm.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename branch</DialogTitle>
            <DialogDescription>
              Renames{" "}
              <span className="font-mono wrap-break-word">{shownTarget}</span>.
            </DialogDescription>
          </DialogHeader>
          <renameForm.AppField
            name="name"
            validators={{
              onChange: ({ value }) =>
                required(value) ??
                (sanitizeRefName(value) === target ? "Unchanged" : undefined),
            }}
          >
            {(field) => (
              <field.TextField label="New name" warning={refNameWarning} />
            )}
          </renameForm.AppField>
          <GenerateBranchNameButton
            gen={guardedGen}
            aiEnabled={aiEnabled}
            aiConfigured={aiConfigured}
            hasChanges={hasChanges}
            headExists={headExists}
            entries={entries}
            recentBranches={allBranchNames}
            nameTarget={targetIsCurrent ? "checked-out-branch" : "other-branch"}
            committedFallback={shownCommittedFallback}
            committedStatus={shownCommittedStatus}
            // Renaming never picks a base — the fallback always applies here.
            basedElsewhere={null}
            onName={(name) => renameForm.setFieldValue("name", name)}
            onSetupAi={() => {
              closeDialog();
              onOpenSettings("ai");
            }}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDialog}>
              Cancel
            </Button>
            <renameForm.AppForm>
              <renameForm.SubmitButton disabled={branchNameGen.generating}>
                Rename
              </renameForm.SubmitButton>
            </renameForm.AppForm>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
