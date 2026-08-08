import { create } from "zustand";
import type { CommitAuthor, RepoInfo } from "@/lib/git/types";
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
  | { type: "advisory"; ghsaId: string };

/** How many rows each Findings category has asked for. In the store (not panel
 *  state) so the list and the detail pane build identical query keys and share
 *  one cache entry. */
export interface FindingsLimits {
  alerts: number;
  codeScanning: number;
  secretScanning: number;
  advisories: number;
}

/** One page per category — matches the shared LoadMoreRow PAGE_SIZE. */
const DEFAULT_FINDINGS_LIMITS: FindingsLimits = {
  alerts: 100,
  codeScanning: 100,
  secretScanning: 100,
  advisories: 100,
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
 *  same set openRepo / openPrReview reset, hoisted so the run/agent navigations
 *  stay in lockstep. Staying in the same repo keeps the user's other selections. */
const CROSS_REPO_RESET: Partial<UiState> = {
  compareBranch: null,
  localPrCreate: null,
  selectedPr: null,
  pendingPrSection: null,
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
};

/** Key a commit draft so each repo + branch keeps its own message. A git branch
 *  name can't contain a colon, so the key stays unambiguous. */
export function commitDraftKey(repoPath: string, branch: string): string {
  return `${repoPath}:${branch}`;
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
  repoPath: string | null;
  repoName: string | null;
  repoTab: RepoTab;
  /** Branch to compare the current branch against, on the Compare tab. */
  compareBranch: string | null;
  /** Selected PR on the Pull Requests tab. */
  selectedPr: SelectedPr | null;
  /** PR sub-tab to land on when the Pulls view next opens a PR — set by the
   *  activity dock's "View" so a finished review opens straight to it;
   *  consumed and cleared by the PR detail views. */
  pendingPrSection: "review" | null;
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
   *  a panel-hosted instance would have its close deferred by the newly-hidden
   *  Activity subtree and stick open. */
  localPrCreate: { defaultHead?: string; defaultBase?: string } | null;
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

  openRepo: (info: RepoInfo) => void;
  closeRepo: () => void;
  /** Open a repo (if not already open) and land on a PR's AI-review sub-tab —
   *  used by the activity dock's "View". One atomic update so the landing
   *  target survives openRepo's own reset. */
  openPrReview: (target: {
    kind: "remote" | "local";
    repoPath: string;
    repoName: string;
    ref: string;
  }) => void;
  /** Open a repo (if not already) and land on a workflow run in the Actions tab —
   *  used by a notification's click-through. Atomic, like openPrReview. */
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
  closeSettings: () => void;
  openHelp: () => void;
  closeHelp: () => void;
  openExplore: () => void;
  closeExplore: () => void;
  setRepoTab: (tab: RepoTab) => void;
  setCompareBranch: (branch: string | null) => void;
  selectPr: (pr: SelectedPr | null) => void;
  setPendingPrSection: (section: "review" | null) => void;
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
    repoPath: null,
    repoName: null,
    repoTab: "changes",
    compareBranch: null,
    selectedPr: null,
    pendingPrSection: null,
    selectedIssue: null,
    selectedDiscussion: null,
    pendingIssueDraft: null,
    pendingCreate: null,
    localPrCreate: null,
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
    openPrReview: (target) =>
      startViewTransition(() => {
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
          pendingPrSection: "review",
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
    selectPr: (pr) => set({ selectedPr: pr }),
    setPendingPrSection: (section) => set({ pendingPrSection: section }),
    selectIssue: (issue) => set({ selectedIssue: issue }),
    selectDiscussion: (discussion) => set({ selectedDiscussion: discussion }),
    setPendingIssueDraft: (draft) => set({ pendingIssueDraft: draft }),
    requestCreate: (kind) =>
      set({ repoTab: CREATE_TAB[kind], pendingCreate: kind }),
    clearPendingCreate: () => set({ pendingCreate: null }),
    openLocalPrCreate: (seeds) => set({ localPrCreate: seeds ?? {} }),
    closeLocalPrCreate: () => set({ localPrCreate: null }),
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
        const result: Partial<UiState> = {};
        // Put the message back into the draft it belonged to.
        if (key) {
          const drafts = { ...s.commitDrafts };
          if (isEmptyDraft(draft)) delete drafts[key];
          else drafts[key] = draft;
          result.commitDrafts = drafts;
        }
        // Only touch the live fields if that draft is still the active one —
        // if the user switched branches mid-commit, leave their current draft
        // alone (the restored message reappears when they switch back).
        if (s.activeDraftKey === key) {
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
          commitTitle: d.title,
          commitBody: d.body,
          commitCoAuthors: d.coAuthors,
          commitAiGenerated: d.aiGenerated,
          amendingHash: d.amendingHash,
        };
      }),
  };
});
