import { canGoBack, canGoForward } from "@/lib/stores/nav-history";
import { useUiStore } from "@/lib/stores/ui";
import { useHotkeyAction } from "./hotkeys";
import { focusInOpenModal } from "./open-modal";

/** Registers Go back and Go forward for the whole app. Mounted once, by App.
 *  An empty direction keeps its registration, disabled, so the chord is still
 *  consumed rather than reaching the webview's native back. A modal holding focus
 *  stands both down at fire time; App's own dialogs and the gated ones come in as
 *  `dialogOpen`. */
export function useNavHistoryActions(dialogOpen: boolean): void {
  const canBack = useUiStore(canGoBack);
  const canForward = useUiStore(canGoForward);
  useHotkeyAction(
    "go-back",
    () => {
      if (focusInOpenModal()) return;
      useUiStore.getState().goBack();
    },
    canBack && !dialogOpen,
  );
  useHotkeyAction(
    "go-forward",
    () => {
      if (focusInOpenModal()) return;
      useUiStore.getState().goForward();
    },
    canForward && !dialogOpen,
  );
}
