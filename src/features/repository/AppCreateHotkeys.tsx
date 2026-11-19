import { forgeFeatureReady, useForgeStatus } from "@/lib/git/queries";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { useUiStore } from "@/lib/stores/ui";

/** The app-level `create-pr` and `create-local-pr` entries; renders nothing. */
export function AppCreateHotkeys({ repoPath }: { repoPath: string | null }) {
  const requestCreate = useUiStore((s) => s.requestCreate);
  const gh = useForgeStatus(repoPath ?? "");
  const canCreatePr = forgeFeatureReady(gh.data, "mrCreate");
  // App-level fallbacks that open the Pull requests tab's own create dialogs: a
  // panel's own registration, registered later, takes the action while enabled.
  // The gate reads the same forge-status value as the panels' gates, so a flip
  // re-registers both in one commit and the panel still registers last.
  useHotkeyAction("create-pr", () => requestCreate("pr"), canCreatePr);
  useHotkeyAction("create-local-pr", () => requestCreate("local-pr"));
  return null;
}
