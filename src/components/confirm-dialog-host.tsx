import { ConfirmDialog } from "@/components/confirm-dialog";
import { useConfirm } from "@/lib/stores/confirm";

/**
 * The single app-root host for {@link useConfirm}. Renders the pending
 * confirmation request (if any) as a {@link ConfirmDialog}, so non-JSX callers
 * (shared hooks, imperative handlers) can `await useConfirm.getState().ask(...)`.
 * Mounted once in `App`; Cancel/Esc resolve the promise `false`, Confirm `true`.
 */
export function ConfirmDialogHost() {
  const request = useConfirm((s) => s.request);
  const answer = useConfirm((s) => s.answer);

  return (
    <ConfirmDialog
      open={request !== null}
      onCancel={() => answer(false)}
      onConfirm={() => answer(true)}
      title={request?.title ?? ""}
      body={request?.body ?? ""}
      confirmLabel={request?.confirmLabel ?? ""}
      confirmVariant={request?.confirmVariant ?? "default"}
    />
  );
}
