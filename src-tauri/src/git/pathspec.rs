//! Concrete paths handed to git as pathspecs.
//!
//! Every command here takes paths the USER picked from a list, never a pattern
//! they typed, so each one must match itself and nothing else. Commands whose
//! callers may legitimately pass a glob — `git_untrack`'s `*.log` form, and the
//! MCP `stage_files` tool, whose description promises pathspec support — are
//! deliberately NOT routed through this; they discriminate at the call site.

/// A concrete path as a pathspec that matches only itself.
///
/// Pathspecs glob, and git tries a literal match FIRST, so a raw path is not
/// safe merely because it names a real file: with a sibling `src/app/s/page.tsx`
/// present, `git restore -- src/app/[slug]/page.tsx` discards BOTH files'
/// uncommitted changes (measured, git 2.51.1). `:(literal)` turns globbing off
/// for the term. Escaping the metacharacters instead does not work here — the
/// escaped form of a directory matches nothing at all.
/// An empty path stays empty: a bare `:(literal)` matches EVERYTHING, and the
/// callers' `!is_empty()` guards would wave it through.
pub(crate) fn literal(path: &str) -> String {
    if path.is_empty() {
        return String::new();
    }
    format!(":(literal){path}")
}
