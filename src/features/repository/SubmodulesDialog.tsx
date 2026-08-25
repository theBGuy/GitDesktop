import {
  ArrowsClockwiseIcon,
  CaretLeftIcon,
  DotsThreeVerticalIcon,
  FolderOpenIcon,
  GitBranchIcon,
  LinkIcon,
  PlusIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import type { ComponentProps } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { nameFromUrl } from "@/features/welcome/clone-utils";
import { clipTitle } from "@/lib/clip-title";
import { validateRepo } from "@/lib/git/api";
import {
  useAddSubmodule,
  useRemoveSubmodule,
  useSetSubmoduleBranch,
  useSetSubmoduleUrl,
  useSubmodules,
  useUpdateSubmodule,
} from "@/lib/git/queries";
import type { Submodule } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { useConfirm } from "@/lib/stores/confirm";
import { isAppError } from "@/lib/tauri/invoke";
import { toastError } from "@/lib/toast";
import { useLatestRef } from "@/lib/use-latest-ref";
import { cn } from "@/lib/utils";
import { useOpenRepoByPath } from "./useOpenRepoByPath";

/** "Modified" carries the warning tokens so it can't be mistaken for the
 *  identically-weighted "Up to date" at a glance; the labels differ too, so the
 *  colour is emphasis rather than the meaning. */
const STATUS: Record<
  string,
  {
    label: string;
    variant: "secondary" | "outline" | "destructive";
    className?: string;
  }
> = {
  ok: { label: "Up to date", variant: "secondary" },
  uninitialized: { label: "Not initialized", variant: "outline" },
  modified: {
    label: "Modified",
    variant: "outline",
    className: "border-warning/40 bg-warning/10 text-warning",
  },
  conflict: { label: "Conflict", variant: "destructive" },
};

/** The `acting` value for the whole-repo actions — no submodule path is empty. */
const ALL = "";

const BUSY_REASON = "An operation is in progress";

const ADDING_REASON = "Adding the submodule…";

/** A gitlink with no `.gitmodules` entry has no URL to edit and nowhere to
 *  record a branch, so both edits would fail in git. */
const NO_ENTRY_REASON = "no .gitmodules entry";

/** The submodule's folder on disk. Its path is repo-root-relative with forward
 *  slashes, which Windows accepts mixed with the repo path's backslashes. */
const submodulePath = (repoPath: string, sub: string) =>
  `${repoPath.replace(/[/\\]+$/, "")}/${sub}`;

/**
 * The submodule manager: lists what the parent repo references, updates them to
 * the recorded commit or to their tracked branch's tip, adds and removes them,
 * edits URL and branch, and opens one as its own repository. Every mutation
 * stages its change for the user to commit.
 */
export function SubmodulesDialog({
  repoPath,
  open,
  onOpenChange,
  onModeChange,
  initialMode = "list",
}: {
  repoPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Every mode change, so the caller's `initialMode` tracks what's on screen —
   *  without it a re-request of the mode already asked for lands as a no-op. */
  onModeChange: (mode: "list" | "add") => void;
  /** Which body an open lands on — the palette's "Add submodule" opens the form. */
  initialMode?: "list" | "add";
}) {
  const [mode, setMode] = useState<"list" | "add">(initialMode);
  // Owned here, not in the form: the flag has to outlive AddSubmodule so the Esc
  // arm below and the form's own exit affordances read one truth, including
  // across a close and reopen while the clone is still running.
  const add = useAddSubmodule(repoPath);

  // Re-seed on every open, and when the caller re-requests a mode while already
  // open (the add action fired from the palette over an open list). Layout
  // effect, so a reopen never paints one frame of the mode it closed on.
  useLayoutEffect(() => {
    if (open) setMode(initialMode);
  }, [open, initialMode]);

  // Read `open` through a ref: an add whose clone outlives the close still runs
  // its continuation, holding the props from before it — propagating the mode
  // then would set the caller's state and pop the closed dialog back open. The
  // stale local `mode` needs no repair; the re-seed above owns it on next open.
  const openRef = useLatestRef(open);
  function changeMode(next: "list" | "add") {
    if (!openRef.current) return;
    setMode(next);
    onModeChange(next);
  }

  const handleOpenChange: NonNullable<
    ComponentProps<typeof Dialog>["onOpenChange"]
  > = (next, details) => {
    // Esc in the add form backs out to the list rather than closing the manager
    // — but not mid-clone, where every other exit affordance is disabled and
    // leaving the form for a sibling one would strand the running add. Escape
    // then closes the whole manager, which the openRef guard already handles.
    if (
      !next &&
      mode === "add" &&
      !add.isPending &&
      details.reason === "escape-key"
    ) {
      details.cancel();
      changeMode("list");
      return;
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {mode === "add" ? (
          <AddSubmodule
            add={add}
            onCancel={() => changeMode("list")}
            onAdded={() => changeMode("list")}
          />
        ) : (
          <SubmoduleList
            repoPath={repoPath}
            onAdd={() => changeMode("add")}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** List mode: every submodule as a row, its actions on an always-visible kebab. */
function SubmoduleList({
  repoPath,
  onAdd,
  onClose,
}: {
  repoPath: string;
  onAdd: () => void;
  onClose: () => void;
}) {
  const subs = useSubmodules(repoPath);
  const update = useUpdateSubmodule(repoPath);
  const remove = useRemoveSubmodule(repoPath);
  const openByPath = useOpenRepoByPath();
  const list = subs.data ?? [];

  const [activeIndex, setActiveIndex] = useState(-1);
  const [urlTarget, setUrlTarget] = useState<Submodule | null>(null);
  const [branchTarget, setBranchTarget] = useState<Submodule | null>(null);
  // Which row a mutation is running against, so the spinner rides the acting
  // control instead of every row at once; non-null also means "everything else
  // is off while it runs".
  const [acting, setActing] = useState<string | null>(null);
  const busy = acting !== null;

  // Refetching may shrink `list` while `activeIndex` lingers, so clamp the
  // stale value (keeping -1 = "nothing active yet") rather than highlight a row
  // that no longer exists.
  const safeActive = activeIndex >= list.length ? list.length - 1 : activeIndex;

  const onKeyDown = listKeyboardNav<(typeof list)[number]>({
    items: list,
    activeIndex: safeActive,
    onActivate: (_s, to) => setActiveIndex(to),
    rowKey: (s) => s.path,
    rowAttr: "data-sub-row",
  });

  // Awaited, not per-call callbacks: react-query drops those when the dialog
  // unmounts mid-flight, so the outcome would never reach the user.
  async function handleUpdate(path?: string, remote = false) {
    setActing(path ?? ALL);
    try {
      await update.mutateAsync({ path, remote });
      if (remote) {
        toast.success(
          path ? `${path} updated to latest` : "Submodules updated to latest",
          { description: "Review and stage the bump in Changes." },
        );
      } else {
        toast.success(path ? `Updated ${path}` : "Submodules updated");
      }
    } catch (e) {
      toastError(e);
    } finally {
      setActing(null);
    }
  }

  async function handleRemove(s: Submodule) {
    const first = await useConfirm.getState().askChecked({
      title: `Remove ${s.path}?`,
      body: "The removal is staged for you to commit. Its cached repository data under .git/modules is kept, so the submodule can be restored, unless you delete it here.",
      confirmLabel: "Remove",
      confirmVariant: "destructive",
      checkboxLabel: "Also delete cached repository data",
    });
    if (!first.ok) return;

    setActing(s.path);
    try {
      let outcome = await remove.mutateAsync({
        path: s.path,
        force: false,
        deleteModuleData: first.checked,
      });
      if (outcome.refusedDirty) {
        // Nothing was mutated — escalate rather than report a failure. The
        // refusal is one bool covering both a dirty worktree and a checkout
        // that has moved off the recorded commit, so the copy names both.
        const forced = await useConfirm.getState().ask({
          title: `Remove ${s.path}?`,
          body: `${s.path} has local changes or is at a different commit than this repository records. Discard that state and remove?`,
          confirmLabel: "Discard and remove",
          confirmVariant: "destructive",
        });
        if (!forced) return;
        outcome = await remove.mutateAsync({
          path: s.path,
          force: true,
          deleteModuleData: first.checked,
        });
        if (outcome.refusedDirty) {
          toast.error(`${s.path} wasn't removed.`);
          return;
        }
      }
      // The removal is staged either way; only the cached-data half can fail.
      if (outcome.moduleDataError) {
        toast.warning("Submodule removed — staged for you to commit.", {
          description: `Its cached repository data was not deleted: ${outcome.moduleDataError}`,
          duration: 10_000,
        });
      } else if (outcome.moduleDataDeleted) {
        toast.success(
          "Submodule removed, cached data deleted — staged for you to commit.",
        );
      } else {
        toast.success("Submodule removed — staged for you to commit.");
      }
    } catch (e) {
      toastError(e);
    } finally {
      setActing(null);
    }
  }

  async function handleOpenAsRepo(s: Submodule) {
    const full = submodulePath(repoPath, s.path);
    // useOpenRepoByPath reports its own failures as a toast and resolves the
    // same either way, so probe first — closing the manager on a failed open
    // would hide the toast's context behind a dismissed dialog.
    try {
      await validateRepo(full);
    } catch (e) {
      if (isAppError(e) && e.kind === "notARepo") {
        toast.error(`${s.path} is not a git repository.`);
      } else {
        toastError(e);
      }
      return;
    }
    // A submodule is an independent repository that nothing else in the app can
    // reach, so it earns a recents row like any other opened repo.
    await openByPath(full, "picker");
    onClose();
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Submodules</DialogTitle>
        <DialogDescription>
          Initialize and update the submodules this repository references to the
          commit it records, or move one to the tip of the branch it tracks.
          Updating fetches over the network; adding, removing, and editing stage
          the change for you to commit.
        </DialogDescription>
      </DialogHeader>

      {/* min-w-0: DialogContent is a grid; without it this item grows to fit a
          long URL instead of letting the rows truncate. */}
      <div className="min-w-0 border">
        <div
          role="listbox"
          aria-label="Submodules"
          onKeyDown={onKeyDown}
          className="max-h-96 overflow-y-auto"
        >
          {subs.isPending ? (
            <div className="flex justify-center p-4">
              <Spinner />
            </div>
          ) : (
            list.map((s, i) => (
              <SubmoduleRow
                key={s.path}
                submodule={s}
                highlighted={i === safeActive}
                acting={acting === s.path}
                busy={busy}
                onFocus={() => setActiveIndex(i)}
                onUpdate={() => handleUpdate(s.path)}
                onUpdateRemote={() => handleUpdate(s.path, true)}
                onEditUrl={() => setUrlTarget(s)}
                onSetBranch={() => setBranchTarget(s)}
                onOpenAsRepo={() => handleOpenAsRepo(s)}
                onRemove={() => handleRemove(s)}
              />
            ))
          )}
        </div>
        {/* No border-t: with no rows above it there is nothing to separate, and
            the container's own border would double up against it. */}
        {!subs.isPending && list.length === 0 && (
          <div className="space-y-2 p-3">
            <p className="text-[11px] text-muted-foreground">
              This repository has no submodules.
            </p>
            <Button variant="outline" size="xs" onClick={onAdd}>
              <PlusIcon data-icon="inline-start" />
              Add submodule
            </Button>
          </div>
        )}
      </div>

      <DialogFooter className="items-center">
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground sm:mr-auto"
          onClick={onAdd}
        >
          <PlusIcon data-icon="inline-start" />
          Add submodule…
        </Button>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
        <DisabledReasonButton
          disabled={busy || list.length === 0}
          reason={list.length === 0 ? "No submodules to update" : BUSY_REASON}
          onClick={() => handleUpdate()}
        >
          {acting === ALL && <Spinner data-icon="inline-start" />}
          Update all
        </DisabledReasonButton>
        {/* Hidden rather than disabled while the repo has no submodules — its
            one item would have nothing to act on. */}
        {list.length > 0 && (
          <DropdownMenu>
            {/* The reason must survive keyboard reach, so it rides the button
                rather than a titled span around the trigger. */}
            <DropdownMenuTrigger
              render={
                <DisabledReasonButton
                  variant="outline"
                  size="icon-sm"
                  disabled={busy}
                  reason={BUSY_REASON}
                  aria-label="More submodule actions"
                />
              }
            >
              <DotsThreeVerticalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => handleUpdate(undefined, true)}>
                <ArrowsClockwiseIcon />
                Update all to latest
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </DialogFooter>

      <EditSubmoduleUrlDialog
        key={urlTarget?.path ?? "no-url"}
        repoPath={repoPath}
        submodule={urlTarget}
        onClose={() => setUrlTarget(null)}
      />

      <SetSubmoduleBranchDialog
        key={branchTarget?.path ?? "no-branch"}
        repoPath={repoPath}
        submodule={branchTarget}
        onClose={() => setBranchTarget(null)}
      />
    </>
  );
}

function SubmoduleRow({
  submodule,
  highlighted,
  acting,
  busy,
  onFocus,
  onUpdate,
  onUpdateRemote,
  onEditUrl,
  onSetBranch,
  onOpenAsRepo,
  onRemove,
}: {
  submodule: Submodule;
  highlighted: boolean;
  /** This row is the one a mutation is running against. */
  acting: boolean;
  /** Some mutation is running — every row's actions are off until it settles. */
  busy: boolean;
  onFocus: () => void;
  onUpdate: () => void;
  onUpdateRemote: () => void;
  onEditUrl: () => void;
  onSetBranch: () => void;
  onOpenAsRepo: () => void;
  onRemove: () => void;
}) {
  const { path, sha, describe, url, status } = submodule;
  const meta = STATUS[status] ?? { label: status, variant: "outline" as const };
  const action = status === "uninitialized" ? "Initialize" : "Update";
  const uninitialized = status === "uninitialized";
  // `describe` falls back to a bare sha prefix on untagged checkouts — showing
  // it beside the sha would read "553c207 · 553c207".
  const detail = [sha.slice(0, 7), sha.startsWith(describe) ? "" : describe]
    .filter(Boolean)
    .join(" · ");
  // A disabled menu item can't carry a tooltip, so its reason rides the label.
  const itemLabel = (label: string, reason?: string) =>
    reason ? `${label} (${reason})` : label;

  return (
    <div
      className={cn(
        "flex items-center gap-1 border-b last:border-b-0",
        highlighted ? "bg-muted" : "hover:bg-muted/60",
      )}
    >
      <button
        type="button"
        role="option"
        aria-selected={highlighted}
        // Not `disabled`: the row must stay focusable so arrow-key nav can move
        // through it while a mutation runs. onClick already refuses.
        aria-disabled={busy || undefined}
        data-sub-row={path}
        onFocus={onFocus}
        onClick={() => !busy && onUpdate()}
        title={busy ? BUSY_REASON : `${action} ${path}`}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left",
          busy && "cursor-default",
        )}
      >
        {/* The URL takes its own full-width line — sharing one with the commit
            clipped it on sight. Snug leading keeps the three lines one unit,
            and the line is dropped entirely when there is no URL. */}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-xs font-medium">
            {path}
          </span>
          <span
            className="mt-0.5 block truncate text-[11px] leading-snug text-muted-foreground"
            onMouseEnter={clipTitle(detail)}
          >
            {detail}
          </span>
          {url && (
            <span
              className="block truncate text-[11px] leading-snug text-muted-foreground"
              onMouseEnter={clipTitle(url)}
            >
              {url}
            </span>
          )}
        </span>
        <Badge variant={meta.variant} className={meta.className}>
          {meta.label}
        </Badge>
      </button>

      <DisabledReasonButton
        variant="outline"
        size="xs"
        disabled={busy}
        reason={BUSY_REASON}
        onClick={onUpdate}
      >
        {acting && <Spinner data-icon="inline-start" />}
        {action}
      </DisabledReasonButton>

      <DropdownMenu>
        {/* The reason must survive keyboard reach, so it rides the button
            rather than a titled span around the trigger. */}
        <DropdownMenuTrigger
          render={
            <DisabledReasonButton
              variant="ghost"
              size="icon-sm"
              wrapperClassName="mr-1"
              disabled={busy}
              reason={BUSY_REASON}
              aria-label={`Actions for ${path}`}
            />
          }
        >
          <DotsThreeVerticalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem onClick={onUpdateRemote}>
            <ArrowsClockwiseIcon />
            Update to latest
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!url} onClick={onEditUrl}>
            <LinkIcon />
            {itemLabel("Edit URL…", url ? undefined : NO_ENTRY_REASON)}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!url} onClick={onSetBranch}>
            <GitBranchIcon />
            {itemLabel("Set branch…", url ? undefined : NO_ENTRY_REASON)}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={uninitialized} onClick={onOpenAsRepo}>
            <FolderOpenIcon />
            {itemLabel(
              "Open as repository",
              uninitialized ? "initialize this submodule first" : undefined,
            )}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onRemove}>
            <TrashIcon />
            Remove…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Add mode: the add-a-submodule form this dialog swaps to. */
function AddSubmodule({
  add,
  onCancel,
  onAdded,
}: {
  /** Owned by the parent so its pending state outlives this form. */
  add: ReturnType<typeof useAddSubmodule>;
  onCancel: () => void;
  onAdded: () => void;
}) {
  const [url, setUrl] = useState("");
  const [path, setPath] = useState("");
  const [branch, setBranch] = useState("");

  // The continuation belongs to THIS mount, not to whichever form is on screen
  // when the clone lands: closing mid-clone and reopening on the add form gives
  // the user a second, freshly-typed form that must not be navigated away by the
  // first one's result. The parent's open-guard can't tell the two apart.
  const mounted = useRef(true);
  useEffect(() => {
    // Set in the BODY, not just initialization: StrictMode's setup→cleanup→setup
    // cycle would otherwise leave the flag false on a mounted form in dev.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const trimmedUrl = url.trim();
  // git's own default when no path is given: the URL's last segment.
  const derivedPath = nameFromUrl(trimmedUrl);

  async function handleAdd() {
    if (!trimmedUrl || add.isPending) return;
    try {
      await add.mutateAsync({
        url: trimmedUrl,
        path: path.trim() || null,
        branch: branch.trim() || null,
      });
      // Reported either way — the add really did happen.
      toast.success("Submodule added — staged for you to commit.");
      if (mounted.current) onAdded();
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-2">
          {/* Off mid-clone, like Cancel and the Esc arm: leaving for a sibling
              form would strand a running add against a path this form owns. */}
          <DisabledReasonButton
            variant="ghost"
            size="icon-sm"
            disabled={add.isPending}
            reason={ADDING_REASON}
            onClick={onCancel}
            aria-label="Back to submodules"
          >
            <CaretLeftIcon />
          </DisabledReasonButton>
          <DialogTitle>Add submodule</DialogTitle>
        </div>
        <DialogDescription>
          Clones another repository into a folder of this one and records it in
          .gitmodules. The addition is staged for you to commit.
        </DialogDescription>
      </DialogHeader>

      <form
        className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-xs"
        onSubmit={(e) => {
          e.preventDefault();
          void handleAdd();
        }}
      >
        <label htmlFor="sub-url" className="text-muted-foreground">
          Repository URL
        </label>
        <Input
          id="sub-url"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/user/repo.git"
          className="h-7 font-mono"
        />
        <label htmlFor="sub-path" className="text-muted-foreground">
          Folder
        </label>
        <Input
          id="sub-path"
          autoComplete="off"
          spellCheck={false}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder={derivedPath || "Optional — derived from the URL"}
          className="h-7 font-mono"
        />
        <label htmlFor="sub-branch" className="text-muted-foreground">
          Branch
        </label>
        <Input
          id="sub-branch"
          autoComplete="off"
          spellCheck={false}
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="Optional — tracks the remote's default"
          className="h-7 font-mono"
        />
      </form>

      <DialogFooter className="items-center">
        {!trimmedUrl && (
          <span className="mr-auto text-[11px] text-muted-foreground">
            Enter a repository URL to continue.
          </span>
        )}
        <DisabledReasonButton
          variant="outline"
          disabled={add.isPending}
          reason={ADDING_REASON}
          onClick={onCancel}
        >
          Cancel
        </DisabledReasonButton>
        <Button disabled={!trimmedUrl || add.isPending} onClick={handleAdd}>
          {add.isPending && <Spinner data-icon="inline-start" />}
          Add
        </Button>
      </DialogFooter>
    </>
  );
}

/** Repoints a submodule at a different remote URL. */
function EditSubmoduleUrlDialog({
  repoPath,
  submodule,
  onClose,
}: {
  repoPath: string;
  submodule: Submodule | null;
  onClose: () => void;
}) {
  const setUrl = useSetSubmoduleUrl(repoPath);
  const [url, setUrlValue] = useState(submodule?.url ?? "");

  const trimmed = url.trim();
  const unchanged = trimmed === (submodule?.url ?? "");
  // Ranked so the reason names the term that actually holds Save right now — an
  // in-flight write outranks the field state it was started from.
  const saveReason = (() => {
    switch (true) {
      case setUrl.isPending:
        return "Saving…";
      case !trimmed:
        return "Enter a URL";
      default:
        return "No changes to save";
    }
  })();

  // Awaited: this dialog is remounted by a `key` flip and unmounts on close, and
  // per-call mutation callbacks don't survive that — the outcome would be lost.
  async function handleSave() {
    if (!submodule || !trimmed || unchanged || setUrl.isPending) return;
    try {
      await setUrl.mutateAsync({ path: submodule.path, url: trimmed });
      toast.success("Submodule URL updated — staged for you to commit.");
      onClose();
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <Dialog open={submodule !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit submodule URL</DialogTitle>
          <DialogDescription>
            Points {submodule?.path} at a different remote. Existing commits are
            untouched; the change is staged for you to commit.
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid grid-cols-[auto_1fr] items-center gap-x-3 text-xs"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSave();
          }}
        >
          <label htmlFor="sub-edit-url" className="text-muted-foreground">
            URL
          </label>
          <Input
            id="sub-edit-url"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={url}
            onChange={(e) => setUrlValue(e.target.value)}
            className="h-7 font-mono"
          />
        </form>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={setUrl.isPending}
          >
            Cancel
          </Button>
          <DisabledReasonButton
            disabled={!trimmed || unchanged || setUrl.isPending}
            reason={saveReason}
            onClick={handleSave}
          >
            {setUrl.isPending && <Spinner data-icon="inline-start" />}
            Save
          </DisabledReasonButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Sets which branch a submodule tracks for "Update to latest". */
function SetSubmoduleBranchDialog({
  repoPath,
  submodule,
  onClose,
}: {
  repoPath: string;
  submodule: Submodule | null;
  onClose: () => void;
}) {
  const setBranch = useSetSubmoduleBranch(repoPath);
  const [branch, setBranchValue] = useState(submodule?.branch ?? "");

  const next = branch.trim() || null;
  const unchanged = next === (submodule?.branch ?? null);
  // No empty-field arm: an empty field is a valid value here (track the remote
  // default), so the only terms are the in-flight write and an unchanged field.
  const saveReason = setBranch.isPending ? "Saving…" : "No changes to save";

  async function handleSave() {
    if (!submodule || unchanged || setBranch.isPending) return;
    try {
      await setBranch.mutateAsync({ path: submodule.path, branch: next });
      toast.success(
        next
          ? `${submodule.path} now tracks ${next} — staged for you to commit.`
          : `${submodule.path} now tracks the remote's default branch — staged for you to commit.`,
      );
      onClose();
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <Dialog open={submodule !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set submodule branch</DialogTitle>
          <DialogDescription>
            "Update to latest" moves {submodule?.path} to the tip of this
            branch. Leave it empty to follow the remote's default branch.
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid grid-cols-[auto_1fr] items-center gap-x-3 text-xs"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSave();
          }}
        >
          <label htmlFor="sub-branch-edit" className="text-muted-foreground">
            Branch
          </label>
          <Input
            id="sub-branch-edit"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={branch}
            onChange={(e) => setBranchValue(e.target.value)}
            placeholder="Empty — the remote's default"
            className="h-7 font-mono"
          />
        </form>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={setBranch.isPending}
          >
            Cancel
          </Button>
          <DisabledReasonButton
            disabled={unchanged || setBranch.isPending}
            reason={saveReason}
            onClick={handleSave}
          >
            {setBranch.isPending && <Spinner data-icon="inline-start" />}
            Save
          </DisabledReasonButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
