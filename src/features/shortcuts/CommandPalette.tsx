import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatBinding } from "@/lib/hotkeys/binding";
import {
  dispatchAction,
  useAvailableActions,
  useEffectiveBindings,
} from "@/lib/hotkeys/hotkeys";
import { ACTIONS, type ActionId } from "@/lib/hotkeys/registry";
import { matchesActionText, queryTokens } from "@/lib/hotkeys/search";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import { cn } from "@/lib/utils";

/**
 * Searchable list of every action that's runnable *right now* — actions
 * whose owning surface isn't mounted (or whose button would be disabled)
 * don't appear, so the palette can never do what the UI wouldn't allow.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const available = useAvailableActions();
  const bindings = useEffectiveBindings();
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // Fresh search every time the palette opens.
  useSeedOnOpen(open, () => {
    setQuery("");
    setHighlight(0);
  });

  const tokens = queryTokens(query);
  const items = ACTIONS.filter((a) => {
    if (a.id === "command-palette" || !available.has(a.id)) return false;
    return matchesActionText(tokens, a.label, a.category);
  });
  const highlighted = items[Math.min(highlight, items.length - 1)];

  // Keep the highlighted row in view while arrowing through.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls to whichever row carries the highlight
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-highlighted="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  function run(id: ActionId) {
    onOpenChange(false);
    // Let the dialog finish closing first so focus restoration can't fight
    // with whatever the action opens (popovers, dialogs, focused inputs).
    setTimeout(() => dispatchAction(id), 0);
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
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <div className="border-b p-2">
          <Input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Type a command…"
            aria-label="Search commands"
          />
        </div>
        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground break-all">
            No matching commands here.
          </p>
        ) : (
          <ul ref={listRef} className="max-h-80 overflow-y-auto py-1">
            {items.map((action, index) => {
              const binding = bindings.get(action.id);
              return (
                <li key={action.id}>
                  <button
                    type="button"
                    data-highlighted={index === highlight || undefined}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs",
                      index === highlight
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-muted/60",
                    )}
                    onMouseMove={() => setHighlight(index)}
                    onClick={() => run(action.id)}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {action.label}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {action.category}
                    </span>
                    {binding && (
                      <kbd className="shrink-0 rounded-none border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                        {formatBinding(binding)}
                      </kbd>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
