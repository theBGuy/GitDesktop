import type { ForgeUserRef, RepoLabel } from "./forge";
import type { CompletedReviewerWithState, PrThreadOut } from "./pr-reviews";

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

/** Where one PR's head branch lives — the targeted read behind opening a PR in
 *  the worktree that has it checked out. Both fields are "" when unknown (a
 *  deleted fork answers "" rather than failing), and a resolver must require
 *  `headRepoFullName` to match the PR's own repo before trusting `headRefName`:
 *  branch names collide freely across forks. */
export interface PrHeadRef {
  headRefName: string;
  headRepoFullName: string;
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

export interface PrRef {
  number: number;
  url: string;
}

/** One team the viewer belongs to. `slug` is org-qualified ("org/slug") — the form
 *  `RemoteListFilter.teams` (remote-lens.ts) carries; `name` is the display label. */
export interface TeamRef {
  slug: string;
  name: string;
}

/** The viewer's teams for the team-review filter. `missingScope` true means the
 *  token can't read team membership, so `teams` is empty for want of permission
 *  rather than membership — the UI says so instead of showing an empty picker. */
export interface MyTeams {
  teams: TeamRef[];
  missingScope: boolean;
}

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

/** A PR's rolled-up CI signal for the list-row icon. "none" = no checks; "neutral" =
 *  finished without a verdict (a cancelled pipeline). GitHub never sends "neutral":
 *  its rollup enum has no cancelled value (see `rollup_state_to_ci`). */
export type CiStatus = "passing" | "failing" | "pending" | "none" | "neutral";

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

export interface PrFileOut {
  path: string;
  additions: number;
  deletions: number;
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
   *  Absent when the URL has no job segment (or isn't an Actions URL). GitLab
   *  doesn't parse at all — its jobs API reports the job's own id directly. */
  jobId?: string;
  /** When the check began — a CheckRun `startedAt`, or a StatusContext's creation
   *  time, which gh reports under this same key. Absent only when the rollup
   *  carried no real time. */
  startedAt?: string;
  /** CheckRun `completedAt`. A StatusContext reports no completion at all, so start
   *  time is the only key both rollup arms can be ordered by. */
  completedAt?: string;
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
