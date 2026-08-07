import { WarningIcon } from "@phosphor-icons/react";
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

/**
 * Prompt shown when switching branches with uncommitted changes: bring the
 * changes along, or stash them so the current branch stays put. Open when
 * `target` is the pending switch (null = closed). Presentational — the switcher
 * owns the checkout/stash mutations and hands down the actions.
 */
export function SwitchWithChangesDialog({
  target,
  currentLabel,
  hint,
  reapply,
  onReapplyChange,
  onCancel,
  onBringChanges,
  onStashAndSwitch,
}: {
  target: { name: string; remote: string | null } | null;
  currentLabel: string;
  /** One-line note above the choices, e.g. why a first attempt didn't work. */
  hint?: string | null;
  reapply: boolean;
  onReapplyChange: (reapply: boolean) => void;
  onCancel: () => void;
  onBringChanges: () => void;
  onStashAndSwitch: () => void;
}) {
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>You have changes in progress</DialogTitle>
          <DialogDescription>
            Bring your uncommitted changes along to {target?.name}, or stash
            them so {currentLabel} stays as you left it.{" "}
            {reapply ? (
              <>
                Stashed changes are put back on {target?.name} once the switch
                lands.
              </>
            ) : (
              '"Pop latest stash" restores stashed changes later.'
            )}
          </DialogDescription>
        </DialogHeader>
        {hint && (
          <p
            role="status"
            className="flex items-start gap-1.5 text-xs text-warning"
          >
            <WarningIcon className="size-4 shrink-0" />
            <span>{hint}</span>
          </p>
        )}
        <label className="flex cursor-pointer items-center gap-2 text-xs">
          <Checkbox
            checked={reapply}
            onCheckedChange={(v) => onReapplyChange(v === true)}
          />
          Reapply after switching
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="outline" onClick={onStashAndSwitch}>
            Stash and switch
          </Button>
          <Button onClick={onBringChanges}>Bring changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
