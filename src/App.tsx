import { DeviceMobileIcon } from "@phosphor-icons/react";
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
import { repoBasename } from "@/features/settings/mcp/shared";
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
import {
  useGitInstalled,
  useLanSharedRepos,
  useLanShareRepo,
  useLanStatus,
  useLanUnshareRepo,
} from "@/lib/git/queries";
import { useHotkeyAction, useHotkeysListener } from "@/lib/hotkeys/hotkeys";
import { reloadLocalPrs } from "@/lib/pulls/local";
import { useSaveSettings, useSettings } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { errorMessage } from "@/lib/tauri/invoke";
import { COLD_START } from "@/lib/test-mode";
import { useLatestRef } from "@/lib/use-latest-ref";

function App() {
  const view = useUiStore((s) => s.view);
  const openSettings = useUiStore((s) => s.openSettings);
  const openMcpBrowse = useUiStore((s) => s.openMcpBrowse);
  const openHelp = useUiStore((s) => s.openHelp);
  const toggleActivity = useUiStore((s) => s.toggleActivity);
  const repoPath = useUiStore((s) => s.repoPath);
  const repoName = useUiStore((s) => s.repoName);
  const gitInstalled = useGitInstalled();
  // Kept mounted app-wide so the LAN "Sharing ON" banner and the companion
  // settings panel share one 5s poller.
  const lanStatus = useLanStatus();
  const shareRepo = useLanShareRepo();
  const unshareRepo = useLanUnshareRepo();
  // Read even while sharing is off (same as the panel) so the share/unshare
  // palette twins gate correctly — exactly one is offered for the open repo.
  const sharedRepos = useLanSharedRepos({ enabled: true });
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

  // The LAN companion server serves whichever repo is open, so push the active
  // repo to the backend whenever it changes. Closing the repo pushes null, which
  // clears it so paired devices stop seeing the last repo (routes 409).
  useEffect(() => {
    invoke("lan_set_active_repo", { repoPath: repoPath ?? null }).catch(
      () => undefined,
    );
  }, [repoPath]);

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
  useHotkeyAction("open-companion-settings", () => openSettings("companion"));
  // Share/unshare the open repo with paired phones. These are complementary
  // palette twins: the palette only lists actions with an enabled handler, so
  // gating them on `alreadyShared` shows exactly one at a time (Share when the
  // open repo isn't shared, Unshare when it is). The compare is verbatim path
  // equality, matching CompanionSection (the stored-path-verbatim contract).
  const sharedMatch =
    repoPath !== null
      ? (sharedRepos.data?.find((r) => r.path === repoPath) ?? null)
      : null;
  const alreadyShared = sharedMatch !== null;
  // Share adds the open repo so it stays reachable even after you switch away.
  // A short success/error toast is the right feedback here (a terminal result,
  // not long-running state).
  useHotkeyAction(
    "lan-share-current-repo",
    () => {
      if (!repoPath) return;
      const name = repoName ?? repoBasename(repoPath);
      shareRepo.mutate(repoPath, {
        onSuccess: () => toast.success(`Shared ${name} with paired phones`),
        onError: (e) => toast.error(errorMessage(e)),
      });
    },
    Boolean(repoPath) && !alreadyShared,
  );
  // Unshare the twin: pass the matched entry's stored path verbatim (the frozen
  // contract). The unshared repo is by definition the OPEN one, so it stays
  // reachable until the user switches away — say so honestly.
  useHotkeyAction(
    "lan-unshare-current-repo",
    () => {
      if (!sharedMatch) return;
      const name = repoName ?? repoBasename(sharedMatch.path);
      unshareRepo.mutate(sharedMatch.path, {
        onSuccess: () =>
          toast.success(
            `Unshared ${name} — phones lose it when you switch repos.`,
          ),
        onError: (e) => toast.error(errorMessage(e)),
      });
    },
    Boolean(repoPath) && alreadyShared,
  );
  useHotkeyAction("show-help", openHelp);
  useHotkeyAction("toggle-notifications", toggleActivity);
  useHotkeyAction("show-shortcuts", () => setShortcutsOpen(true));
  useHotkeyAction("command-palette", () => setPaletteOpen(true));

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
        {/* A calm, layout-integrated banner while the LAN companion is sharing:
            a slim full-width strip in normal flow (shrink-0), above every screen,
            so it pushes content down and can't collide with header chrome. The
            screen container below is flex-1/min-h-0, so the app still fits the
            viewport without a page scrollbar. Text-labeled (never color alone);
            click to manage. */}
        {lanStatus.data?.enabled && (
          <button
            type="button"
            onClick={() => openSettings("companion")}
            title="Phone companion is sharing this repo on your local network — click to manage"
            className="flex h-6 shrink-0 items-center justify-center gap-1.5 border-b border-info/40 bg-info/10 text-[11px] font-medium text-info transition-colors hover:bg-info/20"
          >
            <DeviceMobileIcon className="size-3.5" />
            Sharing on
          </button>
        )}
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
