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
import type { AmendConfirmVariant } from "@/features/history/useAmendCommit";
import { loadSettings } from "@/lib/settings/api";
import { useSaveSettings } from "@/lib/settings/queries";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";

const COPY: Record<
  AmendConfirmVariant,
  { title: string; description: (upstream: string | null) => string }
> = {
  upstream: {
    title: "Amending will require a force push",
    description: (upstream) =>
      `This commit is already on ${upstream ?? "the remote"}. Amending rewrites it, so your branch and the remote will diverge and you'll need to force push to update it. GitDesktop force pushes with --force-with-lease and, where your Git can check it, --force-if-includes (the pair won't overwrite others' work your branch doesn't include), but it still rewrites the branch's history.`,
  },
  elsewhere: {
    title: "This commit is already on a remote branch",
    description: () =>
      "Amending rewrites it on this branch only: the remote branch keeps the original, and the two will differ.",
  },
  unchecked: {
    title: "This commit may already be on a remote branch",
    description: () =>
      "Couldn't check whether a remote branch has this commit. If one does, amending rewrites it on this branch only.",
  },
};

/**
 * Asks before amending a commit that's already published: on the upstream,
 * where the rewrite will require a force push, or on another remote branch (or
 * unchecked) with no live upstream. "Don't show again" persists in settings
 * (`confirmAmendForcePush`) and covers every variant. Confirming starts the
 * amend.
 */
export function AmendForcePushDialog({
  open,
  variant,
  upstream,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  variant: AmendConfirmVariant;
  upstream: string | null;
  /** Starts the amend, resolving true once it actually began. False covers a
   *  gate refusal (a branch rule, or a read still settling), a commit that
   *  couldn't be loaded, a user who navigated away while it loaded, and one who
   *  declined to replace a typed message — each holds the "Don't show again"
   *  write back. */
  onConfirm: () => Promise<boolean>;
  onCancel: () => void;
}) {
  const saveSettings = useSaveSettings();
  const [dontShowAgain, setDontShowAgain] = useState(false);

  // Reset the checkbox each time the dialog opens.
  useSeedOnOpen(open, () => setDontShowAgain(false));

  function confirm() {
    // The preference waits on the amend having STARTED: a refusal, an
    // unresolvable commit, or a navigation away during the lookup leaves the
    // prompt in place. `dontShowAgain` stays the click-time value (the user's
    // answer to THIS prompt); the settings object must not — the dialog closes
    // before the amend resolves, so Settings is reachable during the wait and a
    // snapshot from here would write back the pre-edit object. The write is
    // best-effort; the amend already went ahead.
    void (async () => {
      if (!(await onConfirm())) return;
      if (!dontShowAgain) return;
      const fresh = await loadSettings();
      await saveSettings.mutateAsync({
        ...fresh,
        confirmAmendForcePush: false,
      });
    })().catch(() => undefined);
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
          <DialogTitle className="pr-8">{COPY[variant].title}</DialogTitle>
          <DialogDescription>
            {COPY[variant].description(upstream)}
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
