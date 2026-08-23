export interface GitInfo {
  version: string;
}

export interface RepoInfo {
  root: string;
  name: string;
}

export type ChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "conflicted"
  | "untracked";

export interface FileEntry {
  path: string;
  origPath?: string;
  staged: ChangeKind | null;
  unstaged: ChangeKind | null;
}

export interface BranchHead {
  name: string | null;
  detached: boolean;
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** The upstream is configured but its remote-tracking ref is gone (e.g. the
   *  remote branch was deleted after a PR merge). Treat like "no upstream" for
   *  decisions: offer Publish over Push/Pull, allow undo-commit, don't demand a
   *  force-push on amend. */
  upstreamGone: boolean;
}

export interface RepoStatus {
  branch: BranchHead;
  entries: FileEntry[];
}

export interface Branch {
  name: string;
  isCurrent: boolean;
  upstream: string | null;
  /** ISO-8601 committer date of the branch tip (for recency sorting). */
  lastCommitDate: string;
  /** Hidden from the branch dropdown (a personal, local-config flag). */
  archived: boolean;
  /** Commits this branch is ahead of its own upstream. 0 when the branch is
   *  untracked, its upstream is gone, or the two are in sync. */
  upstreamAhead: number;
  /** Commits this branch is behind its own upstream — drives the
   *  "Update from {upstream}" action. 0 when untracked, gone, or in sync. */
  upstreamBehind: number;
  /** The upstream is configured but its remote-tracking ref is gone (e.g. the
   *  remote branch was deleted after a PR merge). Read as "no upstream" for
   *  pushed-ness decisions. */
  upstreamGone: boolean;
  /** The remote of the branch's upstream (git's `%(upstream:remotename)`), e.g.
   *  `origin` — null when untracked. Authoritative source for which remote a push
   *  targets; the UI must never re-derive it from the upstream string. */
  upstreamRemote: string | null;
}

/** A branch that exists on a remote but not locally — offered in the switcher so
 *  it can be checked out (which creates a local tracking branch). */
export interface RemoteBranch {
  /** Short branch name, without the remote prefix (e.g. `feature/x`). */
  name: string;
  /** The remote it lives on (e.g. `origin`). */
  remote: string;
  /** ISO-8601 committer date of the branch tip (for recency sorting). */
  lastCommitDate: string;
}

/**
 * Evidence for telling a server-side REWRITE of a branch's upstream (a remote
 * rebase or force-push — GitHub's "Update branch → rebase") apart from ordinary
 * two-sided divergence. The two want opposite remedies, so the app measures
 * rather than guesses.
 *
 * `remoteRewritten` answers one narrow question: is the upstream tip absent from
 * this branch's own reflog. That is NOT proof of a rewrite on its own — ordinary
 * divergence looks identical — so only the pair `remoteRewritten === true &&
 * localOnly === 0` (nothing local lacks a patch-twin upstream) may unlock a
 * reset-to-upstream offer. `null` means nothing was provable and every surface
 * must render exactly what it renders without this data.
 */
export interface BranchRewriteStatus {
  remoteRewritten: boolean | null;
  /** Commits on the branch with no patch-equivalent upstream — exactly the work
   *  a reset to the upstream would destroy. */
  localOnly: number;
  /** Commits on the upstream with no patch-equivalent locally. */
  remoteOnly: number;
  /** Commits matched by patch id. Counts BOTH sides of each pair, so a clean
   *  N-commit rebase reports `2 * N` — never render it as a commit count. */
  patchEqual: number;
  /** The upstream's short name (e.g. `origin/feature`). */
  upstream: string | null;
  /** The upstream tip's sha — a confirmed reset targets this commit, so it can
   *  only land on the state the user was shown. */
  upstreamTip: string | null;
}

/** A local branch's ahead/behind counts vs. the default branch. */
export interface BranchDivergence {
  name: string;
  /** Commits on this branch the default branch doesn't have. */
  ahead: number;
  /** Commits on the default branch this branch doesn't have. */
  behind: number;
}

export interface RepoOwner {
  path: string;
  owner: string | null;
  /** The origin remote's host (e.g. "github.com", "gitlab.com") — lets per-repo
   *  UI name the actual provider. */
  host: string | null;
  /** The provider that host routes to ("github" / "gitlab" / "bitbucket"),
   *  including self-managed GitLab hosts glab is signed in to. Null when
   *  unrecognized — the UI labels those GitHub (gh stays authoritative). */
  provider: string | null;
}

/** A git submodule and its state vs. the commit the parent records. */
export interface Submodule {
  path: string;
  sha: string;
  describe: string;
  /** "ok" | "uninitialized" | "modified" | "conflict" */
  status: string;
}

export interface FileDiff {
  filePath: string;
  isBinary: boolean;
  isTruncated: boolean;
  text: string;
}

export interface DiffStatEntry {
  path: string;
  added: number;
  deleted: number;
  isBinary: boolean;
}

export interface StagedDiff {
  text: string;
  truncated: boolean;
  files: DiffStatEntry[];
  /** Changed files hidden from the AI context by ignore patterns. */
  excludedFiles: number;
}

/** Why a `DeltaDiff` could (or couldn't) be computed — drives how the caller
 *  frames or omits the "changes since last review" delta. */
export type DeltaReason = "ok" | "missing" | "rewritten" | "indeterminate";

/** The literal two-dot `from..to` diff ("what changed since"), with a `reason`
 *  for graceful fallback when the delta can't be produced. */
export interface DeltaDiff {
  resolvable: boolean;
  isAncestor: boolean;
  reason: DeltaReason;
  text: string;
  truncated: boolean;
  files: DiffStatEntry[];
}

export interface CommitSummary {
  hash: string;
  subject: string;
  author: string;
  /** Author email (%ae) — drives the History-tab commit avatar. May be "". */
  authorEmail: string;
  date: string;
  /** Tags pointing at this commit. */
  tags: string[];
  /** More than one parent — history rewriting must not cross it. */
  isMerge: boolean;
}

export interface CommitDetails {
  hash: string;
  subject: string;
  body: string;
  author: string;
  authorEmail: string;
  date: string;
}

/** One line of `git blame`: its content plus the commit that last changed it. */
export interface BlameLine {
  lineNo: number;
  hash: string;
  author: string;
  /** Author time, epoch seconds. */
  time: number;
  summary: string;
  content: string;
}

export interface CommitResult {
  hash: string;
}

/** One TODO/FIXME/HACK/… comment found in the working tree by `git_todo_scan`. */
export interface TodoScanItem {
  /** Repo-relative path, forward slashes. */
  path: string;
  /** 1-based line number of the match. */
  line: number;
  /** The marker word that matched, e.g. `"TODO"`. */
  marker: string;
  /** The comment text after the marker (may be `""`); capped at 300 chars
   *  server-side. */
  text: string;
}

/** Result of a working-tree TODO scan (`git_todo_scan`). */
export interface TodoScan {
  /** Matches in git grep output order (grouped by path). */
  items: TodoScanItem[];
  /** The global cap (default 2000) was hit — more matches may exist. */
  truncated: boolean;
}

/** Result of applying a review suggestion to the working tree (see
 *  `gitReplaceFileLines` for the verification/EOL contract). */
export interface ApplyLinesResult {
  /** File was staged (only when it had no other local changes before the apply). */
  staged: boolean;
  /** File already had local changes before the apply — we never auto-stage then. */
  hadLocalChanges: boolean;
}

export interface CommitAuthor {
  name: string;
  email: string;
}

/** One resulting commit in a history rewrite (multi-hash = squash). */
export interface RewriteStep {
  hashes: string[];
  message?: string;
  /** Pause at this commit (interactive-rebase path only; the replay engine
   *  ignores it). */
  edit?: boolean;
}

export interface MergePreview {
  /** "up-to-date" (already merged) · "fast-forward" · "clean" (merge commit, no
   *  conflicts) · "conflict" · "unknown" (couldn't predict — old git/error). */
  status: "up-to-date" | "fast-forward" | "clean" | "conflict" | "unknown";
  /** Conflicting file paths when `status` is "conflict" (may be empty). */
  conflicts: string[];
}

export interface StashEntry {
  index: number;
  message: string;
  date: string;
}

export interface StashFile {
  path: string;
  added: number;
  deleted: number;
  isBinary: boolean;
  /** In the stash's untracked-files parent; its content reads from there. */
  untracked: boolean;
}

/** A dangling/orphaned stash commit found via `git fsck` — lost uncommitted work
 *  that fell out of `git stash list` (e.g. abandoned by an interrupted op).
 *  Addressed by its raw `sha` since it has no `stash@{n}` slot. */
export interface OrphanedStash {
  sha: string;
  message: string;
  date: string;
  fileCount: number;
}

export interface LanguageStat {
  name: string;
  files: number;
  lines: number;
  bytes: number;
}

export interface ContributorStat {
  name: string;
  commits: number;
}

export interface RepoStats {
  commitCount: number;
  branchCount: number;
  tagCount: number;
  contributorCount: number;
  topContributors: ContributorStat[];
  firstCommitDate: string | null;
  lastCommitDate: string | null;
  trackedFiles: number;
  trackedBytes: number;
  gitDirBytes: number;
  totalLines: number;
  languages: LanguageStat[];
}

export interface BranchStats {
  commitCount: number;
  contributorCount: number;
  topContributors: ContributorStat[];
  firstCommitDate: string | null;
  lastCommitDate: string | null;
  filesChanged: number;
  additions: number;
  deletions: number;
}

// ── Insights graphs (local-git) ──────────────────────────────────────────────

/** A contributor with commit count + line churn, for the Insights tab. */
export interface ContributorChurn {
  name: string;
  commits: number;
  additions: number;
  deletions: number;
}

/** Commits in one ISO week ("2025-07"); sorts chronologically as a string. */
export interface WeekCount {
  week: string;
  commits: number;
}

/** Additions/deletions in one ISO week, for the code-frequency graph. */
export interface CodeFreqPoint {
  week: string;
  additions: number;
  deletions: number;
}

/** Punch card: 7 rows (day-of-week, 0=Sun) × 24 columns (hour) of commit counts. */
export type PunchCard = number[][];

/** Community-health profile + social counts (gh API), for the Insights tab. */
export interface CommunityInsights {
  healthPercentage: number;
  hasReadme: boolean;
  hasLicense: boolean;
  hasCodeOfConduct: boolean;
  hasContributing: boolean;
  hasIssueTemplate: boolean;
  hasPullRequestTemplate: boolean;
  license: string | null;
  forksCount: number;
  stargazersCount: number;
  watchersCount: number;
  openIssuesCount: number;
  private: boolean;
}

/** One day of traffic (views or clones). */
export interface TrafficPoint {
  timestamp: string;
  count: number;
  uniques: number;
}

/** A traffic referrer or popular path. */
export interface TrafficItem {
  name: string;
  title: string;
  count: number;
  uniques: number;
}

/** 14-day repo traffic (gh API; needs push access → `available: false` if not). */
export interface RepoTraffic {
  available: boolean;
  viewsCount: number;
  viewsUniques: number;
  views: TrafficPoint[];
  clonesCount: number;
  clonesUniques: number;
  clones: TrafficPoint[];
  referrers: TrafficItem[];
  paths: TrafficItem[];
}

export interface DependencyPackage {
  ecosystem: string;
  name: string;
  version: string;
  /** Declared directly by the repo (vs. pulled in transitively). */
  direct: boolean;
}

/** Dependency-graph SBOM summary (gh API; `available: false` when the graph is off). */
export interface RepoDependencies {
  available: boolean;
  total: number;
  packages: DependencyPackage[];
}

export interface RepoOpState {
  merging: boolean;
  rebasing: boolean;
  cherryPicking: boolean;
  reverting: boolean;
  /** An interactive rebase is paused at an `edit` (vs a conflict). */
  editPaused: boolean;
}

export type RepoOp = "merge" | "rebase" | "cherry-pick" | "revert";

/**
 * One journaled entry from GitDesktop's operation log (`oplog.rs`) — a risky compound
 * git op plus the state it started from, so an interrupted op can be traced or
 * recovered. `op`/`status` are typed as their known values but must be rendered
 * tolerantly (a future backend value must not crash the UI). Wire shape is camelCase.
 */
export interface OpLogEntry {
  id: string;
  op: "merge_local_pr" | "cherry_pick_onto" | "rewrite_commits" | "rebase_edit";
  /** Human label, e.g. "Squash-merge feature → main". */
  label: string;
  /** "paused" = handed to you mid-op (a stopped cherry-pick), neither in-flight nor
   *  finished. "concluded" = that pick ended outside the app, so the journal knows
   *  only that it is over (no finish time). */
  status: "pending" | "done" | "failed" | "dismissed" | "paused" | "concluded";
  /** ISO timestamp the op started. */
  startedAt: string;
  /** ISO timestamp the op finished, or null while still open. */
  finishedAt: string | null;
  /** The branch (or "HEAD" if detached) we were on before the op. */
  originalRef: string | null;
  /** Pre-op HEAD sha. */
  originalSha: string;
  /** The reset-rollback target tip, if one was captured. */
  preOpTip: string | null;
  /** Failure detail when `status === "failed"`. */
  error: string | null;
}

export interface BranchComparison {
  /** On `compare` but not `base` — what a PR would introduce. */
  ahead: CommitSummary[];
  /** On `base` but not `compare` — what `compare` is missing. */
  behind: CommitSummary[];
}

export interface PrPollInfo {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  author: string;
  reviewDecision: string;
  /** Check rollup of the head commit: SUCCESS/FAILURE/PENDING/"". */
  checksState: string;
  /** Head commit SHA — drives pr-sync detection for remote PRs. */
  headSha: string;
  /** Conversation-comment count — a rise between polls = a new comment. GitHub
   *  only (0 for GitLab/Bitbucket in v1). */
  commentCount: number;
  /** Login of the latest comment's author — used to suppress a "new comment"
   *  notification for your own comment. GitHub only ("" elsewhere in v1). */
  lastCommentAuthor: string;
  /** Submitted-review count — a rise without a `reviewDecision` change =
   *  a plain "commented" review. GitHub only (0 for GitLab/Bitbucket in v1). */
  reviewCount: number;
  /** Login of the latest review's author — used to suppress a "new review"
   *  notification for your own review. GitHub only ("" elsewhere in v1). */
  lastReviewAuthor: string;
  /** Node id of the latest review — the same id its card carries in the detail
   *  view, so a review notification can land on that card. GitHub only ("" for
   *  GitLab/Bitbucket in v1). */
  lastReviewId: string;
  /** Logins currently requested to review — you newly appearing here fires a
   *  "review requested" notification. GitHub only (empty elsewhere in v1). */
  reviewRequests: string[];
  /** Head branch name ("" when the provider can't supply it). */
  headRefName: string;
  /** Base/target branch name ("" when the provider can't supply it). */
  baseRefName: string;
  /** ISO-8601 timestamp of when the PR was opened; "" when the provider didn't
   *  supply it. Drives the missed-open catch-up's recency window (an empty or
   *  unparsable value fails closed — the PR isn't caught up). */
  createdAt: string;
}

export interface GhRepo {
  nameWithOwner: string;
  owner: string;
  name: string;
  private: boolean;
  archived: boolean;
  fork: boolean;
  cloneUrl: string;
  sshUrl: string;
  description: string | null;
  pushedAt: string | null;
}

export interface GhRepoList {
  /** The signed-in user's login, so the UI can list their repos first. */
  viewer: string;
  repos: GhRepo[];
}

/** Provider-neutral repository row for the clone browser (GitHub via gh, GitLab
 *  via glab). Mirrors {@link GhRepo} but with a provider-agnostic `fullName`. */
export interface ForgeRepo {
  /** "owner/name" (GitHub) or "group/subgroup/name" (GitLab). */
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  archived: boolean;
  fork: boolean;
  cloneUrl: string;
  sshUrl: string;
  description: string | null;
  pushedAt: string | null;
}

export interface ForgeRepoList {
  /** The signed-in user's login. Kept on the wire; no frontend consumer today. */
  viewer: string;
  /** The `owner` namespaces that count as the viewer's own — a set because "yours" is
   *  provider-shaped: a login on GitHub and GitLab, any workspace you belong to on
   *  Bitbucket. Drives the own-repo Fork gate and the yours-first grouping; empty
   *  means unresolved, so both fail open. */
  ownedNamespaces: string[];
  repos: ForgeRepo[];
}

/** A repository row from the Explore search/browse surface — richer than
 *  {@link ForgeRepo} (stars/language/updatedAt) so results you don't own can rank and
 *  describe. Rust `Option<T>` serializes to `null`. */
export interface ForgeSearchRepo {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  archived: boolean;
  fork: boolean;
  cloneUrl: string;
  sshUrl: string;
  description: string | null;
  updatedAt: string | null;
  stars: number | null;
  language: string | null;
  webUrl: string | null;
  defaultBranch: string | null;
}

/** One page of Explore search results. `hasMore` drives the load-more button;
 *  `total` is the provider's reported match count (GitHub caps search at 1000
 *  reachable results, so `total` may exceed what paging can reach; null when the
 *  provider gives no count). */
export interface ForgeSearchList {
  repos: ForgeSearchRepo[];
  hasMore: boolean;
  total: number | null;
}

/** The result of forking a repo by name. Fork is async server-side, so
 *  `ready: false` means the fork was created but its git objects may not be
 *  clonable yet. */
export interface ForgeForkResult {
  fullName: string;
  cloneUrl: string;
  webUrl: string | null;
  ready: boolean;
}

/** What a provider supports *and* what GitDesktop has built for it, bundled for
 *  the Explore surface so it can gate Fork/Star/README in one fetch. */
export interface ForgeProviderFeatures {
  capabilities: ForgeCapabilities;
  implemented: ForgeImplemented;
}

export interface GhAccount {
  /** The host this account is signed in to ("github.com" or an Enterprise
   *  server). Accounts are grouped by host and switched per host. */
  host: string;
  login: string;
  active: boolean;
}

export interface GhAccounts {
  /** gh's version (e.g. "2.18.1"), "" when gh isn't installed. */
  version: string;
  accounts: GhAccount[];
}

/** The health of a forge sign-in session (gh/glab account, or a Bitbucket token).
 *  `"offline"` means the probe was inconclusive (a network blip) — treated as
 *  "unchanged": it must never flip any UI, so nothing regresses on a bad network. */
export type SessionState =
  | "healthy"
  | "broken"
  | "notConnected"
  | "cliMissing"
  | "offline";

/** One forge session's health, provider-neutral. Populated by `forge_session_health`
 *  (this repo's session) and `forge_accounts_health` (every known account). */
export interface SessionHealth {
  provider: ForgeProvider;
  host: string;
  state: SessionState;
  login: string | null;
  /** gh accounts only — whether this is the active account on its host. */
  active: boolean | null;
  /** A short human reason for a `broken`/`offline` state (a tooltip). */
  detail: string | null;
  method: "oauth" | "pat" | "token" | null;
  /** ISO-8601 expiry when knowable (GitLab/GitHub PAT, user-entered Bitbucket
   *  date); null otherwise (e.g. an OAuth session that renews itself). */
  expiresAt: string | null;
  /** Whole days until `expiresAt` (may be negative/0); null when not knowable. */
  daysLeft: number | null;
}

/** A streaming event from a `forge_reconnect` flow, delivered over a Channel.
 *  `code` is gh's device-flow one-time code + URL; `line` is a glab progress
 *  line; `finished` is the terminal result. */
export type ReconnectEvent =
  | { type: "code"; code: string; url: string }
  | { type: "line"; text: string }
  | {
      type: "finished";
      ok: boolean;
      login: string | null;
      message: string | null;
    };

export interface GhStatus {
  installed: boolean;
  authenticated: boolean;
  /** The active account's login on this repo's host, when it can be determined. */
  login: string | null;
  /** "owner/name" when this repo has a GitHub remote gh recognizes. */
  repo: string | null;
  /** The repo's GitHub host — "github.com" or an Enterprise server like
   *  "github.acme.com" — when it's a recognized GitHub repo. */
  host: string | null;
}

/** The hosting platform backing a repo's hosted features. */
export type ForgeProvider = "github" | "gitlab" | "bitbucket";

/** The human label for a provider. Null/undefined (an unrecognized host that
 *  routes through gh) reads as "GitHub" — gh stays the authoritative default. */
export function providerLabel(
  provider: ForgeProvider | null | undefined,
): "GitHub" | "GitLab" | "Bitbucket" {
  if (provider === "gitlab") return "GitLab";
  if (provider === "bitbucket") return "Bitbucket";
  return "GitHub";
}

/** A signed-in Bitbucket Cloud account (validated against GET /2.0/user before
 *  the token is saved). The token itself is never returned by anything. */
export interface BbAccountInfo {
  /** The Atlassian account email — the HTTP Basic username for API-token auth. */
  email: string;
  username: string | null;
  displayName: string | null;
}

/** What a provider (and this repo on it) supports, so panels show only controls that
 *  work instead of erroring. GitHub is all-true; GitLab/Bitbucket follow the parity
 *  matrix. */
export interface ForgeCapabilities {
  pullRequests: boolean;
  draftPrs: boolean;
  issues: boolean;
  labels: boolean;
  milestones: boolean;
  reactions: boolean;
  discussions: boolean;
  stars: boolean;
  ci: boolean;
  webhooks: boolean;
  approvals: boolean;
  /** The Findings tab. Each provider reads what it actually has: GitHub the
   *  platform alert APIs (Dependabot, code scanning, secret scanning, repository
   *  advisories); GitLab the SAST, secret detection and code quality report
   *  artifacts of a pipeline. Bitbucket has no analogue. */
  securityFindings: boolean;
}

/** Which hosted features GitDesktop has actually *built* for a provider — a different
 *  axis from {@link ForgeCapabilities} (what the platform can do). GitHub is all-true;
 *  a *ready* GitLab/Bitbucket repo whose feature isn't built degrades to "coming soon"
 *  rather than firing GitHub calls. Gated via `forgeFeatureReady`. */
export interface ForgeImplemented {
  pullRequests: boolean;
  issues: boolean;
  ci: boolean;
  releases: boolean;
  insights: boolean;
  /** Repo-management surface: View/Fork/Star/admin settings, branch-rule import. */
  repoActions: boolean;
  /** Searching/browsing repositories on the provider (the Explore surface). */
  repoSearch: boolean;
  /** Forking a repository by owner/name from the Explore surface. */
  repoForkByName: boolean;
  /** Starring / unstarring a repository from the Explore surface. */
  repoStar: boolean;
  /** Fetching a repository's rendered README for the Explore preview. */
  repoReadme: boolean;
  /** Publishing a local repo to the provider (create remote + push). */
  publish: boolean;
  /** Posting a comment/note on an issue (first per-action write). */
  issueComment: boolean;
  /** Closing / reopening an issue. */
  issueState: boolean;
  /** Posting a comment/note on a merge/pull request. */
  mrComment: boolean;
  /** Closing / reopening a merge/pull request (not merge). */
  mrState: boolean;
  /** Approving / unapproving via the bodyless toggle — GitLab and Bitbucket. GitHub
   *  approves through its Review menu instead, so it's false there. */
  mrApprove: boolean;
  /** Merging a merge/pull request (strategy + delete-source-branch) — a shared
   *  control on all three providers. */
  mrMerge: boolean;
  /** Arming merge-when-pipeline-succeeds (auto-merge) on an MR while its head
   *  pipeline is in flight — GitLab-only (GitHub has no in-app PR auto-merge),
   *  so it's false elsewhere. */
  mrAutoMerge: boolean;
  /** Editing labels on an issue — a shared control (GitHub by node id, GitLab by
   *  name), so true for both. */
  issueLabels: boolean;
  /** Editing labels on a merge/pull request — the same shared label control. */
  mrLabels: boolean;
  /** Setting an issue's assignees — a shared issue control. (MR assignees are the
   *  separate `mrAssignees` below.) */
  issueAssignees: boolean;
  /** Creating an issue from the app — a shared control (the GitHub-only org
   *  issue type hides per provider in the dialog; milestone works on both). */
  issueCreate: boolean;
  /** Creating a merge/pull request from the app (push head + open) — shared. */
  mrCreate: boolean;
  /** Re-running a finished CI run — shared. (GitLab retries failed+canceled jobs
   *  only; "re-run all" stays a GitHub-only affordance.) */
  ciRerun: boolean;
  /** Cancelling an in-flight CI run — shared. */
  ciCancel: boolean;
  /** Manually starting a CI run — shared (GitHub dispatches a workflow; GitLab
   *  runs a new pipeline on a ref, with variables instead of inputs). */
  ciDispatch: boolean;
  /** Publishing a new release — shared (the GitHub-only draft/pre-release/latest
   *  toggles hide per provider in the dialog). */
  releaseCreate: boolean;
  /** Managing an existing release (edit, delete, upload/delete assets) — shared. */
  releaseEdit: boolean;
  /** Setting a merge/pull request's assignees — a shared control for GitHub and GitLab
   *  (GitHub PRs are issues under the hood); false for Bitbucket, which has no PR
   *  assignee concept. */
  mrAssignees: boolean;
  /** Requesting changes on an MR (the blocking reviewer state) — GitLab and
   *  Bitbucket (GitHub requests changes via its Review menu). Bitbucket's revoke
   *  works on every plan, so the control toggles there; GitLab is one-shot. */
  mrRequestChanges: boolean;
  /** Editing a merge/pull request's reviewer list — shared on all three providers. Each
   *  provider's setter preserves reviewer kinds it doesn't manage (teams, bots). */
  mrReviewers: boolean;
  /** Editing an existing issue's title/body — the shared edit dialog. */
  issueEdit: boolean;
  /** Editing an existing merge/pull request's title/body — the same shared
   *  edit control. */
  mrEdit: boolean;
  /** Editing + deleting your own comments on a merge/pull request. GitHub gates these
   *  via `canWrite`; GitLab and Bitbucket true. */
  mrCommentEdit: boolean;
  /** Editing + deleting your own comments on an issue — the same shared
   *  Thread controls. GitLab true; Bitbucket issues aren't wired, so false. */
  issueCommentEdit: boolean;
  /** Setting or clearing an issue's milestone — the shared picker. `Milestone.
   *  number` is whatever key the provider's write takes (GitHub milestone
   *  number, GitLab global milestone id). */
  issueMilestone: boolean;
  /** Reactions on an issue + its comments — the shared ReactionBar (GitHub
   *  reacts by node id, GitLab awards emoji by issue/note id). */
  issueReactions: boolean;
  /** Reactions on a merge/pull request + its comments — the same ReactionBar. */
  mrReactions: boolean;
  /** Locking/unlocking an issue's conversation (GitHub with an optional
   *  reason; GitLab has none, so the reason submenu hides per provider). */
  issueLock: boolean;
  /** Moving an issue to another repository/project (GitHub "transfer",
   *  GitLab "move" — the same dialog). */
  issueTransfer: boolean;
  /** Permanently deleting an issue (server-side role checks apply). */
  issueDelete: boolean;
  /** Marking an issue confidential (members-only). GitLab-unique, so false for
   *  GitHub. */
  issueConfidential: boolean;
  /** Setting/clearing an issue's due date. GitLab-unique — false for GitHub. */
  issueDueDate: boolean;
  /** The repository-settings dialog (admin probe + General / Danger zone and
   *  the provider's extra sections). */
  repoSettings: boolean;
  /** Playing a manual CI job (one awaiting a "play"). GitLab-unique, so false for
   *  GitHub. */
  ciJobPlay: boolean;
  /** Time tracking (estimate + spent) on issues and MRs. GitLab-unique, so false for
   *  GitHub. */
  timeTracking: boolean;
  /** Related-issue links (relates_to) on issues. GitLab-unique — GitHub models
   *  relationships as sub-issues/dependencies instead. */
  issueLinks: boolean;
  /** The pull-request tasks checklist (create/edit/resolve/delete). Bitbucket-only — no
   *  GitHub/GitLab analogue is wired. */
  prTasks: boolean;
  /** Reading file:line-anchored review threads on a merge/pull request (GitHub
   *  reviewThreads / GitLab diff-note discussions / Bitbucket inline comments). */
  mrReviewThreads: boolean;
  /** Replying into an existing review thread. */
  mrThreadReply: boolean;
  /** Resolving / unresolving a review thread. */
  mrThreadResolve: boolean;
  /** Editing + deleting your own comment inside a review thread (thread-scoped like
   *  reply/resolve). GitHub gates via `canWrite`; GitLab and Bitbucket true. */
  mrThreadCommentEdit: boolean;
  /** Commenting on individual commits of a merge/pull request (plain or
   *  diff-anchored commit comments) — a shared control. */
  commitComments: boolean;
  /** Creating a new file:line-anchored review thread on a merge/pull request — a
   *  shared control (distinct from replying into an existing thread). */
  mrThreadCreate: boolean;
  /** Submitting a batch review (verdict + summary + staged draft comments) — a
   *  shared control (GitHub review submit, GitLab batch note post). */
  mrReviewSubmit: boolean;
  /** Toggling a PR/MR's draft state both ways from the shared Ready /
   *  Convert-to-draft control. GitLab (`glab mr update --ready|--draft`) and
   *  Bitbucket (PUT `draft`) true; GitHub keeps its Ready/Convert path via
   *  `gh pr ready [--undo]` gated on `canWrite`, so it stays false here. */
  mrDraftToggle: boolean;
}

/** One pull-request task (Bitbucket's PR checklist). `id`/`commentId` are numeric
 *  server ids serialized as Strings (u64-precision rule); `state` is
 *  `"UNRESOLVED"` | `"RESOLVED"`. `creator`/`resolvedBy` are display names (task
 *  user objects carry no username). */
export interface PrTask {
  id: string;
  /** "UNRESOLVED" | "RESOLVED" */
  state: string;
  /** The task text (`content.raw`). */
  text: string;
  /** The creator's display name (falls back to nickname, then ""). */
  creator: string;
  createdOn: string;
  /** Who resolved it, or null while unresolved. */
  resolvedBy: string | null;
  /** The PR comment this task is attached to, or null for a standalone task. */
  commentId: string | null;
  /** The task's web URL, or "". */
  url: string;
}

/** One Bitbucket deployment environment (minimal read — lock/category unmapped).
 *  `adminOnly` is `restrictions.admin_only`; `environmentType` is the tier name. */
export interface BbEnvironment {
  uuid: string;
  name: string;
  /** The tier name ("Test" / "Staging" / "Production"), or "". */
  environmentType: string;
  rank: number;
  hidden: boolean;
  /** Whether the environment is restricted to admins. */
  adminOnly: boolean;
}

/** Whether the viewer can manage this repo's settings (`admin`) and whether
 *  they hold the owner-only lifecycle powers (`owner`). GitHub admin implies
 *  both; GitLab distinguishes Maintainer from Owner. */
export interface ForgeRepoAdmin {
  admin: boolean;
  owner: boolean;
}

/** Viewer write-permission on the repo behind the lens. A null `canPush` /
 *  `canTriage` means the probe couldn't answer that axis (`repo` and
 *  `unknownReason` may still be set) — consumers must FAIL OPEN on null
 *  (leave controls enabled). */
export interface ForgeRepoWriteAccess {
  canPush: boolean | null;
  /** Triage tier and above, which grants labels, assignees, milestones, review
   *  requests, hiding comments and close/reopen WITHOUT push (GitHub triage;
   *  GitLab Reporter) — a separate axis, not implied by `canPush`. Pin is
   *  write-tier; locking is write-tier on GitHub but Reporter (triage) on
   *  GitLab. */
  canTriage: boolean | null;
  role: string | null;
  /** The probed repo identity ("owner/repo") for UI copy. */
  repo: string | null;
  unknownReason: string | null;
}

/** GitLab project settings — its own shape rather than a lossy mapping onto
 *  {@link RepoSettings}: features are ACCESS LEVELS (enabled / private /
 *  disabled), the merge style is one enum, squash is a four-way option. */
export interface GitLabRepoSettings {
  description: string | null;
  topics: string[];
  defaultBranch: string | null;
  /** "private" | "internal" | "public" — read-only here (Danger zone changes it). */
  visibility: string;
  webUrl: string;
  /** Full path ("group/name") — the Danger-zone confirm phrase. */
  fullName: string;
  /** URL slug (what a rename edits). */
  path: string;
  /** Display name. */
  name: string;
  archived: boolean;
  /** "enabled" | "private" (members only) | "disabled" */
  issuesAccessLevel: string;
  mergeRequestsAccessLevel: string;
  wikiAccessLevel: string;
  snippetsAccessLevel: string;
  forkingAccessLevel: string;
  /** "merge" | "rebase_merge" (semi-linear) | "ff" */
  mergeMethod: string;
  /** "never" | "always" | "default_on" | "default_off" */
  squashOption: string;
  removeSourceBranchAfterMerge: boolean;
  onlyAllowMergeIfPipelineSucceeds: boolean;
  onlyAllowMergeIfAllDiscussionsAreResolved: boolean;
}

/** The GitLab settings the General form sends back (the managed subset). */
export type GitLabRepoSettingsInput = Omit<
  GitLabRepoSettings,
  | "visibility"
  | "webUrl"
  | "fullName"
  | "path"
  | "name"
  | "archived"
  | "description"
> & { description: string };

/** A GitLab project member. `id` is the user id as a string (IPC-safe). */
export interface GitLabMember {
  id: string;
  username: string;
  avatarUrl: string;
  /** 10 Guest / 15 Planner / 20 Reporter / 30 Developer / 40 Maintainer / 50 Owner. */
  accessLevel: number;
  /** Added on this project directly (editable) vs inherited from a group. */
  direct: boolean;
}

/** A GitLab project webhook. Events are per-hook boolean flags on GitLab —
 *  `events` carries the enabled flag names ("push_events", …). */
export interface GitLabHook {
  id: string;
  url: string;
  events: string[];
  enableSslVerification: boolean;
  /** "executable", or "disabled"/"temporarily_disabled" once GitLab
   *  auto-disables a failing hook. */
  alertStatus: string;
  createdAt: string;
}

/** What the webhook form sends. `token: null` leaves an existing secret
 *  unchanged (GitLab never returns it). */
export interface GitLabHookInput {
  url: string;
  token: string | null;
  enableSslVerification: boolean;
  events: string[];
}

/** One recorded delivery of a GitLab hook, payloads inline. */
export interface GitLabHookDelivery {
  id: string;
  /** e.g. "push_hooks". */
  trigger: string;
  /** The endpoint's HTTP status ("405") or a failure word. */
  responseStatus: string;
  createdAt: string;
  /** Seconds. */
  duration: number;
  requestPayload: string;
  responsePayload: string;
}

/** A GitLab CI/CD variable — one store (vs GitHub's secrets/variables split):
 *  `masked` hides the value in job logs, `protected` limits it to protected
 *  refs; the API still returns values to maintainers. */
export interface GitLabVariable {
  key: string;
  value: string;
  protected: boolean;
  masked: boolean;
  /** "*" for unscoped. A key can repeat at different scopes (a Premium
   *  feature the app displays but doesn't create) — writes address key+scope. */
  environmentScope: string;
}

/** One access-level entry in a protected branch's push/merge allow list.
 *  Free tier carries a single {0,30,40} role; Premium can add multiple entries
 *  (users/groups/deploy keys), each with its own `description`. */
export interface GitLabAccessLevelEntry {
  accessLevel: number;
  description: string;
}

/** A GitLab protected branch rule. Access levels are set at creation time (the
 *  REST API ignores level changes on update on Free tier), so only
 *  `allowForcePush` is row-editable. `inherited` rules come from a group and
 *  are managed there, not here. */
export interface GitLabProtectedBranch {
  id: string;
  name: string;
  pushLevels: GitLabAccessLevelEntry[];
  mergeLevels: GitLabAccessLevelEntry[];
  allowForcePush: boolean;
  inherited: boolean;
}

/** A merge/pull request's approval summary — who approved and whether the viewer did.
 *  Produced by GitLab and Bitbucket (not GitHub, which approves via its Review menu);
 *  read by the approve/unapprove toggle and Request-changes control
 *  (`implemented.mrApprove` / `implemented.mrRequestChanges`). */
export interface ApprovalState {
  /** Whether the viewer has approved — the toggle's driver (Approve ↔ Revoke). */
  viewerHasApproved: boolean;
  /** Usernames who have approved, for an "Approved by …" summary. */
  approvedBy: string[];
  /** Required approvals — a Premium approval-rules concept; 0 on Free. */
  approvalsRequired: number;
  /** Approvals still needed (0 on Free). */
  approvalsLeft: number;
  /** Whether the viewer holds a "requested changes" reviewer state — the
   *  Request-changes control's pressed state. Cleared by approving (or removing
   *  yourself as a reviewer on GitLab); the direct undo is Premium-only. */
  viewerRequestedChanges: boolean;
}

/** A GitLab issue/MR's time-tracking summary. Seconds are the raw values; the
 *  human strings are GitLab's own formatting ("3h", "1d 2h") and are "" when the
 *  matching value is unset. GitLab-only (`implemented.timeTracking`). */
export interface GitLabTimeStats {
  /** Estimate, in seconds (0 when unset). */
  timeEstimate: number;
  /** Total time spent, in seconds (0 when unset). */
  totalTimeSpent: number;
  /** Human estimate ("3h"); "" when unset. */
  humanTimeEstimate: string;
  /** Human total spent ("1d 2h"); "" when unset. */
  humanTotalTimeSpent: string;
}

/** A related issue linked to another via a `relates_to` link. GitLab-only
 *  (`implemented.issueLinks`); `linkId` addresses the link for removal. */
export interface GitLabLinkedIssue {
  /** The link's own id (used to unlink), as a string (IPC-safe). */
  linkId: string;
  number: number;
  title: string;
  /** "OPEN" or "CLOSED". */
  state: string;
  /** "relates_to" (the only link type the app creates). */
  linkType: string;
  webUrl: string;
}

/** A GitLab MR's merge/auto-merge state — the auto-merge (merge-when-pipeline-
 *  succeeds) control's driver. Only GitLab produces it (`implemented.mrAutoMerge`);
 *  GitHub has no in-app PR auto-merge. */
export interface GitLabMrMergeState {
  /** Whether merge-when-pipeline-succeeds is armed on the MR. */
  autoMergeEnabled: boolean;
  /** GitLab's detailed_merge_status ("mergeable", "ci_still_running", "checking", …). */
  detailedMergeStatus: string;
  /** Head pipeline status ("running", "pending", "success", …); "" when the MR has no pipeline. */
  pipelineStatus: string;
  /** Head pipeline web URL; "" when no pipeline. */
  pipelineUrl: string;
}

// ── Bitbucket settings surface ─────────────────────────────────────────────
//
// Bitbucket's repo-management model is its own shape (like GitLab's), not a mapping
// onto the GitHub types: a `fork_policy` enum, a `mainbranch`, no topics/archiving.
// camelCase mirrors the serde on the Rust side.

/** A Bitbucket workspace the viewer belongs to — the publish target picker. */
export interface BitbucketWorkspace {
  slug: string;
  administrator: boolean;
}

/** Bitbucket repository settings — its own shape (a `fork_policy` enum, a
 *  main branch, no topics). Nullable scalars arrive as "" (empty-string idiom). */
export interface BitbucketRepoSettings {
  name: string;
  slug: string;
  fullName: string;
  description: string;
  website: string;
  language: string;
  isPrivate: boolean;
  /** "allow_forks" | "no_public_forks" | "no_forks". */
  forkPolicy: string;
  mainBranch: string;
  webUrl: string;
  projectKey: string;
  projectName: string;
}

/** The Bitbucket settings the General form sends back (the managed subset).
 *  Name and visibility are NOT here — the Danger zone owns them (rename +
 *  set-visibility). */
export interface BitbucketRepoSettingsInput {
  description: string;
  website: string;
  language: string;
  forkPolicy: string;
  mainBranch: string;
}

/** A Bitbucket branch restriction. `id` is numeric on the wire; it travels as a
 *  string over IPC (u64-precision rule). `value` is the numeric argument some
 *  kinds carry (e.g. `require_approvals_to_merge` → the required count). */
export interface BitbucketBranchRestriction {
  id: string;
  /** "push" | "require_approvals_to_merge" | "force" | "delete" | … */
  kind: string;
  pattern: string;
  /** "glob" (the only kind the app creates). */
  branchMatchKind: string;
  value: number | null;
}

/** Whether Bitbucket Pipelines is enabled for the repo. */
export interface BitbucketPipelinesConfig {
  enabled: boolean;
}

/** A Bitbucket pipeline variable. A secured variable's value is write-only —
 *  reads return `null` for it. */
export interface BitbucketPipelineVariable {
  uuid: string;
  key: string;
  value: string | null;
  secured: boolean;
}

/** A Bitbucket pipeline schedule (a cron-triggered pipeline on a branch).
 *  `cronPattern` is QUARTZ format (e.g. "0 0 12 * * ?"). */
export interface BitbucketPipelineSchedule {
  uuid: string;
  enabled: boolean;
  cronPattern: string;
  refName: string;
}

/** A Bitbucket repository webhook. Bitbucket has no delivery-log API (no
 *  deliveries feature). */
export interface BitbucketHook {
  uuid: string;
  description: string;
  url: string;
  active: boolean;
  events: string[];
  skipCertVerification: boolean;
}

/** What the Bitbucket webhook form sends. A PUT requires the FULL shape (a
 *  partial PUT 400s), so create and update carry the same fields. */
export interface BitbucketHookInput {
  description: string;
  url: string;
  active: boolean;
  events: string[];
  skipCertVerification: boolean;
}

/** Provider-neutral analogue of {@link GhStatus}: whether the hosted integration is
 *  usable for this repo, on which host, as whom, and what it supports. Hosted panels
 *  gate on this (and its `capabilities`) rather than a GitHub-only readiness check. */
export interface ForgeStatus {
  /** The detected provider, or null when the repo has no recognized hosted remote. */
  provider: ForgeProvider | null;
  installed: boolean;
  authenticated: boolean;
  repo: string | null;
  host: string | null;
  login: string | null;
  capabilities: ForgeCapabilities;
  /** Which capabilities are actually built for this provider — drives per-feature
   *  "coming soon" gating distinct from `capabilities`. */
  implemented: ForgeImplemented;
}

export interface WebhookConfig {
  url: string;
  /** "json" or "form". */
  contentType: string;
  /** "0" (verify SSL) or "1" (skip verification). */
  insecureSsl: string;
  /** Masked ("********") when a secret is set; absent otherwise. */
  secret: string | null;
}

export interface WebhookLastResponse {
  code: number | null;
  status: string;
  message: string | null;
}

export interface Webhook {
  id: number;
  active: boolean;
  events: string[];
  config: WebhookConfig;
  updatedAt: string;
  lastResponse: WebhookLastResponse;
}

/** New/edited webhook values sent to the backend (camelCase). */
export interface WebhookInput {
  url: string;
  contentType: "json" | "form";
  /** A new secret; null/empty leaves an existing one unchanged. */
  secret: string | null;
  insecureSsl: boolean;
  events: string[];
  active: boolean;
}

/** A past webhook delivery (summary). */
export interface HookDelivery {
  /** A 19-digit snowflake — string, since it exceeds JS's safe integer range. */
  id: string;
  deliveredAt: string;
  redelivery: boolean;
  duration: number;
  status: string;
  statusCode: number;
  event: string;
  action: string | null;
}

/** One delivery's request payload + response body. */
export interface HookDeliveryDetail {
  requestPayload: string;
  responsePayload: string;
}

/** Curated subset of a repo's GitHub settings (read). */
export interface RepoSettings {
  description: string | null;
  homepage: string | null;
  topics: string[];
  defaultBranch: string;
  hasIssues: boolean;
  hasProjects: boolean;
  hasWiki: boolean;
  hasDiscussions: boolean;
  allowSquashMerge: boolean;
  allowMergeCommit: boolean;
  allowRebaseMerge: boolean;
  allowUpdateBranch: boolean;
  deleteBranchOnMerge: boolean;
  allowAutoMerge: boolean;
  webCommitSignoffRequired: boolean;
  /** Read-only — the repo's GitHub URL, for "manage on GitHub" deep links. */
  htmlUrl: string;
  /** Read-only — "public" | "private" | "internal". */
  visibility: string;
  /** Read-only — "owner/repo". */
  fullName: string;
  /** Read-only — whether the repo is archived. */
  archived: boolean;
  isTemplate: boolean;
  allowForking: boolean;
  /** Forking is only changeable on an org-owned private repo; the toggle hides
   *  otherwise (and `allowForking` is sent as null so the PATCH doesn't 422). */
  canChangeForking: boolean;
  /** Read-only, computed — whether the repo is org-owned. GitHub silently clamps
   *  triage/maintain/admin collaborator roles to write on a user-owned repo, so
   *  the Access UI offers only Read/Write there. */
  isOrg: boolean;
  /** Default squash/merge commit title+message (a constrained enum pair). */
  squashMergeCommitTitle: string;
  squashMergeCommitMessage: string;
  mergeCommitTitle: string;
  mergeCommitMessage: string;
}

/** Edited settings sent to the backend — {@link RepoSettings} minus the
 *  read-only fields, with description/homepage as plain (possibly empty) strings
 *  and `allowForking` nullable (null = leave forking untouched). */
export type RepoSettingsInput = Omit<
  RepoSettings,
  | "description"
  | "homepage"
  | "htmlUrl"
  | "visibility"
  | "fullName"
  | "archived"
  | "canChangeForking"
  | "isOrg"
  | "allowForking"
> & {
  description: string;
  homepage: string;
  allowForking: boolean | null;
};

/** The active gh token's OAuth scopes. `classic: false` = a fine-grained PAT /
 *  App token (no readable scopes — don't treat "missing scope" as a problem). */
export interface GhScopes {
  scopes: string[];
  classic: boolean;
}

/** Which secret store a name lives in. Variables are Actions-only. */
export type SecretApp = "actions" | "dependabot" | "codespaces";

/** A secret's metadata — GitHub never returns the value, only set/delete. */
export interface GhSecret {
  name: string;
  updatedAt: string;
}

/** An Actions variable. Unlike a secret, its value is readable and editable. */
export interface GhVariable {
  name: string;
  value: string;
  updatedAt: string;
}

/** A repo permission level (the invitation/role vocabulary). */
export type RepoRole = "read" | "triage" | "write" | "maintain" | "admin";

/** A repo collaborator. (GitHub can't reliably distinguish a direct grant from
 *  one inherited via a team/org, so we just show the effective role.) */
export interface Collaborator {
  login: string;
  avatarUrl: string;
  /** read | triage | write | maintain | admin */
  roleName: string;
}

/** A pending repo invitation (not yet accepted). */
export interface Invitation {
  id: string;
  login: string;
  avatarUrl: string;
  permission: RepoRole;
  createdAt: string;
}

/** GitHub Pages site config (null when Pages is disabled). */
export interface PagesInfo {
  htmlUrl: string;
  /** "built" | "building" | "errored" | "" */
  status: string;
  /** "legacy" (deploy from a branch) | "workflow" (GitHub Actions) */
  buildType: string;
  sourceBranch: string;
  sourcePath: string;
  cname: string;
  httpsEnforced: boolean;
  /** TLS certificate state for a custom domain — one of "new",
   * "authorization_created", "authorization_pending", "authorized",
   * "uploaded", "approved", "errored", "bad_authz". `null` when the repo has no
   * custom domain (no certificate is provisioned). */
  httpsCertificateState: string | null;
}

export type RulesetEnforcement = "active" | "evaluate" | "disabled";

/** A repo ruleset in the list view. */
export interface RulesetSummary {
  id: number;
  name: string;
  target: string;
  enforcement: string;
  /** "Repository" | "Organization" — org rulesets are read-only from a repo. */
  sourceType: string;
}

/** The full ruleset object (raw GitHub schema, snake_case) for the editor. Only what
 *  the editor reads is modelled; the object carries the rest of GitHub's schema, and
 *  a save spreads those fields back so the full PUT replace doesn't drop them. */
export interface RulesetFull {
  id: number;
  name: string;
  target?: string;
  enforcement: string;
  conditions?: {
    ref_name?: { include?: string[]; exclude?: string[] };
  } & Record<string, unknown>;
  bypass_actors?: unknown[];
  rules?: { type: string; parameters?: Record<string, unknown> }[];
}

/** What a branch's active rules demand of a pull request, aggregated across every
 *  ruleset that applies. GitHub only. */
export interface BranchRequiredRules {
  /** Required status-check contexts, in GitHub's own order and deduplicated. */
  contexts: string[];
  /** Approving reviews the rules require; `null` when no rule names a count. The
   *  PR's check rollup can never carry this — nothing in it names reviews. */
  requiredApprovingReviewCount: number | null;
}

/** A "Code security and analysis" toggle. */
export type SecurityFeature =
  | "advanced_security"
  | "secret_scanning"
  | "secret_scanning_push_protection"
  | "secret_scanning_ai_detection"
  | "secret_scanning_non_provider_patterns"
  | "code_scanning"
  | "dependabot_alerts"
  | "dependabot_security_updates"
  | "private_vulnerability_reporting";

/** State of the repo's security toggles. The three `security_and_analysis`
 *  fields are null when not applicable (e.g. a public repo has no GHAS toggle). */
export interface SecurityStatus {
  isPrivate: boolean;
  advancedSecurity: boolean | null;
  secretScanning: boolean | null;
  secretScanningPushProtection: boolean | null;
  secretScanningAiDetection: boolean | null;
  secretScanningNonProviderPatterns: boolean | null;
  dependabotAlerts: boolean;
  dependabotSecurityUpdates: boolean;
  privateVulnerabilityReporting: boolean;
  codeScanning: boolean;
}

/** A GitHub (classic) branch protection rule, for importing into branch rules. */
export interface GhBranchProtection {
  /** fnmatch-style branch name pattern the rule targets. */
  pattern: string;
  allowsDeletions: boolean;
  allowsForcePushes: boolean;
  requiresLinearHistory: boolean;
  requiresApprovingReviews: boolean;
}

/** State of one git hook in the repo's hooks directory. */
export interface HookEntry {
  name: string;
  description: string;
  /** "active" (installed + runs) | "disabled" (kept, renamed off) | "inactive". */
  state: "active" | "disabled" | "inactive";
  /** Whether git's stock `<name>.sample` is present. */
  hasSample: boolean;
}

export interface HooksInfo {
  /** Absolute path to the effective hooks directory. */
  hooksPath: string;
  /** True when `core.hooksPath` redirects hooks away from `.git/hooks`. */
  customHooksPath: boolean;
  /** A detected hook manager ("husky" | "pre-commit" | "lefthook"). */
  manager: string | null;
  /** Path to the manager's config file/dir, for an "Open config" affordance. */
  managerConfig: string | null;
  entries: HookEntry[];
}

export interface PrRef {
  number: number;
  url: string;
}

/** Which repository a fork's PR/issue surfaces read & write against: the fork
 *  itself ("origin") or its parent ("upstream"). GitHub-only — GitLab/Bitbucket
 *  arms ignore it, so the frontend gates the lens UI to GitHub forks. */
export type RemoteLens = "origin" | "upstream";

/** A PR's membership in a stack — a linear chain where each PR targets the one
 *  below it. Absent/null means unstacked. Provenance differs per forge and `id`
 *  carries it: GitHub's is native (numeric id) and keeps merged members, so
 *  `size` never shrinks; GitLab's is inferred over OPEN MRs ("mr-<iid>" id), so
 *  a merged layer leaves the chain and both `position` and `size` shrink — and a
 *  two-MR chain losing one stops being marked at all. Bitbucket has no stacks. */
export interface PrStackInfo {
  /** Stack identity: GitHub stack number as a string; GitLab "mr-<iid>". */
  id: string;
  /** 1 = bottom of the stack (merges first). */
  position: number;
  size: number;
}

/** One member of a stack, for the detail view's Stack section. On GitHub merging
 *  a member atomically merges every still-open member below it, bottom-up; GitLab
 *  merges that MR alone and retargets the next, so nothing cascades there. */
export interface PrStackMember {
  number: number;
  title: string;
  /** "open" | "merged" | "closed" */
  state: string;
  position: number;
  headRefName: string;
  baseRefName: string;
}

/** What a stack create/add write returns: the stack it landed on and the members
 *  the forge confirmed, so the caller reports the forge's truth rather than the
 *  set it asked for (GitHub can reorder or reject a member). */
export interface StackWriteOutcome {
  stackNumber: number;
  /** Member PR numbers, bottom→top, as the forge confirmed them. */
  members: number[];
}

export interface PrInfo {
  number: number;
  url: string;
  title: string;
  baseRefName: string;
  headRefName: string;
  isDraft: boolean;
  state: string;
  author: { login: string } | null;
  labels: { name: string }[];
  /** ISO-8601 timestamp of when the PR was opened; "" when the source didn't
   *  supply it. Populated by all three providers — drives the list row's age. */
  createdAt: string;
  /** The PR head commit's SHA. Bitbucket-only (its list arm reads
   *  `source.commit.hash`); it feeds the per-commit CI-status probe, since
   *  Bitbucket has no batch pipeline endpoint. "" for GitHub/GitLab (their CI
   *  fetch keys on PR number / MR iid, not the SHA). */
  headSha: string;
  /** Stack membership, driving the row's position badge. Null/absent = unstacked. */
  stack?: PrStackInfo | null;
  /** Whether the list's stack join FAILED, making every row's `stack` unreliable.
   *  Tri-state: absent or false = the join answered (zero stacks is a real answer);
   *  true = it failed, so a row showing no stack may still be stacked. The join is
   *  fail-open per list, so this flag is uniform across the page. */
  stackUnknown?: boolean;
  /** True when the head branch lives in ANOTHER repository — a fork PR, which can
   *  never be a stack member. Absent/false = same-repo. */
  crossRepository?: boolean;
}

/** A PR's rolled-up CI signal for the list-row icon. "none" = no checks. */
export type CiStatus = "passing" | "failing" | "pending" | "none";

/** One PR's CI rollup keyed by number — the PR-list row-icon hydration payload.
 *  Provider-neutral (GitHub statusCheckRollup, GitLab headPipeline, Bitbucket a
 *  per-commit statuses probe); fetched separately from the list (see
 *  `forgePrListCi`). */
export interface PrCiStatus {
  number: number;
  ciStatus: CiStatus;
}

export interface PrCommitOut {
  oid: string;
  headline: string;
  date: string;
  author: string;
  /** The commit message body (below the headline); "" when the commit has none. */
  messageBody: string;
}

/** One comment on a commit (GitHub commit comment / GitLab commit note). A plain
 *  commit comment carries no `path`/`line`/`position`; a diff-anchored one does. */
export interface CommitCommentOut {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  /** Whether the signed-in user wrote it (only their own comments are editable). */
  viewerDidAuthor: boolean;
  /** File path an inline comment anchors to; null for a plain commit comment. */
  path: string | null;
  /** 1-based line an inline comment anchors to; null when not anchored. */
  line: number | null;
  /** First line of a multi-line range (1-based); null for a single-line comment
   *  (GitLab only — GitHub/Bitbucket are always null). */
  startLine: number | null;
  /** Diff position an inline comment anchors to; null when not anchored. */
  position: number | null;
}

/** One pending draft comment in a batch review submission — a file:line-anchored
 *  note the reviewer stages before submitting the whole review at once. */
export interface DraftCommentIn {
  path: string;
  line: number;
  /** "new" (right side) or "old" (left side). */
  side: "new" | "old";
  /** First line of a multi-line range (1-based); omitted for a single line. */
  startLine?: number;
  body: string;
}

/** The outcome of submitting a batch review: how many draft comments posted out
 *  of the total, and whether the verdict (approve / request changes) applied. */
export interface ReviewSubmitOut {
  posted: number;
  total: number;
  verdictApplied: boolean;
}

export interface PrFileOut {
  path: string;
  additions: number;
  deletions: number;
}

export interface PrThreadOut {
  author: string;
  /** The comment author's avatar URL when the provider supplies one
   *  (GitLab/Bitbucket). Empty for GitHub, where it's login-derived. */
  authorAvatarUrl: string;
  /** Review state (APPROVED/COMMENTED/CHANGES_REQUESTED); "" for comments. */
  state: string;
  body: string;
  date: string;
  /** GraphQL node id — a review's `PRR_…` id or a conversation comment's node id;
   *  `""` only when the source supplies none. A review's `id` is matched against a
   *  thread's `reviewId` to attach that review's line comments inline. */
  id: string;
  /** Permalink on GitHub ("" for reviews/local) — for "Copy link". */
  url: string;
  /** Whether the signed-in user wrote it (only their own comments are editable). */
  viewerDidAuthor: boolean;
  /** Whether the comment is hidden (minimized), and GitHub's recorded reason. */
  isMinimized: boolean;
  minimizedReason: string;
  /** The owning review's id when this row is a review-thread comment (GitHub
   *  populates it today, from the comment's own `pullRequestReview`); empty for
   *  review/conversation rows and on GitLab/Bitbucket. Lets the timeline tie
   *  GitHub's empty reply-wrapper reviews back to the thread they wrap. */
  reviewId: string;
}

/** One file:line-anchored review thread, provider-neutral (GitHub reviewThread /
 *  GitLab diff-note discussion / Bitbucket inline-comment chain). */
export interface ReviewThreadOut {
  /** Provider thread id (GitHub node id / GitLab discussion id / Bitbucket root comment id). */
  id: string;
  /** GraphQL id of the review that owns this thread (GitHub `PRR_…`); "" =
   *  unknown / the provider doesn't model reviews (always "" on GitLab/Bitbucket). */
  reviewId: string;
  path: string;
  /** 1-based anchored line; 0 = unknown (e.g. outdated threads). */
  line: number;
  /** First line of a multi-line range (1-based); 0 = single-line. */
  startLine: number;
  /** "new" (right side) or "old" (left side). */
  side: string;
  isResolved: boolean;
  isOutdated: boolean;
  /** Unified-diff hunk excerpt the thread anchors to (GitHub diffHunk); "" when
   *  the provider has none (GitLab/Bitbucket). */
  diffHunk: string;
  /** Full reply chain, oldest first. */
  comments: PrThreadOut[];
}

export interface PrCheckOut {
  name: string;
  status: string;
  /** The check's link: a CheckRun `detailsUrl` or a StatusContext `targetUrl`,
   *  whichever GitHub supplied. Absent when neither did. */
  detailsUrl?: string;
  /** GitHub Actions run id, parsed from a `.../actions/runs/<runId>/…` details
   *  URL. Kept as a string — run/job ids exceed JS's safe-integer range. Absent
   *  for non-Actions checks (external CI, or a StatusContext). */
  runId?: string;
  /** GitHub Actions job id, parsed from `.../actions/runs/<runId>/job/<jobId>`.
   *  Absent when the URL has no job segment (or isn't an Actions URL). */
  jobId?: string;
  /** When the check began — a CheckRun `startedAt`, or a StatusContext's creation
   *  time, which gh reports under this same key. Absent only when the rollup
   *  carried no real time. */
  startedAt?: string;
  /** CheckRun `completedAt`. A StatusContext reports no completion at all, so start
   *  time is the only key both rollup arms can be ordered by. */
  completedAt?: string;
}

/**
 * One activity-timeline event on a PR/MR or an issue, mirroring the Rust
 * `ForgeTimelineEventOut` tagged enum. Provider-neutral: GitHub renders reviews as
 * cards so it emits no approved/changesRequested, while GitLab/Bitbucket emit approval
 * events here. Events arrive oldest→newest; every string field is `""` (and every
 * number `0`) when the provider returned null, so absence reads as empty rather than
 * missing.
 */
export type ForgeTimelineEvent =
  | {
      kind: "forcePushed";
      before: string;
      after: string;
      actor: ForgeUserRef;
      date: string;
    }
  | {
      kind: "labeled";
      label: string;
      color: string;
      /** true for a LABELED_EVENT, false for an UNLABELED_EVENT. */
      added: boolean;
      actor: ForgeUserRef;
      date: string;
    }
  | {
      kind: "reviewRequested";
      reviewer: string;
      actor: ForgeUserRef;
      date: string;
    }
  | { kind: "readyForReview"; actor: ForgeUserRef; date: string }
  | { kind: "convertToDraft"; actor: ForgeUserRef; date: string }
  | { kind: "approved"; actor: ForgeUserRef; date: string }
  | { kind: "changesRequested"; actor: ForgeUserRef; date: string }
  | { kind: "unapproved"; actor: ForgeUserRef; date: string }
  | {
      kind: "closed";
      actor: ForgeUserRef;
      /** `"completed" | "not_planned" | "duplicate"` on a GitHub issue close; `""`
       *  for PRs and for GitLab/Bitbucket, which report no reason. */
      stateReason: string;
      date: string;
    }
  | { kind: "reopened"; actor: ForgeUserRef; date: string }
  | { kind: "merged"; actor: ForgeUserRef; commitOid?: string; date: string }
  | {
      kind: "renamed";
      previous: string;
      current: string;
      actor: ForgeUserRef;
      date: string;
    }
  | {
      kind: "assigned";
      assignee: string;
      /** true for an assignment, false for an unassignment. */
      added: boolean;
      actor: ForgeUserRef;
      date: string;
    }
  | {
      kind: "milestoned";
      milestone: string;
      /** true when added to the milestone, false when removed. */
      added: boolean;
      actor: ForgeUserRef;
      date: string;
    }
  | {
      kind: "crossReferenced";
      /** `"pr" | "issue"`, or `""` when the referring entity's type is unknown. */
      sourceKind: string;
      sourceNumber: number;
      sourceTitle: string;
      /** The referring entity's `owner/name` — a cross-reference can live in another
       *  repository, so the number alone can't address it. `""` when unknown. */
      sourceRepo: string;
      willClose: boolean;
      actor: ForgeUserRef;
      date: string;
    }
  | {
      kind: "connected";
      sourceKind: string;
      sourceNumber: number;
      sourceTitle: string;
      sourceRepo: string;
      /** true when the link was made, false when it was broken. */
      added: boolean;
      actor: ForgeUserRef;
      date: string;
    }
  | {
      kind: "pinned";
      /** true for a pin, false for an unpin. */
      added: boolean;
      actor: ForgeUserRef;
      date: string;
    }
  | {
      kind: "locked";
      locked: boolean;
      /** The lock reason lowercased (`"off_topic"`, `"too_heated"`, `"resolved"`,
       *  `"spam"`); `""` when none was given, and on unlock. */
      reason: string;
      actor: ForgeUserRef;
      date: string;
    }
  | {
      kind: "transferred";
      /** The `owner/name` the issue moved here from; `""` when unknown. */
      fromRepo: string;
      actor: ForgeUserRef;
      date: string;
    }
  | {
      kind: "markedAsDuplicate";
      canonicalKind: string;
      canonicalNumber: number;
      /** The canonical entity's `owner/name` (same cross-repo reason as
       *  `sourceRepo`); `""` when unknown. */
      canonicalRepo: string;
      actor: ForgeUserRef;
      date: string;
    };

export interface RepoLabel {
  /** GraphQL node id; empty on labels embedded in PR details. */
  id: string;
  name: string;
  /** Hex without the leading '#', as GitHub returns it. */
  color: string;
  /** The label's stated purpose, when the source carries one. Optional so
   *  existing cached/serialized shapes without it stay valid. */
  description?: string | null;
}

/** How a pull request merges into its base, as the FORGE reports it. "checking" =
 *  the forge hasn't finished computing (GitHub computes asynchronously and the read
 *  itself primes it, so the caller re-polls); "unavailable" = no server truth to be
 *  had (a non-open PR, or Bitbucket). */
export type PrMergeabilityState =
  | "conflicting"
  | "mergeable"
  | "checking"
  | "unavailable";

export interface PrMergeability {
  state: PrMergeabilityState;
  /** The provider's own wording behind the state, when it supplies one. */
  detail: string | null;
}

export interface PrDetails {
  /** GraphQL node id, used by the label mutations. */
  id: string;
  number: number;
  title: string;
  body: string;
  author: string;
  /** The author's avatar URL when the provider supplies one (GitLab/Bitbucket).
   *  Empty for GitHub, where it's login-derived on the frontend. */
  authorAvatarUrl: string;
  state: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  additions: number;
  deletions: number;
  url: string;
  commits: PrCommitOut[];
  files: PrFileOut[];
  reviews: PrThreadOut[];
  comments: PrThreadOut[];
  checks: PrCheckOut[];
  labels: RepoLabel[];
  /** Assignees. GitHub and GitLab both fill this (the MR/PR-assignees picker is
   *  wired for both, `implemented.mrAssignees`); Bitbucket leaves it empty. Each
   *  carries an avatar (GitLab supplies it; GitHub is login-derived). */
  assignees: ForgeUserRef[];
  /** The reviewer list. All three providers fill this when `implemented.mrReviewers`
   *  is true; the id is the provider's stable handle (GitHub login, GitLab username,
   *  Bitbucket the braced account uuid), the label the display name, never the id. */
  reviewers: ForgeUserRef[];
  /** Reviewers who have submitted a verdict, supplied by the backend for providers
   *  that don't populate `reviews` (GitLab approvals, Bitbucket participant states).
   *  GitHub derives its completed reviewers on the frontend from `reviews`, so it
   *  leaves this empty. */
  completedReviewers: CompletedReviewerWithState[];
  /** Whether the repository allows the merge-commit method (server-side setting of
   *  the repo the PR lives in — its base/parent repo on a fork). GitHub only; `null`
   *  = unknown — do not gate on `null`. The merge-method picker pre-disables an
   *  option only when its flag is explicitly `false`. */
  mergeCommitAllowed: boolean | null;
  /** Whether the repository allows the squash-merge method. GitHub only; `null` =
   *  unknown — do not gate on `null`. */
  squashMergeAllowed: boolean | null;
  /** Whether the repository allows the rebase-merge method. GitHub only; `null` =
   *  unknown — do not gate on `null`. */
  rebaseMergeAllowed: boolean | null;
  /** Stack membership. Null/absent = unstacked (the Stack section renders nothing). */
  stack?: PrStackInfo | null;
  /** Every member of `stack`, bottom-first; empty when the PR is unstacked. */
  stackMembers: PrStackMember[];
  /** True when the stack probe itself FAILED, so a null `stack` above means
   *  "unknown", not "known unstacked" — the two are not interchangeable on a
   *  merge path that can cascade. GitHub-only this wave (only GitHub cascades);
   *  the GitLab and Bitbucket arms always report false. */
  stackUnknown: boolean;
  /** How this PR merges into its base. Optional: rows cached by a session that
   *  predates the field deserialize without it — treat absent as unknown. */
  mergeability?: PrMergeability;
  /** The head branch lives in ANOTHER repository (a fork PR), so the local
   *  resolve flow has nowhere it may push. Optional for the same cache reason;
   *  absent is treated as not-a-fork (the push itself refuses non-fast-forward). */
  crossRepository?: boolean;
  /** The base repo's maintainers may push to the fork's head branch ("allow edits
   *  by maintainers"). GitHub only; absent/null = unknown, which must not be read
   *  as a denial. */
  maintainerCanModify?: boolean | null;
}

/** How far a pull request's head has drifted from its base — the update-branch
 *  affordance's driver (`behindBy > 0` means the base has moved on). */
export interface PrBaseDivergence {
  aheadBy: number;
  behindBy: number;
}

/** An open fork PR whose head commit a local branch already contains — the
 *  maintainer is holding that contributor's work locally. */
export interface ForkPrMatch {
  number: number;
  title: string;
  url: string;
  /** The branch name ON THE FORK — the push destination, which may differ from
   *  the local branch's name. */
  headRefName: string;
  headRepoOwner: string;
  headRepoName: string;
  /** "Allow edits by maintainers"; unknown degrades to false, so the caller
   *  disables the push-to-fork route rather than promising a push that would 403. */
  maintainerCanModify: boolean;
  /** Local commits on top of the PR head (0 = nothing new to push). */
  aheadCount: number;
}

/** A reviewer who has submitted a verdict, as supplied by the backend (GitLab
 *  approvals, Bitbucket participant states). The `state` is uppercased —
 *  APPROVED / CHANGES_REQUESTED / COMMENTED. */
export interface CompletedReviewerWithState {
  user: ForgeUserRef;
  state: string;
}

/** A provider user reference — a stable id + a human label — for pickers,
 *  read-only chips, and timeline actors. Bitbucket carries the account uuid as
 *  the id with the display name / nickname as the label: its nicknames aren't
 *  unique, so the label alone can't round-trip a mutation. GitHub and GitLab put
 *  the login/username in both fields. */
export interface ForgeUserRef {
  id: string;
  label: string;
  /** The user's avatar URL whenever the source supplies one — GitLab/Bitbucket
   *  return it on every user, and the GitHub timeline reads `actor.avatarUrl`.
   *  Empty means derive it from the login on GitHub, initials elsewhere
   *  (`ForgeUserAvatar` owns both fallbacks). */
  avatarUrl: string;
  /** True for a bot account — a bot requested reviewer (e.g. GitHub Copilot), or a
   *  timeline actor GitHub typed as a `Bot`. Bot reviewers are display-only:
   *  they're rendered as read-only chips, never enter the editable picker's
   *  managed set, and the reviewer setters never add or remove them. */
  isBot: boolean;
}

/** One review item on a PR/MR with its author's bot flag — the raw material a re-review
 *  folds in from third-party AI reviewers. From `forge_pr_external_reviews` (GitHub
 *  reviews / GitLab MR discussions; Bitbucket returns none). */
export interface ExternalReviewItem {
  /** `review` = a submitted review body, `inline` = a file:line review comment,
   *  `comment` = a conversation comment, `reply` = a follow-up comment inside a
   *  review thread (emitted by the GitHub harvest for thread replies; GitLab
   *  continues to emit replies as `inline`/`comment`). */
  kind: "review" | "inline" | "comment" | "reply";
  author: string;
  isBot: boolean;
  body: string;
  /** File path for `inline` items ("" otherwise). */
  path: string;
  /** 1-based line for `inline` items (0 when unknown / outdated). */
  line: number;
  /** Commit OID the item was made against ("" when unknown) — for staleness. */
  commitSha: string;
  /** Submitted-review state (APPROVED/CHANGES_REQUESTED/COMMENTED); "" otherwise. */
  state: string;
  /** Inline only: GitHub's thread flags (`isOutdated` = the anchored line moved). */
  isResolved: boolean;
  isOutdated: boolean;
  createdAt: string;
}

export interface IssueInfo {
  number: number;
  url: string;
  title: string;
  /** "OPEN" or "CLOSED". */
  state: string;
  createdAt: string;
  updatedAt: string;
  author: { login: string } | null;
  labels: { name: string }[];
}

export interface Milestone {
  number: number;
  title: string;
}

/** An org-defined issue type (Bug/Feature/Task/…). */
export interface IssueType {
  id: string;
  name: string;
  /** GitHub color NAME (GRAY/BLUE/GREEN/YELLOW/ORANGE/RED/PINK/PURPLE). */
  color: string;
}

export interface Reaction {
  /** GitHub ReactionContent enum value (THUMBS_UP, HEART, ROCKET, …). */
  content: string;
  count: number;
  /** Whether the signed-in user has this reaction (drives the toggle). */
  viewerReacted: boolean;
}

export interface IssueReactions {
  body: Reaction[];
  /** Reactions per comment, keyed by the comment's id as the thread carries it
   *  (a GraphQL node id on GitHub, a numeric note id on GitLab). */
  comments: Record<string, Reaction[]>;
}

export interface DiscussionCategory {
  id: string;
  name: string;
  /** The category glyph (e.g. "🏎️"); may be empty. */
  emoji: string;
  isAnswerable: boolean;
}

export interface DiscussionMeta {
  /** GraphQL node id of the repository — needed to create a discussion. */
  repoId: string;
  hasDiscussionsEnabled: boolean;
  categories: DiscussionCategory[];
}

export interface DiscussionInfo {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  isAnswered: boolean;
  closed: boolean;
  stateReason: string | null;
  categoryName: string;
  categoryEmoji: string;
  author: string;
  commentCount: number;
  upvoteCount: number;
  labels: RepoLabel[];
}

export interface DiscussionReply {
  id: string;
  author: string;
  body: string;
  date: string;
  url: string;
  viewerDidAuthor: boolean;
  isMinimized: boolean;
  minimizedReason: string;
}

export interface DiscussionComment {
  id: string;
  author: string;
  body: string;
  date: string;
  url: string;
  viewerDidAuthor: boolean;
  isMinimized: boolean;
  minimizedReason: string;
  upvoteCount: number;
  viewerHasUpvoted: boolean;
  /** Whether this comment is the discussion's accepted answer. */
  isAnswer: boolean;
  replies: DiscussionReply[];
}

export interface DiscussionDetails {
  id: string;
  number: number;
  title: string;
  body: string;
  url: string;
  author: string;
  createdAt: string;
  categoryName: string;
  categoryEmoji: string;
  /** Whether the category accepts answers (Q&A) — gates "Mark as answer". */
  isAnswerable: boolean;
  isAnswered: boolean;
  upvoteCount: number;
  viewerHasUpvoted: boolean;
  locked: boolean;
  /** GitHub's lock reason (OFF_TOPIC/TOO_HEATED/RESOLVED/SPAM) or null. */
  activeLockReason: string | null;
  closed: boolean;
  /** Close reason (RESOLVED/OUTDATED/DUPLICATE) or null. */
  stateReason: string | null;
  labels: RepoLabel[];
  comments: DiscussionComment[];
}

/** One issue in a parent/sub-issue relationship. */
export interface RelatedIssue {
  /** GraphQL node id (used to remove the relationship). */
  id: string;
  number: number;
  title: string;
  /** "OPEN" or "CLOSED". */
  state: string;
  url: string;
}

/** An issue's parent and sub-issues, with the completion summary. */
export interface IssueRelations {
  parent: RelatedIssue | null;
  subIssues: RelatedIssue[];
  completed: number;
  total: number;
}

/** An issue's dependencies: issues blocking it, and issues it blocks. */
export interface IssueDependencies {
  blockedBy: RelatedIssue[];
  blocking: RelatedIssue[];
}

/** Which dependency direction to edit. */
export type IssueRelation = "blocked_by" | "blocking";

/** A pull request linked to an issue (it closes / references it). */
export interface LinkedPr {
  number: number;
  title: string;
  /** "OPEN", "CLOSED", or "MERGED". */
  state: string;
  url: string;
}

/** An issue's "Development" links: closing PRs + linked branches. */
export interface IssueDevelopment {
  prs: LinkedPr[];
  branches: string[];
}

export interface IssueDetails {
  /** GraphQL node id, used by the label mutations. */
  id: string;
  number: number;
  title: string;
  body: string;
  author: string;
  /** The author's avatar URL when the provider supplies one (GitLab). Empty for
   *  GitHub, where it's login-derived on the frontend. */
  authorAvatarUrl: string;
  state: string;
  createdAt: string;
  url: string;
  /** Assignees (GitHub + GitLab). Each carries an avatar (GitLab supplies it;
   *  GitHub is login-derived). */
  assignees: ForgeUserRef[];
  milestone: Milestone | null;
  issueType: IssueType | null;
  isPinned: boolean;
  locked: boolean;
  /** GitHub's lock reason (off_topic/resolved/spam/too_heated) or null. */
  activeLockReason: string | null;
  /** GitLab-only: the issue is hidden from non-members. Always false on GitHub. */
  confidential: boolean;
  /** GitLab-only: "YYYY-MM-DD" or null. GitHub issues have no due dates. */
  dueDate: string | null;
  /** Conversation comments (shared shape with PRs). */
  comments: PrThreadOut[];
  labels: RepoLabel[];
}

/** One git tag, for the Tags list. */
export interface TagInfo {
  name: string;
  /** The commit the tag points to (dereferenced for annotated tags). */
  target: string;
  date: string;
  annotated: boolean;
  /** Tag annotation subject (annotated) or the commit subject (lightweight). */
  subject: string;
}

/** A GitHub release in the list view (merged with tags by tagName). */
export interface ReleaseInfo {
  tagName: string;
  name: string;
  isDraft: boolean;
  isPrerelease: boolean;
  isLatest: boolean;
  publishedAt: string;
}

export interface ReleaseAsset {
  name: string;
  size: number;
  downloadCount: number;
  url: string;
}

export interface ReleaseDetails {
  tagName: string;
  name: string;
  body: string;
  author: string;
  publishedAt: string;
  isDraft: boolean;
  isPrerelease: boolean;
  targetCommitish: string;
  url: string;
  assets: ReleaseAsset[];
}

/** GitHub's auto-generated release notes (suggested title + body). */
export interface GeneratedNotes {
  name: string;
  body: string;
}

/** An ignored file and the .gitignore rule responsible for ignoring it. A
 *  trailing "/" on `path` marks a collapsed fully-ignored directory. */
export interface IgnoredFile {
  path: string;
  source: string;
  line: number;
  pattern: string;
}

/** A gitignore rule to delete: the file it lives in + its exact pattern line. */
export interface UnignoreRule {
  source: string;
  pattern: string;
}
