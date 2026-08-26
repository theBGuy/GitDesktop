import {
  CaretDownIcon,
  ChatCircleIcon,
  CircleDashedIcon,
  DotsThreeIcon,
  FilesIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  ListChecksIcon,
  PlayIcon,
  ShieldCheckIcon,
  SidebarSimpleIcon,
  TagIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Activity,
  type KeyboardEvent,
  lazy,
  type ReactNode,
  Suspense,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { LazyPanelFallback } from "@/components/lazy-panel-fallback";
import {
  PanelActivityBoundary,
  PanelPortalBoundary,
} from "@/components/panel-portal";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ActionsPanel } from "@/features/actions/ActionsPanel";
import { RunDetailView } from "@/features/actions/RunDetailView";
import { useRunNotifications } from "@/features/actions/useRunNotifications";
import { CodeTodoDetailView } from "@/features/code-todos/CodeTodoDetailView";
import { CodeTodosPanel } from "@/features/code-todos/CodeTodosPanel";
import { CommitBox } from "@/features/commit/CommitBox";
import { CommitDialog } from "@/features/commit/CommitDialog";
import { BranchDiffView } from "@/features/compare/BranchDiffView";
import { ComparePanel } from "@/features/compare/ComparePanel";
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import { DiscussionsPanel } from "@/features/discussions/DiscussionsPanel";
import { DiscussionView } from "@/features/discussions/DiscussionView";
import { BlameDialog } from "@/features/history/BlameDialog";
import { BlameFilePickerDialog } from "@/features/history/BlameFilePickerDialog";
import { CommitDetailView } from "@/features/history/CommitDetailView";
import { HistoryPanel } from "@/features/history/HistoryPanel";
import { IssuesPanel } from "@/features/issues/IssuesPanel";
import { JiraIssueView } from "@/features/issues/JiraIssueView";
import { LinearIssueView } from "@/features/issues/LinearIssueView";
import { LocalIssueView } from "@/features/issues/LocalIssueView";
import { RemoteIssueView } from "@/features/issues/RemoteIssueView";
import { CreateLocalPrDialog } from "@/features/pulls/CreateLocalPrDialog";
import { LocalPrView } from "@/features/pulls/LocalPrView";
import { PullRequestsPanel } from "@/features/pulls/PullRequestsPanel";
import { RemotePrView } from "@/features/pulls/RemotePrView";
import { useCleanupResolveWorktrees } from "@/features/pulls/useCleanupResolveWorktrees";
import { useWatchPrHeads } from "@/features/pulls/useWatchPrHeads";
import { RunTaskPicker } from "@/features/scripts/RunTaskPicker";
import { TaskRunConfirm } from "@/features/scripts/TaskRunConfirm";
import { TaskRunView } from "@/features/scripts/TaskRunView";
import { TasksPanel } from "@/features/scripts/TasksPanel";
import { FindingDetailView } from "@/features/security-findings/FindingDetailView";
import { FindingsPanel } from "@/features/security-findings/FindingsPanel";
import { TagDetailView } from "@/features/tags/TagDetailView";
import { TagsPanel } from "@/features/tags/TagsPanel";
import {
  forgeFeatureReady,
  useForgeSessionHealth,
  useForgeStatus,
  useRepoStatus,
} from "@/lib/git/queries";
import {
  bindingToAriaKeyshortcuts,
  formatBinding,
} from "@/lib/hotkeys/binding";
import { useEffectiveBindings, useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { useJiraLink, useJiraPermissions } from "@/lib/jira/queries";
import { useLinearLink } from "@/lib/linear/queries";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { useLensGate, useSetRepoLens } from "@/lib/repo-lens/queries";
import { useScripts } from "@/lib/scripts/queries";
import type { AppSettings } from "@/lib/settings/api";
import {
  settingsKeys,
  useAiEnabled,
  useRepoAlias,
  useSaveSettings,
  useSettings,
} from "@/lib/settings/queries";
import { useTaskRunStore } from "@/lib/stores/taskRun";
import {
  type RepoTab,
  type SelectedFinding,
  useUiStore,
} from "@/lib/stores/ui";
import { cn } from "@/lib/utils";
import { ChangesPanel } from "./ChangesPanel";
import { InsightsPanel } from "./insights/InsightsPanel";
import { OpRecoveryBanner } from "./OpRecoveryBanner";
import { PrCreateBanner } from "./PrCreateBanner";
import { RepoHeader } from "./RepoHeader";
import { usePrNotifications } from "./usePrNotifications";
import { useRepoVisibilityProbe } from "./useRepoVisibilityProbe";
import { WorktreeRemovalBanner } from "./WorktreeRemovalBanner";

// Base OS window title. In a `tauri dev` session (Vite serving) it gets a
// "(Dev)" suffix so the dev instance is tellable apart in the taskbar / Alt-Tab
// from an installed release — matching the tray tooltip set in `tray.rs`.
const APP_TITLE = import.meta.env.DEV ? "GitDesktop (Dev)" : "GitDesktop";

// The Insights board pulls in Recharts; lazy-load it so that chunk stays off
// the boot path and only loads once the user first opens the Insights tab.
const InsightsBoard = lazy(() =>
  import("./insights/InsightsBoard").then((m) => ({
    default: m.InsightsBoard,
  })),
);

// The Agent surface (write-capable sessions) is a heavy, AI-only graph; lazy it
// the same way so its chunk stays off the boot path until the Agent tab is first
// opened. Gated by `aiEnabled` too — with Hide AI on, it never loads.
const SessionList = lazy(() =>
  import("@/features/sessions/SessionList").then((m) => ({
    default: m.SessionList,
  })),
);
const SessionView = lazy(() =>
  import("@/features/sessions/SessionView").then((m) => ({
    default: m.SessionView,
  })),
);

// The diff viewer pulls in the @git-diff-view stack; lazy it so that chunk
// loads with the first diff render rather than on boot. It sits in the default
// "changes" tab, so the load happens on first paint (tens of ms from disk).
const DiffViewer = lazy(() =>
  import("@/features/diff/DiffViewer").then((m) => ({
    default: m.DiffViewer,
  })),
);

// Secondary surfaces live behind a "More ▾" overflow so the three primary tabs
// keep their full labels in the narrow tab rail. The trigger shows the active
// secondary tab's name (e.g. "Issues ▾") so the rail still says where you are.
// Compare keeps its `mod+3` shortcut here — the number keys bind per-tab, not by
// rail position, so it stays reachable exactly like the other secondary tabs.
const SECONDARY_TABS: { tab: RepoTab; label: string; ai?: boolean }[] = [
  { tab: "compare", label: "Compare" },
  { tab: "agent", label: "Agent", ai: true },
  { tab: "issues", label: "Issues" },
  { tab: "code-todos", label: "Code TODOs" },
  { tab: "discussions", label: "Discussions" },
  { tab: "actions", label: "Actions" },
  { tab: "findings", label: "Findings" },
  { tab: "tags", label: "Tags" },
  { tab: "tasks", label: "Tasks" },
  { tab: "insights", label: "Insights" },
];

// Remount key per finding variant: the category number sequences overlap, so
// the type tag has to be part of the key or two same-numbered findings would
// share one mounted detail pane.
const FINDING_KEY: {
  [K in SelectedFinding["type"]]: (
    f: Extract<SelectedFinding, { type: K }>,
  ) => string;
} = {
  alert: (f) => `a${f.number}`,
  codeScanning: (f) => `c${f.number}`,
  secretScanning: (f) => `s${f.number}`,
  glFinding: (f) => `gl:${f.category}:${f.id}`,
  advisory: (f) => `g${f.ghsaId}`,
};

// TS reduces the indexed union of entries to an uncallable intersection, so the
// correlation the map already encodes is asserted once, here.
function findingKey(f: SelectedFinding): string {
  return (FINDING_KEY[f.type] as (finding: SelectedFinding) => string)(f);
}

// Every repo tab panel goes through this: the <Activity> + boundary pairing is
// the invariant, and wrapping <Activity> alone re-mints the stranded-popup bug.
// Module scope is required — declared inside RepositoryView it would be a new
// component type each render, remounting every panel and losing the state
// <Activity> exists to preserve (filters, selections, scroll). <Activity>
// defers hidden panels' *effects* but NOT React Query fetches, so a heavy tab
// like Insights gates its queries on the panel's own `active`-style props.
function TabPanel({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Activity mode={active ? "visible" : "hidden"}>
      <PanelActivityBoundary active={active}>
        <PanelPortalBoundary>{children}</PanelPortalBoundary>
      </PanelActivityBoundary>
    </Activity>
  );
}

// The collapsed sidebar's icon rail. Icons follow the surfaces' house pairings:
// the changes list is FilesIcon (ComparePanel's "All changes" row), a commit is
// GitCommitIcon, a pull request GitPullRequestIcon — the same glyphs the detail
// placeholders in this file use.
const RAIL_TABS: {
  id: "changes" | "history" | "pulls";
  label: string;
  icon: typeof FilesIcon;
}[] = [
  { id: "changes", label: "Changes", icon: FilesIcon },
  { id: "history", label: "History", icon: GitCommitIcon },
  { id: "pulls", label: "PRs", icon: GitPullRequestIcon },
];

type RailId = (typeof RAIL_TABS)[number]["id"] | "more";

const RAIL_IDS: RailId[] = ["changes", "history", "pulls", "more"];

const RAIL_BUTTON_CLASS =
  "relative flex h-9 w-full shrink-0 items-center justify-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";
// Active carries a shape cue as well as the tokens — the edge bar is the
// vendored tab trigger's `after:` underline turned onto the rail's right edge.
const RAIL_ACTIVE_CLASS =
  "bg-accent text-accent-foreground after:absolute after:inset-y-0 after:right-0 after:w-0.5 after:bg-foreground";
const RAIL_IDLE_CLASS =
  "text-muted-foreground hover:bg-muted/60 hover:text-foreground";

/**
 * The four tab affordances of the collapsed sidebar: the three primary tabs plus
 * the same More overflow menu. Module scope (like TabPanel) so it isn't a fresh
 * component type each render. Selection stays in settings/ui state; the rail only
 * owns which of its buttons the roving tabindex sits on.
 */
function SidebarRail({
  repoTab,
  onChangeTab,
  onSelectSecondary,
  secondaryTabs,
  activeSecondaryLabel,
  taskRunning,
  toggle,
}: {
  repoTab: RepoTab;
  onChangeTab: (tab: RepoTab) => void;
  /** Picking a secondary tab also expands the sidebar — its list is the surface. */
  onSelectSecondary: (tab: RepoTab) => void;
  secondaryTabs: { tab: RepoTab; label: string }[];
  activeSecondaryLabel: string | null;
  taskRunning: boolean;
  /** The expand control, pinned to the rail's foot. An action, not a tab: it
   *  stays out of the arrow-key order and is reached by Tab. */
  toggle: ReactNode;
}) {
  const activeId: RailId =
    RAIL_TABS.find((t) => t.id === repoTab)?.id ?? "more";
  // The roving target follows the active surface until an arrow key moves it:
  // More opens a menu rather than switching tabs, so focus there has no
  // selection to derive itself from.
  const [focusedId, setFocusedId] = useState<RailId | null>(null);
  const currentId = focusedId ?? activeId;
  const railNav = listKeyboardNav<RailId>({
    items: RAIL_IDS,
    activeIndex: RAIL_IDS.indexOf(currentId),
    onActivate: (id) => {
      setFocusedId(id);
      if (id !== "more") onChangeTab(id);
    },
    rowKey: (id) => id,
    rowAttr: "data-rail-tab",
  });
  // Capture phase: the More button is a Base UI menu trigger, which opens the
  // menu on ArrowUp/ArrowDown and stops the event before it could bubble to the
  // rail. Arrows rove the rail; Enter/Space/click still open the menu.
  function onKeyDownCapture(e: KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if (!(e.target instanceof HTMLElement)) return;
    // Only the tab buttons rove — the toggle shares the rail but is an action.
    if (e.target.closest("[data-rail-tab]") === null) return;
    // An open menu owns the arrows: a pointer-opened popup can leave focus on
    // the trigger, and its own list navigation must win there.
    if (e.target.closest("[data-popup-open]") !== null) return;
    e.stopPropagation();
    railNav(e);
  }

  const moreLabel = activeSecondaryLabel ?? "More tabs";
  const moreRunning = taskRunning && repoTab !== "tasks";

  return (
    <nav
      aria-label="Repository tabs"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      onKeyDownCapture={onKeyDownCapture}
    >
      {RAIL_TABS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          data-rail-tab={id}
          tabIndex={id === currentId ? 0 : -1}
          aria-current={id === activeId ? "page" : undefined}
          aria-label={label}
          title={label}
          onClick={() => {
            setFocusedId(id);
            onChangeTab(id);
          }}
          className={cn(
            RAIL_BUTTON_CLASS,
            id === activeId ? RAIL_ACTIVE_CLASS : RAIL_IDLE_CLASS,
          )}
        >
          <Icon className="size-4" />
        </button>
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger
          title={moreRunning ? `${moreLabel} — a task is running` : moreLabel}
          render={
            <button
              type="button"
              data-rail-tab="more"
              tabIndex={currentId === "more" ? 0 : -1}
              aria-current={activeId === "more" ? "page" : undefined}
              aria-label={moreLabel}
              onClick={() => setFocusedId("more")}
              className={cn(
                RAIL_BUTTON_CLASS,
                activeId === "more" ? RAIL_ACTIVE_CLASS : RAIL_IDLE_CLASS,
              )}
            />
          }
        >
          <DotsThreeIcon className="size-4" weight="bold" />
          {moreRunning && (
            <span
              className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-primary ring-2 ring-background"
              aria-hidden
            />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right" className="min-w-44">
          {secondaryTabs.map(({ tab, label }) => (
            <DropdownMenuItem
              key={tab}
              onClick={() => onSelectSecondary(tab)}
              className={cn(
                repoTab === tab && "bg-accent text-accent-foreground",
              )}
            >
              {label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* `mt-auto`: the toggle sits at the rail's foot, separated from the tabs
          by whatever height is left, without a row of its own. */}
      <div className="mt-auto">{toggle}</div>
    </nav>
  );
}

export function RepositoryView() {
  const repoPath = useUiStore((s) => s.repoPath);
  const closeRepo = useUiStore((s) => s.closeRepo);
  const repoName = useUiStore((s) => s.repoName);
  const repoTab = useUiStore((s) => s.repoTab);
  const setRepoTab = useUiStore((s) => s.setRepoTab);
  const requestCreate = useUiStore((s) => s.requestCreate);
  const selectedCommitHash = useUiStore((s) => s.selectedCommitHash);
  const compareCommitHash = useUiStore((s) => s.compareCommitHash);
  const compareBranch = useUiStore((s) => s.compareBranch);
  const selectedPr = useUiStore((s) => s.selectedPr);
  const selectedIssue = useUiStore((s) => s.selectedIssue);
  const selectedDiscussion = useUiStore((s) => s.selectedDiscussion);
  const selectedRunId = useUiStore((s) => s.selectedRunId);
  const selectedFinding = useUiStore((s) => s.selectedFinding);
  const selectedTag = useUiStore((s) => s.selectedTag);
  const selectedTodo = useUiStore((s) => s.selectedTodo);
  const localPrCreate = useUiStore((s) => s.localPrCreate);
  const closeLocalPrCreate = useUiStore((s) => s.closeLocalPrCreate);
  const openCommitDialog = useUiStore((s) => s.openCommitDialog);
  // The detail panes run off deferred selections so rapidly arrowing a list
  // (commits, PRs) only loads + renders the item landed on, not every one
  // passed. The lists' own highlights use the live values, so they stay snappy.
  const deferredCommitHash = useDeferredValue(selectedCommitHash);
  const deferredCompareCommitHash = useDeferredValue(compareCommitHash);
  const deferredPr = useDeferredValue(selectedPr);
  const deferredIssue = useDeferredValue(selectedIssue);
  const deferredDiscussion = useDeferredValue(selectedDiscussion);
  const deferredTag = useDeferredValue(selectedTag);
  const deferredTodo = useDeferredValue(selectedTodo);
  const status = useRepoStatus(repoPath ?? "");
  const alias = useRepoAlias(repoPath);
  // The write-capable agent is an AI feature — hide its tab when AI is hidden.
  const aiEnabled = useAiEnabled();
  const branchHead = status.data?.branch;
  const currentName = branchHead?.name ?? null;
  // A detached HEAD (mid-rebase, or a raw `git checkout <sha>`) has no branch
  // name — show `detached @ <oid>` in the OS title bar so it keeps context
  // instead of collapsing to the bare repo name (mirrors BranchSwitcher's
  // label). `currentName` stays the real branch name for Compare, which is
  // correctly unavailable while detached.
  const headLabel = branchHead?.detached
    ? `detached @ ${branchHead.oid?.slice(0, 7) ?? "?"}`
    : currentName;
  const gh = useForgeStatus(repoPath ?? "");
  // Palette create actions: discussion stays a GitHub-only write; the issue /
  // PR / release creates follow their per-action forge flags (GitHub + GitLab).
  const canGh =
    Boolean(gh.data?.installed && gh.data?.authenticated && gh.data?.repo) &&
    gh.data?.provider === "github";
  const canCreateIssue = forgeFeatureReady(gh.data, "issueCreate");
  const canCreatePr = forgeFeatureReady(gh.data, "mrCreate");
  const canCreateRelease = forgeFeatureReady(gh.data, "releaseCreate");
  // Jira create is a separate axis (a linked project, not the git host); gate on
  // a link AND the project's createIssues permission. These queries dedupe with
  // IssuesPanel's identical keys, so registering the fallback here adds no fetch.
  const jiraLink = useJiraLink(repoPath ?? "");
  const jiraPerms = useJiraPermissions(repoPath ?? "", jiraLink.data);
  const canCreateJira =
    !!jiraLink.data && (jiraPerms.data?.createIssues ?? false);
  // Linear create: gated on a linked team (no project-level permission check —
  // Linear's API key is user-scoped). Dedupes with IssuesPanel's identical key.
  const linearLink = useLinearLink(repoPath ?? "");
  const canCreateLinear = !!linearLink.data;
  // Tab switches are transitions: a heavy first render of the target panel
  // never blocks the click, and hidden Activities pre-render at low priority.
  const [, startTabTransition] = useTransition();
  // Mount the (lazy, Recharts-heavy) Insights board only once its tab is first
  // opened, then keep it mounted — <Activity> preserves its state. This keeps
  // its chunk + heavy queries off the boot path until the user opens Insights.
  const [insightsSeen, setInsightsSeen] = useState(false);
  if (repoTab === "insights" && !insightsSeen) setInsightsSeen(true);
  // Same latch for the (lazy) Agent surface: mount it once its tab is first
  // opened, then keep it mounted so <Activity> preserves session state. Keeps
  // the agent chunk off the boot path until the user opens the Agent tab.
  const [agentSeen, setAgentSeen] = useState(false);
  if (repoTab === "agent" && !agentSeen) setAgentSeen(true);
  // Palette "Blame file…": the picker (open state) and, once a file is picked,
  // the path to blame (worktree blame — no rev). Kept here (always mounted) so
  // the palette can reach it from any tab.
  const [blamePickerOpen, setBlamePickerOpen] = useState(false);
  const [blamePath, setBlamePath] = useState<string | null>(null);
  // Palette "Run a task…": the picker's open state, kept here (always mounted) so
  // the palette can reach it from any tab. Gated on tasks being enabled + present.
  const [runTaskPickerOpen, setRunTaskPickerOpen] = useState(false);
  const scripts = useScripts();
  const tasksEnabled = scripts.data?.enabled ?? false;
  const hasTasks = (scripts.data?.tasks.length ?? 0) > 0;
  // A running task shows a dot on the "More" trigger when you're on another tab.
  const taskRunning = useTaskRunStore((s) => s.activeRun?.status === "running");
  // Sidebar collapse: persisted, and only ever flipped by the user (the toggle,
  // the shortcut, or the palette) — the app never collapses it on their behalf.
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const queryClient = useQueryClient();
  const sidebarCollapsed = settings.data?.sidebarCollapsed ?? false;
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const sidebarPanelsId = useId();
  const sidebarBinding = useEffectiveBindings().get("toggle-sidebar") ?? null;
  // Holds the collapse value whose commit should hand focus to the toggle (null
  // = nothing pending). Each mode renders its own toggle, so the hand-off can
  // only happen once the new one exists — and it is consumed on that commit
  // rather than from a frame scheduled in the handler, because the preference
  // lives in react-query, whose notify-batched re-render can land after one.
  const refocusToggleRef = useRef<boolean | null>(null);
  // A hand-off frame is scheduled but hasn't landed. Focus sits on <body> for
  // that whole window (longer still if the window is backgrounded, where rAF is
  // suspended), so a rejection arriving inside it must read as "focus is ours".
  const handoffRef = useRef(false);

  // OS notifications for PR/check and workflow-run events while this repo is open.
  usePrNotifications(repoPath ?? "");
  useRunNotifications(repoPath ?? "");
  // Auto re-review open LOCAL PRs whose head branch gets new commits — pr-sync,
  // gated by the runner's opt-in + the heads that mode already covered. (Remote PR
  // heads come from usePrNotifications above and the background sync poller.)
  useWatchPrHeads(repoPath ?? "");
  // Reclaim any local-PR resolve worktrees leaked by a crash mid-resolve (runs
  // once per repo, after the local-PR list loads so active ones are spared).
  useCleanupResolveWorktrees(repoPath ?? "");
  // Refresh the repo's stored visibility badge on every open (fire-and-forget).
  useRepoVisibilityProbe(repoPath);

  function changeTab(tab: RepoTab) {
    startTabTransition(() => setRepoTab(tab));
  }

  /** The one writer for the collapse preference.
   *  @returns whether it actually changed — false while settings are still
   *  loading, or when the preference already held `next`. Callers arming
   *  follow-up work on the transition gate on it. */
  function setSidebarCollapsed(next: boolean): boolean {
    const current = settings.data;
    if (!current || current.sidebarCollapsed === next) return false;
    // Focus sitting in the sidebar (or in flight to it, mid hand-off) is about
    // to be hidden (the panels) or unmounted (this mode's toggle, the rail), so
    // it can't be re-homed until the new mode has rendered its own toggle — arm
    // the hand-off for that commit rather than focusing a node this flip is
    // about to take away.
    if (
      handoffRef.current ||
      sidebarRef.current?.contains(document.activeElement)
    ) {
      refocusToggleRef.current = next;
    }
    const updated = { ...current, sidebarCollapsed: next };
    // Patch the cache before persisting: the flip has to land this render, or a
    // fast double-press reads the stale value and re-issues it — one flip, not
    // two. A failed write restores the previous value synchronously, so the
    // hand-off can ride the rollback's own commit.
    queryClient.setQueryData(settingsKeys.settings, updated);
    saveSettings.mutate(updated, {
      onError: () => {
        // Only roll back if this call's change is still the latest: otherwise a
        // late-failing earlier write would stomp a newer successful one (two
        // fast presses where the first write rejects after the second lands).
        const latest = queryClient.getQueryData<AppSettings>(
          settingsKeys.settings,
        );
        if (latest?.sidebarCollapsed !== next) return;
        if (
          handoffRef.current ||
          sidebarRef.current?.contains(document.activeElement)
        ) {
          refocusToggleRef.current = !next;
        }
        queryClient.setQueryData(settingsKeys.settings, current);
      },
    });
    return true;
  }

  function toggleSidebar() {
    setSidebarCollapsed(!sidebarCollapsed);
  }

  // A secondary tab's own list IS the sidebar, so picking one from the collapsed
  // rail expands it — selecting into a hidden list would be a dead end. The menu
  // returns focus to the rail trigger it is about to unmount, so the toggle
  // claims it instead.
  function selectSecondaryFromRail(tab: RepoTab) {
    changeTab(tab);
    if (setSidebarCollapsed(false)) refocusToggleRef.current = false;
  }

  // Tab switching mirrors GitHub Desktop's Ctrl+1–4 by default.
  useHotkeyAction("tab-changes", () => changeTab("changes"));
  useHotkeyAction("tab-history", () => changeTab("history"));
  useHotkeyAction("tab-compare", () => changeTab("compare"));
  useHotkeyAction("tab-pulls", () => changeTab("pulls"));
  useHotkeyAction("tab-issues", () => changeTab("issues"));
  useHotkeyAction("tab-discussions", () => changeTab("discussions"));
  useHotkeyAction("tab-actions", () => changeTab("actions"));
  useHotkeyAction("tab-findings", () => changeTab("findings"));
  useHotkeyAction("tab-tags", () => changeTab("tags"));
  useHotkeyAction("tab-insights", () => changeTab("insights"));
  useHotkeyAction("tab-code-todos", () => changeTab("code-todos"));
  useHotkeyAction("tab-tasks", () => changeTab("tasks"));
  // The Agent tab only exists when AI features are shown (palette-only binding).
  useHotkeyAction("tab-agent", () => changeTab("agent"), aiEnabled);
  useHotkeyAction("toggle-sidebar", toggleSidebar);
  useHotkeyAction("back-to-repositories", closeRepo);
  // Palette "Run a task…": open the picker from any tab (only when there are
  // tasks to run and running is enabled).
  useHotkeyAction(
    "run-task",
    () => setRunTaskPickerOpen(true),
    tasksEnabled && hasTasks,
  );

  // Create actions registered here (always mounted) so the command palette can
  // reach them from any tab: each switches to the owning tab and flags its panel
  // to open its dialog. The panels also register these while visible (newest
  // wins), so on-tab the panel's own handler opens directly with full context.
  useHotkeyAction("create-local-issue", () => requestCreate("local-issue"));
  useHotkeyAction("create-issue", () => requestCreate("issue"), canCreateIssue);
  useHotkeyAction(
    "create-jira-issue",
    () => requestCreate("jira-issue"),
    canCreateJira,
  );
  useHotkeyAction(
    "create-linear-issue",
    () => requestCreate("linear-issue"),
    canCreateLinear,
  );
  useHotkeyAction("create-pr", () => requestCreate("pr"), canCreatePr);
  useHotkeyAction("create-local-pr", () => requestCreate("local-pr"));
  useHotkeyAction(
    "create-discussion",
    () => requestCreate("discussion"),
    canGh,
  );
  useHotkeyAction(
    "create-release",
    () => requestCreate("release"),
    canCreateRelease,
  );
  useHotkeyAction("create-tag", () => requestCreate("tag"));
  // Palette-only "Blame file…": open the fuzzy tracked-file picker from any tab.
  useHotkeyAction("blame-file", () => setBlamePickerOpen(true));
  // Palette "Open commit dialog": enabled whenever a repo is open — the dialog
  // explains an un-committable state itself, so opening it empty still tells the
  // user where they stand.
  useHotkeyAction("open-commit-dialog", openCommitDialog);

  // Fork/upstream lens (PR + Issues surfaces). Wired ONCE here — not in the
  // panels, which can be mounted together under <Activity> (double-register).
  // Absolute set-actions (idempotent), gated on the lens applying (GitHub fork).
  const lensGate = useLensGate(repoPath ?? "");
  const setRepoLens = useSetRepoLens(repoPath ?? "");
  useHotkeyAction("repo-lens-origin", () => setRepoLens("origin"), lensGate);
  useHotkeyAction(
    "repo-lens-upstream",
    () => setRepoLens("upstream"),
    lensGate,
  );

  // Palette "Reconnect forge session": github/gitlab open the reconnect dialog
  // (mode from health — a signed-out host needs a fresh login, since `gh auth
  // refresh` errors when no account exists; anything else refreshes); bitbucket
  // has no in-app flow, so it deep-links to Settings → Accounts. Gated on a
  // known provider (nothing to reconnect otherwise).
  const openReconnect = useUiStore((s) => s.openReconnect);
  const openSettings = useUiStore((s) => s.openSettings);
  const sessionHealth = useForgeSessionHealth(repoPath ?? "");
  const forgeProvider = gh.data?.provider ?? null;
  useHotkeyAction(
    "reconnect-forge-session",
    () => {
      if (forgeProvider === "github" || forgeProvider === "gitlab") {
        openReconnect({
          provider: forgeProvider,
          host:
            gh.data?.host ??
            sessionHealth.data?.host ??
            (forgeProvider === "gitlab" ? "gitlab.com" : "github.com"),
          mode:
            sessionHealth.data?.state === "notConnected" ? "login" : "refresh",
        });
      } else if (forgeProvider === "bitbucket") {
        openSettings("accounts");
      }
    },
    // Gate on health having RESOLVED for github/gitlab: the mode below is derived from
    // `sessionHealth.data`, and while it's undefined the derivation would default to
    // "refresh" — wrong for a never-signed-in host. Defaulting to "login" instead was
    // rejected because `gh auth login` re-requests the DEFAULT scope set (silently
    // narrowing extra granted scopes like `workflow`), while `refresh` preserves them —
    // so the mode decision must never be made blind. Bitbucket needs no health probe (it
    // deep-links to Settings), so it stays enabled on a known provider alone.
    forgeProvider === "bitbucket" ||
      (forgeProvider !== null && sessionHealth.data !== undefined),
  );

  // "repo • branch" in the OS title bar (and Alt-Tab) while a repo is open. No
  // cleanup here: a branch switch updates the title in one pass instead of
  // flashing through the bare base title (the cleanup used to run on every
  // dep change, racing the async setTitle).
  useEffect(() => {
    const display = alias ?? repoName;
    if (!display) return;
    const title = headLabel ? `${display} • ${headLabel}` : display;
    getCurrentWindow()
      .setTitle(`${title} — ${APP_TITLE}`)
      .catch(() => undefined);
  }, [repoName, alias, headLabel]);
  useLayoutEffect(() => {
    if (refocusToggleRef.current === null) return;
    const matched = refocusToggleRef.current === sidebarCollapsed;
    refocusToggleRef.current = null;
    if (!matched) return;
    // One frame, inside the commit that rendered the new mode's toggle: a Base
    // UI menu returns focus to its (now unmounted) trigger as it closes and
    // would otherwise win.
    handoffRef.current = true;
    requestAnimationFrame(() => {
      handoffRef.current = false;
      sidebarToggleRef.current?.focus();
    });
  }, [sidebarCollapsed]);

  // Reset to the bare title only when the repo view unmounts (repo closed).
  useEffect(() => {
    return () => {
      getCurrentWindow()
        .setTitle(APP_TITLE)
        .catch(() => undefined);
    };
  }, []);

  if (!repoPath) return null;

  const secondaryTabs = SECONDARY_TABS.filter((t) => aiEnabled || !t.ai);
  const activeSecondary = secondaryTabs.find((t) => t.tab === repoTab);
  // Tooltip = the action with its effective shortcut appended, e.g. "Collapse
  // sidebar (Ctrl+Shift+B)"; unbound leaves the bare label. `aria-keyshortcuts`
  // carries the chord on the ARIA channel so it stays out of the button's name.
  const sidebarToggleLabel = sidebarCollapsed
    ? "Expand sidebar"
    : "Collapse sidebar";
  const sidebarToggleTitle =
    sidebarBinding === null
      ? sidebarToggleLabel
      : `${sidebarToggleLabel} (${formatBinding(sidebarBinding)})`;
  // One toggle with two homes — the tab row while expanded, the icon rail's foot
  // while collapsed — and exactly one mounted at a time (each home renders under
  // the opposite condition), so both can carry the ref the focus-return effect
  // aims at.
  function sidebarToggleButton(className: string) {
    return (
      <button
        ref={sidebarToggleRef}
        type="button"
        aria-label={sidebarToggleLabel}
        aria-expanded={!sidebarCollapsed}
        aria-controls={sidebarPanelsId}
        aria-keyshortcuts={
          sidebarBinding === null
            ? undefined
            : bindingToAriaKeyshortcuts(sidebarBinding)
        }
        title={sidebarToggleTitle}
        onClick={toggleSidebar}
        className={className}
      >
        <SidebarSimpleIcon className="size-4" />
      </button>
    );
  }
  // Panel activity for the ASIDE's tabs: a collapsed sidebar draws none of them,
  // and Activity defers a hidden panel's effects but not its queries — so the
  // polls and scans (line counts, runs, findings, the TODO git-grep) stand down
  // with the panel that would show them. The main pane keeps its own condition:
  // its detail view is what the user is looking at while the sidebar is closed.
  function sidebarTabActive(tab: RepoTab): boolean {
    return repoTab === tab && !sidebarCollapsed;
  }
  // One source for panel visibility: ChangesPanel gates its line-count poll on
  // the same flag that shows the panel, so the two can't drift apart.
  const changesActive = sidebarTabActive("changes");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RepoHeader repoPath={repoPath} />
      <OpRecoveryBanner repoPath={repoPath} />
      <WorktreeRemovalBanner repoPath={repoPath} />
      <PrCreateBanner repoPath={repoPath} />
      <div className="flex min-h-0 flex-1">
        {/* The sidebar shares the window's shrink with the content pane: it
            gives up width down to a 288px floor (the narrowest that still fits
            its toolbars) instead of the content pane absorbing every pixel. */}
        <aside
          ref={sidebarRef}
          className={cn(
            "flex shrink-0 flex-col border-r",
            sidebarCollapsed ? "w-12" : "w-[clamp(288px,32vw,384px)]",
          )}
        >
          {sidebarCollapsed && (
            <SidebarRail
              repoTab={repoTab}
              onChangeTab={changeTab}
              onSelectSecondary={selectSecondaryFromRail}
              secondaryTabs={secondaryTabs}
              activeSecondaryLabel={activeSecondary?.label ?? null}
              taskRunning={taskRunning}
              toggle={sidebarToggleButton(
                cn(RAIL_BUTTON_CLASS, RAIL_IDLE_CLASS),
              )}
            />
          )}
          {/* Hidden, never unmounted: the panels keep the state their Activity
              wrappers exist to preserve (filters, selections, scroll) across a
              collapse round-trip, and `hidden` also takes them out of the tab
              order and the accessibility tree. */}
          <div
            id={sidebarPanelsId}
            className={cn(
              "flex min-h-0 flex-1 flex-col",
              sidebarCollapsed && "hidden",
            )}
          >
            <Tabs
              value={repoTab}
              onValueChange={(value) => changeTab(value as RepoTab)}
            >
              <TabsList className="w-full">
                <TabsTrigger value="changes" className="min-w-0 flex-1">
                  <span className="min-w-0 truncate">Changes</span>
                </TabsTrigger>
                <TabsTrigger value="history" className="min-w-0 flex-1">
                  <span className="min-w-0 truncate">History</span>
                </TabsTrigger>
                <TabsTrigger value="pulls" className="min-w-0 flex-1">
                  <span className="min-w-0 truncate">PRs</span>
                </TabsTrigger>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    title={
                      taskRunning && repoTab !== "tasks"
                        ? "A task is running"
                        : undefined
                    }
                    render={
                      <button
                        type="button"
                        aria-label="More tabs"
                        className={cn(
                          "relative inline-flex h-[calc(100%-1px)] shrink-0 items-center justify-center gap-1 rounded-none border border-transparent px-2 text-xs font-medium whitespace-nowrap text-foreground/60 transition-all hover:text-foreground data-popup-open:text-foreground dark:text-muted-foreground dark:hover:text-foreground [&_svg]:size-4 [&_svg]:shrink-0",
                          activeSecondary &&
                            "bg-background text-foreground dark:border-input dark:bg-input/30 dark:text-foreground",
                        )}
                      />
                    }
                  >
                    {taskRunning && repoTab !== "tasks" && (
                      <span
                        className="size-1.5 shrink-0 rounded-full bg-primary"
                        aria-hidden
                      />
                    )}
                    <span className="max-w-24 truncate">
                      {activeSecondary?.label ?? "More"}
                    </span>
                    <CaretDownIcon data-icon="inline-end" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-44">
                    {secondaryTabs.map(({ tab, label }) => (
                      <DropdownMenuItem
                        key={tab}
                        onClick={() => changeTab(tab)}
                        className={cn(
                          repoTab === tab && "bg-accent text-accent-foreground",
                        )}
                      >
                        {label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                {/* Rides the tab row rather than a strip of its own: the three
                    triggers are `flex-1 min-w-0` and truncate, so this and the
                    More button (both `shrink-0`) come out of label width. */}
                {!sidebarCollapsed &&
                  sidebarToggleButton(
                    "inline-flex h-[calc(100%-1px)] w-7 shrink-0 items-center justify-center rounded-none border border-transparent text-foreground/60 outline-none transition-all hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset dark:text-muted-foreground dark:hover:text-foreground [&_svg]:shrink-0",
                  )}
              </TabsList>
            </Tabs>
            <TabPanel active={changesActive}>
              <ChangesPanel repoPath={repoPath} active={changesActive} />
              <CommitBox repoPath={repoPath} />
            </TabPanel>
            <TabPanel active={sidebarTabActive("history")}>
              <HistoryPanel repoPath={repoPath} />
            </TabPanel>
            <TabPanel active={sidebarTabActive("compare")}>
              <ComparePanel repoPath={repoPath} />
            </TabPanel>
            <TabPanel active={sidebarTabActive("pulls")}>
              <PullRequestsPanel repoPath={repoPath} />
            </TabPanel>
            <TabPanel active={sidebarTabActive("issues")}>
              <IssuesPanel repoPath={repoPath} />
            </TabPanel>
            <TabPanel active={sidebarTabActive("discussions")}>
              <DiscussionsPanel repoPath={repoPath} />
            </TabPanel>
            <TabPanel active={sidebarTabActive("actions")}>
              <ActionsPanel
                repoPath={repoPath}
                active={sidebarTabActive("actions")}
              />
            </TabPanel>
            <TabPanel active={sidebarTabActive("findings")}>
              <FindingsPanel
                repoPath={repoPath}
                active={sidebarTabActive("findings")}
              />
            </TabPanel>
            <TabPanel active={sidebarTabActive("tags")}>
              <TagsPanel repoPath={repoPath} />
            </TabPanel>
            <TabPanel active={sidebarTabActive("insights")}>
              <InsightsPanel
                repoPath={repoPath}
                active={sidebarTabActive("insights")}
              />
            </TabPanel>
            <TabPanel active={sidebarTabActive("code-todos")}>
              <CodeTodosPanel
                repoPath={repoPath}
                active={sidebarTabActive("code-todos")}
              />
            </TabPanel>
            <TabPanel active={sidebarTabActive("tasks")}>
              <TasksPanel />
            </TabPanel>
            {aiEnabled && (
              <TabPanel active={sidebarTabActive("agent")}>
                {agentSeen && (
                  <Suspense
                    fallback={
                      <LazyPanelFallback
                        name="agent sessions"
                        className="min-h-0 flex-1 gap-1.5"
                        rows={[
                          "h-7 w-20",
                          "h-8 w-full",
                          "h-14 w-full",
                          "h-14 w-full",
                          "h-14 w-full",
                        ]}
                      />
                    }
                  >
                    <SessionList repoPath={repoPath} />
                  </Suspense>
                )}
              </TabPanel>
            )}
          </div>
        </aside>
        <main className="min-w-0 flex-1">
          <TabPanel active={repoTab === "changes"}>
            {/* rows={[]}: this boundary is on the boot path and DiffViewer's
                resting state is a centered placeholder — skeleton bars would
                flash where the app otherwise paints nothing. */}
            <Suspense
              fallback={<LazyPanelFallback name="the diff" rows={[]} />}
            >
              <DiffViewer repoPath={repoPath} />
            </Suspense>
          </TabPanel>
          <TabPanel active={repoTab === "history"}>
            {deferredCommitHash ? (
              <CommitDetailView repoPath={repoPath} hash={deferredCommitHash} />
            ) : (
              <DiffPlaceholder
                icon={GitCommitIcon}
                message="Select a commit to see its changes"
              />
            )}
          </TabPanel>
          <TabPanel active={repoTab === "compare"}>
            {deferredCompareCommitHash ? (
              <CommitDetailView
                repoPath={repoPath}
                hash={deferredCompareCommitHash}
              />
            ) : compareBranch &&
              currentName &&
              compareBranch !== currentName ? (
              <BranchDiffView
                repoPath={repoPath}
                base={compareBranch}
                compare={currentName}
              />
            ) : (
              <DiffPlaceholder
                icon={GitBranchIcon}
                message="Pick a branch to compare against"
              />
            )}
          </TabPanel>
          <TabPanel active={repoTab === "pulls"}>
            {deferredPr?.kind === "remote" ? (
              <RemotePrView
                repoPath={repoPath}
                number={Number(deferredPr.id)}
              />
            ) : deferredPr?.kind === "local" ? (
              <LocalPrView repoPath={repoPath} id={deferredPr.id} />
            ) : (
              <DiffPlaceholder
                icon={GitPullRequestIcon}
                message="Select a pull request"
              />
            )}
          </TabPanel>
          <TabPanel active={repoTab === "issues"}>
            {deferredIssue?.kind === "remote" ? (
              <RemoteIssueView
                repoPath={repoPath}
                number={Number(deferredIssue.id)}
              />
            ) : deferredIssue?.kind === "local" ? (
              <LocalIssueView repoPath={repoPath} id={deferredIssue.id} />
            ) : deferredIssue?.kind === "jira" ? (
              <JiraIssueView repoPath={repoPath} issueKey={deferredIssue.id} />
            ) : deferredIssue?.kind === "linear" ? (
              <LinearIssueView
                repoPath={repoPath}
                issueIdentifier={deferredIssue.id}
              />
            ) : (
              <DiffPlaceholder
                icon={CircleDashedIcon}
                message="Select an issue"
              />
            )}
          </TabPanel>
          <TabPanel active={repoTab === "discussions"}>
            {deferredDiscussion ? (
              <DiscussionView
                repoPath={repoPath}
                number={deferredDiscussion.number}
              />
            ) : (
              <DiffPlaceholder
                icon={ChatCircleIcon}
                message="Select a discussion"
              />
            )}
          </TabPanel>
          <TabPanel active={repoTab === "actions"}>
            {selectedRunId !== null ? (
              <RunDetailView
                key={selectedRunId}
                repoPath={repoPath}
                runId={selectedRunId}
                active={repoTab === "actions"}
              />
            ) : (
              <DiffPlaceholder
                icon={PlayIcon}
                message="Select a workflow run"
              />
            )}
          </TabPanel>
          <TabPanel active={repoTab === "findings"}>
            {selectedFinding ? (
              <FindingDetailView
                key={findingKey(selectedFinding)}
                repoPath={repoPath}
                active={repoTab === "findings"}
              />
            ) : (
              <DiffPlaceholder
                icon={ShieldCheckIcon}
                message="Select a finding"
              />
            )}
          </TabPanel>
          <TabPanel active={repoTab === "tags"}>
            {deferredTag ? (
              <TagDetailView repoPath={repoPath} tag={deferredTag.tag} />
            ) : (
              <DiffPlaceholder icon={TagIcon} message="Select a tag" />
            )}
          </TabPanel>
          <TabPanel active={repoTab === "code-todos"}>
            {deferredTodo ? (
              <CodeTodoDetailView
                repoPath={repoPath}
                path={deferredTodo.path}
                line={deferredTodo.line}
                marker={deferredTodo.marker}
                text={deferredTodo.text}
              />
            ) : (
              <DiffPlaceholder icon={ListChecksIcon} message="Select a TODO" />
            )}
          </TabPanel>
          <TabPanel active={repoTab === "tasks"}>
            <TaskRunView />
          </TabPanel>
          <TabPanel active={repoTab === "insights"}>
            {insightsSeen && (
              <Suspense
                fallback={
                  <LazyPanelFallback
                    name="insights"
                    className="grid auto-rows-min grid-cols-1 gap-4 overflow-hidden p-4 xl:grid-cols-2"
                    rows={[
                      "h-6 w-24 xl:col-span-2",
                      "h-52 w-full",
                      "h-52 w-full",
                      "h-52 w-full xl:col-span-2",
                    ]}
                  />
                }
              >
                <InsightsBoard
                  repoPath={repoPath}
                  active={repoTab === "insights"}
                />
              </Suspense>
            )}
          </TabPanel>
          {aiEnabled && (
            <TabPanel active={repoTab === "agent"}>
              {agentSeen && (
                <Suspense
                  fallback={
                    <LazyPanelFallback
                      name="the agent session"
                      className="gap-3 p-3"
                      rows={["h-7 w-40", "h-24 w-full", "h-40 w-full"]}
                    />
                  }
                >
                  <SessionView repoPath={repoPath} />
                </Suspense>
              )}
            </TabPanel>
          )}
        </main>
      </div>

      {/* Palette "Blame file…": pick a tracked file, then blame its worktree
          contents (no rev — "blame this file as it is now"). */}
      <BlameFilePickerDialog
        repoPath={repoPath}
        open={blamePickerOpen}
        onOpenChange={setBlamePickerOpen}
        onPick={setBlamePath}
      />
      {blamePath && (
        <BlameDialog
          repoPath={repoPath}
          path={blamePath}
          open
          onOpenChange={(o) => {
            if (!o) setBlamePath(null);
          }}
        />
      )}
      {/* Hoisted: its success handler navigates to the Pulls tab, so a
          panel-hosted instance would conceal with the tab that launched it
          mid-close and not finish closing until that tab is next shown. One
          instance here serves every opener. */}
      <CreateLocalPrDialog
        repoPath={repoPath}
        defaultHead={localPrCreate?.defaultHead}
        defaultBase={localPrCreate?.defaultBase}
        open={localPrCreate !== null}
        onOpenChange={(o) => {
          if (!o) closeLocalPrCreate();
        }}
      />
      {/* Hoisted: the commit path that outlives the inline box. A collapsed
          sidebar hides the aside's panels, so CommitBox's <Activity> tears down
          its effects and its `commit` hotkey with them. */}
      <CommitDialog repoPath={repoPath} />
      {/* Palette "Run a task…" picker + the shared run-confirmation dialog.
          Hoisted here so both are reachable from any tab. */}
      <RunTaskPicker
        open={runTaskPickerOpen}
        onOpenChange={setRunTaskPickerOpen}
      />
      <TaskRunConfirm />
    </div>
  );
}
