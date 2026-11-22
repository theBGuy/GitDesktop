import { forgeFeatureReady, useForgeStatus } from "@/lib/git/queries";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { useUiStore } from "@/lib/stores/ui";

/** The app-level `create-pr` and `create-local-pr` entries; renders nothing. */
export function AppCreateHotkeys({ repoPath }: { repoPath: string | null }) {
  const requestCreate = useUiStore((s) => s.requestCreate);
  const gh = useForgeStatus(repoPath ?? "");
  const canCreatePr = forgeFeatureReady(gh.data, "mrCreate");
  // App-level fallbacks that open the Pull requests tab's own create dialogs:
  // the fallback tier lets a panel's own enabled entry take the action whatever
  // the registration order.
  useHotkeyAction("create-pr", () => requestCreate("pr"), canCreatePr, {
    tier: "fallback",
  });
  useHotkeyAction("create-local-pr", () => requestCreate("local-pr"), true, {
    tier: "fallback",
  });
  return null;
}
