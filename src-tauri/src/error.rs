use serde::ser::{SerializeMap, Serializer};
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{}", git_message(*code, stderr))]
    Git { code: i32, stderr: String },
    /// A git operation stopped on merge conflicts and left the repo mid-op for
    /// the user to resolve. `report` is the full both-stream text; `paths` the
    /// unmerged files at classification time.
    #[error("{}", conflict_message(op, report))]
    Conflict {
        op: String,
        paths: Vec<String>,
        report: String,
    },
    /// A rebase-mode pull was refused because git's own fork-point verdict would
    /// have rewritten commits away with no conflict and no warning. Every SHA the
    /// decision needs rides along, so the follow-up rebase pins them rather than
    /// re-resolving refs the app's auto-fetch can move. Boxed: eight inline fields
    /// would push every `AppResult` in the crate past clippy's `result_large_err`.
    #[error("{}", .0.message)]
    PullRebaseWouldDrop(Box<crate::git::pull_guard::WouldDrop>),
    /// A bounded wait for one of a repo's locks expired. `holder` names what was
    /// running in the user's terms ("a worktree removal"), never the lock itself.
    #[error("{}", busy_message(holder))]
    Busy { holder: String },
    #[error("not a git repository: {0}")]
    NotARepo(String),
    #[error("git executable not found")]
    GitNotFound,
    #[error("GitHub CLI (gh) not found")]
    GhNotFound,
    #[error("{0}")]
    Gh(String),
    #[error("This repository has issues disabled.")]
    IssuesDisabled,
    #[error("GitLab CLI (glab) not found")]
    GlabNotFound,
    #[error("{0}")]
    Glab(String),
    #[error("{0}")]
    Bitbucket(String),
    #[error("No Bitbucket account is connected. Add your Atlassian API token in Settings → Accounts.")]
    BitbucketNotConfigured,
    #[error("{0}")]
    Jira(String),
    #[error("keychain error: {0}")]
    Keyring(String),
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    #[error("{0}")]
    Command(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("git operation timed out after {0}s")]
    Timeout(u64),
}

fn git_message(code: i32, stderr: &str) -> String {
    let trimmed = stderr.trim();
    if trimmed.is_empty() {
        format!("git exited with code {code}")
    } else {
        trimmed.to_string()
    }
}

/// One complete sentence, because the frontend takes line 1 verbatim as the toast
/// title (`firstMeaningfulLine`, `src/lib/error-summary.ts`). An empty holder falls
/// back to the generic phrasing rather than emitting a headless sentence.
fn busy_message(holder: &str) -> String {
    let mut chars = holder.chars();
    let Some(first) = chars.next() else {
        return "Another Git operation is still running — try again when it finishes."
            .to_string();
    };
    format!(
        "{}{} is still running — try again when it finishes.",
        first.to_uppercase(),
        chars.as_str()
    )
}

/// The frontend renders a conflict from `op`/`report`, so this is what the
/// non-presenting readers get: `Display` feeds `to_string()` embeds (the oplog
/// entry, the compound funnels' wrapped messages). A report can only be empty if
/// git wrote to neither stream, which still has to say something.
fn conflict_message(op: &str, report: &str) -> String {
    let trimmed = report.trim();
    if trimmed.is_empty() {
        format!("{op} stopped on merge conflicts")
    } else {
        trimmed.to_string()
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let kind = match self {
            AppError::Git { .. } => "git",
            // Stable serialized kind — `presentError` branches on it BEFORE the
            // prose markers to name the paused operation from `op`.
            AppError::Conflict { .. } => "conflict",
            // Stable serialized kind — the frontend branches on it to open the
            // keep-or-drop decision instead of presenting an error.
            AppError::PullRebaseWouldDrop(_) => "pullRebaseWouldDrop",
            AppError::Busy { .. } => "busy",
            AppError::NotARepo(_) => "notARepo",
            AppError::GitNotFound => "gitNotFound",
            AppError::GhNotFound => "ghNotFound",
            AppError::Gh(_) => "gh",
            // Stable serialized kind — the frontend branches on this exact string
            // to render the "issues are disabled" notice (no retry).
            AppError::IssuesDisabled => "issuesDisabled",
            AppError::GlabNotFound => "glabNotFound",
            AppError::Glab(_) => "glab",
            AppError::Bitbucket(_) => "bitbucket",
            AppError::BitbucketNotConfigured => "bitbucketNotConfigured",
            AppError::Jira(_) => "jira",
            AppError::Keyring(_) => "keyring",
            AppError::InvalidArgument(_) => "invalidArgument",
            AppError::Command(_) => "command",
            AppError::Io(_) => "io",
            AppError::Timeout(_) => "timeout",
        };
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("kind", kind)?;
        map.serialize_entry("message", &self.to_string())?;
        match self {
            AppError::Git { code, stderr } => {
                map.serialize_entry("code", code)?;
                map.serialize_entry("stderr", stderr)?;
            }
            AppError::Busy { holder } => {
                map.serialize_entry("holder", holder)?;
            }
            AppError::Conflict { op, paths, report } => {
                map.serialize_entry("op", op)?;
                map.serialize_entry("paths", paths)?;
                map.serialize_entry("report", report)?;
            }
            // Hand-written so every key's casing is explicit: `rename_all` does
            // not cover fields, and the decision UI reads by name each of the
            // seven keys this arm adds.
            AppError::PullRebaseWouldDrop(d) => {
                map.serialize_entry("branch", &d.branch)?;
                map.serialize_entry("upstream", &d.upstream)?;
                map.serialize_entry("branchTip", &d.branch_tip)?;
                map.serialize_entry("newTip", &d.new_tip)?;
                map.serialize_entry("mergeBase", &d.merge_base)?;
                map.serialize_entry("forkPoint", &d.fork_point)?;
                map.serialize_entry("commits", &d.commits)?;
            }
            _ => {}
        }
        map.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::AppError;

    /// The frontend reads these exact keys off a conflict error. Every one is a
    /// single word, so no casing convention can rescue a rename — pinned byte-for
    /// -byte, mirroring `AutostashOutcome`'s wire-shape pin.
    #[test]
    fn conflict_serializes_to_the_pinned_wire_shape() {
        let err = AppError::Conflict {
            op: "merge".to_string(),
            paths: vec!["a.txt".to_string(), "dir/b.txt".to_string()],
            report: "CONFLICT (content): Merge conflict in a.txt".to_string(),
        };
        assert_eq!(
            serde_json::to_string(&err).unwrap(),
            r#"{"kind":"conflict","message":"CONFLICT (content): Merge conflict in a.txt","op":"merge","paths":["a.txt","dir/b.txt"],"report":"CONFLICT (content): Merge conflict in a.txt"}"#
        );
    }

    /// `Git`'s payload arm is the one this variant was modeled on — it must keep
    /// its own shape now that the two share a `match`.
    #[test]
    fn git_still_serializes_to_its_own_wire_shape() {
        let err = AppError::Git {
            code: 1,
            stderr: "boom".to_string(),
        };
        assert_eq!(
            serde_json::to_string(&err).unwrap(),
            r#"{"kind":"git","message":"boom","code":1,"stderr":"boom"}"#
        );
    }

    /// The decision UI reads all nine keys off this error and hands the branch and
    /// four SHAs straight back to `git_pull_rebase_decided`, so a casing slip here
    /// silently loses the commits the user was asked about. Pinned for one and
    /// for two commits — the plural arm is what a multi-commit rewrite produces.
    #[test]
    fn pull_rebase_would_drop_serializes_to_the_pinned_wire_shape() {
        use crate::git::pull_guard::{DroppedCommit, WouldDrop};

        let victim = DroppedCommit {
            sha: "1111111111111111111111111111111111111111".to_string(),
            subject: "V the victim".to_string(),
            author: "Ada".to_string(),
            author_date: "2026-08-28T23:37:38-04:00".to_string(),
        };
        let second = DroppedCommit {
            sha: "2222222222222222222222222222222222222222".to_string(),
            subject: "also doomed".to_string(),
            author: "Bob".to_string(),
            author_date: "2026-08-27T10:00:00+00:00".to_string(),
        };
        let err = |commits: Vec<DroppedCommit>, message: &str| {
            AppError::PullRebaseWouldDrop(Box::new(WouldDrop {
                message: message.to_string(),
                branch: "main".to_string(),
                upstream: "origin/main".to_string(),
                branch_tip: "1111111111111111111111111111111111111111".to_string(),
                new_tip: "3333333333333333333333333333333333333333".to_string(),
                merge_base: "4444444444444444444444444444444444444444".to_string(),
                fork_point: "1111111111111111111111111111111111111111".to_string(),
                commits,
            }))
        };

        assert_eq!(
            serde_json::to_string(&err(
                vec![victim.clone()],
                "Pulling with rebase would drop 1 commit that origin/main no longer contains."
            ))
            .unwrap(),
            r#"{"kind":"pullRebaseWouldDrop","message":"Pulling with rebase would drop 1 commit that origin/main no longer contains.","branch":"main","upstream":"origin/main","branchTip":"1111111111111111111111111111111111111111","newTip":"3333333333333333333333333333333333333333","mergeBase":"4444444444444444444444444444444444444444","forkPoint":"1111111111111111111111111111111111111111","commits":[{"sha":"1111111111111111111111111111111111111111","subject":"V the victim","author":"Ada","authorDate":"2026-08-28T23:37:38-04:00"}]}"#
        );
        assert_eq!(
            serde_json::to_string(&err(
                vec![victim, second],
                "Pulling with rebase would drop 2 commits that origin/main no longer contains."
            ))
            .unwrap(),
            r#"{"kind":"pullRebaseWouldDrop","message":"Pulling with rebase would drop 2 commits that origin/main no longer contains.","branch":"main","upstream":"origin/main","branchTip":"1111111111111111111111111111111111111111","newTip":"3333333333333333333333333333333333333333","mergeBase":"4444444444444444444444444444444444444444","forkPoint":"1111111111111111111111111111111111111111","commits":[{"sha":"1111111111111111111111111111111111111111","subject":"V the victim","author":"Ada","authorDate":"2026-08-28T23:37:38-04:00"},{"sha":"2222222222222222222222222222222222222222","subject":"also doomed","author":"Bob","authorDate":"2026-08-27T10:00:00+00:00"}]}"#
        );
    }

    /// The frontend renders line 1 of `message` as the toast title, so the whole
    /// sentence is the contract — not just the `holder` key beside it.
    #[test]
    fn busy_serializes_to_the_pinned_wire_shape() {
        let err = AppError::Busy {
            holder: "a worktree removal".to_string(),
        };
        assert_eq!(
            serde_json::to_string(&err).unwrap(),
            r#"{"kind":"busy","message":"A worktree removal is still running — try again when it finishes.","holder":"a worktree removal"}"#
        );
    }

    /// A payload-free variant carries kind + message and nothing else.
    #[test]
    fn a_plain_variant_carries_no_payload_keys() {
        assert_eq!(
            serde_json::to_string(&AppError::GitNotFound).unwrap(),
            r#"{"kind":"gitNotFound","message":"git executable not found"}"#
        );
    }
}
