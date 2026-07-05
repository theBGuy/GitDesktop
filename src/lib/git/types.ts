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

/** Result of applying a review suggestion to the working tree
 *  ({@link ReviewThreadOut} → {@link ApplyLinesResult}). The backend verifies the
 *  expected lines still match before editing, preserves EOL/BOM/trailing newline,
 *  and only stages when the file had no other local changes. */
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
  /** An interactive rebase is paused at an `edit` (vs a conflict). */
  editPaused: boolean;
}

export type RepoOp = "merge" | "rebase" | "cherry-pick";

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
  /** The signed-in user's login, so the UI lists their own repos first. */
  viewer: string;
  repos: ForgeRepo[];
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

/** What a provider (and this repo on it) supports, so panels show only the
 *  controls that work instead of erroring. GitHub is all-true; GitLab/Bitbucket
 *  follow the parity matrix. Grows as more panels move behind capability gates. */
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
}

/** Which hosted features GitDesktop has actually *built* for a provider — a
 *  different axis from {@link ForgeCapabilities}. Capabilities = what the platform
 *  can do; this = what we've wired up. GitHub is all-true; GitLab/Bitbucket flip
 *  these on per phase, so a *ready* repo whose feature isn't built yet degrades to
 *  "coming soon" rather than firing GitHub calls. Gated via `forgeFeatureReady`. */
export interface ForgeImplemented {
  pullRequests: boolean;
  issues: boolean;
  ci: boolean;
  releases: boolean;
  insights: boolean;
  /** Repo-management surface: View/Fork/Star/admin settings, branch-rule import. */
  repoActions: boolean;
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
  /** Approving / unapproving a merge request via the bodyless toggle — GitLab-only
   *  (GitHub approves through the review flow), so it's false for GitHub. */
  mrApprove: boolean;
  /** Merging a merge/pull request (strategy + delete-source-branch) — a shared
   *  control, so true for both GitHub and GitLab. */
  mrMerge: boolean;
  /** Arming merge-when-pipeline-succeeds (auto-merge) on an MR while its head
   *  pipeline is in flight — GitLab-only like `mrApprove` (GitHub has no in-app
   *  PR auto-merge), so it's false for GitHub. */
  mrAutoMerge: boolean;
  /** Editing labels on an issue — a shared control (GitHub by node id, GitLab by
   *  name), so true for both. */
  issueLabels: boolean;
  /** Editing labels on a merge/pull request — the same shared label control. */
  mrLabels: boolean;
  /** Setting an issue's assignees — a shared issue control. (MR assignees are the
   *  separate GitLab-only `mrAssignees` below.) */
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
  /** Setting a merge request's assignees — GitLab-only like `mrApprove` (GitHub
   *  PRs expose no assignee picker here), so it's false for GitHub. */
  mrAssignees: boolean;
  /** Requesting changes on an MR (the blocking reviewer state) — GitLab and
   *  Bitbucket (GitHub requests changes via its Review menu). Bitbucket's revoke
   *  works on every plan, so the control toggles there; GitLab is one-shot. */
  mrRequestChanges: boolean;
  /** Editing a merge/pull request's reviewer list — Bitbucket-only (reviewers
   *  picked from workspace members; GitHub keeps its own review-request flow and
   *  the GitLab reviewer list isn't wired). */
  mrReviewers: boolean;
  /** Editing an existing issue's title/body — the shared edit dialog. */
  issueEdit: boolean;
  /** Editing an existing merge/pull request's title/body — the same shared
   *  edit control. */
  mrEdit: boolean;
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
  /** Marking an issue confidential (members-only). GitLab-unique — false for
   *  GitHub, which has no confidential-issue concept. */
  issueConfidential: boolean;
  /** Setting/clearing an issue's due date. GitLab-unique — false for GitHub. */
  issueDueDate: boolean;
  /** The repository-settings dialog (admin probe + General / Danger zone and
   *  the provider's extra sections). */
  repoSettings: boolean;
  /** Playing a manual CI job (a job awaiting a manual "play"). GitLab-unique —
   *  false for GitHub, whose manual approvals work differently. */
  ciJobPlay: boolean;
  /** Time tracking (estimate + spent) on issues and MRs. GitLab-unique — false
   *  for GitHub, which has no built-in time tracking. */
  timeTracking: boolean;
  /** Related-issue links (relates_to) on issues. GitLab-unique — false for
   *  GitHub (its issue relationships are sub-issues/dependencies instead). */
  issueLinks: boolean;
  /** The pull-request tasks checklist (create/edit/resolve/delete). Bitbucket-only
   *  — a native Bitbucket concept with no GitHub/GitLab analogue wired here, so
   *  false for both. */
  prTasks: boolean;
  /** Reading file:line-anchored review threads on a merge/pull request (GitHub
   *  reviewThreads / GitLab diff-note discussions / Bitbucket inline comments). */
  mrReviewThreads: boolean;
  /** Replying into an existing review thread. */
  mrThreadReply: boolean;
  /** Resolving / unresolving a review thread. */
  mrThreadResolve: boolean;
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

/** A merge/pull request's approval summary — who has approved and whether the
 *  signed-in viewer has. Only GitLab produces it today; the GitLab-only
 *  approve/unapprove toggle and Request-changes control read it (gated on
 *  `implemented.mrApprove` / `implemented.mrRequestChanges`). */
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

// ── Bitbucket settings surface (wave 2/3) ──────────────────────────────────
//
// Bitbucket's repo-management model is its own shape (like GitLab's), not a
// mapping onto the GitHub types: a `fork_policy` enum, a `mainbranch`, and no
// topics/archiving. camelCase mirrors the serde on the Rust side.

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

/** Provider-neutral analogue of {@link GhStatus}: is the hosted integration usable
 *  for this repo, on which host, as whom, and what does it support. Hosted panels
 *  gate on this (and its `capabilities`) instead of a GitHub-only readiness check,
 *  so the same surfaces light up for GitLab and Bitbucket too. */
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

/** The full ruleset object (raw GitHub schema, snake_case) for the editor. */
export interface RulesetFull {
  id: number;
  name: string;
  target?: string;
  enforcement: string;
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } };
  bypass_actors?: unknown[];
  rules?: { type: string; parameters?: Record<string, unknown> }[];
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
}

export interface PrCommitOut {
  oid: string;
  headline: string;
  date: string;
  author: string;
}

export interface PrFileOut {
  path: string;
  additions: number;
  deletions: number;
}

export interface PrThreadOut {
  author: string;
  /** Review state (APPROVED/COMMENTED/CHANGES_REQUESTED); "" for comments. */
  state: string;
  body: string;
  date: string;
  /** GraphQL node id — set for conversation comments, "" for reviews. */
  id: string;
  /** Permalink on GitHub ("" for reviews/local) — for "Copy link". */
  url: string;
  /** Whether the signed-in user wrote it (only their own comments are editable). */
  viewerDidAuthor: boolean;
  /** Whether the comment is hidden (minimized), and GitHub's recorded reason. */
  isMinimized: boolean;
  minimizedReason: string;
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
}

export interface RepoLabel {
  /** GraphQL node id; empty on labels embedded in PR details. */
  id: string;
  name: string;
  /** Hex without the leading '#', as GitHub returns it. */
  color: string;
}

export interface PrDetails {
  /** GraphQL node id, used by the label mutations. */
  id: string;
  number: number;
  title: string;
  body: string;
  author: string;
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
  /** Assignee usernames. Only GitLab fills this — the MR-assignees picker is
   *  GitLab-only (`implemented.mrAssignees`); GitHub leaves it empty. */
  assignees: string[];
  /** The reviewer list. Only Bitbucket fills this — the reviewers picker is
   *  Bitbucket-only (`implemented.mrReviewers`). Identity is the provider's
   *  stable id (Bitbucket: the braced account uuid), never the display label. */
  reviewers: ForgeUserRef[];
}

/** A provider user reference for pickers — a stable id + a human label.
 *  Bitbucket's reviewer picker emits it today (id = account uuid, label =
 *  display name / nickname): Bitbucket nicknames aren't unique, so the label
 *  alone can't round-trip a mutation. */
export interface ForgeUserRef {
  id: string;
  label: string;
}

/** One review item on a PR/MR (a submitted review, an inline review comment, or a
 *  conversation comment) with its author's bot flag — the raw material a re-review
 *  folds in from third-party AI reviewers. From `forge_pr_external_reviews`
 *  (GitHub reviews / GitLab MR discussions; Bitbucket returns none). */
export interface ExternalReviewItem {
  kind: "review" | "inline" | "comment";
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
  state: string;
  createdAt: string;
  url: string;
  assignees: string[];
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
