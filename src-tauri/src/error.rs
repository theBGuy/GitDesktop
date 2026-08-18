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
            AppError::Conflict { op, paths, report } => {
                map.serialize_entry("op", op)?;
                map.serialize_entry("paths", paths)?;
                map.serialize_entry("report", report)?;
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

    /// A payload-free variant carries kind + message and nothing else.
    #[test]
    fn a_plain_variant_carries_no_payload_keys() {
        assert_eq!(
            serde_json::to_string(&AppError::GitNotFound).unwrap(),
            r#"{"kind":"gitNotFound","message":"git executable not found"}"#
        );
    }
}
