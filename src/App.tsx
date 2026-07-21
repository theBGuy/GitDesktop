import { useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Spinner } from "@/components/ui/spinner";
import { ReconnectDialog } from "@/features/accounts/ReconnectDialog";
import { ActivityStrip } from "@/features/activity/ActivityDock";
import { AutomationResultDialog } from "@/features/automations/AutomationResultDialog";
import { HelpScreen } from "@/features/help/HelpScreen";
import { RepositoryView } from "@/features/repository/RepositoryView";
import { SettingsScreen } from "@/features/settings/SettingsScreen";
import { CommandPalette } from "@/features/shortcuts/CommandPalette";
import { ShortcutsDialog } from "@/features/shortcuts/ShortcutsDialog";
import { UpdateChecker } from "@/features/updates/UpdateChecker";
import { WhatsNew } from "@/features/updates/WhatsNew";
import { GitMissingScreen } from "@/features/welcome/GitMissingScreen";
import { useRepoDrop } from "@/features/welcome/useRepoDrop";
import { WelcomeScreen } from "@/features/welcome/WelcomeScreen";
import { syncAnalytics, track } from "@/lib/analytics";
import { useBackgroundPrSync } from "@/lib/automations/useBackgroundPrSync";
import { useGitInstalled } from "@/lib/git/queries";
import { useHotkeyAction, useHotkeysListener } from "@/lib/hotkeys/hotkeys";
import { reloadLocalPrs } from "@/lib/pulls/local";
import { reloadReviewNotes } from "@/lib/review-notes/store";
import { useSaveSettings, useSettings } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { COLD_START } from "@/lib/test-mode";
import { commitTheme, nextTheme, THEME_LABELS } from "@/lib/theme";
import { useLatestRef } from "@/lib/use-latest-ref";

function App() {
  const view = useUiStore((s) => s.view);
  const openSettings = useUiStore((s) => s.openSettings);
  const openMcpBrowse = useUiStore((s) => s.openMcpBrowse);
  const openHelp = useUiStore((s) => s.openHelp);
  const toggleActivity = useUiStore((s) => s.toggleActivity);
  const gitInstalled = useGitInstalled();
  const queryClient = useQueryClient();
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Show a one-time passive notice on first launch, letting users opt out.
  const noticeShown = useRef(false);
  // The notice lingers ~10s; read the LATEST settings at click/dismiss time (not
  // the value frozen when it was shown) so a setting changed in the meantime
  // isn't clobbered when we persist `seenAnalyticsNotice`.
  const settingsRef = useLatestRef(settings.data);
  useEffect(() => {
    if (
      !settings.data ||
      noticeShown.current ||
      settings.data.seenAnalyticsNotice ||
      COLD_START
    )
      return;
    noticeShown.current = true;
    const persist = (extra?: { analyticsEnabled: false }) => {
      const latest = settingsRef.current;
      if (latest)
        saveSettings.mutate({
          ...latest,
          ...extra,
          seenAnalyticsNotice: true,
        });
    };
    toast("GitDesktop sends anonymous usage data", {
      description:
        "No code, paths, or secrets — and no session recordings unless you opt in. Manage in Settings → General.",
      duration: 10000,
      action: {
        label: "Turn off",
        onClick: () => persist({ analyticsEnabled: false }),
      },
      onDismiss: () => persist(),
      onAutoClose: () => persist(),
    });
  }, [settings.data, saveSettings]);

  // Reconcile analytics (events) + replay (opt-in) when either setting changes
  // at runtime. main.tsx already initialized with the persisted values, so skip
  // the first run to avoid a double-init, then reconcile on later changes.
  const analyticsSynced = useRef(false);
  useEffect(() => {
    if (!settings.data) return;
    const { analyticsEnabled, recordReplay } = settings.data;
    if (!analyticsSynced.current) {
      analyticsSynced.current = true;
      return;
    }
    syncAnalytics(analyticsEnabled, recordReplay).catch(() => {
      // Best-effort — analytics failures never surface to the user.
    });
  }, [settings.data]);

  // Track screen changes.
  useEffect(() => {
    track({ name: "screen_viewed", properties: { screen: view } });
  }, [view]);

  // The backend owns the window-close behavior, so mirror the preference to it.
  const closeToTray = settings.data?.closeToTray;
  useEffect(() => {
    if (closeToTray === undefined) return;
    invoke("set_close_to_tray", { enabled: closeToTray }).catch(
      () => undefined,
    );
  }, [closeToTray]);

  // Drop a repo folder anywhere on the window to open it.
  useRepoDrop();

  // Keep pr-sync (auto re-review) automations firing for recent repos that
  // AREN'T the one currently open — the active repo's own poller covers it, but
  // this catches pushes to repos you've switched away from. Always mounted (any
  // view, welcome included); no-op unless a recent repo carries a pr-sync rule.
  useBackgroundPrSync();

  // The app-wide hotkey dispatcher plus the always-available actions.
  useHotkeysListener();
  useHotkeyAction("open-settings", openSettings);
  // Palette-only deep link; hidden alongside the panel when AI features are off.
  useHotkeyAction(
    "open-mcp-servers-settings",
    () => openSettings("mcp-servers"),
    !settings.data?.hideAi,
  );
  useHotkeyAction("browse-mcp-registry", openMcpBrowse, !settings.data?.hideAi);
  useHotkeyAction("show-help", openHelp);
  useHotkeyAction("toggle-notifications", toggleActivity);
  useHotkeyAction("show-shortcuts", () => setShortcutsOpen(true));
  useHotkeyAction("command-palette", () => setPaletteOpen(true));
  useHotkeyAction("cycle-theme", () => {
    const current = settingsRef.current;
    if (!current) return;
    // Step System → Light → Dark → Slate. Apply-on-change like the picker:
    // persist + toggle the class immediately (appearance prefs have no Save bar).
    const next = nextTheme(current.theme);
    saveSettings.mutate({ ...current, theme: next });
    commitTheme(next);
    toast.success(`Theme: ${THEME_LABELS[next]}`);
  });

  // The webview stays "visible" when the window loses focus, so TanStack's
  // own focus refetch never fires in Tauri; bridge the native focus event.
  useEffect(() => {
    const unlisten = getCurrentWindow().onFocusChanged(
      ({ payload: focused }) => {
        if (focused) {
          queryClient.invalidateQueries({ queryKey: ["repo"] });
          // The MCP server (with --allow-write) can mutate local-prs.json on
          // disk while we're unfocused; reload the in-memory store from disk
          // BEFORE invalidating so the refetch sees the external writes.
          reloadLocalPrs()
            .then(() =>
              queryClient.invalidateQueries({ queryKey: ["local-prs"] }),
            )
            .catch(() => {
              // Best-effort: a failed reload just leaves the last known state.
            });
          // Same story for review-notes.json — the MCP server can deposit a
          // per-branch reviewer note while we're unfocused; reload the store
          // from disk BEFORE invalidating so the refetch sees it.
          reloadReviewNotes()
            .then(() =>
              queryClient.invalidateQueries({ queryKey: ["review-notes"] }),
            )
            .catch(() => {
              // Best-effort: a failed reload just leaves the last known state.
            });
        }
      },
    );
    return () => {
      unlisten.then((f) => f());
    };
  }, [queryClient]);

  if (gitInstalled.isPending) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  }
  if (gitInstalled.isError) {
    return <GitMissingScreen onRetry={() => gitInstalled.refetch()} />;
  }

  return (
    <>
      <div className="flex h-screen flex-col">
        {view === "welcome" && <WelcomeScreen />}
        {view === "repo" && <RepositoryView />}
        {view === "settings" && <SettingsScreen />}
        {view === "help" && <HelpScreen />}
        {/* A thin activity strip for the headerless screens (the repo view uses
            its in-header dock instead); only present while a review runs. */}
        <ActivityStrip />
      </div>
      <AutomationResultDialog />
      <ReconnectDialog />
      <UpdateChecker />
      <WhatsNew />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      {COLD_START && (
        <div className="pointer-events-none fixed right-2 bottom-2 z-50 flex items-center gap-1.5 border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] font-medium text-warning">
          <span className="size-1.5 rounded-full bg-warning" />
          Cold-start test mode
        </div>
      )}
    </>
  );
}

export default App;
