import { useSelector } from "@tanstack/react-store";
import { useRef, useState } from "react";

type SubmitFlag = { readonly isSubmitting: boolean };

/** The slice of a form-core form the hold reads: its store and live state. */
type DraftCreateForm = {
  readonly store: {
    get: () => SubmitFlag;
    subscribe: (listener: (value: SubmitFlag) => void) => {
      unsubscribe: () => void;
    };
  };
  readonly state: SubmitFlag;
};

export type DraftCreateHold = {
  /** Render value: the draft on screen has a create running. */
  running: boolean;
  /** Live twin of `running`, for handlers, seeds and clean-ups. */
  isRunning: () => boolean;
  /** The live generation of the draft the form holds. */
  draft: () => number;
  /** The form now holds another draft. */
  nextDraft: () => void;
  /** The form still holds generation `gen`'s draft. */
  holds: (gen: number) => boolean;
  /** Records the current draft's create as running; `end` clears only its own record. */
  begin: () => { gen: number; end: () => void };
};

/**
 * Form-core keeps one `isSubmitting` per form: a reseed clears it, and an older
 * draft's settle clears it again under a newer draft's running create, so the
 * hold also reads the draft's own record. The flag stays in the union because
 * form-core sets it synchronously at the press, before any await.
 */
export function useDraftCreateHold(form: DraftCreateForm): DraftCreateHold {
  const flag = useSelector(form.store, (s) => s.isSubmitting);
  const genRef = useRef(0);
  const [gen, setGen] = useState(0);
  const runningRef = useRef<number | null>(null);
  const [runningGen, setRunningGen] = useState<number | null>(null);
  return {
    running: flag || runningGen === gen,
    isRunning: () =>
      form.state.isSubmitting || runningRef.current === genRef.current,
    draft: () => genRef.current,
    nextDraft: () => {
      genRef.current += 1;
      setGen(genRef.current);
    },
    holds: (g) => genRef.current === g,
    begin: () => {
      const g = genRef.current;
      runningRef.current = g;
      setRunningGen(g);
      return {
        gen: g,
        end: () => {
          if (runningRef.current !== g) return;
          runningRef.current = null;
          setRunningGen(null);
        },
      };
    },
  };
}
