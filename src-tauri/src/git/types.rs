use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub root: String,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    Typechange,
    Conflicted,
    Untracked,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig_path: Option<String>,
    pub staged: Option<ChangeKind>,
    pub unstaged: Option<ChangeKind>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchHead {
    pub name: Option<String>,
    pub detached: bool,
    pub oid: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// The upstream is configured (`upstream` is `Some`) but its remote-tracking
    /// ref is gone (e.g. the branch was deleted on the remote after a PR merge).
    /// Consumers treat this like "no upstream" for decisions — Publish instead of
    /// Push/Pull, undo-commit allowed, no force-push demanded on amend.
    pub upstream_gone: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub branch: BranchHead,
    pub entries: Vec<FileEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub is_current: bool,
    pub upstream: Option<String>,
    /// ISO-8601 committer date of the branch tip (for recency sorting).
    pub last_commit_date: String,
    /// Hidden from the branch dropdown (a personal, local-config flag).
    pub archived: bool,
    /// Commits on this branch that its own upstream doesn't have.
    pub upstream_ahead: u32,
    /// Commits on this branch's upstream that it doesn't have (drives
    /// "Update from origin/x" only when there's something to bring down).
    pub upstream_behind: u32,
    /// The upstream is configured (`upstream` is `Some`) but its remote-tracking
    /// ref is gone (e.g. the remote branch was deleted after a PR merge). Read as
    /// "no upstream" for pushed-ness decisions.
    pub upstream_gone: bool,
    /// The remote of the branch's upstream (`%(upstream:remotename)`), e.g.
    /// `origin` — null when untracked. Authoritative source for which remote a
    /// push targets; the UI must never re-derive it from the upstream string.
    pub upstream_remote: Option<String>,
}

/// A branch that exists on a remote but not (yet) as a local branch — offered in
/// the switcher so it can be checked out (which creates a local tracking branch).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBranch {
    /// The short branch name, without the remote prefix (e.g. `feature/x`).
    pub name: String,
    /// The remote it lives on (e.g. `origin`).
    pub remote: String,
    /// ISO-8601 committer date of the branch tip (for recency sorting).
    pub last_commit_date: String,
}

/// How far a local branch sits from a base branch (the default branch), for
/// the at-a-glance counts in the branch menu.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchDivergence {
    pub name: String,
    /// Commits on `name` that the base doesn't have.
    pub ahead: u32,
    /// Commits on the base that `name` doesn't have.
    pub behind: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub file_path: String,
    pub is_binary: bool,
    pub is_truncated: bool,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffStatEntry {
    pub path: String,
    pub added: u32,
    pub deleted: u32,
    pub is_binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedDiff {
    pub text: String,
    pub truncated: bool,
    pub files: Vec<DiffStatEntry>,
    /// Changed files hidden from the AI context by ignore patterns.
    pub excluded_files: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    pub hash: String,
    pub subject: String,
    pub author: String,
    /// Author email (%ae). Drives the History-tab commit avatar (GitHub
    /// no-reply login or Gravatar); empty when git records no author email.
    pub author_email: String,
    pub date: String,
    /// Tags pointing at this commit (from %D decorations).
    pub tags: Vec<String>,
    /// More than one parent — history rewriting must not cross it.
    pub is_merge: bool,
}

/// One git tag, for the Tags list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    pub name: String,
    /// The commit the tag points to (dereferenced for annotated tags).
    pub target: String,
    /// ISO date the tag was created (annotated) or the commit's date.
    pub date: String,
    /// Annotated tag (has its own object + message) vs a lightweight ref.
    pub annotated: bool,
    /// Tag annotation subject (annotated) or the commit subject (lightweight).
    pub subject: String,
}

/// One line of `git blame` output: the line's content plus the commit that
/// last touched it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub line_no: u32,
    pub hash: String,
    pub author: String,
    /// Author time as epoch seconds; the frontend formats it.
    pub time: i64,
    pub summary: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub hash: String,
    pub subject: String,
    pub body: String,
    pub author: String,
    pub author_email: String,
    pub date: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitAuthor {
    pub name: String,
    pub email: String,
}

/// One resulting commit in a history rewrite: a single hash is a plain
/// pick; several hashes squash into one commit carrying `message`. `edit`
/// flags the commit to pause at (only the interactive-rebase path honors it;
/// the atomic replay engine ignores it).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewriteStep {
    pub hashes: Vec<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub edit: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub index: u32,
    pub message: String,
    pub date: String,
}

/// A git submodule and its working-state vs. the recorded commit.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Submodule {
    pub path: String,
    pub sha: String,
    /// `git describe` of the checked-out commit, when available.
    pub describe: String,
    /// "ok" | "uninitialized" | "modified" | "conflict".
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoOpState {
    pub merging: bool,
    pub rebasing: bool,
    pub cherry_picking: bool,
    pub reverting: bool,
    /// An interactive rebase is paused at an `edit` (vs a conflict) — the user
    /// should amend the commit, then continue.
    pub edit_paused: bool,
}

impl RepoOpState {
    /// Whether a multi-step operation is mid-flight — the single home of the flag
    /// list, so a gate can't drift by re-listing the fields and missing one.
    /// `edit_paused` is excluded: it qualifies `rebasing` rather than standing on
    /// its own.
    pub fn mid_op(&self) -> bool {
        self.merging || self.rebasing || self.cherry_picking || self.reverting
    }
}
