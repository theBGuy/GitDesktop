import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { INTERPRETERS } from "@/lib/scripts/types";
import { useTaskRunStore } from "@/lib/stores/taskRun";

const INTERPRETER_LABELS: Record<string, string> = Object.fromEntries(
  INTERPRETERS.map((i) => [i.id, i.label]),
);

/**
 * The run dialog, driven by the task-run store's `pending`. Hoisted at the repo
 * level so any run trigger (panel, palette picker) shares one instance. Beyond
 * confirming, it's where a run's **arguments** are adjusted: the field seeds from
 * the task's saved args (the saved task is never changed here), with the task's
 * documented arguments as reference below — Enter runs immediately.
 * `reason: "replace"` additionally warns that the still-running task stops.
 */
export function TaskRunConfirm() {
  const pending = useTaskRunStore((s) => s.pending);
  const activeRun = useTaskRunStore((s) => s.activeRun);
  const confirmPending = useTaskRunStore((s) => s.confirmPending);
  const cancelPending = useTaskRunStore((s) => s.cancelPending);

  const [args, setArgs] = useState("");
  // Seed the args field from the task's saved string each time a run is
  // requested (a new pending), discarding the previous request's edits.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!pending) {
      seededFor.current = null;
      return;
    }
    const key = `${pending.task.id}:${pending.reason}`;
    if (seededFor.current === key) return;
    seededFor.current = key;
    setArgs(pending.task.args);
  }, [pending]);

  const replacing = pending?.reason === "replace";
  const task = pending?.task ?? null;
  const interpreter = task
    ? (INTERPRETER_LABELS[task.interpreter] ?? task.interpreter)
    : "";
  // Keys precomputed outside the JSX: `arg` alone isn't guaranteed unique (the
  // editor doesn't forbid documenting the same flag twice), and the list is
  // static per dialog-open, so a position-qualified key is stable and safe.
  const docRows = (task?.argDocs ?? []).map((d, i) => ({
    ...d,
    key: `${i}:${d.arg}`,
  }));

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(o) => {
        if (!o) cancelPending();
      }}
    >
      {/* Tall-content guard: a task may document many arguments; the footer must
          stay reachable, so the dialog caps and scrolls (same as the editor). */}
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {replacing
              ? "A task is already running"
              : `Run “${task?.name}”?`}
          </DialogTitle>
          <DialogDescription>
            {replacing ? (
              <>
                Stops “{activeRun?.task.name}” — still running — and runs “
                {task?.name}” instead.
              </>
            ) : task?.description ? (
              task.description
            ) : (
              <>
                Runs the {interpreter} script in the repository's folder. Make
                sure you trust what it does.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="run-args">Arguments</Label>
          <Input
            id="run-args"
            autoFocus
            className="font-mono"
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                confirmPending(args);
              }
            }}
            placeholder="none"
            autoComplete="off"
            spellCheck={false}
          />
          {docRows.length > 0 && (
            <dl className="space-y-0.5 pt-1 text-xs">
              {docRows.map((d) => (
                <div key={d.key} className="flex gap-2">
                  <dt className="shrink-0 font-mono text-muted-foreground">
                    {d.arg}
                  </dt>
                  <dd className="min-w-0 flex-1 truncate text-muted-foreground">
                    {d.description}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={cancelPending}>
            Cancel
          </Button>
          <Button
            variant={replacing ? "destructive" : "default"}
            onClick={() => confirmPending(args)}
          >
            {replacing ? "Stop & run" : "Run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
