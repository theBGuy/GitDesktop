<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" alt="GitDesktop logo" width="88" height="88">
</p>

<h1 align="center">GitDesktop</h1>

<p align="center"><strong>An AI-native, keyboard-first Git desktop client</strong></p>

<p align="center">
  <a href="https://github.com/theBGuy/GitDesktop/releases/latest"><img alt="Download the latest release" src="https://img.shields.io/badge/Download-latest_release-4FE0C4?style=flat-square"></a>
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache_2.0-555?style=flat-square"></a>
  <img alt="Platforms: Windows, macOS, Linux" src="https://img.shields.io/badge/platforms-Windows_%7C_macOS_%7C_Linux-555?style=flat-square">
</p>

GitDesktop keeps GitHub Desktop's approachable model and goes further: the full
pull-request lifecycle in the app (including offline "local" PRs), a GitHub
Actions cockpit, and AI woven through commits, reviews, and CI debugging — with
the provider you choose, local models included.

Built with **Tauri 2 + React 19**. All GitHub access goes through the **GitHub
CLI (`gh`)**: no OAuth app, and the app never stores your tokens. Core git runs
against any remote via system `git`. Because everything follows `gh` — which
detects each repo's host from its remote — **GitHub Enterprise** servers work
the same as github.com once you've run `gh auth login --hostname <host>`, and
Settings → Accounts switches the active account per host.

![GitDesktop's Changes view: a split, syntax-highlighted diff on the right; the changes list, a stash browser, and an AI-generated commit message with co-authors on the left.](site/src/assets/app-staging.png)

## Install

**[Download the latest release →](https://github.com/theBGuy/GitDesktop/releases/latest)**
Pick the installer for your OS under **Assets**. Builds are signed and keep
themselves up to date (see [Updates](#updates)). Prefer to build from source? See
[Development](#development).

## Highlights

- **The whole PR lifecycle, in-app** — review, comment, label, **assign**,
  **request reviewers**, approve, edit, and merge (merge/squash/rebase) GitHub PRs
  without the browser — and set **labels and assignees** right when you **open** the
  PR/MR (GitHub and GitLab). Requesting reviewers works across GitHub, GitLab, and
  Bitbucket.
  A PR's Conversation is a **date-sorted activity feed** — reviews, comments,
  **pushed commits** (grouped, each SHA clickable to that commit), and events, with an
  **approval marked stale** once later commits land — now on **GitHub, GitLab, and
  Bitbucket** (GitLab MRs and Bitbucket PRs fold in commits, approvals/changes-requested,
  and close/reopen/merge; GitLab has no force-push or draft events, Bitbucket no
  labels or review-requests). **Local PRs** get the timeline too (created → pushed
  commits → comments → merged/closed). CI checks fold into a **pass/fail/pending rollup**
  that **peeks a failing job's log inline** without leaving the PR — for **GitHub Actions**
  and **GitLab pipeline** jobs alike; **Bitbucket** build statuses link out (name/state/URL,
  no fetchable logs).
  Plus **local PRs**: the same workflow against any two branches with no remote,
  promotable to a real GitHub PR (comments and all) in one click. A local-PR
  merge **pre-shows whether it will conflict**, and if it does you resolve the
  conflicts in an **in-app editor** — in an isolated worktree that never touches
  your branch or working tree — then **Finish** (commit + mark merged) or
  **Abort**.
- **Issues & Discussions, in-app** — triage GitHub issues (types, sub-issues,
  dependencies, linked PRs and branches) and Discussions without the browser, plus
  private **local to-dos** that need no remote.
- **GitHub Actions cockpit** — browse runs, drill into jobs and steps, re-run (all
  or failed), cancel, dispatch a workflow, and read failed-step logs — none of
  which GitHub Desktop does.
- **GitLab too** — via the **GitLab CLI (`glab`)**, browse and clone your GitLab
  projects and read **merge requests**, **issues**, **CI pipelines**, and
  **releases** in the same panels: lists, plus detail views (MR
  comments/commits/diff; issue conversation with a labels/assignees/milestone rail;
  pipeline jobs with logs and a branch CI badge; release notes with asset links). And
  GitLab **writes** — **comment** on (and **edit / delete** your own comments) and
  **close / reopen** a GitLab issue
  **or merge request**, **edit titles and descriptions**, **react** with emoji
  (award emoji on descriptions and comments), edit **labels** and
  **assignees** (issues *and* MRs), set an issue's **milestone**,
  **approve / unapprove**, **request changes on**, and **merge** (merge/squash) an
  MR — including **auto-merge** (merge when the pipeline succeeds, cancelable in
  place) while a pipeline is running, **create issues and
  merge requests** (push-and-open, drafts included, duplicate-MR detection —
  publishing local issues/PRs to
  GitLab works too), **lock / unlock** an issue's conversation, **move** an issue
  to another project, **delete** an issue, set an issue's **due date** (with a
  past-due cue) or mark it **confidential**, **track time** (estimate + spent) on
  an issue *or* MR and **link related issues** (all GitLab-unique, right in the
  rail), **retry / cancel / run pipelines** (with CI/CD variables) and **play a
  manual pipeline job**, and
  **publish / edit / delete releases** with asset uploads, **star** the project
  ("View on GitLab" and a fork link too), and **publish a local repo to GitLab**
  (create + push, straight from the app) — right from the app. **Project settings**
  too: the same settings dialog manages a GitLab project's **General** settings
  (description, topics, default branch, feature access levels, merge method and
  squash policy), **Members**, **Protected branches** (per-rule push/merge access
  levels and a force-push policy), **Webhooks** (with a delivery log and re-send),
  **CI/CD variables**, and the **Danger zone** (rename, archive, visibility,
  transfer, delete). **Self-managed GitLab** works wherever `glab` is signed in —
  the app recognizes any host from `glab auth login`. Insights charts
  GitLab pipelines alongside the local-git analytics. GitHub is unchanged.
- **Bitbucket Cloud** — connect with an **Atlassian API token**
  (Settings → Accounts), then **browse & clone** your Bitbucket repositories,
  read **pull requests** (diffs, comments, build statuses) and watch **Pipelines**
  (with step logs) in the same panels — and act on them: comment (and edit / delete
  your own comments), decline,
  merge (merge commit / squash / fast-forward, optionally deleting the source
  branch), edit, create (drafts included, and pick **reviewers** at create time),
  approve/unapprove, **request changes**
  (a true toggle — revoking works on every Bitbucket plan), pick **reviewers**
  from your workspace members, and flip **draft ↔ ready** in either direction.
  A PR also gets a **Tasks** checklist — add, edit, resolve/unresolve, and delete
  tasks with a progress bar and an "N open tasks" header chip that jumps to the
  list (read-only on a closed or merged PR). Plus rerun, trigger, and stop
  Pipelines — and on a repo with custom `pipelines.custom.*` in its
  `bitbucket-pipelines.yml`, **pick which pipeline to run** (Default or a named
  custom one), with variables. Reopening a declined
  PR isn't available (a Bitbucket platform limit). **Publish a local repo to
  Bitbucket** (pick a workspace, name it, and it creates the repo, adds `origin`,
  and pushes the current branch). Insights charts **Bitbucket Pipeline durations**
  alongside the local-git analytics, with a link-out to Bitbucket's
  Commits/Branches/Pipelines/Deployments. And **repository settings** (admin-gated) manage a
  Bitbucket repo: **General** (description, website, language, fork policy, default
  branch), **default reviewers**, **branch restrictions** (prevent
  pushes/force-pushes/deletion, restrict merges, require approvals/builds/tasks),
  **pipeline variables** (secured supported) and **schedules** (cron), a read-only
  list of **deployment environments**, **webhooks**,
  and a **Danger zone** (rename — which updates your local `origin` automatically —
  visibility, transfer, delete; Bitbucket has no archive). Bitbucket has retired its
  native issue tracker (issues live in Jira), so issues aren't shown for
  Bitbucket repositories.
- **Delegate a task to an agent** — hand a coding task to an AI agent that works
  in an isolated worktree, so your own checkout is never touched. Follow it
  **step by step** — every file it reads, edits, and command it runs — and
  **expand any edit to see its diff inline**; then review the full diff and keep
  it as a branch — or open a local PR straight from it — or discard it. Run several at once, organized into
  **Active** and **Kept** tabs, searchable, with a notification when each finishes. Uses the CLI agent you already have —
  **Claude Code**, **Codex**, **GitHub Copilot**, or **opencode** (whose free
  hosted models need no key at all), no extra subscription. Sandbox its writes in a
  **Docker/Podman container**, or rely on each CLI's own worktree confinement on
  the host — and give a repo **extra tools inside that container** (e.g. Playwright)
  by committing a `.gitdesktop/agent.Dockerfile`, which GitDesktop builds into a
  per-repo image after you review and confirm it. Drive each turn with **slash commands and skills** — built-in
  starters, custom commands you define, and the selected agent's own commands and
  **Agent Skills** (project *and* global, including the shared `.agents/skills`) —
  plus `@file` mentions, a model/reasoning-effort picker, and terminal-style
  prompt history.
- **Bring your own MCP servers** — register Model Context Protocol servers (local
  `stdio` or remote HTTP, with secrets kept in your **OS keychain**) under
  **Settings → MCP servers**, then opt a session into the ones you want from the
  composer's **MCP** picker — on **Claude**, **Copilot**, or **opencode** sessions
  (host *or* container), and on **Codex** in a **container** (host Codex can't approve
  MCP tool calls, so it needs the sandbox). A Claude session runs in strict mode —
  *only* the servers you picked, never inheriting others on your machine — while Copilot
  and opencode layer your picks onto their own config. In a container the servers run
  *inside* the sandbox, with a shared npm cache so an `npx` server downloads only once.
  Find new servers by **Browse**-ing the
  official MCP registry in-app — with GitHub stars, weekly installs, and exactly what
  each one runs shown so you can vet before adding — or **Import** ones you've already
  configured. Change the selection **mid-session**, too.
- **Use GitDesktop *as* an MCP server** — the reverse direction: expose this repo's
  **read-only-by-default** git & forge tools (status, log, diff, blame, branches, file
  history/read, PRs, issues, CI logs) to any external MCP client — **Claude Desktop**,
  **Cursor**, **Claude Code**. The PR/issue/CI tools work across **GitHub, GitLab &
  Bitbucket** (routed through the forge abstraction — they dispatch by the repo's remote;
  Bitbucket covers PRs and pipelines, but not issues). **Settings → MCP servers** shows a
  ready-to-paste config snippet — or **writes it straight into the repo's `.mcp.json`**
  for you (with a **Shareable** toggle for portable, teammate-committable paths), or
  **installs it globally** for **Claude Code** or **Copilot** — per-client rows that show
  each one's live state (installed & pointing at the current launcher, or at an older
  install with one-click **Reinstall**) and let you **Remove** it, all into the client's
  user config so it's available in every project — plus a
  one-click **Add to PATH** launcher so the bare `gitdesktop-mcp` command resolves in any
  terminal (puts the managed-copy bin dir on your user PATH on Windows, or symlinks
  `gitdesktop-mcp` into `~/.local/bin` on macOS/Linux — reversible, no admin). The app
  runs as a stdio server (its own binary on macOS/Linux, an update-safe `gitdesktop-mcp`
  copy on Windows), so an agent can *understand* a repo without touching it. Writes are an
  **escalating opt-in ladder** — each tier is a separate flag, and enabling one never grants
  another: **`--allow-write`** lets an agent create, comment on, approve, and set the status
  of *this repo's* local PRs and issues (GitDesktop's own app-data review artifacts — nothing
  is pushed); **`--allow-remote-write`** unlocks *real* forge writes under your authenticated
  identity (GitHub `gh`, GitLab `glab`, or a stored Bitbucket token) — create/merge/update
  PRs, request reviewers, edit labels and assignees, approve or resolve review threads, rerun
  or dispatch CI, cut releases, and file or comment on issues; **`--allow-git-write`** enables
  recoverable local-git mutations of the repo (stage, commit, branch, push/pull/fetch, stash,
  merge, rebase, cherry-pick, tags); and **`--allow-destructive`** is additionally required
  for the irreversible ones (discard, reset, force-push, delete branch/tag). Every flag is off
  by default, so read-only stays the default — and agent-session branches are refused by the
  branch-mutating tools. The server also exposes GitDesktop's own **AI generation recipes** —
  it hands a connected agent the fully assembled commit-message, PR-description, or
  branch-name prompt (the same context the in-app features build) for the agent to complete
  with its own model.
- **Run commands without leaving the app** — every agent session has an integrated
  terminal: a real shell in a resizable bottom dock, toggled with `Ctrl`/`⌘`+`J`. For a
  container session it runs *inside* the session's container — you pick which dev-server
  ports to publish *before* it starts, and can reconnect to or stop one that's still
  running; for a host session it's a shell in the worktree. A hidden terminal keeps
  running, so a dev server you start stays up.
- **Run a task several ways and keep the best** — fan one task out across 2–5 arms
  (best-of-N), **each with its own agent, model, and effort** so different providers
  (Claude, Codex, Copilot, opencode) attack it differently. Each runs in its own
  worktree; compare them and keep the winner with a single **keep this, discard the
  rest**. Because fanning out multiple agents costs more, a confirmation first shows an
  **upfront estimate** drawn from your own recent sessions, and the ensemble's
  **running total** as it works — opt-in, never the default.
- **Research before you plan** — a read-only, **web-enabled Research** mode that
  sits upstream of Plan. **Brainstorm** surveys the web and your code for several
  distinct directions with prior art; **Deep research** investigates one direction
  in depth and writes a **cited** report, rendered right in the app (never bounced
  to an external editor). **Switch between the two mid-session** as the idea
  narrows — the conversation carries over. Hand a report **straight to Plan**, or
  **save** it as a local Markdown file (yours to review and commit, in
  `.gitdesktop/research/`). Read-only: it searches and reads, but never writes.
  Runs on **any agent** — Claude, Codex, Copilot, or opencode — each using its own
  native web search and fetch.
- **Plan before you build** — a read-only **Plan** mode drafts an agent-ready
  issue from a task (or an existing issue): a repo-aware agent explores your code
  and writes the problem, approach, affected files, acceptance criteria, and verify
  plan, with cited paths validated against your tree so hallucinations are flagged.
  If the plan leaves decisions open, answer them in an inline panel (pick a
  suggestion or write your own) and **refine** the plan with your choices. Then file
  it as a local or GitHub issue — or hand it **straight to a write-capable agent
  session** to implement. Nothing is changed during planning; it never writes.
- **From issue to implementation** — an **Implement** button on any local or
  GitHub issue (and on a finished plan) seeds the agent composer with the spec, so
  you pick the agent and confirm — then it builds it in an isolated worktree.
- **AI where it helps** — commit messages, branch names, PR and issue
  titles/descriptions (and **suggested labels** from the repo's existing set when
  you generate a PR/MR), repository descriptions and topics, and a streaming code
  review or security audit. Bring your own provider: cloud APIs, local **Ollama**,
  or a **keyless CLI agent** you already pay for — the full list is under
  [AI configuration](#ai-configuration).
- **AI review that doesn't quit or repeat itself** — it keeps running while you
  move between PRs, and finishes in the tray even after you close the window.
  Re-runs remember the last round, fold in other reviewers' findings, and read
  GitDesktop's own earlier comments on the PR — so a finding it already refuted or
  marked fixed is treated as settled instead of re-raised. Every AI-posted
  review is **clearly machine-authored** — a branded GitDesktop header/footer, a
  "GitDesktop" bot author with a robot avatar on local PRs, and (with a GitLab
  project/group access token in Settings → Accounts) posting as the real **GitLab
  project bot** rather than your own account.
- **Debug failed CI with AI** — turn a failed job's logs into a streamed
  root-cause + fix, ending with a ready-to-paste prompt for a coding agent.
- **Markdown everywhere you write** — Write/Preview tabs and a formatting toolbar
  (with Ctrl+B / I / K) on every comment, reply, and release-notes field, rendered
  to match GitHub's own styling: task lists, heading hierarchy, and
  syntax-highlighted code in ~190 languages (light and dark).
- **Privacy-first** — API keys live in the OS keychain (never in app files), local
  models keep code on your machine, AI-ignore patterns keep sensitive files out of
  context, and a single switch hides every AI surface.
- **Keyboard-first** — rebindable shortcuts with GitHub-Desktop-compatible
  defaults, a generated cheat sheet (Ctrl+/), a command palette (Ctrl+K), and
  arrow-key navigation everywhere.
- **Self-updating** — signed, verified auto-updates from GitHub Releases, always on
  your consent.

## Features

**Repositories** — clone, add local, create (README / .gitignore / license
scaffolding), publish to GitHub, and fork. A header repo switcher groups every
repo by owner with a Recent section and filter, and each row shows identity
badges at a glance — the forge's logo (GitHub / GitLab / Bitbucket, a cloud for
an unrecognized remote, a folder for local-only) and a visibility icon (lock /
buildings / globe for private / internal / public); aliases and recycle-bin-safe
removal. Star or unstar a repo from the menu, and (for admins) manage GitHub
repo settings — description and topics (with AI suggestions), merge options and
default commit messages, template & forking, **collaborators & invitations**,
**branch rulesets** (create/edit, reversible enable/disable), **code security &
analysis** toggles, **Actions/Dependabot/Codespaces secrets & variables** (repo
and environment scope), the **Sponsor button** (`.github/FUNDING.yml`), webhooks
with delivery history, **GitHub Pages** config, a **danger zone** (rename,
archive, change visibility, transfer, delete), and deep links to the settings
GitHub keeps browser-only — without leaving the app. **Manage files** git
tracks or ignores beyond your pending changes: untrack a file committed by
mistake (kept on disk), or surface every ignored file with the rule responsible
and force-add it or remove that rule.

**Changes & commits** — unified/split diff with syntax highlighting,
collapsible surrounding context, and image diffing; filter the changes list by
path or category; the working-tree diff is one whole-file view with hunk- and
line-level staging and discarding (drag across the line numbers) — including
committing or discarding only part of a brand-new (untracked) file;
stage/unstage/discard single files or a multi-selection from the context menu;
discarding a whole untracked file goes to the recycle bin. Commit with title + body,
co-authors suggested from history, amend, undo, reset, and revert.

**Branches** — switch (bring-changes / stash prompt), create, rename, delete,
and **archive** (hide from the switcher without deleting), plus **Clean up
branches** ⭐ — a bulk sweep that archives or deletes every stale branch (merged
into the default branch, or with no commits in a chosen window) in one reviewed
list. Per-branch ahead/behind
vs. the default branch and a PR badge in the switcher, update a branch *without*
checking it out — from the default branch or from its own upstream (bring the
default current after a merged PR) — check out or delete remote-only branches
right from the switcher's Remote section, remove a branch's worktree from its
menu, a Compare tab
(three-dot diff, commits ahead/behind, merge/rebase, jump to PR), and **local
branch-protection rules** (naming, merge methods, require-PR, force-push) that
are shareable via a committed file or importable from GitHub. Merging shows an
**advanced merge tooling** ⭐ panel that predicts the result in memory before you
commit to it (fast-forward / clean / which files will conflict), with `--no-ff`
and an auto-resolve-conflicts strategy (`-X ours/theirs`, clearly cautioned) —
which GitHub Desktop doesn't offer. A **Change base** action rebases a branch
onto a different base for when it was branched off the wrong one — replaying only
its own commits (the wrong base's are left behind), with a preview of exactly
which commits will move.

**History & advanced** — paged, filterable history with rich commit detail,
per-file history and line blame, and an at-a-glance marker on every commit that
hasn't been pushed yet; cherry-pick (onto the current or another branch) and a
full **interactive rebase** ⭐ — an *Edit history* editor to reword / squash /
fixup / drop / reorder unpushed commits behind an atomic replay engine (any
conflict rolls back untouched), or **edit** a commit to pause and amend its
contents (a real resumable rebase) — which GitHub Desktop doesn't offer; a stash
browser with a **Recover lost work** ⭐ view that scans (via `git fsck`) for
orphaned/dangling stashes — uncommitted work a `git stash` saved but that fell
out of `git stash list` (dropped, or abandoned by an interrupted operation) — and
restores any of them non-destructively to the working tree; an **operation
journal** ⭐ that records the risky compound operations GitDesktop runs (local PR
merges, cherry-picks, history edits, rebases) and, if one is interrupted by a
crash or restart, surfaces a calm recovery notice naming what was interrupted and
the exact branch + commit it started from — browsable any time via the *Operation
history* command; tag management,
submodule management, and a **worktree manager** (create, switch between, and
remove linked worktrees, so you can work on several branches in parallel folders
without stashing).

**Syncing** — fetch / pull / push with ahead/behind indicators; pull is
`--ff-only`, and divergence routes to a guarded force push with
`--force-with-lease`. **Auto-fetch** (on by default) quietly runs a background
`git fetch` on an interval while the window is focused, so the behind-count and
incoming commits stay current without pressing Fetch — it never pulls or merges,
and pushing/pulling stay manual. In-progress merge/rebase/cherry-pick get a conflict banner
with gated Continue / Abort. Selecting a conflicted file opens an **in-app
conflict editor**: each region shows Current (ours) over Incoming (theirs) with
Accept current / incoming / both, plus whole-file Accept all current / incoming
and Open in editor. **AI conflict resolution** is one more option there — ask your
model to merge a file, review the proposal as a diff, and accept it (per file or
all at once). Multi-provider, runs on local Ollama or a keyless Claude Code /
Codex agent, and never writes until you accept.

**Pull requests** — full read + write for GitHub PRs, plus **local PRs**: the full
PR workflow against any two branches with no remote at all. AI review + security
audit on any PR, with an activity indicator, a cancel, and a concurrency-capped
queue. Re-runs are iterative — they feed back the previous round, fold in other
bots' findings, and read GitDesktop's own earlier comments on the PR (its past
reviews and any "fixed in `<sha>`"/refutation replies) as soft, re-verifiable
context, so an already-addressed finding isn't re-raised cold (the current diff is
always the source of truth); per PR, ignore the prior review, trim a false finding,
or opt out of the external-bot folding. **Line-anchored review comments** — from Copilot,
CodeRabbit, or humans — render right in the app: grouped by file in the
Conversation tab and anchored at their exact line in the Files diff, with
reply-in-thread, resolve/unresolve, and edit/delete of your own thread comments —
and a reviewer's suggested change can be
**applied straight to your working tree** (verified against the file, staged when
safe) — now on **GitLab and Bitbucket** too, not just GitHub — something even
GitHub's API can't do. **Compose your own review** right from the diff: click a
line number (or drag across a range — a real multi-line anchor on **GitHub and
GitLab**; Bitbucket anchors at the last line, and the composer says so) to open an
inline composer — clicking the "+" on any line of a drag opens the range composer —
then post a single
comment or **start a review** to batch drafts (persisted per-PR, surviving
restarts) that render at their anchors with a pending-review count, then
**Submit review…** with a verdict (Comment / Approve / Request changes,
capability-gated per provider) — and insert a **provider-correct suggestion**
pre-filled with the selected code. **Drill into a PR's commits** too — the
Commits tab is arrow-navigable, and opening a commit shows its full message and
per-file diffs with a **whole-commit thread and line-anchored comments** you can
add, edit, and delete (line-anchored comments carry a real drag-range on GitLab;
GitHub and Bitbucket anchor to a single line). The same **commit comments** are also
available straight from the **History tab** — open any pushed commit to comment on
the whole commit or anchor to lines (an unpushed commit shows a push hint instead).
A PR's Conversation is a **date-sorted activity feed** that interleaves reviews,
comments, **pushed commits** (grouped into "pushed N commits," each SHA clickable straight
to its detail), and events — and marks an **approval or changes-request stale** once later
commits land. It covers **GitHub, GitLab, and Bitbucket**: GitHub carries the full event
set (force-push, label add/remove, review request, ready-for-review, convert-to-draft,
close, reopen, merge, rename); **GitLab MRs** add pushed commits, label add/remove,
close/reopen/merge, and approvals (approved / changes-requested / approval-withdrawn), but
have no force-push or draft events; **Bitbucket PRs** add pushed commits, merge/close, and
approved / changes-requested, with no labels or review-requests. **Local PRs** get the feed
too — created → pushed commits (each SHA clickable to the commit detail) → comments →
merged/closed. Its **CI checks** collapse into a **✓ passed · ✕ failed · ● pending rollup**
(auto-expanding on any failure) whose failing **GitHub Actions** and **GitLab pipeline**
jobs **peek their job log inline**, without leaving the PR; **Bitbucket** build statuses and
other external checks link out (name/state/URL, no fetchable logs). **Record management** lives on the list row, not the footer:
**right-click** a local PR to **Archive / Unarchive** or **Delete** it (Delete confirms;
the branches are untouched), also reachable from the command palette.
Write/Preview markdown editor
(formatting toolbar and live preview) everywhere you author.

![A pull request open in GitDesktop with an inline AI review summarizing the diff; the left sidebar lists both local and GitHub pull requests, and the footer offers Approve, Comment, and Publish-to-GitHub actions.](site/src/assets/app-review.png)

**Issues & to-dos** — a dedicated tab for GitHub issues and private **local
to-dos** (no remote needed; publishable to GitHub in one click). Browse, create,
and edit (drafting with AI from your repo's issue templates), react with emoji,
and manage the full metadata: labels, assignees, milestones, issue type,
sub-issues, dependencies (blocked-by / blocking), and development links (linked
and closing PRs and branches, plus create-a-branch). Duplicate, transfer,
pin/unpin, lock/unlock, or delete.

![An issue open in GitDesktop with its description, labels, assignees, milestone, sub-issues, and a linked development branch and pull request; local and GitHub issues appear together in the sidebar.](site/src/assets/app-issues.png)

**Discussions** — browse and read a repository's GitHub Discussions, create and
edit them, and react or upvote, with Write/Preview markdown throughout.

**GitHub Actions** — a dedicated tab with live run status, run detail, re-run /
cancel / manual dispatch, inline failed-step logs, **Debug with AI**, a current-branch
CI badge in the header, and run-completion notifications.

![GitDesktop's GitHub Actions tab: a workflow run with its Lint, Unit tests, and Build jobs listed, the Build job expanded into individual steps and durations, plus Re-run all jobs and View on GitHub controls.](site/src/assets/app-actions.png)

**Insights** — a repository-graphs tab (Ctrl/Cmd-9): commit activity, code
frequency (additions vs. deletions), contributor churn, and a commit punch card —
all computed **locally from your clone**, so they work offline, on private repos,
with no token or rate limit, and without GitHub's 10k-commit chart degradation.
Plus the at-a-glance overview (languages, contributors, sizes, branch-vs-default),
a GitHub Actions success-rate / duration trend, a community-health card,
14-day **traffic** (views/clones/referrers/paths, with push access), a
**dependencies** card, and quick links to the web-only GitHub insights (Pulse,
network, dependents, Actions metrics, stars over time). Charts ship one-line
captions, data-table fallbacks, and keyboard navigation.

**Git settings** — Settings → **Git** configures your global git config from the
app: the **default branch** for new repos (`init.defaultBranch`, honored by a
command-line `git init` too), **line endings** (`core.autocrlf`), and your **commit
identity** — plus a **per-repository override** (`git config --local`) so you can
commit as a different author in one repo without changing your global identity.

**Git hooks** — view, edit, enable/disable, and template `.git/hooks`, with
husky / pre-commit / lefthook detection and install integration.

**Automations** — a lifecycle grid (on commit / on PR opened / on new commits to a
reviewed PR) that runs AI review or security audit automatically, with per-action
branch conditions, Save/Discard drafts, global defaults, and per-repo overrides.

**Integrations** — open in any editor or terminal (auto-detected, or point at any
executable), and tunable OS notifications for PR activity, checks, and CI runs.

**Activity & notifications** — a persistent bell in the header that collects terminal
events (a finished review, checks passing/failing, a PR approved/commented/merged, a
review requested from you, a completed CI run, or a finished agent / research / plan run) into a clickable,
clearable history that survives a restart — so a review that finishes while you're away is
never a missed click. Open it from the command palette; which events show follows your
notification settings.

**Environment check** — a Settings → **About** panel reports your app/OS/Tauri
versions and the status of every CLI GitDesktop uses (git, the GitHub & GitLab
CLIs, Claude Code, Codex): installed?, version, resolved path, and sign-in
state — with an Install link for anything that's missing. It also shows a live
readout of the window's current position, size, and display (with copy-coords).

**Window memory** — GitDesktop reopens at the size and position you left it, and
maximized if it was, validated against your current monitors so an unplugged
display can't strand it off-screen.

## AI configuration

- **Providers** — Anthropic, OpenAI, **any OpenAI-compatible endpoint** (custom
  base URL, with one-click presets for the Vercel AI Gateway, Google Gemini,
  DeepSeek, Mistral, and Z.ai), OpenRouter, **local or LAN Ollama**, **Ollama Cloud**
  (hosted models via an API key), and the **Claude Code / Codex / GitHub Copilot /
  opencode CLIs** (keyless, via your subscription — or opencode's free hosted
  models). Separate models for generation vs. review; live model lists in a
  searchable picker.
- **Custom & LAN servers** — point Ollama or an OpenAI-compatible endpoint at a
  box on your network, not just `localhost`. Non-built-in hosts must be added to
  the **Allowed hosts** list (Settings → AI; one-click *Allow host* on the URL
  field), which GitDesktop enforces before every AI request.
- **Custom instructions** (included in every generation):
  - **Global** — Settings → AI instructions (e.g. "Follow Conventional Commits").
  - **Per-repo** — `.gitdesktop/instructions.md` in the repo. Takes precedence.
- **AI ignore patterns** (keep files out of AI context; they still commit
  normally), gitignore-style:
  - **Global** — Settings → Excluded files (one pattern per line).
  - **Per-repo** — `.gitdesktop/aiignore` in the repo.
- **Keys** live in the OS keychain (Windows Credential Manager, macOS Keychain,
  libsecret). **Hide AI** (Settings → General) hides every AI surface while
  keeping your config.

## Updates

GitDesktop checks GitHub Releases on launch (opt-out in Settings → Updates) and
installs **only on your consent**. Updates are cryptographically signed and
verified by the app — separate from OS code signing. Maintainer release steps:
[docs/deployment-updates.md](docs/deployment-updates.md).

## Requirements

- **git** on `PATH` (required).
- **GitHub CLI (`gh`)**, installed and authenticated (`gh auth login`), for the
  pull-request and Actions features — they stay hidden when it isn't available.
- An **AI provider** for the AI features: an API key (Anthropic / OpenAI /
  OpenRouter / **Ollama Cloud**), a local **Ollama** server, or a signed-in
  **Claude Code / Codex** CLI. All optional.

## Development

Prereqs: Rust toolchain, Node 20+, pnpm.

```sh
pnpm install
pnpm tauri dev    # run the app
pnpm build        # typecheck + bundle the frontend
pnpm lint         # biome
cargo test --manifest-path src-tauri/Cargo.toml   # Rust unit tests
```

### Architecture

- `src-tauri/src/git/` — typed Tauri commands that shell out to system `git`
  (porcelain v2 parsing, per-repo mutation locks, timeouts).
- `src-tauri/src/github/` — `gh`-backed commands: pull requests (`pr.rs`) and
  GitHub Actions (`actions.rs`).
- `src-tauri/src/{hooks,secrets,instructions}.rs` — git-hook management, OS
  keychain storage, and repo instruction/rule files.
- `src-tauri/src/agent.rs` — drives local coding-agent CLIs (Claude Code / Codex /
  GitHub Copilot / opencode) for keyless AI review, sessions, and CI debugging.
- `src/lib/` — invoke bindings + TanStack Query hooks (`git/`, `github/`),
  the AI layer (`ai/`, Vercel AI SDK over the Tauri HTTP plugin so requests
  bypass webview CORS), settings, and the hotkey registry.
- `src/features/` — the screens: repository, changes/diff, commit, history,
  compare, pulls, actions, hooks, branch-rules, settings, and updates.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the
conventions we follow (Conventional Commits, Biome, a `[Unreleased]` changelog
entry), and how to open a good PR. Please also read the
[Code of Conduct](CODE_OF_CONDUCT.md). For questions, see
[SUPPORT.md](.github/SUPPORT.md); to report a vulnerability, follow
[SECURITY.md](SECURITY.md).

## Sponsor

GitDesktop is free and open source under Apache 2.0. If it earns a place in your
daily workflow, you can support continued development:

- **[GitHub Sponsors](https://github.com/sponsors/theBGuy)**
- **[Buy Me a Coffee](https://buymeacoffee.com/theBGuy)**

## Privacy

GitDesktop never collects your code, file contents, or repository details.
Optional anonymous usage analytics can be turned off in Settings → General, and
masked session replay stays off until you opt in. Full details:
[PRIVACY.md](PRIVACY.md).

## License

Licensed under the [Apache License 2.0](LICENSE).
