import { InfoIcon, WarningIcon } from "@phosphor-icons/react";
import { useEffect, useEffectEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
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
import { useCompareBranches } from "@/lib/git/queries";
import type { Branch } from "@/lib/git/types";

const PREVIEW_CAP = 6;

/**
 * "Rebase onto a different base" — the fix for branching off the wrong branch.
 * Two pickers: the **new base** (where the branch should sit) and the
 * **original base** (the wrong branch it was based on); `git rebase --onto
 * <newBase> <oldBase>` then replays only the commits after the original base
 * (`oldBase..HEAD`), excluding the wrong base's own work. The moving-commits
 * preview is the safety net: the user visually confirms "yes, these are MY
 * commits" before running.
 *
 * The dialog is presentational — it collects the two branches and calls
 * `onRun`; the switcher owns the mutation (so it feeds the `busy` gate) and the
 * conflict flow reuses the existing banner untouched.
 */
export function RebaseOntoDialog({
  repoPath,
  open,
  onClose,
  onRun,
  otherBranches,
  currentLabel,
  defaultBranch,
  hasChanges,
  isPushed,
}: {
  repoPath: string;
  open: boolean;
  onClose: () => void;
  onRun: (newBase: string, oldBase: string) => void;
  /** Branches other than the current one (already excludes `gd/session/*`). */
  otherBranches: Branch[];
  currentLabel: string;
  defaultBranch: string | null;
  /** Dirty working tree — a rebase can't run until it's clean. */
  hasChanges: boolean;
  /** The current branch tracks a remote — rebasing will need a force-push. */
  isPushed: boolean;
}) {
  const [newBase, setNewBase] = useState("");
  const [oldBase, setOldBase] = useState("");
  const newBaseSelectId = useId();
  const oldBaseSelectId = useId();

  // On open, default the new base to the default branch (the usual "I meant to
  // branch off main" case) and the original base to any other branch.
  const seedOnOpen = useEffectEvent(() => {
    const names = otherBranches.map((b) => b.name);
    const seededNew =
      defaultBranch && names.includes(defaultBranch)
        ? defaultBranch
        : (names[0] ?? "");
    setNewBase(seededNew);
    setOldBase(names.find((n) => n !== seededNew) ?? "");
  });
  useEffect(() => {
    if (open) seedOnOpen();
  }, [open]);

  const sameBranch = Boolean(newBase) && newBase === oldBase;
  // The commits `oldBase..HEAD` — exactly what `--onto` will replay. Compares
  // against the literal `HEAD` ref (what the rebase itself operates on, so the
  // preview and the action can never disagree), gated on the dialog being open
  // so it doesn't fetch in the background.
  const comparison = useCompareBranches(
    repoPath,
    open && oldBase && !sameBranch ? oldBase : null,
    open ? "HEAD" : null,
  );
  const moving = comparison.data?.ahead ?? [];
  const movingCount = moving.length;
  const canRun =
    !hasChanges &&
    Boolean(newBase) &&
    Boolean(oldBase) &&
    !sameBranch &&
    movingCount > 0;

  function run() {
    if (!canRun) return;
    onRun(newBase, oldBase);
  }

  function renderPreview() {
    if (hasChanges) {
      return (
        <span className="flex items-start gap-1.5 text-warning">
          <WarningIcon className="mt-px size-3.5 shrink-0" />
          <span>
            Commit or stash your changes first — a rebase needs a clean working
            tree.
          </span>
        </span>
      );
    }
    if (sameBranch) {
      return (
        <span className="text-muted-foreground">
          Pick two different branches.
        </span>
      );
    }
    if (!oldBase) return null;
    if (comparison.isFetching && comparison.data === undefined) {
      return (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Spinner className="size-3" /> Checking which commits will move…
        </span>
      );
    }
    if (comparison.isError) {
      // A failed range query (bad ref, timeout) leaves `data` undefined — don't
      // let that fall through and read as a benign "nothing to move".
      return (
        <span className="flex items-start gap-1.5 text-warning">
          <WarningIcon className="mt-px size-3.5 shrink-0" />
          <span>
            Couldn't check which commits would move — make sure both branches
            are reachable.
          </span>
        </span>
      );
    }
    if (movingCount === 0) {
      return (
        <span className="flex items-start gap-1.5 text-warning">
          <WarningIcon className="mt-px size-3.5 shrink-0" />
          <span>
            Nothing to move — {currentLabel} has no commits beyond{" "}
            <span className="font-mono">{oldBase}</span>.
          </span>
        </span>
      );
    }
    return null;
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col">
        <DialogHeader>
          <DialogTitle>Change base of {currentLabel}</DialogTitle>
          <DialogDescription>
            Replay only {currentLabel}'s own commits onto a different branch —
            for when it was branched off the wrong one. Conflicts appear in the
            changes list.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
          <div className="space-y-2">
            <Label htmlFor={newBaseSelectId}>New base</Label>
            <Select
              items={Object.fromEntries(
                otherBranches.map((b) => [b.name, b.name]),
              )}
              value={newBase || null}
              onValueChange={(v) => v && setNewBase(v)}
            >
              <SelectTrigger id={newBaseSelectId} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {otherBranches.map((b) => (
                  <SelectItem key={b.name} value={b.name}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor={oldBaseSelectId}>Original base</Label>
            <Select
              items={Object.fromEntries(
                otherBranches.map((b) => [b.name, b.name]),
              )}
              value={oldBase || null}
              onValueChange={(v) => v && setOldBase(v)}
            >
              <SelectTrigger id={oldBaseSelectId} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {otherBranches.map((b) => (
                  <SelectItem key={b.name} value={b.name}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              The branch it was accidentally based on — commits after this point
              are what move.
            </p>
          </div>

          <div className="min-h-5 text-xs">{renderPreview()}</div>

          {canRun && (
            <div className="space-y-2">
              <p className="text-xs text-foreground/80">
                {movingCount} commit{movingCount === 1 ? "" : "s"} will move
                onto <span className="font-mono">{newBase}</span>:
              </p>
              <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border bg-muted/30 p-2">
                {moving.slice(0, PREVIEW_CAP).map((c) => (
                  <li key={c.hash} className="flex gap-2 text-xs">
                    <span className="shrink-0 font-mono text-muted-foreground">
                      {c.hash.slice(0, 7)}
                    </span>
                    <span className="truncate" title={c.subject}>
                      {c.subject}
                    </span>
                  </li>
                ))}
                {movingCount > PREVIEW_CAP && (
                  <li className="text-[11px] text-muted-foreground">
                    +{movingCount - PREVIEW_CAP} more
                  </li>
                )}
              </ul>
              {isPushed && (
                <span className="flex items-start gap-1.5 text-xs text-warning">
                  <InfoIcon className="mt-px size-3.5 shrink-0" />
                  <span>
                    This rewrites {currentLabel}'s history — you'll need to
                    force-push afterward.
                  </span>
                </span>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={run} disabled={!canRun}>
            Rebase
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
