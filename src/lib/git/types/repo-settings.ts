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
