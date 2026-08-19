import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { eventToBinding, formatBinding } from "./binding";
import { useEffectiveBindings } from "./hotkeys";

/** What a surface does when the generate chord fires there. */
export interface GenerateAction {
  /** Mirrors the visible Generate button's enabled state — including "not
   *  already generating", since a repeat must never abort a running stream. */
  enabled: boolean;
  run: () => void;
}

/**
 * The `generate-commit-message` chord, reused by whichever AI-generate surface
 * is on screen. Mount the returned `onKeyDown` on the dialog's DialogContent —
 * NOT the `<form>`: the X close button renders as a form SIBLING inside the
 * Popup, so a form-level handler misses a chord pressed with focus on X.
 *
 * The binding comes from the user's effective bindings (never a literal chord),
 * so a Settings → Keyboard rebind drives every surface at once; null = the user
 * cleared it, and the chord stays fully inert.
 *
 * Swallowing follows the generator, not its enabled state: while this surface
 * HAS a generator the chord is swallowed on every match, before `enabled` is
 * consulted, so a disabled Generate can't let the chord reach the global
 * listener. `run` undefined means the surface has no generator at all — Hide-AI
 * removed it, or a shared dialog's host passes none — and the chord falls
 * through untouched instead. Nothing generates behind a dialog in that arm
 * either, because the only global handler is the commit box's: Hide-AI leaves
 * it registered but DISABLED, and the listener runs the newest ENABLED handler
 * or none; and off the Changes tab the commit box is unmounted, so it isn't
 * registered at all.
 *
 * Auto-repeat is dropped without swallowing, matching that global listener —
 * holding the chord must not re-fire before the generating flag lands.
 */
export function useGenerateChord({
  enabled,
  run,
}: {
  enabled: boolean;
  run?: () => void;
}): {
  onKeyDown: (e: React.KeyboardEvent) => void;
  /** " (Ctrl+G)" — append to a Generate button's `title`; "" when unbound. */
  hint: string;
  binding: string | null;
} {
  const binding = useEffectiveBindings().get("generate-commit-message") ?? null;
  return {
    onKeyDown: (e) => {
      if (binding === null || run === undefined || e.repeat) return;
      if (eventToBinding(e) !== binding) return;
      e.preventDefault();
      if (enabled) run();
    },
    hint: bindingHint(binding),
    binding,
  };
}

/** The chord's title suffix on its own, for a Generate button whose chord is
 *  owned by an ancestor (see {@link GenerateActionContext}). */
export function useGenerateChordHint(): string {
  return bindingHint(
    useEffectiveBindings().get("generate-commit-message") ?? null,
  );
}

function bindingHint(binding: string | null): string {
  return binding === null ? "" : ` (${formatBinding(binding)})`;
}

/** A published action plus the shell key (section id) that owns it. */
interface PublishedGenerateAction extends GenerateAction {
  key: string;
}

/** Where a nested surface hands its generate action to the ancestor that owns
 *  the chord. */
interface GenerateActionSink {
  /** The shell key the subtree currently being rendered belongs to. */
  activeKey: string;
  publish: (action: PublishedGenerateAction) => void;
  /** Identity-paired with `publish`, so a retraction can only clear its own. */
  retract: (action: PublishedGenerateAction) => void;
}

export const GenerateActionContext = createContext<GenerateActionSink | null>(
  null,
);

/**
 * Shell side of {@link GenerateActionContext}, for a container that owns the
 * chord but not the generator — a settings dialog whose sections come and go.
 * Provide `sink` on the context and call `runPublished` from the chord handler;
 * the swallow stays unconditional, so the chord can never leak out of the
 * shell, and a section without a generator makes it a no-op.
 *
 * `activeKey` is what makes the published action safe to run. Under an
 * `AnimatePresence mode="wait"` crossfade the OUTGOING section stays mounted —
 * and published — for the whole fade, and its successor mounts only once that
 * finishes: the successor can never clobber, but the section the user just left
 * would otherwise answer the chord, starting a stream into a form that is
 * unmounting and whose Cancel affordance is already gone. So a published action
 * runs only while its key is still the shell's active one.
 */
export function useGenerateActionSink(activeKey: string): {
  sink: GenerateActionSink;
  runPublished: () => void;
} {
  // A ref, not state: the value is only ever read at keydown time, and a
  // re-render per publish would fight the section crossfade.
  const current = useRef<PublishedGenerateAction | null>(null);
  const fns = useMemo(
    () => ({
      publish: (action: PublishedGenerateAction) => {
        current.current = action;
      },
      retract: (action: PublishedGenerateAction) => {
        if (current.current === action) current.current = null;
      },
    }),
    [],
  );
  const sink = useMemo<GenerateActionSink>(
    () => ({ activeKey, ...fns }),
    [activeKey, fns],
  );
  return {
    sink,
    runPublished: () => {
      const action = current.current;
      if (action?.key === activeKey && action.enabled) action.run();
    },
  };
}

/** Section side of {@link GenerateActionContext}: publishes this surface's
 *  generate action while it's mounted, and returns the chord hint for its
 *  Generate button. No provider ⇒ inert, so a section still renders standalone. */
export function usePublishGenerateAction(
  enabled: boolean,
  run: () => void,
): { hint: string } {
  const sink = useContext(GenerateActionContext);
  const hint = useGenerateChordHint();
  // The key this section mounted under. Two host constraints keep it honest:
  // the shell's crossfade retains the EXITING subtree's element — provider
  // included — so an outgoing section keeps reading the sink it rendered with,
  // never its successor's; and that subtree is keyed by section, so it remounts
  // per section rather than carrying a stale snapshot across a switch.
  const keyRef = useRef(sink?.activeKey ?? null);
  // No dep array: `run` is a fresh closure on most renders and republishing is
  // a single ref write, so re-running every render is cheaper than comparing.
  useEffect(() => {
    const key = keyRef.current;
    if (!sink || key === null) return;
    const action: PublishedGenerateAction = { key, enabled, run };
    sink.publish(action);
    return () => sink.retract(action);
  });
  return { hint };
}
