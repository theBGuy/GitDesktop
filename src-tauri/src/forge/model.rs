//! The neutral, provider-agnostic data model the `Forge` abstraction speaks in:
//! host-independent types each `Forge` impl maps its provider's API onto, so panels
//! don't branch per provider. PR/issue payloads are the exception — they still ride
//! GitHub's own shapes in `github::pr` / `github::issue`.

use serde::{Deserialize, Serialize};

/// Which hosting platform backs a repo's hosted features.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    GitHub,
    GitLab,
    Bitbucket,
}

/// What a provider (and this repo on it) actually supports, so the UI shows only the
/// controls that work instead of erroring. The platforms are NOT feature-identical —
/// Bitbucket Cloud has no labels/milestones/stars, GitLab has no Discussions — so
/// panels gate on these flags rather than assuming GitHub. GitHub is all-true.
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
    /// Reading the repo's vulnerability findings — from each platform's own
    /// source: GitHub's alert APIs (Dependabot, code scanning, secret scanning +
    /// repository advisories), and on GitLab the SAST / secret-detection /
    /// code-quality report artifacts a CI pipeline publishes (readable on every
    /// tier, unlike GitLab's own Ultimate-gated dashboard). Bitbucket Cloud has
    /// no analogue.
    pub security_findings: bool,
}

impl Capabilities {
    /// The static capability profile for a provider (refined per-repo later, e.g.
    /// a Bitbucket repo with issues disabled). Mirrors the parity matrix in
    /// `docs/multi-provider-support.md` §6.
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
                security_findings: true,
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
                security_findings: true,
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
                security_findings: false,
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
            security_findings: false,
        }
    }
}

/// Which hosted features GitDesktop has actually BUILT for a provider — a different
/// axis from [`Capabilities`] (what the PLATFORM can do). A panel lights up only when
/// the repo is ready AND the platform supports the feature AND it's implemented here,
/// so a ready GitLab repo degrades unbuilt panels to "coming soon" instead of firing
/// `gh_*` calls that would break. Mirrored in the frontend as
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
    // ── Writes (per-action): flip on as each mutation lands, so a read-only provider
    //    suppresses just the writes it can't do yet. ──
    /// Posting a comment/note on an issue.
    pub issue_comment: bool,
    /// Closing / reopening an issue.
    pub issue_state: bool,
    /// Posting a comment/note on a merge/pull request.
    pub mr_comment: bool,
    /// Closing / reopening a merge/pull request (not merge).
    pub mr_state: bool,
    /// Editing AND deleting a merge/pull request conversation comment — one flag for
    /// both ops. True for all three providers.
    pub mr_comment_edit: bool,
    /// Editing AND deleting an issue conversation comment — one flag for both ops.
    /// False for Bitbucket (its native tracker is being retired).
    pub issue_comment_edit: bool,
    /// Approving / unapproving a merge request via the bodyless toggle. GitLab and
    /// Bitbucket share it; GitHub surfaces approval through the review flow (the
    /// Review menu) instead — one of the three writes whose GitHub analogue lives
    /// elsewhere (see `all`).
    pub mr_approve: bool,
    /// Merging a merge/pull request (strategy + delete-source-branch). A shared
    /// control on all three providers.
    pub mr_merge: bool,
    /// Arming/cancelling GitLab auto-merge (merge-when-pipeline-succeeds).
    /// GitLab-only — this app has no in-app GitHub PR auto-merge control.
    pub mr_auto_merge: bool,
    /// Editing labels on an issue — a shared control (GitHub by node id, GitLab by
    /// name), so true for both.
    pub issue_labels: bool,
    /// Editing labels on a merge/pull request — the same shared label control.
    pub mr_labels: bool,
    /// Setting an issue's assignees — a shared issue control. (MR/PR assignees are
    /// the separate `mr_assignees` below — a shared control for GitHub and GitLab.)
    pub issue_assignees: bool,
    /// Creating an issue from the app — a shared control (the GitHub-only org issue
    /// type hides per provider; milestone works on both).
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
    /// Requesting changes — the blocking reviewer state. GitLab and Bitbucket share the
    /// control; GitHub does it through its Review menu, so the flag stays `false` there.
    pub mr_request_changes: bool,
    /// Editing a merge/pull request's reviewer list — shared by all three (GitHub
    /// `gh pr edit --add/--remove-reviewer`, GitLab `reviewer_ids`, Bitbucket workspace
    /// members). Each arm PRESERVES the reviewers it doesn't manage (teams / bots on
    /// GitHub) so the picker can never drop them.
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
    /// Reactions on an issue and its comments (GitHub reacts by GraphQL node id, GitLab
    /// awards emoji by issue/note id).
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
    /// Marking an issue confidential (members-only). GitLab-unique — GitHub has no
    /// confidential-issue concept, so `false` there.
    pub issue_confidential: bool,
    /// Setting / clearing an issue's due date. GitLab-unique — GitHub issues
    /// have no due dates, so the flag stays `false` for GitHub (see `all`).
    pub issue_due_date: bool,
    /// Playing a manual CI job (`when: manual`). GitLab-unique — GitHub Actions has no
    /// per-job manual play.
    pub ci_job_play: bool,
    /// Time tracking on issues and merge requests (estimate + spent). GitLab-unique.
    pub time_tracking: bool,
    /// Related issues (issue links). GitLab-unique — GitHub has no native issue
    /// links, so like `mr_approve` this stays `false` for GitHub (see `all`).
    pub issue_links: bool,
    /// The pull-request tasks checklist (create/edit/resolve/delete). Bitbucket-native
    /// — no GitHub/GitLab analogue wired here.
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
    /// Editing AND deleting a file:line-anchored review-thread comment — one flag for
    /// both ops, separate from `mr_comment_edit` (flat conversation comments). True for
    /// all three (GitHub PullRequestReviewComment mutations; GitLab/Bitbucket reuse
    /// their note/comment endpoints).
    pub mr_thread_comment_edit: bool,
    /// Reading + writing comments on an individual commit (whole-commit and
    /// file:line-anchored). All three providers wire it (GitHub commit-comments REST,
    /// GitLab commit discussions, Bitbucket commit comments), so it's true for each.
    pub commit_comments: bool,
    /// Creating a NEW file:line-anchored review thread (vs replying in one —
    /// `mr_thread_reply`). True for all three.
    pub mr_thread_create: bool,
    /// Submitting a batched review (summary + inline comments + verdict) in one action.
    /// True for all three.
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
    /// Forking a repo by `owner/name` (Explore's Fork, distinct from the current-repo
    /// fork). Wired for all three.
    pub repo_fork_by_name: bool,
    /// Starring / unstarring a repo by its `owner/name` from Explore, plus the
    /// starred-state read. GitHub and GitLab both have a star API; Bitbucket Cloud
    /// has no stars, so it stays `false` there.
    pub repo_star: bool,
    /// Reading a repo's README for the Explore preview. Wired for all three.
    pub repo_readme: bool,
}

impl Implemented {
    /// The GitHub reference profile. Not literally everything: controls whose GitHub
    /// analogue lives elsewhere (`mr_approve`, `mr_request_changes`, `mr_draft_toggle`
    /// — the Review menu / `gh pr ready`) and the GitLab- or Bitbucket-unique ones stay
    /// `false`; each is explained at its field.
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
            mr_assignees: true,
            mr_request_changes: false,
            mr_reviewers: true,
            issue_edit: true,
            mr_edit: true,
            issue_milestone: true,
            issue_reactions: true,
            mr_reactions: true,
            issue_lock: true,
            issue_transfer: true,
            issue_delete: true,
            issue_confidential: false,
            issue_due_date: false,
            ci_job_play: false,
            time_tracking: false,
            issue_links: false,
            pr_tasks: false,
            // Review threads: read + reply are shared; GitHub resolves threads too.
            mr_review_threads: true,
            mr_thread_reply: true,
            mr_thread_resolve: true,
            mr_thread_comment_edit: true,
            commit_comments: true,
            mr_thread_create: true,
            mr_review_submit: true,
            mr_draft_toggle: false,
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
            // GitLab: reads fully wired; writes land per-action — the flags below are
            // the source of truth (don't re-enumerate them here).
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
            // Bitbucket Cloud: PRs, pipelines, repo actions, publish, the repo-settings
            // surface, and the PR-write set are wired over direct HTTP — the flags below
            // are the source of truth. `mr_state` is DECLINE only: a declined PR can't
            // be reopened via API or web (BCLOUD-4954), so `forge_pr_reopen` errors and
            // the frontend hides the button. Issues stay false — the native tracker
            // sunsets 2026-08-20.
            Provider::Bitbucket => Self {
                pull_requests: true,
                ci: true,
                repo_actions: true,
                // Insights, publishing a local repo, and the full repo-settings surface
                // (admin probe + General / Danger zone + default reviewers / branch
                // restrictions / pipelines config, variables, schedules / webhooks) are
                // wired over direct HTTP.
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
                pr_tasks: true,
                // Review threads: inline-comment reads + replies are wired; thread
                // RESOLUTION stays false — no comment-resolution field/endpoint was
                // found on any probed Bitbucket comment (`resolve_thread` errors).
                mr_review_threads: true,
                mr_thread_reply: true,
                mr_thread_comment_edit: true,
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

/// The provider-neutral analogue of `GhStatus`: is the hosted integration usable for
/// this repo, on which host, signed in as whom, and what does it support. The frontend
/// gates hosted features on this, not a GitHub-only readiness check.
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

/// A provider user reference — a stable id plus a human label — for pickers,
/// read-only chips, and timeline actors. Bitbucket identity must travel as the
/// braced account uuid (id) with the display name / nickname as the label:
/// participant objects never carry `username`, and nicknames aren't unique, so
/// the display string alone can't round-trip a mutation safely. GitHub and GitLab
/// put the login/username in both fields.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ForgeUserRef {
    pub id: String,
    pub label: String,
    /// The user's avatar URL whenever the source supplies one — GitLab/Bitbucket
    /// return it on every user, and the GitHub timeline reads `actor.avatarUrl`.
    /// Empty means the frontend derives it from the login on GitHub
    /// (`<host>/<login>.png`) and falls back to initials elsewhere, so an emitter
    /// with no URL to hand leaves it empty rather than guessing one.
    pub avatar_url: String,
    /// True for a bot account — a bot requested reviewer (e.g. GitHub Copilot), or
    /// a timeline actor whose GraphQL `__typename` is `Bot`. Bot reviewers are
    /// display-only: they are never part of the editable picker's managed set and
    /// the reviewer setters never add or remove them.
    pub is_bot: bool,
}

/// One activity-timeline event on a merge/pull request or an issue, a tagged union
/// keyed on `kind` (camelCase). The backend maps a GitHub `timelineItems`
/// `__typename` (or a GitLab/Bitbucket event) onto a variant; an unclassifiable node
/// is skipped, never a panic. Every `date`/string defaults to `""` for provider
/// nulls, so a field is absent-as-empty rather than missing — `Merged.commit_oid` is
/// the one exception, an `Option` that is genuinely absent from the wire when unset.
///
/// `rename_all` renames VARIANT tags only, so `rename_all_fields` is load-bearing
/// for the TS mirror (`src/lib/git/types.ts`): without it `Merged.commit_oid` reaches
/// TS as `undefined` and a merged PR silently loses its merge commit.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ForgeTimelineEventOut {
    /// `HeadRefForcePushedEvent` — the head branch was force-pushed.
    ForcePushed {
        before: String,
        after: String,
        actor: ForgeUserRef,
        date: String,
    },
    /// `LabeledEvent` (`added = true`) / `UnlabeledEvent` (`added = false`).
    Labeled {
        label: String,
        color: String,
        added: bool,
        actor: ForgeUserRef,
        date: String,
    },
    /// `ReviewRequestedEvent` — `reviewer` is a user login OR a team slug.
    ReviewRequested {
        reviewer: String,
        actor: ForgeUserRef,
        date: String,
    },
    /// `ReadyForReviewEvent` — a draft was marked ready.
    ReadyForReview { actor: ForgeUserRef, date: String },
    /// `ConvertToDraftEvent` — the PR was converted back to a draft.
    ConvertToDraft { actor: ForgeUserRef, date: String },
    /// `ClosedEvent` — the PR/issue was closed (without merging). `state_reason` is
    /// GitHub's issue close reason lowercased ("completed" / "not_planned" /
    /// "duplicate"); `""` for PRs and for the other providers, which report none.
    Closed {
        actor: ForgeUserRef,
        state_reason: String,
        date: String,
    },
    /// `ReopenedEvent` — a closed PR/issue was reopened.
    Reopened { actor: ForgeUserRef, date: String },
    /// `MergedEvent` — `commit_oid` is the merge commit (may be `None`).
    Merged {
        actor: ForgeUserRef,
        #[serde(skip_serializing_if = "Option::is_none")]
        commit_oid: Option<String>,
        date: String,
    },
    /// `RenamedTitleEvent` — the title changed.
    Renamed {
        previous: String,
        current: String,
        actor: ForgeUserRef,
        date: String,
    },
    /// An approval was given. GitHub surfaces approvals through the review flow
    /// (they render as review cards), so its own timeline never emits this — it's
    /// produced by the GitLab (system-note "approved") and Bitbucket (`approval`
    /// activity) arms, whose approvals carry no reviewable body.
    Approved { actor: ForgeUserRef, date: String },
    /// A "request changes" verdict without an accompanying review card. Emitted by
    /// the GitLab (system-note "requested changes") and Bitbucket (`changes_requested`
    /// activity) arms; GitHub renders its request-changes reviews as cards instead.
    ChangesRequested { actor: ForgeUserRef, date: String },
    /// A previously-given approval was withdrawn (GitLab system-note "unapproved";
    /// Bitbucket has no explicit unapproval activity). GitHub never emits it.
    Unapproved { actor: ForgeUserRef, date: String },
    /// `AssignedEvent` (`added = true`) / `UnassignedEvent` (`added = false`).
    Assigned {
        assignee: String,
        added: bool,
        actor: ForgeUserRef,
        date: String,
    },
    /// `MilestonedEvent` (`added = true`) / `DemilestonedEvent` (`added = false`).
    Milestoned {
        milestone: String,
        added: bool,
        actor: ForgeUserRef,
        date: String,
    },
    /// `CrossReferencedEvent` — another PR/issue mentioned this one. `source_kind` is
    /// `"pr"` / `"issue"` (`""` when unrecognized) and `source_repo` is the referring
    /// entity's `owner/name`: a cross-reference can live in ANOTHER repository, so the
    /// number alone can't address it.
    CrossReferenced {
        source_kind: String,
        source_number: u64,
        source_title: String,
        source_repo: String,
        will_close: bool,
        actor: ForgeUserRef,
        date: String,
    },
    /// `ConnectedEvent` (`added = true`) / `DisconnectedEvent` (`added = false`) — a
    /// PR/issue link was made or broken. Same `source_*` shape (and cross-repo caveat)
    /// as [`ForgeTimelineEventOut::CrossReferenced`].
    Connected {
        source_kind: String,
        source_number: u64,
        source_title: String,
        source_repo: String,
        added: bool,
        actor: ForgeUserRef,
        date: String,
    },
    /// `PinnedEvent` (`added = true`) / `UnpinnedEvent` (`added = false`).
    Pinned {
        added: bool,
        actor: ForgeUserRef,
        date: String,
    },
    /// `LockedEvent` (`locked = true`) / `UnlockedEvent` (`locked = false`). `reason`
    /// is GitHub's lock reason lowercased, `""` when none was given or on unlock.
    Locked {
        locked: bool,
        reason: String,
        actor: ForgeUserRef,
        date: String,
    },
    /// `TransferredEvent` — the issue moved here from `from_repo` (`owner/name`).
    Transferred {
        from_repo: String,
        actor: ForgeUserRef,
        date: String,
    },
    /// `MarkedAsDuplicateEvent` — closed as a duplicate of the canonical entity.
    /// `canonical_repo` carries its `owner/name` for the same cross-repo reason as
    /// [`ForgeTimelineEventOut::CrossReferenced`].
    MarkedAsDuplicate {
        canonical_kind: String,
        canonical_number: u64,
        canonical_repo: String,
        actor: ForgeUserRef,
        date: String,
    },
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

/// A repository row for the clone browser — neutral across providers.
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
    /// The signed-in user's login. Kept on the wire; no frontend consumer today.
    pub viewer: String,
    /// The [`ForgeRepo::owner`] namespaces that count as the viewer's own — a SET
    /// because "yours" is provider-shaped: a login on GitHub and GitLab, but any
    /// workspace you belong to on Bitbucket, where the login resolves to the account's
    /// username or display name while repo owners are workspace slugs — separate
    /// namespaces that don't line up. Drives the own-repo Fork gate and the yours-first
    /// grouping; empty means unresolved, so both fail open.
    pub owned_namespaces: Vec<String>,
    pub repos: Vec<ForgeRepo>,
}

/// The [`ForgeRepoList::owned_namespaces`] set, with blanks dropped: every provider's
/// viewer/slug probe ends in `unwrap_or_default`, and `ForgeRepo::owner` does too, so
/// an empty namespace in the set would match an unresolved repo and hide its Fork
/// instead of falling open.
pub fn namespace_set(names: impl IntoIterator<Item = String>) -> Vec<String> {
    names.into_iter().filter(|n| !n.is_empty()).collect()
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

    /// The clone browser and Explore key off these exact wire names; a TS mirror that
    /// misses `ownedNamespaces` reads `undefined` silently, so pin the whole shape.
    #[test]
    fn repo_list_serializes_camel_case_wire_keys() {
        let value = serde_json::to_value(ForgeRepoList {
            viewer: "evangoldberg98".into(),
            owned_namespaces: vec!["thebguy1".into(), "betabotsllc".into()],
            repos: vec![],
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "viewer": "evangoldberg98",
                "ownedNamespaces": ["thebguy1", "betabotsllc"],
                "repos": [],
            })
        );
    }

    /// A provider whose viewer/workspace probe failed contributes nothing to the set:
    /// an empty namespace would match a repo whose own `owner` fell back to "".
    #[test]
    fn namespace_set_drops_unresolved_probes() {
        assert_eq!(namespace_set(["".to_string()]), Vec::<String>::new());
        assert_eq!(
            namespace_set(["".to_string(), "octocat".to_string()]),
            vec!["octocat".to_string()]
        );
    }

    fn actor(login: &str) -> ForgeUserRef {
        ForgeUserRef {
            id: login.to_string(),
            label: login.to_string(),
            avatar_url: format!("https://avatars/{login}.png"),
            is_bot: false,
        }
    }

    /// Pins the IPC contract with the TS mirror (src/lib/git/types.ts): `commit_oid` is
    /// the variant's multi-word field (read as `commitOid`), and `actor` is a nested
    /// object whose own keys are camelCase too.
    #[test]
    fn merged_timeline_event_wire_shape_is_camel_case() {
        let merged = serde_json::to_value(ForgeTimelineEventOut::Merged {
            actor: actor("alice"),
            commit_oid: Some("deadbeef".to_string()),
            date: "2026-05-12T12:01:23Z".to_string(),
        })
        .expect("Merged serializes");
        let obj = merged.as_object().expect("Merged is a JSON object");
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["actor", "commitOid", "date", "kind"]);
        assert_eq!(obj["kind"], "merged");
        assert_eq!(obj["commitOid"], "deadbeef");
        assert!(
            obj.get("commit_oid").is_none(),
            "snake_case field must not ship"
        );
        let mut actor_keys: Vec<&str> = obj["actor"]
            .as_object()
            .expect("actor is a JSON object")
            .keys()
            .map(String::as_str)
            .collect();
        actor_keys.sort_unstable();
        assert_eq!(actor_keys, ["avatarUrl", "id", "isBot", "label"]);
    }

    /// The ref-carrying variants have the most multi-word fields, so they're the
    /// tightest check that `rename_all_fields` still covers a NEW variant.
    #[test]
    fn cross_referenced_wire_shape_is_camel_case() {
        let value = serde_json::to_value(ForgeTimelineEventOut::CrossReferenced {
            source_kind: "pr".to_string(),
            source_number: 42,
            source_title: "Fix the thing".to_string(),
            source_repo: "octocat/hello".to_string(),
            will_close: true,
            actor: actor("alice"),
            date: "2026-05-12T12:01:23Z".to_string(),
        })
        .expect("CrossReferenced serializes");
        let obj = value.as_object().expect("CrossReferenced is a JSON object");
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "actor",
                "date",
                "kind",
                "sourceKind",
                "sourceNumber",
                "sourceRepo",
                "sourceTitle",
                "willClose",
            ]
        );
        assert_eq!(obj["kind"], "crossReferenced");
    }

    /// `state_reason` always ships (no skip), so the issue view can distinguish a
    /// "closed as not planned" from a plain close without a second read.
    #[test]
    fn closed_timeline_event_serializes_state_reason() {
        let value = serde_json::to_value(ForgeTimelineEventOut::Closed {
            actor: actor("alice"),
            state_reason: "not_planned".to_string(),
            date: "2026-05-12T12:01:23Z".to_string(),
        })
        .expect("Closed serializes");
        let obj = value.as_object().expect("Closed is a JSON object");
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["actor", "date", "kind", "stateReason"]);
        assert_eq!(obj["kind"], "closed");
        assert_eq!(obj["stateReason"], "not_planned");
        // The empty (PR / non-GitHub) case still ships the key.
        let empty = serde_json::to_value(ForgeTimelineEventOut::Closed {
            actor: actor("alice"),
            state_reason: String::new(),
            date: String::new(),
        })
        .expect("Closed serializes");
        assert_eq!(empty["stateReason"], "");
    }

    #[test]
    fn github_supports_everything() {
        let c = Capabilities::for_provider(Provider::GitHub);
        assert!(c.discussions && c.labels && c.milestones && c.draft_prs && c.reactions && c.stars);
        assert!(c.security_findings);
    }

    #[test]
    fn gitlab_has_everything_but_discussions() {
        let c = Capabilities::for_provider(Provider::GitLab);
        assert!(!c.discussions);
        assert!(c.labels && c.milestones && c.stars && c.reactions && c.approvals);
        // Findings come from the pipeline's report artifacts, not an alert API.
        assert!(c.security_findings);
    }

    #[test]
    fn bitbucket_drops_unsupported_features() {
        let c = Capabilities::for_provider(Provider::Bitbucket);
        assert!(!c.labels && !c.milestones && !c.stars && !c.reactions && !c.discussions);
        assert!(!c.security_findings);
        // Issues are off — the native tracker sunsets 2026-08-20.
        assert!(!c.issues);
        // …but the core flow still works, and draft PRs are supported.
        assert!(c.pull_requests && c.ci && c.webhooks && c.approvals && c.draft_prs);
    }

    #[test]
    fn none_supports_nothing() {
        let c = Capabilities::none();
        assert!(!c.pull_requests && !c.issues && !c.ci && !c.webhooks);
        assert!(!c.security_findings);
    }

    #[test]
    fn github_has_everything_implemented() {
        let i = Implemented::for_provider(Provider::GitHub);
        assert!(i.pull_requests && i.issues && i.ci && i.releases && i.insights);
        assert!(i.repo_actions && i.publish);
        // The GitHub `false`s mostly have their analogue elsewhere: approve /
        // request-changes live in GitHub's Review menu, draft toggle in
        // `gh pr ready [--undo]` gated on canWrite, and the rest are GitLab- or
        // Bitbucket-unique surfaces.
        assert!(!i.mr_approve);
        assert!(!i.mr_auto_merge);
        assert!(i.issue_labels && i.mr_labels && i.issue_assignees);
        assert!(i.mr_assignees);
        assert!(i.issue_create && i.mr_create);
        assert!(i.ci_rerun && i.ci_cancel && i.ci_dispatch);
        assert!(i.release_create && i.release_edit);
        assert!(!i.mr_request_changes && i.mr_reviewers);
        assert!(i.issue_edit && i.mr_edit && i.issue_milestone);
        assert!(i.issue_reactions && i.mr_reactions);
        assert!(!i.ci_job_play && !i.time_tracking && !i.issue_links);
        assert!(!i.pr_tasks);
        assert!(i.mr_review_threads && i.mr_thread_reply && i.mr_thread_resolve);
        assert!(i.commit_comments && i.mr_thread_create && i.mr_review_submit);
        assert!(!i.mr_draft_toggle);
        assert!(i.repo_search && i.repo_fork_by_name && i.repo_star && i.repo_readme);
    }

    #[test]
    fn gitlab_implements_mr_issue_ci_and_release_reads_so_far() {
        // GitLab is platform-capable of PRs/issues/CI; every panel is wired, and writes
        // land per-action.
        let cap = Capabilities::for_provider(Provider::GitLab);
        let imp = Implemented::for_provider(Provider::GitLab);
        assert!(cap.pull_requests && imp.pull_requests);
        assert!(cap.issues && imp.issues);
        assert!(cap.ci && imp.ci);
        assert!(imp.releases);
        assert!(imp.insights && imp.repo_actions && imp.publish);
        assert!(imp.issue_comment && imp.issue_state);
        assert!(imp.mr_comment && imp.mr_state && imp.mr_approve && imp.mr_merge);
        assert!(imp.mr_comment_edit && imp.issue_comment_edit);
        assert!(imp.mr_auto_merge);
        assert!(imp.issue_labels && imp.mr_labels && imp.issue_assignees);
        assert!(imp.issue_create && imp.mr_create);
        assert!(imp.ci_rerun && imp.ci_cancel && imp.ci_dispatch);
        assert!(imp.release_create && imp.release_edit);
        assert!(imp.mr_assignees);
        assert!(imp.issue_edit && imp.mr_edit && imp.issue_milestone);
        assert!(imp.mr_request_changes);
        assert!(imp.issue_reactions && imp.mr_reactions);
        assert!(imp.ci_job_play && imp.time_tracking && imp.issue_links);
        // PR tasks stay Bitbucket-only — not wired for GitLab.
        assert!(!imp.pr_tasks);
        assert!(imp.mr_review_threads && imp.mr_thread_reply && imp.mr_thread_resolve);
        assert!(imp.mr_thread_comment_edit);
        assert!(imp.commit_comments && imp.mr_thread_create && imp.mr_review_submit);
        assert!(imp.mr_draft_toggle);
        assert!(imp.repo_search && imp.repo_fork_by_name && imp.repo_star && imp.repo_readme);
    }

    #[test]
    fn bitbucket_implements_pr_and_ci_writes() {
        let gh = Implemented::for_provider(Provider::GitHub);
        assert!(gh.issue_comment && gh.issue_state && gh.mr_comment && gh.mr_state);
        // GitHub edits/deletes both PR and issue conversation comments, plus
        // review-thread comments (PullRequestReviewComment nodes).
        assert!(gh.mr_comment_edit && gh.issue_comment_edit && gh.mr_thread_comment_edit);
        // MR merge is shared by all three providers; the bodyless approve/unapprove
        // toggle is GitLab + Bitbucket — GitHub approves through the review flow, not
        // this toggle.
        assert!(gh.mr_merge && !gh.mr_approve);
        // Auto-merge is GitLab-only (no in-app GitHub PR auto-merge).
        assert!(!gh.mr_auto_merge);
        let bb = Implemented::for_provider(Provider::Bitbucket);
        // Bitbucket reads that ARE built: PRs, CI pipelines, repo actions.
        assert!(bb.pull_requests && bb.ci && bb.repo_actions);
        // PR writes: comment, decline (mr_state), merge, edit, create, and the
        // bodyless approve/unapprove toggle.
        assert!(bb.mr_comment && bb.mr_state && bb.mr_merge && bb.mr_edit && bb.mr_create);
        assert!(bb.mr_approve);
        // PR-comment edit/delete is wired; issue-comment edit stays off (no tracker).
        assert!(bb.mr_comment_edit && !bb.issue_comment_edit);
        // …the request-changes toggle and the reviewers picker…
        assert!(bb.mr_request_changes && bb.mr_reviewers);
        // …and pipeline rerun / cancel / dispatch.
        assert!(bb.ci_rerun && bb.ci_cancel && bb.ci_dispatch);
        // …plus insights, publish, and the repo-settings surface.
        assert!(bb.insights && bb.publish && bb.repo_settings);
        // …and the Bitbucket-only PR-tasks checklist.
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
