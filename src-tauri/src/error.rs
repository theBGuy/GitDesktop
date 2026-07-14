use serde::ser::{SerializeMap, Serializer};
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{}", git_message(*code, stderr))]
    Git { code: i32, stderr: String },
    #[error("not a git repository: {0}")]
    NotARepo(String),
    #[error("git executable not found")]
    GitNotFound,
    #[error("GitHub CLI (gh) not found")]
    GhNotFound,
    #[error("{0}")]
    Gh(String),
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

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let kind = match self {
            AppError::Git { .. } => "git",
            AppError::NotARepo(_) => "notARepo",
            AppError::GitNotFound => "gitNotFound",
            AppError::GhNotFound => "ghNotFound",
            AppError::Gh(_) => "gh",
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
        if let AppError::Git { code, stderr } = self {
            map.serialize_entry("code", code)?;
            map.serialize_entry("stderr", stderr)?;
        }
        map.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;
