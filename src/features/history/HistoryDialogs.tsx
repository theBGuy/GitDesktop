import { formOptions } from "@tanstack/react-form";
import { type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { LabeledGroup } from "@/components/form/labeled-group";
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
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { PROMOTION_BLOCKS_CHECKOUT } from "@/features/repository/checkout-copy";
import { clipTitleFromText } from "@/lib/clip-title";
import { required, withForm } from "@/lib/form";
import type { CherryPickRangeResult } from "@/lib/git/api";
import {
  pendingWriteMatching,
  RELEASE_WRITES_FAMILY,
  type ReleaseWriteKind,
  releaseWriteTag,
  useCherryPick,
  useCherryPickOnto,
  useCommitParents,
  useDeleteLocalTag,
  useDeleteTagOnOrigin,
  usePendingRepoWrites,
  useResetToCommit,
  useRevertCommit,
} from "@/lib/git/queries";
import { refNameWarning } from "@/lib/git/ref-name";
import {
  ACT_PENDING_REASON,
  refuseWhileOffline,
  useOfflineHold,
} from "@/lib/offline-writes";
import { refuseIfSwitched } from "@/lib/stores/notifications";
import { promotionBlocksCheckout } from "@/lib/stores/worktree-removal";
import { isAppError } from "@/lib/tauri/invoke";
import { toastError, toastErrorWithNote } from "@/lib/toast";
import { useLatestRef } from "@/lib/use-latest-ref";
import { useRetained } from "@/lib/use-retained";
import {
  CHERRY_PICK_ALREADY_APPLIED,
  MERGE_PARENT_COPY,
  MERGE_PARENT_DESCRIPTION,
  type MergeParentOp,
  mergeParentPrompt,
} from "./commit-confirms";

const onError = (e: unknown) => toastError(e);

// The delete-tag, reset, cherry-pick and merge-parent dialogs below can be
// dismissed while their write runs, and an unkeyed host (one instance across
// repo switches) may reopen one on another subject or repo before the settle: a
// settle closes only while the dialog still shows its subject in the repo it
// fired in, both read off live props. A host that keys them by repo must scope
// its onClose/onDone to the open session or the live repo (as HistoryPanel
// does): the unmounted instance's props stop updating, so those reads freeze.
// Each of these takes `openedIn`, the repo its host opened it in, and refuses
// (closing) when answered after a switch. A selection clear has its own rule, at
// its site; the create-from-commit dialogs settle by open session in their host.

/** Confirm-and-delete a tag, optionally on origin too. Owns its mutation; the
 *  parent keeps the open + "delete on origin" state (reset on each open). */
export function DeleteTagDialog({
  repoPath,
  name,
  openedIn,
  remote,
  onRemoteChange,
  onClose,
}: {
  repoPath: string;
  name: string | null;
  openedIn: string | null;
  remote: boolean;
  onRemoteChange: (v: boolean) => void;
  onClose: () => void;
}) {
  const deleteLocalTag = useDeleteLocalTag(repoPath);
  const deleteTagOnOrigin = useDeleteTagOnOrigin(repoPath);
  // Offline holds only the origin arm; the local-only delete runs offline.
  const offlineHold = useOfflineHold();
  const shownName = useRetained(name);
  // The shown tag's own delete, from the cache: this dialog is reused across
  // tags, so another tag's delete never holds it. The retained name keeps the
  // hold through the close fade.
  const releaseWrites = usePendingRepoWrites(RELEASE_WRITES_FAMILY, repoPath);
  const deletingThis = (kind: ReleaseWriteKind) =>
    pendingWriteMatching(
      releaseWrites,
      kind,
      (v: unknown) => releaseWriteTag(v) === shownName,
    ) !== undefined;
  const pending =
    shownName !== null &&
    (deletingThis("delete-local-tag") || deletingThis("delete-origin-tag"));
  const liveName = useLatestRef(name);
  const liveRepo = useLatestRef(repoPath);
  async function run() {
    if (!name || !openedIn) return;
    if (refuseIfSwitched(openedIn, "nothing was deleted")) {
      onClose();
      return;
    }
    if (remote && refuseWhileOffline()) return;
    const startedFor = name;
    const startedIn = repoPath;
    const closeIfStillOpen = () => {
      if (liveRepo.current === startedIn && liveName.current === startedFor)
        onClose();
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
  openedIn,
  onClose,
}: {
  repoPath: string;
  hash: string | null;
  openedIn: string | null;
  onClose: () => void;
}) {
  const resetMutation = useResetToCommit(repoPath);
  const shownHash = useRetained(hash);
  const liveHash = useLatestRef(hash);
  const liveRepo = useLatestRef(repoPath);
  async function run() {
    if (!hash || !openedIn) return;
    if (refuseIfSwitched(openedIn, "nothing was reset")) {
      onClose();
      return;
    }
    if (promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return;
    }
    const startedFor = hash;
    const startedIn = repoPath;
    const closeIfStillOpen = () => {
      if (liveRepo.current === startedIn && liveHash.current === startedFor)
        onClose();
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

/** The mainline choice a merge commit's revert or pick asks for: its parents, read
 *  in `repo` (the one the dialog opened in), with Parent 1 pre-selected. The pick
 *  is keyed by commit AND `op` (what the choice is for), so every new subject
 *  starts on Parent 1 without a seed. A null `hash` asks nothing and holds nothing. */
function useMainlineChoice(repo: string, hash: string | null, op: string) {
  const parents = useCommitParents(repo, hash);
  const [picked, setPicked] = useState<{
    hash: string;
    op: string;
    mainline: number;
  } | null>(null);
  const mainline =
    picked !== null && picked.hash === hash && picked.op === op
      ? picked.mainline
      : 1;
  const heldReason = (() => {
    switch (true) {
      case hash === null:
        return undefined;
      case parents.isPending:
        return "Reading this commit's parents…";
      case parents.isError:
        return "Couldn't read this commit's parents.";
      default:
        return undefined;
    }
  })();
  return {
    parents,
    mainline,
    heldReason,
    pick: (n: number) => {
      if (hash !== null) setPicked({ hash, op, mainline: n });
    },
    reset: () => setPicked(null),
  };
}

/** The parent-radio section both merge-commit dialogs render: two skeleton rows
 *  while the parents load, one row per parent after (octopus merges included).
 *  `ariaLabel` names the radio group only where no captioned group wraps it, so
 *  a reader never hears two nested groups with one name. */
function MainlineParentList({
  choice,
  ariaLabel,
}: {
  choice: ReturnType<typeof useMainlineChoice>;
  ariaLabel?: string;
}) {
  const { parents, mainline, pick } = choice;
  switch (true) {
    case parents.isPending:
      return (
        <>
          <span role="status" className="sr-only">
            Loading parents…
          </span>
          <div aria-busy className="flex flex-col gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
          </div>
        </>
      );
    case parents.isError:
      return (
        <p className="text-xs text-muted-foreground">
          Couldn't read this commit's parents.
        </p>
      );
    default:
      return (
        <RadioGroup
          aria-label={ariaLabel}
          value={String(mainline)}
          onValueChange={(v) => {
            // Base UI types the group's value as `any`.
            if (typeof v === "string") pick(Number(v));
          }}
        >
          {(parents.data ?? []).map((p, i) => (
            <label
              key={p.hash}
              className="flex min-w-0 cursor-pointer items-center gap-2 text-xs"
            >
              <Radio value={String(i + 1)} />
              <span className="shrink-0">
                Parent {i + 1} ·{" "}
                <span className="font-mono">{p.hash.slice(0, 7)}</span> —
              </span>
              <span
                className="min-w-0 truncate"
                onMouseEnter={clipTitleFromText}
              >
                {p.subject}
              </span>
            </label>
          ))}
        </RadioGroup>
      );
  }
}

/** Copy one or more commits onto another branch (and switch to it). Owns its
 *  mutation + the run logic; the parent supplies the selected hashes, the
 *  destination-branch state, and the "done" callback that clears the selection. */
export function CherryPickOntoDialog({
  repoPath,
  hashes,
  isMerge,
  openedIn,
  branch,
  onBranchChange,
  branches,
  currentBranch,
  onClose,
  onDone,
}: {
  repoPath: string;
  hashes: string[] | null;
  /** Whether a LONE commit in `hashes` is a merge, which asks for its mainline;
   *  a batch never does (the backend refuses a batch holding a merge). */
  isMerge: boolean;
  openedIn: string | null;
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
  const shownIsMerge = useRetained(isMerge, hashes !== null);
  const shownIn = useRetained(openedIn);
  const count = shownHashes?.length ?? 0;
  const mergeHash =
    count === 1 && shownIsMerge ? (shownHashes?.[0] ?? null) : null;
  const choice = useMainlineChoice(shownIn ?? repoPath, mergeHash, "pick-onto");
  const liveHashes = useLatestRef(hashes);
  const liveRepo = useLatestRef(repoPath);

  function close() {
    choice.reset();
    onClose();
  }

  async function run() {
    if (!hashes || !branch || !openedIn) return;
    if (refuseIfSwitched(openedIn, "nothing was cherry-picked")) {
      close();
      return;
    }
    // It switches to the destination branch, so it moves HEAD.
    if (promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return;
    }
    // Compared by value: the host hands a fresh array on every open.
    const startedFor = hashes.join();
    const startedIn = repoPath;
    const stillOpen = () =>
      liveRepo.current === startedIn &&
      liveHashes.current?.join() === startedFor;
    const target = branch;
    // Sent only when the parent section rendered: a lone merge commit.
    const mainline =
      hashes.length === 1 && isMerge ? choice.mainline : undefined;
    let result: CherryPickRangeResult;
    try {
      result = await cherryPickOnto.mutateAsync({
        hashes,
        targetBranch: target,
        mainline,
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
      if (stillOpen()) close();
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
    // Another repo's dialog and selection are never this pick's to clear (a
    // repo-keyed host scopes its own callbacks; see the header comment).
    if (liveRepo.current !== startedIn) return;
    // The pick moved HEAD to the destination, so the source selection no longer
    // describes the view — a dismissed dialog's included. Only a pick reopened on
    // ANOTHER selection is a new session: neither it nor that selection is ours.
    const live = liveHashes.current;
    if (live !== null && live.join() !== startedFor) return;
    close();
    onDone();
  }

  const heldReason = (() => {
    switch (true) {
      case cherryPickOnto.isPending:
        return ACT_PENDING_REASON;
      case !branch:
        return "Choose a destination branch first.";
      default:
        return choice.heldReason;
    }
  })();

  return (
    <Dialog
      open={hashes !== null}
      onOpenChange={(open) => {
        if (!open) close();
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
        {mergeHash !== null && (
          <LabeledGroup label="Mainline parent" className="min-w-0">
            <p className="text-xs text-muted-foreground">
              {MERGE_PARENT_DESCRIPTION}
            </p>
            <MainlineParentList choice={choice} />
          </LabeledGroup>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <DisabledReasonButton
            disabled={heldReason !== undefined}
            reason={heldReason}
            onClick={() => void run()}
          >
            Cherry-pick
          </DisabledReasonButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What a host opens {@link MergeParentDialog} on. `alreadyApplied` is a host's
 *  own wording for a pick with nothing to apply, given only where it differs from
 *  the default {@link CHERRY_PICK_ALREADY_APPLIED}. */
export type MergePickTarget = {
  hash: string;
  op: MergeParentOp;
  alreadyApplied?: string;
};

/** Revert or cherry-pick a MERGE commit, choosing which parent counts as the
 *  mainline (git's `-m`). Owns its mutations and the parents read; hosts route
 *  merge commits here and every other commit to the plain confirm. */
export function MergeParentDialog({
  repoPath,
  target,
  openedIn,
  onClose,
}: {
  repoPath: string;
  target: MergePickTarget | null;
  openedIn: string | null;
  onClose: () => void;
}) {
  const revertCommit = useRevertCommit(repoPath);
  const cherryPick = useCherryPick(repoPath);
  const pending = revertCommit.isPending || cherryPick.isPending;
  const shown = useRetained(target);
  const shownIn = useRetained(openedIn);
  const choice = useMainlineChoice(
    shownIn ?? repoPath,
    shown?.hash ?? null,
    shown?.op ?? "revert",
  );
  const { mainline } = choice;
  const liveTarget = useLatestRef(target);
  const liveRepo = useLatestRef(repoPath);
  const copy = MERGE_PARENT_COPY[shown?.op ?? "revert"];
  const prompt = mergeParentPrompt(shown?.op ?? "revert", shown?.hash ?? "");

  function close() {
    choice.reset();
    onClose();
  }

  async function run() {
    if (!target || !openedIn) return;
    if (refuseIfSwitched(openedIn, MERGE_PARENT_COPY[target.op].nothingDone)) {
      close();
      return;
    }
    if (promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return;
    }
    const { hash, op, alreadyApplied = CHERRY_PICK_ALREADY_APPLIED } = target;
    const startedIn = repoPath;
    // Same repo, commit AND op: a settling revert never closes a cherry-pick
    // dialog reopened on the same commit.
    const closeIfStillOpen = () => {
      const live = liveTarget.current;
      if (
        liveRepo.current === startedIn &&
        live?.hash === hash &&
        live.op === op
      )
        close();
    };
    try {
      if (op === "revert") {
        await revertCommit.mutateAsync({ hash, mainline });
      } else if (await cherryPick.mutateAsync({ hash, mainline })) {
        toast.success(`Cherry-picked ${hash.slice(0, 7)}`);
      } else {
        toast.info(alreadyApplied);
      }
    } catch (e) {
      onError(e);
      closeIfStillOpen();
      return;
    }
    closeIfStillOpen();
  }

  const heldReason = pending ? ACT_PENDING_REASON : choice.heldReason;

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{prompt.title}</DialogTitle>
          <DialogDescription>{prompt.body}</DialogDescription>
        </DialogHeader>
        <div className="min-w-0">
          <MainlineParentList choice={choice} ariaLabel="Mainline parent" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <DisabledReasonButton
            disabled={heldReason !== undefined}
            reason={heldReason}
            onClick={() => void run()}
          >
            {pending && <Spinner data-icon="inline-start" />}
            {copy.confirmLabel}
          </DisabledReasonButton>
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
