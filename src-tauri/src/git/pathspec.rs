//! Concrete paths handed to git as pathspecs.
//!
//! Every command here takes paths the USER picked from a list, never a pattern
//! they typed, so each one must match itself and nothing else.
//!
//! Deliberately NOT routed through this, because a caller may legitimately pass
//! a glob: `git_untrack` and `git_force_add` (the "untrack all `*.log`" menu
//! form; call sites literalize — `ChangesContextMenu.tsx:239,258`,
//! `RepositoryFilesDialog.tsx:187,207`), and the `git_stage_core` /
//! `git_unstage_core` cores (`ChangesPanel.tsx:412,471,486,546`).
//!
//! The MCP write tools do NOT belong on that list: they literalize at the tool
//! boundary in `mcp_server::write_git::literal_pathspecs`, with `literal: false`
//! as the deliberate-glob escape hatch. See that helper for the tools it covers
//! and why `discard_changes` is the exception.
//!
//! Keep this list true — it reads as the authoritative "stays raw" set.

/// A concrete path as a pathspec that matches only itself.
///
/// Pathspecs glob, and git tries a literal match FIRST, so a raw path is not
/// safe merely because it names a real file: with a sibling `src/app/s/page.tsx`
/// present, `git restore -- src/app/[slug]/page.tsx` discards BOTH files'
/// uncommitted changes (measured, git 2.51.1). `:(literal)` turns globbing off
/// for the term. Escaping the metacharacters instead does not work here — the
/// escaped form of a directory matches nothing at all.
///
/// An empty path stays empty: a bare `:(literal)` matches EVERYTHING, and the
/// callers' `!is_empty()` guards would wave it through.
pub(crate) fn literal(path: &str) -> String {
    if path.is_empty() {
        return String::new();
    }
    format!(":(literal){path}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_stays_empty_and_metacharacters_are_disarmed() {
        // A bare `:(literal)` would match the whole repo past an is_empty guard.
        assert_eq!(literal(""), "");
        assert_eq!(literal("a[b]"), ":(literal)a[b]");
    }
}
