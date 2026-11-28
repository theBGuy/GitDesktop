use super::*;

/// Position of `%(push)` among the push-destination atoms.
pub(super) const PUSH_TRACKING_ATOM_INDEX: usize = 2;

/// Where a bare push of `local` lands, off the first line of a HEAD tracking read
/// ([`UPSTREAM_TRACKING_FORMAT`]'s fields, then the push atoms): None/None when the
/// line is missing (an unborn HEAD), names another ref, or carries no atoms. Out of
/// reach: an upstream remote with no fetch refspec leaves `%(upstream)` and `%(push)`
/// empty while push.default=upstream still pushes to `branch.<b>.merge` (git 2.51.1).
pub(super) fn bare_push_destination(
    text: &str,
    refname: &str,
    local: &str,
) -> (Option<String>, Option<String>) {
    let Some(line) = tracking_line(text, refname) else {
        return (None, None);
    };
    crate::git::branches::push_destination_fields(
        local,
        line.atoms(),
        line.upstream_remote(),
        line.upstream_remoteref(),
    )
}

/// The local branch a bare push would update in this repository, off the same line as
/// [`bare_push_destination`]: a BRANCH upstream whose push remote (`%(push:remotename)`)
/// is `.`. A line read without the atoms falls back to the upstream's own remote, so an
/// old git refuses rather than guesses; non-branch and untracked upstreams never answer.
pub(super) fn bare_push_local_upstream(text: &str, refname: &str) -> Option<String> {
    let (Upstream::Branch(up), remotename, _) = parse_upstream_tracking(text, refname)? else {
        return None;
    };
    let push_remote = tracking_line(text, refname)?
        .push_remotename()
        .unwrap_or(&remotename);
    (push_remote == ".").then_some(up)
}

/// Whether `%(upstream:remotename)` names a real remote: empty is untracked, and `.`
/// is a local upstream (measured, git 2.51.1), neither of which has a remote to push to.
pub(crate) fn is_named_remote(remotename: &str) -> bool {
    !remotename.is_empty() && remotename != "."
}

/// The `for-each-ref` format [`parse_upstream_tracking`] reads. The upstream rides
/// `%(upstream:remoteref)` (`branch.<b>.merge`, the branch's name ON the remote),
/// never `%(upstream:short)`: the short form disambiguates against local refs, so a
/// tag named `origin/<x>` turns it into `remotes/origin/<x>`, which the push would
/// then create as a new remote branch. The remote-side name also needs no knowledge
/// of the remote's fetch-refspec layout, and covers a local (`.`) upstream.
pub(crate) const UPSTREAM_TRACKING_FORMAT: &str =
    "--format=%(refname)%00%(upstream:remoteref)%00%(upstream:remotename)%00%(upstream:track)";

/// How many fields [`UPSTREAM_TRACKING_FORMAT`] writes, so the push atoms a read appends
/// start at this index.
pub(crate) const UPSTREAM_TRACKING_FIELDS: usize = 4;

/// The first line of a tracking read split once: [`UPSTREAM_TRACKING_FORMAT`]'s fields,
/// then the push-destination atoms (none when the read fell back without them).
pub(in crate::git) struct TrackingLine<'a> {
    fields: Vec<&'a str>,
}

/// Position of `%(push:remotename)` among the push-destination atoms; the whole atom
/// order is pinned against git by `tracking_line_reads_each_push_atom_by_name`.
const PUSH_REMOTENAME_ATOM_INDEX: usize = 0;

/// None when there is no line or it names another ref (for-each-ref matches a prefix).
pub(in crate::git) fn tracking_line<'a>(text: &'a str, refname: &str) -> Option<TrackingLine<'a>> {
    let fields: Vec<&str> = text.lines().next()?.split('\0').collect();
    (fields.first() == Some(&refname)).then_some(TrackingLine { fields })
}

impl<'a> TrackingLine<'a> {
    /// `%(upstream:remoteref)`, empty when untracked.
    pub(in crate::git) fn upstream_remoteref(&self) -> &'a str {
        self.fields.get(1).copied().unwrap_or("")
    }

    /// `%(upstream:remotename)`, empty when untracked.
    pub(in crate::git) fn upstream_remote(&self) -> &'a str {
        self.fields.get(2).copied().unwrap_or("")
    }

    /// The push-destination atoms, in `PUSH_DESTINATION_ATOMS` order.
    pub(in crate::git) fn atoms(&self) -> &[&'a str] {
        self.fields.get(UPSTREAM_TRACKING_FIELDS..).unwrap_or(&[])
    }

    /// None when the line carries no atoms; `Some("")` when the atom is empty.
    pub(in crate::git) fn push_remotename(&self) -> Option<&'a str> {
        self.atoms().get(PUSH_REMOTENAME_ATOM_INDEX).copied()
    }

    /// `%(upstream)`, the upstream's full tracking ref; None when the line carries no atoms.
    pub(in crate::git) fn upstream_atom(&self) -> Option<&'a str> {
        self.atoms().get(UPSTREAM_ATOM_INDEX).copied()
    }
}

/// What a local branch tracks, as `push::build_push_args` needs it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Upstream {
    /// No upstream configured.
    Untracked,
    /// A branch on the upstream remote, by its name there.
    Branch(String),
    /// A ref that is no branch (`refs/pull/<n>/head`, `refs/tags/<x>`): nothing to
    /// push INTO, and nothing a push may retrack away from.
    NotABranch,
}

/// Parse one [`UPSTREAM_TRACKING_FORMAT`] line into `(upstream, remotename, gone)`,
/// but ONLY when its `%(refname)` equals `expected_ref`. `for-each-ref` matches a
/// pattern as a prefix up to a slash (`refs/heads/feat` also matches
/// `refs/heads/feat/sub`), so the exact refname check is what enforces "no such
/// branch" for a non-exact name. Returns `None` when there is no line, or the first
/// line's refname isn't `expected_ref`. An *untracked* branch still emits
/// `refs/heads/<b>\0\0\0`, which (refname matches) parses to
/// `Some((Upstream::Untracked, "", false))`.
pub(crate) fn parse_upstream_tracking(
    stdout: &str,
    expected_ref: &str,
) -> Option<(Upstream, String, bool)> {
    let line = stdout.lines().next()?;
    let mut parts = line.split('\0');
    let refname = parts.next().unwrap_or("");
    if refname != expected_ref {
        return None;
    }
    let upstream = upstream_from_remoteref(parts.next().unwrap_or(""));
    let remotename = parts.next().unwrap_or("").to_string();
    let track = parts.next().unwrap_or("");
    // Mirror branches/listing.rs's gone detection: `[gone]` in %(upstream:track).
    Some((upstream, remotename, track.contains("[gone]")))
}

/// An `%(upstream:remoteref)` value as an [`Upstream`]. Three shapes of
/// `branch.<b>.merge`: `refs/heads/<x>` is branch `<x>`; any other `refs/` ref
/// (`refs/pull/<n>/head` from a pull fetch refspec) is NOT a branch, pushed under the
/// local name with its tracking config left alone; a bare name (hand-edited config,
/// which git DWIMs) is the branch name itself. Empty is untracked.
pub(crate) fn upstream_from_remoteref(remoteref: &str) -> Upstream {
    match remoteref {
        "" => Upstream::Untracked,
        remoteref => match remoteref.strip_prefix("refs/heads/") {
            Some(name) => Upstream::Branch(name.to_string()),
            None if remoteref.starts_with("refs/") => Upstream::NotABranch,
            None => Upstream::Branch(remoteref.to_string()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::remote::tests::{init_repo, run, seeded_origin, temp_base, up};

    /// The bare arm's verdict off one tracking line: the push-remote atom decides, and a
    /// line read without the atoms falls back to the upstream's own remote.
    #[test]
    fn local_upstream_bare_line_reads_the_push_remote_atom() {
        use super::bare_push_local_upstream as local;
        let r = "refs/heads/feat";
        let line = |rest: &str| format!("{r}\0refs/heads/main\0.\0{rest}");
        let main = Some("main".to_string());
        assert_eq!(local(&line("\0.\0\0\0"), r), main);
        assert_eq!(local(&line(""), r), main, "no atoms");
        assert_eq!(local(&line("\0up\0\0\0"), r), None);
        let tag = format!("{r}\0refs/tags/v1\0.\0\0.\0\0\0");
        assert_eq!(local(&tag, r), None, "not a branch");
        assert_eq!(local(&format!("{r}\0\0\0"), r), None);
        assert_eq!(local("", r), None, "unborn");
    }

    /// The parser and both bare readers take each push atom by name: every atom they
    /// consume is compared with git's own single-atom read, so a reordered or inserted
    /// atom goes red here.
    #[tokio::test]
    async fn tracking_line_reads_each_push_atom_by_name() {
        use super::{bare_push_destination, bare_push_local_upstream, tracking_line};
        use crate::git::branches::{push_destination_fields, read_refs_with_push_destination};
        let (_guard, base, _origin, _url) = seeded_origin("atom-order").await;
        let work = base.join("work").to_string_lossy().into_owned();
        let refname = "refs/heads/feat";
        // In the order `push_destination_fields` destructures them.
        macro_rules! single_reads {
            () => {{
                let mut reads = Vec::new();
                for atom in [
                    "%(push:remotename)",
                    "%(push:remoteref)",
                    "%(push)",
                    "%(upstream)",
                ] {
                    let format = format!("--format={atom}");
                    let out = run(&work, &["for-each-ref", refname, &format]).await;
                    reads.push(out.trim_end().to_string());
                }
                reads
            }};
        }
        run(&work, &["checkout", "-q", "-b", "feat"]).await;
        run(&work, &["branch", "-q", "--set-upstream-to=origin/main"]).await;
        run(&work, &["config", "branch.feat.pushRemote", "origin"]).await;
        let refspec = "refs/heads/feat:refs/heads/dest";
        run(&work, &["config", "remote.origin.push", refspec]).await;

        let single = single_reads!();
        let single_strs: Vec<&str> = single.iter().map(String::as_str).collect();
        for (i, a) in single.iter().enumerate() {
            assert!(!a.is_empty(), "atom {i} empty: {single:?}");
            assert!(
                !single[i + 1..].contains(a),
                "atoms not distinct: {single:?}"
            );
        }
        let text = read_refs_with_push_destination(&work, refname, UPSTREAM_TRACKING_FORMAT)
            .await
            .unwrap();
        let line = tracking_line(&text, refname).expect("the branch's own line");
        assert_eq!(line.atoms(), single_strs.as_slice(), "{text:?}");
        assert_eq!(
            line.atoms()[super::PUSH_TRACKING_ATOM_INDEX],
            single_strs[2],
            "%(push)"
        );
        assert_eq!(line.push_remotename(), Some(single_strs[0]));
        assert_eq!(line.upstream_atom(), Some(single_strs[3]));
        assert_eq!(line.upstream_remoteref(), "refs/heads/main");
        let (_, upstream_remote, _) = parse_upstream_tracking(&text, refname).unwrap();
        assert_eq!(line.upstream_remote(), upstream_remote);
        assert_eq!(
            bare_push_destination(&text, refname, "feat"),
            push_destination_fields("feat", &single_strs, "origin", "refs/heads/main")
        );
        assert_eq!(bare_push_local_upstream(&text, refname), None);

        // One extra base field shifts every atom, as an inserted atom shifts the rest.
        let shifted_format = format!("{UPSTREAM_TRACKING_FORMAT}%00%(objectname)");
        let shifted = read_refs_with_push_destination(&work, refname, &shifted_format)
            .await
            .unwrap();
        let shifted_line = tracking_line(&shifted, refname).expect("the branch's own line");
        assert_ne!(shifted_line.atoms(), single_strs.as_slice(), "{shifted:?}");

        // By value, never through `push_destination_fields`: what each atom MEANS.
        run(&work, &["config", "--unset", "remote.origin.push"]).await;
        for mode in ["current", "upstream"] {
            run(&work, &["config", "push.default", mode]).await;
            let single = single_reads!();
            let remote = single[0].as_str();
            assert_eq!(single[1], "", "{mode}: {single:?}");
            let expected_branch = if mode == "current" {
                let track_prefix = format!("refs/remotes/{remote}/");
                assert_eq!(
                    single[2],
                    format!("{track_prefix}feat"),
                    "{mode}: {single:?}"
                );
                single[2].strip_prefix(&track_prefix).unwrap().to_string()
            } else {
                assert_eq!(single[2], single[3], "{mode}: {single:?}");
                "refs/heads/main"
                    .strip_prefix("refs/heads/")
                    .unwrap()
                    .to_string()
            };
            let text = read_refs_with_push_destination(&work, refname, UPSTREAM_TRACKING_FORMAT)
                .await
                .unwrap();
            assert_eq!(
                bare_push_destination(&text, refname, "feat"),
                (Some(remote.to_string()), Some(expected_branch)),
                "{mode}: {text:?}"
            );
        }

        run(&work, &["config", "branch.feat.pushRemote", "."]).await;
        assert_eq!(single_reads!()[0], ".");
        let text = read_refs_with_push_destination(&work, refname, UPSTREAM_TRACKING_FORMAT)
            .await
            .unwrap();
        assert_eq!(
            bare_push_local_upstream(&text, refname),
            Some("main".to_string()),
            "{text:?}"
        );
    }

    #[test]
    fn upstream_tracking_fields_counts_the_format_atoms() {
        let atoms = UPSTREAM_TRACKING_FORMAT
            .strip_prefix("--format=")
            .expect("the format is a --format= argument");
        assert_eq!(atoms.split("%00").count(), super::UPSTREAM_TRACKING_FIELDS);
    }

    #[test]
    fn parse_upstream_tracking_missing_branch_is_none() {
        assert_eq!(parse_upstream_tracking("", "refs/heads/feature"), None);
    }

    #[test]
    fn parse_upstream_tracking_untracked_is_some_empty() {
        // An untracked branch: refname present, empty upstream fields → valid publish.
        assert_eq!(
            parse_upstream_tracking("refs/heads/feature\0\0\0\n", "refs/heads/feature"),
            Some((Upstream::Untracked, "".into(), false))
        );
    }

    #[test]
    fn parse_upstream_tracking_gone() {
        assert_eq!(
            parse_upstream_tracking("refs/heads/feature\0refs/heads/feat\0origin\0[gone]", "refs/heads/feature"),
            Some((up("feat"), "origin".into(), true))
        );
    }

    #[test]
    fn parse_upstream_tracking_normal() {
        assert_eq!(
            parse_upstream_tracking("refs/heads/feature\0refs/heads/feature\0origin\0[ahead 2]", "refs/heads/feature"),
            Some((up("feature"), "origin".into(), false))
        );
    }

    /// The upstream is its name ON the remote, so a remote-side branch name that looks
    /// like a remote-tracking path stays whole, and a local (`.`) upstream reads the
    /// same way.
    #[test]
    fn parse_upstream_tracking_reads_the_remote_side_name() {
        assert_eq!(
            parse_upstream_tracking(
                "refs/heads/x\0refs/heads/remotes/origin/x\0origin\0",
                "refs/heads/x"
            ),
            Some((up("remotes/origin/x"), "origin".into(), false))
        );
        assert_eq!(
            parse_upstream_tracking("refs/heads/x\0refs/heads/main\0.\0", "refs/heads/x"),
            Some((up("main"), ".".into(), false))
        );
    }

    #[test]
    fn parse_upstream_tracking_prefix_match_is_rejected() {
        // `for-each-ref refs/heads/feat` also matches `refs/heads/feat/sub`; the
        // exact-refname check must reject it so the caller returns "no such branch"
        // instead of reading feat/sub's tracking.
        assert_eq!(
            parse_upstream_tracking("refs/heads/feat/sub\0\0\0\n", "refs/heads/feat"),
            None
        );
    }

    /// The real `for-each-ref` output shape feeding `parse_upstream_tracking` — the
    /// format assumption is otherwise only checked against hand-written strings.
    #[tokio::test]
    async fn parse_upstream_tracking_matches_real_for_each_ref_output() {
        let (_base, base) = temp_base("track");
        let origin = base.join("origin");
        let repo = base.join("repo");
        std::fs::create_dir_all(&origin).unwrap();
        std::fs::create_dir_all(&repo).unwrap();
        let origin_s = origin.to_string_lossy().into_owned();
        let repo_s = repo.to_string_lossy().into_owned();

        init_repo(&origin_s, "o.txt").await;
        // The default branch name (main/master) is whatever git is configured for.
        let def = run(&origin_s, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();

        init_repo(&repo_s, "r.txt").await;
        run(&repo_s, &["remote", "add", "origin", &origin_s]).await;
        run(&repo_s, &["fetch", "-q", "origin"]).await;
        run(
            &repo_s,
            &["branch", &format!("--set-upstream-to=origin/{def}"), &def],
        )
        .await;
        run(&repo_s, &["branch", "feature"]).await; // untracked
        run(&repo_s, &["branch", "feat/sub"]).await; // prefix sibling; no exact `feat`

        // Shortens the upstream past `origin/<def>`, which the parse must not read.
        run(&repo_s, &["tag", &format!("origin/{def}")]).await;

        // Run the real `for-each-ref` and parse it exactly as the caller does.
        let track = |b: &str| {
            let repo_s = repo_s.clone();
            let refspec = format!("refs/heads/{b}");
            async move {
                let out = run(
                    &repo_s,
                    &["for-each-ref", &refspec, UPSTREAM_TRACKING_FORMAT],
                )
                .await;
                parse_upstream_tracking(&out, &refspec)
            }
        };

        // Untracked branch → non-empty refname line with empty upstream fields.
        assert_eq!(
            track("feature").await,
            Some((Upstream::Untracked, String::new(), false))
        );
        // Tracked branch → the remote-side branch name + remote name; gone=false
        // (ahead/behind are ignored by the parser, so divergent histories are fine).
        assert_eq!(track(&def).await, Some((up(&def), "origin".into(), false)));
        // Prefix: `for-each-ref refs/heads/feat` matches `feat/sub`, whose refname
        // isn't `refs/heads/feat` → None (the exact-match guard, end to end).
        assert_eq!(track("feat").await, None);

        // Gone upstream: track origin/<def>, then delete the remote-tracking ref so
        // `%(upstream:track)` becomes `[gone]`. Do this LAST — it also makes <def> gone.
        // The full ref: the tag above makes the bare `origin/<def>` ambiguous.
        run(
            &repo_s,
            &[
                "branch",
                "--track",
                "goner",
                &format!("refs/remotes/origin/{def}"),
            ],
        )
        .await;
        run(
            &repo_s,
            &["update-ref", "-d", &format!("refs/remotes/origin/{def}")],
        )
        .await;
        let g = track("goner").await;
        assert!(
            matches!(g, Some((_, _, true))),
            "goner upstream should read gone: {g:?}"
        );
    }
}
