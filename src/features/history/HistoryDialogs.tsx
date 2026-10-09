import { formOptions } from "@tanstack/react-form";
import { type ReactNode, useId } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { SelectClipText } from "@/components/select-clip-text";
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
import { PROMOTION_BLOCKS_CHECKOUT } from "@/features/repository/checkout-copy";
import { clipTitleFromText } from "@/lib/clip-title";
import { required, withForm } from "@/lib/form";
import type { CherryPickRangeResult } from "@/lib/git/api";
import {
  useCherryPickOnto,
  useDeleteLocalTag,
  useDeleteTagOnOrigin,
  useResetToCommit,
} from "@/lib/git/queries";
import { refNameWarning } from "@/lib/git/ref-name";
import {
  ACT_PENDING_REASON,
  refuseWhileOffline,
  useOfflineHold,
} from "@/lib/offline-writes";
import { promotionBlocksCheckout } from "@/lib/stores/worktree-removal";
import { isAppError } from "@/lib/tauri/invoke";
import { toastError, toastErrorWithNote } from "@/lib/toast";
import { useLatestRef } from "@/lib/use-latest-ref";
import { useRetained } from "@/lib/use-retained";

const onError = (e: unknown) => toastError(e);

// The write dialogs below can be dismissed while their write runs, and the host
// may reopen one on another subject before the settle: a settle closes only
// while the dialog still shows the subject it was fired on, read off the live
// prop. A selection clear has its own rule, at its site.

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
  const deleteLocalTag = useDeleteLocalTag(repoPath);
  const deleteTagOnOrigin = useDeleteTagOnOrigin(repoPath);
  const pending = deleteLocalTag.isPending || deleteTagOnOrigin.isPending;
  // Offline holds only the origin arm; the local-only delete runs offline.
  const offlineHold = useOfflineHold();
  const shownName = useRetained(name);
  const liveName = useLatestRef(name);
  async function run() {
    if (!name) return;
    if (remote && refuseWhileOffline()) return;
    const startedFor = name;
    const closeIfStillOpen = () => {
      if (liveName.current === startedFor) onClose();
    };
    try {
      await (remote ? deleteTagOnOrigin : deleteLocalTag).mutateAsync(name);
    } catch (e) {
      onError(e);
      closeIfStillOpen();
      return;
    }
    toast.success(`Deleted tag ${name}${remote ? " (local and origin)" : ""}`);
    closeIfStillOpen();
  }
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
          <DisabledReasonButton
            variant="destructive"
            disabled={pending || (remote && !!offlineHold)}
            reason={(() => {
              switch (true) {
                case pending:
                  return ACT_PENDING_REASON;
                case remote:
                  return offlineHold;
                default:
                  return undefined;
              }
            })()}
            onClick={() => void run()}
          >
            {pending && <Spinner data-icon="inline-start" />}
            Delete tag
          </DisabledReasonButton>
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
  const liveHash = useLatestRef(hash);
  async function run() {
    if (!hash) return;
    if (promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return;
    }
    const startedFor = hash;
    const closeIfStillOpen = () => {
      if (liveHash.current === startedFor) onClose();
    };
    try {
      await resetMutation.mutateAsync(hash);
    } catch (e) {
      onError(e);
      closeIfStillOpen();
      return;
    }
    toast.success(`Reset to ${hash.slice(0, 7)}`);
    closeIfStillOpen();
  }
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
            onClick={() => void run()}
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
  const count = shownHashes?.length ?? 0;
  const liveHashes = useLatestRef(hashes);
  async function run() {
    if (!hashes || !branch) return;
    // It switches to the destination branch, so it moves HEAD.
    if (promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return;
    }
    // Compared by value: the host hands a fresh array on every open.
    const startedFor = hashes.join();
    const stillOpen = () => liveHashes.current?.join() === startedFor;
    const target = branch;
    let result: CherryPickRangeResult;
    try {
      result = await cherryPickOnto.mutateAsync({
        hashes,
        targetBranch: target,
      });
    } catch (e) {
      // A paused pick leaves you on the destination branch and closes this
      // dialog, so the toast is the only place left that can say where you
      // are; the generic summary names the operation, never the branch.
      if (isAppError(e) && e.kind === "conflict") {
        toastErrorWithNote(
          e,
          `You're now on ${target} — resolve the conflicts there, then continue the cherry-pick.`,
        );
      } else {
        onError(e);
      }
      if (stillOpen()) onClose();
      return;
    }
    const { applied, skipped } = result;
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
    // The pick moved HEAD to the destination, so the source selection no longer
    // describes the view — a dismissed dialog's included. Only a pick reopened on
    // ANOTHER selection is a new session: neither it nor that selection is ours.
    const live = liveHashes.current;
    if (live !== null && live.join() !== startedFor) return;
    onClose();
    onDone();
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
            {count > 1 ? (
              <>
                Copies these {count} commits onto the chosen branch and switches
                to it. They stay on {currentBranch ?? "this branch"} too.
                Commits already present are skipped; any failure rolls the whole
                batch back automatically.
              </>
            ) : (
              <>
                Copies this commit onto the chosen branch and switches to it. It
                stays on {currentBranch ?? "this branch"} too. If the
                destination already has it, it's skipped; a conflict pauses the
                cherry-pick on the destination branch, where you can resolve it
                and continue; any other failure rolls it back automatically.
              </>
            )}
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
              <SelectValue onMouseEnter={clipTitleFromText} />
            </SelectTrigger>
            <SelectContent>
              {branches.map((b) => (
                <SelectItem key={b.name} value={b.name}>
                  <SelectClipText>{b.name}</SelectClipText>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void run()}
            disabled={!branch || cherryPickOnto.isPending}
          >
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
