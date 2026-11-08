import { useUiStore } from "@/lib/stores/ui";
import { lastCheckoutReady, recordLastCheckout } from "./store";

// Side-effect module, imported once by App. It records EVERY landing, however
// it arrived (such as recents, picker, drop, clone, a worktree open, or the
// store navigators' direct repo switches), by watching `repoPath` rather than
// wrapping `openRepo`, which the navigators don't route through. A close
// (null) records nothing, and re-opening the same path fires no write.
const unsubscribe = useUiStore.subscribe((s, prev) => {
  if (s.repoPath === prev.repoPath || s.repoPath === null) return;
  void recordLastCheckout(s.repoPath);
});

// A dev re-execution of this module would otherwise stack a second listener.
import.meta.hot?.dispose(() => unsubscribe());

// The load starts at app start, so recents rows can hint from memory once it
// lands.
void lastCheckoutReady();
