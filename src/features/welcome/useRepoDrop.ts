import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { validateRepo } from "@/lib/git/api";
import { useAddRecentRepo } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { useLatestRef } from "@/lib/use-latest-ref";

/**
 * Opens a git repository by dropping its folder onto the window. Subscribes
 * once; reads the latest store action / mutation via getState + a ref so the
 * native drag-drop handler isn't re-registered on every render.
 */
export function useRepoDrop() {
  const addRecent = useAddRecentRepo();
  const addRecentRef = useLatestRef(addRecent);

  useEffect(() => {
    const unlisten = getCurrentWindow().onDragDropEvent(async (event) => {
      if (event.payload.type !== "drop") return;
      const path = event.payload.paths[0];
      if (!path) return;
      try {
        const info = await validateRepo(path);
        // Await the recents write so the row exists before RepositoryView mounts
        // and its open-time visibility probe persists onto it (best-effort — a
        // settings-write failure must never block opening the repo).
        await addRecentRef.current
          .mutateAsync({ path: info.root, name: info.name })
          .catch(() => undefined);
        useUiStore.getState().openRepo(info);
      } catch (e) {
        // Not a git repo (or a file, not a folder) — surface why.
        toastError(e);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);
}
