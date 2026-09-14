import { PlayIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { clipTitle } from "@/lib/clip-title";
import { useScripts, useTaskRepoKeys } from "@/lib/scripts/queries";
import { taskInScope } from "@/lib/scripts/scope";
import { INTERPRETERS } from "@/lib/scripts/types";
import { useTaskRunStore } from "@/lib/stores/taskRun";
import { useUiStore } from "@/lib/stores/ui";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import { cn } from "@/lib/utils";

const INTERPRETER_LABELS: Record<string, string> = Object.fromEntries(
  INTERPRETERS.map((i) => [i.id, i.label]),
);

/**
 * The command-palette "Run a task…" picker: search the registered tasks and run
 * one. Hoisted at the repo level so it's reachable from any tab. Modeled on the
 * command palette (Dialog + filtered list + arrow/Enter).
 */
export function RunTaskPicker({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tasks = useScripts().data?.tasks ?? [];
  const repoPath = useUiStore((s) => s.repoPath);
  const { keys, settled } = useTaskRepoKeys(repoPath);
  const request = useTaskRunStore((s) => s.request);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useSeedOnOpen(open, () => {
    setQuery("");
    setHighlight(0);
  });

  const q = query.trim().toLowerCase();
  // Scope first: a task belonging to another repository is never offered here —
  // running it is the harm the scope prevents. Managing it lives in the panel.
  // The unsettled identity window offers nothing rather than classifying against
  // the raw path alone: under-offering for a beat is the safe direction, and the
  // same hold keeps this list and the panel from disagreeing.
  const items = settled
    ? tasks.filter(
        (t) =>
          taskInScope(t, keys) &&
          (!q ||
            t.name.toLowerCase().includes(q) ||
            t.description.toLowerCase().includes(q)),
      )
    : [];
  // ONE clamped cursor drives the Enter target, the rendered highlight, and the
  // arrow steps: the list shrinks under an open picker (a repo switch, the
  // settled flip), and clamping in only one of those places runs a row that no
  // row shows as selected. Empty list = -1, which indexes to undefined.
  const active = items.length > 0 ? Math.min(highlight, items.length - 1) : -1;
  const highlighted = items[active];

  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls to whichever row carries the highlight
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-highlighted="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function run(taskId: string) {
    const task = tasks.find((t) => t.id === taskId);
    onOpenChange(false);
    // Let the dialog close first so its confirm (if any) isn't fighting focus.
    if (task) setTimeout(() => void request(task), 0);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    // The steps read the CLAMPED cursor, not the stored one: a stale-high stored
    // value would otherwise step from a row the user never saw highlighted.
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length > 0)
        setHighlight(Math.min(active + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length > 0) setHighlight(Math.max(active - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlighted) run(highlighted.id);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-md" showCloseButton={false}>
        <DialogTitle className="sr-only">Run a task</DialogTitle>
        <div className="border-b p-2">
          <Input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Run a task…"
            aria-label="Search tasks"
          />
        </div>
        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            No matching tasks.
          </p>
        ) : (
          <ul ref={listRef} className="max-h-80 overflow-y-auto py-1">
            {items.map((task, index) => (
              <li key={task.id}>
                <button
                  type="button"
                  data-highlighted={index === active || undefined}
                  className={cn(
                    "flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs",
                    index === active
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-muted/60",
                  )}
                  onMouseMove={() => setHighlight(index)}
                  onClick={() => run(task.id)}
                >
                  <PlayIcon className="mt-px size-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span
                      className="truncate"
                      onMouseEnter={clipTitle(task.name)}
                    >
                      {task.name}
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
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    {INTERPRETER_LABELS[task.interpreter] ?? task.interpreter}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
