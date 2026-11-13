import { useLayoutEffect } from "react";
import { useLensState } from "@/lib/repo-lens/queries";
import { useUiStore } from "@/lib/stores/ui";

/** Keeps the history's lens stamp in step with the live lens of the open repository. */
export function useNavLensSync(repoPath: string | null): void {
  const { lens, answered } = useLensState(repoPath ?? "");
  const stamp = useUiStore((s) => s.navHistory.lens);
  const syncNavLens = useUiStore((s) => s.syncNavLens);
  // Compares the live lens with the history's stamp, never with a previous render,
  // so a flip made while this view was unmounted is caught on remount; `stamp` as a
  // dep re-stamps a history re-seeded behind the hook (a repo switch). A layout
  // effect, so the re-seed lands in the commit that renders the flipped lens.
  useLayoutEffect(() => {
    if (repoPath === null || !answered || stamp === lens) return;
    syncNavLens(repoPath, lens);
  }, [repoPath, answered, lens, stamp, syncNavLens]);
}
