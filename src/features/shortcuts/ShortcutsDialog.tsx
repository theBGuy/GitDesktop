import { DIALOG_SCROLL } from "@/components/dialog-scroll";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatBinding } from "@/lib/hotkeys/binding";
import { useEffectiveBindings } from "@/lib/hotkeys/hotkeys";
import { ACTIONS, BUILT_IN_KEYS, CATEGORY_ORDER } from "@/lib/hotkeys/registry";
import { cn } from "@/lib/utils";

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="shrink-0 rounded-none border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
      {children}
    </kbd>
  );
}

/**
 * The complete, always-current shortcut reference — rendered from the action
 * registry with the user's own bindings, so it can't drift from reality.
 */
export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const bindings = useEffectiveBindings();
  const paletteBinding = bindings.get("command-palette");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Every action is rebindable in Settings → Keyboard. Unbound actions (
            — ) are still reachable from the command palette
            {paletteBinding ? ` (${formatBinding(paletteBinding)})` : ""}.
          </DialogDescription>
        </DialogHeader>
        <div
          className={cn(
            DIALOG_SCROLL,
            "grid max-h-[65vh] items-start gap-x-10 sm:grid-cols-2",
          )}
        >
          {CATEGORY_ORDER.map((category) => (
            <section key={category} className="mb-5">
              <h3 className="mb-1.5 text-xs font-semibold">{category}</h3>
              <ul className="space-y-1">
                {ACTIONS.filter((a) => a.category === category).map(
                  (action) => {
                    const binding = bindings.get(action.id);
                    return (
                      <li
                        key={action.id}
                        className="flex items-center justify-between gap-3 text-xs"
                      >
                        <span className="min-w-0 truncate">{action.label}</span>
                        {binding ? (
                          <Kbd>{formatBinding(binding)}</Kbd>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </li>
                    );
                  },
                )}
              </ul>
            </section>
          ))}
          <section className="mb-5">
            <h3 className="mb-1.5 text-xs font-semibold">Built-in</h3>
            <ul className="space-y-1">
              {BUILT_IN_KEYS.map((row) => (
                <li
                  key={row.keys}
                  className="flex items-center justify-between gap-3 text-xs"
                >
                  <span className="min-w-0">{row.what}</span>
                  <Kbd>
                    {row.binding ? formatBinding(row.binding) : row.keys}
                  </Kbd>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
