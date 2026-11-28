#[cfg(test)]
mod tests {
    use super::super::*;
    use crate::git::remote::tests::{
        assert_rejection_reason, git_push_core_unpinned, run, seeded_origin, STALE_LEASE_REJECTION,
    };
    use crate::git::runner::TEST_GIT_HANG_GUARD;

    /// The bare lease's own refusal, driven end to end: with the remote moved and
    /// never fetched, the remote-tracking ref is stale and git rejects before
    /// `--force-if-includes` has anything to say. Canary for the frontend's
    /// `(stale info)` marker — the counterpart of
    /// `refusal_stderr_still_matches_the_frontend_markers` (autostash.rs).
    #[tokio::test]
    async fn force_push_rejection_stderr_still_matches_the_frontend_markers() {
        let (_guard, base, origin_s, url) = seeded_origin("stale-info").await;
        let base_s = base.to_string_lossy().into_owned();

        for name in ["clone1", "clone2"] {
            run(&base_s, &["-c", "core.autocrlf=false", "clone", "-q", &url, name]).await;
            let c = base.join(name).to_string_lossy().into_owned();
            run(&c, &["config", "core.autocrlf", "false"]).await;
            run(&c, &["config", "user.email", "t@t.local"]).await;
            run(&c, &["config", "user.name", "T"]).await;
        }
        let clone1 = base.join("clone1");
        let clone2 = base.join("clone2");
        let clone1_s = clone1.to_string_lossy().into_owned();
        let clone2_s = clone2.to_string_lossy().into_owned();

        // clone2 moves the shared branch; clone1 never learns of it, so its
        // remote-tracking ref — the lease's expectation — is stale.
        std::fs::write(clone2.join("b.txt"), "theirs\n").unwrap();
        run(&clone2_s, &["add", "-A"]).await;
        run(&clone2_s, &["commit", "-qm", "from clone2"]).await;
        run(&clone2_s, &["push", "-q"]).await;
        let theirs = run(&clone2_s, &["rev-parse", "HEAD"]).await.trim().to_string();

        std::fs::write(clone1.join("c.txt"), "mine\n").unwrap();
        run(&clone1_s, &["add", "-A"]).await;
        run(&clone1_s, &["commit", "-q", "--amend", "-m", "amended seed"]).await;

        let state = AppState::default();
        let err = git_push_core_unpinned(&state, clone1_s.clone(), false, true, None, None, None)
            .await
            .expect_err("a stale lease must not clobber the remote");
        let AppError::Git { stderr, .. } = &err else {
            panic!("expected a git error, got {err:?}")
        };
        assert_rejection_reason(stderr, STALE_LEASE_REJECTION);
        assert_eq!(
            run(&origin_s, &["rev-parse", "refs/heads/main"]).await.trim(),
            theirs,
            "clone2's commit is still origin's tip"
        );
    }

    /// A push GitHub's secret push protection refused, from a real GH013
    /// rejection measured on this machine (github.com over HTTPS, 2026-08-11).
    /// The flagged secret's own value never appears in the block, and the
    /// unblock id is a placeholder here; two purely informational `(?)` notes
    /// GitHub prints between the violation list and the locations are trimmed.
    /// GitHub pads every one of these lines with trailing spaces, dropped here
    /// because an editor would strip them back out anyway — which is the reason
    /// the frontend markers, and `has_remote_bullet` below, never end-anchor.
    const PUSH_PROTECTION_STDERR: &str = "\
remote: error: GH013: Repository rule violations found for refs/heads/feat/security-findings-phase-3.
remote:
remote: - GITHUB PUSH PROTECTION
remote:   —————————————————————————————————————————
remote:     Resolve the following violations before pushing again
remote:
remote:     - Push cannot contain secrets
remote:
remote:
remote:       —— GitLab Access Token ———————————————————————————————
remote:        locations:
remote:          - commit: 64a012e497764a53e38949a968553daa2d8f51a3
remote:            path: src-tauri/src/forge/gitlab_findings.rs:1151
remote:
remote:        (?) To push, remove secret from commit(s) or follow this URL to allow the secret.
remote:        https://github.com/theBGuy/GitDesktop/security/secret-scanning/unblock-secret/<id>
remote:
remote:
To https://github.com/theBGuy/GitDesktop.git
 ! [remote rejected] feat/security-findings-phase-3 -> feat/security-findings-phase-3 (push declined due to repository rule violations)
error: failed to push some refs to 'https://github.com/theBGuy/GitDesktop.git'
";

    /// A branch simply behind its remote: the negative control for the block
    /// above. It shares the `failed to push some refs` tail, so anything the
    /// frontend anchors on has to come from the push-protection block itself.
    const NON_FAST_FORWARD_STDERR: &str = "\
To https://github.com/theBGuy/GitDesktop.git
 ! [rejected]        main -> main (non-fast-forward)
error: failed to push some refs to 'https://github.com/theBGuy/GitDesktop.git'
hint: Updates were rejected because the tip of your current branch is behind
";

    /// Whether `report` carries a `remote:` bullet whose text opens with
    /// `label`, matching `PUSH_PROTECTION_MARKERS` (src/lib/error-summary.ts)
    /// exactly: space/tab indent only, the `remote:` prefix, the `-` bullet,
    /// the label at a word boundary — and no end anchor, since git pads the
    /// line. Looser matching here would let the canary pass stderr the
    /// frontend rejects, which is the one direction it must not be loose in.
    fn has_remote_bullet(report: &str, label: &str) -> bool {
        fn eat(s: &str) -> &str {
            s.trim_start_matches([' ', '\t'])
        }
        report.lines().any(|l| {
            eat(l)
                .strip_prefix("remote:")
                .and_then(|r| eat(r).strip_prefix('-'))
                .and_then(|r| eat(r).strip_prefix(label))
                .is_some_and(|rest| {
                    !rest
                        .chars()
                        .next()
                        .is_some_and(|c| c.is_alphanumeric() || c == '_')
                })
        })
    }

    /// Canary for the frontend's push-protection markers: `pushProtectionSummary`
    /// (src/lib/error-summary.ts) can only turn a blocked push into one human
    /// line while GitHub still prints these two bullets, so the measured stderr
    /// and the marker shapes are pinned together here. `GH013` is asserted apart
    /// from them on purpose — it heads every repository rule violation, not just
    /// secrets, so the frontend must never classify on it alone.
    #[test]
    fn push_protection_stderr_still_matches_the_frontend_markers() {
        for label in ["GITHUB PUSH PROTECTION", "Push cannot contain secrets"] {
            assert!(
                has_remote_bullet(PUSH_PROTECTION_STDERR, label),
                "the `{label}` bullet is gone — the frontend summary is now blind to a \
                 blocked push. Actual stderr:\n{PUSH_PROTECTION_STDERR}"
            );
            assert!(
                !has_remote_bullet(NON_FAST_FORWARD_STDERR, label),
                "`{label}` matched a plain non-fast-forward rejection, which must keep its \
                 own presentation"
            );
        }
        assert!(
            !has_remote_bullet(
                "remote: - GITHUB PUSH PROTECTIONAL",
                "GITHUB PUSH PROTECTION"
            ),
            "the label matched past its word boundary — the frontend's \\b would refuse \
             this line, so the canary must too"
        );
        assert!(
            PUSH_PROTECTION_STDERR
                .lines()
                .any(|l| l.trim_start().starts_with("remote: error: GH013:")),
            "the fixture no longer carries the GH013 code it was measured from"
        );
    }

    /// git asked for a username with prompting disabled and nothing in the
    /// credential helper — measured against github.com on git 2.51.1.windows.1,
    /// 2026-09.
    const NO_CREDENTIALS_STDERR: &str = "\
fatal: could not read Username for 'https://github.com': terminal prompts disabled
";

    /// Credentials github.com refused, same provenance. The sideband line names
    /// the cause; the `fatal:` line is the one the frontend anchors on.
    const REJECTED_CREDENTIALS_STDERR: &str = "\
remote: Invalid username or token. Password authentication is not supported for Git operations.
fatal: Authentication failed for 'https://github.com/octocat/Hello-World.git/'
";

    /// A push to a repository the authenticated account cannot write, same
    /// provenance: the account is recognized, the permission is not there.
    const FORBIDDEN_STDERR: &str = "\
remote: Permission to octocat/Hello-World.git denied to theBGuy.
fatal: unable to access 'https://github.com/octocat/Hello-World.git/': The requested URL returned error: 403
";

    /// A push dry-run against an archived GitHub repository, same provenance.
    /// Only the `remote:` line is measured verbatim; the `fatal:` line under it is
    /// git's standard curl-error shape, written out rather than captured — hence a
    /// placeholder URL, so this blob makes no claim about a repository another
    /// fixture presents differently.
    const ARCHIVED_STDERR: &str = "\
remote: This repository was archived so it is read-only.
fatal: unable to access 'https://github.com/example/archived.git/': The requested URL returned error: 403
";

    /// A push to a Gitea pull-mirror over plain HTTP, from the user report the
    /// read-only marker was written for (GitDesktop 0.10.0 on Linux, self-hosted
    /// Gitea). The marker-bearing `remote:` line is verbatim; the report's paste
    /// wraps the `fatal:` line after the colon, which git emits on one line, and
    /// the `99xx` port is the reporter's own masking.
    const GITEA_MIRROR_STDERR: &str = "\
remote: mirror repository is read-only
fatal: unable to access 'http://192.168.1.10:99xx/gituser1/GitDesktop/': The requested URL returned error: 403
";

    /// A push dry-run against an archived GitLab project — measured against
    /// gitlab.com on git 2.51.1.windows.1, 2026-09 (`theBGuy/gitdesktop-gitlab-demo`,
    /// archived via the API for this capture and unarchived immediately after).
    /// GitLab's wording carries neither "read-only" nor "repository", so it needs
    /// its own marker rather than widening the generic one.
    const GITLAB_ARCHIVED_STDERR: &str = "\
remote: You can't push code to an archived project.
fatal: unable to access 'https://gitlab.com/theBGuy/gitdesktop-gitlab-demo.git/': The requested URL returned error: 403
";

    /// git asked for a username with prompting disabled and nothing in the
    /// credential helper — measured against gitlab.com, same provenance as the
    /// GitHub fixture above. Same `fatal:` shape: this is git's own wording, not
    /// the host's.
    const GITLAB_NO_CREDENTIALS_STDERR: &str = "\
fatal: could not read Username for 'https://gitlab.com': terminal prompts disabled
";

    /// The Bitbucket counterpart, from a remote URL carrying an embedded username
    /// (`https://user@bitbucket.org/...` — this app's own Bitbucket remotes are
    /// shaped this way, see `strip_https_userinfo`). Git already has a username, so
    /// it asks for the missing half instead: "Password", not "Username". Measured
    /// against bitbucket.org, same provenance; the account name itself is
    /// immaterial to the shape, so it's swapped for a placeholder here.
    const BITBUCKET_NO_CREDENTIALS_STDERR: &str = "\
fatal: could not read Password for 'https://user@bitbucket.org': terminal prompts disabled
";

    /// Credentials gitlab.com refused, same provenance as the GitHub fixture. The
    /// sideband wording differs by host; the `fatal:` line the frontend anchors on
    /// does not.
    const GITLAB_REJECTED_CREDENTIALS_STDERR: &str = "\
remote: HTTP Basic: Access denied. If a password was provided for Git authentication, the password was incorrect or you're required to use a token instead of a password. If a token was provided, it was either incorrect, expired, or improperly scoped. See https://gitlab.com/help/topics/git/troubleshooting_git.md#error-on-git-fetch-http-basic-access-denied
fatal: Authentication failed for 'https://gitlab.com/theBGuy/gitdesktop-gitlab-demo.git/'
";

    /// The Bitbucket counterpart, same provenance.
    const BITBUCKET_REJECTED_CREDENTIALS_STDERR: &str = "\
remote: You may not have access to this repository or it no longer exists in this workspace. If you think this repository exists and you have access, make sure you are authenticated.
fatal: Authentication failed for 'https://bitbucket.org/thebguy1/dispatch-demo.git/'
";

    /// A push to a GitLab project the authenticated account cannot write
    /// (`gitlab-org/gitlab`, a real project this account has read-only access to),
    /// same provenance as the GitHub fixture.
    const GITLAB_FORBIDDEN_STDERR: &str = "\
remote: You are not allowed to push code to this project.
fatal: unable to access 'https://gitlab.com/gitlab-org/gitlab.git/': The requested URL returned error: 403
";

    /// The Bitbucket counterpart, against a repository this account cannot write.
    /// Bitbucket returns the same 403 shape for "no access" and "doesn't exist" —
    /// deliberately, so a probe can't distinguish a private repo from a missing one.
    const BITBUCKET_FORBIDDEN_STDERR: &str = "\
remote: The requested repository either does not exist or you do not have access. If you believe this repository exists and you have access, make sure you're authenticated.
fatal: unable to access 'https://bitbucket.org/atlassian/python-bitbucket.git/': The requested URL returned error: 403
";

    /// `git ls-remote` over SSH with no usable key — measured against gitlab.com
    /// on git 2.51.1.windows.1, 2026-09. The ssh client ends its line with CRLF
    /// while git's own lines use LF; the `\r` is kept byte-exact.
    const GITLAB_SSH_NO_ACCESS_STDERR: &str = "\
git@gitlab.com: Permission denied (publickey).\r
fatal: Could not read from remote repository.

Please make sure you have the correct access rights
and the repository exists.
";

    /// The github.com counterpart, same provenance: identical but for the host.
    const GITHUB_SSH_NO_ACCESS_STDERR: &str = "\
git@github.com: Permission denied (publickey).\r
fatal: Could not read from remote repository.

Please make sure you have the correct access rights
and the repository exists.
";

    /// `git ls-remote` against a local path that doesn't exist, same git,
    /// 2026-09-24. It ends on the same `fatal:` tail as the SSH refusals above.
    const LOCAL_MISSING_PATH_STDERR: &str = "\
fatal: 'C:/definitely-not-a-repo-x7q9z' does not appear to be a git repository
fatal: Could not read from remote repository.

Please make sure you have the correct access rights
and the repository exists.
";

    /// `git ls-remote` against an SSH host that doesn't resolve, same provenance;
    /// the ssh line ends in CRLF like the key refusals'.
    const UNRESOLVABLE_HOST_STDERR: &str = "\
ssh: Could not resolve hostname definitely-not-a-host-x7q9z.invalid: Name or service not known\r
fatal: Could not read from remote repository.

Please make sure you have the correct access rights
and the repository exists.
";

    /// The chunks the frontend's `/m` regexes see as lines. JS `.` refuses every
    /// LineTerminator and `^` re-anchors after each, while `str::lines` splits on
    /// `\n` alone — and git's sideband re-emits `remote: ` after a BARE `\r` when
    /// it overwrites a progress line, so `lines` would hand two sideband chunks to
    /// one marker as a single matchable line.
    fn js_lines(report: &str) -> impl Iterator<Item = &str> {
        report.split(['\n', '\r', '\u{2028}', '\u{2029}'])
    }

    /// Whether `text` carries `word` at JS `\b` boundaries — `[A-Za-z0-9_]` on
    /// either flank refuses the hit, which is what keeps `read-onlyish` and
    /// `repositoryX` out. `-` is outside that set, so `read-only`'s own hyphen
    /// never ends the word.
    fn contains_word(text: &str, word: &str) -> bool {
        fn is_word_char(c: char) -> bool {
            c.is_ascii_alphanumeric() || c == '_'
        }
        text.match_indices(word).any(|(start, _)| {
            text[..start].chars().next_back().is_none_or(|c| !is_word_char(c))
                && text[start + word.len()..]
                    .chars()
                    .next()
                    .is_none_or(|c| !is_word_char(c))
        })
    }

    /// Entry one: a `remote:` line naming both a repository and a read-only state.
    /// The JS lookahead makes the two order-independent within the line, and `.`
    /// never crosses a line terminator, so both tokens must sit on the SAME line.
    /// The case tolerance is `[Rr]` only, not a case-insensitive match.
    fn marks_read_only_repository(report: &str) -> bool {
        js_lines(report).any(|l| {
            l.trim_start_matches([' ', '\t'])
                .strip_prefix("remote: ")
                .is_some_and(|rest| {
                    ["repository", "Repository", "repositories", "Repositories"]
                        .iter()
                        .any(|w| contains_word(rest, w))
                        && ["read-only", "Read-only"]
                            .iter()
                            .any(|w| contains_word(rest, w))
                })
        })
    }

    /// Entry two: GitLab's archived-project refusal. Plain substring, not a word
    /// scan — GitLab's own wording is fixed copy, unlike the generic entry above
    /// which has to tolerate a repository name or state description around it.
    fn marks_gitlab_archived_project(report: &str) -> bool {
        js_lines(report).any(|l| {
            l.trim_start_matches([' ', '\t'])
                .starts_with("remote: You can't push code to an archived project.")
        })
    }

    /// Entry three. Line-anchored with no indent tolerance, exactly like the
    /// regex. Covers both halves of git's credential-fill prompt: "Username" when
    /// the remote URL carries none, "Password" when it already has one embedded
    /// (this app's own Bitbucket remotes are shaped that way).
    fn marks_missing_credentials(report: &str) -> bool {
        js_lines(report).any(|l| {
            l.starts_with("fatal: could not read Username for ")
                || l.starts_with("fatal: could not read Password for ")
        })
    }

    /// Entry four, anchored the same way.
    fn marks_rejected_credentials(report: &str) -> bool {
        js_lines(report).any(|l| l.starts_with("fatal: Authentication failed for "))
    }

    /// Entry five: git's curl-level 403. The regex's `[^'\n]*` cannot cross a
    /// quote, so the URL runs to the FIRST `'` on the line and the tail has to
    /// follow immediately. A bare `\r` inside the quotes ends the chunk here while
    /// JS would keep reading — stricter than the frontend, the safe direction.
    fn marks_forbidden_403(report: &str) -> bool {
        js_lines(report).any(|l| {
            l.strip_prefix("fatal: unable to access '")
                .and_then(|r| r.split_once('\''))
                .is_some_and(|(_url, tail)| {
                    tail.starts_with(": The requested URL returned error: 403")
                })
        })
    }

    /// Entry six, `^\S+@\S+: Permission denied \((?=[^)\n]*publickey)`. The
    /// regex's `\S` runs can't cross whitespace, so its `user@host:` token is the
    /// line's whole first word: that word must end in `:` and hold an `@` with a
    /// character on each side before that colon. `is_js_space` is JS's `\s`, which
    /// differs from `char::is_whitespace` on U+0085 and U+FEFF. The method list up
    /// to the first `)` must name `publickey`; a bare `\r`, U+2028, or U+2029
    /// inside it ends the chunk here while JS keeps reading, stricter like entry
    /// five.
    fn marks_ssh_key_refused(report: &str) -> bool {
        fn is_js_space(c: char) -> bool {
            (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
        }
        js_lines(report).any(|l| {
            let (word, rest) = l.split_at(l.find(is_js_space).unwrap_or(l.len()));
            rest.strip_prefix(" Permission denied (")
                .is_some_and(|methods| {
                    methods
                        .split_once(')')
                        .map_or(methods, |(list, _)| list)
                        .contains("publickey")
                })
                && word.strip_suffix(':').is_some_and(|user_host| {
                    user_host
                        .char_indices()
                        .any(|(i, c)| c == '@' && i > 0 && i + 1 < user_host.len())
                })
        })
    }

    /// Rust mirrors of `REMOTE_ACCESS_SUMMARIES` (src/lib/error-summary.ts), in
    /// the frontend's table order.
    const REMOTE_ACCESS_MARKERS: [fn(&str) -> bool; 6] = [
        marks_read_only_repository,
        marks_gitlab_archived_project,
        marks_missing_credentials,
        marks_rejected_credentials,
        marks_forbidden_403,
        marks_ssh_key_refused,
    ];

    /// Positions in [`REMOTE_ACCESS_MARKERS`], named for the pattern each entry
    /// matches — not a 1:1 verdict: `READ_ONLY` and `GITLAB_ARCHIVED` are
    /// different patterns that both resolve to the same toast text
    /// (`READ_ONLY_REPOSITORY_SUMMARY`, error-summary.ts), since GitLab's
    /// archived-project wording is exactly the case that summary describes.
    const READ_ONLY: usize = 0;
    const GITLAB_ARCHIVED: usize = 1;
    const NO_CREDENTIALS: usize = 2;
    const REJECTED_CREDENTIALS: usize = 3;
    const FORBIDDEN_403: usize = 4;
    const SSH_KEY_REFUSED: usize = 5;

    /// The entry `remoteAccessSummary` would pick: the FIRST match in table order,
    /// mirroring its `.find()`. The index is the table POSITION, so order is
    /// precedence — not a unique verdict, since two positions can share one.
    fn first_remote_access_match(report: &str) -> Option<usize> {
        REMOTE_ACCESS_MARKERS.iter().position(|m| m(report))
    }

    /// Canary for the frontend's remote-access markers: `remoteAccessSummary`
    /// (src/lib/error-summary.ts) can only turn a transport or sideband refusal
    /// into one human line while these measured stderr shapes still land on the
    /// entry whose wording was written for them, so the blobs and Rust mirrors of
    /// `REMOTE_ACCESS_SUMMARIES` are pinned together here. Keep the two lists in
    /// step, ORDER INCLUDED — the table's order is precedence, not just layout.
    /// GitLab's credential/permission/archived shapes and Bitbucket's
    /// credential/permission shapes are measured live (gitlab.com, bitbucket.org,
    /// 2026-09); Bitbucket's read-only wording stays absent on purpose — grown
    /// from captured stderr when it's reachable, never from a guess.
    #[test]
    fn remote_access_stderr_still_matches_the_frontend_markers() {
        for (stderr, entry, what) in [
            (NO_CREDENTIALS_STDERR, NO_CREDENTIALS, "no stored credentials"),
            (
                GITLAB_NO_CREDENTIALS_STDERR,
                NO_CREDENTIALS,
                "no stored credentials, on GitLab",
            ),
            (
                BITBUCKET_NO_CREDENTIALS_STDERR,
                NO_CREDENTIALS,
                "no stored password, on a Bitbucket remote with an embedded username",
            ),
            (
                REJECTED_CREDENTIALS_STDERR,
                REJECTED_CREDENTIALS,
                "rejected credentials",
            ),
            (
                GITLAB_REJECTED_CREDENTIALS_STDERR,
                REJECTED_CREDENTIALS,
                "rejected credentials, on GitLab",
            ),
            (
                BITBUCKET_REJECTED_CREDENTIALS_STDERR,
                REJECTED_CREDENTIALS,
                "rejected credentials, on Bitbucket",
            ),
            (FORBIDDEN_STDERR, FORBIDDEN_403, "a permission refusal"),
            (
                GITLAB_FORBIDDEN_STDERR,
                FORBIDDEN_403,
                "a permission refusal, on GitLab",
            ),
            (
                BITBUCKET_FORBIDDEN_STDERR,
                FORBIDDEN_403,
                "a permission refusal, on Bitbucket",
            ),
            (ARCHIVED_STDERR, READ_ONLY, "an archived repository"),
            (GITEA_MIRROR_STDERR, READ_ONLY, "a read-only mirror"),
            (
                GITLAB_ARCHIVED_STDERR,
                GITLAB_ARCHIVED,
                "an archived GitLab project",
            ),
            (
                GITLAB_SSH_NO_ACCESS_STDERR,
                SSH_KEY_REFUSED,
                "an SSH key refusal, on GitLab",
            ),
            (
                GITHUB_SSH_NO_ACCESS_STDERR,
                SSH_KEY_REFUSED,
                "an SSH key refusal, on GitHub",
            ),
        ] {
            assert_eq!(
                first_remote_access_match(stderr),
                Some(entry),
                "{what} no longer reaches entry {entry} — the toast would explain \
                 something else, or nothing. Actual stderr:\n{stderr}"
            );
        }

        // The TS regex has no `$` anchor, so it matches a line carrying trailing
        // text after the period too (a version banner, a self-managed instance's
        // appended hint) — the Rust mirror must match the SAME set, not a
        // stricter one, or the canary could pass while under-approximating what
        // the frontend actually classifies.
        assert!(
            REMOTE_ACCESS_MARKERS[GITLAB_ARCHIVED](
                "remote: You can't push code to an archived project. Contact an admin.\n"
            ),
            "a trailing-text variant of the archived-project line must still match"
        );

        // All three read-only-family blobs also carry git's generic 403 line, so
        // the read-only/archived verdicts above rest on the table's ORDER rather
        // than on exclusivity.
        for stderr in [ARCHIVED_STDERR, GITEA_MIRROR_STDERR, GITLAB_ARCHIVED_STDERR] {
            assert!(
                REMOTE_ACCESS_MARKERS[FORBIDDEN_403](stderr),
                "a read-only blob lost its 403 line — the fixture no longer exercises \
                 the precedence entry one depends on. Actual stderr:\n{stderr}"
            );
        }

        // The permission blob reaches entry five on its own merits: its `remote:`
        // line reports no repository state, and no earlier entry claims it.
        for earlier in [READ_ONLY, GITLAB_ARCHIVED, NO_CREDENTIALS, REJECTED_CREDENTIALS] {
            assert!(
                !REMOTE_ACCESS_MARKERS[earlier](FORBIDDEN_STDERR),
                "entry {earlier} claimed a plain permission refusal, which has its own \
                 summary"
            );
        }

        // The ssh line's CRLF joint is part of the measured shape; a fixture that
        // lost it would stop exercising the `\r` the frontend regex must tolerate.
        for stderr in [GITLAB_SSH_NO_ACCESS_STDERR, GITHUB_SSH_NO_ACCESS_STDERR] {
            assert!(
                stderr.contains("(publickey).\r\nfatal: "),
                "an SSH fixture lost its measured CRLF joint. Actual stderr:\n{stderr}"
            );
        }

        // These end on the same shared `fatal:` tail as the key refusals, but their
        // own first lines say more than any mapped summary, so no entry may claim
        // them.
        for stderr in [LOCAL_MISSING_PATH_STDERR, UNRESOLVABLE_HOST_STDERR] {
            assert_eq!(
                first_remote_access_match(stderr),
                None,
                "a first-contact failure with a specific first line was claimed by \
                 a remote-access entry. Actual stderr:\n{stderr}"
            );
        }

        // Constructed, not measured: ssh's method list varies, and entry six only
        // needs it to name `publickey`.
        assert_eq!(
            first_remote_access_match("git@example.com: Permission denied (publickey,password).\n"),
            Some(SSH_KEY_REFUSED),
            "a key refusal listing more methods than publickey must still match"
        );

        // Shapes the line anchor, word boundaries, and exact wording refuse.
        // Looser matching here would let the canary pass stderr the frontend
        // leaves raw, which is the one direction it must not be loose in.
        for line in [
            "Add read-only repository guard",          // a commit subject echoed back
            "remote: repository is readonly",          // no hyphen
            "remote: branch main is read-only",        // no repository token
            "remote: this repository is read-onlyish", // past the word boundary
            // Two sideband chunks a bare `\r` separates: neither carries both
            // tokens, and JS `.` cannot span the `\r` to join them.
            "remote: repository access\rremote: mirror is read-only\n",
            // Entry three is anchored at the line start with no indent tolerance.
            "  fatal: could not read Username for 'https://x'",
            // Entry five's quoted run stops at the first `'`, so the tail has to
            // follow that quote and not a later one.
            "fatal: unable to access 'a': 'b': The requested URL returned error: 403",
            // Entry two's wording is GitLab's exact copy — a paraphrase must not
            // borrow its verdict.
            "remote: You cannot push code to an archived project.",
            // Entry six's `user@host:` token must open the line, so ssh's
            // refusal quoted after other text is not ssh's.
            "warning: git@gitlab.com: Permission denied (publickey).",
            // Constructed: a refusal that never involved a key must not get key
            // advice.
            "git@example.com: Permission denied (password).",
            "git@example.com: Permission denied (keyboard-interactive).",
        ] {
            assert_eq!(
                first_remote_access_match(line),
                None,
                "`{line}` matched a remote-access marker the frontend would refuse"
            );
        }
    }

    /// Mirror of `PUSH_TRANSFER_HEADER` / `FETCH_TRANSFER_HEADER`
    /// (src/lib/error-summary.ts), on the trimmed line like the frontend: the
    /// keyword, one space, then ONE token of an optional `[\w.-]+@`, a `[\w.+-]+`
    /// run, `:`, and a non-empty tail. Each class excludes the separator after it,
    /// so the first `@` and the first `:` are the only splits the regex can take.
    fn is_transfer_header(line: &str, keyword: &str) -> bool {
        fn run_then_tail(s: &str) -> bool {
            s.split_once(':').is_some_and(|(run, tail)| {
                !run.is_empty()
                    && run
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || "_.+-".contains(c))
                    && !tail.is_empty()
            })
        }
        let Some(token) = line
            .trim()
            .strip_prefix(keyword)
            .and_then(|r| r.strip_prefix(' '))
        else {
            return false;
        };
        !token.chars().any(char::is_whitespace)
            && (run_then_tail(token)
                || token.split_once('@').is_some_and(|(user, rest)| {
                    !user.is_empty()
                        && user
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
                        && run_then_tail(rest)
                }))
    }

    /// Mirror of `TRANSFER_REF_LINE` (src/lib/error-summary.ts), on the UNTRIMMED
    /// line: a space, one of the documented success flags ` +-*=t`, a space, a
    /// `[…]` status, a lowercase hex range (`..` or `...`), or the bare `branch` /
    /// `tag` / `remote-tracking branch` words, a space run, then a non-space
    /// character with a ` -> ` arrow somewhere after it that a non-space character
    /// follows.
    fn is_transfer_ref_noise(line: &str) -> bool {
        let Some(rest) = line.strip_prefix(' ') else {
            return false;
        };
        let mut chars = rest.chars();
        if !chars.next().is_some_and(|flag| " +-*=t".contains(flag)) {
            return false;
        }
        let Some(rest) = chars.as_str().strip_prefix(' ') else {
            return false;
        };
        let tail = if let Some(status) = rest.strip_prefix('[') {
            match status.split_once(']') {
                Some((inner, tail)) if !inner.is_empty() => tail,
                _ => return false,
            }
        } else if let Some(tail) = rest.strip_prefix("remote-tracking branch") {
            tail
        } else {
            let is_hex =
                |s: &str| !s.is_empty() && s.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'));
            let (word, tail) = rest.split_at(rest.find(' ').unwrap_or(rest.len()));
            if word != "branch" && word != "tag" {
                let Some((old, new)) = word.split_once("..") else {
                    return false;
                };
                if !(is_hex(old) && is_hex(new.strip_prefix('.').unwrap_or(new))) {
                    return false;
                }
            }
            tail
        };
        let after = tail.trim_start_matches(' ');
        let mut rest = after.chars();
        after.len() < tail.len()
            && rest.next().is_some_and(|c| !c.is_whitespace())
            && rest.as_str().match_indices(" -> ").any(|(i, _)| {
                rest.as_str()[i + 4..]
                    .chars()
                    .next()
                    .is_some_and(|c| !c.is_whitespace())
            })
    }

    /// Mirror of `TRANSFER_DELETED_LINE` (src/lib/error-summary.ts), on the
    /// UNTRIMMED line: ` - [deleted]`, a space run, then exactly one non-space
    /// token (an optional trailing `\r` aside) running to the end.
    fn is_transfer_deleted_noise(line: &str) -> bool {
        let Some(rest) = line.strip_prefix(" - [deleted]") else {
            return false;
        };
        let after = rest.trim_start_matches(' ');
        let token = after.strip_suffix('\r').unwrap_or(after);
        after.len() < rest.len() && !token.is_empty() && !token.chars().any(char::is_whitespace)
    }

    /// Mirror of `isNoiseLine` (src/lib/error-summary.ts), minus its
    /// `Rebasing (x/y)` arm, which no transfer report carries.
    fn is_summary_noise(line: &str) -> bool {
        let t = line.trim();
        t.is_empty()
            || t.starts_with("hint:")
            || is_transfer_header(t, "To")
            || is_transfer_header(t, "From")
            || is_transfer_ref_noise(line)
            || is_transfer_deleted_noise(line)
    }

    /// The line `firstMeaningfulLine` would summarize, before its prefix strip and
    /// space collapse.
    fn first_meaningful(report: &str) -> Option<&str> {
        report.lines().find(|l| !is_summary_noise(l))
    }

    /// `line` with git's column padding collapsed, as the summary shows it.
    fn collapsed(line: &str) -> String {
        line.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    /// stderr of a git call that must fail, run the way the app's runner runs it.
    async fn failing_stderr(repo: &str, args: &[&str]) -> String {
        match run_git(Some(repo), args, TEST_GIT_HANG_GUARD).await {
            Err(AppError::Git { stderr, .. }) => stderr,
            Err(other) => panic!("expected `git {args:?}` to fail with a git error, got {other:?}"),
            Ok(_) => panic!("expected `git {args:?}` to fail, but it succeeded"),
        }
    }

    /// Canary for the frontend's transfer-report noise family: `firstMeaningfulLine`
    /// (src/lib/error-summary.ts) skips git's `To`/`From` headers and the per-ref
    /// lines carrying a documented success flag, while a `!` line stays meaningful,
    /// so a failed push, pull, or fetch summarizes git's reason rather than a ref
    /// that moved fine. Real repos re-derive the measured shapes against Rust
    /// mirrors of `PUSH_TRANSFER_HEADER`, `FETCH_TRANSFER_HEADER`,
    /// `TRANSFER_REF_LINE`, and `TRANSFER_DELETED_LINE`, in both directions — keep
    /// the two lists in step. The `remote-tracking branch` form needs a
    /// `refs/remotes/*` ref on the remote to reproduce, so it is pinned from its
    /// measured line only.
    #[tokio::test]
    async fn transfer_report_stderr_still_matches_the_frontend_markers() {
        let (_guard, base, _origin_s, url) = seeded_origin("transfer-report").await;
        let base_s = base.to_string_lossy().into_owned();
        for name in ["clone1", "clone2"] {
            run(
                &base_s,
                &["-c", "core.autocrlf=false", "clone", "-q", &url, name],
            )
            .await;
            let c = base.join(name).to_string_lossy().into_owned();
            run(&c, &["config", "core.autocrlf", "false"]).await;
            run(&c, &["config", "user.email", "t@t.local"]).await;
            run(&c, &["config", "user.name", "T"]).await;
        }
        let clone1 = base.join("clone1");
        let clone2 = base.join("clone2");
        let clone1_s = clone1.to_string_lossy().into_owned();
        let clone2_s = clone2.to_string_lossy().into_owned();

        // clone2 moves main, tags its new tip, and publishes a branch for clone1 to
        // delete later; clone1 commits on the old tip, so the two have diverged.
        std::fs::write(clone2.join("b.txt"), "theirs\n").unwrap();
        run(&clone2_s, &["add", "-A"]).await;
        run(&clone2_s, &["commit", "-qm", "from clone2"]).await;
        run(&clone2_s, &["tag", "v1"]).await;
        run(
            &clone2_s,
            &[
                "push",
                "-q",
                "origin",
                "main",
                "v1",
                "HEAD:refs/heads/doomed",
            ],
        )
        .await;
        std::fs::write(clone1.join("c.txt"), "mine\n").unwrap();
        run(&clone1_s, &["add", "-A"]).await;
        run(&clone1_s, &["commit", "-qm", "from clone1"]).await;

        // The app's default pull mode, on its fall-through path: the fetch half's
        // report leads, and git's refusal is the reason.
        let pull = failing_stderr(&clone1_s, &["pull", "--ff-only"]).await;
        assert!(
            pull.trim()
                .lines()
                .next()
                .is_some_and(|l| is_transfer_header(l, "From")),
            "a refused pull no longer leads with the `From` header. Actual stderr:\n{pull}"
        );
        assert!(
            pull.lines()
                .any(|l| l.contains("-> origin/main") && is_transfer_ref_noise(l)),
            "the pull's fast-forward table line is gone or no longer reads as noise. \
             Actual stderr:\n{pull}"
        );
        assert!(
            first_meaningful(&pull)
                .is_some_and(|l| l.starts_with("fatal: Not possible to fast-forward")),
            "the refused pull would no longer summarize git's reason. Actual stderr:\n{pull}"
        );

        // A local tag the remote's disagrees with: `fetch --tags` refuses to move it,
        // and that `!` line is the reason. Naming `main` adds fetch's bare-word
        // `* branch … -> FETCH_HEAD` line to the same report.
        run(&clone1_s, &["tag", "-f", "v1"]).await;
        let fetch = failing_stderr(&clone1_s, &["fetch", "--tags", "origin", "main"]).await;
        assert!(
            fetch
                .trim()
                .lines()
                .next()
                .is_some_and(|l| is_transfer_header(l, "From")),
            "a refused fetch no longer leads with the `From` header. Actual stderr:\n{fetch}"
        );
        assert!(
            fetch.lines().any(|l| l.starts_with(" * branch")
                && collapsed(l).contains("main -> FETCH_HEAD")
                && is_transfer_ref_noise(l)),
            "the fetch's `* branch` line is gone or no longer reads as noise. \
             Actual stderr:\n{fetch}"
        );
        assert!(
            first_meaningful(&fetch).is_some_and(|l| {
                l.trim_start().starts_with("! [rejected]")
                    && collapsed(l).contains("v1 -> v1")
                    && l.contains("(would clobber existing tag)")
            }),
            "the tag-clobber refusal would no longer summarize its `!` line. \
             Actual stderr:\n{fetch}"
        );

        // A rejected branch pushed alongside a new tag and a deletion: neither success
        // line may headline the failure.
        run(&clone1_s, &["tag", "v2"]).await;
        let push = failing_stderr(
            &clone1_s,
            &[
                "push",
                "origin",
                ":refs/heads/doomed",
                "main",
                "refs/tags/v2",
            ],
        )
        .await;
        assert!(
            push.trim()
                .lines()
                .next()
                .is_some_and(|l| is_transfer_header(l, "To")),
            "a rejected push no longer leads with the `To` header. Actual stderr:\n{push}"
        );
        assert!(
            push.lines().any(|l| l.starts_with(" * [new tag]")
                && collapsed(l).contains("v2 -> v2")
                && is_transfer_ref_noise(l)),
            "the new tag's report line is gone or no longer reads as noise. \
             Actual stderr:\n{push}"
        );
        assert!(
            push.lines().any(|l| l.starts_with(" - [deleted]")
                && collapsed(l) == "- [deleted] doomed"
                && is_transfer_deleted_noise(l)),
            "the deletion's report line is gone or no longer reads as noise. \
             Actual stderr:\n{push}"
        );
        assert!(
            first_meaningful(&push).is_some_and(|l| {
                l.trim_start().starts_with("! [rejected]")
                    && collapsed(l).contains("main -> main")
                    && l.contains("(non-fast-forward)")
            }),
            "the rejected push would no longer summarize its `!` line. Actual stderr:\n{push}"
        );

        // Measured on git 2.51.1.windows.1 (a fetch of a `refs/remotes/*` ref): the
        // two-word summary column, followed by a single space.
        assert!(
            is_summary_noise(" * remote-tracking branch mirror/main -> FETCH_HEAD"),
            "the remote-tracking fetch line no longer reads as noise"
        );

        // Shapes the mirrors refuse, as the frontend's own boundary tests do.
        // Looser matching here would let the canary pass a report the frontend
        // summarizes differently.
        for line in [
            " ! [rejected]        main -> main (non-fast-forward)",
            " - make sure the remote still exists",
            " - [deleted]         feat and the rest",
            "Renamed main -> trunk on the remote.",
            "   Fix the parser -> faster builds",
            " * note: main -> trunk",
            " * branches main -> trunk",
            "From /home/u/origin",
            "From here on, retry the fetch.",
        ] {
            assert!(
                !is_summary_noise(line),
                "`{line}` reads as noise here, but the frontend keeps it meaningful"
            );
        }
    }
}
