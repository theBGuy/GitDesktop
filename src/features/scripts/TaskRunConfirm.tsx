import { ConfirmDialog } from "@/components/confirm-dialog";
import { INTERPRETERS } from "@/lib/scripts/types";
import { useTaskRunStore } from "@/lib/stores/taskRun";
import { useUiStore } from "@/lib/stores/ui";

const INTERPRETER_LABELS: Record<string, string> = Object.fromEntries(
  INTERPRETERS.map((i) => [i.id, i.label]),
);

/**
 * The run-confirmation dialog, driven by the task-run store's `pending`. Hoisted
 * at the repo level so any run trigger (panel, palette picker) shares one dialog.
 * `confirm` = the task's own confirm-before-run; `replace` = a task is still
 * running (running it stops the current one).
 */
export function TaskRunConfirm() {
  const pending = useTaskRunStore((s) => s.pending);
  const activeRun = useTaskRunStore((s) => s.activeRun);
  const confirmPending = useTaskRunStore((s) => s.confirmPending);
  const cancelPending = useTaskRunStore((s) => s.cancelPending);
  const repoName = useUiStore((s) => s.repoName);

  const replacing = pending?.reason === "replace";
  const interpreter = pending
    ? (INTERPRETER_LABELS[pending.task.interpreter] ?? pending.task.interpreter)
    : "";

  return (
    <ConfirmDialog
      open={pending !== null}
      onCancel={cancelPending}
      onConfirm={confirmPending}
      title={
        replacing
          ? "A task is already running"
          : `Run "${pending?.task.name}"?`
      }
      body={
        replacing ? (
          <>
            Stop “{activeRun?.task.name}” and run “{pending?.task.name}”
            instead?
          </>
        ) : (
          <>
            Runs the {interpreter} script
            {repoName ? ` in ${repoName}` : ""}. Make sure you trust what it
            does.
          </>
        )
      }
      confirmLabel={replacing ? "Stop & run" : "Run"}
      confirmVariant={replacing ? "destructive" : "default"}
    />
  );
}
