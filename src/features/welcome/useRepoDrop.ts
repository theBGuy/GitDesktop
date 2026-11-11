import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { toast } from "sonner";
import {
  claimRepoOpen,
  useOpenRecordedRepo,
} from "@/features/repository/useOpenRepoByPath";
import { validateRepo } from "@/lib/git/api";
import { toastError } from "@/lib/toast";
import { useLatestRef } from "@/lib/use-latest-ref";

const IMAGE_DROP_HINT =
  "To add an image to a comment, paste it or use Attach image.";

/** An image dropped on the window is most likely meant for a comment. */
const IMAGE_PATH = /\.(png|jpe?g|gif|webp)$/i;

/**
 * Opens a git repository by dropping its folder onto the window. Subscribes
 * once; reads the latest open tail via a ref so the native drag-drop handler
 * isn't re-registered on every render.
 */
export function useRepoDrop() {
  const openRecorded = useOpenRecordedRepo();
  const openRecordedRef = useLatestRef(openRecorded);

  useEffect(() => {
    const unlisten = getCurrentWindow().onDragDropEvent(async (event) => {
      if (event.payload.type !== "drop") return;
      const path = event.payload.paths[0];
      if (!path) return;
      // Before the claim: an image drop is no open request, so it must not
      // retire one in flight.
      if (IMAGE_PATH.test(path)) {
        toast(IMAGE_DROP_HINT);
        return;
      }
      // Claimed before validating, as a Recents click is: the drop is the request,
      // so a later open wins over it and a slow validate can't retire that one.
      const stillCurrent = claimRepoOpen();
      try {
        const info = await validateRepo(path);
        await openRecordedRef.current(info, stillCurrent);
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
