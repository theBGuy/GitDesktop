use super::*;

/// The shared guard against refspec/argv injection from a user-named ref: every
/// ref-reaching name routes through here or through `validate_tag_name`. Rev
/// syntax (`~ ^ @ { }`) is deliberately accepted, for branch start-points.
pub(crate) fn validate_ref_name(name: &str) -> AppResult<()> {
    if name.is_empty() || name.starts_with('-') {
        return Err(AppError::InvalidArgument(format!(
            "invalid branch name: {name}"
        )));
    }
    // Reject glob/refspec metacharacters. A ref name is interpolated into
    // `for-each-ref refs/heads/<name>` (where `* ? [` glob) and, on the push
    // path, into a push refspec `refs/heads/<name>:refs/heads/<name>` (where `*`
    // is a wildcard and `:` a separator) — so an unfiltered `*` would glob-match
    // and mirror-push every branch. These characters are never valid in a real
    // git ref name. `~ ^ @ { }` are deliberately NOT rejected: this validator is
    // also used for rev-expression start points (e.g. `main~3`, `HEAD@{2}`).
    if name
        .chars()
        .any(|c| matches!(c, '*' | '?' | '[' | ':' | '\\' | ' ') || c.is_ascii_control())
    {
        return Err(AppError::InvalidArgument(format!(
            "invalid branch name: {name}"
        )));
    }
    Ok(())
}

/// The stricter gate for inputs that must name a BRANCH and nothing else: it adds
/// a rejection of rev-expression syntax, which `rev-parse` would otherwise resolve
/// (`feature~1` exists under `refs/heads/` as the branch's parent commit), and of
/// bare `@`, git's HEAD shorthand in the rev positions these names reach.
pub(crate) fn validate_branch_name(name: &str) -> AppResult<()> {
    validate_ref_name(name)?;
    if name == "@" || name.contains(['~', '^']) || name.contains("..") || name.contains("@{") {
        return Err(AppError::InvalidArgument(format!(
            "invalid branch name: {name}"
        )));
    }
    Ok(())
}

/// Agent-session prefix; [`refuse_session_branch_name`] guards case-insensitively, and
/// `mcp_server::write_git::ensure_not_session_branch` delegates to it, so the MCP tools
/// refuse with the same text.
pub(crate) const SESSION_BRANCH_PREFIX: &str = "gd/session/";

pub(crate) fn is_session_branch_name(name: &str) -> bool {
    name.to_ascii_lowercase().starts_with(SESSION_BRANCH_PREFIX)
}

/// Refuse names whose branches or worktrees would vanish from every filtered surface.
pub(crate) fn refuse_session_branch_name(name: &str) -> AppResult<()> {
    if is_session_branch_name(name) {
        return Err(AppError::InvalidArgument(format!(
            "\"{name}\" is in gd/session/, which is reserved for agent sessions — choose another name."
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_ref_name_rejects_glob_and_refspec_metacharacters() {
        // `*` would otherwise glob-match via `for-each-ref refs/heads/*` and
        // mirror-push every branch through a wildcard push refspec.
        for bad in ["*", "feat*", "a?b", "a[b", "a:b", "a\\b", "a b", "x\u{7f}"] {
            assert!(validate_ref_name(bad).is_err(), "should reject {bad:?}");
        }
        assert!(validate_ref_name("").is_err());
        assert!(validate_ref_name("-x").is_err());
    }

    #[test]
    fn validate_ref_name_accepts_names_and_rev_start_points() {
        // Real branch names AND rev-expression start points (this validator guards
        // git_create_branch's start_point too) must keep passing.
        for ok in [
            "feature", "feat/x", "origin/feat", "release-1.0",
            "main~3", "HEAD", "HEAD@{2}", "abc123def",
        ] {
            assert!(validate_ref_name(ok).is_ok(), "should accept {ok:?}");
        }
    }

    #[test]
    fn validate_branch_name_rejects_rev_expressions_ref_name_accepts() {
        // The whole point of the stricter gate: `~`/`^` shapes RESOLVE under
        // `rev-parse --verify refs/heads/…`, so an existence probe alone passes
        // them and the caller proceeds against an ancestor commit.
        // `@{-N}` is the Nth previous branch, which git expands into the name it mints.
        let bad_names = [
            "feature~1",
            "main^",
            "HEAD@{1}",
            "main..other",
            "a^{commit}",
            "@",
            "@{-1}",
            "@{-2}",
        ];
        for bad in bad_names {
            assert!(validate_ref_name(bad).is_ok(), "ref gate accepts {bad:?}");
            assert!(
                validate_branch_name(bad).is_err(),
                "branch gate should reject {bad:?}"
            );
        }
        // Refspec metacharacters stay rejected, and real branch names stay valid.
        assert!(validate_branch_name("a*b").is_err());
        for ok in ["feature", "feat/x", "release-1.0", "fix_123"] {
            assert!(validate_branch_name(ok).is_ok(), "should accept {ok:?}");
        }
    }

    #[test]
    fn session_branch_name_truth_table() {
        for name in ["gd/session/x", "GD/Session/x", "gd/SESSION/x", "Gd/session/"] {
            assert!(super::is_session_branch_name(name), "{name}");
            let err = super::refuse_session_branch_name(name).unwrap_err();
            assert!(
                matches!(err, AppError::InvalidArgument(message) if message == format!(
                    "\"{name}\" is in gd/session/, which is reserved for agent sessions — choose another name."
                ))
            );
        }
        for name in ["gd/sessions/x", "wip/gd/session/x", "feature/x", "gd/session"] {
            assert!(!super::is_session_branch_name(name), "{name}");
            assert!(super::refuse_session_branch_name(name).is_ok(), "{name}");
        }
    }
}
