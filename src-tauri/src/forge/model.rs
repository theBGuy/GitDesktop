//! The neutral, provider-agnostic data model the `Forge` abstraction speaks in.
//!
//! Today every hosted feature deserializes GitHub's own shapes (`GhStatus`,
//! `PrInfo`, …). To support GitLab and Bitbucket without branching every panel,
//! the backend grows a small set of host-independent types here; each `Forge`
//! impl maps its provider's API onto them. Phase 0 only needs [`ForgeStatus`] +
//! [`Capabilities`]; later phases add `PullRequest`, `Issue`, etc. alongside.

use serde::{Deserialize, Serialize};

/// Which hosting platform backs a repo's hosted features.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    GitHub,
    GitLab,
    Bitbucket,
}

/// What a provider (and this repo on it) actually supports, so the UI shows only
/// the controls that work instead of erroring. The platforms are *not*
/// feature-identical — Bitbucket Cloud has no labels/milestones/stars, GitLab has
/// no Discussions — so panels gate on these flags rather than assuming GitHub.
///
/// GitHub is all-true today; GitLab/Bitbucket follow the parity matrix in
/// `docs/multi-provider-support.md` §6. The set grows as later phases migrate more
/// panels behind capability gates (rulesets, collaborators, pages, …).
#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub pull_requests: bool,
    pub draft_prs: bool,
    pub issues: bool,
    pub labels: bool,
    pub milestones: bool,
    pub reactions: bool,
    pub discussions: bool,
    pub stars: bool,
    pub ci: bool,
    pub webhooks: bool,
    pub approvals: bool,
}

impl Capabilities {
    /// The static capability profile for a provider (refined per-repo later, e.g.
    /// a Bitbucket repo with issues disabled). Mirrors the §6 parity matrix.
    pub const fn for_provider(provider: Provider) -> Self {
        match provider {
            // GitHub is the reference implementation: everything on.
            Provider::GitHub => Self {
                pull_requests: true,
                draft_prs: true,
                issues: true,
                labels: true,
                milestones: true,
                reactions: true,
                discussions: true,
                stars: true,
                ci: true,
                webhooks: true,
                approvals: true,
            },
            // GitLab: MRs/issues/labels/milestones/CI/approvals, emoji "awards" as
            // reactions, but no Discussions (GitHub-only).
            Provider::GitLab => Self {
                pull_requests: true,
                draft_prs: true,
                issues: true,
                labels: true,
                milestones: true,
                reactions: true,
                discussions: false,
                stars: true,
                ci: true,
                webhooks: true,
                approvals: true,
            },
            // Bitbucket Cloud: no labels, milestones, stars, reactions, or
            // discussions; PRs/CI(pipelines)/webhooks/approvals do work. Draft PRs
            // ARE supported (since 2024, the `draft` bool on the PR object). The
            // native issue tracker is being deleted platform-wide 2026-08-20, so
            // issues is false.
            Provider::Bitbucket => Self {
                pull_requests: true,
                draft_prs: true,
                issues: false,
                labels: false,
                milestones: false,
                reactions: false,
                discussions: false,
                stars: false,
                ci: true,
                webhooks: true,
                approvals: true,
            },
        }
    }

    /// Nothing supported — the profile for a repo with no recognized hosted
    /// remote (so every hosted control hides).
    pub const fn none() -> Self {
        Self {
            pull_requests: false,
            draft_prs: false,
            issues: false,
            labels: false,
            milestones: false,
            reactions: false,
            discussions: false,
            stars: false,
            ci: false,
            webhooks: false,
            approvals: false,
        }
    }
}

/// Which hosted features GitDesktop has actually **built** for a provider — a
/// different axis from [`Capabilities`]. Capabilities = what the *platform* can do
/// (GitLab has labels); `Implemented` = what *we've wired up* for it (we may not
/// have built GitLab labels yet). A panel lights up only when the repo is ready
/// **and** the platform supports the feature **and** we've implemented it here.
///
/// GitHub is the reference implementation (everything built). GitLab/Bitbucket
/// flip these on per phase as each read/write path lands — so a *ready* GitLab
/// repo degrades its unbuilt panels to "coming soon" instead of firing `gh_*`
/// calls that would break against it. The frontend mirrors this as
/// `forgeFeatureReady(status, feature)`.
#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Implemented {
    // ── Reads (panel-level): whether we fetch+render this surface at all. ──
    pub pull_requests: bool,
    pub issues: bool,
    pub ci: bool,
    pub releases: bool,
    pub insights: bool,
    /// Repo-management surface: View/Fork/Star/admin settings, branch-rule import.
    pub repo_actions: bool,
    /// Publishing a local repo to the provider (create remote + push).
    pub publish: bool,
    /// The repository-settings dialog (admin probe + General / Danger zone,
    /// plus each provider's extra sections). Distinct from `repo_actions` so a
    /// provider can have View/Star without the settings surface.
    pub repo_settings: bool,
    // ── Writes (per-action): flip on as each mutation lands for a provider, so a
    //    read-only provider's detail views suppress just the writes it can't do
    //    yet (distinct from the panel-level read flags above). ──
    /// Posting a comment/note on an issue.
    pub issue_comment: bool,
    /// Closing / reopening an issue.
    pub issue_state: bool,
    /// Posting a comment/note on a merge/pull request.
    pub mr_comment: bool,
    /// Closing / reopening a merge/pull request (not merge).
    pub mr_state: bool,
    /// Editing AND deleting a merge/pull request conversation comment — one flag
    /// covering both ops (like `mr_state` covers close + reopen). GitHub edits/deletes
    /// the IssueComment node; GitLab the MR note; Bitbucket the PR comment, so it's
    /// true for all three.
    pub mr_comment_edit: bool,
    /// Editing AND deleting an issue conversation comment — one flag covering both
    /// ops. GitHub and GitLab wire it; Bitbucket's native tracker is being retired,
    /// so it stays `false` there.
    pub issue_comment_edit: bool,
    /// Approving / unapproving a merge request via the bodyless toggle. GitLab-only:
    /// GitHub surfaces approval through the older review flow (the Review menu), not
    /// this control, so it's the one write GitHub leaves `false` (see `all`).
    pub mr_approve: bool,
    /// Merging a merge/pull request (strategy + delete-source-branch). A shared
    /// control — GitHub via `gh pr merge`, GitLab via `glab` — so it's true for both.
    pub mr_merge: bool,
    /// Arming/cancelling GitLab auto-merge (merge-when-pipeline-succeeds). GitLab-only:
    /// this app has no in-app GitHub PR auto-merge control, so like `mr_approve` the
    /// flag stays `false` for GitHub (see `all`).
    pub mr_auto_merge: bool,
    /// Editing labels on an issue — a shared control (GitHub by node id, GitLab by
    /// name), so true for both.
    pub issue_labels: bool,
    /// Editing labels on a merge/pull request — the same shared label control.
    pub mr_labels: bool,
    /// Setting an issue's assignees — a shared issue control. (MR/PR assignees are
    /// the separate `mr_assignees` below — a shared control for GitHub and GitLab.)
    pub issue_assignees: bool,
    /// Creating an issue from the app — a shared control (the same create dialog;
    /// the GitHub-only org issue type hides per provider — milestone works on both).
    pub issue_create: bool,
    /// Creating a merge/pull request from the app (push the head branch + open) —
    /// a shared control.
    pub mr_create: bool,
    /// Re-running a finished CI run — a shared control. GitHub re-runs all or just
    /// failed jobs; GitLab's retry restarts failed/canceled jobs only (there is no
    /// GitLab "re-run all", so that one button stays GitHub-only in the UI).
    pub ci_rerun: bool,
    /// Cancelling an in-flight CI run — a shared control.
    pub ci_cancel: bool,
    /// Manually starting a CI run — a shared control (GitHub dispatches a workflow;
    /// GitLab runs a new pipeline on a ref, with variables instead of inputs).
    pub ci_dispatch: bool,
    /// Publishing a new release — a shared control (the same create dialog; the
    /// GitHub-only draft/pre-release/latest toggles hide per provider).
    pub release_create: bool,
    /// Managing an existing release (edit title/notes, delete, upload assets,
    /// delete assets) — a shared control.
    pub release_edit: bool,
    /// Setting a merge/pull request's assignees — a shared control for GitHub and
    /// GitLab. GitHub PRs are issues under the hood, so the PATCH issues endpoint
    /// sets PR assignees; GitLab resolves usernames→ids and PUTs `assignee_ids`.
    /// Bitbucket PRs have no assignee concept, so it stays `false` there.
    pub mr_assignees: bool,
    /// Requesting changes on a merge request — the blocking reviewer state.
    /// GitLab and Bitbucket share the control; GitHub requests changes through
    /// its Review menu (`gh_pr_review`), not this control, so the flag stays
    /// `false` for GitHub (see `all`).
    pub mr_request_changes: bool,
    /// Editing a merge/pull request's reviewer list — now a shared control on
    /// all three providers. GitHub diffs pending user requests and runs
    /// `gh pr edit --add/--remove-reviewer`; GitLab PUTs `reviewer_ids`;
    /// Bitbucket picks reviewers (not assignees) from workspace members. Each
    /// preserves the reviewers it doesn't manage (teams / bots on GitHub) so the
    /// picker can never drop them.
    pub mr_reviewers: bool,
    /// Editing an existing issue's title/body — a shared control (the same edit
    /// dialog; GitHub PATCHes the issue, GitLab PUTs title/description).
    pub issue_edit: bool,
    /// Editing an existing merge/pull request's title/body — the same shared
    /// edit control.
    pub mr_edit: bool,
    /// Setting or clearing an issue's milestone — a shared control (the same
    /// picker; GitHub keys on the milestone number, GitLab on the GLOBAL
    /// milestone id, which is what each provider's list read returns).
    pub issue_milestone: bool,
    /// Reactions on an issue and its comments — a shared control (the same
    /// ReactionBar; GitHub reacts by GraphQL node id, GitLab awards emoji by
    /// issue/note id).
    pub issue_reactions: bool,
    /// Reactions on a merge/pull request and its comments — the same shared
    /// ReactionBar.
    pub mr_reactions: bool,
    /// Locking / unlocking an issue's conversation — a shared control (GitHub
    /// locks with an optional reason; GitLab's `discussion_locked` has none, so
    /// the reason submenu hides per provider).
    pub issue_lock: bool,
    /// Moving an issue to another repository/project — a shared control
    /// (GitHub calls it transfer, GitLab move; same dialog).
    pub issue_transfer: bool,
    /// Permanently deleting an issue — a shared control (both providers
    /// restrict it server-side to elevated roles).
    pub issue_delete: bool,
    /// Marking an issue confidential (members-only). GitLab-unique — GitHub has
    /// no confidential-issue concept, so like `mr_approve` this stays `false`
    /// for GitHub (see `all`).
    pub issue_confidential: bool,
    /// Setting / clearing an issue's due date. GitLab-unique — GitHub issues
    /// have no due dates, so the flag stays `false` for GitHub (see `all`).
    pub issue_due_date: bool,
    /// Playing a manual CI job (GitLab pipelines' `when: manual` jobs).
    /// GitLab-unique — GitHub Actions has no per-job manual play, so like
    /// `mr_approve` this stays `false` for GitHub (see `all`).
    pub ci_job_play: bool,
    /// Time tracking on issues and merge requests (estimate + spent time).
    /// GitLab-unique — GitHub has no native time tracking, so the flag stays
    /// `false` for GitHub (see `all`).
    pub time_tracking: bool,
    /// Related issues (issue links). GitLab-unique — GitHub has no native issue
    /// links, so like `mr_approve` this stays `false` for GitHub (see `all`).
    pub issue_links: bool,
    /// The pull-request tasks checklist (create/edit/resolve/delete). Bitbucket-only:
    /// PR tasks are a native Bitbucket concept with no GitHub/GitLab analogue wired
    /// here, so like `mr_approve` this stays `false` for both (see `all`).
    pub pr_tasks: bool,
    /// Reading file:line-anchored review threads on a merge/pull request — a shared
    /// read surface (GitHub reviewThreads / GitLab diff-note discussions / Bitbucket
    /// inline comments), so true for all three.
    pub mr_review_threads: bool,
    /// Replying in an existing review thread — a shared write, true for all three.
    pub mr_thread_reply: bool,
    /// Resolving / unresolving a review thread — GitHub and GitLab resolve threads;
    /// Bitbucket exposed no comment-resolution field/endpoint on any probed comment,
    /// so it stays `false` there (the forge arm errors).
    pub mr_thread_resolve: bool,
    /// Editing AND deleting a file:line-anchored review-thread comment — one flag
    /// covering both ops. Separate from `mr_comment_edit` (which covers flat
    /// conversation comments) because thread-scoped controls carry their own flag
    /// family alongside `mr_thread_reply` / `mr_thread_resolve`. All three providers
    /// wire it (GitHub via the PullRequestReviewComment mutations, GitLab/Bitbucket
    /// reusing their note/comment endpoints), so it's true for each.
    pub mr_thread_comment_edit: bool,
    /// Reading + writing comments on an individual commit (whole-commit and
    /// file:line-anchored). All three providers wire it (GitHub commit-comments REST,
    /// GitLab commit discussions, Bitbucket commit comments), so it's true for each.
    pub commit_comments: bool,
    /// Creating a NEW file:line-anchored review thread on a merge/pull request (as
    /// opposed to replying in an existing one — `mr_thread_reply`). All three
    /// providers wire it, so it's true for each.
    pub mr_thread_create: bool,
    /// Submitting a batched review (summary + inline comments + approve/comment/
    /// request-changes verdict) in one action. All three providers wire it, so it's
    /// true for each.
    pub mr_review_submit: bool,
    /// Toggling a merge/pull request's draft state BOTH ways from the shared
    /// Ready / Convert-to-draft control. GitLab (`glab mr update --ready|--draft`)
    /// and Bitbucket (PUT `draft`) drive that control off this flag. GitHub stays
    /// `false`: its Ready/Convert path goes through `gh pr ready [--undo]` gated on
    /// `canWrite` (the forge-gating convention for a shared control whose GitHub arm
    /// has its own gate), so the frontend enables it there without this flag.
    pub mr_draft_toggle: bool,
    /// Searching / browsing repositories on the provider for the Explore view — a
    /// shared read (GitHub `search/repositories`, GitLab `projects?search=`,
    /// Bitbucket workspace-scoped `q=name~"…"`), so true for all three. Bitbucket's
    /// is workspace-scoped by design (global repo search was retired platform-wide).
    pub repo_search: bool,
    /// Forking a repo by its `owner/name` (Explore's Fork action, distinct from the
    /// current-repo fork). Wired for all three (`gh repo fork`, GitLab fork POST,
    /// Bitbucket forks POST), so true for each.
    pub repo_fork_by_name: bool,
    /// Starring / unstarring a repo by its `owner/name` from Explore, plus the
    /// starred-state read. GitHub and GitLab both have a star API; Bitbucket Cloud
    /// has no stars, so it stays `false` there.
    pub repo_star: bool,
    /// Reading a repo's rendered README for the Explore preview — a shared read
    /// (GitHub `repos/…/readme`, GitLab repository-files raw, Bitbucket `src/…`),
    /// so true for all three.
    pub repo_readme: bool,
}

impl Implemented {
    /// Everything built — the GitHub reference profile. The one exception is
    /// `mr_approve`: GitHub's approval surface is the older review flow (the Review
    /// menu), not the bodyless approve/unapprove toggle, so that forge control is
    /// GitLab-only and stays `false` here.
    const fn all() -> Self {
        Self {
            pull_requests: true,
            issues: true,
            ci: true,
            releases: true,
            insights: true,
            repo_actions: true,
            publish: true,
            repo_settings: true,
            issue_comment: true,
            issue_state: true,
            mr_comment: true,
            mr_state: true,
            mr_comment_edit: true,
            issue_comment_edit: true,
            mr_approve: false,
            mr_merge: true,
            // Like `mr_approve`: no in-app GitHub PR auto-merge control here.
            mr_auto_merge: false,
            issue_labels: true,
            mr_labels: true,
            issue_assignees: true,
            issue_create: true,
            mr_create: true,
            ci_rerun: true,
            ci_cancel: true,
            ci_dispatch: true,
            release_create: true,
            release_edit: true,
            // GitHub PRs are issues under the hood, so the same assignee control the
            // issue path uses works on PRs too — the MR/PR-assignees picker is wired
            // for both GitHub and GitLab.
            mr_assignees: true,
            // Like `mr_approve`: GitHub requests changes via its Review menu.
            mr_request_changes: false,
            // Requested reviewers ARE editable (`gh pr edit --add/--remove-reviewer`).
            // The picker manages user reviewers; any team requests are preserved
            // (team display in the picker is a follow-up).
            mr_reviewers: true,
            issue_edit: true,
            mr_edit: true,
            issue_milestone: true,
            issue_reactions: true,
            mr_reactions: true,
            issue_lock: true,
            issue_transfer: true,
            issue_delete: true,
            // Like `mr_approve`: GitLab-unique issue fields with no GitHub analogue.
            issue_confidential: false,
            issue_due_date: false,
            // Like `mr_approve`: GitLab-unique — no per-job manual play, native
            // time tracking, or issue links on GitHub.
            ci_job_play: false,
            time_tracking: false,
            issue_links: false,
            // Like `mr_approve`: PR tasks are a Bitbucket-only surface here.
            pr_tasks: false,
            // Review threads: read + reply are shared; GitHub resolves threads too.
            mr_review_threads: true,
            mr_thread_reply: true,
            mr_thread_resolve: true,
            mr_thread_comment_edit: true,
            commit_comments: true,
            mr_thread_create: true,
            mr_review_submit: true,
            // GitHub's Ready / Convert-to-draft goes via `gh pr ready [--undo]`
            // gated on `canWrite`, not this flag.
            mr_draft_toggle: false,
            // Explore: repo search, fork-by-name, star, and README are all built
            // for GitHub.
            repo_search: true,
            repo_fork_by_name: true,
            repo_star: true,
            repo_readme: true,
        }
    }

    /// Nothing built yet — a recognized provider whose panels aren't wired up.
    pub const fn none() -> Self {
        Self {
            pull_requests: false,
            issues: false,
            ci: false,
            releases: false,
            insights: false,
            repo_actions: false,
            publish: false,
            repo_settings: false,
            issue_comment: false,
            issue_state: false,
            mr_comment: false,
            mr_state: false,
            mr_comment_edit: false,
            issue_comment_edit: false,
            mr_approve: false,
            mr_merge: false,
            mr_auto_merge: false,
            issue_labels: false,
            mr_labels: false,
            issue_assignees: false,
            issue_create: false,
            mr_create: false,
            ci_rerun: false,
            ci_cancel: false,
            ci_dispatch: false,
            release_create: false,
            release_edit: false,
            mr_assignees: false,
            mr_request_changes: false,
            mr_reviewers: false,
            issue_edit: false,
            mr_edit: false,
            issue_milestone: false,
            issue_reactions: false,
            mr_reactions: false,
            issue_lock: false,
            issue_transfer: false,
            issue_delete: false,
            issue_confidential: false,
            issue_due_date: false,
            ci_job_play: false,
            time_tracking: false,
            issue_links: false,
            pr_tasks: false,
            mr_review_threads: false,
            mr_thread_reply: false,
            mr_thread_resolve: false,
            mr_thread_comment_edit: false,
            commit_comments: false,
            mr_thread_create: false,
            mr_review_submit: false,
            mr_draft_toggle: false,
            repo_search: false,
            repo_fork_by_name: false,
            repo_star: false,
            repo_readme: false,
        }
    }

    /// What's built for a provider today. The single place to flip a GitLab /
    /// Bitbucket feature on as its impl lands — bump the flag here and the matching
    /// panel stops degrading to "coming soon".
    pub const fn for_provider(provider: Provider) -> Self {
        match provider {
            Provider::GitHub => Self::all(),
            // GitLab reads are fully wired — merge requests, issues, CI
            // pipelines, releases, and insights. WRITES land
            // per-action: issue + MR comment and close/reopen, the GitLab-only MR
            // approve/unapprove toggle, request-changes, and MR assignees, MR
            // merge, issue + MR labels, issue assignees, issue/MR create, issue +
            // MR title/body edit, issue milestone, award-emoji reactions, issue
            // lock / move / delete, the GitLab-unique confidential + due-date
            // fields, pipeline
            // retry / cancel / run, and release create / edit / delete / assets.
            Provider::GitLab => Self {
                pull_requests: true,
                issues: true,
                ci: true,
                releases: true,
                // The board's core charts are local git; the CI card rides the
                // forge pipeline read. The GitHub-only cards (community /
                // traffic / dependencies) hide per provider in the component.
                insights: true,
                // View/star (fork is a web link-out; branch-rule import stays
                // GitHub-only via a provider guard).
                repo_actions: true,
                publish: true,
                // The settings dialog: General + Danger zone (and the GitLab
                // sections as they land), gated by the Maintainer/Owner probe.
                repo_settings: true,
                issue_comment: true,
                issue_state: true,
                mr_comment: true,
                mr_state: true,
                mr_comment_edit: true,
                issue_comment_edit: true,
                mr_approve: true,
                mr_merge: true,
                mr_auto_merge: true,
                issue_labels: true,
                mr_labels: true,
                issue_assignees: true,
                issue_create: true,
                mr_create: true,
                ci_rerun: true,
                ci_cancel: true,
                ci_dispatch: true,
                release_create: true,
                release_edit: true,
                mr_assignees: true,
                mr_request_changes: true,
                // Reviewers ARE editable (MR `reviewer_ids`), separate from
                // assignees. ⚠ Free tier keeps only one reviewer — the setter
                // re-reads and discloses any dropped reviewer.
                mr_reviewers: true,
                issue_edit: true,
                mr_edit: true,
                issue_milestone: true,
                issue_reactions: true,
                mr_reactions: true,
                issue_lock: true,
                issue_transfer: true,
                issue_delete: true,
                issue_confidential: true,
                issue_due_date: true,
                ci_job_play: true,
                time_tracking: true,
                issue_links: true,
                // PR tasks are Bitbucket-only here.
                pr_tasks: false,
                // Review threads: read, reply, and resolve are all wired for GitLab
                // (positioned diff-note discussions; PUT resolves the discussion).
                mr_review_threads: true,
                mr_thread_reply: true,
                mr_thread_resolve: true,
                // Review-thread comment edit/delete: positioned notes reuse the MR
                // note endpoint.
                mr_thread_comment_edit: true,
                // Commit comments, new-thread create, and batched review submit are
                // all wired for GitLab.
                commit_comments: true,
                mr_thread_create: true,
                mr_review_submit: true,
                // Draft toggle both ways via `glab mr update --ready|--draft`.
                mr_draft_toggle: true,
                // Explore: repo search (`projects?search=`), fork-by-name (fork
                // POST), star (`projects/{id}/star`), and README (repository-files
                // raw) are all wired for GitLab.
                repo_search: true,
                repo_fork_by_name: true,
                repo_star: true,
                repo_readme: true,
            },
            // Bitbucket Cloud reads (Phase 3): PR list/view/diff, CI pipelines, and
            // repo View/URL are wired over direct HTTP. Phase 4 adds the WRITES: PR
            // comment, decline (`mr_state` = DECLINE only — Bitbucket can't reopen a
            // declined PR via API or web, so `forge_pr_reopen` errors and the frontend
            // hides the button), merge, title/body edit, create, and the bodyless
            // approve/unapprove toggle; plus pipeline rerun / cancel / dispatch.
            // The parity pass adds the request-changes TOGGLE (unlike GitLab,
            // Bitbucket's revoke works on every plan) and the reviewers picker
            // (`mr_reviewers` — workspace members, minus the author).
            // Everything else — issues (the native tracker sunsets 2026-08-20),
            // assignees/labels, releases, insights, settings — stays false, so
            // those panels degrade to "coming soon".
            Provider::Bitbucket => Self {
                pull_requests: true,
                ci: true,
                repo_actions: true,
                // Wave 2/3: the insights flag, publishing a local repo, and the
                // full repo-settings surface (admin probe + General / Danger zone +
                // default reviewers / branch restrictions / pipelines config,
                // variables, schedules / webhooks) are now wired over direct HTTP.
                insights: true,
                publish: true,
                repo_settings: true,
                mr_comment: true,
                mr_state: true,
                // PR-comment edit + delete are wired; issue_comment_edit stays false
                // (via `..Self::none()`) — Bitbucket's tracker is being retired.
                mr_comment_edit: true,
                mr_merge: true,
                mr_edit: true,
                mr_create: true,
                mr_approve: true,
                mr_request_changes: true,
                mr_reviewers: true,
                ci_rerun: true,
                ci_cancel: true,
                ci_dispatch: true,
                // Wave 4: the PR-tasks checklist (Bitbucket-native).
                pr_tasks: true,
                // Review threads: inline-comment reads + replies are wired; thread
                // RESOLUTION stays false — no comment-resolution field/endpoint was
                // found on any probed Bitbucket comment (`resolve_thread` errors).
                mr_review_threads: true,
                mr_thread_reply: true,
                // Review-thread comment edit/delete: inline comments are the same
                // comment objects as the conversation ones, so they reuse the PR
                // comment endpoints. (Thread RESOLUTION stays false above.)
                mr_thread_comment_edit: true,
                // Commit comments, new-thread create, and batched review submit are
                // all wired for Bitbucket.
                commit_comments: true,
                mr_thread_create: true,
                mr_review_submit: true,
                // Draft toggle both ways (PUT `draft`).
                mr_draft_toggle: true,
                // Explore: repo search (workspace-scoped `q=name~"…"`), fork-by-name
                // (forks POST), and README (`src/…`) are wired. `repo_star` stays
                // false (via `..Self::none()`) — Bitbucket Cloud has no stars.
                repo_search: true,
                repo_fork_by_name: true,
                repo_readme: true,
                ..Self::none()
            },
        }
    }
}

/// The provider-neutral analogue of `GhStatus`: is the hosted integration usable
/// for this repo, on which host, signed in as whom, and what does it support. The
/// frontend gates hosted features on this instead of a GitHub-only readiness
/// check, so the same panels light up for any provider.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ForgeStatus {
    /// The detected provider, or `None` when the repo has no recognized hosted
    /// remote (a purely-local repo, or a host we don't support).
    pub provider: Option<Provider>,
    /// The provider's tooling/credential is available (its CLI is installed, or an
    /// HTTP token is configured).
    pub installed: bool,
    /// Signed in on this repo's host.
    pub authenticated: bool,
    /// `"owner/name"` (or `"group/subgroup/name"` on GitLab) when recognized.
    pub repo: Option<String>,
    /// The repo's host — `"github.com"`, an Enterprise/self-managed server,
    /// `"gitlab.com"`, `"bitbucket.org"` — when known.
    pub host: Option<String>,
    /// The active account's login on this repo's host, when determinable.
    pub login: Option<String>,
    /// What this provider/repo supports — drives capability-gated UI.
    pub capabilities: Capabilities,
    /// Which of those capabilities GitDesktop has actually built for this provider
    /// — drives per-feature "coming soon" gating distinct from `capabilities`.
    pub implemented: Implemented,
}

/// A provider user reference for pickers — a stable id plus a human label.
/// Bitbucket's reviewer picker is the emitter today (id = the braced account
/// uuid, label = display name / nickname): Bitbucket identity must travel as the
/// uuid because participant objects never carry `username`, and nicknames aren't
/// unique — the display string alone can't round-trip a mutation safely.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ForgeUserRef {
    pub id: String,
    pub label: String,
    /// The user's avatar URL when the provider supplies one (GitLab/Bitbucket
    /// return it directly). Empty for GitHub, where the picker derives the avatar
    /// from the login (`<host>/<login>.png`), so we don't spend a field on it.
    pub avatar_url: String,
    /// True for a bot requested reviewer (e.g. GitHub Copilot). Bot reviewers are
    /// display-only: they are never part of the editable picker's managed set and
    /// the reviewer setters never add or remove them.
    pub is_bot: bool,
}

/// A reviewer who has submitted a verdict (GitLab approval/requested-changes,
/// Bitbucket participant state). GitHub derives its own completed reviewers on
/// the frontend from `reviews`, so it leaves this empty.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CompletedReviewerOut {
    pub user: ForgeUserRef,
    /// Uppercased: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED".
    pub state: String,
}

/// A repository as listed for cloning — neutral across providers (the clone
/// browser's row). GitHub fields map 1:1 from `GhRepo`; GitLab fills it from a
/// `glab` project.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ForgeRepo {
    /// "owner/name" (GitHub) or "group/subgroup/name" (GitLab).
    pub full_name: String,
    /// The owning user/org/group namespace.
    pub owner: String,
    pub name: String,
    pub private: bool,
    pub archived: bool,
    pub fork: bool,
    /// HTTPS clone URL.
    pub clone_url: String,
    /// SSH clone URL.
    pub ssh_url: String,
    pub description: Option<String>,
    /// ISO-8601 last-activity/push time, for recency sorting.
    pub pushed_at: Option<String>,
}

/// The signed-in user's repositories on a provider, for the clone browser.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ForgeRepoList {
    /// The signed-in user's login, so the UI lists their own repos first.
    pub viewer: String,
    pub repos: Vec<ForgeRepo>,
}

/// One search-result repository for the Explore view — a superset of [`ForgeRepo`]
/// carrying the extra columns a discovery/browse row shows (stars, language, the
/// web URL, the default branch). Each provider maps its own search payload onto it.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ForgeSearchRepo {
    /// "owner/name" (GitHub / Bitbucket) or "group/subgroup/name" (GitLab).
    pub full_name: String,
    pub owner: String,
    pub name: String,
    pub private: bool,
    pub archived: bool,
    pub fork: bool,
    /// HTTPS clone URL.
    pub clone_url: String,
    /// SSH clone URL — empty string when the provider doesn't supply one.
    pub ssh_url: String,
    pub description: Option<String>,
    /// The provider's last-activity time (GitHub `pushed_at` / GitLab
    /// `last_activity_at` / Bitbucket `updated_on`), for recency display.
    pub updated_at: Option<String>,
    pub stars: Option<u64>,
    pub language: Option<String>,
    pub web_url: Option<String>,
    pub default_branch: Option<String>,
}

/// One page of [`ForgeSearchRepo`] results for the Explore view.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ForgeSearchList {
    pub repos: Vec<ForgeSearchRepo>,
    /// Whether another page is likely available (per-provider heuristic).
    pub has_more: bool,
    /// The total result count where the provider reports one (GitHub REST
    /// `total_count`); `None` on GitLab/Bitbucket, which don't.
    pub total: Option<u64>,
}

/// The outcome of forking a repo by name — the fork's identity plus a best-effort
/// readiness flag (fork creation is asynchronous on every provider).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ForgeForkResult {
    /// The fork's `owner/name` (or `group/…/name` on GitLab).
    pub full_name: String,
    /// HTTPS clone URL of the fork.
    pub clone_url: String,
    pub web_url: Option<String>,
    /// Whether the fork looked ready after a bounded readiness poll. `false` is not
    /// an error — the fork exists, it just may not be cloneable for a few more
    /// seconds.
    pub ready: bool,
}

/// A provider's static feature profile — its platform [`Capabilities`] plus what
/// GitDesktop has [`Implemented`] for it. Pure (no I/O), so the Explore view can
/// ask "does this provider support fork/star/search?" without a repo in hand.
#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct ProviderFeatures {
    pub capabilities: Capabilities,
    pub implemented: Implemented,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_supports_everything() {
        let c = Capabilities::for_provider(Provider::GitHub);
        assert!(c.discussions && c.labels && c.milestones && c.draft_prs && c.reactions && c.stars);
    }

    #[test]
    fn gitlab_has_everything_but_discussions() {
        let c = Capabilities::for_provider(Provider::GitLab);
        assert!(!c.discussions);
        assert!(c.labels && c.milestones && c.stars && c.reactions && c.approvals);
    }

    #[test]
    fn bitbucket_drops_unsupported_features() {
        let c = Capabilities::for_provider(Provider::Bitbucket);
        assert!(!c.labels && !c.milestones && !c.stars && !c.reactions && !c.discussions);
        // Issues are off — the native tracker sunsets 2026-08-20.
        assert!(!c.issues);
        // …but the core flow still works, and draft PRs are supported.
        assert!(c.pull_requests && c.ci && c.webhooks && c.approvals && c.draft_prs);
    }

    #[test]
    fn none_supports_nothing() {
        let c = Capabilities::none();
        assert!(!c.pull_requests && !c.issues && !c.ci && !c.webhooks);
    }

    #[test]
    fn github_has_everything_implemented() {
        let i = Implemented::for_provider(Provider::GitHub);
        assert!(i.pull_requests && i.issues && i.ci && i.releases && i.insights);
        assert!(i.repo_actions && i.publish);
        // The lone exception: the bodyless approve/unapprove toggle is GitLab-only
        // (GitHub approves via the review flow), so GitHub leaves `mr_approve` false.
        assert!(!i.mr_approve);
        // Auto-merge (MWPS) is a GitLab-only control too — no in-app GitHub PR
        // auto-merge here, so GitHub stays false.
        assert!(!i.mr_auto_merge);
        // Labels (issue + MR) and issue assignees are shared controls — built for both.
        assert!(i.issue_labels && i.mr_labels && i.issue_assignees);
        // MR/PR assignees are a shared control too (GitHub PRs are issues under the hood).
        assert!(i.mr_assignees);
        assert!(i.issue_create && i.mr_create);
        // CI actions and release management are shared controls too.
        assert!(i.ci_rerun && i.ci_cancel && i.ci_dispatch);
        assert!(i.release_create && i.release_edit);
        // Request-changes mirrors mr_approve: a forge-only control (GitHub's
        // analogue lives in its own Review menu), so it stays false. The reviewers
        // picker, though, IS built for GitHub (`gh pr edit --add/--remove-reviewer`).
        assert!(!i.mr_request_changes && i.mr_reviewers);
        // Title/body editing, issue milestones, and reactions are shared controls.
        assert!(i.issue_edit && i.mr_edit && i.issue_milestone);
        assert!(i.issue_reactions && i.mr_reactions);
        // CI job play, time tracking, and issue links mirror mr_approve: GitLab-only
        // (GitHub has no per-job manual play, native time tracking, or issue links),
        // so GitHub stays false.
        assert!(!i.ci_job_play && !i.time_tracking && !i.issue_links);
        // PR tasks are a Bitbucket-only surface here, so GitHub stays false too.
        assert!(!i.pr_tasks);
        // Review threads: read, reply, and resolve are all built for GitHub.
        assert!(i.mr_review_threads && i.mr_thread_reply && i.mr_thread_resolve);
        // Commit comments, new-thread create, and batched review submit — all three.
        assert!(i.commit_comments && i.mr_thread_create && i.mr_review_submit);
        // The draft toggle stays false for GitHub — its Ready/Convert path goes via
        // `gh pr ready [--undo]` gated on canWrite, not this flag.
        assert!(!i.mr_draft_toggle);
        // Explore: repo search, fork-by-name, star, and README are all built for GitHub.
        assert!(i.repo_search && i.repo_fork_by_name && i.repo_star && i.repo_readme);
    }

    #[test]
    fn gitlab_implements_mr_issue_ci_and_release_reads_so_far() {
        // GitLab is platform-capable of PRs/issues/CI (capabilities); merge request,
        // issue, CI-pipeline, and release reads are built, so only insights / repo
        // actions still degrade to "coming soon" even when the repo is ready.
        let cap = Capabilities::for_provider(Provider::GitLab);
        let imp = Implemented::for_provider(Provider::GitLab);
        assert!(cap.pull_requests && imp.pull_requests);
        assert!(cap.issues && imp.issues);
        assert!(cap.ci && imp.ci);
        assert!(imp.releases);
        // Every panel is wired now — insights (local charts + CI card), repo
        // actions (view/star), and publish.
        assert!(imp.insights && imp.repo_actions && imp.publish);
        // First WRITES: issue + MR comment and close/reopen are wired up for GitLab,
        // plus the GitLab-only MR approve/unapprove toggle and MR merge.
        assert!(imp.issue_comment && imp.issue_state);
        assert!(imp.mr_comment && imp.mr_state && imp.mr_approve && imp.mr_merge);
        // …plus comment edit/delete on both MR and issue comments.
        assert!(imp.mr_comment_edit && imp.issue_comment_edit);
        // …plus the GitLab-only auto-merge (MWPS) arm/cancel control.
        assert!(imp.mr_auto_merge);
        // Labels (issue + MR) and issue assignees now wired for GitLab too.
        assert!(imp.issue_labels && imp.mr_labels && imp.issue_assignees);
        // …and creating issues + merge requests from the app.
        assert!(imp.issue_create && imp.mr_create);
        // …and pipeline retry/cancel/run, release management, and the GitLab-only
        // MR assignees picker.
        assert!(imp.ci_rerun && imp.ci_cancel && imp.ci_dispatch);
        assert!(imp.release_create && imp.release_edit);
        assert!(imp.mr_assignees);
        // …and title/body editing plus issue milestones.
        assert!(imp.issue_edit && imp.mr_edit && imp.issue_milestone);
        // …and the GitLab-only request-changes reviewer state.
        assert!(imp.mr_request_changes);
        // …and award-emoji reactions on issues and MRs.
        assert!(imp.issue_reactions && imp.mr_reactions);
        // …and the GitLab-only CI job play, time tracking, and issue links.
        assert!(imp.ci_job_play && imp.time_tracking && imp.issue_links);
        // PR tasks stay Bitbucket-only — not wired for GitLab.
        assert!(!imp.pr_tasks);
        // Review threads: read, reply, and resolve are all wired for GitLab.
        assert!(imp.mr_review_threads && imp.mr_thread_reply && imp.mr_thread_resolve);
        // …plus edit/delete on review-thread comments (positioned notes).
        assert!(imp.mr_thread_comment_edit);
        // …plus commit comments, new-thread create, and batched review submit.
        assert!(imp.commit_comments && imp.mr_thread_create && imp.mr_review_submit);
        // …and the draft toggle both ways (`glab mr update --ready|--draft`).
        assert!(imp.mr_draft_toggle);
        // Explore: repo search, fork-by-name, star, and README are all wired for GitLab.
        assert!(imp.repo_search && imp.repo_fork_by_name && imp.repo_star && imp.repo_readme);
    }

    #[test]
    fn bitbucket_implements_pr_and_ci_writes() {
        let gh = Implemented::for_provider(Provider::GitHub);
        assert!(gh.issue_comment && gh.issue_state && gh.mr_comment && gh.mr_state);
        // GitHub edits/deletes both PR and issue conversation comments, plus
        // review-thread comments (PullRequestReviewComment nodes).
        assert!(gh.mr_comment_edit && gh.issue_comment_edit && gh.mr_thread_comment_edit);
        // MR merge is a shared control (both providers); approve/unapprove is the one
        // GitLab-only write — GitHub approves via the review flow, not this toggle.
        assert!(gh.mr_merge && !gh.mr_approve);
        // Auto-merge is GitLab-only (no in-app GitHub PR auto-merge).
        assert!(!gh.mr_auto_merge);
        let bb = Implemented::for_provider(Provider::Bitbucket);
        // Bitbucket reads that ARE built (Phase 3): PRs, CI pipelines, repo actions.
        assert!(bb.pull_requests && bb.ci && bb.repo_actions);
        // Phase 4 PR writes: comment, decline (mr_state), merge, edit, create, and the
        // bodyless approve/unapprove toggle.
        assert!(bb.mr_comment && bb.mr_state && bb.mr_merge && bb.mr_edit && bb.mr_create);
        assert!(bb.mr_approve);
        // PR-comment edit/delete is wired; issue-comment edit stays off (no tracker).
        assert!(bb.mr_comment_edit && !bb.issue_comment_edit);
        // …the request-changes toggle and the reviewers picker (both Bitbucket
        // writes; GitLab's reviewer list stays unwired)…
        assert!(bb.mr_request_changes && bb.mr_reviewers);
        // …and pipeline rerun / cancel / dispatch.
        assert!(bb.ci_rerun && bb.ci_cancel && bb.ci_dispatch);
        // …plus wave 2/3: insights, publish, and the repo-settings surface.
        assert!(bb.insights && bb.publish && bb.repo_settings);
        // …and wave 4's Bitbucket-only PR-tasks checklist.
        assert!(bb.pr_tasks);
        // …but issues and releases stay off.
        assert!(!bb.issues && !bb.releases);
        assert!(!bb.issue_comment && !bb.issue_state);
        // Auto-merge has no Bitbucket analogue.
        assert!(!bb.mr_auto_merge);
        assert!(!bb.issue_labels && !bb.mr_labels && !bb.issue_assignees);
        assert!(!bb.issue_create);
        assert!(!bb.release_create && !bb.release_edit && !bb.mr_assignees);
        assert!(!bb.issue_edit && !bb.issue_milestone);
        assert!(!bb.issue_reactions && !bb.mr_reactions);
        assert!(!bb.ci_job_play && !bb.time_tracking && !bb.issue_links);
        // Review threads: inline reads + replies are wired; resolution is NOT
        // (no comment-resolution field/endpoint found on any probed Bitbucket comment).
        assert!(bb.mr_review_threads && bb.mr_thread_reply);
        assert!(!bb.mr_thread_resolve);
        // …but review-thread comment edit/delete IS wired (inline comments reuse the
        // PR comment endpoints).
        assert!(bb.mr_thread_comment_edit);
        // …plus commit comments, new-thread create, and batched review submit.
        assert!(bb.commit_comments && bb.mr_thread_create && bb.mr_review_submit);
        // …and the draft toggle both ways (PUT `draft`).
        assert!(bb.mr_draft_toggle);
        // GitHub keeps the draft toggle off (its Ready/Convert path is gh-native).
        assert!(!gh.mr_draft_toggle);
        // Explore: repo search, fork-by-name, and README are wired for Bitbucket;
        // star is NOT (Bitbucket Cloud has no stars).
        assert!(bb.repo_search && bb.repo_fork_by_name && bb.repo_readme);
        assert!(!bb.repo_star);
    }
}
