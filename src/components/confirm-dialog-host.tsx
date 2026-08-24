import { useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import type { ConfirmRequest } from "@/lib/stores/confirm";
import { useConfirm } from "@/lib/stores/confirm";

/**
 * The single app-root host for {@link useConfirm}. Renders the pending
 * confirmation request (if any) as a {@link ConfirmDialog}, so non-JSX callers
 * (shared hooks, imperative handlers) can `await useConfirm.getState().ask(...)`.
 * Mounted once in `App`; Cancel/Esc resolve the promise `false`, Confirm `true`.
 *
 * An `askChecked` request's checkbox is composed into the dialog's body here —
 * ConfirmDialog stays the plain two-button prompt every other caller wants.
 */
export function ConfirmDialogHost() {
  const request = useConfirm((s) => s.request);
  const answer = useConfirm((s) => s.answer);

  // One host serves every prompt, so the box must re-seed per request rather
  // than carry the previous answer's state over. Adjusted during render (not in
  // an effect) so the first paint of a new request already shows its initial.
  const [checked, setChecked] = useState(false);
  const [seeded, setSeeded] = useState<ConfirmRequest | null>(null);
  if (seeded !== request) {
    setSeeded(request);
    setChecked(request?.checkboxInitial ?? false);
  }

  const checkboxLabel = request?.checkboxLabel;

  return (
    <ConfirmDialog
      open={request !== null}
      onCancel={() => answer(false, checked)}
      onConfirm={() => answer(true, checked)}
      title={request?.title ?? ""}
      body={
        checkboxLabel === undefined ? (
          (request?.body ?? "")
        ) : (
          <>
            {request?.body}
            <label className="mt-3 flex cursor-pointer items-center gap-2 text-foreground">
              <Checkbox
                checked={checked}
                onCheckedChange={(next) => setChecked(next === true)}
              />
              {checkboxLabel}
            </label>
          </>
        )
      }
      confirmLabel={request?.confirmLabel ?? ""}
      confirmVariant={request?.confirmVariant ?? "default"}
    />
  );
}
