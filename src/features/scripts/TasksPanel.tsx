import {
  CaretDownIcon,
  CaretRightIcon,
  DotsThreeVerticalIcon,
  FolderIcon,
  LightningIcon,
  PencilSimpleIcon,
  PlayIcon,
  PlusIcon,
  TrashIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { clipTitle } from "@/lib/clip-title";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import {
  useAddTask,
  useRemoveTask,
  useScripts,
  useSetTasksEnabled,
  useTaskRepoKeys,
  useUpdateTask,
} from "@/lib/scripts/queries";
import {
  scopeRepoLabel,
  TASK_SCOPE_GLOBAL,
  TASK_SCOPE_UNKNOWN,
  taskInScope,
  taskScope,
  taskScopedElsewhere,
} from "@/lib/scripts/scope";
import { INTERPRETERS, type TaskDef } from "@/lib/scripts/types";
import { useConfirm } from "@/lib/stores/confirm";
import { useTaskRunStore } from "@/lib/stores/taskRun";
import { useUiStore } from "@/lib/stores/ui";
import {
  ARIA_DISABLED_CLASS,
  useDisabledReason,
} from "@/lib/use-disabled-reason";
import { cn } from "@/lib/utils";
import { TaskDialog } from "./TaskDialog";

const INTERPRETER_LABELS: Record<string, string> = Object.fromEntries(
  INTERPRETERS.map((i) => [i.id, i.label]),
);

/** What a delete costs, by source: an inline body exists only inside the task,
 *  while a file task owns nothing but the registration. */
const DELETE_BODY: Record<TaskDef["source"]["kind"], string> = {
  inline:
    "The task and its inline script are removed together. The script is stored only in this task, so deleting it is permanent.",
  file: "The task is removed. The script file it points at stays on disk.",
};

/** One keyboard-navigable row: the in-scope tasks, then the other-repositories
 *  disclosure header and — while it's open — that group's rows. One list, so the
 *  arrows cross the boundary without the user learning a second gesture. */
type NavRow =
  | { kind: "task"; task: TaskDef }
  | { kind: "group" }
  | { kind: "other"; task: TaskDef };

const GROUP_ROW_KEY = "other-repos-header";

/** DOM key per row. The two task kinds are prefixed apart: the same task id can
 *  never appear in both buckets, but a shared key space across row TYPES is the
 *  collision React resolves by keeping the first row's DOM alive. */
function navRowKey(row: NavRow): string {
  switch (row.kind) {
    case "group":
      return GROUP_ROW_KEY;
    case "other":
      return `other-${row.task.id}`;
    default:
      return row.task.id;
  }
}

export function TasksPanel() {
  const scripts = useScripts();
  const setEnabled = useSetTasksEnabled();
  const addTask = useAddTask();
  const updateTask = useUpdateTask();
  const removeTask = useRemoveTask();
  const request = useTaskRunStore((s) => s.request);
  const repoPath = useUiStore((s) => s.repoPath);
  // Scope classification waits for `settled`: the identity key resolves a beat
  // after open, and classifying against the raw path alone would flash an
  // identity-scoped task through the other-repositories group.
  const { keys, settled } = useTaskRepoKeys(repoPath);

  const [editing, setEditing] = useState<TaskDef | "new" | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [othersOpen, setOthersOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const othersId = useId();

  const enabled = scripts.data?.enabled ?? false;
  const tasks = scripts.data?.tasks ?? [];
  const inScope = tasks.filter((t) => taskInScope(t, keys));
  const elsewhere = tasks.filter((t) => taskScopedElsewhere(t, keys));

  function saveTask(task: TaskDef) {
    const isNew = editing === "new";
    const mutation = isNew ? addTask : updateTask;
    mutation.mutate(task, {
      onSuccess: () => {
        setEditing(null);
        toast.success(isNew ? `Added "${task.name}"` : `Saved "${task.name}"`);
      },
      onError: (e) => toast.error(String(e)),
    });
  }

  function deleteTask(id: string) {
    // All tasks, not just the in-scope ones: the other-repositories group deletes
    // through here too.
    const name = tasks.find((t) => t.id === id)?.name ?? "task";
    removeTask.mutate(id, {
      onSuccess: () => {
        setEditing(null);
        toast.success(`Deleted "${name}"`);
      },
      onError: (e) => toast.error(String(e)),
    });
  }

  // The row menus' delete is one click from gone, so it asks first. The editor's
  // own two-step Delete… already confirms and calls `deleteTask` directly — a
  // second prompt would stack on it.
  async function confirmDeleteTask(task: TaskDef) {
    const ok = await useConfirm.getState().ask({
      title: `Delete "${task.name}"?`,
      body: DELETE_BODY[task.source.kind],
      confirmLabel: "Delete task",
      confirmVariant: "destructive",
    });
    if (ok) deleteTask(task.id);
  }

  const navRows: NavRow[] = [];
  for (const task of inScope) navRows.push({ kind: "task", task });
  if (elsewhere.length > 0) {
    navRows.push({ kind: "group" });
    if (othersOpen) {
      for (const task of elsewhere) navRows.push({ kind: "other", task });
    }
  }
  const groupIndex = inScope.length;
  // The cursor is clamped at render, not stored clamped: the row list shrinks
  // under it (a delete, a collapse, a repo switch), and a stale index past the
  // end would leave no row carrying tabIndex=0 — the list unreachable by Tab —
  // and hand the nav an undefined row to key.
  const clamped = Math.min(activeIndex, navRows.length - 1);
  // Roving tabindex over the composite list: exactly one row is a tab stop, and
  // until a row is focused (clamped === -1) that's the first one, so the list is
  // keyboard-reachable from the start.
  const tabStop = Math.max(clamped, 0);

  const nav = listKeyboardNav({
    items: navRows,
    activeIndex: clamped,
    onActivate: (_row, to) => setActiveIndex(to),
    rowKey: navRowKey,
  });

  // The row cursor and the group's expansion describe the repo they were made
  // in. Guarded on the path actually changing: this panel outlives a repo switch
  // (RepositoryView is one instance) and <Activity> replays effects on every tab
  // show, where an unguarded reset would collapse the group under the user.
  const prevRepo = useRef(repoPath);
  useEffect(() => {
    if (prevRepo.current === repoPath) return;
    prevRepo.current = repoPath;
    setActiveIndex(-1);
    setOthersOpen(false);
  }, [repoPath]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <LightningIcon className="size-4 text-muted-foreground" />
        <span className="text-xs font-medium">Tasks</span>
        {enabled && settled && inScope.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {inScope.length}
          </span>
        )}
        <span className="flex-1" />
        {enabled && (
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => setEditing("new")}
            title="New task"
            aria-label="New task"
          >
            <PlusIcon />
          </Button>
        )}
      </div>

      {/* The identity gate applies only once tasks are enabled: the consent
          screen classifies nothing, so it must not wait on an identity lookup
          that may never settle. */}
      {scripts.isPending || (enabled && !settled) ? (
        <div className="space-y-2 p-3">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : !enabled ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <LightningIcon className="size-8 text-muted-foreground" />
          <div className="space-y-1">
            <p className="text-sm font-medium">Run your scripts from here</p>
            <p className="text-xs text-muted-foreground">
              Save a script — like your release or build flow — and run it in an
              interactive terminal without leaving GitDesktop. Scripts you save
              stay on this machine and only run when you start them.
            </p>
          </div>
          <Button
            size="sm"
            disabled={setEnabled.isPending}
            onClick={() =>
              setEnabled.mutate(true, {
                onError: (e) => toast.error(String(e)),
              })
            }
          >
            Enable task running
          </Button>
        </div>
      ) : tasks.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <LightningIcon className="size-8 text-muted-foreground" />
          <div className="space-y-1">
            <p className="text-sm font-medium">No tasks yet</p>
            <p className="text-xs text-muted-foreground">
              Register a script to run it here. A task belongs to the repository
              you create it in, and you can make one available in every
              repository instead.
            </p>
          </div>
          <Button size="sm" onClick={() => setEditing("new")}>
            <PlusIcon data-icon="inline-start" />
            New task
          </Button>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div
            ref={listRef}
            role="group"
            aria-label="Tasks"
            onKeyDown={nav}
            className="space-y-0.5 p-2"
          >
            {inScope.length === 0 ? (
              <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
                <LightningIcon className="size-8 text-muted-foreground" />
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    No tasks for this repository
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Create one here, or open the repository a task below belongs
                    to.
                  </p>
                </div>
                <Button size="sm" onClick={() => setEditing("new")}>
                  <PlusIcon data-icon="inline-start" />
                  New task
                </Button>
              </div>
            ) : (
              inScope.map((task, index) => (
                <div key={task.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    data-row={task.id}
                    tabIndex={index === tabStop ? 0 : -1}
                    onFocus={() => setActiveIndex(index)}
                    onClick={() => void request(task)}
                    className={cn(
                      "flex min-w-0 flex-1 items-start gap-2 rounded px-2 py-1.5 text-left text-xs",
                      index === clamped
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-muted/60",
                    )}
                  >
                    <PlayIcon className="mt-px size-3.5 shrink-0 text-muted-foreground" />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-center gap-2">
                        <span
                          className="min-w-0 flex-1 truncate"
                          onMouseEnter={clipTitle(task.name)}
                        >
                          {task.name}
                        </span>
                        {task.args !== "" && (
                          <span
                            className="min-w-0 max-w-32 truncate font-mono text-[10px] text-muted-foreground"
                            onMouseEnter={clipTitle(task.args)}
                          >
                            {task.args}
                          </span>
                        )}
                        {taskScope(task) === TASK_SCOPE_GLOBAL && (
                          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                            All repos
                          </span>
                        )}
                        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                          {INTERPRETER_LABELS[task.interpreter] ??
                            task.interpreter}
                        </span>
                      </span>
                      {task.description !== "" && (
                        <span
                          className="truncate text-[11px] text-muted-foreground"
                          onMouseEnter={clipTitle(task.description)}
                        >
                          {task.description}
                        </span>
                      )}
                    </span>
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          className="shrink-0 text-muted-foreground"
                          title={`More actions for "${task.name}"`}
                          aria-label={`More actions for ${task.name}`}
                        />
                      }
                    >
                      <DotsThreeVerticalIcon />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => void request(task)}>
                        <PlayIcon data-icon="inline-start" />
                        Run
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setEditing(task)}>
                        <PencilSimpleIcon data-icon="inline-start" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => void confirmDeleteTask(task)}
                      >
                        <TrashIcon data-icon="inline-start" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))
            )}

            {elsewhere.length > 0 && (
              <div className="pt-2">
                <button
                  type="button"
                  data-row={GROUP_ROW_KEY}
                  tabIndex={groupIndex === tabStop ? 0 : -1}
                  onFocus={() => setActiveIndex(groupIndex)}
                  aria-expanded={othersOpen}
                  aria-controls={othersId}
                  onClick={() => setOthersOpen((v) => !v)}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-1 rounded px-2 py-1.5 text-left text-xs",
                    groupIndex === clamped
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {othersOpen ? (
                    <CaretDownIcon className="size-3 shrink-0" />
                  ) : (
                    <CaretRightIcon className="size-3 shrink-0" />
                  )}
                  Other repositories
                  <span className="tabular-nums">· {elsewhere.length}</span>
                </button>
                {/* The panel is the only place tasks can be managed, so a task
                    whose repository isn't open stays listed and editable here —
                    hiding it would strand the tasks of a removed repo. */}
                <div
                  id={othersId}
                  hidden={!othersOpen}
                  className="space-y-0.5 pt-0.5"
                >
                  {othersOpen &&
                    elsewhere.map((task, offset) => {
                      const index = groupIndex + 1 + offset;
                      return (
                        <OtherTaskRow
                          key={`other-${task.id}`}
                          task={task}
                          active={index === clamped}
                          tabIndex={index === tabStop ? 0 : -1}
                          onFocus={() => setActiveIndex(index)}
                          onEdit={() => setEditing(task)}
                          onDelete={() => void confirmDeleteTask(task)}
                        />
                      );
                    })}
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      )}

      <TaskDialog
        task={editing}
        open={editing !== null}
        onOpenChange={(o) => {
          if (!o) setEditing(null);
        }}
        onSave={saveTask}
        onDelete={deleteTask}
      />
    </div>
  );
}

/**
 * The three strings an other-repo row shows for its scope. The reason names the
 * task because it is the row's ONLY hover text — `aria-disabled:pointer-events-none`
 * reaches every descendant, so a clipped-only tooltip inside could never fire.
 * A malformed stored scope names no repository to open, so its copy points at
 * the repair instead: Edit, then the "Available in" picker.
 */
function otherRowCopy(task: TaskDef): {
  attribution: string;
  reason: string;
  runLabel: string;
  unreadable: boolean;
} {
  const scope = taskScope(task);
  if (scope === TASK_SCOPE_UNKNOWN) {
    return {
      attribution: "scope unreadable",
      reason: `"${task.name}" has an unreadable saved scope — edit the task to choose where it's available`,
      runLabel: "Run (scope unreadable)",
      unreadable: true,
    };
  }
  const label = scopeRepoLabel(scope);
  return {
    attribution: label,
    reason: `"${task.name}" is scoped to "${label}" — open that repository to run it`,
    runLabel: `Run (scoped to "${label}")`,
    unreadable: false,
  };
}

/**
 * A task scoped to another repository: still listed and manageable, never
 * runnable from here. The row takes the raw-`<button>` arm of the disabled-reason
 * contract (the vendored Button can't carry this row's layout), and its Run menu
 * item repeats the reason in its label — a disabled menu item can't hold a
 * tooltip. Editing is live so the task can be re-scoped from wherever you are.
 */
function OtherTaskRow({
  task,
  active,
  tabIndex,
  onFocus,
  onEdit,
  onDelete,
}: {
  task: TaskDef;
  active: boolean;
  tabIndex: number;
  onFocus: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const copy = otherRowCopy(task);
  const { blockedReason, reasonId, wrapperTitle, describedBy, nativeProps } =
    useDisabledReason({ disabled: true, reason: copy.reason });

  return (
    <div className="flex items-center gap-1">
      <span
        className={cn(
          "flex min-w-0 flex-1",
          blockedReason && "cursor-not-allowed",
        )}
        title={wrapperTitle}
      >
        <button
          {...nativeProps}
          type="button"
          data-row={`other-${task.id}`}
          tabIndex={tabIndex}
          onFocus={onFocus}
          aria-describedby={describedBy}
          className={cn(
            ARIA_DISABLED_CLASS,
            "flex min-w-0 flex-1 items-start gap-2 rounded px-2 py-1.5 text-left text-xs",
            active && "bg-accent text-accent-foreground",
          )}
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{task.name}</span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {INTERPRETER_LABELS[task.interpreter] ?? task.interpreter}
              </span>
            </span>
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              {copy.unreadable ? (
                <WarningIcon className="size-3 shrink-0 text-warning" />
              ) : (
                <FolderIcon className="size-3 shrink-0" />
              )}
              <span className="truncate">{copy.attribution}</span>
            </span>
          </span>
        </button>
        {blockedReason ? (
          <span id={reasonId} className="sr-only">
            {blockedReason}
          </span>
        ) : null}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              className="shrink-0 text-muted-foreground"
              title={`More actions for "${task.name}"`}
              aria-label={`More actions for ${task.name}`}
            />
          }
        >
          <DotsThreeVerticalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled>
            <PlayIcon data-icon="inline-start" />
            {copy.runLabel}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onEdit}>
            <PencilSimpleIcon data-icon="inline-start" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <TrashIcon data-icon="inline-start" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
