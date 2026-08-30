import { create } from "zustand";
import type { CommitAuthor, RemoteLens, RepoInfo } from "@/lib/git/types";
import type { PrSection } from "@/lib/pulls/pr-section";
import { startViewTransition } from "@/lib/view-transition";

export type AppView = "welcome" | "repo" | "settings" | "help" | "explore";
export type RepoTab =
  | "changes"
  | "history"
  | "compare"
  | "pulls"
  | "issues"
  | "discussions"
  | "actions"
  | "findings"
  | "tags"
  | "insights"
  | "code-todos"
  | "tasks"
  | "agent";
/** A create dialog the command palette / New menus can request from any tab. */
export type CreateKind =
  | "issue"
  | "local-issue"
  | "jira-issue"
  | "pr"
  | "local-pr"
  | "release"
  | "tag"
  | "discussion";
/** The tab each create dialog lives on; requestCreate switches to it. */
const CREATE_TAB: Record<CreateKind, RepoTab> = {
  issue: "issues",
  "local-issue": "issues",
  "jira-issue": "issues",
  pr: "pulls",
  "local-pr": "pulls",
  release: "tags",
  tag: "tags",
  discussion: "discussions",
};
/** A Settings section to open directly (matches SettingsScreen's panel ids). */
export type SettingsTarget =
  | "general"
  | "ai"
  | "mcp-servers"
  | "automations"
  | "notifications"
  | "keyboard"
  | "accounts"
  | "git"
  | "editor"
  | "terminal"
  | "updates";

export interface SelectedPr {
  kind: "local" | "remote";
  /** Local PR id, or the remote PR number as a string. */
  id: string;
}

export interface SelectedIssue {
  kind: "local" | "remote" | "jira";
  /** Local issue id, the remote issue number as a string, or the Jira issue key
   *  (e.g. `PROJ-123`). */
  id: string;
}

/** Selected security finding, one variant per category the Findings tab lists.
 *  Alert / code-scanning / secret-scanning numbers are per-category sequences, so
 *  the `type` tag is what keeps two same-numbered findings distinct. */
export type SelectedFinding =
  | { type: "alert"; number: number }
  | { type: "codeScanning"; number: number }
  | { type: "secretScanning"; number: number }
  | { type: "advisory"; ghsaId: string }
  /** GitLab pipeline-report findings. `id` is always a *derived* identity —
   *  `secureFindingId` for SAST/secrets, `codeQualityFindingId` for code
   *  quality — because a report can omit the id or fingerprint outright, and
   *  every finding missing one would otherwise share the empty string. */
  | {
      type: "glFinding";
      category: "sast" | "secretDetection" | "codeQuality";
      id: string;
    };

/** How many rows each Findings category has asked for. In the store (not panel
 *  state) so the list and the detail pane build identical query keys and share
 *  one cache entry. */
export interface FindingsLimits {
  alerts: number;
  codeScanning: number;
  secretScanning: number;
  advisories: number;
  /** Shared by GitLab's three categories — they come from one pipeline query. */
  gitlab: number;
}

/** One page per category — matches the shared LoadMoreRow PAGE_SIZE. */
const DEFAULT_FINDINGS_LIMITS: FindingsLimits = {
  alerts: 100,
  codeScanning: 100,
  secretScanning: 100,
  advisories: 100,
  gitlab: 100,
};

export interface SelectedFile {
  path: string;
  staged: boolean;
  untracked: boolean;
}

/** Which forge sign-in the global ReconnectDialog is driving; null = closed.
 *  `mode: "login"` signs in a new session, `"refresh"` renews an existing one. */
export interface ReconnectTarget {
  provider: "github" | "gitlab";
  host: string;
  mode: "login" | "refresh";
  /** Extra OAuth scopes to request alongside the ones already granted. GitHub
   *  `refresh` only — the backend refuses them on any other arm. */
  scopes?: string[];
}

/** An in-progress commit message, persisted per repo + branch. */
export interface CommitDraft {
  title: string;
  body: string;
  coAuthors: CommitAuthor[];
  aiGenerated: boolean;
  amendingHash: string | null;
}

const EMPTY_COMMIT_DRAFT: CommitDraft = {
  title: "",
  body: "",
  coAuthors: [],
  aiGenerated: false,
  amendingHash: null,
};

/** Selections cleared when a navigation switches to a *different* repo — the
 *  same set openRepo / openPr reset, hoisted so the run/agent navigations
 *  stay in lockstep. Staying in the same repo keeps the user's other selections. */
const CROSS_REPO_RESET: Partial<UiState> = {
  // Absent on purpose: `queuedMerges` keys embed the repoPath (and lens), so
  // entries can't leak across repos, and clearing here would kill the queued-merge
  // chip's promised session persistence on any repo round-trip.
  compareBranch: null,
  localPrCreate: null,
  commitDialogOpen: false,
  selectedPr: null,
  pendingPrSection: null,
  pendingReviewId: null,
  selectedIssue: null,
  selectedDiscussion: null,
  pendingIssueDraft: null,
  selectedRunId: null,
  selectedFinding: null,
  findingsLimits: DEFAULT_FINDINGS_LIMITS,
  repoSettingsRequest: null,
  selectedTag: null,
  selectedTodo: null,
  selectedFile: null,
  selectedCommitHash: null,
  compareCommitHash: null,
  commitTitle: "",
  commitBody: "",
  commitCoAuthors: [],
  commitAiGenerated: false,
  amendingHash: null,
  activeDraftKey: null,
  draftKeyRemaps: {},
};

/** Key a queued merge by the SAME identity the PR view uses — repo + number +
 *  lens. The lens is part of it because a fork's origin and upstream can both
 *  carry a pull request numbered 7, and the view flips lens while staying
 *  mounted: without it, one lens's chip shows on the other, and the
 *  clear-on-non-OPEN effect deletes the other's record.
 *
 *  Opaque (never parsed back) and collision-free read from the RIGHT: the lens is
 *  a fixed two-value enum and the number is digits, so neither trailing segment
 *  can contain `#` however exotic the path in front of them is. */
export function queuedMergeKey(
  repoPath: string,
  number: number,
  lens: RemoteLens,
): string {
  return `${repoPath}#${number}#${lens}`;
}

/** Key a commit draft so each repo + branch keeps its own message. A git branch
 *  name can't contain a colon, so the key stays unambiguous. */
export function commitDraftKey(repoPath: string, branch: string): string {
  return `${repoPath}:${branch}`;
}

/** Where the draft captured under `key` lives now, following branch renames.
 *  Remaps are collapsed on write, so one lookup covers a chain of renames. */
export function resolveDraftKey(
  remaps: Record<string, string>,
  key: string | null,
): string | null {
  return key === null ? null : (remaps[key] ?? key);
}

function isEmptyDraft(d: CommitDraft): boolean {
  return (
    !d.title &&
    !d.body &&
    d.coAuthors.length === 0 &&
    d.amendingHash === null &&
    !d.aiGenerated
  );
}

interface UiState {
  view: AppView;
  /** Underlying view to return to when an overlay (settings, help, explore) closes. */
  previousView: Exclude<AppView, "settings" | "help" | "explore">;
  /** Settings section to jump to when opening Settings; null = leave as-is.
   *  Consumed (and cleared) by SettingsScreen once applied. */
  settingsTarget: SettingsTarget | null;
  /** Whether the MCP-registry browser (Settings → MCP servers) is open. In the store so the
   *  command palette can deep-link to it in one atomic navigation, whether or not the panel
   *  is mounted yet. */
  mcpBrowseOpen: boolean;
  /** Whether the Activity & Notifications popover is open. Held in the store so
   *  the command palette / a hotkey can toggle it regardless of which mount
   *  (header dock or bottom strip) is currently on screen. */
  activityOpen: boolean;
  /** The forge sign-in the global ReconnectDialog is driving; null = closed. Held
   *  in the store so any surface (repo panels, Settings, the palette) can open the
   *  one shared dialog. */
  reconnectTarget: ReconnectTarget | null;
  /** Session-scoped dismissals of the token-expiry notice, keyed
   *  `${provider}|${host}|${expiresAt}`. In-memory only (never persisted), so a
   *  dismissed notice returns next launch until the token is actually renewed. */
  dismissedExpiryNotices: Set<string>;
  /** Pull requests whose merge the forge accepted into a MERGE QUEUE rather than
   *  landing, keyed by {@link queuedMergeKey}. Nothing the app can fetch carries
   *  that state (no mergeStateStatus member reports it), so the accepted outcome
   *  is the only evidence there is — recorded here so the chip survives a switch
   *  away and back. In-memory only: a relaunch forgets, and the PR's own state
   *  takes over once it lands. */
  queuedMerges: Record<string, true>;
  repoPath: string | null;
  repoName: string | null;
  repoTab: RepoTab;
  /** Branch to compare the current branch against, on the Compare tab. */
  compareBranch: string | null;
  /** Selected PR on the Pull Requests tab. */
  selectedPr: SelectedPr | null;
  /** PR sub-tab to land on when the Pulls view next opens a PR — set from a
   *  notification row's click-through so the event's own tab opens; null asks
   *  for no switch. Consumed and cleared by the PR detail views. */
  pendingPrSection: PrSection | null;
  /** Review the Pulls view should scroll to once the opened PR's details land —
   *  set from a review notification's click-through, null when the event names no
   *  review. Consumed by the PR detail view, which hands it to its own reveal
   *  state rather than reading it per render. */
  pendingReviewId: string | null;
  /** Selected issue on the Issues tab. */
  selectedIssue: SelectedIssue | null;
  /** Selected discussion (by number) on the Discussions tab. */
  selectedDiscussion: { number: number } | null;
  /** A draft to seed the next GitHub-issue create dialog (e.g. "Reference in
   *  new issue" from a discussion, or "Duplicate issue"); consumed and cleared
   *  by IssuesPanel. `labels` (names) carry over when duplicating. */
  pendingIssueDraft: {
    title: string;
    body: string;
    labels?: string[];
  } | null;
  /** A create dialog requested from the palette / a New menu; the owning panel
   *  opens its dialog when this matches its kind, then clears it. Survives the
   *  tab switch requestCreate performs. */
  pendingCreate: CreateKind | null;
  /** The hoisted "create local PR" dialog: null = closed; an object = open, with
   *  optional branch seeds. Lives at RepositoryView level (outside the tab
   *  <Activity> wrappers) because its success handler navigates to the Pulls tab —
   *  a panel-hosted instance would conceal with the tab that launched it mid-close,
   *  deferring its close and unmount until that tab is next shown. */
  localPrCreate: { defaultHead?: string; defaultBase?: string } | null;
  /** Whether the pop-out commit dialog is open. In the store (not panel state)
   *  because the dialog is hoisted at RepositoryView level and opens from the
   *  palette as well as the commit box — including while the sidebar is
   *  collapsed, where the inline box is Activity-hidden. Not persisted. */
  commitDialogOpen: boolean;
  /** Selected workflow run (databaseId) on the Actions tab. */
  selectedRunId: number | null;
  /** Selected finding on the Findings tab. */
  selectedFinding: SelectedFinding | null;
  /** Per-category row limits on the Findings tab; "Load more" bumps one. */
  findingsLimits: FindingsLimits;
  /** A one-shot request to open Repository Settings at a section, raised by
   *  another surface (the Findings tab's "Dependabot is off" card). The menu
   *  that owns the dialog consumes and clears it. */
  repoSettingsRequest: "security" | null;
  /** Selected tag (by name) on the Tags tab. */
  selectedTag: { tag: string } | null;
  /** Selected TODO on the Code TODOs tab. Carries the scan's authoritative
   *  `marker`/`text` (the Rust scanner gates markers to real comment openers, so
   *  these beat any client-side re-derivation) alongside its path + line. */
  selectedTodo: {
    path: string;
    line: number;
    marker: string;
    text: string;
  } | null;
  selectedFile: SelectedFile | null;
  selectedCommitHash: string | null;
  /** Commit selected on the Compare tab. Separate from `selectedCommitHash` (History's) so
   *  neither clobbers the other. Reset when the compare branch changes — a commit from one
   *  branch's compare list may not exist in another's. */
  compareCommitHash: string | null;
  commitTitle: string;
  commitBody: string;
  /** Co-authors credited on the next commit (Co-authored-by trailers). */
  commitCoAuthors: CommitAuthor[];
  generating: boolean;
  /** Whether the current commit draft was produced by AI generation. */
  commitAiGenerated: boolean;
  /** Hash of the commit being amended, or null for a normal commit. */
  amendingHash: string | null;
  /** Saved commit drafts keyed by repo+branch; survives repo/branch switches.
   *  The live commit fields above mirror the entry for `activeDraftKey`. */
  commitDrafts: Record<string, CommitDraft>;
  activeDraftKey: string | null;
  /** Draft keys a branch rename moved: captured key -> where that draft lives now.
   *  Lets a generation started before the rename recognise its own draft after it;
   *  a genuine branch switch or a repo switch clears the whole record. */
  draftKeyRemaps: Record<string, string>;

  openRepo: (info: RepoInfo) => void;
  closeRepo: () => void;
  /** Open a repo (if not already open) and select a PR — used by a notification
   *  row's click-through. `section` is the sub-tab to land on, or null to leave
   *  whichever tab the user is on. One atomic update so the landing target
   *  survives openRepo's own reset. */
  openPr: (target: {
    kind: "remote" | "local";
    repoPath: string;
    repoName: string;
    ref: string;
    section: PrSection | null;
    /** Review to scroll to once the PR's details land; omitted/null = none. */
    reviewId?: string | null;
    /** Store-external state this navigation depends on (the caller's repo-lens
     *  write), run inside the SAME view-transition callback as the selection.
     *  Written outside it, it would land a render early — the transition callback
     *  is deferred on Chromium — pairing the new lens with the old PR number and
     *  fetching a pair the user never selected. */
    beforeSelect?: () => void;
  }) => void;
  /** Open a repo (if not already) and land on a workflow run in the Actions tab —
   *  used by a notification's click-through. Atomic, like openPr. */
  openRun: (target: {
    repoPath: string;
    repoName: string;
    runId: number;
  }) => void;
  /** Open a repo (if not already) and land on its Agent tab. Atomic. */
  openAgentTab: (target: { repoPath: string; repoName: string }) => void;
  /** Jump to a commit in the History tab (e.g. from the blame gutter). ONE atomic set of
   *  `repoTab` + `selectedCommitHash` — a follow-up `set()` gets clobbered by the deferred
   *  transition sets elsewhere. Pass the full 40-char hash; CommitDetailView fetches by
   *  hash, so any reachable commit resolves even if history hasn't paged that far. */
  openCommit: (hash: string) => void;
  openSettings: (target?: SettingsTarget) => void;
  clearSettingsTarget: () => void;
  /** Navigate to Settings → MCP servers and open the registry browser, atomically. */
  openMcpBrowse: () => void;
  setMcpBrowseOpen: (open: boolean) => void;
  setActivityOpen: (open: boolean) => void;
  toggleActivity: () => void;
  /** Open the global ReconnectDialog for a forge sign-in. */
  openReconnect: (target: ReconnectTarget) => void;
  closeReconnect: () => void;
  /** Dismiss the token-expiry notice for `key` (session-scoped, not persisted). */
  dismissExpiryNotice: (key: string) => void;
  /** Record / forget that a PR's merge went into the forge's merge queue. */
  markMergeQueued: (key: string) => void;
  clearMergeQueued: (key: string) => void;
  closeSettings: () => void;
  openHelp: () => void;
  closeHelp: () => void;
  openExplore: () => void;
  closeExplore: () => void;
  setRepoTab: (tab: RepoTab) => void;
  setCompareBranch: (branch: string | null) => void;
  selectPr: (pr: SelectedPr | null) => void;
  setPendingPrSection: (section: PrSection | null) => void;
  setPendingReviewId: (reviewId: string | null) => void;
  selectIssue: (issue: SelectedIssue | null) => void;
  selectDiscussion: (discussion: { number: number } | null) => void;
  setPendingIssueDraft: (
    draft: { title: string; body: string; labels?: string[] } | null,
  ) => void;
  /** Switch to the create's tab and flag its panel to open the dialog. */
  requestCreate: (kind: CreateKind) => void;
  clearPendingCreate: () => void;
  /** Open the hoisted create-local-PR dialog, optionally seeding its branches. */
  openLocalPrCreate: (seeds?: {
    defaultHead?: string;
    defaultBase?: string;
  }) => void;
  closeLocalPrCreate: () => void;
  /** Open / close the hoisted pop-out commit dialog. */
  openCommitDialog: () => void;
  closeCommitDialog: () => void;
  selectRun: (id: number | null) => void;
  selectFinding: (finding: SelectedFinding | null) => void;
  setFindingsLimits: (limits: FindingsLimits) => void;
  /** Ask whichever surface owns the Repository Settings dialog to open it at
   *  `section`. Cleared by that surface as it opens (one-shot). */
  requestRepoSettings: (section: "security") => void;
  clearRepoSettingsRequest: () => void;
  selectTag: (tag: { tag: string } | null) => void;
  setSelectedTodo: (
    todo: {
      path: string;
      line: number;
      marker: string;
      text: string;
    } | null,
  ) => void;
  selectFile: (file: SelectedFile | null) => void;
  selectCommit: (hash: string | null) => void;
  selectCompareCommit: (hash: string | null) => void;
  setCommitDraft: (title: string, body: string) => void;
  setCommitTitle: (title: string) => void;
  setCommitBody: (body: string) => void;
  setCommitCoAuthors: (coAuthors: CommitAuthor[]) => void;
  clearCommitDraft: () => void;
  /** Restore a snapshot for the draft `key` it belonged to (into `commitDrafts[key]`, and
   *  into the live fields only if that key is still active). Undoes an optimistic clear when
   *  a commit fails — `key` is captured at submit, so a mid-commit branch switch can't
   *  restore to the wrong branch. */
  restoreCommitDraft: (draft: CommitDraft, key: string | null) => void;
  setGenerating: (generating: boolean) => void;
  setCommitAiGenerated: (generated: boolean) => void;
  setAmending: (hash: string | null) => void;
  /** Point the live commit fields at `key`'s saved draft (load on repo/branch
   *  switch). The previous draft is already mirrored in `commitDrafts`. */
  loadCommitDraft: (key: string) => void;
  /** Carry a commit draft across a branch rename: moves its `commitDrafts` entry
   *  and, when the renamed branch owns the live fields, retargets `activeDraftKey`.
   *  Always records the old -> new remap so consumers holding the old key (the
   *  generation guard, a `restoreCommitDraft` deferred behind a commit) resolve
   *  to the renamed draft — key identity, not stream survival: a poll that flips
   *  the key first has already cancelled an in-flight generation's next chunk. */
  migrateCommitDraft: (
    repoPath: string,
    fromBranch: string,
    toBranch: string,
  ) => void;
}

export const useUiStore = create<UiState>()((set, get) => {
  // Mirror the live commit-draft fields into commitDrafts[activeDraftKey] on
  // every edit so a draft survives repo/branch switches; empty drafts are
  // pruned so the map doesn't accumulate blanks.
  const setDraftFields = (
    patch: Partial<{
      commitTitle: string;
      commitBody: string;
      commitCoAuthors: CommitAuthor[];
      commitAiGenerated: boolean;
      amendingHash: string | null;
    }>,
  ) =>
    set((s) => {
      const next = {
        commitTitle: s.commitTitle,
        commitBody: s.commitBody,
        commitCoAuthors: s.commitCoAuthors,
        commitAiGenerated: s.commitAiGenerated,
        amendingHash: s.amendingHash,
        ...patch,
      };
      const result: Partial<UiState> = { ...patch };
      if (s.activeDraftKey) {
        const draft: CommitDraft = {
          title: next.commitTitle,
          body: next.commitBody,
          coAuthors: next.commitCoAuthors,
          aiGenerated: next.commitAiGenerated,
          amendingHash: next.amendingHash,
        };
        const drafts = { ...s.commitDrafts };
        if (isEmptyDraft(draft)) delete drafts[s.activeDraftKey];
        else drafts[s.activeDraftKey] = draft;
        result.commitDrafts = drafts;
      }
      return result;
    });

  return {
    view: "welcome",
    previousView: "welcome",
    settingsTarget: null,
    mcpBrowseOpen: false,
    activityOpen: false,
    reconnectTarget: null,
    dismissedExpiryNotices: new Set<string>(),
    queuedMerges: {},
    repoPath: null,
    repoName: null,
    repoTab: "changes",
    compareBranch: null,
    selectedPr: null,
    pendingPrSection: null,
    pendingReviewId: null,
    selectedIssue: null,
    selectedDiscussion: null,
    pendingIssueDraft: null,
    pendingCreate: null,
    localPrCreate: null,
    commitDialogOpen: false,
    selectedRunId: null,
    selectedFinding: null,
    findingsLimits: DEFAULT_FINDINGS_LIMITS,
    repoSettingsRequest: null,
    selectedTag: null,
    selectedTodo: null,
    selectedFile: null,
    selectedCommitHash: null,
    compareCommitHash: null,
    commitTitle: "",
    commitBody: "",
    commitCoAuthors: [],
    generating: false,
    commitAiGenerated: false,
    amendingHash: null,
    commitDrafts: {},
    activeDraftKey: null,
    draftKeyRemaps: {},

    openRepo: (info) =>
      startViewTransition(() =>
        set({
          view: "repo",
          previousView: "repo",
          repoPath: info.root,
          repoName: info.name,
          repoTab: "changes",
          // Clear the live fields; the previous repo's draft stays in
          // commitDrafts (keyed by repo+branch) and CommitBox reloads the new
          // repo's draft once its branch is known.
          ...CROSS_REPO_RESET,
        }),
      ),
    closeRepo: () =>
      startViewTransition(() =>
        set({
          view: "welcome",
          previousView: "welcome",
          repoPath: null,
          repoName: null,
          repoTab: "changes",
          ...CROSS_REPO_RESET,
        }),
      ),
    openPr: (target) =>
      startViewTransition(() => {
        // Before the set, inside this callback: react-query updates an
        // observer's result synchronously, so the flush below renders the
        // caller's write and this selection in one pass.
        target.beforeSelect?.();
        const switchingRepo = get().repoPath !== target.repoPath;
        set({
          view: "repo",
          previousView: "repo",
          repoPath: target.repoPath,
          repoName: target.repoName,
          repoTab: "pulls",
          // Switching repos clears the rest the way openRepo does; staying in
          // the same repo keeps your other selections and just retargets the PR.
          // The explicit PR keys come AFTER the spread so it can't null them.
          ...(switchingRepo ? CROSS_REPO_RESET : {}),
          selectedPr: { kind: target.kind, id: target.ref },
          pendingPrSection: target.section,
          // In THIS set, not a follow-up one: a second set() would be clobbered
          // (see openCommit's note), and the reveal target must land with the
          // selection it belongs to.
          pendingReviewId: target.reviewId ?? null,
        });
      }),
    openRun: (target) =>
      startViewTransition(() => {
        const switchingRepo = get().repoPath !== target.repoPath;
        set({
          view: "repo",
          previousView: "repo",
          repoPath: target.repoPath,
          repoName: target.repoName,
          repoTab: "actions",
          ...(switchingRepo ? CROSS_REPO_RESET : {}),
          // After the reset (which nulls it) so the run stays selected.
          selectedRunId: target.runId,
        });
      }),
    openAgentTab: (target) =>
      startViewTransition(() => {
        const switchingRepo = get().repoPath !== target.repoPath;
        set({
          view: "repo",
          previousView: "repo",
          repoPath: target.repoPath,
          repoName: target.repoName,
          repoTab: "agent",
          ...(switchingRepo ? CROSS_REPO_RESET : {}),
        });
      }),
    setRepoTab: (tab) => set({ repoTab: tab }),
    openCommit: (hash) => set({ repoTab: "history", selectedCommitHash: hash }),
    // Atomic (a follow-up set() would be clobbered); rationale in the compareCommitHash doc.
    setCompareBranch: (branch) =>
      set({ compareBranch: branch, compareCommitHash: null }),
    // Clears any armed reveal in the SAME set (openPr's atomicity): a review
    // request belongs to the PR the notification opened, and picking another
    // from the list would leave it armed to fire on a later return to that one.
    selectPr: (pr) => set({ selectedPr: pr, pendingReviewId: null }),
    setPendingPrSection: (section) => set({ pendingPrSection: section }),
    setPendingReviewId: (reviewId) => set({ pendingReviewId: reviewId }),
    selectIssue: (issue) => set({ selectedIssue: issue }),
    selectDiscussion: (discussion) => set({ selectedDiscussion: discussion }),
    setPendingIssueDraft: (draft) => set({ pendingIssueDraft: draft }),
    requestCreate: (kind) =>
      set({ repoTab: CREATE_TAB[kind], pendingCreate: kind }),
    clearPendingCreate: () => set({ pendingCreate: null }),
    openLocalPrCreate: (seeds) => set({ localPrCreate: seeds ?? {} }),
    closeLocalPrCreate: () => set({ localPrCreate: null }),
    openCommitDialog: () => set({ commitDialogOpen: true }),
    closeCommitDialog: () => set({ commitDialogOpen: false }),
    selectRun: (id) => set({ selectedRunId: id }),
    selectFinding: (finding) => set({ selectedFinding: finding }),
    setFindingsLimits: (limits) => set({ findingsLimits: limits }),
    requestRepoSettings: (section) => set({ repoSettingsRequest: section }),
    clearRepoSettingsRequest: () => set({ repoSettingsRequest: null }),
    selectTag: (tag) => set({ selectedTag: tag }),
    setSelectedTodo: (todo) => set({ selectedTodo: todo }),
    selectCommit: (hash) => set({ selectedCommitHash: hash }),
    selectCompareCommit: (hash) => set({ compareCommitHash: hash }),
    openSettings: (target) =>
      startViewTransition(() => {
        const { view } = get();
        set({
          view: "settings",
          settingsTarget: target ?? null,
          // Keep the underlying view when opening from another overlay.
          previousView:
            view === "settings" || view === "help" || view === "explore"
              ? get().previousView
              : view,
        });
      }),
    clearSettingsTarget: () => set({ settingsTarget: null }),
    // One atomic update (inside the view transition) so the browse flag isn't
    // clobbered by the deferred set the transition schedules.
    openMcpBrowse: () =>
      startViewTransition(() => {
        const { view } = get();
        set({
          view: "settings",
          settingsTarget: "mcp-servers",
          mcpBrowseOpen: true,
          previousView:
            view === "settings" || view === "help" || view === "explore"
              ? get().previousView
              : view,
        });
      }),
    setMcpBrowseOpen: (open) => set({ mcpBrowseOpen: open }),
    setActivityOpen: (open) => set({ activityOpen: open }),
    toggleActivity: () => set((s) => ({ activityOpen: !s.activityOpen })),
    openReconnect: (target) => set({ reconnectTarget: target }),
    closeReconnect: () => set({ reconnectTarget: null }),
    dismissExpiryNotice: (key) =>
      set((s) => ({
        dismissedExpiryNotices: new Set(s.dismissedExpiryNotices).add(key),
      })),
    markMergeQueued: (key) =>
      set((s) => ({ queuedMerges: { ...s.queuedMerges, [key]: true } })),
    clearMergeQueued: (key) =>
      set((s) => {
        if (!s.queuedMerges[key]) return {};
        const { [key]: _gone, ...rest } = s.queuedMerges;
        return { queuedMerges: rest };
      }),
    closeSettings: () =>
      startViewTransition(() => set({ view: get().previousView })),
    openHelp: () =>
      startViewTransition(() => {
        const { view } = get();
        set({
          view: "help",
          previousView:
            view === "settings" || view === "help" || view === "explore"
              ? get().previousView
              : view,
        });
      }),
    closeHelp: () =>
      startViewTransition(() => set({ view: get().previousView })),
    openExplore: () =>
      startViewTransition(() => {
        const { view } = get();
        set({
          view: "explore",
          // Keep the underlying view when opening Explore from another overlay,
          // so closing Explore returns to what was really underneath.
          previousView:
            view === "settings" || view === "help" || view === "explore"
              ? get().previousView
              : view,
        });
      }),
    closeExplore: () =>
      startViewTransition(() => set({ view: get().previousView })),
    selectFile: (file) => set({ selectedFile: file }),
    setCommitDraft: (title, body) =>
      setDraftFields({ commitTitle: title, commitBody: body }),
    setCommitTitle: (title) => setDraftFields({ commitTitle: title }),
    setCommitBody: (body) => setDraftFields({ commitBody: body }),
    setCommitCoAuthors: (coAuthors) =>
      setDraftFields({ commitCoAuthors: coAuthors }),
    clearCommitDraft: () =>
      set((s) => {
        const drafts = { ...s.commitDrafts };
        if (s.activeDraftKey) delete drafts[s.activeDraftKey];
        return {
          commitTitle: "",
          commitBody: "",
          commitCoAuthors: [],
          commitAiGenerated: false,
          amendingHash: null,
          commitDrafts: drafts,
        };
      }),
    restoreCommitDraft: (draft, key) =>
      set((s) => {
        // `key` is captured before the commit is awaited, so a rename landing in
        // between must restore where that draft lives now — the same identity
        // seam the generation guard resolves through.
        const target = resolveDraftKey(s.draftKeyRemaps, key);
        const result: Partial<UiState> = {};
        // Put the message back into the draft it belonged to.
        if (target) {
          const drafts = { ...s.commitDrafts };
          if (isEmptyDraft(draft)) delete drafts[target];
          else drafts[target] = draft;
          result.commitDrafts = drafts;
        }
        // Only touch the live fields if that draft is still the active one —
        // if the user switched branches mid-commit, leave their current draft
        // alone (the restored message reappears when they switch back).
        if (s.activeDraftKey === target) {
          result.commitTitle = draft.title;
          result.commitBody = draft.body;
          result.commitCoAuthors = draft.coAuthors;
          result.commitAiGenerated = draft.aiGenerated;
          result.amendingHash = draft.amendingHash;
        }
        return result;
      }),
    setGenerating: (generating) => set({ generating }),
    setCommitAiGenerated: (generated) =>
      setDraftFields({ commitAiGenerated: generated }),
    setAmending: (hash) => setDraftFields({ amendingHash: hash }),
    loadCommitDraft: (key) =>
      set((s) => {
        // The outgoing draft is already mirrored in commitDrafts, so just point
        // the live fields at the requested key's draft (or a blank one).
        if (key === s.activeDraftKey) return {};
        const d = s.commitDrafts[key] ?? EMPTY_COMMIT_DRAFT;
        return {
          activeDraftKey: key,
          // A real switch retires the rename record: anything it was keeping
          // alive is bound to the key we're leaving, so it can't apply here.
          draftKeyRemaps: {},
          commitTitle: d.title,
          commitBody: d.body,
          commitCoAuthors: d.coAuthors,
          commitAiGenerated: d.aiGenerated,
          amendingHash: d.amendingHash,
        };
      }),
    migrateCommitDraft: (repoPath, fromBranch, toBranch) =>
      set((s) => {
        const oldKey = commitDraftKey(repoPath, fromBranch);
        const newKey = commitDraftKey(repoPath, toBranch);
        if (oldKey === newKey) return {};
        const result: Partial<UiState> = {};
        const moved = s.commitDrafts[oldKey];
        const retargeting = s.activeDraftKey === oldKey;
        // A draft already sitting under the new name belongs to a branch that no
        // longer answers to it, so the state carried across the rename wins —
        // including an empty one, which must leave no entry for the live fields
        // (about to point here) to contradict.
        if (moved || (retargeting && s.commitDrafts[newKey])) {
          const drafts = { ...s.commitDrafts };
          delete drafts[oldKey];
          if (moved) drafts[newKey] = moved;
          else delete drafts[newKey];
          result.commitDrafts = drafts;
        }
        // Recorded for every rename, not just the retargeting one: the status
        // poll can flip the key first, and a generation or a deferred restore
        // still holds the old key. Collapse existing entries onto the new key so
        // a chain of renames stays one lookup deep, dropping any identities.
        const remaps: Record<string, string> = {};
        for (const [from, to] of Object.entries(s.draftKeyRemaps)) {
          const next = to === oldKey ? newKey : to;
          if (next !== from) remaps[from] = next;
        }
        remaps[oldKey] = newKey;
        // A freshly claimed name has no live owner elsewhere, so any surviving
        // mapping AWAY from it is dead — left in place it would hijack the key.
        delete remaps[newKey];
        result.draftKeyRemaps = remaps;
        if (retargeting) {
          result.activeDraftKey = newKey;
        } else if (s.activeDraftKey === newKey && moved) {
          // The status poll can flip the key to the new name before this runs,
          // which blanks the live fields; put the carried-over draft back into
          // them so the rename never costs the user their message.
          result.commitTitle = moved.title;
          result.commitBody = moved.body;
          result.commitCoAuthors = moved.coAuthors;
          result.commitAiGenerated = moved.aiGenerated;
          result.amendingHash = moved.amendingHash;
        }
        return result;
      }),
  };
});
