import { Channel } from "@tauri-apps/api/core";
import { invoke } from "@/lib/tauri/invoke";
import {
  COLD_START,
  coldStartDeleteSecret,
  coldStartGetSecret,
  coldStartSetSecret,
} from "@/lib/test-mode";
import type {
  AiIgnoreVerdict,
  ApplyLinesResult,
  ApprovalState,
  AvailableProjects,
  BbAccountInfo,
  BbEnvironment,
  BitbucketBranchRestriction,
  BitbucketHook,
  BitbucketHookInput,
  BitbucketPipelineSchedule,
  BitbucketPipelinesConfig,
  BitbucketPipelineVariable,
  BitbucketRepoSettings,
  BitbucketRepoSettingsInput,
  BitbucketWorkspace,
  BlameLine,
  Branch,
  BranchComparison,
  BranchDivergence,
  BranchRequiredRules,
  BranchRewriteStatus,
  BranchStats,
  CheckApp,
  CodeFreqPoint,
  Collaborator,
  CommitAuthor,
  CommitCommentOut,
  CommitDetails,
  CommitResult,
  CommitSummary,
  CommunityInsights,
  ContributorChurn,
  DeltaDiff,
  DiffStatEntry,
  DiscussionDetails,
  DiscussionInfo,
  DiscussionMeta,
  DraftCommentIn,
  ExternalReviewItem,
  FileDiff,
  ForgeForkActivity,
  ForgeForkDivergence,
  ForgeForkResult,
  ForgeProvider,
  ForgeProviderFeatures,
  ForgeRepoAdmin,
  ForgeRepoList,
  ForgeRepoWriteAccess,
  ForgeSearchList,
  ForgeStatus,
  ForgeTimelineEvent,
  ForgeUserRef,
  ForkPrMatch,
  GeneratedNotes,
  GhAccounts,
  GhBranchProtection,
  GhPublishOwners,
  GhRepoList,
  GhScopes,
  GhSecret,
  GhVariable,
  GitInfo,
  GitLabHook,
  GitLabHookDelivery,
  GitLabHookInput,
  GitLabLinkedIssue,
  GitLabMember,
  GitLabMrMergeState,
  GitLabProtectedBranch,
  GitLabRepoSettings,
  GitLabRepoSettingsInput,
  GitLabTimeStats,
  GitLabVariable,
  HookDelivery,
  HookDeliveryDetail,
  HooksInfo,
  IgnoredFile,
  Invitation,
  IssueDependencies,
  IssueDetails,
  IssueDevelopment,
  IssueInfo,
  IssueReactions,
  IssueRelation,
  IssueRelations,
  IssueType,
  MergePreview,
  Milestone,
  OpLogEntry,
  OrphanedStash,
  PagesInfo,
  PrBaseDivergence,
  PrCiStatus,
  PrDetails,
  PrInfo,
  PrMergeability,
  PrMergeabilityState,
  ProjectItemRef,
  ProjectItemRemove,
  PrPollInfo,
  PrRef,
  PrTask,
  PunchCard,
  ReconnectEvent,
  ReleaseDetails,
  ReleaseInfo,
  RemoteBranch,
  RemoteLens,
  RepoDependencies,
  RepoInfo,
  RepoLabel,
  RepoOp,
  RepoOpState,
  RepoOwner,
  RepoRole,
  RepoSettings,
  RepoSettingsInput,
  RepoStats,
  RepoStatus,
  RepoTraffic,
  ReviewSubmitOut,
  ReviewThreadOut,
  RewriteStep,
  RulesetEnforcement,
  RulesetFull,
  RulesetSummary,
  SecretApp,
  SecurityFeature,
  SecurityStatus,
  SessionHealth,
  StackWriteOutcome,
  StagedDiff,
  StashEntry,
  StashFile,
  Submodule,
  SubmoduleRemoveOutcome,
  TagInfo,
  TodoScan,
  UnignoreRule,
  Webhook,
  WebhookInput,
  WeekCount,
  WorkingLineStats,
} from "./types";

export const checkGitInstalled = () => invoke<GitInfo>("check_git_installed");

export const validateRepo = (path: string) =>
  invoke<RepoInfo>("validate_repo", { path });

export const cloneRepo = (
  url: string,
  parentDir: string,
  dirName?: string,
  recurseSubmodules = false,
) =>
  invoke<string>("clone_repo", {
    url,
    parentDir,
    dirName: dirName ?? null,
    recurseSubmodules,
  });

export interface CreateRepoOptions {
  name: string;
  description: string;
  parentDir: string;
  initReadme: boolean;
  gitignore: string | null;
  license: string | null;
  defaultBranch: string;
}

export const createRepo = (options: CreateRepoOptions) =>
  invoke<string>("create_repo", { options });

export const gitStatus = (repoPath: string) =>
  invoke<RepoStatus>("git_status", { repoPath });

/** Per-file `+added -deleted` counts for the Changes panel's rows, split by
 *  diff side (`git_status` runs porcelain v2, which carries no line data). */
export const gitWorkingLineStats = (repoPath: string) =>
  invoke<WorkingLineStats>("git_working_line_stats", { repoPath });

/** Count of commits on HEAD not on any remote-tracking ref — the "unpublished"
 *  count for a branch with no upstream (where `branch.ahead` is undefined). */
export const gitUnpushedCount = (repoPath: string) =>
  invoke<number>("git_unpushed_count", { repoPath });

export const gitBranches = (repoPath: string) =>
  invoke<Branch[]>("git_branches", { repoPath });

export const gitRemoteBranches = (repoPath: string) =>
  invoke<RemoteBranch[]>("git_remote_branches", { repoPath });

export const gitRepoOwners = (repoPaths: string[]) =>
  invoke<RepoOwner[]>("git_repo_owners", { repoPaths });

export const gitCheckoutBranch = (repoPath: string, name: string) =>
  invoke<void>("git_checkout_branch", { repoPath, name });

export const gitCheckoutRemoteBranch = (
  repoPath: string,
  remote: string,
  name: string,
) => invoke<void>("git_checkout_remote_branch", { repoPath, remote, name });

export const gitCreateBranch = (
  repoPath: string,
  name: string,
  checkout: boolean,
  startPoint?: string,
  noTrack?: boolean,
) =>
  invoke<void>("git_create_branch", {
    repoPath,
    name,
    checkout,
    startPoint: startPoint ?? null,
    noTrack: noTrack ?? false,
  });

export const gitDiffFile = (
  repoPath: string,
  filePath: string,
  staged: boolean,
  untracked: boolean,
) =>
  invoke<FileDiff>("git_diff_file", { repoPath, filePath, staged, untracked });

/** A single file's cumulative diff in an agent session worktree, against the
 *  session's base commit (committed turns + uncommitted edits; new untracked
 *  files show as a full add). Powers the inline edit-step diff in the transcript. */
export const gitSessionFileDiff = (
  repoPath: string,
  filePath: string,
  base: string,
) => invoke<FileDiff>("git_session_file_diff", { repoPath, filePath, base });

/** Staged diff vs HEAD. With `worktree: true` it instead returns ALL in-progress
 *  tracked changes (staged + unstaged) vs HEAD — for naming a branch off work
 *  that may not be staged yet. Untracked files are never included (callers pass
 *  their paths from the status entries separately). */
export const gitStagedDiff = (
  repoPath: string,
  opts: { maxBytes?: number; exclude?: string[]; worktree?: boolean } = {},
) =>
  invoke<StagedDiff>("git_staged_diff", {
    repoPath,
    maxBytes: opts.maxBytes ?? null,
    exclude: opts.exclude ?? null,
    ...(opts.worktree ? { worktree: true } : {}),
  });

export const gitStage = (repoPath: string, paths: string[]) =>
  invoke<void>("git_stage", { repoPath, paths });

export const gitUnstage = (repoPath: string, paths: string[]) =>
  invoke<void>("git_unstage", { repoPath, paths });

export const gitCommit = (
  repoPath: string,
  title: string,
  body?: string,
  amend = false,
) =>
  invoke<CommitResult>("git_commit", {
    repoPath,
    title,
    body: body ?? null,
    amend,
  });

export const gitStashList = (repoPath: string) =>
  invoke<StashEntry[]>("git_stash_list", { repoPath });

export const gitStashFiles = (repoPath: string, index: number) =>
  invoke<StashFile[]>("git_stash_files", { repoPath, index });

export const gitStashFileDiff = (
  repoPath: string,
  index: number,
  filePath: string,
) => invoke<FileDiff>("git_stash_file_diff", { repoPath, index, filePath });

export const gitStashApply = (repoPath: string, index: number, pop: boolean) =>
  invoke<void>("git_stash_apply", { repoPath, index, pop });

export const gitStashDrop = (repoPath: string, index: number) =>
  invoke<void>("git_stash_drop", { repoPath, index });

export const gitOrphanedStashes = (repoPath: string) =>
  invoke<OrphanedStash[]>("git_orphaned_stashes", { repoPath });

export const gitOrphanedStashFiles = (repoPath: string, sha: string) =>
  invoke<StashFile[]>("git_orphaned_stash_files", { repoPath, sha });

export const gitOrphanedStashFileDiff = (
  repoPath: string,
  sha: string,
  filePath: string,
) =>
  invoke<FileDiff>("git_orphaned_stash_file_diff", { repoPath, sha, filePath });

export const gitRestoreOrphaned = (repoPath: string, sha: string) =>
  invoke<void>("git_restore_orphaned", { repoPath, sha });

/** Full operation journal, newest-first (pure read). */
export const gitOplogList = (repoPath: string) =>
  invoke<OpLogEntry[]>("git_oplog_list", { repoPath });

/** Reconciles the journal against the repo and returns the genuinely
 *  interrupted op (0 or 1). Writes the store as an idempotent side effect. */
export const gitOplogCheck = (repoPath: string) =>
  invoke<OpLogEntry[]>("git_oplog_check", { repoPath });

/** Marks a journal entry "dismissed" so it stops surfacing as interrupted. */
export const gitOplogDismiss = (repoPath: string, id: string) =>
  invoke<void>("git_oplog_dismiss", { repoPath, id });

export const gitOpState = (repoPath: string) =>
  invoke<RepoOpState>("git_op_state", { repoPath });

export const gitOpAbort = (repoPath: string, op: RepoOp) =>
  invoke<void>("git_op_abort", { repoPath, op });

/** Resolves true when the operation completed normally, false when the pending
 *  cherry-pick was skipped because the resolution left nothing to commit. The
 *  flag speaks for that pick alone: it fully describes a single-commit
 *  cherry-pick, while a longer sequence may still have applied its remaining
 *  picks. */
export const gitOpContinue = (repoPath: string, op: RepoOp) =>
  invoke<boolean>("git_op_continue", { repoPath, op });

/** One file's bytes for the webview, or the reason they're withheld. */
export interface FileBytes {
  /** Base64 of the file bytes; null when the preview is refused. */
  base64: string | null;
  /** Media type sniffed from the bytes, not the extension — one of PNG, GIF,
   *  JPEG, WebP. null for anything else (SVG, BMP, ICO, text, …). */
  mime: string | null;
  /** Past the byte cap, or a raster whose header declares more than the
   *  webview's decoder should be handed. */
  tooLarge: boolean;
}

/** File content at a rev (null rev = working tree; null result = absent). */
export const gitFileBase64 = (
  repoPath: string,
  rev: string | null,
  filePath: string,
) => invoke<FileBytes | null>("git_file_base64", { repoPath, rev, filePath });

/** Decode base64 file bytes (from git_file_base64) to a UTF-8 string. */
export function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export const gitApplyPatch = (
  repoPath: string,
  patch: string,
  cached: boolean,
  reverse: boolean,
) => invoke<void>("git_apply_patch", { repoPath, patch, cached, reverse });

/** One selected changed line for partial staging. */
export interface SelectedLine {
  side: "old" | "new";
  line: number;
}

/** Stage/unstage/discard a selected subset of lines from a file's diff. */
export const gitApplyPartial = (
  repoPath: string,
  diffText: string,
  selected: SelectedLine[],
  cached: boolean,
  reverse: boolean,
) =>
  invoke<void>("git_apply_partial", {
    repoPath,
    diffText,
    selected,
    cached,
    reverse,
  });

/** Replace lines `[startLine, startLine + expectedLines.length)` (1-based) of a
 *  file with `replacementLines` — GitHub's "Commit suggestion", applied locally.
 *  The backend verifies `expectedLines` still match before editing (a mismatch is
 *  a specific error), preserves EOL/BOM/trailing newline, and stages the file only
 *  when `stageWhenClean` and it had no other local changes. */
export const gitReplaceFileLines = (
  repoPath: string,
  filePath: string,
  startLine: number,
  expectedLines: string[],
  replacementLines: string[],
  stageWhenClean: boolean,
) =>
  invoke<ApplyLinesResult>("git_replace_file_lines", {
    repoPath,
    filePath,
    startLine,
    expectedLines,
    replacementLines,
    stageWhenClean,
  });

export const gitCommitAuthors = (repoPath: string) =>
  invoke<CommitAuthor[]>("git_commit_authors", { repoPath });

export const gitUserIdentity = (repoPath: string) =>
  invoke<CommitAuthor>("git_user_identity", { repoPath });

export const gitLocalIdentity = (repoPath: string) =>
  invoke<CommitAuthor>("git_local_identity", { repoPath });

export const gitSetLocalIdentity = (
  repoPath: string,
  name: string,
  email: string,
) => invoke<void>("git_set_local_identity", { repoPath, name, email });

export const gitGlobalIdentity = () =>
  invoke<CommitAuthor>("git_global_identity");

export const gitSetGlobalIdentity = (name: string, email: string) =>
  invoke<void>("git_set_global_identity", { name, email });

export const gitGlobalDefaultBranch = () =>
  invoke<string>("git_global_default_branch");

export const gitSetGlobalDefaultBranch = (branch: string) =>
  invoke<void>("git_set_global_default_branch", { branch });

export const gitGlobalAutocrlf = () => invoke<string>("git_global_autocrlf");

export const gitSetGlobalAutocrlf = (value: string) =>
  invoke<void>("git_set_global_autocrlf", { value });

export const gitCommitDiff = (
  repoPath: string,
  hash: string,
  maxBytes?: number,
) =>
  invoke<StagedDiff>("git_commit_diff", {
    repoPath,
    hash,
    maxBytes: maxBytes ?? null,
  });

/** Discards selected lines from an untracked (new) file — removes just those
 *  1-based line numbers and rewrites it in place (the file stays untracked).
 *  Used for line/hunk discard of a new file, where reverse-applying a patch
 *  would delete the whole file instead. */
export const gitDiscardUntrackedLines = (
  repoPath: string,
  path: string,
  lines: number[],
) => invoke<void>("git_discard_untracked_lines", { repoPath, path, lines });

/** Moves the branch pointer to `hash`. `"mixed"` (the default) keeps every
 *  working-tree change; `"hard"` rewrites the working tree too and is refused
 *  outright while tracked changes are outstanding. */
export const gitReset = (
  repoPath: string,
  hash: string,
  mode?: "mixed" | "hard",
) => invoke<void>("git_reset", { repoPath, hash, mode: mode ?? null });

export const gitCheckoutCommit = (repoPath: string, hash: string) =>
  invoke<void>("git_checkout_commit", { repoPath, hash });

export const gitRevert = (repoPath: string, hash: string) =>
  invoke<void>("git_revert", { repoPath, hash });

/** Resolves true when a commit was created, false when there was nothing
 *  to apply (the changes already exist on this branch). */
export const gitCherryPick = (repoPath: string, hash: string) =>
  invoke<boolean>("git_cherry_pick", { repoPath, hash });

export interface CherryPickRangeResult {
  applied: number;
  skipped: number;
}

/** Copies `hashes` (oldest-first) onto `targetBranch` and leaves you there.
 *  A single commit that conflicts stops on `targetBranch` with the pick in
 *  progress, for the conflict banner to continue or abort. Every other failure
 *  (and any failure in a multi-commit batch) rolls `targetBranch` back to its
 *  prior tip and returns you to your starting branch; the error says when
 *  either rollback step failed and how to recover. */
export const gitCherryPickOnto = (
  repoPath: string,
  hashes: string[],
  targetBranch: string,
) =>
  invoke<CherryPickRangeResult>("git_cherry_pick_onto", {
    repoPath,
    hashes,
    targetBranch,
  });

export const gitTag = (repoPath: string, name: string, hash: string) =>
  invoke<void>("git_tag", { repoPath, name, hash });

export const gitRewriteCommits = (
  repoPath: string,
  base: string,
  steps: RewriteStep[],
) => invoke<void>("git_rewrite_commits", { repoPath, base, steps });

/** Like gitRewriteCommits but via a real, resumable `git rebase -i` — used when
 *  a step is marked `edit` (pause to amend its contents). Leaves the rebase in
 *  progress for the banner to continue/abort. */
export const gitRebaseEdit = (
  repoPath: string,
  base: string,
  steps: RewriteStep[],
) => invoke<void>("git_rebase_edit", { repoPath, base, steps });

/** Full messages (subject + body) for the unpushed commits `base..HEAD`, to
 *  pre-fill the Edit-history editor without truncating multi-line bodies. */
export const gitUnpushedMessages = (repoPath: string, base: string) =>
  invoke<{ hash: string; message: string }[]>("git_unpushed_messages", {
    repoPath,
    base,
  });

export const gitPushTag = (repoPath: string, name: string) =>
  invoke<void>("git_push_tag", { repoPath, name });

export const gitDeleteTag = (
  repoPath: string,
  name: string,
  onRemote: boolean,
) => invoke<void>("git_delete_tag", { repoPath, name, onRemote });

/** Every tag in the repo, newest first (for the Tags list). */
export const gitListTags = (repoPath: string) =>
  invoke<TagInfo[]>("git_list_tags", { repoPath });

// ── Releases ────────────────────────────────────────────────────────────────
//
// Reads and writes go through the provider-neutral `forge_release_*`. Two pieces stay
// `gh_*`: notes generation (GitHub's changelog API) and asset download (GitLab assets
// are links the browser opens).

export const forgeReleaseList = (repoPath: string) =>
  invoke<ReleaseInfo[]>("forge_release_list", { repoPath });

export const forgeReleaseView = (repoPath: string, tag: string) =>
  invoke<ReleaseDetails>("forge_release_view", { repoPath, tag });

export const forgeReleaseCreate = (
  repoPath: string,
  tag: string,
  title: string,
  notes: string,
  target: string,
  prerelease: boolean,
  draft: boolean,
  latest: boolean,
) =>
  invoke<string>("forge_release_create", {
    repoPath,
    tag,
    title,
    notes,
    target,
    prerelease,
    draft,
    latest,
  });

export const forgeReleaseEdit = (
  repoPath: string,
  tag: string,
  title: string,
  notes: string,
  prerelease: boolean,
  draft: boolean,
  // Tri-state: `undefined` omits `--latest` so GitHub keeps/decides Latest natively
  // (a draft's Latest is structurally false — sending it strips Latest on publish).
  latest: boolean | undefined,
) =>
  invoke<void>("forge_release_edit", {
    repoPath,
    tag,
    title,
    notes,
    prerelease,
    draft,
    latest,
  });

/** The release asset Tauri's updater polls. KEEP IN SYNC with `UPDATER_MANIFEST`
 *  in src-tauri/src/github/release.rs — the sync command matches on this name. */
export const UPDATER_MANIFEST_NAME = "latest.json";

/** Re-points the release's `latest.json` updater manifest at `notes`, leaving its
 *  version, dates and platform signatures untouched. GitHub-only. */
export const forgeReleaseSyncUpdaterNotes = (
  repoPath: string,
  tag: string,
  notes: string,
) => invoke<void>("forge_release_sync_updater_notes", { repoPath, tag, notes });

/** GitHub's auto-generated release notes (suggested title + body), for preview. */
export const ghReleaseGenerateNotes = (
  repoPath: string,
  tag: string,
  target: string,
  previousTag: string,
) =>
  invoke<GeneratedNotes>("gh_release_generate_notes", {
    repoPath,
    tag,
    target,
    previousTag,
  });

export const forgeReleaseDelete = (
  repoPath: string,
  tag: string,
  cleanupTag: boolean,
) => invoke<void>("forge_release_delete", { repoPath, tag, cleanupTag });

export const forgeReleaseUploadAsset = (
  repoPath: string,
  tag: string,
  filePath: string,
) => invoke<void>("forge_release_upload_asset", { repoPath, tag, filePath });

export const forgeReleaseDeleteAsset = (
  repoPath: string,
  tag: string,
  assetName: string,
) => invoke<void>("forge_release_delete_asset", { repoPath, tag, assetName });

export const ghReleaseDownloadAsset = (
  repoPath: string,
  tag: string,
  assetName: string,
  dir: string,
) =>
  invoke<void>("gh_release_download_asset", { repoPath, tag, assetName, dir });

/** Appends ignore patterns to the repo root `.gitignore` (created if absent),
 *  returning the number of patterns actually appended (already-present ones are
 *  skipped). */
export const appendToGitignore = (repoPath: string, patterns: string[]) =>
  invoke<number>("append_to_gitignore", { repoPath, patterns });

export const gitUntrack = (
  repoPath: string,
  pathspecs: string[],
  ignorePatterns: string[],
) => invoke<void>("git_untrack", { repoPath, pathspecs, ignorePatterns });

export const gitListTracked = (repoPath: string) =>
  invoke<string[]>("git_list_tracked", { repoPath });

/** Every file in the working tree git doesn't track and doesn't ignore. */
export const gitListUntracked = (repoPath: string) =>
  invoke<string[]>("git_list_untracked", { repoPath });

export const gitIgnoredFiles = (repoPath: string) =>
  invoke<IgnoredFile[]>("git_ignored_files", { repoPath });

export const gitForceAdd = (repoPath: string, pathspecs: string[]) =>
  invoke<void>("git_force_add", { repoPath, pathspecs });

export const gitUnignoreRules = (repoPath: string, rules: UnignoreRule[]) =>
  invoke<void>("git_unignore_rules", { repoPath, rules });

export const revealInExplorer = (path: string) =>
  invoke<void>("reveal_in_explorer", { path });

/** Moves a repository folder to the OS recycle bin. */
export const deleteRepoFolder = (path: string) =>
  invoke<void>("delete_repo_folder", { path });

export const openWithDefault = (path: string) =>
  invoke<void>("open_with_default", { path });

export const openInTerminal = (
  path: string,
  terminal?: string,
  program?: string,
  command?: string,
) =>
  invoke<void>("open_in_terminal", {
    path,
    terminal: terminal || null,
    program: program || null,
    command: command || null,
  });

/** The repo's web URL on its provider (GitHub or GitLab). */
export const forgeRepoUrl = (repoPath: string) =>
  invoke<string>("forge_repo_url", { repoPath });

/** A repo's visibility probe: visibility (lowercase "public" | "private" | "internal")
 *  plus fork provenance, in one round-trip. `isFork` is set only on positive API
 *  evidence; `parent` is the upstream slug when supplied. Rejects when visibility is
 *  undeterminable (no remote / no auth / API failure) — callers treat a rejection as
 *  "leave the persisted values alone". */
export interface RepoVisibility {
  visibility: string;
  isFork: boolean;
  parent: string | null;
}

export const forgeRepoVisibility = (repoPath: string) =>
  invoke<RepoVisibility>("forge_repo_visibility", { repoPath });

export const gitRecentCommits = (repoPath: string, limit: number) =>
  invoke<CommitSummary[]>("git_recent_commits", { repoPath, limit });

export const gitLog = (
  repoPath: string,
  limit: number,
  skip: number,
  /** When set, search the whole history by commit message instead of paging. */
  search?: string,
) =>
  invoke<CommitSummary[]>("git_log", {
    repoPath,
    limit,
    skip,
    search: search ?? null,
  });

export const gitCommitDetails = (repoPath: string, hash: string) =>
  invoke<CommitDetails>("git_commit_details", { repoPath, hash });

export const gitFileLog = (
  repoPath: string,
  path: string,
  limit: number,
  skip: number,
) => invoke<CommitSummary[]>("git_file_log", { repoPath, path, limit, skip });

export const gitBlame = (repoPath: string, path: string, rev?: string | null) =>
  invoke<BlameLine[]>("git_blame", { repoPath, path, rev: rev ?? null });

export const gitCommitFiles = (repoPath: string, hash: string) =>
  invoke<DiffStatEntry[]>("git_commit_files", { repoPath, hash });

export const gitCommitFileDiff = (
  repoPath: string,
  hash: string,
  filePath: string,
) => invoke<FileDiff>("git_commit_file_diff", { repoPath, hash, filePath });

export const gitFetch = (repoPath: string) =>
  invoke<void>("git_fetch", { repoPath });

/** Fetch a single named remote (`git fetch --prune --no-prune-tags <remote>`),
 *  unlike {@link gitFetch}, which only touches the default remote. Used to
 *  sync a fork's `upstream`, which a bare fetch never reaches. */
export const gitFetchRemote = (repoPath: string, remote: string) =>
  invoke<void>("git_fetch_remote", { repoPath, remote });

/** The default branch name (e.g. `"main"`) of a named remote — the branch a
 *  fork's upstream sync targets. Resolves the local remote HEAD, doing one
 *  network call to set it if unknown. */
export const gitRemoteDefaultBranch = (repoPath: string, remote: string) =>
  invoke<string>("git_remote_default_branch", { repoPath, remote });

/** Pull mode: fast-forward only (default), or reconcile a diverged branch. */
export type PullMode = "ffOnly" | "rebase" | "merge";

export const gitPull = (repoPath: string, mode: PullMode = "ffOnly") =>
  invoke<void>("git_pull", { repoPath, mode });

/**
 * What a stash → run → reapply compound did. Each command below stashes
 * (including untracked files), runs its operation, then pops — reporting which
 * of those steps landed rather than collapsing to a bare success/failure, so
 * the UI can say where the user's changes ended up.
 *
 * `stderr` on the failure variants is the underlying git output; the stash is
 * retained in every variant that names it, and is the user's safety net.
 */
export type AutostashOutcome =
  /** Tree was clean at stash time; the operation ran plainly. */
  | { kind: "nothingStashed" }
  /** Switch with `reapply: false` — stash kept deliberately, no pop attempted. */
  | { kind: "stashedOnly" }
  /** stash → run → pop, all clean. */
  | { kind: "reapplied" }
  /** The operation succeeded but the pop failed; the stash is kept.
   *  `conflicted` = the pop left unmerged paths to resolve, rather than
   *  refusing outright. */
  | { kind: "reapplyConflicted"; stderr: string; conflicted: boolean }
  /** The operation failed cleanly and the changes were restored. */
  | { kind: "opFailedRestored"; stderr: string }
  /** The operation failed and the stash is kept. `inProgress` = it left
   *  in-progress state, so ConflictBanner offers Continue/Abort; false = the
   *  restore-pop failed instead, and there is no banner. */
  | { kind: "opFailedStashKept"; stderr: string; inProgress: boolean };

export const gitPullAutostash = (repoPath: string, mode: PullMode = "ffOnly") =>
  invoke<AutostashOutcome>("git_pull_autostash", { repoPath, mode });

export const gitMergeAutostash = (repoPath: string, branch: string) =>
  invoke<AutostashOutcome>("git_merge_autostash", { repoPath, branch });

export const gitRebaseAutostash = (repoPath: string, branch: string) =>
  invoke<AutostashOutcome>("git_rebase_autostash", { repoPath, branch });

export const gitRebaseOntoAutostash = (
  repoPath: string,
  newBase: string,
  oldBase: string,
) =>
  invoke<AutostashOutcome>("git_rebase_onto_autostash", {
    repoPath,
    newBase,
    oldBase,
  });

export const gitSwitchAutostash = (
  repoPath: string,
  name: string,
  remote: string | null,
  reapply: boolean,
) =>
  invoke<AutostashOutcome>("git_switch_autostash", {
    repoPath,
    name,
    remote,
    reapply,
  });

/** One commit a rebase pull would rewrite away (mirrors the Rust
 *  `DroppedCommit` in git/pull_guard.rs). */
export interface DroppedCommit {
  sha: string;
  subject: string;
  author: string;
  authorDate: string;
}

/** The structured refusal a rebase pull throws when the upstream was rewritten
 *  and replaying would rewrite local commits away. Wire shape pinned by the Rust
 *  test `pull_rebase_would_drop_serializes_to_the_pinned_wire_shape` (error.rs);
 *  narrow a thrown value to it with `isPullWouldDrop` (lib/error-summary.ts).
 *
 *  Deliberately outside the `AppError` union: its `kind` carries a payload no
 *  generic error presenter reads, and every consumer reaches it through the
 *  classifier instead. */
export interface PullWouldDrop {
  kind: "pullRebaseWouldDrop";
  message: string;
  /** Short local branch name (`main`). */
  branch: string;
  /** Short upstream name (`origin/main`). */
  upstream: string;
  /** The local branch's tip when the guard ran — the decision's `expectedTip`. */
  branchTip: string;
  /** The upstream tip a rebase would land on. */
  newTip: string;
  /** Base BELOW the doomed commits, so a rebase from it replays them — `keep`. */
  mergeBase: string;
  /** Base ABOVE them, so a rebase from it leaves them behind — `drop`. */
  forkPoint: string;
  commits: DroppedCommit[];
}

/** The user's answer to the pull guard. Mirrors the two words Rust's
 *  `decided_base` accepts; anything else is refused there. */
export type PullDecision = "keep" | "drop";

/** What a decided pull rebases against. Every SHA is copied verbatim off the
 *  `PullWouldDrop` that raised the question — the app auto-fetches in the
 *  background, so re-deriving any of them would answer about a different state
 *  than the user was shown. */
export interface PullDecisionShas {
  /** The branch the guard asked about, so the answer can only ever land on it. */
  branch: string;
  decision: PullDecision;
  newTip: string;
  keepBase: string;
  dropBase: string;
  expectedTip: string;
}

/** Phase B of a guarded rebase pull. Rejects with a `PULL_DECISION_STALE`
 *  message when the branch moved since the guard ran. */
export const gitPullRebaseDecided = (
  repoPath: string,
  decided: PullDecisionShas,
) =>
  invoke<void>("git_pull_rebase_decided", {
    repoPath,
    branch: decided.branch,
    decision: decided.decision,
    newTip: decided.newTip,
    keepBase: decided.keepBase,
    dropBase: decided.dropBase,
    expectedTip: decided.expectedTip,
  });

export const gitPullRebaseDecidedAutostash = (
  repoPath: string,
  decided: PullDecisionShas,
) =>
  invoke<AutostashOutcome>("git_pull_rebase_decided_autostash", {
    repoPath,
    branch: decided.branch,
    decision: decided.decision,
    newTip: decided.newTip,
    keepBase: decided.keepBase,
    dropBase: decided.dropBase,
    expectedTip: decided.expectedTip,
  });

/** Which guarantee a completed push actually ran under (mirrors the Rust
 *  `PushGuard` in git/remote.rs). Only meaningful when `force` is set: a
 *  non-force push has no lease to degrade and reports the neutral
 *  `"leaseAndIncludes"`. The two `leaseOnly*` values mean the push landed with
 *  `--force-with-lease` alone, so a caller announcing it must not claim the
 *  stronger `--force-if-includes` protection. */
export type PushGuard =
  | "leaseAndIncludes"
  | "leaseOnlyOldGit"
  | "leaseOnlyNoReflog";

/** `remoteBranch` names the DESTINATION branch when it differs from the local
 *  one (pushing back to a fork PR's head); it requires both `branch` and
 *  `remote`, and never sets upstream. */
export const gitPush = (
  repoPath: string,
  setUpstream: boolean,
  force = false,
  branch?: string,
  remote?: string,
  remoteBranch?: string,
) =>
  invoke<PushGuard>("git_push", {
    repoPath,
    setUpstream,
    force,
    branch: branch ?? null,
    remote: remote ?? null,
    remoteBranch: remoteBranch ?? null,
  });

export const gitRemotes = (repoPath: string) =>
  invoke<string[]>("git_remotes", { repoPath });

export const gitRemoteUrl = (repoPath: string, name: string) =>
  invoke<string>("git_remote_url", { repoPath, name });

export const gitRemoteSetUrl = (repoPath: string, name: string, url: string) =>
  invoke<void>("git_remote_set_url", { repoPath, name, url });

export const gitRemoteAdd = (repoPath: string, name: string, url: string) =>
  invoke<void>("git_remote_add", { repoPath, name, url });

export const gitRemoteRemove = (repoPath: string, name: string) =>
  invoke<void>("git_remote_remove", { repoPath, name });

export const gitSubmodules = (repoPath: string) =>
  invoke<Submodule[]>("git_submodules", { repoPath });

/** Init + update submodules to the recorded commit; `path` for one, else all.
 *  `remote` instead moves them to the tip of the branch they track (the remote's
 *  default branch when none is configured), leaving a bump staged in the parent. */
export const gitSubmoduleUpdate = (
  repoPath: string,
  path?: string,
  remote = false,
) =>
  invoke<void>("git_submodule_update", {
    repoPath,
    path: path ?? null,
    remote,
  });

/** Adds a submodule; `path` null derives it from the URL. Leaves `.gitmodules`
 *  and the new gitlink staged. */
export const gitSubmoduleAdd = (
  repoPath: string,
  url: string,
  path: string | null,
  branch: string | null,
) => invoke<void>("git_submodule_add", { repoPath, url, path, branch });

/** Removes a submodule, staging the deletion. Refuses a dirty one unless `force`;
 *  keeps its cached `.git/modules` data unless `deleteModuleData`. */
export const gitSubmoduleRemove = (
  repoPath: string,
  path: string,
  force: boolean,
  deleteModuleData: boolean,
) =>
  invoke<SubmoduleRemoveOutcome>("git_submodule_remove", {
    repoPath,
    path,
    force,
    deleteModuleData,
  });

export const gitSubmoduleSetUrl = (
  repoPath: string,
  path: string,
  url: string,
) => invoke<void>("git_submodule_set_url", { repoPath, path, url });

/** Sets the branch a submodule tracks; null tracks the remote's default. */
export const gitSubmoduleSetBranch = (
  repoPath: string,
  path: string,
  branch: string | null,
) => invoke<void>("git_submodule_set_branch", { repoPath, path, branch });

export const gitUndoCommit = (repoPath: string) =>
  invoke<void>("git_undo_commit", { repoPath });

export const gitSetBranchArchived = (
  repoPath: string,
  name: string,
  archived: boolean,
) => invoke<void>("git_set_branch_archived", { repoPath, name, archived });

export const gitRenameBranch = (
  repoPath: string,
  oldName: string,
  newName: string,
) => invoke<void>("git_rename_branch", { repoPath, oldName, newName });

export const gitDeleteBranch = (repoPath: string, name: string) =>
  invoke<void>("git_delete_branch", { repoPath, name });

/** Deletes `name` on `remote` (`git push <remote> --delete`). Idempotent when
 *  the remote ref is already gone. */
export const gitDeleteRemoteBranch = (
  repoPath: string,
  remote: string,
  name: string,
) => invoke<void>("git_delete_remote_branch", { repoPath, remote, name });

export const gitDefaultBranch = (repoPath: string) =>
  invoke<string | null>("git_default_branch", { repoPath });

export const gitDiscardAll = (repoPath: string) =>
  invoke<void>("git_discard_all", { repoPath });

export const gitDiscardPaths = (
  repoPath: string,
  paths: { path: string; untracked: boolean }[],
) => invoke<void>("git_discard_paths", { repoPath, paths });

export const gitStashAll = (repoPath: string) =>
  invoke<void>("git_stash_all", { repoPath });

// True when a stash entry was actually created (a pathspec matching nothing
// no-ops at exit 0).
export const gitStashPaths = (repoPath: string, paths: string[]) =>
  invoke<boolean>("git_stash_paths", { repoPath, paths });

export const gitStashPop = (repoPath: string) =>
  invoke<void>("git_stash_pop", { repoPath });

export const gitStashCount = (repoPath: string) =>
  invoke<number>("git_stash_count", { repoPath });

/** Conflict-auto-resolve strategy for a merge: "none" stops on conflicts,
 *  "ours"/"theirs" auto-resolve conflicting hunks via `-X`. */
export type MergeConflictStrategy = "none" | "ours" | "theirs";

export const gitMerge = (
  repoPath: string,
  branch: string,
  squash: boolean,
  noFf: boolean,
  strategy: MergeConflictStrategy,
) => invoke<void>("git_merge", { repoPath, branch, squash, noFf, strategy });

export const gitMergePreview = (
  repoPath: string,
  branch: string,
  strategy: MergeConflictStrategy,
) => invoke<MergePreview>("git_merge_preview", { repoPath, branch, strategy });

export const gitRebase = (repoPath: string, branch: string) =>
  invoke<void>("git_rebase", { repoPath, branch });

/** Rebases the current branch onto `newBase`, replaying only the commits after
 *  `oldBase` (`oldBase..HEAD`) — the "branched off the wrong branch" fix. */
export const gitRebaseOnto = (
  repoPath: string,
  newBase: string,
  oldBase: string,
) => invoke<void>("git_rebase_onto", { repoPath, newBase, oldBase });

export const gitBranchDivergence = (repoPath: string, base: string) =>
  invoke<BranchDivergence[]>("git_branch_divergence", { repoPath, base });

/** Whether `branch`'s upstream was rewritten under it, and what a reset to that
 *  upstream would cost. Read-only (rev-parse / rev-list only). */
export const gitBranchRewriteStatus = (repoPath: string, branch: string) =>
  invoke<BranchRewriteStatus>("git_branch_rewrite_status", {
    repoPath,
    branch,
  });

/** Points `branch` at its upstream's tip without checking it out. Refuses when
 *  the branch is checked out anywhere (naming the worktree, or pointing at the
 *  sync controls for the current branch — that arm takes {@link gitReset} in
 *  `"hard"` mode, which moves the working tree too).
 *
 *  `expectedTip` is the sha the caller measured and showed the user: the backend
 *  re-resolves the upstream and refuses if it has moved since, so a background
 *  fetch during the confirmation can't redirect the reset. */
export const gitBranchResetToUpstream = (
  repoPath: string,
  branch: string,
  expectedTip: string,
) =>
  invoke<void>("git_branch_reset_to_upstream", {
    repoPath,
    branch,
    expectedTip,
  });

export interface MergePair {
  base: string;
  head: string;
}

export interface BranchMergeState {
  /** `head` is fully merged into `base` (nothing left to merge). */
  merged: boolean;
  /** The `head` branch still exists locally. */
  headExists: boolean;
}

/** Per pair: whether `head` is merged into `base`, and whether `head` exists. */
export const gitBranchMergeStates = (repoPath: string, pairs: MergePair[]) =>
  invoke<BranchMergeState[]>("git_branch_merge_states", { repoPath, pairs });

/** Resolves to "up-to-date" | "fast-forward" | "merge". */
export const gitUpdateBranchFrom = (
  repoPath: string,
  branch: string,
  base: string,
) => invoke<string>("git_update_branch_from", { repoPath, branch, base });

export type MergeStrategy = "merge" | "squash" | "rebase" | "fast_forward";

/** Outcome of starting or finishing a local-PR merge: `merged` committed; `conflicts`
 *  paused in an isolated worktree for the user to resolve, without touching their
 *  branch or working tree (the worktree fields feed finish/abort). */
export interface LocalPrMergeOutcome {
  status: "merged" | "conflicts";
  conflicts: string[];
  /** The base tip after a successful merge (informational). */
  baseTip: string;
  /** The detached worktree holding the in-progress merge; null when merged clean. */
  worktreePath: string | null;
  /** The worktree's id, passed to finish; null when merged clean. */
  worktreeId: string | null;
  /** The oplog entry id, passed to finish/abort. */
  opId: string | null;
}

export const gitMergeLocalPr = (
  repoPath: string,
  base: string,
  head: string,
  message: string,
  strategy: MergeStrategy,
) =>
  invoke<LocalPrMergeOutcome>("git_merge_local_pr", {
    repoPath,
    base,
    head,
    message,
    strategy,
  });

/** Commits a paused local-PR merge once its conflicts are resolved (staged) in the
 *  worktree at `worktreePath`. May itself return `conflicts` again for a multi-step
 *  rebase that re-pauses (in the same worktree). */
export const gitFinishLocalPrMerge = (
  repoPath: string,
  base: string,
  strategy: MergeStrategy,
  message: string,
  worktreePath: string,
  worktreeId: string,
  opId: string | null,
) =>
  invoke<LocalPrMergeOutcome>("git_finish_local_pr_merge", {
    repoPath,
    base,
    strategy,
    message,
    worktreePath,
    worktreeId,
    opId,
  });

/** Rolls a paused local-PR merge back by deleting the merge worktree — the user's
 *  branch and working tree were never touched, so nothing else to undo. */
export const gitAbortLocalPrMerge = (
  repoPath: string,
  worktreePath: string,
  opId: string | null,
) =>
  invoke<void>("git_abort_local_pr_merge", {
    repoPath,
    worktreePath,
    opId,
  });

/** Outcome of merging a remote PR's base INTO its head branch: `pushed` merged clean
 *  and the head branch was updated on the forge (never force); `conflicts` paused in
 *  an isolated worktree for the user to resolve (its fields feed finish/abort). */
export interface RemotePrResolveOutcome {
  status: "pushed" | "conflicts";
  /** May be EMPTY on a `conflicts` outcome that re-attached to an existing worktree
   *  whose conflicts are all resolved already — Finish is the next step, not a fault. */
  conflicts: string[];
  /** The detached worktree holding the paused merge; null when it pushed clean. */
  worktreePath: string | null;
  /** The worktree's id, passed to finish; null when it pushed clean. */
  worktreeId: string | null;
  /** The head branch's new tip after a successful push (informational). */
  pushedSha: string | null;
}

/** An existing resolve worktree, as returned by {@link gitFindRemotePrResolve}. The id
 *  is backend-owned — never derived from the path. */
export interface RemotePrResolveHandle {
  worktreePath: string;
  worktreeId: string;
}

/** Merges the lens remote's `<base>` into the PR's head branch in a hidden detached
 *  worktree — the user's branch and working tree are untouched. Idempotent: an existing
 *  resolve worktree for this PR+lens comes back as `conflicts` instead of a duplicate. */
export const gitMergeRemotePr = (
  repoPath: string,
  number: number,
  base: string,
  head: string,
  message: string | null,
  lens: RemoteLens,
) =>
  invoke<RemotePrResolveOutcome>("git_merge_remote_pr", {
    repoPath,
    number,
    base,
    head,
    message,
    lens,
  });

/** Commits a paused remote-PR resolution and pushes the head branch. Errors while any
 *  conflict is unresolved, and errors KEEPING the worktree if the remote head moved. */
export const gitFinishRemotePrResolve = (
  repoPath: string,
  head: string,
  worktreePath: string,
  worktreeId: string,
  message: string | null,
  lens: RemoteLens,
) =>
  invoke<RemotePrResolveOutcome>("git_finish_remote_pr_resolve", {
    repoPath,
    head,
    worktreePath,
    worktreeId,
    message,
    lens,
  });

/** Discards a paused remote-PR resolution by deleting its worktree — nothing was
 *  pushed and the user's branch was never touched, so nothing else to undo. */
export const gitAbortRemotePrResolve = (
  repoPath: string,
  worktreePath: string,
) => invoke<void>("git_abort_remote_pr_resolve", { repoPath, worktreePath });

/** The existing resolve worktree for this PR under this lens, or null — lets the view
 *  offer to resume a resolution left behind by an earlier session. */
export const gitFindRemotePrResolve = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) =>
  invoke<RemotePrResolveHandle | null>("git_find_remote_pr_resolve", {
    repoPath,
    number,
    lens,
  });

/** In-memory prediction of whether merging `head` into `base` will conflict, for
 *  the pre-merge preview line. Reuses the existing `MergePreview` shape. */
export const gitConflictPreview = (
  repoPath: string,
  base: string,
  head: string,
) => invoke<MergePreview>("git_conflict_preview", { repoPath, base, head });

export const gitRepoStats = (repoPath: string) =>
  invoke<RepoStats>("git_repo_stats", { repoPath });

/** Stats for the commits/diff `branch` has that `base` doesn't. */
export const gitBranchStats = (
  repoPath: string,
  branch: string,
  base: string,
) => invoke<BranchStats>("git_branch_stats", { repoPath, branch, base });

// Insights graphs — `weeks > 0` limits to a trailing window; `0` is all history.
export const gitContributorActivity = (repoPath: string, weeks: number) =>
  invoke<ContributorChurn[]>("git_contributor_activity", { repoPath, weeks });

export const gitCommitActivity = (repoPath: string, weeks: number) =>
  invoke<WeekCount[]>("git_commit_activity", { repoPath, weeks });

export const gitCodeFrequency = (repoPath: string, weeks: number) =>
  invoke<CodeFreqPoint[]>("git_code_frequency", { repoPath, weeks });

export const gitPunchCard = (repoPath: string, weeks: number) =>
  invoke<PunchCard>("git_punch_card", { repoPath, weeks });

export const ghCommunityInsights = (repoPath: string) =>
  invoke<CommunityInsights>("gh_community_insights", { repoPath });

export const ghRepoTraffic = (repoPath: string) =>
  invoke<RepoTraffic>("gh_repo_traffic", { repoPath });

export const ghRepoDependencies = (repoPath: string) =>
  invoke<RepoDependencies>("gh_repo_dependencies", { repoPath });

export const forgeForkActivity = (repoPath: string) =>
  invoke<ForgeForkActivity>("forge_fork_activity", { repoPath });

export const forgeForkDivergence = (
  repoPath: string,
  forkFullName: string,
  baseBranch: string,
  forkBranch: string,
) =>
  invoke<ForgeForkDivergence>("forge_fork_divergence", {
    repoPath,
    forkFullName,
    baseBranch,
    forkBranch,
  });

export const gitCompareBranches = (
  repoPath: string,
  base: string,
  compare: string,
) =>
  invoke<BranchComparison>("git_compare_branches", { repoPath, base, compare });

export const gitBranchDiffFiles = (
  repoPath: string,
  base: string,
  compare: string,
) =>
  invoke<DiffStatEntry[]>("git_branch_diff_files", { repoPath, base, compare });

export const gitBranchFileDiff = (
  repoPath: string,
  base: string,
  compare: string,
  filePath: string,
) =>
  invoke<FileDiff>("git_branch_file_diff", {
    repoPath,
    base,
    compare,
    filePath,
  });

/** Three-dot `base...compare` diff. `exclude` takes gitignore-style patterns the
 *  backend filters out of the text and file list (counting them in
 *  `excludedFiles`); generation callers pass the user's AI-ignore patterns here.
 *  Review callers omit them and filter client-side instead
 *  (`filterDiffByAiIgnore`), which covers forge-supplied PR diffs too. */
export const gitBranchDiff = (
  repoPath: string,
  base: string,
  compare: string,
  maxBytes?: number,
  exclude?: string[],
) =>
  invoke<StagedDiff>("git_branch_diff", {
    repoPath,
    base,
    compare,
    maxBytes: maxBytes ?? null,
    exclude: exclude ?? null,
  });

/** The literal `fromRef..toRef` diff — "what changed since the last review".
 *  Soft, best-effort: never throws for missing/rewritten history; the result's
 *  `reason` says why the delta is absent so the caller can fall back. */
export const gitDiffBetweenRefs = (
  repoPath: string,
  fromRef: string,
  toRef: string,
  maxBytes?: number,
) =>
  invoke<DeltaDiff>("git_diff_between_refs", {
    repoPath,
    fromRef,
    toRef,
    maxBytes: maxBytes ?? null,
  });

/** Best-effort fetch of specific commit SHAs from origin, so a remote PR's
 *  prior-review delta can resolve when the PR was never checked out. Returns
 *  whether the fetch succeeded; callers treat failure as "no delta". */
export const gitFetchObjects = (repoPath: string, refs: string[]) =>
  invoke<boolean>("git_fetch_objects", { repoPath, refs });

/** Fixed-string `git grep` at a rev, as `path:line:content` lines ("" = no
 *  matches). Used by the agentic HTTP review tool loop to search at the PR head. */
export const gitGrepAtRef = (
  repoPath: string,
  pattern: string,
  atRef: string,
  maxHits?: number,
) => invoke<string>("git_grep_at_ref", { repoPath, pattern, atRef, maxHits });

/** Scans the working tree for TODO/FIXME/HACK/… code comments (case-sensitive
 *  fixed-string `git grep`), grouped by path in output order. `maxHits` caps the
 *  total (default 2000 server-side); `truncated` reports when the cap was hit. */
export const gitTodoScan = (
  repoPath: string,
  markers: string[],
  maxHits?: number,
) => invoke<TodoScan>("git_todo_scan", { repoPath, markers, maxHits });

/** Current tip SHA of each requested local branch (one for-each-ref call).
 *  Branches that don't exist are omitted. Used to watch open local PRs' heads. */
export const gitBranchTips = (repoPath: string, branches: string[]) =>
  invoke<Record<string, string>>("git_branch_tips", { repoPath, branches });

/** Hands a repo-aware CLI review a detached checkout of `sha` so it reads the
 *  PR head's files without moving the active branch: one reused worktree per
 *  repository, or a throwaway mint when that one is unavailable. Returns the
 *  path, or null when one isn't needed/possible (already on that commit, object
 *  not local, or both checkouts failed) — caller uses the repo root. */
export const gitReviewWorktree = (repoPath: string, sha: string) =>
  invoke<string | null>("git_review_worktree", { repoPath, sha });

/** Releases the review workspace: the reused per-repo worktree is unclaimed, a
 *  throwaway mint is removed. Best-effort, idempotent. */
export const gitRemoveWorktree = (repoPath: string, worktreePath: string) =>
  invoke<void>("git_remove_worktree", { repoPath, worktreePath });

/** Reclaims leaked local-PR conflict worktrees: removes every hidden `gd-resolve-*`
 *  worktree whose path is NOT in `keepPaths`. Pass every active paused merge's
 *  `pendingMerge.worktreePath` (as it came from the merge outcome) so an in-progress
 *  resolve is spared. Best-effort housekeeping, run once on repo open. */
export const gitCleanupOrphanedResolveWorktrees = (
  repoPath: string,
  keepPaths: string[],
) =>
  invoke<void>("git_cleanup_orphaned_resolve_worktrees", {
    repoPath,
    keepPaths,
  });

/** Provider-neutral hosted-integration status (GitHub, GitLab, Bitbucket) — the gate
 *  hosted panels read for any provider. */
export const forgeStatus = (repoPath: string) =>
  invoke<ForgeStatus>("forge_status", { repoPath });

/** The signed-in user's repositories on a provider, for the clone browser. */
export const forgeListRepos = (provider: ForgeProvider) =>
  invoke<ForgeRepoList>("forge_list_repos", { provider });

/** The namespaces the signed-in user owns on a provider — derived from the
 *  same probes as `forgeListRepos`' `ownedNamespaces`, without the repository
 *  list. */
export const forgeOwnedNamespaces = (provider: ForgeProvider) =>
  invoke<string[]>("forge_owned_namespaces", { provider });

// ── Explore: search / browse / fork / star / README ──────────────────────────
//
// The Explore surface searches and browses repositories on a provider. An empty
// `query` means the Popular feed (GitHub/GitLab only — never send an empty query
// for Bitbucket, whose search is workspace-scoped and single-page).

/** Search repositories on a provider (empty `query` = the Popular feed on
 *  GitHub/GitLab). `page` is 1-based; `hasMore` on the result drives paging. */
export const forgeSearchRepos = (
  provider: ForgeProvider,
  query: string,
  sort: "best" | "stars" | "updated",
  page: number,
) =>
  invoke<ForgeSearchList>("forge_search_repos", {
    provider,
    query,
    sort,
    page,
  });

/** Fork a repository under the signed-in user's account. Async server-side — the
 *  result's `ready` is false when the fork's git objects may not be clonable yet. */
export const forgeForkRepo = (
  provider: ForgeProvider,
  owner: string,
  name: string,
) => invoke<ForgeForkResult>("forge_fork_repo", { provider, owner, name });

/** Star (or unstar, when `star` is false) a repository. */
export const forgeStarRepo = (
  provider: ForgeProvider,
  owner: string,
  name: string,
  star: boolean,
) => invoke<void>("forge_star_repo", { provider, owner, name, star });

/** Whether the signed-in user has starred a repository. */
export const forgeStarred = (
  provider: ForgeProvider,
  owner: string,
  name: string,
) => invoke<boolean>("forge_starred", { provider, owner, name });

/** A repository's rendered README (HTML/markdown from the provider); null when the
 *  repo has no README (not an error). `defaultBranch` scopes the lookup when known. */
export const forgeRepoReadme = (
  provider: ForgeProvider,
  owner: string,
  name: string,
  defaultBranch: string | null,
) =>
  invoke<string | null>("forge_repo_readme", {
    provider,
    owner,
    name,
    defaultBranch,
  });

/** What a provider supports and what GitDesktop has built for it — the gate the
 *  Explore surface reads to show only Fork/Star/README controls that work. */
export const forgeProviderFeatures = (provider: ForgeProvider) =>
  invoke<ForgeProviderFeatures>("forge_provider_features", { provider });

// ── Bitbucket account (Atlassian API token) ──────────────────────────────────
//
// Bitbucket Cloud auth is an Atlassian API token used with the account email (HTTP
// Basic); the token lives in the OS keychain and is never returned. Cold-start test
// mode has no keychain, so `forgeBbAccount` reports "not connected".

/** Validate an Atlassian API token against GET /2.0/user and, on success, save
 *  it to the keychain. Throws (nothing saved) on an invalid token or a network
 *  failure — the message distinguishes the two. */
export const forgeBbSetAccount = (email: string, token: string) =>
  invoke<BbAccountInfo>("forge_bb_set_account", { email, token });

/** Remove the saved Bitbucket token from the keychain. */
export const forgeBbClearAccount = () => invoke<void>("forge_bb_clear_account");

/** The saved Bitbucket account (fast keyring check, no network); null when none. */
export const forgeBbAccount = () =>
  COLD_START
    ? Promise.resolve<BbAccountInfo | null>(null)
    : invoke<BbAccountInfo | null>("forge_bb_account");

// ── Forge session health & reconnect ─────────────────────────────────────────
//
// Probe a session (gh/glab account or the Bitbucket token) and drive an in-app
// reconnect (gh's device flow / glab's `--web`) instead of sending the user to a
// terminal.

/** The health of the forge session backing THIS repo (its provider only). */
export const forgeSessionHealth = (repoPath: string) =>
  invoke<SessionHealth>("forge_session_health", { repoPath });

/** The health of every known forge account (gh accounts + glab hosts). */
export const forgeAccountsHealth = () =>
  invoke<SessionHealth[]>("forge_accounts_health");

/** Drive an in-app reconnect: `mode: "login"` signs in a new session, `"refresh"`
 *  renews an existing one. Streams `ReconnectEvent`s (gh's device code, glab's
 *  progress lines, then a terminal `finished`) over a Channel; resolves when the
 *  flow ends. Cancel a live flow via {@link forgeReconnectCancel} with the same
 *  `sessionId` (generated frontend-side with `crypto.randomUUID()`). */
export const forgeReconnect = (args: {
  sessionId: string;
  provider: "github" | "gitlab";
  host: string;
  mode: "login" | "refresh";
  /** Extra OAuth scopes (`gh auth refresh -s …`) — GitHub `refresh` only; the
   *  backend rejects them elsewhere rather than dropping them. */
  scopes?: string[];
  onEvent: (event: ReconnectEvent) => void;
}): Promise<void> => {
  const channel = new Channel<ReconnectEvent>();
  channel.onmessage = args.onEvent;
  return invoke<void>("forge_reconnect", {
    sessionId: args.sessionId,
    provider: args.provider,
    host: args.host,
    mode: args.mode,
    scopes: args.scopes ?? null,
    onEvent: channel,
  });
};

/** Cancel an in-flight reconnect flow (kills the CLI subprocess). */
export const forgeReconnectCancel = (sessionId: string) =>
  invoke<void>("forge_reconnect_cancel", { sessionId });

/** Clone a repo for a provider, supplying provider auth that plain `git clone`
 *  lacks (a private GitLab repo authenticates via glab's token). Returns the
 *  cloned path. */
export const forgeClone = (
  provider: ForgeProvider,
  url: string,
  parentDir: string,
  dirName?: string,
  recurseSubmodules = false,
) =>
  invoke<string>("forge_clone", {
    provider,
    url,
    parentDir,
    dirName: dirName ?? null,
    recurseSubmodules,
  });

/** Create a merge/pull request (pushes the head branch first). Provider-neutral:
 *  GitHub via `gh pr create`, GitLab via `glab` with a one-shot credential-helper
 *  push and draft mapped to the `Draft:` title prefix. */
export const forgePrCreate = (
  repoPath: string,
  base: string,
  head: string,
  title: string,
  body: string,
  draft: boolean,
  reviewers: string[] | undefined,
  labels: string[] | undefined,
  assignees: string[] | undefined,
  lens: RemoteLens,
) =>
  invoke<PrRef>("forge_pr_create", {
    repoPath,
    base,
    head,
    title,
    body,
    draft,
    // Create-time reviewers are Bitbucket-only; omit (null) for other providers so
    // the backend leaves behavior untouched.
    reviewers: reviewers ?? null,
    // Labels (names) + assignees (login/username strings) are GitHub/GitLab; omit
    // (null) for Bitbucket so the backend leaves behavior untouched.
    labels: labels ?? null,
    assignees: assignees ?? null,
    lens,
  });

/** Which providers this machine can publish to (CLI installed + signed in) —
 *  asked explicitly since an unpublished repo has no remote to detect one from. */
export const forgePublishTargets = (repoPath: string) =>
  invoke<{ github: boolean; gitlab: boolean; bitbucket: boolean }>(
    "forge_publish_targets",
    { repoPath },
  );

/** Publish a local repo to the CHOSEN provider (create + add origin + push).
 *  GitLab has no homepage field and drops it (the dialog hides that field).
 *  Bitbucket maps homepage → website, drops topics, and needs a `workspace`. */
export const forgePublishRepo = (
  provider: "github" | "gitlab" | "bitbucket",
  repoPath: string,
  name: string,
  isPrivate: boolean,
  description: string,
  homepage: string,
  topics: string[],
  workspace?: string,
) =>
  invoke<string>("forge_publish_repo", {
    provider,
    repoPath,
    name,
    private: isPrivate,
    description,
    homepage,
    topics,
    workspace,
  });

/** Open PRs/MRs whose head is `head` — the ComparePanel duplicate probe. */
export const forgePrsForBranch = (
  repoPath: string,
  head: string,
  lens: RemoteLens,
) => invoke<PrInfo[]>("forge_prs_for_branch", { repoPath, head, lens });

export type PrStateFilter = "open" | "closed";

/** The CI rollup for a PR-list page, keyed by number (provider-neutral). `prs` carries
 *  each row's number plus head SHA (the Bitbucket arm needs the SHA). `sampleUrl` is any
 *  PR html url from the same page and is load-bearing for forks: it fixes which repo the
 *  numbers belong to when the list resolves to the parent while origin points at the
 *  fork. */
export const forgePrListCi = (
  repoPath: string,
  prs: { number: number; headSha: string }[],
  sampleUrl: string,
) => invoke<PrCiStatus[]>("forge_pr_list_ci", { repoPath, prs, sampleUrl });

/** Mergeability for a PR-list page, keyed by number — the sibling of
 *  {@link forgePrListCi}. Unlike the CI rollup it takes no row list: the backend
 *  re-queries the page from these same filter args, so only the filters cross the
 *  wire. Only rows the provider can answer for appear in the record. */
export const forgePrListMergeability = (
  repoPath: string,
  state: PrStateFilter,
  limit: number | undefined,
  lens: RemoteLens,
) =>
  invoke<Record<number, PrMergeabilityState>>("forge_pr_list_mergeability", {
    repoPath,
    state,
    limit,
    lens,
  });

/** A PR's activity timeline (force-pushes, label changes, review requests, state
 *  changes, approvals) for the Conversation tab. Provider-neutral — the backend
 *  dispatches per provider (GitHub `gh`, GitLab `glab`, Bitbucket HTTP). */
export const forgePrTimeline = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) =>
  invoke<ForgeTimelineEvent[]>("forge_pr_timeline", { repoPath, number, lens });

/** An issue's activity timeline (labels, assignment, milestones, cross-references,
 *  state changes) for the issue view. Provider-neutral — the backend dispatches
 *  (GitHub GraphQL, GitLab resource events + system notes; Bitbucket issues are
 *  unsupported). */
export const forgeIssueTimeline = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) =>
  invoke<ForgeTimelineEvent[]>("forge_issue_timeline", {
    repoPath,
    number,
    lens,
  });

// Provider-neutral merge/pull request reads — the backend resolves the repo's provider
// and dispatches, returning the same neutral `PrInfo`/`PrDetails` shapes. Neutral
// `forge*` wrappers cover the writes below; a few paths stay GitHub-only —
// comment hide/unhide, update-branch, base-divergence, and PR checkout.
export const forgePrList = (
  repoPath: string,
  state: PrStateFilter,
  limit: number | undefined,
  lens: RemoteLens,
) => invoke<PrInfo[]>("forge_pr_list", { repoPath, state, limit, lens });

export const forgePrView = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) => invoke<PrDetails>("forge_pr_view", { repoPath, number, lens });

/** A single PR's mergeability against its base. GitHub computes this asynchronously
 *  and this read PRIMES that computation, so a "checking" result means poll again;
 *  non-open PRs (and Bitbucket) answer "unavailable". */
export const forgePrMergeability = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) =>
  invoke<PrMergeability>("forge_pr_mergeability", { repoPath, number, lens });

export const forgePrDiff = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) => invoke<string>("forge_pr_diff", { repoPath, number, lens });

/** The unified diff for a single commit of a PR/MR (per-commit review view). */
export const forgePrCommitDiff = (
  repoPath: string,
  number: number,
  oid: string,
) => invoke<string>("forge_pr_commit_diff", { repoPath, number, oid });

/** The forge's own unified diff for a single commit, independent of any PR/MR.
 *  Reuses `forge_pr_commit_diff` with `number: 0` — `number` is part of the neutral
 *  contract but ignored by every provider (documented in forge/mod.rs), so a
 *  PR-independent commit diff just passes a placeholder. */
export const forgeCommitDiff = (repoPath: string, sha: string) =>
  invoke<string>("forge_pr_commit_diff", { repoPath, number: 0, oid: sha });

/** Whether a commit exists on any remote (the History-tab comment surface gates on
 *  it — you can only comment on a commit the forge already has). */
export const commitOnRemote = (repoPath: string, sha: string) =>
  invoke<boolean>("commit_on_remote", { repoPath, sha });

// Commit comments (GitHub commit comments / GitLab commit notes) — plain or
// diff-anchored, provider-neutral. `sha` is the commit; `commentId` addresses a
// single comment for edit/delete.
export const forgeCommitComments = (
  repoPath: string,
  sha: string,
  lens: RemoteLens,
) =>
  invoke<CommitCommentOut[]>("forge_commit_comments", { repoPath, sha, lens });

export const forgeCommitCommentCreate = (
  repoPath: string,
  args: {
    sha: string;
    body: string;
    path?: string;
    line?: number;
    startLine?: number;
    position?: number;
  },
  lens: RemoteLens,
) =>
  invoke<void>("forge_commit_comment_create", {
    repoPath,
    sha: args.sha,
    body: args.body,
    path: args.path ?? null,
    line: args.line ?? null,
    startLine: args.startLine ?? null,
    position: args.position ?? null,
    lens,
  });

export const forgeCommitCommentEdit = (
  repoPath: string,
  args: { sha: string; commentId: string; body: string },
  lens: RemoteLens,
) =>
  invoke<void>("forge_commit_comment_edit", {
    repoPath,
    sha: args.sha,
    commentId: args.commentId,
    body: args.body,
    lens,
  });

export const forgeCommitCommentDelete = (
  repoPath: string,
  args: { sha: string; commentId: string },
  lens: RemoteLens,
) =>
  invoke<void>("forge_commit_comment_delete", {
    repoPath,
    sha: args.sha,
    commentId: args.commentId,
    lens,
  });

/** Provider-neutral PR poll for the notification poller + remote pr-sync — the
 *  backend dispatches (GitHub `gh`, GitLab `glab`, Bitbucket HTTP) onto the same
 *  neutral `PrPollInfo`. GitLab/Bitbucket carry no check rollup or review decision
 *  in list responses, so those fields come back empty (a v1 limit); `headSha`
 *  still drives pr-sync. */
export const forgePrPoll = (repoPath: string) =>
  invoke<PrPollInfo[]>("forge_pr_poll", { repoPath });

export type IssueStateFilter = "open" | "closed";

// Provider-neutral issue reads — the backend resolves the repo's provider and
// dispatches, returning the same neutral `IssueInfo`/`IssueDetails` shapes. Most writes
// are neutral too; the GitHub-only ones keep their `gh_issue_*` names (pin/unpin, issue
// type, sub-issues/dependencies, linked branch) — trust the prefix, not this list.
export const forgeIssueList = (
  repoPath: string,
  state: IssueStateFilter,
  limit: number | undefined,
  lens: RemoteLens,
) => invoke<IssueInfo[]>("forge_issue_list", { repoPath, state, limit, lens });

export const forgeIssueView = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) => invoke<IssueDetails>("forge_issue_view", { repoPath, number, lens });

/** Create an issue. Provider-neutral: `milestone` is the provider's milestone key
 *  (whatever `forgeMilestones` returned as `number`); only `issueType` is
 *  GitHub-only and dropped by the GitLab arm (its dialog hides that picker). */
export const forgeIssueCreate = (
  repoPath: string,
  title: string,
  body: string,
  labels: string[],
  assignees: string[],
  milestone: number | null,
  issueType: string | null,
  lens: RemoteLens,
) =>
  invoke<PrRef>("forge_issue_create", {
    repoPath,
    title,
    body,
    labels,
    assignees,
    milestone,
    issueType,
    lens,
  });

export const forgeAssignableUsers = (repoPath: string, lens: RemoteLens) =>
  invoke<ForgeUserRef[]>("forge_assignable_users", { repoPath, lens });

/** Open/active milestones for the milestone picker. `number` is whatever key the
 *  provider's milestone write takes (GitHub milestone number, GitLab global id). */
export const forgeMilestones = (repoPath: string, lens: RemoteLens) =>
  invoke<Milestone[]>("forge_milestones", { repoPath, lens });

export const forgeIssueSetAssignees = (
  repoPath: string,
  number: number,
  assignees: string[],
  lens: RemoteLens,
) =>
  invoke<void>("forge_issue_set_assignees", {
    repoPath,
    number,
    assignees,
    lens,
  });

/** Set a merge/pull request's assignees — GitHub + GitLab (`implemented.mrAssignees`);
 *  Bitbucket has no PR assignee concept. */
export const forgeMrSetAssignees = (
  repoPath: string,
  number: number,
  assignees: string[],
  lens: RemoteLens,
) =>
  invoke<void>("forge_mr_set_assignees", { repoPath, number, assignees, lens });

export const forgeIssueSetMilestone = (
  repoPath: string,
  number: number,
  milestone: number | null,
  lens: RemoteLens,
) =>
  invoke<void>("forge_issue_set_milestone", {
    repoPath,
    number,
    milestone,
    lens,
  });

/** Mark an issue confidential (members-only) or public — GitLab-only. */
export const forgeGlIssueSetConfidential = (
  repoPath: string,
  number: number,
  confidential: boolean,
) =>
  invoke<void>("forge_gl_issue_set_confidential", {
    repoPath,
    number,
    confidential,
  });

/** Set ("YYYY-MM-DD") or clear (null) an issue's due date — GitLab-only. */
export const forgeGlIssueSetDueDate = (
  repoPath: string,
  number: number,
  dueDate: string | null,
) => invoke<void>("forge_gl_issue_set_due_date", { repoPath, number, dueDate });

// GitLab time tracking (estimate + spent) on issues and MRs — `implemented.timeTracking`.
// Durations use GitLab's human format ("3h", "1d 2h 30m"); the server validates. Every
// write returns the fresh {@link GitLabTimeStats}, so callers write it straight into the
// cache.
export const forgeGlIssueTimeStats = (repoPath: string, number: number) =>
  invoke<GitLabTimeStats>("forge_gl_issue_time_stats", { repoPath, number });

export const forgeGlMrTimeStats = (repoPath: string, number: number) =>
  invoke<GitLabTimeStats>("forge_gl_mr_time_stats", { repoPath, number });

/** Set or reset (null/empty) an issue's estimate. */
export const forgeGlIssueSetTimeEstimate = (
  repoPath: string,
  number: number,
  duration: string | null,
) =>
  invoke<GitLabTimeStats>("forge_gl_issue_set_time_estimate", {
    repoPath,
    number,
    duration,
  });

/** Add to (or, with null, reset) an issue's spent time. Positive adds; a
 *  negative duration ("-15m") subtracts. */
export const forgeGlIssueAddSpentTime = (
  repoPath: string,
  number: number,
  duration: string | null,
) =>
  invoke<GitLabTimeStats>("forge_gl_issue_add_spent_time", {
    repoPath,
    number,
    duration,
  });

export const forgeGlMrSetTimeEstimate = (
  repoPath: string,
  number: number,
  duration: string | null,
) =>
  invoke<GitLabTimeStats>("forge_gl_mr_set_time_estimate", {
    repoPath,
    number,
    duration,
  });

export const forgeGlMrAddSpentTime = (
  repoPath: string,
  number: number,
  duration: string | null,
) =>
  invoke<GitLabTimeStats>("forge_gl_mr_add_spent_time", {
    repoPath,
    number,
    duration,
  });

// GitLab related-issue links (relates_to) — GitLab-only, gated on
// `implemented.issueLinks`. Links are symmetric server-side.
export const forgeGlIssueLinks = (repoPath: string, number: number) =>
  invoke<GitLabLinkedIssue[]>("forge_gl_issue_links", { repoPath, number });

export const forgeGlIssueLink = (
  repoPath: string,
  number: number,
  targetNumber: number,
) => invoke<void>("forge_gl_issue_link", { repoPath, number, targetNumber });

export const forgeGlIssueUnlink = (
  repoPath: string,
  number: number,
  linkId: string,
) => invoke<void>("forge_gl_issue_unlink", { repoPath, number, linkId });

/** The repo's enabled issue types (empty when the owner defines none). */
export const ghIssueTypes = (repoPath: string, lens: RemoteLens) =>
  invoke<IssueType[]>("gh_issue_types", { repoPath, lens });

export const ghIssueSetType = (
  repoPath: string,
  number: number,
  typeName: string | null,
  lens: RemoteLens,
) => invoke<void>("gh_issue_set_type", { repoPath, number, typeName, lens });

export const ghIssuePin = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) => invoke<void>("gh_issue_pin", { repoPath, number, lens });

export const ghIssueUnpin = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) => invoke<void>("gh_issue_unpin", { repoPath, number, lens });

export type LockReason = "off_topic" | "resolved" | "spam" | "too_heated";

/** Locks the conversation. `reason` is GitHub-only (GitLab locks without one —
 *  its arm ignores it). */
export const forgeIssueLock = (
  repoPath: string,
  number: number,
  reason: LockReason | null,
  lens: RemoteLens,
) => invoke<void>("forge_issue_lock", { repoPath, number, reason, lens });

export const forgeIssueUnlock = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) => invoke<void>("forge_issue_unlock", { repoPath, number, lens });

export const forgeIssueReactions = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) =>
  invoke<IssueReactions>("forge_issue_reactions", { repoPath, number, lens });

/** The reaction subject travels in BOTH provider vocabularies: GitHub keys on
 *  `subjectId` (a GraphQL node id) and ignores `target`/`number`; GitLab keys on
 *  `target` ("issue"/"mr") + `number`, with `subjectId` empty for the body or
 *  the note id for a comment. Discussions (GitHub-only) pass "discussion". */
export type ReactionTarget = "issue" | "mr" | "discussion";

export const forgeAddReaction = (
  repoPath: string,
  target: ReactionTarget,
  number: number,
  subjectId: string,
  content: string,
) =>
  invoke<void>("forge_add_reaction", {
    repoPath,
    target,
    number,
    subjectId,
    content,
  });

export const forgeRemoveReaction = (
  repoPath: string,
  target: ReactionTarget,
  number: number,
  subjectId: string,
  content: string,
) =>
  invoke<void>("forge_remove_reaction", {
    repoPath,
    target,
    number,
    subjectId,
    content,
  });

/** The repo's issue templates (frontmatter stripped); empty when it has none. */
export const readIssueTemplates = (repoPath: string) =>
  invoke<string[]>("read_issue_templates", { repoPath });

export const ghDiscussionCategories = (repoPath: string) =>
  invoke<DiscussionMeta>("gh_discussion_categories", { repoPath });

export const ghDiscussionList = (
  repoPath: string,
  category: string | null,
  limit?: number,
) =>
  invoke<DiscussionInfo[]>("gh_discussion_list", { repoPath, category, limit });

export const ghDiscussionView = (repoPath: string, number: number) =>
  invoke<DiscussionDetails>("gh_discussion_view", { repoPath, number });

export const ghDiscussionCreate = (
  repoPath: string,
  repoId: string,
  categoryId: string,
  title: string,
  body: string,
) =>
  invoke<PrRef>("gh_discussion_create", {
    repoPath,
    repoId,
    categoryId,
    title,
    body,
  });

export const ghDiscussionAddComment = (
  repoPath: string,
  discussionId: string,
  body: string,
  replyToId: string | null,
) =>
  invoke<void>("gh_discussion_add_comment", {
    repoPath,
    discussionId,
    body,
    replyToId,
  });

export const ghDiscussionMarkAnswer = (repoPath: string, commentId: string) =>
  invoke<void>("gh_discussion_mark_answer", { repoPath, commentId });

export const ghDiscussionUnmarkAnswer = (repoPath: string, commentId: string) =>
  invoke<void>("gh_discussion_unmark_answer", { repoPath, commentId });

export const ghDiscussionUpdateComment = (
  repoPath: string,
  commentId: string,
  body: string,
) =>
  invoke<void>("gh_discussion_update_comment", { repoPath, commentId, body });

export const ghDiscussionDeleteComment = (
  repoPath: string,
  commentId: string,
) => invoke<void>("gh_discussion_delete_comment", { repoPath, commentId });

export const ghDiscussionSetUpvote = (
  repoPath: string,
  subjectId: string,
  up: boolean,
) => invoke<void>("gh_discussion_set_upvote", { repoPath, subjectId, up });

export const ghDiscussionReactions = (repoPath: string, number: number) =>
  invoke<IssueReactions>("gh_discussion_reactions", { repoPath, number });

export type DiscussionLockReason =
  | "OFF_TOPIC"
  | "TOO_HEATED"
  | "RESOLVED"
  | "SPAM";

export const ghDiscussionLock = (
  repoPath: string,
  discussionId: string,
  reason: DiscussionLockReason | null,
) => invoke<void>("gh_discussion_lock", { repoPath, discussionId, reason });

export const ghDiscussionUnlock = (repoPath: string, discussionId: string) =>
  invoke<void>("gh_discussion_unlock", { repoPath, discussionId });

export type DiscussionCloseReason = "RESOLVED" | "OUTDATED" | "DUPLICATE";

export const ghDiscussionClose = (
  repoPath: string,
  discussionId: string,
  reason: DiscussionCloseReason,
) => invoke<void>("gh_discussion_close", { repoPath, discussionId, reason });

export const ghDiscussionReopen = (repoPath: string, discussionId: string) =>
  invoke<void>("gh_discussion_reopen", { repoPath, discussionId });

export const ghDiscussionDelete = (repoPath: string, discussionId: string) =>
  invoke<void>("gh_discussion_delete", { repoPath, discussionId });

// Issue comment, close/reopen, title/body edit, lock, transfer and delete are all
// provider-neutral. The remaining GitHub-only writes keep the `gh_issue_*` prefix
// (pin/unpin, issue type, sub-issues/dependencies, linked branch).
export const forgeIssueComment = (
  repoPath: string,
  number: number,
  body: string,
  lens: RemoteLens,
) => invoke<void>("forge_issue_comment", { repoPath, number, body, lens });

export const forgeIssueClose = (
  repoPath: string,
  number: number,
  reason: string,
  lens: RemoteLens,
) => invoke<void>("forge_issue_close", { repoPath, number, reason, lens });

export const forgeIssueReopen = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) => invoke<void>("forge_issue_reopen", { repoPath, number, lens });

export const forgeIssueEdit = (
  repoPath: string,
  number: number,
  title: string,
  body: string,
  lens: RemoteLens,
) => invoke<void>("forge_issue_edit", { repoPath, number, title, body, lens });

/** Transfers (GitHub) / moves (GitLab) an issue to `destination` — "owner/repo"
 *  on GitHub, a full "group/name" project path on GitLab; returns the new URL. */
export const forgeIssueTransfer = (
  repoPath: string,
  number: number,
  destination: string,
  lens: RemoteLens,
) =>
  invoke<string>("forge_issue_transfer", {
    repoPath,
    number,
    destination,
    lens,
  });

export const forgeIssueDelete = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) => invoke<void>("forge_issue_delete", { repoPath, number, lens });

export const ghIssueRelations = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) => invoke<IssueRelations>("gh_issue_relations", { repoPath, number, lens });

export const ghIssueDependencies = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) =>
  invoke<IssueDependencies>("gh_issue_dependencies", {
    repoPath,
    number,
    lens,
  });

export const ghIssueDevelopment = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) =>
  invoke<IssueDevelopment>("gh_issue_development", { repoPath, number, lens });

/** Creates a new branch off the default branch, linked to the issue. */
export const ghIssueCreateLinkedBranch = (
  repoPath: string,
  issueId: string,
  name: string,
  lens: RemoteLens,
) =>
  invoke<void>("gh_issue_create_linked_branch", {
    repoPath,
    issueId,
    name,
    lens,
  });

/** Adds/removes a blocked-by or blocking dependency by target issue number. */
export const ghIssueSetDependency = (
  repoPath: string,
  number: number,
  relation: IssueRelation,
  target: number,
  add: boolean,
  lens: RemoteLens,
) =>
  invoke<void>("gh_issue_set_dependency", {
    repoPath,
    number,
    relation,
    target,
    add,
    lens,
  });

/** Adds issue `subNumber` (this repo) as a sub-issue of `parentId` (node id). */
export const ghIssueAddSubIssue = (
  repoPath: string,
  parentId: string,
  subNumber: number,
  lens: RemoteLens,
) =>
  invoke<void>("gh_issue_add_sub_issue", {
    repoPath,
    parentId,
    subNumber,
    lens,
  });

export const ghIssueRemoveSubIssue = (
  repoPath: string,
  parentId: string,
  subId: string,
) => invoke<void>("gh_issue_remove_sub_issue", { repoPath, parentId, subId });

/** The GitHub Projects (v2) boards this repo's items can be added to — the repo's
 *  own plus its owner's. Needs the `project` (or `read:project`) token scope; a
 *  token without it fails with the scope hint rather than an empty list. */
export const ghProjectsAvailable = (repoPath: string, lens: RemoteLens) =>
  invoke<AvailableProjects>("gh_projects_available", { repoPath, lens });

/** The boards one issue/PR currently belongs to, with each membership's item id. */
export const ghItemProjects = (
  repoPath: string,
  kind: "issue" | "pr",
  number: number,
  lens: RemoteLens,
) =>
  invoke<ProjectItemRef[]>("gh_item_projects", {
    repoPath,
    kind,
    number,
    lens,
  });

/** Links/unlinks an item's boards in one call. Adds address the project by id
 *  (`contentId` is the issue/PR node id); removes need the membership's item id,
 *  which only exists once the item is on that board. */
export const ghEditItemProjects = (
  repoPath: string,
  contentId: string,
  addProjectIds: string[],
  removes: ProjectItemRemove[],
) =>
  invoke<void>("gh_edit_item_projects", {
    repoPath,
    contentId,
    addProjectIds,
    removes,
  });

/** Third-party AI-reviewer findings on a PR/MR (Copilot/CodeRabbit/…), behind the
 *  forge abstraction: GitHub delegates unchanged, GitLab maps MR discussions,
 *  Bitbucket returns empty by design. Shape is provider-agnostic. */
export const forgePrExternalReviews = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) =>
  invoke<ExternalReviewItem[]>("forge_pr_external_reviews", {
    repoPath,
    number,
    lens,
  });

/** File:line-anchored review threads on a PR/MR, provider-neutral (GitHub
 *  reviewThreads / GitLab diff-note discussions / Bitbucket inline comments). */
export const forgePrReviewThreads = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) =>
  invoke<ReviewThreadOut[]>("forge_pr_review_threads", {
    repoPath,
    number,
    lens,
  });

/** Post a reply into an existing review thread. */
export const forgePrThreadReply = (
  repoPath: string,
  number: number,
  threadId: string,
  body: string,
) =>
  invoke<void>("forge_pr_thread_reply", { repoPath, number, threadId, body });

/** Resolve / unresolve a review thread. */
export const forgePrThreadResolve = (
  repoPath: string,
  number: number,
  threadId: string,
  resolved: boolean,
) =>
  invoke<void>("forge_pr_thread_resolve", {
    repoPath,
    number,
    threadId,
    resolved,
  });

/** Create a new file:line-anchored review thread on a PR/MR (distinct from
 *  replying into an existing one). `side` is "new" (right) or "old" (left);
 *  `startLine` opens a multi-line range. */
export const forgePrThreadCreate = (
  repoPath: string,
  args: {
    number: number;
    path: string;
    line: number;
    side: "new" | "old";
    startLine?: number;
    body: string;
  },
  lens: RemoteLens,
) =>
  invoke<void>("forge_pr_thread_create", {
    repoPath,
    number: args.number,
    path: args.path,
    line: args.line,
    side: args.side,
    startLine: args.startLine ?? null,
    body: args.body,
    lens,
  });

export type ReviewVerdict = "comment" | "approve" | "request_changes";

/** Submit a batch review — a verdict, an optional summary, and any staged draft
 *  comments posted together. Returns how many comments landed and whether the
 *  verdict applied. */
export const forgePrReviewSubmit = (
  repoPath: string,
  args: {
    number: number;
    verdict: ReviewVerdict;
    summary?: string;
    comments: DraftCommentIn[];
  },
  lens: RemoteLens,
) =>
  invoke<ReviewSubmitOut>("forge_pr_review_submit", {
    repoPath,
    number: args.number,
    verdict: args.verdict,
    summary: args.summary ?? null,
    comments: args.comments,
    lens,
  });

// The GitLab review-bot token — a second GitLab token so batch reviews / bot
// comments post under a distinct identity. Status returns the bot login when one
// is configured (null otherwise); the token itself is never returned. Cold-start
// test mode has no keychain, so status reports null.
export const forgeGitlabReviewTokenStatus = () =>
  COLD_START
    ? Promise.resolve<string | null>(null)
    : invoke<string | null>("forge_gitlab_review_token_status", {});

export const forgeGitlabReviewTokenSet = (token: string) =>
  invoke<string>("forge_gitlab_review_token_set", { token });

export const forgeGitlabReviewTokenClear = () =>
  invoke<void>("forge_gitlab_review_token_clear", {});

// MR comment, close/reopen, title/body edit and merge are provider-neutral, as are
// full reviews (see `forgePrReviewSubmit` above). `asBot` posts as the configured
// GitLab review-bot identity instead of the signed-in user (other providers ignore it).
export const forgePrComment = (
  repoPath: string,
  number: number,
  body: string,
  asBot: boolean | undefined,
  lens: RemoteLens,
) =>
  invoke<void>("forge_pr_comment", {
    repoPath,
    number,
    body,
    asBot: asBot ?? null,
    lens,
  });

// MR approve/unapprove and request-changes are GitLab + Bitbucket controls (GitHub
// does both via its Review menu); the approvals read drives their states.
export const forgePrApprovals = (repoPath: string, number: number) =>
  invoke<ApprovalState>("forge_pr_approvals", { repoPath, number });

export const forgePrApprove = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) => invoke<void>("forge_pr_approve", { repoPath, number, lens });

export const forgePrUnapprove = (repoPath: string, number: number) =>
  invoke<void>("forge_pr_unapprove", { repoPath, number });

/** Request changes on an MR (adds the viewer as a reviewer when needed); a
 *  non-empty `body` is posted as a comment alongside. */
export const forgePrRequestChanges = (
  repoPath: string,
  number: number,
  body: string,
  lens: RemoteLens,
) => invoke<void>("forge_pr_request_changes", { repoPath, number, body, lens });

/** Revoke the viewer's requested-changes state — Bitbucket-only (its revoke works
 *  on every plan, making the control a true toggle; GitLab's undo is Premium). */
export const forgePrUnrequestChanges = (repoPath: string, number: number) =>
  invoke<void>("forge_pr_unrequest_changes", { repoPath, number });

/** Toggle a PR's draft state both ways, for all three providers. Bitbucket PUTs
 *  `draft`; GitLab shells `glab mr update --ready|--draft`; GitHub shells
 *  `gh pr ready [--undo]`. `lens` is GitHub-only (fork identity) — passed through
 *  and ignored by the GitLab/Bitbucket arms. */
export const forgePrSetDraft = (
  repoPath: string,
  number: number,
  draft: boolean,
  lens?: RemoteLens,
) => invoke<void>("forge_pr_set_draft", { repoPath, number, draft, lens });

/** Replace a PR's reviewer list (ids from `forgePrReviewerCandidates`) — all
 *  three providers (`implemented.mrReviewers`); create-time reviewers remain
 *  Bitbucket-only. */
export const forgePrSetReviewers = (
  repoPath: string,
  number: number,
  reviewers: string[],
  lens: RemoteLens,
) =>
  invoke<void>("forge_pr_set_reviewers", { repoPath, number, reviewers, lens });

/** Reviewer-picker candidates for a PR — Bitbucket: workspace members minus the
 *  user the server would reject. For an existing PR pass its number (the PR author
 *  is excluded); at create time pass `null` (no PR yet — the viewer is excluded). */
export const forgePrReviewerCandidates = (
  repoPath: string,
  number: number | null,
  lens: RemoteLens,
) =>
  invoke<ForgeUserRef[]>("forge_pr_reviewer_candidates", {
    repoPath,
    number,
    lens,
  });

// Comment edit/delete are provider-neutral (GitHub via `gh`, GitLab via `glab`,
// Bitbucket via its API). `number` is the PR/MR (or issue) the comment lives on —
// GitLab/Bitbucket address the note by MR/issue + comment id, GitHub ignores it.
export const forgePrEditComment = (
  repoPath: string,
  number: number,
  commentId: string,
  body: string,
) =>
  invoke<void>("forge_pr_edit_comment", { repoPath, number, commentId, body });

export const forgePrDeleteComment = (
  repoPath: string,
  number: number,
  commentId: string,
) => invoke<void>("forge_pr_delete_comment", { repoPath, number, commentId });

export const forgeIssueEditComment = (
  repoPath: string,
  number: number,
  commentId: string,
  body: string,
) =>
  invoke<void>("forge_issue_edit_comment", {
    repoPath,
    number,
    commentId,
    body,
  });

export const forgeIssueDeleteComment = (
  repoPath: string,
  number: number,
  commentId: string,
) =>
  invoke<void>("forge_issue_delete_comment", { repoPath, number, commentId });

// Edit/delete a comment inside a file:line-anchored review thread (the same
// provider-neutral dispatch as the conversation ones; `commentId` is the thread
// comment's provider id).
export const forgePrEditReviewComment = (
  repoPath: string,
  number: number,
  commentId: string,
  body: string,
) =>
  invoke<void>("forge_pr_edit_review_comment", {
    repoPath,
    number,
    commentId,
    body,
  });

export const forgePrDeleteReviewComment = (
  repoPath: string,
  number: number,
  commentId: string,
) =>
  invoke<void>("forge_pr_delete_review_comment", {
    repoPath,
    number,
    commentId,
  });

/** GitHub `ReportedContentClassifiers` reasons for hiding a comment. */
export type MinimizeReason =
  | "OFF_TOPIC"
  | "OUTDATED"
  | "RESOLVED"
  | "DUPLICATE"
  | "SPAM"
  | "ABUSE";

export const ghPrMinimizeComment = (
  repoPath: string,
  commentId: string,
  classifier: MinimizeReason,
) =>
  invoke<void>("gh_pr_minimize_comment", { repoPath, commentId, classifier });

export const ghPrUnminimizeComment = (repoPath: string, commentId: string) =>
  invoke<void>("gh_pr_unminimize_comment", { repoPath, commentId });

/** Discards an unsubmitted (PENDING) review by its node id; only its author sees one. */
export const ghPrDiscardPendingReview = (repoPath: string, reviewId: string) =>
  invoke<void>("gh_pr_discard_pending_review", { repoPath, reviewId });

/** Outcome of an ACCEPTED forge merge (a failure rejects the invoke instead).
 *  `queued` means the forge took the merge but hasn't completed it — the PR is
 *  NOT merged yet. `cleanupWarning` carries the human-readable detail either
 *  way: on the merged path that the post-merge remote head-branch deletion
 *  failed (GitHub-only — GitLab and Bitbucket fold deletion into their atomic
 *  merge); on the queued path, what was queued. `null` = nothing to add. */
export interface PrMergeOutcome {
  queued: boolean;
  cleanupWarning: string | null;
}

// MR merge is provider-neutral (GitHub via `gh pr merge`, GitLab via `glab`). `sha`
// is GitLab's optional stale-view guard (it 409s if the head moved since the user
// loaded the MR); GitHub has no analogue and ignores it.
export const forgePrMerge = (
  repoPath: string,
  number: number,
  strategy: MergeStrategy,
  deleteBranch: boolean,
  sha: string | undefined,
  lens: RemoteLens,
) =>
  invoke<PrMergeOutcome>("forge_pr_merge", {
    repoPath,
    number,
    strategy,
    deleteBranch,
    sha: sha ?? null,
    lens,
  });

// GitLab auto-merge (merge-when-pipeline-succeeds) — GitLab-only, gated on
// `implemented.mrAutoMerge`. The merge/pipeline state drives the arm affordance
// and the "auto-merge enabled" footer indicator.
export const forgeGlMrMergeState = (repoPath: string, number: number) =>
  invoke<GitLabMrMergeState>("forge_gl_mr_merge_state", { repoPath, number });

// Arm auto-merge with a strategy ("merge" | "squash"; "rebase" is rejected
// backend-side). `sha` is the same stale-view guard as a plain merge — GitLab
// 409s if the head moved. 405s only when no auto-merge strategy is available and
// the head pipeline isn't passing; a passing one merges immediately instead.
export const forgeGlMrAutoMerge = (
  repoPath: string,
  number: number,
  strategy: MergeStrategy,
  deleteBranch: boolean,
  sha?: string,
) =>
  invoke<void>("forge_gl_mr_auto_merge", {
    repoPath,
    number,
    strategy,
    deleteBranch,
    sha: sha ?? null,
  });

export const forgeGlMrCancelAutoMerge = (repoPath: string, number: number) =>
  invoke<void>("forge_gl_mr_cancel_auto_merge", { repoPath, number });

/** Remove the project's fork relationship (detach from the fork network) —
 *  GitLab-only. Requires the Owner role; open MRs to the parent are closed. */
export const forgeGlRemoveForkRelationship = (repoPath: string) =>
  invoke<void>("forge_gl_remove_fork_relationship", { repoPath });

export const forgePrClose = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) => invoke<void>("forge_pr_close", { repoPath, number, lens });

export const forgePrReopen = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) => invoke<void>("forge_pr_reopen", { repoPath, number, lens });

/** Merge (or `rebase`) the base branch into a PR's head — GitHub's
 *  "Update branch". Queued, not synchronous: GitHub answers 202 Accepted and runs
 *  the update afterwards, so resolving means accepted, not that the head has moved. */
export const ghPrUpdateBranch = (
  repoPath: string,
  number: number,
  rebase: boolean,
  lens: RemoteLens,
) => invoke<void>("gh_pr_update_branch", { repoPath, number, rebase, lens });

/** How far a PR's head is ahead of / behind its base. */
export const ghPrBaseDivergence = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) =>
  invoke<PrBaseDivergence>("gh_pr_base_divergence", { repoPath, number, lens });

/** The open fork PR whose head `branch` already contains, or null. Advisory —
 *  a forge outage answers null rather than failing. */
export const forgeDetectForkPrForBranch = (repoPath: string, branch: string) =>
  invoke<ForkPrMatch | null>("forge_detect_fork_pr_for_branch", {
    repoPath,
    branch,
  });

/** The name of a remote pointing at `owner/repo` on origin's host, adding one if
 *  needed. Idempotent — returns the same name on a second call. */
export const forgeEnsureForkRemote = (
  repoPath: string,
  owner: string,
  repo: string,
) => invoke<string>("forge_ensure_fork_remote", { repoPath, owner, repo });

/** Approve a workflow run GitHub is holding for maintainer approval (a
 *  first-time contributor's fork PR). GitHub-only; the run read/rerun/cancel
 *  wrappers live in `lib/github/actions.ts`. */
export const forgeCiRunApprove = (
  repoPath: string,
  runId: number,
  lens?: RemoteLens,
) =>
  invoke<void>("forge_ci_run_approve", {
    repoPath,
    runId: String(runId),
    lens: lens ?? null,
  });

export const ghAccounts = () => invoke<GhAccounts>("gh_accounts");

/** Every repo the signed-in user can access (+ viewer login), newest first. */
export const ghListRepos = () => invoke<GhRepoList>("gh_list_repos");

export const ghSwitchAccount = (host: string, login: string) =>
  invoke<void>("gh_switch_account", { host, login });

export const ghPrCheckout = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) => invoke<void>("gh_pr_checkout", { repoPath, number, lens });

/** Reactions for a PR/MR body + each comment (keyed by the comment's id — a
 *  GraphQL node id on GitHub, a note id on GitLab). */
export const forgePrReactions = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) => invoke<IssueReactions>("forge_pr_reactions", { repoPath, number, lens });

/** Returns the fork's URL ("" when the fork already existed). */
export const ghRepoFork = (repoPath: string, contributeToParent: boolean) =>
  invoke<string>("gh_repo_fork", { repoPath, contributeToParent });

/** Whether the signed-in user has starred this repo. */
export const forgeRepoStarStatus = (repoPath: string) =>
  invoke<boolean>("forge_repo_star_status", { repoPath });

/** Stars (true) or unstars (false) this repo for the signed-in user. */
export const forgeRepoSetStar = (repoPath: string, starred: boolean) =>
  invoke<void>("forge_repo_set_star", { repoPath, starred });

/** Whether the signed-in user can manage this repo's settings, behind the
 *  abstraction (GitHub admin; GitLab Maintainer, with `owner` for the
 *  Owner-only lifecycle actions). Gates the settings UI. */
export const forgeRepoAdmin = (repoPath: string) =>
  invoke<ForgeRepoAdmin>("forge_repo_admin", { repoPath });

/** Whether the signed-in user can PUSH to the repo behind the lens — the
 *  permission axis the per-action forge flags don't cover (they answer "is this
 *  wired for this provider?"). Nulls mean the probe couldn't answer: fail open. */
export const forgeRepoWriteAccess = (repoPath: string, lens?: RemoteLens) =>
  invoke<ForgeRepoWriteAccess>("forge_repo_write_access", { repoPath, lens });

/** The GitLab project-settings read (GitLab repos only — GitHub stays on
 *  `ghRepoSettingsGet`; the models are provider-shaped). */
export const forgeGlRepoSettings = (repoPath: string) =>
  invoke<GitLabRepoSettings>("forge_gl_repo_settings", { repoPath });

/** Batch-save the GitLab project settings; returns the updated read. */
export const forgeGlRepoSettingsUpdate = (
  repoPath: string,
  input: GitLabRepoSettingsInput,
) =>
  invoke<GitLabRepoSettings>("forge_gl_repo_settings_update", {
    repoPath,
    input,
  });

// The GitLab settings sub-surfaces (Members / Webhooks / CI/CD variables) —
// GitLab repos only; the GitHub dialog keeps its gh-backed sections.
export const forgeGlMembers = (repoPath: string) =>
  invoke<GitLabMember[]>("forge_gl_members", { repoPath });

export const forgeGlMemberAdd = (
  repoPath: string,
  username: string,
  accessLevel: number,
) => invoke<void>("forge_gl_member_add", { repoPath, username, accessLevel });

export const forgeGlMemberUpdate = (
  repoPath: string,
  userId: string,
  accessLevel: number,
) => invoke<void>("forge_gl_member_update", { repoPath, userId, accessLevel });

export const forgeGlMemberRemove = (repoPath: string, userId: string) =>
  invoke<void>("forge_gl_member_remove", { repoPath, userId });

export const forgeGlHooks = (repoPath: string) =>
  invoke<GitLabHook[]>("forge_gl_hooks", { repoPath });

export const forgeGlHookCreate = (repoPath: string, input: GitLabHookInput) =>
  invoke<void>("forge_gl_hook_create", { repoPath, input });

export const forgeGlHookUpdate = (
  repoPath: string,
  hookId: string,
  input: GitLabHookInput,
) => invoke<void>("forge_gl_hook_update", { repoPath, hookId, input });

export const forgeGlHookDelete = (repoPath: string, hookId: string) =>
  invoke<void>("forge_gl_hook_delete", { repoPath, hookId });

export const forgeGlHookTest = (
  repoPath: string,
  hookId: string,
  trigger: string,
) => invoke<void>("forge_gl_hook_test", { repoPath, hookId, trigger });

export const forgeGlHookEvents = (repoPath: string, hookId: string) =>
  invoke<GitLabHookDelivery[]>("forge_gl_hook_events", { repoPath, hookId });

export const forgeGlHookResend = (
  repoPath: string,
  hookId: string,
  eventId: string,
) => invoke<void>("forge_gl_hook_resend", { repoPath, hookId, eventId });

export const forgeGlVariables = (repoPath: string) =>
  invoke<GitLabVariable[]>("forge_gl_variables", { repoPath });

export const forgeGlVariableSet = (
  repoPath: string,
  args: {
    key: string;
    value: string;
    protected: boolean;
    masked: boolean;
    create: boolean;
    /** The scope the write addresses ("*" for unscoped; creates always "*"). */
    scope: string;
  },
) => invoke<void>("forge_gl_variable_set", { repoPath, ...args });

export const forgeGlVariableDelete = (
  repoPath: string,
  key: string,
  scope: string,
) => invoke<void>("forge_gl_variable_delete", { repoPath, key, scope });

export const forgeGlProtectedBranches = (repoPath: string) =>
  invoke<GitLabProtectedBranch[]>("forge_gl_protected_branches", { repoPath });

export const forgeGlProtectedBranchCreate = (
  repoPath: string,
  args: {
    name: string;
    pushAccessLevel: number;
    mergeAccessLevel: number;
    allowForcePush: boolean;
  },
) => invoke<void>("forge_gl_protected_branch_create", { repoPath, ...args });

export const forgeGlProtectedBranchUpdate = (
  repoPath: string,
  name: string,
  allowForcePush: boolean,
) =>
  invoke<void>("forge_gl_protected_branch_update", {
    repoPath,
    name,
    allowForcePush,
  });

export const forgeGlProtectedBranchDelete = (repoPath: string, name: string) =>
  invoke<void>("forge_gl_protected_branch_delete", { repoPath, name });

/** Project paths the viewer is a member of on THIS repo's host — the Move
 *  dialog's suggestions (host-correct for self-managed GitLab). */
export const forgeGlMemberProjects = (repoPath: string) =>
  invoke<string[]>("forge_gl_member_projects", { repoPath });

/** Owners the viewer can publish under — the GitHub publish owner picker (account-scoped). */
export const forgeGhPublishOwners = () =>
  invoke<GhPublishOwners>("forge_gh_publish_owners");

// ── Bitbucket settings surface — Bitbucket repos only; the GitHub / GitLab dialogs
//    keep their own provider-shaped sections.

/** The viewer's Bitbucket workspaces — the publish target picker (account-scoped). */
export const forgeBbWorkspaces = () =>
  invoke<BitbucketWorkspace[]>("forge_bb_workspaces");

export const forgeBbRepoSettings = (repoPath: string) =>
  invoke<BitbucketRepoSettings>("forge_bb_repo_settings", { repoPath });

export const forgeBbRepoSettingsUpdate = (
  repoPath: string,
  input: BitbucketRepoSettingsInput,
) =>
  invoke<BitbucketRepoSettings>("forge_bb_repo_settings_update", {
    repoPath,
    input,
  });

export const forgeBbDefaultReviewers = (repoPath: string) =>
  invoke<ForgeUserRef[]>("forge_bb_default_reviewers", { repoPath });

export const forgeBbDefaultReviewerAdd = (repoPath: string, uuid: string) =>
  invoke<void>("forge_bb_default_reviewer_add", { repoPath, uuid });

export const forgeBbDefaultReviewerRemove = (repoPath: string, uuid: string) =>
  invoke<void>("forge_bb_default_reviewer_remove", { repoPath, uuid });

/** Workspace members WITHOUT the author exclusion — the default-reviewers picker. */
export const forgeBbMemberCandidates = (repoPath: string) =>
  invoke<ForgeUserRef[]>("forge_bb_member_candidates", { repoPath });

export const forgeBbBranchRestrictions = (repoPath: string) =>
  invoke<BitbucketBranchRestriction[]>("forge_bb_branch_restrictions", {
    repoPath,
  });

export const forgeBbBranchRestrictionCreate = (
  repoPath: string,
  kind: string,
  pattern: string,
  value: number | null,
) =>
  invoke<void>("forge_bb_branch_restriction_create", {
    repoPath,
    kind,
    pattern,
    value,
  });

export const forgeBbBranchRestrictionUpdate = (
  repoPath: string,
  id: string,
  kind: string,
  pattern: string,
  value: number | null,
) =>
  invoke<void>("forge_bb_branch_restriction_update", {
    repoPath,
    id,
    kind,
    pattern,
    value,
  });

export const forgeBbBranchRestrictionDelete = (repoPath: string, id: string) =>
  invoke<void>("forge_bb_branch_restriction_delete", { repoPath, id });

export const forgeBbPipelinesConfig = (repoPath: string) =>
  invoke<BitbucketPipelinesConfig>("forge_bb_pipelines_config", { repoPath });

export const forgeBbPipelinesConfigUpdate = (
  repoPath: string,
  enabled: boolean,
) => invoke<void>("forge_bb_pipelines_config_update", { repoPath, enabled });

export const forgeBbPipelineVariables = (repoPath: string) =>
  invoke<BitbucketPipelineVariable[]>("forge_bb_pipeline_variables", {
    repoPath,
  });

export const forgeBbPipelineVariableCreate = (
  repoPath: string,
  key: string,
  value: string,
  secured: boolean,
) =>
  invoke<void>("forge_bb_pipeline_variable_create", {
    repoPath,
    key,
    value,
    secured,
  });

export const forgeBbPipelineVariableUpdate = (
  repoPath: string,
  uuid: string,
  value: string,
  secured: boolean,
) =>
  invoke<void>("forge_bb_pipeline_variable_update", {
    repoPath,
    uuid,
    value,
    secured,
  });

export const forgeBbPipelineVariableDelete = (repoPath: string, uuid: string) =>
  invoke<void>("forge_bb_pipeline_variable_delete", { repoPath, uuid });

export const forgeBbPipelineSchedules = (repoPath: string) =>
  invoke<BitbucketPipelineSchedule[]>("forge_bb_pipeline_schedules", {
    repoPath,
  });

export const forgeBbPipelineScheduleCreate = (
  repoPath: string,
  refName: string,
  cronPattern: string,
  enabled: boolean,
) =>
  invoke<void>("forge_bb_pipeline_schedule_create", {
    repoPath,
    refName,
    cronPattern,
    enabled,
  });

export const forgeBbPipelineScheduleSetEnabled = (
  repoPath: string,
  uuid: string,
  enabled: boolean,
) =>
  invoke<void>("forge_bb_pipeline_schedule_set_enabled", {
    repoPath,
    uuid,
    enabled,
  });

export const forgeBbPipelineScheduleDelete = (repoPath: string, uuid: string) =>
  invoke<void>("forge_bb_pipeline_schedule_delete", { repoPath, uuid });

export const forgeBbHooks = (repoPath: string) =>
  invoke<BitbucketHook[]>("forge_bb_hooks", { repoPath });

export const forgeBbHookCreate = (
  repoPath: string,
  input: BitbucketHookInput,
) => invoke<void>("forge_bb_hook_create", { repoPath, input });

export const forgeBbHookUpdate = (
  repoPath: string,
  uuid: string,
  input: BitbucketHookInput,
) => invoke<void>("forge_bb_hook_update", { repoPath, uuid, input });

export const forgeBbHookDelete = (repoPath: string, uuid: string) =>
  invoke<void>("forge_bb_hook_delete", { repoPath, uuid });

// ── Bitbucket PR tasks + environments ────────────────────────────────────────

/** A PR's task checklist, in list order (Bitbucket-only — `implemented.prTasks`). */
export const forgeBbPrTasks = (repoPath: string, number: number) =>
  invoke<PrTask[]>("forge_bb_pr_tasks", { repoPath, number });

/** Create a PR task from free-text (empty text is rejected server-side). */
export const forgeBbPrTaskCreate = (
  repoPath: string,
  number: number,
  text: string,
) => invoke<PrTask>("forge_bb_pr_task_create", { repoPath, number, text });

/** Edit a PR task's text (`taskId` is the numeric server id as a String). */
export const forgeBbPrTaskEdit = (
  repoPath: string,
  number: number,
  taskId: string,
  text: string,
) =>
  invoke<PrTask>("forge_bb_pr_task_edit", { repoPath, number, taskId, text });

/** Resolve / unresolve a PR task. */
export const forgeBbPrTaskSetState = (
  repoPath: string,
  number: number,
  taskId: string,
  resolved: boolean,
) =>
  invoke<PrTask>("forge_bb_pr_task_set_state", {
    repoPath,
    number,
    taskId,
    resolved,
  });

/** Delete a PR task. */
export const forgeBbPrTaskDelete = (
  repoPath: string,
  number: number,
  taskId: string,
) => invoke<void>("forge_bb_pr_task_delete", { repoPath, number, taskId });

/** The repo's deployment environments, sorted by rank ascending (Bitbucket-only). */
export const forgeBbEnvironments = (repoPath: string) =>
  invoke<BbEnvironment[]>("forge_bb_environments", { repoPath });

/** The active gh token's OAuth scopes (for "needs gh auth refresh -s …" hints). */
export const ghTokenScopes = (host?: string) =>
  invoke<GhScopes>("gh_token_scopes", { host: host ?? null });

/** The real avatar URL for a GitHub bot account (dependabot, renovate, …), or
 *  `""` when it can't be resolved — bot logins have no `<host>/<login>.png`. */
export const ghBotAvatar = (login: string) =>
  invoke<string>("gh_bot_avatar", { login });

/** One commit-author `email → avatar_url` pairing from the commits API. */
export interface CommitAuthorAvatar {
  email: string;
  avatarUrl: string;
}

/** Batch-resolves commit-author `email → GitHub avatar URL` for one recent-commits page.
 *  GitHub-only, deliberately partial (one page), and never errors — empty repo / offline
 *  / non-GitHub resolves to `[]` so callers keep initials. */
export const ghCommitAuthorAvatars = (repoPath: string) =>
  invoke<CommitAuthorAvatar[]>("gh_commit_author_avatars", { repoPath });

export const ghHooksList = (repoPath: string) =>
  invoke<Webhook[]>("gh_hooks_list", { repoPath });

export const ghHookCreate = (repoPath: string, input: WebhookInput) =>
  invoke<Webhook>("gh_hook_create", { repoPath, input });

export const ghHookUpdate = (
  repoPath: string,
  id: number,
  input: WebhookInput,
) => invoke<Webhook>("gh_hook_update", { repoPath, id, input });

export const ghHookDelete = (repoPath: string, id: number) =>
  invoke<void>("gh_hook_delete", { repoPath, id });

export const ghHookPing = (repoPath: string, id: number) =>
  invoke<void>("gh_hook_ping", { repoPath, id });

export const ghHookTest = (repoPath: string, id: number) =>
  invoke<void>("gh_hook_test", { repoPath, id });

export const ghHookDeliveries = (repoPath: string, hookId: number) =>
  invoke<HookDelivery[]>("gh_hook_deliveries", { repoPath, hookId });

export const ghHookDelivery = (
  repoPath: string,
  hookId: number,
  deliveryId: string,
) =>
  invoke<HookDeliveryDetail>("gh_hook_delivery", {
    repoPath,
    hookId,
    deliveryId,
  });

export const ghHookRedeliver = (
  repoPath: string,
  hookId: number,
  deliveryId: string,
) => invoke<void>("gh_hook_redeliver", { repoPath, hookId, deliveryId });

export const ghRepoSettingsGet = (repoPath: string) =>
  invoke<RepoSettings>("gh_repo_settings_get", { repoPath });

export const ghRepoSettingsUpdate = (
  repoPath: string,
  input: RepoSettingsInput,
) => invoke<RepoSettings>("gh_repo_settings_update", { repoPath, input });

export const ghSecretsList = (
  repoPath: string,
  app: SecretApp,
  env: string | null,
) => invoke<GhSecret[]>("gh_secrets_list", { repoPath, app, env });

export const ghSecretSet = (
  repoPath: string,
  app: SecretApp,
  env: string | null,
  name: string,
  value: string,
) => invoke<void>("gh_secret_set", { repoPath, app, env, name, value });

export const ghSecretDelete = (
  repoPath: string,
  app: SecretApp,
  env: string | null,
  name: string,
) => invoke<void>("gh_secret_delete", { repoPath, app, env, name });

export const ghVariablesList = (repoPath: string, env: string | null) =>
  invoke<GhVariable[]>("gh_variables_list", { repoPath, env });

export const ghVariableSet = (
  repoPath: string,
  env: string | null,
  name: string,
  value: string,
) => invoke<void>("gh_variable_set", { repoPath, env, name, value });

export const ghVariableDelete = (
  repoPath: string,
  env: string | null,
  name: string,
) => invoke<void>("gh_variable_delete", { repoPath, env, name });

export const ghEnvironmentsList = (repoPath: string) =>
  invoke<string[]>("gh_environments_list", { repoPath });

export const ghCollaboratorsList = (repoPath: string) =>
  invoke<Collaborator[]>("gh_collaborators_list", { repoPath });

/** Returns true when GitHub created a pending invitation, false on an immediate grant. */
export const ghCollaboratorAdd = (
  repoPath: string,
  username: string,
  role: RepoRole,
) => invoke<boolean>("gh_collaborator_add", { repoPath, username, role });

export const ghCollaboratorRemove = (repoPath: string, username: string) =>
  invoke<void>("gh_collaborator_remove", { repoPath, username });

export const ghInvitationsList = (repoPath: string) =>
  invoke<Invitation[]>("gh_invitations_list", { repoPath });

export const ghInvitationUpdate = (
  repoPath: string,
  id: string,
  permission: RepoRole,
) => invoke<void>("gh_invitation_update", { repoPath, id, permission });

export const ghInvitationCancel = (repoPath: string, id: string) =>
  invoke<void>("gh_invitation_cancel", { repoPath, id });

export const ghSecurityGet = (repoPath: string) =>
  invoke<SecurityStatus>("gh_security_get", { repoPath });

export const ghSecurityApply = (
  repoPath: string,
  changes: { feature: SecurityFeature; enabled: boolean }[],
) => invoke<void>("gh_security_apply", { repoPath, changes });

// Lifecycle actions dispatch behind the abstraction — the parameter shapes are
// provider-neutral (GitLab's transfer takes a namespace path as `newOwner`).
export const forgeRepoSetVisibility = (repoPath: string, visibility: string) =>
  invoke<void>("forge_repo_set_visibility", { repoPath, visibility });

export const forgeRepoTransfer = (
  repoPath: string,
  newOwner: string,
  newName: string | null,
) => invoke<void>("forge_repo_transfer", { repoPath, newOwner, newName });

export const forgeRepoDelete = (repoPath: string) =>
  invoke<void>("forge_repo_delete", { repoPath });

export const forgeRepoSetArchived = (repoPath: string, archived: boolean) =>
  invoke<void>("forge_repo_set_archived", { repoPath, archived });

export const forgeRepoRename = (repoPath: string, newName: string) =>
  invoke<void>("forge_repo_rename", { repoPath, newName });

export const ghPagesGet = (repoPath: string) =>
  invoke<PagesInfo | null>("gh_pages_get", { repoPath });

export const ghPagesEnable = (
  repoPath: string,
  buildType: string,
  branch: string | null,
  path: string | null,
) => invoke<void>("gh_pages_enable", { repoPath, buildType, branch, path });

export const ghPagesUpdate = (
  repoPath: string,
  args: {
    buildType?: string;
    branch?: string;
    path?: string;
    cname?: string;
    httpsEnforced?: boolean;
  },
) =>
  invoke<void>("gh_pages_update", {
    repoPath,
    buildType: args.buildType ?? null,
    branch: args.branch ?? null,
    path: args.path ?? null,
    cname: args.cname ?? null,
    httpsEnforced: args.httpsEnforced ?? null,
  });

export const ghPagesDisable = (repoPath: string) =>
  invoke<void>("gh_pages_disable", { repoPath });

export const ghRulesetsList = (repoPath: string) =>
  invoke<RulesetSummary[]>("gh_rulesets_list", { repoPath });

export const ghRulesetGet = (repoPath: string, id: number) =>
  invoke<RulesetFull>("gh_ruleset_get", { repoPath, id });

/** The apps behind the repo's checks, read from the latest check runs on the
 *  default branch's head — GitHub publishes no id→name lookup for an app. Only
 *  apps that have reported there are named. GitHub only. */
export const ghCheckRunApps = (repoPath: string) =>
  invoke<CheckApp[]>("gh_check_run_apps", { repoPath });

/** What a branch's active rules require — check contexts and any approving-review
 *  count. Empty for a readable branch under no rules; a branch this token can't read —
 *  or a name the backend's ref gate refuses — rejects, which a caller showing a
 *  fallback may treat as empty. GitHub only. */
export const ghBranchRequiredChecks = (
  repoPath: string,
  branch: string,
  lens: RemoteLens,
) =>
  invoke<BranchRequiredRules>("gh_branch_required_checks", {
    repoPath,
    branch,
    lens,
  });

export const ghRulesetCreate = (
  repoPath: string,
  body: Record<string, unknown>,
) => invoke<void>("gh_ruleset_create", { repoPath, body });

export const ghRulesetUpdate = (
  repoPath: string,
  id: number,
  body: Record<string, unknown>,
) => invoke<void>("gh_ruleset_update", { repoPath, id, body });

export const ghRulesetDelete = (repoPath: string, id: number) =>
  invoke<void>("gh_ruleset_delete", { repoPath, id });

export const ghRulesetSetEnforcement = (
  repoPath: string,
  id: number,
  enforcement: RulesetEnforcement,
) => invoke<void>("gh_ruleset_set_enforcement", { repoPath, id, enforcement });

/** The repo's local `.github/dependabot.yml` text (null when absent). */
export const dependabotGet = (repoPath: string) =>
  invoke<string | null>("dependabot_get", { repoPath });

export const dependabotSet = (repoPath: string, content: string) =>
  invoke<void>("dependabot_set", { repoPath, content });

export const dependabotDelete = (repoPath: string) =>
  invoke<void>("dependabot_delete", { repoPath });

/** The repo's local `.github/FUNDING.yml` text (null when absent). */
export const fundingGet = (repoPath: string) =>
  invoke<string | null>("funding_get", { repoPath });

export const fundingSet = (repoPath: string, content: string) =>
  invoke<void>("funding_set", { repoPath, content });

export const fundingDelete = (repoPath: string) =>
  invoke<void>("funding_delete", { repoPath });

/** Edits a PR's title/body, and — when `base` is supplied — retargets it. An
 *  omitted `base` reaches the backend as `None` and leaves the base branch
 *  untouched, so an unchanged picker never sends a retarget the forge could
 *  reject (GitHub refuses to move a stacked PR's base). */
export const forgePrEdit = (
  repoPath: string,
  number: number,
  title: string,
  body: string,
  lens: RemoteLens,
  base?: string,
) =>
  invoke<void>("forge_pr_edit", {
    repoPath,
    number,
    title,
    body,
    lens,
    // Explicit null for "no retarget", the same wire shape every other optional
    // arg here uses — an `undefined` value is dropped by IPC serialization.
    base: base ?? null,
  });

/** Create a stack from `pullRequests` (bottom→top; the forge validates that each
 *  targets the one below it). */
export const forgeStackCreate = (
  repoPath: string,
  pullRequests: number[],
  lens: RemoteLens,
) =>
  invoke<StackWriteOutcome>("forge_stack_create", {
    repoPath,
    pullRequests,
    lens,
  });

/** Append `pullRequests` (bottom→top) to an existing stack. GitHub only appends
 *  on top, so the caller must have checked the attach point is the stack's top. */
export const forgeStackAdd = (
  repoPath: string,
  stackNumber: number,
  pullRequests: number[],
  lens: RemoteLens,
) =>
  invoke<StackWriteOutcome>("forge_stack_add", {
    repoPath,
    stackNumber,
    pullRequests,
    lens,
  });

/** Dissolve a stack: its members stay open on their branches, unstacked. */
export const forgeStackDissolve = (
  repoPath: string,
  stackNumber: number,
  lens: RemoteLens,
) => invoke<void>("forge_stack_dissolve", { repoPath, stackNumber, lens });

export const forgeRepoLabels = (repoPath: string, lens: RemoteLens) =>
  invoke<RepoLabel[]>("forge_repo_labels", { repoPath, lens });

/** GitHub's (classic) branch protection rules — read-only, for importing. */
export const ghBranchProtections = (repoPath: string) =>
  invoke<GhBranchProtection[]>("gh_branch_protections", { repoPath });

export const gitHooksList = (repoPath: string) =>
  invoke<HooksInfo>("git_hooks_list", { repoPath });

export const gitHookRead = (repoPath: string, name: string) =>
  invoke<string | null>("git_hook_read", { repoPath, name });

export const gitHookWrite = (repoPath: string, name: string, content: string) =>
  invoke<void>("git_hook_write", { repoPath, name, content });

export const gitHookSetEnabled = (
  repoPath: string,
  name: string,
  enabled: boolean,
) => invoke<void>("git_hook_set_enabled", { repoPath, name, enabled });

export const gitHookDelete = (repoPath: string, name: string) =>
  invoke<void>("git_hook_delete", { repoPath, name });

/** Runs a hook manager's CLI (pre-commit/lefthook); returns its output. */
export const gitRunHookManager = (
  repoPath: string,
  manager: string,
  action: "install" | "update",
) => invoke<string>("git_run_hook_manager", { repoPath, manager, action });

/** Add/remove labels on an issue or MR. GitHub keys them by GraphQL node id
 *  (`addIds`/`removeIds` on `labelableId`); GitLab keys them by name
 *  (`addNames`/`removeNames` on `number`). Callers pass both; the forge command
 *  takes whichever pair the repo's provider addresses by. `target` is "issue"|"mr". */
export const forgeEditLabels = (
  repoPath: string,
  target: "issue" | "mr",
  number: number,
  labelableId: string,
  addIds: string[],
  removeIds: string[],
  addNames: string[],
  removeNames: string[],
) =>
  invoke<void>("forge_edit_labels", {
    repoPath,
    target,
    number,
    labelableId,
    addIds,
    removeIds,
    addNames,
    removeNames,
  });

export const openWithProgram = (program: string, path: string) =>
  invoke<void>("open_with_program", { program, path });

export interface DetectedEditor {
  name: string;
  path: string;
}

export const detectEditors = () => invoke<DetectedEditor[]>("detect_editors");

export interface DetectedTerminal {
  /** Known kind id the launcher dispatches on, e.g. "powershell". */
  id: string;
  name: string;
  path: string;
}

export const detectTerminals = () =>
  invoke<DetectedTerminal[]>("detect_terminals");

export const readRepoInstructions = (repoPath: string) =>
  invoke<string | null>("read_repo_instructions", { repoPath });

export const readRepoAiIgnore = (repoPath: string) =>
  invoke<string[]>("read_repo_ai_ignore", { repoPath });

/** Appends AI-ignore patterns to `<repo>/.gitdesktop/aiignore` (created if
 *  absent), returning the number actually appended. Skipped only when already
 *  EFFECTIVE — a pattern sitting before a later `!` un-ignore line is re-added
 *  at the end, where last-match-wins puts it back in force. */
export const appendRepoAiIgnore = (repoPath: string, patterns: string[]) =>
  invoke<number>("append_repo_ai_ignore", { repoPath, patterns });

/** Deletes lines from `<repo>/.gitdesktop/aiignore`, matched as the matcher
 *  reads them (trimmed), returning the number actually removed. */
export const removeRepoAiIgnore = (repoPath: string, patterns: string[]) =>
  invoke<number>("remove_repo_ai_ignore", { repoPath, patterns });

/** Which of `paths` the user's AI-ignore patterns hide, decided by git's own
 *  gitignore engine — the same matcher the diff commands filter through. For
 *  path lists the frontend holds itself (a remote PR's changed files): the paths
 *  need not exist in the working tree or index. Returns `[]` when nothing
 *  matches, or when either list is empty. */
export const gitFilterAiIgnored = (
  repoPath: string,
  paths: string[],
  exclude: string[],
) => invoke<string[]>("git_filter_ai_ignored", { repoPath, paths, exclude });

/** Which rule decided each of `paths`, for the same matcher and `exclude` list
 *  {@link gitFilterAiIgnored} filters through — the verification surface behind
 *  the hiding. Every decided path is reported, negations included; paths no rule
 *  touches are absent. */
export const gitAiIgnoreVerdicts = (
  repoPath: string,
  paths: string[],
  exclude: string[],
) =>
  invoke<AiIgnoreVerdict[]>("git_ai_ignore_verdicts", {
    repoPath,
    paths,
    exclude,
  });

/** Raw contents of `<repo>/.gitdesktop/branch-rules.json`, or null if absent. */
export const readRepoBranchRules = (repoPath: string) =>
  invoke<string | null>("read_repo_branch_rules", { repoPath });

/** Writes `<repo>/.gitdesktop/branch-rules.json` (caller passes serialized JSON). */
export const writeRepoBranchRules = (repoPath: string, contents: string) =>
  invoke<void>("write_repo_branch_rules", { repoPath, contents });

/** Raw contents of `<repo>/.gitdesktop/syntax.json`, or null if absent. */
export const readRepoSyntax = (repoPath: string) =>
  invoke<string | null>("read_repo_syntax", { repoPath });

/** Writes `<repo>/.gitdesktop/syntax.json` (caller passes serialized JSON). */
export const writeRepoSyntax = (repoPath: string, contents: string) =>
  invoke<void>("write_repo_syntax", { repoPath, contents });

/** A slash-command or skill discovered for an agent (project or global). */
export interface AgentCommand {
  name: string;
  description: string;
  /** Command body (`$ARGUMENTS`/`$1..` expanded on use); empty for skills. */
  prompt: string;
  argumentHint: string;
  kind: "command" | "skill";
  scope: "project" | "global";
}

/** Slash-commands + skills available to `agent`, from the repo and the user's
 *  home, following each CLI's conventions + the canonical `.agents/skills`. */
export const readAgentCommands = (repoPath: string, agent: string) =>
  invoke<AgentCommand[]>("read_agent_commands", { repoPath, agent });

/** Reads a small text file the user picked (for importing a language config). */
export const readTextFile = (path: string) =>
  invoke<string>("read_text_file", { path });

/** Absolute path to the managed MCP launcher executable — ensures the
 *  update-safe copy exists (Windows) before returning. The command for the
 *  "use GitDesktop as an MCP server" config (`<launcher> mcp --repo <path>`). */
export const mcpLauncherPath = () => invoke<string>("mcp_launcher_path");

/** State of the `gitdesktop-mcp` command-line launcher (Settings → MCP servers).
 *  Windows puts the managed launcher's bin dir on the user PATH (migrating any
 *  older app-dir entry); macOS/Linux symlink `gitdesktop-mcp` into ~/.local/bin.
 *  See src-tauri/src/path_launcher.rs. */
export interface PathLauncherStatus {
  /** `gitdesktop-mcp` resolves in a newly-opened terminal (persisted PATH). */
  onPath: boolean;
  /** We installed it, so Remove can undo it (false when on PATH by other means). */
  managed: boolean;
  /** Install location for display (the PATH dir on Windows, symlink path on Unix). */
  target: string;
  /** Persistent caveat, e.g. Unix "~/.local/bin isn't on your PATH". */
  warning: string | null;
  /** One-shot success note from install/remove (shown as a toast, not persisted). */
  note: string | null;
}

export const pathLauncherStatus = () =>
  invoke<PathLauncherStatus>("path_launcher_status");

/** Add `gitdesktop` to PATH (append app dir / symlink), returning fresh status. */
export const pathLauncherInstall = () =>
  invoke<PathLauncherStatus>("path_launcher_install");

/** Reverse exactly what we added, returning fresh status. */
export const pathLauncherRemove = () =>
  invoke<PathLauncherStatus>("path_launcher_remove");

/** Merge the `gitdesktop` MCP entry into `<repo>/.mcp.json`, preserving any
 *  sibling servers. Returns whether it wrote and whether an entry already
 *  existed; with `overwrite:false` an existing entry is left untouched
 *  (`{ existed: true, written: false }`). */
export const mcpJsonWrite = (
  repoPath: string,
  entry: unknown,
  overwrite: boolean,
) =>
  invoke<{ written: boolean; existed: boolean }>("mcp_json_write", {
    repoPath,
    entry,
    overwrite,
  });

/** Install the `gitdesktop` MCP server into a client's GLOBAL (user-scope) config
 *  via that client's own CLI — `claude mcp add-json … -s user` /
 *  `copilot mcp add … -- <cmd>`. Mirrors mcpJsonWrite's existed/overwrite dance:
 *  `{ existed: true, written: false }` when an entry already exists and
 *  `overwrite` is false. See src-tauri/src/mcp.rs. */
export const mcpGlobalInstall = (
  client: "claude" | "copilot",
  command: string,
  args: string[],
  overwrite: boolean,
) =>
  invoke<{ written: boolean; existed: boolean }>("mcp_global_install", {
    client,
    command,
    args,
    overwrite,
  });

/** Whether a client's GLOBAL (user-scope) config has a `gitdesktop` server, and
 *  whether its configured command points at the CURRENT managed launcher. */
export interface McpGlobalClientStatus {
  /** A `gitdesktop` server exists in this client's user config. */
  installed: boolean;
  /** The configured command, or null when not installed (for display). */
  command: string | null;
  /** The configured command resolves to the current managed launcher
   *  (path-normalized) — false for an older install or a custom entry. */
  current: boolean;
  /** The installed entry's `args` (string elements only), so the UI can read
   *  WHICH permission tier is installed and nudge Reinstall when it drifts from
   *  the selected permissions. `null` when not installed, unreadable, or the
   *  entry predates this probe — never guessed. */
  args: string[] | null;
}

export interface McpGlobalStatus {
  claude: McpGlobalClientStatus;
  copilot: McpGlobalClientStatus;
}

/** Read-only probe of the global `gitdesktop` install state for both clients,
 *  by reading each client's config file directly (no CLI spawn). Never creates
 *  the managed launcher copy. See src-tauri/src/mcp.rs. */
export const mcpGlobalStatus = () =>
  invoke<McpGlobalStatus>("mcp_global_status");

/** Remove the `gitdesktop` server from a client's GLOBAL (user-scope) config via
 *  that client's own CLI. Errors carry actionable messages (e.g. CLI not found). */
export const mcpGlobalRemove = (client: "claude" | "copilot") =>
  invoke<null>("mcp_global_remove", { client });

// Cold-start test mode keeps API keys in an isolated sessionStorage store so
// the OS keychain (and the user's real keys) are never touched (no-op normally).
export const setSecret = (provider: string, value: string) =>
  COLD_START
    ? Promise.resolve(coldStartSetSecret(provider, value))
    : invoke<void>("set_secret", { provider, value });

export const getSecret = (provider: string) =>
  COLD_START
    ? Promise.resolve(coldStartGetSecret(provider))
    : invoke<string | null>("get_secret", { provider });

export const deleteSecret = (provider: string) =>
  COLD_START
    ? Promise.resolve(coldStartDeleteSecret(provider))
    : invoke<void>("delete_secret", { provider });

export const secretExists = (provider: string) =>
  COLD_START
    ? Promise.resolve(coldStartGetSecret(provider) !== null)
    : invoke<boolean>("secret_exists", { provider });

// MCP server secrets are keyed per registered server id + entry (env/header)
// name; in cold-start mode they reuse the isolated store via a combined key.
const mcpRef = (serverId: string, key: string) =>
  `mcp-server/${serverId}/${key}`;

export const setMcpSecret = (serverId: string, key: string, value: string) =>
  COLD_START
    ? Promise.resolve(coldStartSetSecret(mcpRef(serverId, key), value))
    : invoke<void>("set_mcp_secret", { serverId, key, value });

export const deleteMcpSecret = (serverId: string, key: string) =>
  COLD_START
    ? Promise.resolve(coldStartDeleteSecret(mcpRef(serverId, key)))
    : invoke<void>("delete_mcp_secret", { serverId, key });

export const mcpSecretExists = (serverId: string, key: string) =>
  COLD_START
    ? Promise.resolve(coldStartGetSecret(mcpRef(serverId, key)) !== null)
    : invoke<boolean>("mcp_secret_exists", { serverId, key });
