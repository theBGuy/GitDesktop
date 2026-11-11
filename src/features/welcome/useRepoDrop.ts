import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { toast } from "sonner";
import {
  claimRepoOpen,
  reserveRepoOpen,
  useOpenRecordedRepo,
} from "@/features/repository/useOpenRepoByPath";
import { validateRepo } from "@/lib/git/api";
import { isAppError } from "@/lib/tauri/invoke";
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
      // A checkout's name can end in an image extension, so such a path is
      // asked about first. Its place in the request order is reserved at the
      // drop and claimed only once it proves a checkout: an image file is no
      // open request and must not retire one in flight.
      if (IMAGE_PATH.test(path)) {
        const reservation = reserveRepoOpen();
        let info: Awaited<ReturnType<typeof validateRepo>>;
        try {
          info = await validateRepo(path);
        } catch (e) {
          // Only a path git calls no repository is the image file; any other
          // refusal is git's reason about a checkout, shown as a drop shows it.
          if (isAppError(e) && e.kind === "notARepo") toast(IMAGE_DROP_HINT);
          else toastError(e);
          return;
        }
        const stillCurrent = reservation();
        if (!stillCurrent) return;
        try {
          await openRecordedRef.current(info, stillCurrent);
        } catch (e) {
          toastError(e);
        }
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
