import { useState } from "react";
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
import { useSaveSettings, useSettings } from "@/lib/settings/queries";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";

/**
 * Asks before amending a commit that's already on the remote, since the
 * rewrite will require a force push. "Don't show again" persists in settings
 * (`confirmAmendForcePush`). Confirming starts the amend.
 */
export function AmendForcePushDialog({
  open,
  upstream,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  upstream: string | null;
  /** Starts the amend, resolving true once it actually began. False covers both
   *  a gate refusal (a branch rule, or a read still settling) and a commit that
   *  couldn't be loaded — either one holds the "Don't show again" write back. */
  onConfirm: () => Promise<boolean>;
  onCancel: () => void;
}) {
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const [dontShowAgain, setDontShowAgain] = useState(false);

  // Reset the checkbox each time the dialog opens.
  useSeedOnOpen(open, () => setDontShowAgain(false));

  function confirm() {
    // The preference waits on the amend having started: a refused confirm, or a
    // commit that no longer resolves, leaves the prompt that carried it in place.
    // `dontShowAgain` is the click-time value by design — the user's answer to
    // THIS prompt, not whatever the checkbox holds when the amend lands.
    void onConfirm().then((amended) => {
      if (!amended || !dontShowAgain || !settings.data) return;
      void saveSettings
        .mutateAsync({ ...settings.data, confirmAmendForcePush: false })
        .catch(() => undefined);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Amending will require a force push</DialogTitle>
          <DialogDescription>
            This commit is already on {upstream ?? "the remote"}. Amending
            rewrites it, so your branch and the remote will diverge and you'll
            need to force push to update it. GitDesktop force pushes with
            --force-with-lease and, where your Git can check it,
            --force-if-includes (the pair won't overwrite others' work your
            branch doesn't include), but it still rewrites the branch's history.
          </DialogDescription>
        </DialogHeader>
        <label className="flex cursor-pointer items-center gap-2 text-xs">
          <Checkbox
            checked={dontShowAgain}
            onCheckedChange={(v) => setDontShowAgain(v === true)}
          />
          Don't show this again
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={confirm}>Begin amend</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
