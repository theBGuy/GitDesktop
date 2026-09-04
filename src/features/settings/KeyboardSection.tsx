import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react";
import { useSelector } from "@tanstack/react-store";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { withForm } from "@/lib/form";
import {
  bindingKey,
  eventToBinding,
  formatBinding,
  hasModifier,
  isTypeaheadKey,
} from "@/lib/hotkeys/binding";
import { dispatchAction, useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import {
  ACTIONS,
  type ActionDef,
  CATEGORY_ORDER,
} from "@/lib/hotkeys/registry";
import { matchesActionText, queryTokens } from "@/lib/hotkeys/search";
import { cn } from "@/lib/utils";
import { settingsFormOpts } from "./settings-form";

/** Keys refused without a modifier because they activate whatever has focus,
 *  on every surface. Space is deliberately NOT here — binding a single key to
 *  stage or select is the primary ask — so it binds, and the note on assignment
 *  carries its cost: a live bound action takes the keypress a focused button or
 *  checkbox would have used, and page scroll with it. */
const ACTIVATION_KEYS = new Set(["enter"]);

/** Keys that scroll or move a selection on their own. A bare binding on one
 *  preventDefaults it on every surface where the action is live, so list
 *  navigation and scrolling die app-wide. */
const NAV_KEYS = new Set([
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
]);

/** Without a modifier, only the activation and navigation keys above are
 *  refused: each already means something on every focused surface. Every other
 *  key binds, because the dispatcher holds modifier-less bindings back wherever
 *  the keystroke is already typing or driving a menu. */
function isBindableCombo(binding: string): boolean {
  if (hasModifier(binding)) return true;
  const key = bindingKey(binding);
  return !ACTIVATION_KEYS.has(key) && !NAV_KEYS.has(key);
}

/** What accepting a modifier-less binding costs. The menu-and-picker clause is
 *  true only of character keys, which is all typeahead consumes; Space earns a
 *  longer line, being the one bindable key whose native job is activating the
 *  focused control, so a live action takes that keypress instead. */
function consequenceNote(binding: string): string {
  const zones = isTypeaheadKey(binding)
    ? "while you're typing or in a menu or picker"
    : "while you're typing";
  const quiet = `${formatBinding(binding)} stays quiet ${zones}, and fires anywhere else`;
  return bindingKey(binding) === "space"
    ? `${quiet} — including on a focused button, where it replaces the button's own Space press.`
    : `${quiet}.`;
}

/** Why a refused key can't stand alone. The two sets collide with different
 *  things, so each names what the bare key would have taken over. */
function refusalNote(binding: string): string {
  return ACTIVATION_KEYS.has(bindingKey(binding))
    ? `Enter activates the focused control, so this shortcut needs ${formatBinding("mod")} or ${formatBinding("alt")} added.`
    : `That key scrolls and navigates on its own, so this shortcut needs ${formatBinding("mod")} or ${formatBinding("alt")} added.`;
}

export const KeyboardSection = withForm({
  ...settingsFormOpts,
  render: function KeyboardSectionRender({ form }) {
    const overrides = useSelector(form.store, (s) => s.values.hotkeys);
    const [recordingId, setRecordingId] = useState<string | null>(null);
    const [note, setNote] = useState<{
      text: string;
      /** The overrides-draft signature this note was posted under. */
      sig: string;
    } | null>(null);
    /** Signature over the overrides draft a note was posted under. A mismatch
     *  retires the note outright, so a draft that later returns to that signature
     *  can't resurrect a dismissed message. Steal and consequence notes describe
     *  the draft, so any route changing it — including the footer's Discard, which
     *  form.reset()s while this section stays mounted — retires them without
     *  knowing to clear them; the refusal note is advisory (an attempted key, not
     *  the draft), and retiring it early is the safe direction. */
    const draftSig = JSON.stringify(overrides);
    // Set during render of the component that owns the state: React's derived-state
    // reset, re-rendered before commit. An effect would commit — and announce — the
    // stale note for a frame first.
    if (note && note.sig !== draftSig) setNote(null);
    const visibleNote = note && note.sig === draftSig ? note.text : null;
    // View state only: the filter never touches the form, so it can't dirty
    // the Save/Discard bar or survive into saved settings.
    const [filter, setFilter] = useState("");
    const filterRef = useRef<HTMLInputElement>(null);

    // Settings replaces the repository view and its panels mount exclusively,
    // so this is the only live "focus-filter" handler while Keyboard is open.
    useHotkeyAction("focus-filter", () => filterRef.current?.focus(), true);

    const effective = (id: string): string | null => {
      const override = overrides[id];
      if (override !== undefined) return override;
      return ACTIONS.find((a) => a.id === id)?.defaultBinding ?? null;
    };

    /** Assigns or clears a binding. Reports whether it posted the steal message
     *  — that note outranks any softer one the caller would add — along with the
     *  signature of the draft it just wrote, so the caller's own note rides the
     *  same one. */
    function setBinding(
      id: string,
      binding: string | null,
    ): { stole: boolean; sig: string } {
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
      const sig = JSON.stringify(next);
      const stealNote =
        stolenFrom && binding
          ? `${formatBinding(binding)} was taken from "${stolenFrom}", which is now unbound.`
          : null;
      setNote(stealNote ? { text: stealNote, sig } : null);
      return { stole: stealNote !== null, sig };
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
        setNote({ text: refusalNote(binding), sig: draftSig });
        return;
      }
      // The assignment always stands; a modifier-less binding only earns a note
      // about where it stays quiet, and never over the steal message. (Chords
      // are exempt: the quiet zones named by the note don't apply to them.)
      const { stole, sig } = setBinding(id, binding);
      if (!stole && !hasModifier(binding)) {
        setNote({ text: consequenceNote(binding), sig });
      }
      setRecordingId(null);
    });

    // Subscribe only while recording, not on every render.
    useEffect(() => {
      if (recordingId === null) return;
      const handler = (e: KeyboardEvent) => onRecordKey(e);
      window.addEventListener("keydown", handler, true);
      return () => window.removeEventListener("keydown", handler, true);
    }, [recordingId]);

    const query = filter.trim().toLowerCase();
    const tokens = queryTokens(filter);

    /** Match over what the row shows, two ways. Label and category go through
     *  the shared action-text search (every word present, any order, hyphens
     *  ignored) so this list finds what the command palette finds. The binding
     *  arms stay literal substrings of the raw query, in both display
     *  ("Ctrl+Shift+P") and canonical ("mod+shift+p") form — tokenizing key
     *  text would match across separators that mean something here. "unbound"
     *  is the word for the empty binding, from three characters on, so typing
     *  toward it narrows instead of flashing the empty state ("un" still means
     *  the Unstage/Undo labels). */
    function matchesQuery(action: ActionDef): boolean {
      if (query === "") return true;
      if (matchesActionText(tokens, action.label, action.category)) return true;
      const binding = effective(action.id);
      if (binding === null)
        return query.length >= 3 && "unbound".startsWith(query);
      return (
        binding.includes(query) ||
        formatBinding(binding).toLowerCase().includes(query)
      );
    }

    const groups = CATEGORY_ORDER.map((category) => ({
      category,
      actions: ACTIONS.filter(
        (a) => a.category === category && matchesQuery(a),
      ),
    })).filter((group) => group.actions.length > 0);
    const shownCount = groups.reduce((n, group) => n + group.actions.length, 0);

    // A filter that hides the recording row cancels recording: the window-level
    // capture listener would otherwise keep swallowing keys for a row nobody
    // can see.
    const recordingHidden =
      recordingId !== null &&
      !groups.some((g) => g.actions.some((a) => a.id === recordingId));
    useEffect(() => {
      if (recordingHidden) setRecordingId(null);
    }, [recordingHidden]);

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
          {visibleNote && (
            <p className="mt-1 text-xs text-warning">{visibleNote}</p>
          )}
          {/* Announce recording state + notes to screen readers. */}
          <span role="status" aria-live="assertive" className="sr-only">
            {recordingId
              ? `Recording shortcut for ${
                  ACTIONS.find((a) => a.id === recordingId)?.label ?? "action"
                }. Press the new combination, or Escape to cancel.`
              : (visibleNote ?? "")}
          </span>
        </div>
        <div className="flex gap-2">
          <Input
            ref={filterRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            // Recording captures every keydown window-wide, so without this
            // the first thing typed here would be read as a binding attempt.
            onFocus={() => setRecordingId(null)}
            placeholder="Filter shortcuts"
            aria-label="Filter shortcuts"
            className="h-7 flex-1"
            autoComplete="off"
          />
          {/* Polite, so the filtered count queues behind the recording
              announcements above instead of interrupting them. */}
          <span role="status" aria-live="polite" className="sr-only">
            {query === ""
              ? ""
              : `${shownCount} ${shownCount === 1 ? "shortcut" : "shortcuts"} shown`}
          </span>
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
            onClick={() => form.setFieldValue("hotkeys", {})}
          >
            Reset all to defaults
          </Button>
        </div>
        {groups.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No shortcuts match — try an action name, category, or key.
          </p>
        ) : null}
        {groups.map(({ category, actions }) => (
          <div key={category}>
            <h3 className="mb-1 text-xs font-semibold">{category}</h3>
            <div className="divide-y border">
              {actions.map((action) => {
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
