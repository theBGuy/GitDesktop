import { WarningIcon } from "@phosphor-icons/react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
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
import { useRetained } from "@/lib/use-retained";

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
  /**
   * One-line note above the choices. Set only when a bring-changes attempt was
   * refused — the switcher clears it on every fresh open — so its presence is
   * also what puts the footer in its refusal state below, and what the reapply
   * clause is appended to.
   */
  hint?: string | null;
  reapply: boolean;
  onReapplyChange: (reapply: boolean) => void;
  onCancel: () => void;
  onBringChanges: () => void;
  onStashAndSwitch: () => void;
}) {
  const shownTarget = useRetained(target);
  // Bringing the changes has already been refused, so it can only fail again:
  // stashing takes the primary and the dead offer stays visible but inert,
  // rather than reading as the recommended action beside a hint saying it lost.
  const refused = Boolean(hint);
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
            Bring your uncommitted changes along to {shownTarget?.name}, or
            stash them so {currentLabel} stays as you left it.{" "}
            {reapply ? (
              <>
                Stashed changes are put back on {shownTarget?.name} once the
                switch lands.
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
            {/* The reapply clause is appended here rather than baked into the
                hint: the checkbox stays live while this note shows. */}
            <span>
              {hint}
              {refused && reapply
                ? " Reapply is set, so your changes still come along."
                : null}
            </span>
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
          <Button
            variant={refused ? "default" : "outline"}
            onClick={onStashAndSwitch}
          >
            Stash and switch
          </Button>
          <DisabledReasonButton
            // Below `sm` the footer stacks and stretches the wrapper span; the
            // Button fills it to match the plain siblings beside it.
            className="w-full"
            disabled={refused}
            reason={
              refused
                ? "Git would overwrite your changes — stash and switch instead"
                : null
            }
            variant={refused ? "outline" : "default"}
            onClick={onBringChanges}
          >
            Bring changes
          </DisabledReasonButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
