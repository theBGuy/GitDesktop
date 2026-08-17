import {
  ArrowLineUpIcon,
  CaretLeftIcon,
  CopyIcon,
  DotsThreeVerticalIcon,
  FolderOpenIcon,
  GitBranchIcon,
  LockSimpleIcon,
  LockSimpleOpenIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
  WrenchIcon,
} from "@phosphor-icons/react";
import type { MouseEvent } from "react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { copyText } from "@/lib/clipboard";
import { normPath } from "@/lib/git/path";
import {
  useAddUserWorktree,
  useBranches,
  useLockUserWorktree,
  useMoveUserWorktree,
  useRepairWorktrees,
  useRepoStatus,
  useUnlockUserWorktree,
  useUserWorktrees,
} from "@/lib/git/queries";
import type { UserWorktree } from "@/lib/git/worktree";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { useUiStore } from "@/lib/stores/ui";
import { useWorktreeRemovals } from "@/lib/stores/worktree-removal";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { DeleteWorktreeDialog } from "./DeleteWorktreeDialog";
import { PromoteWorktreeDialog } from "./PromoteWorktreeDialog";
import { useOpenWorktree } from "./useOpenRepoByPath";

/** Sets a hover title only when a Select item is actually clipped. Base UI pins
 *  the popup to the trigger width and clips `overflow-x`, and the inner item text
 *  is `whitespace-nowrap`, so the truncation lives on the ITEM element — measure
 *  `currentTarget`, not an inner span (a span-level check never fires). */
const clipTitle = (value: string) => (e: MouseEvent<HTMLElement>) => {
  const el = e.currentTarget;
  el.title = el.scrollWidth > el.clientWidth ? value : "";
};

/**
 * The user-facing Git worktree manager. Lists the repo's worktrees (agent-session
 * ones are filtered out by the backend), switches the active repo to one, removes
 * them safely, and creates new ones via an inline form. Opened from the repo ⋯
 * menu and the command palette.
 */
export function WorktreesDialog({
  repoPath,
  open,
  onOpenChange,
}: {
  repoPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [mode, setMode] = useState<"list" | "create">("list");

  // Always reset to the list when the dialog reopens.
  function handleOpenChange(next: boolean) {
    if (next) setMode("list");
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-xl">
        {mode === "create" ? (
          <CreateWorktree
            repoPath={repoPath}
            onCancel={() => setMode("list")}
            onCreated={() => setMode("list")}
          />
        ) : (
          <WorktreeList
            repoPath={repoPath}
            open={open}
            onAdd={() => setMode("create")}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ----------------------------------------------------------------- list mode

function WorktreeList({
  repoPath,
  open,
  onAdd,
  onClose,
}: {
  repoPath: string;
  open: boolean;
  onAdd: () => void;
  onClose: () => void;
}) {
  const worktrees = useUserWorktrees(repoPath, open);
  const openWorktree = useOpenWorktree();
  const unlock = useUnlockUserWorktree(repoPath);
  const repair = useRepairWorktrees(repoPath);
  const activeRepo = useUiStore((s) => s.repoPath);
  const activeNorm = activeRepo ? normPath(activeRepo) : "";

  const [highlight, setHighlight] = useState(-1);
  const [deleteTarget, setDeleteTarget] = useState<UserWorktree | null>(null);
  const [renameTarget, setRenameTarget] = useState<UserWorktree | null>(null);
  const [lockTarget, setLockTarget] = useState<UserWorktree | null>(null);
  const [promoteTarget, setPromoteTarget] = useState<UserWorktree | null>(null);

  const list = worktrees.data ?? [];
  const linkedCount = list.filter((w) => !w.isMain).length;
  // A row whose folder is being removed still lists (the removal can outlive
  // this dialog), but nothing may act on it until it settles.
  const removals = useWorktreeRemovals(repoPath);
  const removingPaths = new Set(removals.map((r) => r.path));

  const onKeyDown = listKeyboardNav({
    items: list,
    activeIndex: highlight,
    onActivate: (_w, to) => setHighlight(to),
    rowKey: (w) => w.path,
    rowAttr: "data-wt-path",
  });

  async function handleOpen(w: UserWorktree) {
    if (normPath(w.path) === activeNorm) return; // already here
    if (removingPaths.has(w.path)) return; // its folder is going away
    await openWorktree(w.path);
    onClose();
  }

  function handleUnlock(w: UserWorktree) {
    unlock.mutate(w.path, {
      onSuccess: () => toast.success("Worktree unlocked"),
      onError: toastError,
    });
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Worktrees</DialogTitle>
        <DialogDescription>
          Each worktree checks out a different branch into its own folder, so
          you can work on several at once without stashing or switching. Opening
          one makes it the active repository.
        </DialogDescription>
      </DialogHeader>

      {/* min-w-0: DialogContent is a grid; without it this grid item grows to
          fit a long worktree path instead of letting the rows truncate. */}
      <div className="min-w-0 border">
        <div
          role="listbox"
          aria-label="Worktrees"
          onKeyDown={onKeyDown}
          className="max-h-80 overflow-y-auto"
        >
          {worktrees.isPending ? (
            <div className="flex justify-center p-4">
              <Spinner />
            </div>
          ) : (
            list.map((w, i) => (
              <WorktreeRow
                key={w.path}
                worktree={w}
                highlighted={i === highlight}
                isCurrent={normPath(w.path) === activeNorm}
                isRemoving={removingPaths.has(w.path)}
                onFocus={() => setHighlight(i)}
                onOpen={() => handleOpen(w)}
                onRename={() => setRenameTarget(w)}
                onLock={() => setLockTarget(w)}
                onUnlock={() => handleUnlock(w)}
                onDelete={() => setDeleteTarget(w)}
                onPromote={() => setPromoteTarget(w)}
              />
            ))
          )}
        </div>
        {!worktrees.isPending && linkedCount === 0 && (
          <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">
            No additional worktrees yet. Add one to work on another branch in
            its own folder.
          </p>
        )}
      </div>

      <DialogFooter>
        {linkedCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground sm:mr-auto"
            disabled={repair.isPending}
            title="Re-link worktrees after moving or renaming the repository folder"
            onClick={() =>
              repair.mutate(undefined, {
                onSuccess: () => toast.success("Worktree links repaired"),
                onError: toastError,
              })
            }
          >
            {repair.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <WrenchIcon data-icon="inline-start" />
            )}
            Repair links
          </Button>
        )}
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
        <Button onClick={onAdd}>
          <PlusIcon data-icon="inline-start" />
          Add worktree
        </Button>
      </DialogFooter>

      <RenameWorktreeDialog
        key={renameTarget?.path ?? "no-rename"}
        repoPath={repoPath}
        worktree={renameTarget}
        onClose={() => setRenameTarget(null)}
      />

      <LockWorktreeDialog
        key={lockTarget?.path ?? "no-lock"}
        repoPath={repoPath}
        worktree={lockTarget}
        onClose={() => setLockTarget(null)}
      />

      <DeleteWorktreeDialog
        key={deleteTarget?.path ?? "none"}
        repoPath={repoPath}
        worktree={deleteTarget}
        onClose={() => setDeleteTarget(null)}
      />

      <PromoteWorktreeDialog
        key={promoteTarget?.path ?? "no-promote"}
        repoPath={repoPath}
        worktree={promoteTarget}
        onClose={() => setPromoteTarget(null)}
      />
    </>
  );
}

function WorktreeRow({
  worktree,
  highlighted,
  isCurrent,
  isRemoving,
  onFocus,
  onOpen,
  onRename,
  onLock,
  onUnlock,
  onDelete,
  onPromote,
}: {
  worktree: UserWorktree;
  highlighted: boolean;
  isCurrent: boolean;
  /** Its folder is being removed right now — every action on it is off. */
  isRemoving: boolean;
  onFocus: () => void;
  onOpen: () => void;
  onRename: () => void;
  onLock: () => void;
  onUnlock: () => void;
  onDelete: () => void;
  onPromote: () => void;
}) {
  const { path, branch, isMain, isDetached, isLocked, lockReason } = worktree;

  // A disabled menu item can't carry a tooltip, so its blocking reason rides the
  // label. A removal in progress outranks the other reasons — the worktree is on
  // its way out, whatever else is true of it.
  const itemLabel = (label: string, otherReason?: string) => {
    if (isRemoving) return `${label} (removal in progress)`;
    return otherReason ? `${label} (${otherReason})` : label;
  };
  const openTitle = isCurrent ? "Current worktree" : "Open this worktree";

  return (
    <div
      data-highlighted={highlighted || undefined}
      className={cn(
        "flex items-center gap-1 border-b last:border-b-0",
        isCurrent
          ? "bg-accent"
          : highlighted
            ? "bg-muted"
            : "hover:bg-muted/60",
      )}
    >
      <button
        type="button"
        role="option"
        aria-selected={highlighted}
        // Not `disabled`: the current row must stay focusable so arrow-key nav
        // can move through it. onOpen already no-ops on the current worktree
        // and on one being removed.
        aria-disabled={isCurrent || isRemoving || undefined}
        data-wt-path={path}
        onFocus={onFocus}
        onClick={onOpen}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left",
          (isCurrent || isRemoving) && "cursor-default",
        )}
        title={isRemoving ? "Removal in progress" : openTitle}
      >
        <GitBranchIcon
          weight={isCurrent ? "fill" : "regular"}
          className={cn(
            "size-3.5 shrink-0",
            isCurrent ? "text-primary" : "text-muted-foreground",
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate font-mono text-xs font-medium">
              {isDetached ? "detached HEAD" : branch || "—"}
            </span>
            <RowTags
              isMain={isMain}
              isCurrent={isCurrent}
              isDetached={isDetached}
              isLocked={isLocked}
              lockReason={lockReason}
              isRemoving={isRemoving}
            />
          </span>
          <span
            className="mt-0.5 block truncate text-[11px] text-muted-foreground"
            onMouseEnter={(e) => {
              const el = e.currentTarget;
              el.title = el.scrollWidth > el.clientWidth ? path : "";
            }}
          >
            {path}
          </span>
        </span>
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="mr-1 shrink-0"
              aria-label={`Actions for ${branch || path}`}
            />
          }
        >
          <DotsThreeVerticalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem disabled={isCurrent || isRemoving} onClick={onOpen}>
            <FolderOpenIcon />
            {itemLabel(isCurrent ? "Current worktree" : "Open worktree")}
          </DropdownMenuItem>
          {/* Copying a path acts on nothing, so a removal doesn't block it. */}
          <DropdownMenuItem onClick={() => copyText(path, "Path copied")}>
            <CopyIcon />
            Copy path
          </DropdownMenuItem>
          <DropdownMenuItem
            // git can't move the main worktree or a locked one, and moving the
            // one you're standing in risks a cwd lock + a stale active path —
            // rename it after switching away.
            disabled={isMain || isCurrent || isLocked || isRemoving}
            onClick={onRename}
          >
            <PencilSimpleIcon />
            {itemLabel("Rename…", isLocked ? "locked" : undefined)}
          </DropdownMenuItem>
          {!isMain &&
            (isLocked ? (
              <DropdownMenuItem disabled={isRemoving} onClick={onUnlock}>
                <LockSimpleOpenIcon />
                {itemLabel("Unlock")}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled={isRemoving} onClick={onLock}>
                <LockSimpleIcon />
                {itemLabel("Lock…")}
              </DropdownMenuItem>
            ))}
          {/* Promote moves this worktree's branch into the main workspace: it
              removes the worktree (a branch can't live in two) and checks the
              branch out in main. Only for a linked worktree that has a branch. */}
          {!isMain && !isDetached && (
            <DropdownMenuItem
              disabled={isLocked || isRemoving}
              onClick={onPromote}
            >
              <ArrowLineUpIcon />
              {itemLabel(
                "Promote to main workspace…",
                isLocked ? "locked" : undefined,
              )}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            variant="destructive"
            // Can't delete the main worktree, nor the one you're standing in
            // (it'd leave the app pointing at a removed folder) — switch away first.
            disabled={isMain || isCurrent || isRemoving}
            onClick={onDelete}
          >
            <TrashIcon />
            {itemLabel("Delete worktree…")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function RowTags({
  isMain,
  isCurrent,
  isDetached,
  isLocked,
  lockReason,
  isRemoving,
}: {
  isMain: boolean;
  isCurrent: boolean;
  isDetached: boolean;
  isLocked: boolean;
  lockReason: string;
  isRemoving: boolean;
}) {
  return (
    <>
      {/* First and in words: it's why every action on this row is off, and the
          repo banner behind this dialog is the only other place it shows. */}
      {isRemoving && (
        <Badge variant="outline" className="shrink-0">
          <Spinner aria-hidden data-icon="inline-start" />
          Removing…
        </Badge>
      )}
      {isMain && (
        <Badge variant="secondary" className="shrink-0">
          Main
        </Badge>
      )}
      {isCurrent && (
        <Badge variant="outline" className="shrink-0 text-primary">
          Current
        </Badge>
      )}
      {isDetached && (
        <Badge variant="outline" className="shrink-0">
          Detached
        </Badge>
      )}
      {isLocked && (
        <Badge
          variant="outline"
          className="shrink-0 text-warning"
          title={lockReason ? `Locked: ${lockReason}` : "Locked"}
        >
          <LockSimpleIcon data-icon="inline-start" />
          Locked
        </Badge>
      )}
    </>
  );
}

// --------------------------------------------------------------- rename worktree

export function RenameWorktreeDialog({
  repoPath,
  worktree,
  onClose,
}: {
  repoPath: string;
  worktree: UserWorktree | null;
  onClose: () => void;
}) {
  const move = useMoveUserWorktree(repoPath);
  const { parent, name: currentName } = splitPath(worktree?.path ?? "");
  const [name, setName] = useState(currentName);

  const trimmed = name.trim();
  const newPath = parent ? `${parent}/${trimmed}` : trimmed;
  const unchanged = !!worktree && normPath(newPath) === normPath(worktree.path);
  // A rename keeps the worktree in place, so block path separators (that'd be a
  // move into another folder) — keep this a simple in-place rename.
  const invalid = /[\\/]/.test(trimmed);

  function handleRename() {
    if (!worktree || !trimmed || unchanged || invalid) return;
    move.mutate(
      { from: worktree.path, to: newPath },
      {
        onSuccess: () => {
          toast.success(`Renamed to ${trimmed}`);
          onClose();
        },
        onError: toastError,
      },
    );
  }

  return (
    <Dialog open={worktree !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename worktree</DialogTitle>
          <DialogDescription>
            Renames the worktree folder in place. Its branch and commits are
            unchanged.
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid grid-cols-[auto_1fr] items-center gap-x-3 text-xs"
          onSubmit={(e) => {
            e.preventDefault();
            handleRename();
          }}
        >
          <label htmlFor="wt-rename" className="text-muted-foreground">
            Folder name
          </label>
          <Input
            id="wt-rename"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-7 font-mono"
            aria-invalid={invalid || undefined}
          />
          <span className="col-start-2 mt-1 block truncate font-mono text-[11px] text-muted-foreground">
            {invalid ? "Use a folder name, not a path." : newPath}
          </span>
        </form>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={move.isPending}>
            Cancel
          </Button>
          <Button
            disabled={!trimmed || unchanged || invalid || move.isPending}
            onClick={handleRename}
          >
            {move.isPending && <Spinner data-icon="inline-start" />}
            Rename
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ----------------------------------------------------------------- lock worktree

export function LockWorktreeDialog({
  repoPath,
  worktree,
  onClose,
}: {
  repoPath: string;
  worktree: UserWorktree | null;
  onClose: () => void;
}) {
  const lock = useLockUserWorktree(repoPath);
  const [reason, setReason] = useState("");

  function handleLock() {
    if (!worktree) return;
    lock.mutate(
      { path: worktree.path, reason: reason.trim() || undefined },
      {
        onSuccess: () => {
          toast.success("Worktree locked");
          onClose();
        },
        onError: toastError,
      },
    );
  }

  return (
    <Dialog open={worktree !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Lock worktree</DialogTitle>
          <DialogDescription>
            Locking stops this worktree from being pruned or renamed, and
            deleting it asks for a forced confirmation — useful for one on a
            removable or network drive. Add an optional note for why.
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid grid-cols-[auto_1fr] items-center gap-x-3 text-xs"
          onSubmit={(e) => {
            e.preventDefault();
            handleLock();
          }}
        >
          <label htmlFor="wt-lock-reason" className="text-muted-foreground">
            Reason
          </label>
          <Input
            id="wt-lock-reason"
            autoFocus
            autoComplete="off"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Optional — e.g. on a USB drive"
            className="h-7"
          />
        </form>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={lock.isPending}>
            Cancel
          </Button>
          <Button onClick={handleLock} disabled={lock.isPending}>
            {lock.isPending && <Spinner data-icon="inline-start" />}
            Lock
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- create mode

function CreateWorktree({
  repoPath,
  onCancel,
  onCreated,
}: {
  repoPath: string;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const worktrees = useUserWorktrees(repoPath);
  const branchesQuery = useBranches(repoPath);
  const status = useRepoStatus(repoPath);
  const add = useAddUserWorktree(repoPath);

  const list = worktrees.data ?? [];
  const mainPath = list.find((w) => w.isMain)?.path ?? repoPath;
  const checkedOut = new Set(
    list.map((w) => w.branch).filter((b): b is string => Boolean(b)),
  );
  // Hide the app-internal agent-session branches — they're never something a
  // user picks as a base or checks out into a manual worktree.
  const branches = (branchesQuery.data ?? []).filter(
    (b) => !b.name.startsWith("gd/session/"),
  );
  const available = branches.filter((b) => !checkedOut.has(b.name));
  const currentBranch = status.data?.branch.name ?? "";

  const [source, setSource] = useState<"new" | "existing">("new");
  const [newBranch, setNewBranch] = useState("");
  const [base, setBase] = useState(currentBranch || "HEAD");
  const [existing, setExisting] = useState("");
  const [path, setPath] = useState("");
  // Stop auto-deriving the path once the user edits it by hand.
  const [pathEdited, setPathEdited] = useState(false);

  const branch = source === "new" ? newBranch.trim() : existing;

  // Default the folder to a sibling of the main worktree, named for the branch,
  // until the user takes the path field over.
  const derivedPath = deriveSiblingPath(mainPath, branch);
  const effectivePath = pathEdited ? path : derivedPath;

  const missing =
    !branch || !effectivePath
      ? source === "new"
        ? "Enter a branch name and folder to continue."
        : "Pick a branch and folder to continue."
      : "";

  function handleCreate() {
    add.mutate(
      {
        path: effectivePath,
        branch,
        newBranch: source === "new",
        baseRef: source === "new" ? base : undefined,
      },
      {
        onSuccess: () => {
          toast.success(`Worktree created on ${branch}`);
          onCreated();
        },
        onError: toastError,
      },
    );
  }

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onCancel}
            aria-label="Back to worktrees"
          >
            <CaretLeftIcon />
          </Button>
          <DialogTitle>New worktree</DialogTitle>
        </div>
        <DialogDescription>
          Check out a branch into a new folder. The branch can't already be
          checked out in another worktree.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3">
        <RadioGroup
          value={source}
          onValueChange={(v) => setSource(v as "new" | "existing")}
          className="flex gap-4 text-xs"
        >
          <label className="flex cursor-pointer items-center gap-1.5">
            <Radio value="new" />
            New branch
          </label>
          <label className="flex cursor-pointer items-center gap-1.5">
            <Radio value="existing" />
            Existing branch
          </label>
        </RadioGroup>

        {source === "new" ? (
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-xs">
            <label htmlFor="wt-new-branch" className="text-muted-foreground">
              Branch name
            </label>
            <Input
              id="wt-new-branch"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
              placeholder="feature/login"
              className="h-7 font-mono"
            />
            <label htmlFor="wt-base" className="text-muted-foreground">
              Based on
            </label>
            <Select value={base} onValueChange={(v) => v && setBase(v)}>
              <SelectTrigger id="wt-base" size="sm" className="font-mono">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {currentBranch &&
                  !branches.some((b) => b.name === currentBranch) && (
                    <SelectItem
                      value={currentBranch}
                      onMouseEnter={clipTitle(currentBranch)}
                    >
                      {currentBranch}
                    </SelectItem>
                  )}
                {branches.map((b) => (
                  <SelectItem
                    key={b.name}
                    value={b.name}
                    onMouseEnter={clipTitle(b.name)}
                  >
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : (
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-xs">
            <label htmlFor="wt-existing" className="text-muted-foreground">
              Branch
            </label>
            {available.length === 0 ? (
              <p className="text-muted-foreground">
                Every branch is already checked out in a worktree.
              </p>
            ) : (
              <Select
                value={existing}
                onValueChange={(v) => v && setExisting(v)}
              >
                <SelectTrigger id="wt-existing" size="sm" className="font-mono">
                  <SelectValue placeholder="Select a branch" />
                </SelectTrigger>
                <SelectContent>
                  {available.map((b) => (
                    <SelectItem
                      key={b.name}
                      value={b.name}
                      onMouseEnter={clipTitle(b.name)}
                    >
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        )}

        <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 text-xs">
          <label htmlFor="wt-path" className="text-muted-foreground">
            Folder
          </label>
          <Input
            id="wt-path"
            autoComplete="off"
            spellCheck={false}
            value={effectivePath}
            onChange={(e) => {
              setPath(e.target.value);
              setPathEdited(true);
            }}
            placeholder="Path for the new worktree"
            className="h-7 font-mono"
          />
        </div>
      </div>

      <DialogFooter className="items-center">
        {missing && (
          <span className="mr-auto text-[11px] text-muted-foreground">
            {missing}
          </span>
        )}
        <Button variant="outline" onClick={onCancel} disabled={add.isPending}>
          Cancel
        </Button>
        <Button
          disabled={Boolean(missing) || add.isPending}
          onClick={handleCreate}
        >
          {add.isPending && <Spinner data-icon="inline-start" />}
          Create worktree
        </Button>
      </DialogFooter>
    </>
  );
}

/** Splits a path into its parent and last segment, tolerating both separators
 *  and a trailing slash. Parent is "" when there's no separator. */
function splitPath(p: string): { parent: string; name: string } {
  const base = p.replace(/[/\\]+$/, "");
  const i = Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"));
  return i >= 0
    ? { parent: base.slice(0, i), name: base.slice(i + 1) }
    : { parent: "", name: base };
}

/** A sibling folder of the main worktree named for the branch:
 *  `<parent>/<repo>-<branch>` (branch slashes flattened to dashes). */
function deriveSiblingPath(mainPath: string, branch: string): string {
  if (!mainPath) return "";
  const { parent, name } = splitPath(mainPath);
  const safe = branch.trim().replace(/[\\/]+/g, "-");
  if (!safe) return "";
  return parent ? `${parent}/${name}-${safe}` : `${name}-${safe}`;
}
