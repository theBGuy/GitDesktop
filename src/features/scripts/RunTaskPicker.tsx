import { PlayIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useScripts } from "@/lib/scripts/queries";
import { INTERPRETERS } from "@/lib/scripts/types";
import { useTaskRunStore } from "@/lib/stores/taskRun";
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
  const request = useTaskRunStore((s) => s.request);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
    }
  }, [open]);

  const q = query.trim().toLowerCase();
  const items = tasks.filter(
    (t) =>
      !q ||
      t.name.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q),
  );
  const highlighted = items[Math.min(highlight, items.length - 1)];

  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls to whichever row carries the highlight
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-highlighted="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  function run(taskId: string) {
    const task = tasks.find((t) => t.id === taskId);
    onOpenChange(false);
    // Let the dialog close first so its confirm (if any) isn't fighting focus.
    if (task) setTimeout(() => request(task), 0);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
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
                  data-highlighted={index === highlight || undefined}
                  className={cn(
                    "flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs",
                    index === highlight
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-muted/60",
                  )}
                  onMouseMove={() => setHighlight(index)}
                  onClick={() => run(task.id)}
                >
                  <PlayIcon className="mt-px size-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{task.name}</span>
                    {task.description !== "" && (
                      <span className="truncate text-[11px] text-muted-foreground">
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
