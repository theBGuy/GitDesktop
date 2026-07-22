import {
  DotsThreeVerticalIcon,
  LightningIcon,
  PencilSimpleIcon,
  PlayIcon,
  PlusIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useRef, useState } from "react";
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
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import {
  useAddTask,
  useRemoveTask,
  useScripts,
  useSetTasksEnabled,
  useUpdateTask,
} from "@/lib/scripts/queries";
import { INTERPRETERS, type TaskDef } from "@/lib/scripts/types";
import { useTaskRunStore } from "@/lib/stores/taskRun";
import { cn } from "@/lib/utils";
import { TaskDialog } from "./TaskDialog";

const INTERPRETER_LABELS: Record<string, string> = Object.fromEntries(
  INTERPRETERS.map((i) => [i.id, i.label]),
);

export function TasksPanel() {
  const scripts = useScripts();
  const setEnabled = useSetTasksEnabled();
  const addTask = useAddTask();
  const updateTask = useUpdateTask();
  const removeTask = useRemoveTask();
  const request = useTaskRunStore((s) => s.request);

  const [editing, setEditing] = useState<TaskDef | "new" | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);

  const enabled = scripts.data?.enabled ?? false;
  const tasks = scripts.data?.tasks ?? [];

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
    const name = tasks.find((t) => t.id === id)?.name ?? "task";
    removeTask.mutate(id, {
      onSuccess: () => {
        setEditing(null);
        toast.success(`Deleted "${name}"`);
      },
      onError: (e) => toast.error(String(e)),
    });
  }

  const nav = listKeyboardNav({
    items: tasks,
    activeIndex,
    onActivate: (_item, to) => setActiveIndex(to),
    rowKey: (t) => t.id,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <LightningIcon className="size-4 text-muted-foreground" />
        <span className="text-xs font-medium">Tasks</span>
        {enabled && tasks.length > 0 && (
          <span className="text-xs text-muted-foreground">{tasks.length}</span>
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

      {scripts.isPending ? (
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
              Register a script to run it here. Tasks are shared across your
              repositories and run in whichever one is open.
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
            {tasks.map((task, index) => (
              <div key={task.id} className="flex items-center gap-1">
                <button
                  type="button"
                  data-row={task.id}
                  tabIndex={index === activeIndex ? 0 : -1}
                  onFocus={() => setActiveIndex(index)}
                  onClick={() => request(task)}
                  className={cn(
                    "flex min-w-0 flex-1 items-start gap-2 rounded px-2 py-1.5 text-left text-xs",
                    index === activeIndex
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-muted/60",
                  )}
                >
                  <PlayIcon className="mt-px size-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">
                        {task.name}
                      </span>
                      {task.args !== "" && (
                        <span
                          className="min-w-0 max-w-32 truncate font-mono text-[10px] text-muted-foreground"
                          title={task.args}
                        >
                          {task.args}
                        </span>
                      )}
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        {INTERPRETER_LABELS[task.interpreter] ??
                          task.interpreter}
                      </span>
                    </span>
                    {task.description !== "" && (
                      <span className="truncate text-[11px] text-muted-foreground">
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
                    <DropdownMenuItem onClick={() => request(task)}>
                      <PlayIcon data-icon="inline-start" />
                      Run
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setEditing(task)}>
                      <PencilSimpleIcon data-icon="inline-start" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => deleteTask(task.id)}
                    >
                      <TrashIcon data-icon="inline-start" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))}
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
