import {
  CaretDownIcon,
  ChatCircleIcon,
  CircleDashedIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  ListChecksIcon,
  PlayIcon,
  TagIcon,
} from "@phosphor-icons/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Activity,
  lazy,
  Suspense,
  useDeferredValue,
  useEffect,
  useState,
  useTransition,
} from "react";
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
import { LocalIssueView } from "@/features/issues/LocalIssueView";
import { RemoteIssueView } from "@/features/issues/RemoteIssueView";
import { CreateLocalPrDialog } from "@/features/pulls/CreateLocalPrDialog";
import { LocalPrView } from "@/features/pulls/LocalPrView";
import { PullRequestsPanel } from "@/features/pulls/PullRequestsPanel";
import { RemotePrView } from "@/features/pulls/RemotePrView";
import { useCleanupResolveWorktrees } from "@/features/pulls/useCleanupResolveWorktrees";
import { useWatchPrHeads } from "@/features/pulls/useWatchPrHeads";
import { TagDetailView } from "@/features/tags/TagDetailView";
import { TagsPanel } from "@/features/tags/TagsPanel";
import {
  forgeFeatureReady,
  useForgeSessionHealth,
  useForgeStatus,
  useRepoStatus,
} from "@/lib/git/queries";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { useJiraLink, useJiraPermissions } from "@/lib/jira/queries";
import { useLensGate, useSetRepoLens } from "@/lib/repo-lens/queries";
import { useAiEnabled, useRepoAlias } from "@/lib/settings/queries";
import { type RepoTab, useUiStore } from "@/lib/stores/ui";
import { cn } from "@/lib/utils";
import { ChangesPanel } from "./ChangesPanel";
import { InsightsPanel } from "./insights/InsightsPanel";
import { OpRecoveryBanner } from "./OpRecoveryBanner";
import { RepoHeader } from "./RepoHeader";
import { usePrNotifications } from "./usePrNotifications";
import { useRepoVisibilityProbe } from "./useRepoVisibilityProbe";

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

// Secondary surfaces live behind a "More ▾" overflow so the four primary tabs
// keep their full labels in the fixed-width rail. The trigger shows the active
// secondary tab's name (e.g. "Issues ▾") so the rail still says where you are.
const SECONDARY_TABS: { tab: RepoTab; label: string; ai?: boolean }[] = [
  { tab: "agent", label: "Agent", ai: true },
  { tab: "issues", label: "Issues" },
  { tab: "code-todos", label: "Code TODOs" },
  { tab: "discussions", label: "Discussions" },
  { tab: "actions", label: "Actions" },
  { tab: "tags", label: "Tags" },
  { tab: "insights", label: "Insights" },
];

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
  const selectedTag = useUiStore((s) => s.selectedTag);
  const selectedTodo = useUiStore((s) => s.selectedTodo);
  const localPrCreate = useUiStore((s) => s.localPrCreate);
  const closeLocalPrCreate = useUiStore((s) => s.closeLocalPrCreate);
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

  // OS notifications for PR/check and workflow-run events while this repo is open.
  usePrNotifications(repoPath ?? "");
  useRunNotifications(repoPath ?? "");
  // Auto re-review open PRs (local + remote) whose head branch gets new
  // commits — pr-sync, gated by the runner's opt-in + per-mode watermark.
  useWatchPrHeads(repoPath ?? "");
  // Reclaim any local-PR resolve worktrees leaked by a crash mid-resolve (runs
  // once per repo, after the local-PR list loads so active ones are spared).
  useCleanupResolveWorktrees(repoPath ?? "");
  // Refresh the repo's stored visibility badge on every open (fire-and-forget).
  useRepoVisibilityProbe(repoPath);

  function changeTab(tab: RepoTab) {
    startTabTransition(() => setRepoTab(tab));
  }

  // Tab switching mirrors GitHub Desktop's Ctrl+1–4 by default.
  useHotkeyAction("tab-changes", () => changeTab("changes"));
  useHotkeyAction("tab-history", () => changeTab("history"));
  useHotkeyAction("tab-compare", () => changeTab("compare"));
  useHotkeyAction("tab-pulls", () => changeTab("pulls"));
  useHotkeyAction("tab-issues", () => changeTab("issues"));
  useHotkeyAction("tab-discussions", () => changeTab("discussions"));
  useHotkeyAction("tab-actions", () => changeTab("actions"));
  useHotkeyAction("tab-tags", () => changeTab("tags"));
  useHotkeyAction("tab-insights", () => changeTab("insights"));
  useHotkeyAction("tab-code-todos", () => changeTab("code-todos"));
  // The Agent tab only exists when AI features are shown (palette-only binding).
  useHotkeyAction("tab-agent", () => changeTab("agent"), aiEnabled);
  useHotkeyAction("back-to-repositories", closeRepo);

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
  // Reset to the bare title only when the repo view unmounts (repo closed).
  useEffect(() => {
    return () => {
      getCurrentWindow()
        .setTitle(APP_TITLE)
        .catch(() => undefined);
    };
  }, []);

  if (!repoPath) return null;

  // Panels live inside <Activity> so switching tabs preserves their state
  // (filters, selections, scroll) instead of unmounting them. <Activity> defers
  // hidden panels' *effects*, but NOT React Query fetches (those run during
  // render/commit) — so a heavy tab like Insights must gate its queries on its
  // own visibility, not rely on being hidden. See `active` below.
  const mode = (tab: RepoTab) => (repoTab === tab ? "visible" : "hidden");
  const secondaryTabs = SECONDARY_TABS.filter((t) => aiEnabled || !t.ai);
  const activeSecondary = secondaryTabs.find((t) => t.tab === repoTab);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RepoHeader repoPath={repoPath} />
      <OpRecoveryBanner repoPath={repoPath} />
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-96 shrink-0 flex-col border-r">
          <Tabs
            value={repoTab}
            onValueChange={(value) => changeTab(value as RepoTab)}
          >
            <TabsList className="w-full">
              <TabsTrigger value="changes" className="min-w-0 flex-1">
                Changes
              </TabsTrigger>
              <TabsTrigger value="history" className="min-w-0 flex-1">
                History
              </TabsTrigger>
              <TabsTrigger value="compare" className="min-w-0 flex-1">
                Compare
              </TabsTrigger>
              <TabsTrigger value="pulls" className="min-w-0 flex-1">
                PRs
              </TabsTrigger>
              <DropdownMenu>
                <DropdownMenuTrigger
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
                  {activeSecondary?.label ?? "More"}
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
            </TabsList>
          </Tabs>
          <Activity mode={mode("changes")}>
            <ChangesPanel repoPath={repoPath} />
            <CommitBox repoPath={repoPath} />
          </Activity>
          <Activity mode={mode("history")}>
            <HistoryPanel repoPath={repoPath} />
          </Activity>
          <Activity mode={mode("compare")}>
            <ComparePanel repoPath={repoPath} />
          </Activity>
          <Activity mode={mode("pulls")}>
            <PullRequestsPanel repoPath={repoPath} />
          </Activity>
          <Activity mode={mode("issues")}>
            <IssuesPanel repoPath={repoPath} />
          </Activity>
          <Activity mode={mode("discussions")}>
            <DiscussionsPanel repoPath={repoPath} />
          </Activity>
          <Activity mode={mode("actions")}>
            <ActionsPanel repoPath={repoPath} active={repoTab === "actions"} />
          </Activity>
          <Activity mode={mode("tags")}>
            <TagsPanel repoPath={repoPath} />
          </Activity>
          <Activity mode={mode("insights")}>
            <InsightsPanel
              repoPath={repoPath}
              active={repoTab === "insights"}
            />
          </Activity>
          <Activity mode={mode("code-todos")}>
            <CodeTodosPanel
              repoPath={repoPath}
              active={repoTab === "code-todos"}
            />
          </Activity>
          {aiEnabled && (
            <Activity mode={mode("agent")}>
              {agentSeen && (
                <Suspense fallback={null}>
                  <SessionList repoPath={repoPath} />
                </Suspense>
              )}
            </Activity>
          )}
        </aside>
        <main className="min-w-0 flex-1">
          <Activity mode={mode("changes")}>
            <Suspense fallback={null}>
              <DiffViewer repoPath={repoPath} />
            </Suspense>
          </Activity>
          <Activity mode={mode("history")}>
            {deferredCommitHash ? (
              <CommitDetailView repoPath={repoPath} hash={deferredCommitHash} />
            ) : (
              <DiffPlaceholder
                icon={GitCommitIcon}
                message="Select a commit to see its changes"
              />
            )}
          </Activity>
          <Activity mode={mode("compare")}>
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
          </Activity>
          <Activity mode={mode("pulls")}>
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
          </Activity>
          <Activity mode={mode("issues")}>
            {deferredIssue?.kind === "remote" ? (
              <RemoteIssueView
                repoPath={repoPath}
                number={Number(deferredIssue.id)}
              />
            ) : deferredIssue?.kind === "local" ? (
              <LocalIssueView repoPath={repoPath} id={deferredIssue.id} />
            ) : deferredIssue?.kind === "jira" ? (
              <JiraIssueView repoPath={repoPath} issueKey={deferredIssue.id} />
            ) : (
              <DiffPlaceholder
                icon={CircleDashedIcon}
                message="Select an issue"
              />
            )}
          </Activity>
          <Activity mode={mode("discussions")}>
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
          </Activity>
          <Activity mode={mode("actions")}>
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
          </Activity>
          <Activity mode={mode("tags")}>
            {deferredTag ? (
              <TagDetailView repoPath={repoPath} tag={deferredTag.tag} />
            ) : (
              <DiffPlaceholder icon={TagIcon} message="Select a tag" />
            )}
          </Activity>
          <Activity mode={mode("code-todos")}>
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
          </Activity>
          <Activity mode={mode("insights")}>
            {insightsSeen && (
              <Suspense fallback={null}>
                <InsightsBoard
                  repoPath={repoPath}
                  active={repoTab === "insights"}
                />
              </Suspense>
            )}
          </Activity>
          {aiEnabled && (
            <Activity mode={mode("agent")}>
              {agentSeen && (
                <Suspense fallback={null}>
                  <SessionView repoPath={repoPath} />
                </Suspense>
              )}
            </Activity>
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
      {/* Hoisted: its success handler navigates to the Pulls tab, which hides whichever
          tab launched it — a panel-hosted instance under <Activity> would have its
          close deferred and stick open. One instance here serves every opener. */}
      <CreateLocalPrDialog
        repoPath={repoPath}
        defaultHead={localPrCreate?.defaultHead}
        defaultBase={localPrCreate?.defaultBase}
        open={localPrCreate !== null}
        onOpenChange={(o) => {
          if (!o) closeLocalPrCreate();
        }}
      />
    </div>
  );
}
