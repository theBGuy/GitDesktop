import { FileCodeIcon, WarningIcon } from "@phosphor-icons/react";
import { Fragment, useEffect, useRef, useState } from "react";
import { PathText } from "@/components/path-text";
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
import {
  useResolvedTaskScript,
  useTaskRepoKeys,
  useUpdateTask,
} from "@/lib/scripts/queries";
import { isRunConfirmedIn } from "@/lib/scripts/scope";
import { INTERPRETERS, type TaskDef } from "@/lib/scripts/types";
import { useTaskRunStore } from "@/lib/stores/taskRun";
import { useUiStore } from "@/lib/stores/ui";
import { useRetained } from "@/lib/use-retained";

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
 *
 * A file task names the resolved file this run will execute: its stored path can
 * be repo-relative, so the same task points at a different file in every repo.
 */
export function TaskRunConfirm() {
  const repoPath = useUiStore((s) => s.repoPath);
  const pending = useTaskRunStore((s) => s.pending);
  const activeRun = useTaskRunStore((s) => s.activeRun);
  const confirmPending = useTaskRunStore((s) => s.confirmPending);
  const cancelPending = useTaskRunStore((s) => s.cancelPending);
  const { keys } = useTaskRepoKeys(repoPath);
  const updateTask = useUpdateTask();

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

  // The seeding effect above stays on live `pending`.
  const shownPending = useRetained(pending);

  const replacing = shownPending?.reason === "replace";
  const firstRun = shownPending?.firstRun === true;
  const task = shownPending?.task ?? null;
  const interpreter = task
    ? (INTERPRETER_LABELS[task.interpreter] ?? task.interpreter)
    : "";
  // Resolution rides the LIVE pending, not the retained one: that way the query
  // goes dormant at close and re-enables at each open, refetching once its
  // staleTime lapses — a branch switch between runs must never leave the safety
  // surface showing a stale path or missing-file verdict.
  const resolved = useResolvedTaskScript(pending?.task ?? null, repoPath);
  // Closing empties the live query key (the path drops out of it), so hold the last
  // resolution alongside the SIGNATURE it was produced under — the repo and stored
  // path that are the query key's own axes, never a task id, which survives a repo
  // switch or a path edit and would name a file this run wouldn't execute. Both
  // retains share one flag so they can't desync; a mismatch (or a failed re-resolve)
  // falls back to the stored path with no existence verdict.
  const scriptSig = (t: TaskDef | null) =>
    t?.source.kind === "file" && repoPath
      ? `${repoPath}::${t.source.path}`
      : null;
  const hasResolved = resolved.data != null;
  const lastResolved = useRetained(resolved.data ?? null, hasResolved);
  const lastResolvedFor = useRetained(
    scriptSig(pending?.task ?? null),
    hasResolved,
  );
  const script =
    lastResolvedFor !== null && lastResolvedFor === scriptSig(task)
      ? lastResolved
      : null;
  const detail =
    task?.description ||
    `Runs the ${interpreter} script in the repository's folder. Make sure you trust what it does.`;

  // The Run button and the args field's Enter share this: which control the user
  // reaches for must not decide whether the confirmation is recorded.
  const run = () => {
    // `shownPending` outlives the live one through the close animation, and the
    // args field can still hold focus there — so a run fired against a pending
    // the repo switch already cleared would record the NEW repo's key while
    // `confirmPending` no-ops, skipping that repo's genuine first run.
    if (!useTaskRunStore.getState().pending) return;
    if (task?.source.kind === "file" && !isRunConfirmedIn(task, keys)) {
      // The canonical key is the most-preferred one `useTaskRepoKeys` reports —
      // the worktree-stable identity once resolved, the raw checkout path until
      // then (the store folds a raw one onto the identity on the next write).
      const key = keys.at(-1);
      // Fire-and-forget: the run starts either way and nothing downstream reads
      // the result, so this takes no continuation to lose.
      if (key) {
        updateTask
          .mutateAsync({
            ...task,
            runConfirmedIn: [...task.runConfirmedIn, key],
          })
          .catch(() => undefined);
      }
    }
    confirmPending(args);
  };
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
            {replacing ? "A task is already running" : `Run “${task?.name}”?`}
          </DialogTitle>
          <DialogDescription>
            {replacing ? (
              <>
                Stops “{activeRun?.task.name}” — still running — and runs “
                {task?.name}” instead.
              </>
            ) : (
              <>
                {firstRun
                  ? "This is the task's first run in this repository, so it confirms once here. Later runs start straight away. "
                  : ""}
                {detail}
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {task?.source.kind === "file" ? (
          // The exact file this run executes, knowable only once resolved against
          // this repo. `min-w-0` because `DialogContent` is a grid: the item would
          // otherwise floor at the path's width and outgrow the dialog's cap.
          <div className="min-w-0 space-y-1 text-xs">
            <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <FileCodeIcon className="size-3.5 shrink-0" />
              <PathText
                path={script?.path ?? task.source.path}
                className="font-mono"
              />
            </div>
            {/* Icon + text, never color alone (WCAG AA). */}
            {script?.exists === false ? (
              <p className="flex items-start gap-1.5 text-warning">
                <WarningIcon
                  weight="fill"
                  className="mt-0.5 size-3.5 shrink-0"
                />
                <span className="min-w-0">
                  No such file in this repository. The run will stop with
                  “script file not found”.
                </span>
              </p>
            ) : null}
          </div>
        ) : null}

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
                run();
              }
            }}
            placeholder="none"
            autoComplete="off"
            spellCheck={false}
          />
          {docRows.length > 0 && (
            // --help-style reference: flag column + description that WRAPS —
            // this is documentation the user is here to read, so it never
            // truncates (the dialog itself scrolls if the list is long).
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 pt-1 text-xs">
              {docRows.map((d) => (
                <Fragment key={d.key}>
                  <dt className="font-mono text-muted-foreground">{d.arg}</dt>
                  <dd className="min-w-0 wrap-break-word text-muted-foreground">
                    {d.description}
                  </dd>
                </Fragment>
              ))}
            </dl>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={cancelPending}>
            Cancel
          </Button>
          <Button variant={replacing ? "destructive" : "default"} onClick={run}>
            {replacing ? "Stop & run" : "Run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
