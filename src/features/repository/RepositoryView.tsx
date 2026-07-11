import {
  CaretDownIcon,
  ChatCircleIcon,
  CircleDashedIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitPullRequestIcon,
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
import { CommitBox } from "@/features/commit/CommitBox";
import { BranchDiffView } from "@/features/compare/BranchDiffView";
import { ComparePanel } from "@/features/compare/ComparePanel";
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import { DiffViewer } from "@/features/diff/DiffViewer";
import { DiscussionsPanel } from "@/features/discussions/DiscussionsPanel";
import { DiscussionView } from "@/features/discussions/DiscussionView";
import { CommitDetailView } from "@/features/history/CommitDetailView";
import { HistoryPanel } from "@/features/history/HistoryPanel";
import { IssuesPanel } from "@/features/issues/IssuesPanel";
import { JiraIssueView } from "@/features/issues/JiraIssueView";
import { LocalIssueView } from "@/features/issues/LocalIssueView";
import { RemoteIssueView } from "@/features/issues/RemoteIssueView";
import { LocalPrView } from "@/features/pulls/LocalPrView";
import { PullRequestsPanel } from "@/features/pulls/PullRequestsPanel";
import { RemotePrView } from "@/features/pulls/RemotePrView";
import { useCleanupResolveWorktrees } from "@/features/pulls/useCleanupResolveWorktrees";
import { useWatchPrHeads } from "@/features/pulls/useWatchPrHeads";
import { SessionList } from "@/features/sessions/SessionList";
import { SessionView } from "@/features/sessions/SessionView";
import { TagDetailView } from "@/features/tags/TagDetailView";
import { TagsPanel } from "@/features/tags/TagsPanel";
import {
  forgeFeatureReady,
  useForgeStatus,
  useRepoStatus,
} from "@/lib/git/queries";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { useJiraLink, useJiraPermissions } from "@/lib/jira/queries";
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

// Secondary surfaces live behind a "More ▾" overflow so the four primary tabs
// keep their full labels in the fixed-width rail. The trigger shows the active
// secondary tab's name (e.g. "Issues ▾") so the rail still says where you are.
const SECONDARY_TABS: { tab: RepoTab; label: string; ai?: boolean }[] = [
  { tab: "agent", label: "Agent", ai: true },
  { tab: "issues", label: "Issues" },
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
  // The detail panes run off deferred selections so rapidly arrowing a list
  // (commits, PRs) only loads + renders the item landed on, not every one
  // passed. The lists' own highlights use the live values, so they stay snappy.
  const deferredCommitHash = useDeferredValue(selectedCommitHash);
  const deferredCompareCommitHash = useDeferredValue(compareCommitHash);
  const deferredPr = useDeferredValue(selectedPr);
  const deferredIssue = useDeferredValue(selectedIssue);
  const deferredDiscussion = useDeferredValue(selectedDiscussion);
  const deferredTag = useDeferredValue(selectedTag);
  const status = useRepoStatus(repoPath ?? "");
  const alias = useRepoAlias(repoPath);
  // The write-capable agent is an AI feature — hide its tab when AI is hidden.
  const aiEnabled = useAiEnabled();
  const currentName = status.data?.branch?.name ?? null;
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

  // "repo • branch" in the OS title bar (and Alt-Tab) while a repo is open. No
  // cleanup here: a branch switch updates the title in one pass instead of
  // flashing through the bare base title (the cleanup used to run on every
  // dep change, racing the async setTitle).
  useEffect(() => {
    const display = alias ?? repoName;
    if (!display) return;
    const title = currentName ? `${display} • ${currentName}` : display;
    getCurrentWindow()
      .setTitle(`${title} — ${APP_TITLE}`)
      .catch(() => undefined);
  }, [repoName, alias, currentName]);
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
          {aiEnabled && (
            <Activity mode={mode("agent")}>
              <SessionList repoPath={repoPath} />
            </Activity>
          )}
        </aside>
        <main className="min-w-0 flex-1">
          <Activity mode={mode("changes")}>
            <DiffViewer repoPath={repoPath} />
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
              <SessionView repoPath={repoPath} />
            </Activity>
          )}
        </main>
      </div>
    </div>
  );
}
