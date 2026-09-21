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
  /** Re-running ONE finished CI job — GitHub restarts the job plus every job that
   *  depends on it; GitLab retries that job alone. Bitbucket steps have no retry
   *  endpoint, so false there. */
  ciJobRerun: boolean;
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
  /** Listing the repo's direct forks with their activity signals (the Insights
   *  "Fork activity" card) — built for all three providers. */
  forkActivity: boolean;
  /** On-demand ahead/behind between one fork's branch and this repo's base
   *  branch. GitHub's compare API only, so false elsewhere. */
  forkCompare: boolean;
  /** The whole-repo "mine" list filters (assigned to me, review requested from me)
   *  on the PR/issue panels — a shared control for GitHub and GitLab, both of which
   *  express the axis server-side; false for Bitbucket, which isn't wired. */
  listFilterMine: boolean;
  /** Filtering the PR list by a team whose review was requested — GitHub-only
   *  (teams are a GitHub concept), so false elsewhere. */
  listFilterTeam: boolean;
  /** Server-side author filtering on the PR/issue panels. False for Bitbucket,
   *  whose API filters on account ids rather than the display names the app
   *  shows, so no author the user can pick is a term it would accept. */
  listFilterAuthor: boolean;
  /** Grouping the PR list by the viewer's review state (reviewed / needs another
   *  look / not reviewed), which needs the per-PR review timestamps
   *  `forge_pr_review_state` returns — GitHub-only, so false elsewhere. */
  reviewGrouping: boolean;
}

/** Provider-neutral analogue of `GhStatus` (accounts.ts): whether the hosted
 *  integration is usable for this repo, on which host, as whom, and what it
 *  supports. Hosted panels gate on this (and its `capabilities`) rather than a
 *  GitHub-only readiness check. */
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
