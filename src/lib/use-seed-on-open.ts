import { useEffect, useEffectEvent, useRef } from "react";

/**
 * Runs `seed` once per open TRANSITION, not once per effect-mount. A hidden
 * `<Activity>` tab unmounts its subtree's effects and re-creates them on show,
 * so a bare `useEffect(() => { if (open) seed(); }, [open])` re-fires with the
 * dialog still open and blanks whatever the user had typed. The latch is a ref
 * because refs and state survive the hide — only effects re-mount — and a
 * conditionally-mounted dialog still seeds, since remounting gives it a fresh one.
 */
export function useSeedOnOpen(open: boolean, seed: () => void): void {
  const seeded = useRef(false);
  const run = useEffectEvent(seed);
  useEffect(() => {
    if (!open) {
      seeded.current = false;
      return;
    }
    // Latch BEFORE seeding: StrictMode's setup → cleanup → setup would
    // otherwise seed twice, and a seed that sets state re-enters this effect.
    if (seeded.current) return;
    seeded.current = true;
    run();
  }, [open]);
}
