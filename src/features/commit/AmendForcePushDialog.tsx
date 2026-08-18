import { useEffect, useState } from "react";
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
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const [dontShowAgain, setDontShowAgain] = useState(false);

  // Reset the checkbox each time the dialog opens.
  useEffect(() => {
    if (open) setDontShowAgain(false);
  }, [open]);

  function confirm() {
    if (dontShowAgain && settings.data) {
      saveSettings.mutate({ ...settings.data, confirmAmendForcePush: false });
    }
    onConfirm();
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
