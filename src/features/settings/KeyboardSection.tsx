import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react";
import { useSelector } from "@tanstack/react-store";
import { useEffect, useEffectEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { withForm } from "@/lib/form";
import { eventToBinding, formatBinding } from "@/lib/hotkeys/binding";
import { dispatchAction } from "@/lib/hotkeys/hotkeys";
import { ACTIONS, CATEGORY_ORDER } from "@/lib/hotkeys/registry";
import { cn } from "@/lib/utils";
import { settingsFormOpts } from "./settings-form";

/** Bindings must carry a real modifier or be a function key — anything a
 *  user could type into a text field is rejected during recording. */
function isBindableCombo(binding: string): boolean {
  if (/^f\d{1,2}$/.test(binding)) return true;
  return binding.includes("mod+") || binding.includes("alt+");
}

export const KeyboardSection = withForm({
  ...settingsFormOpts,
  render: function KeyboardSectionRender({ form }) {
    const overrides = useSelector(form.store, (s) => s.values.hotkeys);
    const [recordingId, setRecordingId] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);

    const effective = (id: string): string | null => {
      const override = overrides[id];
      if (override !== undefined) return override;
      return ACTIONS.find((a) => a.id === id)?.defaultBinding ?? null;
    };

    function setBinding(id: string, binding: string | null) {
      const next = { ...overrides };
      let stolenFrom: string | null = null;
      if (binding) {
        // A binding can only mean one thing: assigning it here unbinds
        // whichever action held it before.
        for (const action of ACTIONS) {
          if (action.id !== id && effective(action.id) === binding) {
            if (action.defaultBinding === null) delete next[action.id];
            else next[action.id] = null;
            stolenFrom = action.label;
          }
        }
      }
      const def = ACTIONS.find((a) => a.id === id)?.defaultBinding ?? null;
      if (binding === def) delete next[id];
      else next[id] = binding;
      form.setFieldValue("hotkeys", next);
      setNote(
        stolenFrom && binding
          ? `${formatBinding(binding)} was taken from "${stolenFrom}", which is now unbound.`
          : null,
      );
    }

    // While recording, capture every keypress before the app's own hotkey
    // dispatcher sees it. Esc cancels; Backspace/Delete unbinds; Tab cancels and
    // is allowed through so it never traps keyboard focus inside the row.
    const onRecordKey = useEffectEvent((e: KeyboardEvent) => {
      const id = recordingId;
      if (id === null) return;
      if (e.key === "Tab") {
        setRecordingId(null);
        return; // don't preventDefault — let focus move out of recording
      }
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecordingId(null);
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        setBinding(id, null);
        setRecordingId(null);
        return;
      }
      const binding = eventToBinding(e);
      if (!binding) return; // bare modifier — keep waiting
      if (!isBindableCombo(binding)) {
        setNote(
          `Shortcuts need a modifier (${formatBinding("mod")} or ${formatBinding("alt")}) or a function key, so they can't collide with typing.`,
        );
        return;
      }
      setBinding(id, binding);
      setRecordingId(null);
    });

    // Subscribe only while recording, not on every render.
    useEffect(() => {
      if (recordingId === null) return;
      const handler = (e: KeyboardEvent) => onRecordKey(e);
      window.addEventListener("keydown", handler, true);
      return () => window.removeEventListener("keydown", handler, true);
    }, [recordingId]);

    const overrideCount = Object.keys(overrides).length;

    return (
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-medium">Keyboard</h2>
          <p className="text-xs text-muted-foreground">
            Click a shortcut to record a new one — Esc cancels, Backspace
            unbinds. Unbound actions stay available in the command palette.
            Changes apply when you save.
          </p>
          {note && <p className="mt-1 text-xs text-warning">{note}</p>}
          {/* Announce recording state + notes to screen readers. */}
          <span role="status" aria-live="assertive" className="sr-only">
            {recordingId
              ? `Recording shortcut for ${
                  ACTIONS.find((a) => a.id === recordingId)?.label ?? "action"
                }. Press the new combination, or Escape to cancel.`
              : (note ?? "")}
          </span>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => dispatchAction("show-shortcuts")}
          >
            View all shortcuts
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={overrideCount === 0}
            onClick={() => {
              form.setFieldValue("hotkeys", {});
              setNote(null);
            }}
          >
            Reset all to defaults
          </Button>
        </div>
        {CATEGORY_ORDER.map((category) => (
          <div key={category}>
            <h3 className="mb-1 text-xs font-semibold">{category}</h3>
            <div className="divide-y border">
              {ACTIONS.filter((a) => a.category === category).map((action) => {
                const binding = effective(action.id);
                const overridden = overrides[action.id] !== undefined;
                const recording = recordingId === action.id;
                return (
                  <div
                    key={action.id}
                    className="flex items-center gap-2 px-2.5 py-1.5"
                  >
                    <span className="min-w-0 flex-1 truncate text-xs">
                      {action.label}
                    </span>
                    <button
                      type="button"
                      aria-label={
                        recording
                          ? `Recording shortcut for ${action.label}. Press the new combination, or Escape to cancel.`
                          : `Shortcut for ${action.label}: ${
                              binding ? formatBinding(binding) : "unbound"
                            }. Click to change.`
                      }
                      onClick={() =>
                        setRecordingId(recording ? null : action.id)
                      }
                      className={cn(
                        "shrink-0 border px-2 py-0.5 font-mono text-[11px]",
                        recording
                          ? "border-ring bg-accent text-accent-foreground"
                          : binding
                            ? "bg-muted text-foreground hover:border-ring"
                            : "text-muted-foreground hover:border-ring",
                      )}
                      title="Click, then press the new shortcut"
                    >
                      {recording
                        ? "Press keys…"
                        : binding
                          ? formatBinding(binding)
                          : "Unbound"}
                    </button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Reset ${action.label} to default`}
                      className={cn("shrink-0", !overridden && "invisible")}
                      onClick={() => {
                        const next = { ...overrides };
                        delete next[action.id];
                        form.setFieldValue("hotkeys", next);
                        setNote(null);
                      }}
                    >
                      <ArrowCounterClockwiseIcon />
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </section>
    );
  },
});
