import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  CircleDashedIcon,
  KanbanIcon,
} from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { ForgeUserAvatar } from "@/components/forge-user-avatar";
import { Button } from "@/components/ui/button";
import { ConversationFilterPopover } from "@/features/conversations/ConversationFilterPopover";
import { ConversationListPanel } from "@/features/conversations/ConversationListPanel";
import { PAGE_SIZE } from "@/features/conversations/LoadMoreRow";
import { RepoLensSwitcher } from "@/features/conversations/RepoLensSwitcher";
import { useCollapsedSections } from "@/features/conversations/useCollapsedSections";
import { useLocalRemoteFilter } from "@/features/conversations/useLocalRemoteFilter";
import type { IssueStateFilter } from "@/lib/git/api";
import {
  forgeFeatureReady,
  useForgeStatus,
  useHoverPrefetch,
  useIssueList,
  usePrefetchIssue,
} from "@/lib/git/queries";
import { providerLabel } from "@/lib/git/types";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { useLocalIssues } from "@/lib/issues/queries";
import {
  useJiraIssues,
  useJiraLink,
  useJiraPermissions,
} from "@/lib/jira/queries";
import { formatStoryPoints, type JiraIssueInfo } from "@/lib/jira/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import {
  useLensGate,
  useRemoteSlug,
  useRepoLens,
  useSetRepoLens,
} from "@/lib/repo-lens/queries";
import { useUiStore } from "@/lib/stores/ui";
import { isAppError } from "@/lib/tauri/invoke";
import { formatRelativeTime } from "@/lib/time";
import { toastError } from "@/lib/toast";
import { CreateIssueDialog } from "./CreateIssueDialog";
import { CreateJiraIssueDialog } from "./CreateJiraIssueDialog";
import { CreateLocalIssueDialog } from "./CreateLocalIssueDialog";
import { RepoJiraDialog } from "./RepoJiraDialog";

/** Bitbucket has retired its native issue tracker (deleted platform-wide
 *  2026-08-20); issues moved to Jira. When the repo has no Jira link yet, invite
 *  the user to link one — that's the only issue story for a Bitbucket repo. */
function BitbucketLinkJiraCta({ onLink }: { onLink: () => void }) {
  return (
    <div className="space-y-2.5 px-3 py-4 text-xs text-muted-foreground">
      <p>
        Bitbucket has retired its native issue tracker — link a Jira project to
        browse its issues here.
      </p>
      <Button size="sm" className="cursor-pointer" onClick={onLink}>
        <KanbanIcon data-icon="inline-start" />
        Link your Jira project
      </Button>
    </div>
  );
}

/** The Jira status chip: category picks the open/closed icon+token, the REAL
 *  status name is the text (meaning is never color-only). */
function JiraStatusChip({ issue }: { issue: JiraIssueInfo }) {
  const done = issue.statusCategory === "done";
  const Icon = done ? CheckCircleIcon : CircleDashedIcon;
  return (
    <span className="inline-flex w-fit items-center gap-1 whitespace-nowrap border px-1 py-px text-[10px] text-muted-foreground">
      <Icon
        className={`size-3 shrink-0 ${done ? "text-merged" : "text-success"}`}
      />
      {issue.statusName}
    </span>
  );
}

export function IssuesPanel({ repoPath }: { repoPath: string }) {
  const gh = useForgeStatus(repoPath);
  const provider = gh.data?.provider;
  const isGitLab = provider === "gitlab";
  const isBitbucket = provider === "bitbucket";
  // The origin|upstream lens (GitHub forks only) scopes ONLY the remote section
  // below — local + Jira issues are lens-independent. It decides which repo feeds
  // `remotes`, not how rows are partitioned.
  const lens = useRepoLens(repoPath);
  const lensGate = useLensGate(repoPath);
  const setLens = useSetRepoLens(repoPath);
  const upstreamSlug = useRemoteSlug(repoPath, "upstream", lens === "upstream");
  const providerName = providerLabel(provider);
  // When browsing the parent, the remote section header names the parent slug.
  const remoteLabel =
    lens === "upstream" ? (upstreamSlug ?? "Upstream") : providerName;
  // Issue *reads* are provider-neutral (the panel-level `issues` flag); issue
  // *creation* follows its own per-action write flag — ready GitHub AND GitLab
  // repos both offer the create dialog (which hides GitHub-only fields per
  // provider), while a not-ready repo gets a disabled item with the reason.
  const ghReady = forgeFeatureReady(gh.data, "issues");
  const canCreateGh = forgeFeatureReady(gh.data, "issueCreate");
  const [stateFilter, setStateFilter] = useState<IssueStateFilter>("open");
  // How many remote issues to load; "Load more" bumps it. A tab switch resets it.
  const [limit, setLimit] = useState(PAGE_SIZE);
  const issueList = useIssueList(repoPath, ghReady, stateFilter, limit, lens);
  // A fork (issues off by default on GitHub) surfaces a typed error here. It's a
  // permanent repo condition, not a transient fetch failure, so the section shows
  // an informative notice with no Retry — and issue creation is offered as
  // disabled-with-reason rather than a call that can only ever fail.
  const issuesDisabled =
    issueList.isError &&
    isAppError(issueList.error) &&
    issueList.error.kind === "issuesDisabled";
  // Creation is possible only when the forge allows it AND the repo hasn't turned
  // issues off — gates every path that opens the GitHub create dialog.
  const canOpenGhCreate = canCreateGh && !issuesDisabled;
  const onStateFilter = (s: IssueStateFilter) => {
    setStateFilter(s);
    setLimit(PAGE_SIZE);
  };
  const selectedIssue = useUiStore((s) => s.selectedIssue);
  const selectIssue = useUiStore((s) => s.selectIssue);
  const prefetchIssue = usePrefetchIssue(repoPath, lens);
  const hoverPrefetch = useHoverPrefetch();
  const filterRef = useRef<HTMLInputElement>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createLocalOpen, setCreateLocalOpen] = useState(false);
  const [createJiraOpen, setCreateJiraOpen] = useState(false);
  const [jiraOpen, setJiraOpen] = useState(false);
  const localIssues = useLocalIssues(repoPath);
  // A linked Jira project is a third issue source, independent of the git host.
  const jiraLink = useJiraLink(repoPath);
  const link = jiraLink.data ?? null;
  const jiraIssues = useJiraIssues(repoPath, link, stateFilter);
  // Per-project write permissions gate the Jira "New" option: present only when
  // linked AND the user can create issues (a failed probe → `?? false` → absent).
  const jiraPerms = useJiraPermissions(repoPath, link);
  const canCreateJira = !!link && (jiraPerms.data?.createIssues ?? false);
  const pendingIssueDraft = useUiStore((s) => s.pendingIssueDraft);
  const setPendingIssueDraft = useUiStore((s) => s.setPendingIssueDraft);
  const pendingCreate = useUiStore((s) => s.pendingCreate);
  const clearPendingCreate = useUiStore((s) => s.clearPendingCreate);
  const [issueDraft, setIssueDraft] = useState<
    { title: string; body: string; labels?: string[] } | undefined
  >();

  useHotkeyAction("focus-filter", () => filterRef.current?.focus());
  useHotkeyAction("create-issue", () => setCreateOpen(true), canOpenGhCreate);
  useHotkeyAction(
    "create-jira-issue",
    () => setCreateJiraOpen(true),
    canCreateJira,
  );
  useHotkeyAction("link-jira-project", () => setJiraOpen(true));

  // "Reference in new issue" / "Duplicate issue" seeds + opens the create dialog.
  // Re-check the gate (like the PR panel): the seeder's own gate can lag this
  // panel's — never open a create dialog that can't submit.
  useEffect(() => {
    if (pendingIssueDraft) {
      if (canOpenGhCreate) {
        setIssueDraft(pendingIssueDraft);
        setCreateOpen(true);
      }
      setPendingIssueDraft(null);
    }
  }, [pendingIssueDraft, setPendingIssueDraft, canOpenGhCreate]);

  // Opened from the command palette / New menu via requestCreate (works from any
  // tab — RepositoryView switches here first, then this fires).
  useEffect(() => {
    if (pendingCreate === "issue") {
      if (canOpenGhCreate) setCreateOpen(true);
      clearPendingCreate();
    } else if (pendingCreate === "local-issue") {
      setCreateLocalOpen(true);
      clearPendingCreate();
    } else if (pendingCreate === "jira-issue") {
      // Re-check the gate: RepositoryView's fallback fired from another tab, so
      // its snapshot of the permission can lag this panel's — never open a
      // create dialog that can't submit (mirrors the canCreateGh guard above).
      if (canCreateJira) setCreateJiraOpen(true);
      clearPendingCreate();
    }
  }, [pendingCreate, clearPendingCreate, canOpenGhCreate, canCreateJira]);

  const {
    filterText,
    setFilterText,
    authorFilter,
    labelFilter,
    toggle,
    showArchived,
    setShowArchived,
    authors,
    labels,
    activeFilterCount,
    stateLocal,
    stateRemote: issues,
    visibleLocal,
    archivedLocalCount,
    visibleRemote: visible,
    authorCount,
    labelCount,
  } = useLocalRemoteFilter({
    locals: localIssues.data ?? [],
    remotes: issueList.data ?? [],
    stateFilter,
  });

  // Jira issues aren't part of the local/remote filter hook (their author/label
  // vocabulary is Jira's, not the repo host's); apply just the free-text search
  // so the shared search box narrows them too. An author-filter selection has no
  // Jira analogue, so it excludes the whole section (matching how it excludes
  // locals).
  const jiraQuery = filterText.trim().toLowerCase();
  const visibleJira =
    authorFilter.size > 0 || labelFilter.size > 0
      ? []
      : (jiraIssues.data ?? []).filter(
          (i) =>
            !jiraQuery ||
            i.key.toLowerCase().includes(jiraQuery) ||
            i.summary.toLowerCase().includes(jiraQuery),
        );

  const { localCollapsed, remoteCollapsed, toggleLocal, toggleRemote } =
    useCollapsedSections("issues");

  // Arrow keys walk the visible rows: local → remote → jira, matching the render
  // order (navTargets is flattened for the shared keyboard-nav helper). A
  // collapsed section's rows leave the registry (its body is unmounted), so an
  // arrow key can never land on an invisible row. The Jira section isn't
  // collapsible, so it always contributes.
  const navTargets = [
    ...(localCollapsed
      ? []
      : visibleLocal.map((i) => ({ kind: "local" as const, id: i.id }))),
    ...(remoteCollapsed
      ? []
      : visible.map((i) => ({
          kind: "remote" as const,
          id: String(i.number),
        }))),
    ...visibleJira.map((i) => ({ kind: "jira" as const, id: i.key })),
  ];

  const onListKeyDown = listKeyboardNav({
    items: navTargets,
    activeIndex: navTargets.findIndex(
      (t) => t.kind === selectedIssue?.kind && t.id === selectedIssue.id,
    ),
    onActivate: (target) => selectIssue(target),
    rowKey: (target) => `${target.kind}:${target.id}`,
  });

  const RowIcon = stateFilter === "open" ? CircleDashedIcon : CheckCircleIcon;

  // The Bitbucket remote (host) section never has issues — its tracker is
  // retired. Unlinked, it invites linking a Jira project; linked, the Jira
  // section below IS the content, so the host section collapses to a one-line
  // pointer rather than the ForgeNotReady connection ladder. Non-BB repos never
  // see a Jira CTA here (quiet promotion — dialog via menu/palette).
  const bitbucketNotReadySlot = isBitbucket ? (
    link ? (
      <p className="px-3 py-2 text-[11px] text-muted-foreground">
        Issues for this repository live in Jira, below.
      </p>
    ) : (
      <BitbucketLinkJiraCta onLink={() => setJiraOpen(true)} />
    )
  ) : undefined;

  return (
    <ConversationListPanel
      repoPath={repoPath}
      feature="issues"
      remoteLabel={remoteLabel}
      stateFilter={stateFilter}
      onStateFilter={onStateFilter}
      lensControl={<RepoLensSwitcher repoPath={repoPath} />}
      newMenu={{
        ghLabel: isBitbucket
          ? "Issue on Bitbucket…"
          : isGitLab
            ? "Issue on GitLab…"
            : "Issue on GitHub…",
        // Issues disabled on the repo (a fork's default) also blocks creation, even
        // when the forge is otherwise ready — gate it with the reason so "New" isn't
        // a button that can only fail.
        ghDisabled: !canCreateGh || issuesDisabled,
        ghReason:
          canCreateGh && !issuesDisabled
            ? undefined
            : isBitbucket
              ? "Bitbucket has retired its native issue tracker — link a Jira project to track issues."
              : isGitLab
                ? gh.data?.installed
                  ? "Sign in to GitLab (glab auth login) to open issues here."
                  : "Install the GitLab CLI (glab) to open issues here."
                : issuesDisabled
                  ? "Issues are disabled on this repository — enable them in the repository settings on GitHub."
                  : "Connect this repository to GitHub to open an issue.",
        onGh: () => setCreateOpen(true),
        localLabel: "Local issue…",
        onLocal: () => setCreateLocalOpen(true),
        jiraLabel: canCreateJira
          ? `Jira issue in ${link?.projectKey}…`
          : undefined,
        onJira: canCreateJira ? () => setCreateJiraOpen(true) : undefined,
      }}
      filterSlot={
        <ConversationFilterPopover
          authors={authors}
          labels={labels}
          authorFilter={authorFilter}
          labelFilter={labelFilter}
          toggle={toggle}
          activeFilterCount={activeFilterCount}
          authorCount={authorCount}
          labelCount={labelCount}
        />
      }
      filterRef={filterRef}
      filterText={filterText}
      onFilterText={setFilterText}
      onListKeyDown={onListKeyDown}
      stateLocal={stateLocal}
      visibleLocal={visibleLocal}
      localKey={(issue) => issue.id}
      isLocalActive={(issue) =>
        selectedIssue?.kind === "local" && selectedIssue.id === issue.id
      }
      onSelectLocal={(issue) => selectIssue({ kind: "local", id: issue.id })}
      renderLocalRow={(issue) => (
        <>
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <RowIcon className="size-3 shrink-0 text-muted-foreground" />
            <span className="truncate" title={issue.title}>
              {issue.title}
            </span>
          </p>
          <p className="mt-0.5 truncate pl-4 text-[11px] text-muted-foreground">
            local · {formatRelativeTime(issue.createdAt)}
            {issue.archived ? " · archived" : ""}
          </p>
        </>
      )}
      archivedLocalCount={archivedLocalCount}
      showArchived={showArchived}
      onToggleArchived={() => setShowArchived((v) => !v)}
      localCollapsed={localCollapsed}
      remoteCollapsed={remoteCollapsed}
      onToggleLocal={toggleLocal}
      onToggleRemote={toggleRemote}
      ghPending={gh.isPending}
      ghReady={ghReady}
      remoteNotReadySlot={bitbucketNotReadySlot}
      listPending={issueList.isPending}
      remoteError={issueList.isError}
      remoteErrorSlot={
        issuesDisabled ? (
          <div className="space-y-1 px-3 py-4 text-xs text-muted-foreground">
            <p>Issues are disabled on this repository.</p>
            <p className="text-[11px]">
              Forks start with issues turned off — enable them in the repository
              settings on GitHub.
            </p>
            {/* This disabled state only ever renders for the origin (fork) lens by
                construction; when the repo is a GitHub fork, offer browsing the
                parent's issues instead of a dead end. */}
            {lensGate && lens === "origin" && (
              <div className="space-y-1.5 pt-1.5">
                <p className="text-[11px]">
                  Your fork has issues disabled — switch to Upstream to browse
                  the parent repository's issues.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="cursor-pointer"
                  onClick={() => setLens("upstream")}
                >
                  Switch to upstream
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-2 px-3 py-4 text-xs text-muted-foreground">
            <p>Couldn't load issues.</p>
            <Button
              variant="outline"
              size="sm"
              className="cursor-pointer"
              onClick={() => issueList.refetch()}
            >
              Retry
            </Button>
          </div>
        )
      }
      // More may exist server-side exactly when this page filled the requested
      // limit (compared against the raw loaded count, not the filtered view).
      hasMore={(issueList.data?.length ?? 0) === limit}
      remoteCount={issueList.data?.length ?? 0}
      loadingMore={issueList.isFetching}
      onLoadMore={() => setLimit((n) => n + PAGE_SIZE)}
      stateRemote={issues}
      visibleRemote={visible}
      remoteKey={(issue) => String(issue.number)}
      isRemoteActive={(issue) =>
        selectedIssue?.kind === "remote" &&
        selectedIssue.id === String(issue.number)
      }
      onSelectRemote={(issue) =>
        selectIssue({ kind: "remote", id: String(issue.number) })
      }
      onRemoteHover={(issue) =>
        hoverPrefetch(() => prefetchIssue(issue.number))
      }
      renderRemoteRow={(issue) => (
        <>
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <RowIcon className="size-3 shrink-0 text-muted-foreground" />
            <span className="truncate" title={issue.title}>
              {issue.title}
            </span>
          </p>
          <p className="mt-0.5 truncate pl-4 text-[11px] text-muted-foreground">
            #{issue.number} · {issue.author ? `${issue.author.login} · ` : ""}
            {formatRelativeTime(issue.createdAt)}
          </p>
        </>
      )}
      remoteSkeletonRows={3}
      localNoun="issues"
      remoteNoun="issues"
      jira={
        link
          ? {
              header: `Jira · ${link.projectKey}`,
              headerAction: (
                <Button
                  variant="ghost"
                  size="xs"
                  className="cursor-pointer text-muted-foreground"
                  onClick={() =>
                    openUrl(
                      `https://${link.siteHost}/browse/${link.projectKey}`,
                    ).catch(toastError)
                  }
                  title={`Open ${link.projectKey} in Jira`}
                >
                  <ArrowSquareOutIcon data-icon="inline-start" />
                  View in Jira
                </Button>
              ),
              pending: jiraIssues.isPending,
              isError: jiraIssues.isError,
              errorSlot: (
                <div className="space-y-2 px-3 py-4 text-xs text-muted-foreground">
                  <p>
                    Couldn't load {link.projectKey} — your Jira credential may
                    have expired.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="cursor-pointer"
                    onClick={() => setJiraOpen(true)}
                  >
                    Reconnect
                  </Button>
                </div>
              ),
              items: visibleJira,
              itemKey: (issue: JiraIssueInfo) => issue.key,
              isActive: (issue: JiraIssueInfo) =>
                selectedIssue?.kind === "jira" &&
                selectedIssue.id === issue.key,
              onSelect: (issue: JiraIssueInfo) =>
                selectIssue({ kind: "jira", id: issue.key }),
              // Three-line layout so the textual Jira status name never wraps
              // inside its chip and squeezes the title: (1) status chip left +
              // assignee avatar right, (2) full-width truncating title, (3)
              // key · updated. Row heights stay consistent with/without an
              // assignee (line 1 always reserves the avatar's height via the
              // chip).
              renderRow: (issue: JiraIssueInfo) => (
                <>
                  <div className="flex min-h-6 items-center gap-1.5">
                    <JiraStatusChip issue={issue} />
                    {issue.storyPoints != null && (
                      <span
                        className="w-fit whitespace-nowrap border px-1 py-px text-[10px] text-muted-foreground"
                        title="Story points"
                        aria-label={`${formatStoryPoints(issue.storyPoints)} story points`}
                      >
                        {formatStoryPoints(issue.storyPoints)}
                      </span>
                    )}
                    {issue.assignee && (
                      <span className="ml-auto shrink-0">
                        <ForgeUserAvatar user={issue.assignee} ghHost={null} />
                      </span>
                    )}
                  </div>
                  <p
                    className="mt-0.5 truncate text-xs font-medium"
                    title={issue.summary}
                  >
                    {issue.summary}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                    {issue.key} · {formatRelativeTime(issue.updatedAt)}
                  </p>
                </>
              ),
              skeletonRows: 3,
              emptyLabel: `No ${stateFilter} issues in ${link.projectKey} — switch the filter or view the project in Jira.`,
            }
          : undefined
      }
    >
      <CreateIssueDialog
        repoPath={repoPath}
        lens={lens}
        open={createOpen}
        onOpenChange={(o) => {
          setCreateOpen(o);
          if (!o) setIssueDraft(undefined);
        }}
        initialDraft={issueDraft}
      />
      <CreateLocalIssueDialog
        repoPath={repoPath}
        open={createLocalOpen}
        onOpenChange={setCreateLocalOpen}
      />
      {link && (
        <CreateJiraIssueDialog
          repoPath={repoPath}
          link={link}
          open={createJiraOpen}
          onOpenChange={setCreateJiraOpen}
        />
      )}
      <RepoJiraDialog
        repoPath={repoPath}
        open={jiraOpen}
        onOpenChange={setJiraOpen}
        existingLink={link}
      />
    </ConversationListPanel>
  );
}
