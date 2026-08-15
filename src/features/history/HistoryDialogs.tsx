import { formOptions } from "@tanstack/react-form";
import { type ReactNode, useId } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { required, withForm } from "@/lib/form";
import {
  useCherryPickOnto,
  useDeleteTag,
  useResetToCommit,
} from "@/lib/git/queries";
import { refNameWarning } from "@/lib/git/ref-name";
import { toastError } from "@/lib/toast";
import { useRetained } from "@/lib/use-retained";

const onError = (e: unknown) => toastError(e);

/** Confirm-and-delete a tag, optionally on origin too. Owns its mutation; the
 *  parent keeps the open + "delete on origin" state (reset on each open). */
export function DeleteTagDialog({
  repoPath,
  name,
  remote,
  onRemoteChange,
  onClose,
}: {
  repoPath: string;
  name: string | null;
  remote: boolean;
  onRemoteChange: (v: boolean) => void;
  onClose: () => void;
}) {
  const deleteTag = useDeleteTag(repoPath);
  const shownName = useRetained(name);
  return (
    <Dialog
      open={name !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete tag {shownName}?</DialogTitle>
          <DialogDescription>
            Removes the tag from this repository. The commit it points at is not
            affected.
          </DialogDescription>
        </DialogHeader>
        <label className="flex cursor-pointer items-center gap-2 text-xs">
          <Checkbox
            checked={remote}
            onCheckedChange={(v) => onRemoteChange(v === true)}
          />
          Also delete the tag on origin
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={deleteTag.isPending}
            onClick={() => {
              if (!name) return;
              deleteTag.mutate(
                { name, onRemote: remote },
                {
                  onSuccess: () => {
                    toast.success(
                      `Deleted tag ${name}${remote ? " (local and origin)" : ""}`,
                    );
                    onClose();
                  },
                  onError: (e) => {
                    onError(e);
                    onClose();
                  },
                },
              );
            }}
          >
            {deleteTag.isPending && <Spinner data-icon="inline-start" />}
            Delete tag
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Mixed-reset the current branch to a commit. Owns its mutation. */
export function ResetCommitDialog({
  repoPath,
  hash,
  onClose,
}: {
  repoPath: string;
  hash: string | null;
  onClose: () => void;
}) {
  const resetMutation = useResetToCommit(repoPath);
  const shownHash = useRetained(hash);
  return (
    <Dialog
      open={hash !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset to commit?</DialogTitle>
          <DialogDescription>
            Moves the current branch to {shownHash?.slice(0, 7)}. Changes from
            later commits stay in your working tree as uncommitted changes
            (mixed reset). Commits that were only on this branch will be
            orphaned.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={resetMutation.isPending}
            onClick={() => {
              if (!hash) return;
              resetMutation.mutate(hash, {
                onSuccess: () => {
                  toast.success(`Reset to ${hash.slice(0, 7)}`);
                  onClose();
                },
                onError: (e) => {
                  onError(e);
                  onClose();
                },
              });
            }}
          >
            Reset
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Copy one or more commits onto another branch (and switch to it). Owns its
 *  mutation + the run logic; the parent supplies the selected hashes, the
 *  destination-branch state, and the "done" callback that clears the selection. */
export function CherryPickOntoDialog({
  repoPath,
  hashes,
  branch,
  onBranchChange,
  branches,
  currentBranch,
  onClose,
  onDone,
}: {
  repoPath: string;
  hashes: string[] | null;
  branch: string;
  onBranchChange: (b: string) => void;
  branches: { name: string }[];
  currentBranch: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const cherryPickOnto = useCherryPickOnto(repoPath);
  const destId = useId();
  const shownHashes = useRetained(hashes);
  function run() {
    if (!hashes || !branch) return;
    const target = branch;
    cherryPickOnto.mutate(
      { hashes, targetBranch: target },
      {
        onSuccess: ({ applied, skipped }) => {
          if (applied === 0) {
            toast.info(
              `Nothing to copy onto ${target} — those changes are already there.`,
            );
          } else {
            const note = skipped > 0 ? ` (${skipped} already present)` : "";
            toast.success(
              `Copied ${applied} commit${applied === 1 ? "" : "s"} onto ${target}${note}`,
            );
          }
          onClose();
          onDone();
        },
        onError: (e) => {
          onError(e);
          onClose();
        },
      },
    );
  }
  return (
    <Dialog
      open={hashes !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cherry-pick to branch</DialogTitle>
          <DialogDescription>
            {shownHashes && shownHashes.length > 1
              ? `Copies these ${shownHashes.length} commits onto the chosen branch and switches to it. `
              : "Copies this commit onto the chosen branch and switches to it. "}
            They stay on {currentBranch ?? "this branch"} too. Commits already
            present are skipped; any failure rolls the batch back automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor={destId}>Destination branch</Label>
          <Select
            items={Object.fromEntries(branches.map((b) => [b.name, b.name]))}
            value={branch || null}
            onValueChange={(v) => v && onBranchChange(v)}
          >
            <SelectTrigger id={destId} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {branches.map((b) => (
                <SelectItem key={b.name} value={b.name}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={run} disabled={!branch || cherryPickOnto.isPending}>
            Cherry-pick
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Shared form shape so the parent's `useAppForm` and the `withForm` dialog
 *  agree — used for both "create branch" and "create tag" from a commit. */
export const createRefFromCommitFormOpts = formOptions({
  defaultValues: { name: "" },
});

/**
 * "Create branch from commit" / "Create tag" — one form dialog parameterized by
 * copy. The parent owns the form (it carries the create-branch / create-tag
 * submit + mutation) and the open state; this is the presentational shell.
 */
export const CreateRefFromCommitDialog = withForm({
  ...createRefFromCommitFormOpts,
  props: {
    open: false,
    onClose: () => {
      // Default no-op for type inference; callers always pass a real handler.
    },
    title: "",
    description: null as ReactNode,
    fieldLabel: "",
    placeholder: "",
    submitLabel: "",
  },
  render: function CreateRefFromCommitDialogRender({
    form,
    open,
    onClose,
    title,
    description,
    fieldLabel,
    placeholder,
    submitLabel,
  }) {
    return (
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o) onClose();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              form.handleSubmit();
            }}
          >
            <form.AppField
              name="name"
              validators={{ onChange: ({ value }) => required(value) }}
            >
              {(field) => (
                <field.TextField
                  label={fieldLabel}
                  placeholder={placeholder}
                  warning={refNameWarning}
                />
              )}
            </form.AppField>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <form.AppForm>
                <form.SubmitButton>{submitLabel}</form.SubmitButton>
              </form.AppForm>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    );
  },
});
