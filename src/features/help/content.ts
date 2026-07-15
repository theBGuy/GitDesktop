/**
 * A section of the in-app user guide, rendered as Markdown in the Help screen.
 *
 * Keyboard shortcuts in `body` are written as tokens, NOT literal keys, so the
 * guide always shows the right key for the platform (⌘ on macOS) and reflects
 * the user's rebindings:
 *   - \`{{kbd:action-id}}\` — a rebindable action from the hotkey registry; resolves
 *     to its current effective binding (or "unbound" if the user cleared it).
 *   - \`{{key:mod+b}}\` — a fixed, non-rebindable combo (e.g. the Markdown editor's
 *     formatting keys); resolves to the platform-formatted form only.
 *
 * AI content is gated by the "Hide AI features" setting:
 *   - A whole section with \`ai: true\` is dropped from the guide when AI is hidden.
 *   - An inline passage wrapped in \`{{ai}}…{{/ai}}\` is stripped when AI is hidden
 *     (and the markers alone are stripped when AI is on).
 * HelpScreen resolves all of this before rendering.
 */
export interface GuideSection {
  id: string;
  /** Left-nav label. */
  label: string;
  /** AI-only section: hidden when "Hide AI features" is on. */
  ai?: boolean;
  /** Markdown body (with {{kbd:…}} / {{key:…}} / {{ai}}…{{/ai}} tokens). */
  body: string;
}

export const GUIDE_SECTIONS: GuideSection[] = [
  {
    id: "getting-started",
    label: "Getting started",
    body: `# Welcome to GitDesktop

GitDesktop is a desktop Git client{{ai}} with AI built in{{/ai}}: GitHub Desktop-style
fundamentals — status, staging, branches, history, diffs, sync — plus the full
pull-request lifecycle, GitHub Actions, issues, discussions, releases, repository
insights{{ai}}, and write-capable AI agent sessions{{/ai}}, all in one app.

A few things worth knowing up front:

- **Git is required.** GitDesktop drives your system \`git\`, so anything it does is
  standard Git you could do on the command line.
- **GitHub features use the GitHub CLI (\`gh\`).** Pull requests, issues, discussions,
  Actions, and repository settings appear once \`gh\` is installed and you've run
  \`gh auth login\`. There's no separate sign-in, and the app never stores your tokens.
  Plain Git (clone/fetch/pull/push) works against any remote without GitHub.
- **GitHub Enterprise works too.** GitDesktop follows \`gh\`, which detects each repo's
  host from its remote — so sign in to your Enterprise server with
  \`gh auth login --hostname your.github.example\` and its repos get the same PR, issue,
  and Actions features. **Settings → Accounts** lists every signed-in host and lets you
  switch the active account per host.
- **Bitbucket Cloud.** Connect in **Settings → Accounts** with an **Atlassian
  API token** (created at id.atlassian.com, used with your Atlassian account email) —
  the token is stored in your OS keychain. Then browse & clone your repositories, and
  read and act on pull requests and Pipelines. (See **Bitbucket repositories** below.)
{{ai}}- **AI is optional.** Commit messages, PR descriptions, reviews, CI debugging, and
  agent sessions can use Anthropic, OpenAI, OpenRouter, Ollama (local or cloud), an
  OpenAI-compatible endpoint, or the Claude Code / Codex / GitHub Copilot / opencode
  CLIs. You can hide every AI feature in **Settings → General**.
{{/ai}}
## Open your first repository

From the welcome screen (or the repo switcher in the header):

- **Open repository** ({{kbd:add-local-repository}}) — point at a folder that's already
  a Git repo.
- **Clone repository** ({{kbd:clone-repository}}) — clone from a URL, or browse and
  clone your **GitHub**, **GitLab**, or **Bitbucket** repos from their tabs.
- **Create repository** ({{kbd:new-repository}}) — start a new repo with an optional
  README, \`.gitignore\`, and license.

## Finding your way around

Once a repo is open you land on the **Changes** tab. The header's tab rail holds the
four primary views — **Changes**, **History**, **Compare**, and **Pull Requests** —
and a **More ▾** menu holds the rest: {{ai}}**Agent**, {{/ai}}**Issues**,
**Discussions**, **Actions**, **Tags**, and **Insights**. The More button shows the
active secondary tab's name, so the rail always says where you are.

Switch tabs with the number keys ({{kbd:tab-changes}} through {{kbd:tab-insights}}; see
*Keyboard & navigation*). Issues, Discussions, Actions, and Tags need \`gh\` and a GitHub
remote{{ai}}; the **Agent** tab appears only when AI features are enabled{{/ai}}.

> Tip: press {{kbd:command-palette}} anytime for the command palette — the fastest way
> to find a feature when you don't know where it lives — or {{kbd:show-help}} to reopen
> this guide.`,
  },
  {
    id: "repositories",
    label: "Repositories",
    body: `# Repositories

## Switching repos

The repository name in the header is a **switcher** ({{kbd:show-repositories}}). Click it
to see every repo you've opened, grouped by GitHub owner, with a Recent section and a
filter box — jump between repos without returning to the welcome screen. Each row shows
its **forge** as a leading logo (GitHub, GitLab, or Bitbucket; a cloud for a remote on an
unrecognized host, a folder for a local-only repo) and, once resolved, a trailing
**visibility** icon — a lock (private), buildings (internal), or globe (public) — plus a
**fork** glyph when the repo is a fork of another (hover it for the upstream repo).

## The repository menu

Click the **⋮** menu next to the repo name for repo-wide actions:

- **View on GitHub / GitLab / Bitbucket** ({{kbd:view-on-github}}), open a **terminal**
  at the repo root ({{kbd:open-in-terminal}}), **show in your file manager**
  ({{kbd:show-in-explorer}}), or **open in your editor** ({{kbd:open-in-editor}}).
- On the host: **Star** the repository, **create an issue**, or **Fork** it (on GitLab
  and Bitbucket, forking opens the web fork page). Bitbucket has no stars and its
  issue tracker is retired, so those two actions don't appear for Bitbucket repos.
- **Insights** (analytics), **manage files**, **submodules**, the **remote URL**,
  **branch rules**, **git hooks**, {{ai}}**automations**, {{/ai}}**repository settings**,
  an **alias**, copy the repo path, copy the branch name, copy the HEAD SHA, and
  remove the repo from the list.

## Aliases

An **alias** gives a repo a friendly name shown in the lists, header, and window title —
handy when several repos share a name. For repository statistics and analytics (commits,
contributors, language makeup, activity, traffic), open **Insights** from the menu or the
**Insights** tab.

The app remembers each window's **position and size** across launches, including which
monitor it was on — see **Settings → About** for the current coordinates.`,
  },
  {
    id: "repo-settings",
    label: "Repository settings",
    body: `# Repository settings

**Repository settings** (the repo ⋮ menu) manages your GitHub repository — a GitLab
project (see **GitLab projects** below) or a Bitbucket repository (see **Bitbucket
repositories** below) too — without leaving the app. It's organized as a sidebar of
grouped sections; changes apply on the host immediately unless noted. On GitHub it looks
like this:

- **General** — description, topics, homepage, default branch, features (issues,
  projects, wiki, discussions), pull-request merge options (allowed merge methods,
  default squash/merge commit messages, auto-merge, delete-branch-on-merge), template
  repository, and (on org-owned private repos) allow-forking.
- **Access** — collaborators and their roles; invite someone at any level
  (Read / Triage / Write / Maintain / Admin), change a role inline, remove access, and
  manage pending invitations.
- **Rules** — GitHub's branch **rulesets**: list them, flip enforcement
  (Active / Evaluate / Disabled), and create or edit one (require a PR with approvals /
  code-owner review, required status checks, block force pushes, restrict deletions,
  linear history, signed commits).
- **Security** — secret scanning (with AI detection and non-provider-pattern
  sub-toggles), push protection, code scanning, Dependabot alerts and security updates,
  and private vulnerability reporting, behind a save/discard bar. Dependabot **version
  updates** scaffolds a \`.github/dependabot.yml\` for you to commit.
- **Pages** — enable GitHub Pages from a branch + folder or via Actions, set a custom
  domain, enforce HTTPS, and see the live URL and build status.
- **Sponsor** — edit \`.github/FUNDING.yml\` (GitHub Sponsors, Patreon, Open Collective,
  Ko-fi, and more); saving writes the file to your working tree to commit.
- **Secrets** — Actions, Dependabot, and Codespaces **secrets** plus Actions
  **variables**, at repository or environment scope. Values are encrypted on your
  machine and, as on GitHub, can't be read back — only replaced or removed.
- **Webhooks** — add, edit, and remove webhooks; pick events, send a ping or test
  delivery, and inspect recent **deliveries** with their request/response payloads.
- **Danger zone** — **rename**, **archive / unarchive**, **change visibility**,
  **transfer ownership**, and **delete** the repository. The three irreversible actions
  are each behind a type-the-\`owner/repo\`-name confirmation, and your local clone is
  never touched.

> Some options GitHub exposes to no app appear as **"Manage on GitHub"** links rather
> than dead toggles.

## GitLab projects

The same dialog manages a **GitLab** project (it needs the **Maintainer** role; the
menu item appears only when you have it):

- **General** — description and topics (AI-generate works here too), default branch,
  per-feature **access levels** (Issues, Merge requests, Wiki, Snippets, Forking — each
  everyone / members-only / disabled), the **merge method** (merge commit, semi-linear,
  fast-forward), the **squash policy**, and the merge checks (pipelines must succeed,
  all threads resolved, delete source branch by default).
- **Members** — add someone by username at a role (Guest … Owner), change a role
  inline, or remove them. Members **inherited from a group** show read-only — they're
  managed on the group.
- **Protected branches** — protect a branch or wildcard with per-rule **allowed to
  push** / **allowed to merge** access levels and an **allow force push** toggle;
  unprotect with a confirm. Rules **inherited from a group** show read-only. Access
  levels are set when you protect a branch — to change them, unprotect and re-protect.
- **Variables** — the project's **CI/CD variables**: add, edit, and delete, with
  **protected** (protected refs only) and **masked** (hidden in job logs) flags.
- **Webhooks** — create, edit, and delete hooks with per-event triggers and a secret
  token; **send a test event**; and debug with the **delivery log** — each delivery's
  request/response payloads, with one-click **re-send**. A hook GitLab auto-disabled
  after failures shows a **disabled** badge.
- **Danger zone** — **rename** (name + path, old paths redirect),
  **archive / unarchive**, **change visibility**, **transfer** to another namespace,
  and **delete**. The Owner-only actions disable with an explanation when you're a
  Maintainer.

## Bitbucket repositories

The same dialog manages a **Bitbucket** repository (it needs **admin** on the repo; the
menu item appears only when you have it):

- **General** — description, **website**, primary **language**, **fork policy** (allow
  all forks / private forks only / no forks), and the **default branch**, saved behind a
  Save button.
- **Default reviewers** — the accounts auto-added to every new pull request: add one from
  the workspace members not already listed, or remove one.
- **Branch restrictions** — rules that limit matching branches (by a **glob** like
  \`release/*\`): **prevent pushes**, **prevent force pushes**, **prevent branch
  deletion**, **restrict merges**, and **require approvals / passing builds / resolved
  tasks** to merge (the count-based ones take a number). Edit a rule's pattern or count,
  or delete it.
- **Variables** — the repo's **pipeline variables**: add, edit, and delete, with a
  **secured** flag (a secured value is write-only and never shown again). If Pipelines
  are off, an **Enable pipelines** action turns them on first.
- **Schedules** — **pipeline schedules** that run a branch's pipeline on a recurring
  **cron** (Bitbucket uses Quartz cron, e.g. \`0 0 12 * * ?\`): add one, toggle it
  enabled/disabled in place, or delete it.
- **Deployments** — a read-only list of the repo's **deployment environments** (with tier,
  and hints for ones not yet used or restricted to admins). Environments are created and
  managed on Bitbucket, so there's a **Manage on Bitbucket…** link out rather than editing
  here. (Like Variables and Schedules, deployments need Pipelines enabled first.)
- **Webhooks** — create, edit, and delete webhooks with a payload URL, an active toggle,
  and an event checklist. Bitbucket has no delivery-log API, so there's no deliveries
  view.
- **Danger zone** — **rename** (this changes the repository's URL slug; GitDesktop
  updates your local \`origin\` remote automatically), **change visibility**
  (public / private), **transfer** (a link out to Bitbucket, which handles transfers on
  the web), and **delete**. Bitbucket has no archive, so that action isn't shown. Your
  local clone is never touched.`,
  },
  {
    id: "changes",
    label: "Changes, diffs & commits",
    body: `# Changes, diffs & commits

The **Changes** tab ({{kbd:tab-changes}}) lists your modified files, split into
**Staged** (included in the next commit) and **Changes** (not yet staged).

## Staging

- Click a file to see its diff. Toggle **unified / split** at the top of the diff.
- Stage or unstage a file with the **+ / −** button on its row, or **Stage all**.
- **Hunk-level staging** — in a file's diff, each hunk has its own Stage / Unstage /
  Discard buttons.
- **Line-level staging** — drag across the line-number gutter to select specific lines,
  then stage or discard just those.
- Select multiple files ({{key:mod}}-click, or Shift-click for a range), then right-click
  for **Stage / Unstage / Discard / Stash** of the whole selection.
- Filter the list by path, or by category (new / modified / deleted, included /
  excluded) with the funnel button.

## The diff viewer

- **Syntax highlighting** for most languages, with a per-file **language override** if a
  file is detected wrong (or turn highlighting off).
- **Image diffs** render side by side.
- Very large diffs are capped (with a **Show full diff** escape hatch) so a huge file
  never freezes the view.

## Committing

Write a **summary** (there's a 72-character budget indicator) and an optional
**description**, then **Commit** ({{kbd:commit}}).

- **Co-authors** — add collaborators; the picker suggests people from the repo's history
  and writes proper \`Co-authored-by:\` trailers.
{{ai}}- **Generate with AI** ({{kbd:generate-commit-message}}) — write the summary and
  description from your staged diff (see *AI & automations*).
{{/ai}}- After committing, **Undo** ({{kbd:undo-commit}}) reverses the last commit and
  returns your message to the box.

> Discarding an **untracked** file moves it to the recycle bin, so it's recoverable —
> it isn't deleted outright.`,
  },
  {
    id: "history",
    label: "History & git operations",
    body: `# History & git operations

The **History** tab ({{kbd:tab-history}}) is the commit log for the current branch — each
entry shows the author's avatar (from GitHub or Gravatar, or their initials). Click
a commit to see its message, author, and full diff; **Shift + ↑ / ↓** extends the
selection to compare a range.

## Commit actions

Right-click a commit (or use the commit detail view) for:

- **Amend** the most recent commit (reword, or fold in staged changes).
- **Revert** — create a new commit that undoes a commit's changes.
- **Cherry-pick** a commit onto the current branch.
- **Reset** the current branch to a commit — a **mixed reset**, so the changes from later
  commits return to your working tree as uncommitted changes.
- **Edit history** — open the interactive-rebase editor over your unpushed commits, where
  each commit gets an action: **pick** (keep), **reword** (edit its message), **squash**
  (merge into the commit below, combining messages), **fixup** (merge in, keeping the
  message), **edit** (pause to amend its changes), or **drop** (remove it) — plus **↑/↓** to
  reorder.{{ai}} Reword can regenerate a message with AI.{{/ai}} A "Result" count shows what
  you'll end up with. With no **edit**, it applies all at once and rolls back untouched if
  anything conflicts. If you choose **edit**, it starts a rebase that **pauses** at that commit —
  amend it in the **Changes** tab (stage and commit/amend as usual), then **Continue** from the
  banner there. A quick **Squash N commits…** is also on the context menu when you select
  adjacent commits.
- **Create a branch** or **create a tag** at a commit, **check out** a commit, or copy
  its SHA.

## Commit comments

When the repo is connected to **GitHub**, **GitLab**, or **Bitbucket** and the commit is
**pushed**, opening it shows a **comments pane** below the diff: a **whole-commit composer**
plus its thread, and **clickable line numbers** on the diff — click or drag a range to anchor
a comment to those lines (create / edit / delete your own). An **unpushed** commit shows a
push hint instead, and a local-only repo shows no comment pane at all.

## Exploring a file's past

- **File history** — see every commit that touched a specific file.
- **Blame** — line-by-line, which commit last changed each line. Hover (or
  keyboard-focus) a line's commit in the gutter to preview it; click or press
  Enter to jump straight to that commit in **History**.

Right-click any file row to reach both: in the **Changes** list, in a commit's file
list (in **History**, or a PR's **Commits** tab), in a PR's **Files** tab, or in a
**Compare** / local-PR file list. On those historical surfaces **Blame** is pinned at
that commit or branch — you see the file *as of* that revision, not your working copy.
The **Blame file…** command (from the command palette) opens a fuzzy picker of every
tracked file and blames the one you choose as it is now.

> History-rewriting actions (reset, Edit history, squash) only ever touch **unpushed**
> commits, and a push of rewritten history becomes a safe **force-with-lease** push (see
> *Syncing & conflicts*).`,
  },
  {
    id: "branches",
    label: "Branches & compare",
    body: `# Branches & compare

The branch name in the header opens the **branch switcher** ({{kbd:show-branches}}).

- Branches are sorted by most recent commit, with the default branch pinned on top and
  each branch's ahead/behind counts vs. the default.
- **Create** a branch ({{kbd:new-branch}}), **rename** ({{kbd:rename-branch}}), **delete**
  ({{kbd:delete-branch}}), or **archive** it — archiving hides a branch without deleting
  it, collapsing it into an "Archived" section.
- **Clean up branches** — from the switcher's menu or the command palette — opens a bulk
  sweep of stale branches: those **merged** into the default branch, or with no commits in a
  chosen window (30/60/90 days). Review the pre-checked list, then **archive** them
  (reversible) or **delete** them together. The current branch, the default branch, and
  protected branches are never included.
{{ai}}- **Generate a branch name with AI** from your working-tree changes when creating
  or renaming one.
{{/ai}}- Switching with **uncommitted changes** prompts you to bring them along or stash
  and switch.
- Right-click a branch to **merge**, **squash and merge**, **rebase**, or **update it
  from the default branch** ({{kbd:update-from-default}}) — the last *without* checking it
  out.
- **Change base…** — from the switcher's menu or the command palette — rebases the current
  branch onto a *different* branch, for the "I branched off the wrong one" case: pick the
  branch you meant to base on and the branch you actually did, and only your branch's own
  commits move — the wrong base's commits are left behind. A preview lists exactly which
  commits will move before you run it, and any conflicts drop into the resolve flow below.
- **Update a branch from its own upstream** without switching to it: when a branch is
  behind the remote it tracks, its right-click menu offers **Update from _origin/…_**. This
  is the "just merged a PR — bring the default branch current before I switch back" flow;
  the default branch's row shows how far behind its upstream it is after a fetch, and
  *Update default branch from its remote* is available from the command palette too.
- The **Remote** section lists branches on your remotes you haven't checked out locally
  yet — click one to check it out (creating a local tracking branch), or right-click to
  **Delete on _origin_…**, a server-side delete that removes the branch from the remote for
  everyone (protected names are blocked, and it can't be undone from the app).
- The **Merge** dialog previews the result before you commit to it — *fast-forward*, *clean
  merge*, or *which files will conflict* — worked out in memory without touching your files.
  Two options sit alongside: **Always create a merge commit** (no fast-forward), and an **On
  conflict** strategy — *Stop and let me resolve* (default), or *Prefer current* / *Prefer
  incoming* to auto-resolve conflicting changes in one branch's favor (the other side's
  conflicting changes are dropped, so it's used deliberately).

## Stash

**Stash all changes** ({{kbd:stash-all}}) sets your working changes aside; **View
stashes** lists them to apply, pop, or drop, and **Pop latest stash** restores the most
recent.

**Recover lost work** (in the branch ⋮ menu, or the command palette) opens the
**Recoverable** tab in the stashes dialog. It scans your repository (with \`git fsck\`) for
*orphaned* stashes — uncommitted work a stash once saved that has since fallen out of
**View stashes** (dropped, or abandoned by an interrupted operation) — and lists each one
with a file-by-file diff preview. **Restore to working tree** re-applies the one you pick;
it's non-destructive (it applies the stash, never dropping or committing anything), so you
can safely preview and recover work you thought was gone.

**Operation history** (in the branch ⋮ menu, or the command palette) opens a
journal of the *risky* operations GitDesktop runs — local PR merges, cherry-picks, history
edits, and interactive rebases — each recorded with the exact branch and commit it started
from, and whether it finished, failed, or is still pending. If one of these operations is
interrupted (a crash or a restart mid-op), a calm recovery line appears above the **Changes**
list naming what was interrupted and the state it started from. That notice only informs — it
never resets or continues anything on its own (the git-native **Continue**/**Abort** for an
in-progress merge, rebase, or cherry-pick live in the conflict bar right above it); from it
you can open this history, jump to **Recover lost work** to rescue any orphaned changes, or
dismiss the notice.

## Compare

The **Compare** tab ({{kbd:tab-compare}}) lets you pick any base branch and see what the
current branch adds: the commits ahead and behind, and the full three-dot diff a PR would
show. From here you can merge, rebase, or jump straight to opening a pull request.

## Branch rules

**Branch rules…** (in the ⋮ menu) sets local protections — naming patterns, blocked
deletion, allowed merge methods, require-PR, and force-push blocking. They're enforced
inside the app, can be shared with your team via a committed file, and can be imported
from a repo's GitHub branch-protection rules. (For server-side enforcement, use **Rules**
in *Repository settings*.)

## Worktrees

**Worktrees…** (in the ⋮ menu, or the command palette) manages linked worktrees — extra
folders that each check out a different branch of the same repository, so you can build,
test, or review several branches at once without stashing or switching.

- **Add** a worktree on a new branch (from any base) or an existing one; it's checked out
  into its own folder, defaulting to a sibling of the repository.
- **Open** a worktree to make it the active repository — git commands then run in that
  folder and the window title follows. Open the main worktree to switch back.
- **Rename** a worktree to move its folder to a new name in place; its branch is unchanged.
- **Lock** a worktree (with an optional reason) so git won't prune or remove it without a
  forced confirmation — useful for one on a removable or network drive; **Unlock** to undo.
- **Delete** a worktree to remove its folder; its branch is kept. A worktree with
  uncommitted changes asks before force-removing. The main worktree, and whichever one
  you're currently in, can't be renamed or deleted — switch away first.
- **Promote to main workspace** brings a worktree's branch into your main checkout: it
  removes the worktree (a branch can't be checked out in two at once) and checks that branch
  out in the main workspace. The worktree must be clean first; any uncommitted work in the
  main workspace is stashed so the checkout can't be blocked (restore it with *Pop latest
  stash*). Works even on the worktree you're currently in.
- **Repair links** (footer) re-connects worktrees if you moved or renamed the repository
  folder in your file manager, which otherwise breaks the path each worktree records.

A branch can only be checked out in one worktree at a time, so the list excludes branches
already in use. The **branch switcher** knows this too: a branch that's checked out in
another worktree is badged, and choosing it offers to open that worktree instead of failing
with a checkout error. You can also **Remove worktree…** straight from that badged branch's
right-click menu — the branch stays, and its **Delete…** item un-disables once the worktree
is gone. When you're in a linked worktree the switcher reminds you that a branch checkout
lands *there* (not the main workspace) and offers a one-click **Open main workspace**, and its
**Worktrees** section jumps you straight to any other worktree — no detour through a
checked-out branch. **Open main workspace** and **Promote this worktree to main workspace**
are in the command palette too.

A repository's local pull requests, issues, review history, and per-repo settings are shared
across all its worktrees, so you see the same ones whichever folder you're working in.{{ai}}
Worktrees that AI agent sessions use internally are hidden here.{{/ai}}`,
  },
  {
    id: "syncing",
    label: "Syncing & conflicts",
    body: `# Fetch, pull, push & conflicts

The header shows **Fetch / Pull / Push** with ahead/behind indicators.

- **Fetch** ({{kbd:fetch}}) updates your view of the remote without changing your branch.
- **Pull** ({{kbd:pull}}) is fast-forward only by design — it won't create surprise merge
  commits.
- **Push** ({{kbd:push}}) sends your commits. For a branch with no upstream yet, you'll
  see **Publish branch** instead.

## Update a fork from upstream

If your repo has an **\`upstream\`** remote (the source repo you forked), the Pull menu's
caret adds **Update from upstream** — also in the command palette ({{kbd:command-palette}}).
One click fetches upstream, resolves its default branch, and brings your current branch up to
date: it **fast-forwards** silently when it can, creates a **merge commit** when the histories
have cleanly diverged, and sends any conflicts to the **conflict editor** (below). It never
pushes for you — once you're ahead, **Push** lights up on its own. (A plain **Fetch** never
touches \`upstream\`, so this is how a fork sees the source repo's new commits.)

## Auto-fetch

By default, GitDesktop quietly fetches in the background so the ahead/behind counts stay
current without pressing **Fetch**. It runs on an interval while the window is focused, once
more when you return to the app or open a repo, and again right after you **merge a pull
request** so the merge shows up locally without a manual Fetch. It only updates your view of the remote
— it **never pulls, merges, or changes your files**, so pulling and pushing stay deliberate.
There are no toasts; the **Fetch** button simply spins while it works, and hovering it shows
when the repo was last fetched. Turn it off, or change the interval, under
**Settings → General**.

## Safer force push

If your local history was rewritten (for example, after amending a commit that was
already pushed), GitDesktop detects the divergence and turns Push into a **confirmed
force push using \`--force-with-lease\`** — which refuses to clobber work someone else
pushed in the meantime.

## Resolving conflicts

During a **merge**, **rebase**, or **cherry-pick**, a slim banner appears in **Changes**
with the conflict count and **Abort** / **Finish** controls. Select a conflicted file (the
\`!\` badge) to open the **conflict editor**: each conflict region shows **Current (ours)**
over **Incoming (theirs)** with **Accept current**, **Accept incoming**, or **Accept both**,
and the header adds whole-file **Accept all current** / **Accept all incoming** and **Open in
editor**. Files mark themselves resolved as you go — the \`!\` badge clears — and **Finish**
stays disabled until every conflict is resolved.

{{ai}}## Resolve conflicts with AI

Select a conflicted file and click **Resolve with AI** in the conflict editor's header (also
on the file's right-click menu, and via the command palette ({{kbd:command-palette}})). Your configured
**Review** model (Settings → AI) merges the file's sides and streams a proposal; you review
it as a diff against your side, flip to the proposed file or the *ours* / *theirs* / *base*
versions, then **Accept & stage** to apply it — nothing is written until you accept.
**Regenerate** for another attempt, or **Discard** to drop it. The banner's **Resolve all
with AI** walks every conflict in turn. It runs on any provider, including local Ollama and
keyless Claude Code / Codex agents, and skips files matched by your AI ignore patterns.{{/ai}}`,
  },
  {
    id: "pull-requests",
    label: "Pull requests",
    body: `# Pull requests

The **Pull Requests** tab ({{kbd:tab-pulls}}) manages GitHub PRs, GitLab merge requests,
and local PRs. (Hosted PRs/MRs need the matching CLI — \`gh\` or \`glab\` — installed and
authenticated.)

## GitHub PRs

Browse open/closed PRs and open one in a full in-app view: description, commits, changed
files with diffs, and CI checks. From there you can **comment** (with quote-reply),
**review** (approve / comment / request changes), **edit** the title and body, manage
**labels**, **assignees**, and **reviewers** (request a review from a collaborator — the
picker excludes the PR author, whom GitHub won't let you request), mark a draft **ready**,
**merge** (merge commit, squash, or rebase, with optional branch deletion), and **close**.
Reviewers who've already reviewed show as read-only chips carrying their verdict — a check
for **approved**, an X for **requested changes**, a speech bubble for **commented** (icon
shape plus the word, never color alone) — so a finished review (including Copilot's) stays
visible after the reviewer leaves the pending-request list.

The Conversation tab is a single **date-sorted activity feed** — reviews, comments,
pushed commits, and events all interleaved oldest-to-newest. A run of pushes collapses
into one **pushed N commits** row that expands to the commits (arrow-navigable), and each
commit's short SHA is clickable — it jumps to that commit's detail. On GitHub, events show
up as calm one-line entries: force-pushes, label added/removed, review requested, marked
ready for review, converted to draft, closed, reopened, merged, and renamed. An **approval
or changes-request that predates a later push is flagged stale** (**stale · N commits
since**), so an out-of-date verdict never reads as current. The feed works for **GitLab
MRs**, **Bitbucket PRs**, and **local PRs** too — see their sections below for the events
each one reports.

CI checks appear as a **rollup summary** — **✓ N passed · ✕ M failed · ● K pending**,
each count with its own icon and word so status never rides on color alone. It
auto-expands whenever something has failed. Expanding lists the checks failures-first
(arrow-navigable). A failing **GitHub Actions** check **peeks its job log inline**,
without leaving the PR — **copy** the log with the button in its top-right corner — with
an **Open full run** link; an external check (Vercel and the
like) links straight out to its details. **GitLab MRs** get the same rollup from the MR's
pipeline jobs, with the same **inline log peek**; **Bitbucket PRs** get it from the PR's
commit build statuses, but those **link out only** (name, state, and URL — Bitbucket
exposes no fetchable job logs).

Comments, replies, edits, and descriptions use a Markdown editor with **Write / Preview**
tabs and a formatting toolbar (bold, italic, headings, quote, code, links, and bulleted
/ numbered / task lists, with {{key:mod+b}} / {{key:mod+i}} / {{key:mod+k}}). The same
editor is everywhere you write Markdown — issues, discussions, and release notes.

## Review comments

Line-anchored review comments — left by humans or bots like **Copilot** and
**CodeRabbit** — surface in the **Conversation** tab and the **Files** tab. On
**GitHub**, each review's comments render **inline under that review** in the
Conversation timeline, grouped by file — so you read them in context, right where
the review lands. Everything left outside a review — standalone GitHub line
comments, and *every* thread on **GitLab** and **Bitbucket** (which don't tie
comments to a review) — collects in a **by-file block** below the timeline, headed
*Review comments* (or *Other line comments* when some already appear inline above).
The file-group header carries the path, so each thread shows just its line —
**Line 43**, or **Lines 31–35** for a multi-line range. A thread expands to the full reply chain and carries an
**Outdated** badge when its line no longer exists in the diff and a **Resolved** badge
once closed. Resolved threads tuck behind a per-file **✓ n resolved** expander so the
open ones stay in view. On **GitHub**, an expanded thread also shows the **anchored code
excerpt** — the diff hunk the comment was left on — above the first reply; GitLab and
Bitbucket don't expose that hunk, so their cards show the line chip alone. Reviewer
\`\`\`suggestion blocks render as a **Suggested change** diff — the anchored lines against
the proposed replacement (a labeled block of just the replacement where the originals
can't be recovered). That block gets an **Apply** button on **GitHub, GitLab, and
Bitbucket** PRs alike — GitDesktop's
local answer to GitHub's *Commit suggestion* (which has no public API): it writes the
change straight to your **working tree**, first verifying the target lines still match what
the reviewer saw (it refuses honestly if the file has drifted) and preserving the file's
line endings and BOM. It **stages** the file only when it had no other local changes;
otherwise it applies unstaged and tells you why. Apply is disabled with an explanation when
the thread is **outdated** or a branch other than the PR's head is checked out. In the
**Files** tab, the same threads are anchored **under their exact line** in the diff (both
unified and split), so you read each comment next to the code it's about; outdated or
unanchored threads stay in the Conversation tab instead. From either place you can
**reply** in-thread, **resolve / unresolve** (where the provider allows it), **edit or
delete your own** thread comments, **quote** a
comment into the main composer, and **copy** the whole thread — path, line range, the
diff excerpt, and every reply — as Markdown.

## Compose your own review

In the **Files** tab, **click a line number** — or **drag across a range** of them — to
open an inline composer right under the diff. A dragged range lands as a **real multi-line
anchor** on **GitHub and GitLab**; **Bitbucket** anchors at the last line, and the composer
says so. Clicking the **+** on **any line** of a drag (not just its last) reopens the same
range. From there you can:

- **Add single comment** — post one line comment immediately (it appears in the thread
  right away).
- **Start a review** — batch the comment as a **draft** instead of posting it. Once a
  review is in progress the button reads **Add to review**, and each draft renders at its
  anchor with a **Pending** badge and inline **Edit** / **Delete**. Pending drafts are
  **saved to disk per PR**, so they survive closing the PR or restarting the app.
- **Add suggestion** — insert a provider-correct \`\`\`suggestion block pre-filled with the
  selected code, ready to edit (GitHub carries the range on the anchor, GitLab uses its
  \`:-N+0\` form, and Bitbucket suggestions are single-line).

A **Review in progress** bar shows the pending count with **Submit review…** and
**Discard**. Submitting opens a dialog to choose a **verdict** — **Comment**, **Approve**,
or **Request changes** — each offered only where the provider allows it; **Request changes**
requires a summary. Submit posts all your pending drafts as one batch review (it works with
no drafts too, for a plain verdict + summary). **Submit review…** and **Discard pending
review** are also available from the command palette ({{kbd:command-palette}}).

## The Commits tab

A PR's **Commits** tab is arrow-navigable — **↑ / ↓** to move, **Enter** to open a commit.
A hosted commit opens a **detail view**: its full message body, a changed-file list with
per-file diffs, and a **copy SHA** control (a local PR's commit opens the full history
commit detail instead). The detail view also carries **commit comments** — a whole-commit
thread and **line-anchored comments** on the commit's diff (click a line, or drag a range),
with create / edit / delete of your own, on GitHub, GitLab, and Bitbucket. A dragged range is
a real range on **GitLab**; **GitHub** and **Bitbucket** commit comments anchor to a single
line, and the composer says so.

Create a PR with **Create pull request** ({{kbd:create-pr}}) or from the Compare tab — as
a **draft** if you like, and set its **labels** and **assignees** right in the dialog
(GitHub and GitLab; Bitbucket PRs have neither, so it shows only its reviewers picker
instead){{ai}}. You can also fill the title and description with an **AI-generated** draft
from the branch diff and commit subjects — which additionally **proposes labels**, chosen
only from the repository's existing labels and added to whatever you've already picked
(never invented). The same **Generate** button is on the **Edit** dialog too, so you can
write or regenerate an existing PR's title and description at any time — including for pull
requests from forks{{/ai}}.

## GitLab merge requests

Point the app at a **GitLab** repo and the same tab lists its **merge requests** (open and
closed/merged) next to any local PRs. Open one for the description, comments, commits, and a
highlighted **diff** (with an **Open on GitLab** link) — and the GitLab MR writes:
**comment** on it (and **edit** or **delete** your own comments), **close / reopen** it,
**edit** its title and description,
**approve / unapprove** it (a reviewer action,
with the approval count shown inline), **request changes** (the blocking reviewer state —
it adds you as a reviewer if needed, posts your drafted comment alongside, and clears when
you approve), **react** with emoji on the description and comments,
edit its **labels**, **assignees**, and **reviewers** (request a review from a project
member; on GitLab's free tier only one reviewer sticks, and the app tells you if others
were dropped), track **time** on it (a clock summary in the
header opens a popover to set an estimate and log spent time), and **merge**
it — merge or squash, optionally deleting
the source branch, guarded so it never merges a head you didn't see (GitLab applies the project's
configured merge method, so there's no separate "rebase" option). While a pipeline is running the
merge menu also offers **auto-merge** (merge when the pipeline succeeds) — GitLab merges it for
you once the pipeline passes, and an **Auto-merge enabled** indicator in the footer lets you cancel
it in place. Its **line-anchored review comments** render too — grouped by file in the
Conversation tab and anchored in the Files diff (see *Review comments* above) — with
reply-in-thread, resolve/unresolve, and edit/delete of your own thread comments. The MR's
Conversation is the same **date-sorted activity feed** as GitHub's: pushed commits, label
add/removed, close/reopen/merge, and approval events (approved / changes-requested /
approval-withdrawn), all interleaved with reviews and comments — GitLab doesn't report
force-push or draft events, so those don't appear. Its **CI checks** roll up from the MR's
pipeline jobs, and a failing job **peeks its log inline** just like GitHub Actions.
**Creating a merge request**
works from the app too ({{kbd:create-pr}}, the New menu, or the Compare tab) — it pushes your
branch and opens the MR, with the same draft checkbox and AI description as GitHub, and the
Compare tab points you at an **existing open MR** from your branch instead of creating a
duplicate. GitLab uses the GitLab
CLI (\`glab\`) — run \`glab auth login\` once, no tokens stored. **Self-managed GitLab works
too**: sign \`glab\` in to your instance (\`glab auth login --hostname …\`) and the app
recognizes repositories on that host automatically. Its issues, CI pipelines, and
releases work too (see their sections below).

## Bitbucket PRs

Point the app at a **Bitbucket Cloud** repo (connect with an Atlassian API token in
**Settings → Accounts**) and the same tab lists its **pull requests**. A Bitbucket PR's
Conversation is the same **date-sorted activity feed**: pushed commits, merge/close, and
verdicts (approved / changes-requested), interleaved with reviews and comments. Bitbucket
has no labels or review-request events, so those don't appear. Its **CI checks** roll up
from the PR head commit's build statuses — name, state, and a **link out** to each status;
Bitbucket exposes no fetchable job logs, so these don't peek inline the way GitHub Actions
and GitLab pipeline jobs do.

## Local PRs

A **local PR** is the same review workflow against any two branches with **no remote at
all** — describe it in Markdown, comment, label, approve, and merge locally. Local PRs
are private to you and never written into the repo. When you're ready, **promote** a
local PR to a real GitHub PR or GitLab MR in one click, history preserved.

Its Conversation is the same **date-sorted activity feed** as the hosted PRs: it opens with
a **created** marker, interleaves the branch's **pushed commits** (grouped, each short SHA
clickable to that commit's detail) with your **comments**, and ends with a **merged** or
**closed** marker once the PR reaches that state.

Before you merge, the PR footer previews whether the merge will **conflict** or land
cleanly. If a merge does hit conflicts, GitDesktop runs it in an **isolated worktree** —
your branch and working tree are left untouched, so you don't need a clean tree (unless
you're merging into the branch you're currently on). The PR view opens a **resolve
surface** with the conflicted files and the in-app conflict editor (see *Syncing &
conflicts*); once every conflict is resolved, **Finish merge** commits and marks the PR
merged, or **Abort** throws the merge away.

**Managing the record** lives on the PR's list row, not the merge footer (which is just
the merge decision): **right-click** a local PR to **Archive / Unarchive** it (archiving
hides it and deselects the detail view) or **Delete** it — Delete confirms first and
tells you how many comments go with it; the branches themselves are never touched. Both
are also in the command palette ({{kbd:command-palette}}) as **Archive pull request** and
**Delete pull request**, acting on the selected local PR.
{{ai}}
## AI review

On any PR — GitHub or a GitLab MR — run a streamed **code review** or a focused
**security audit** of its changes
using your chosen review model, and optionally post the result as a comment. A general
review builds on **soft context** where it exists: your prior review of the PR, findings
other AI reviewers (Copilot, CodeRabbit) left, and **GitDesktop's own earlier comments on
the PR** — so on a re-review it treats a finding it already refuted or marked fixed as
resolved instead of raising it cold. See *AI & automations* to pick the review model.

**Agentic review.** The panel's **Agentic review** toggle gives the reviewer read-only
tools so that, instead of relying on the prompt's truncated summary, it pulls the **full PR
diff**, reads any file at any ref, searches the repo, runs history, and reads the
PR's existing comments and threads — so big PRs stop hedging about the part they couldn't
see. It works two ways depending on your review model. **CLI agent models** (Claude,
Copilot, opencode) get the tools through GitDesktop attaching to the run as a **read-only
MCP server**. **HTTP/API models** (Anthropic, OpenAI, OpenAI-compatible, OpenRouter,
Ollama) get a **native, read-only tool loop** instead — with **no review workspace to
prepare**, so those reviews start instantly (no "Preparing review workspace…" wait).
Either way it's **read-only end to end** — only read tools exist in the loop, so the
reviewer can explore but never modify — and the status line shows what it's reading as it
goes. When a review's diff outgrows the prompt budget, the panel offers one click to turn
on agentic review for full coverage. A couple of caveats: each tool step is an extra model
call, so agentic runs are slower and pricier than a one-shot review; and small local models
(some Ollama models) may not support tool calling — the review fails with a clear message
suggesting you turn agentic off or pick another model. (Codex reviews already explore the
repo on their own but can't attach the GitDesktop tools, so they get the file-exploration
framing without the PR tools.)

Every AI-posted review is **clearly machine-authored**: a branded GitDesktop header and
footer on the comment, and on a **local PR** a "GitDesktop" bot author with a robot avatar.
On **GitLab**, add a project or group access token in **Settings → Accounts** (see
*Settings & updates*) and your AI reviews post as the real **GitLab project bot** rather
than your signed-in \`glab\` account.{{/ai}}`,
  },
  {
    id: "issues",
    label: "Issues",
    body: `# Issues

The **Issues** tab ({{kbd:tab-issues}}, in the More ▾ menu) manages GitHub issues, GitLab
issues, and private local issues. (The **GitLab issues** section below covers exactly which
GitLab actions are available.)

## GitHub issues

Browse, filter, and open issues in a full view: body, comments, labels, assignees,
milestone, and reactions. **Create** an issue, comment with the Markdown editor, edit,
add labels, **close / reopen**, **lock**, and **transfer** an issue to another repo.

- **Sub-issues** — break an issue into a parent/child checklist with completion tracking.
- **Dependencies** — link issues as blocked-by / blocking.
- **Development** — see linked PRs and branches, and **create a branch** wired to the
  issue.

## GitLab issues

Point the app at a **GitLab** repo and the same tab lists its **issues** (open and closed)
next to any local issues. Open one to read the description and comments — and the GitLab
issue **writes**: **comment** on the issue (and **edit** or **delete** your own comments),
**close / reopen** it, **edit** its title and
description, **react** with emoji on the description and comments (GitLab's award emoji),
and set its **labels**, **assignees**, and **milestone** right in the side
rail. The rail also carries GitLab-unique fields: a **due date** (type a date and
press Enter, or pick from the calendar; **Clear** removes it, and an open issue past
its date reads "Past due"), a **confidential** toggle (hides the issue from
non-members), **time tracking** (type an **estimate** like \`3h\`, log **spent** time
like \`45m\` or subtract with \`-15m\`, with a progress bar and an "over" note when
spent exceeds the estimate), and **related issues** (link other issues in this project,
with an inline picker; open one from the rail or unlink it). The **More actions** menu works too: **lock / unlock** the conversation (GitLab
locks without a reason, so there's no reason submenu), **duplicate** the issue, **move**
it to another project you have access to (the original closes with a "moved" marker),
and **delete** it (Owner-only). **Creating issues** works too — the New menu (or
{{kbd:create-issue}} from the
palette) opens the same dialog GitHub uses, with labels, assignees, and a milestone (the
org issue type is the one GitHub-only picker). The repository menu works too: **View on
GitLab**, **star / unstar**, and a **Fork on GitLab** link, **Repository settings**
(see that section — the dialog manages GitLab projects too), and you can **publish** a
local repository straight to GitLab (it creates the project, adds it as
\`origin\`, and pushes).

## Jira issues

Link a **Jira Cloud** project to any repository and the Issues tab gains a
**Jira · PROJECTKEY** section. Link one from the repo **⋯** menu's **Link Jira project…**
(pick your Jira site and a project), then browse the project's issues alongside any local
ones. The open / closed / all filter maps to Jira's status **categories** — "To Do" and
"In Progress" issues count as open, and anything in the **Done** category counts as closed
— while each row still shows its real status name (e.g. *Selected for Development*,
*In Review*, *Done*). Open an issue to read its **status**, **type**, **priority**,
**assignee**, and **labels**, plus the Markdown **description** and **comments**. Every
issue links out with **View in Jira**.

When the project uses them, issues also show their **agile fields** — **story points** (both
on the list rows and in the detail), **sprint**, a clickable **epic / parent** (open it to
jump to that issue), **components**, and **fix versions**. These are resolved automatically
per Jira site, so there's nothing to configure; all of these agile fields are read-only
here (edit them in Jira).

**Time tracking** appears when the linked project has it enabled (on projects without it,
the section simply doesn't show). You'll see the **original estimate**, **remaining**, and
**time spent** — Jira's own values — with a progress bar. **Log work** using Jira's duration
grammar (\`2d 4h 30m\` — weeks, days, hours, and minutes) with an optional note, and Jira
decrements the remaining estimate for you; you can also **set or clear the original and
remaining estimates** directly. The most recent **worklog entries** are listed (Jira returns
the first 20), you can **edit or delete your own** entries — or anyone's, if you hold Jira's
project-admin worklog permissions — and the full history is a **View all in Jira** link away.
As with every other action here, these are gated on your Jira permissions — logging work,
editing estimates, and worklog edits each need the matching permission, so a control appears
only when your role allows it.

You can work an issue without leaving the tab. **Create** one ({{kbd:create-jira-issue}}
from the palette) with a summary, Markdown description, and an **issue-type** picker;
**comment** in Markdown; **close or reopen** it by following the project's own workflow —
the confirmation names the real resulting status, not a generic "closed" — or move it to
any workflow status from the **status menu** on the chip, which lists the transitions your
role allows by their target status name; **assign or unassign** it by searching your
project's users; set or clear its **due date**, change its **priority**, and edit its
**labels**; and **edit or delete your own comments** (or anyone's, with Jira's project-admin
comment permissions). Each action is gated on your Jira permissions, so anything your token
and role can't do simply doesn't appear — a control shows up only when your permissions allow
it.

**Referenced issues follow your work.** When a **branch name**, a commit's message (in the
commit detail view), or a pull request's title or description mentions one of the linked
project's issue keys (e.g. \`PROJ-123\`), GitDesktop shows a compact **referenced Jira
issues** row there. Click a key to jump to that issue in the **Jira** section of the Issues
tab. Only the **linked project's** key is matched — no other project and no generic key
pattern.

You can also **promote a local issue to Jira.** When a repo is linked, the local issue's
**publish** action offers Jira as a destination (alongside GitHub or GitLab when both are
available); its comments carry over to the new Jira issue, and the local issue closes with a
back-link to it.

To connect, add an **Atlassian API token** (your Atlassian account email plus the
token, validated against the site before it's saved and stored in your OS keychain); if
you've already connected Bitbucket (see *Bitbucket repositories*), you can **reuse that
credential** with one button instead of re-entering it.

## Local issues

A **local issue** is a private, offline to-do tracked in the app — create, edit, label,
and close it with no remote. When it's ready to share, **promote** it to a GitHub or
GitLab issue — or, when the repo has a **linked Jira project**, to a Jira issue — in one
click.
{{ai}}
## Hand off to an agent

From an issue, **Solve with agent** starts a write-capable agent session framed around
that issue (see *Agent sessions*).{{/ai}}`,
  },
  {
    id: "discussions",
    label: "Discussions",
    body: `# Discussions

The **Discussions** tab ({{kbd:tab-discussions}}, in the More ▾ menu) browses and takes
part in GitHub Discussions for the repo. (Discussions must be enabled on the repo.)

- Read **threaded conversations** — top-level comments with nested replies — and post,
  edit, delete, or hide comments with the Markdown editor.
- In a Q&A discussion, **mark a reply as the answer**.
- Add **reactions** and upvotes.
- Manage a discussion's lifecycle: **close** (as resolved / outdated / duplicate),
  **reopen**, **lock**, and **delete**.
- **Create a discussion**, or **create an issue from a discussion** when a thread turns
  into actionable work (the new issue links back to it).`,
  },
  {
    id: "releases",
    label: "Releases & tags",
    body: `# Releases & tags

The **Tags** tab ({{kbd:tab-tags}}, in the More ▾ menu) manages your repository's tags and
releases — GitHub and **GitLab** releases both (the GitLab section below covers the
provider differences).

- See every tag and **create a tag** (also available from a commit in History).
- **Create a release** from a tag: set the title and notes, mark it a **pre-release** or
  **draft**, and publish. Releases show badges (**Latest**, **Pre-release**, **Draft**).
{{ai}}- **Generate release notes with AI** — draft the notes from the commits and
  changelog between this tag and the previous one, then edit before publishing.{{/ai}}

## GitLab releases

Point the app at a **GitLab** repo and the **Tags** tab lists its **releases** alongside your
local tags (release rows carry the **Latest** badge). Open one to read the release **notes**,
who published it and when, and its **asset links** — click to open them in your browser. The
release actions work here too: **publish a release** (from an existing tag or a new one
created from a target branch/commit), **edit** its title and notes, **delete** it (optionally
deleting the tag), **upload** a file as an asset link, and **delete asset links**. GitLab has
no draft or pre-release concept and picks the latest release itself, so those GitHub toggles
don't appear.`,
  },
  {
    id: "actions",
    label: "GitHub Actions",
    body: `# GitHub Actions

The **Actions** tab ({{kbd:tab-actions}}, in the More ▾ menu) is a cockpit for your GitHub
Actions workflow runs (needs \`gh\` + a GitHub remote). **GitLab pipelines** show here too
(see below).

- The list shows recent runs with live status, refreshing while any run is active. Filter
  by text or scope to the current branch.
- Click a run to see its **jobs and steps** with status and durations.
- **Re-run all jobs**, **Re-run failed jobs**, or **Cancel** an in-progress run.
- **Run workflow…** manually dispatches a workflow (one with a \`workflow_dispatch\`
  trigger) on a branch you choose, including any **input parameters** it defines.
- Expand any job for its **logs** — or a failed run's **failed-step logs** — inline, and
  **copy** them with the button in the log's top-right corner.

## GitLab pipelines

Point the app at a **GitLab** repo and the same tab lists its **pipelines** — newest first,
filterable, optionally scoped to the current branch — with the header CI badge tracking the
latest one. Open a pipeline to see its **jobs** (status + durations); expand a job for its
**log** (copyable from its corner). The pipeline actions work here too: **Cancel** a running pipeline, **Retry** a
failed or canceled one (GitLab restarts its failed jobs), and **Run pipeline…** starts a
fresh pipeline on a branch or tag, with optional **CI/CD variables**. A **manual job** —
one that waits for a manual trigger — shows a **Run job** button that plays it.
{{ai}}
## Debug with AI

On a failed job, **Debug with AI** reads that job's logs and streams a diagnosis: the
likely **root cause**, a concrete **fix**, and — at the end — a ready-to-paste **agent
prompt** you can hand to a coding agent to implement the fix. Copy just that prompt with
**Copy fix prompt**.

{{/ai}}A small **CI badge** in the header tracks the current branch's latest run; click it
to jump to that run. You can also get an OS **notification** when a run finishes
(**Settings → Notifications**).`,
  },
  {
    id: "bitbucket",
    label: "Bitbucket repositories",
    body: `# Bitbucket repositories

GitDesktop works with **Bitbucket Cloud** repositories. Connect once in **Settings →
Accounts**: create an **Atlassian API token** at id.atlassian.com, then enter your
Atlassian **account email** (not your Bitbucket username) and the token. It needs the
five read scopes \`read:user:bitbucket\`, \`read:workspace:bitbucket\`,
\`read:repository:bitbucket\`, \`read:pullrequest:bitbucket\`, and
\`read:pipeline:bitbucket\`. To also **act on** pull requests and Pipelines (below), add
the write scopes \`write:pullrequest:bitbucket\`, \`write:pipeline:bitbucket\`, and
\`admin:pipeline:bitbucket\` (pipeline variables & config). To **manage repositories** —
publish a local repo, edit repository settings, branch restrictions, default reviewers,
webhooks, or delete — also add \`write:repository:bitbucket\`,
\`admin:repository:bitbucket\`, \`delete:repository:bitbucket\`, and the webhook scopes
\`read:webhook:bitbucket\`, \`write:webhook:bitbucket\`, and \`delete:webhook:bitbucket\`.
A write fails with a clear message if the token lacks the matching scope. The token is
stored in your OS keychain — never in app files.

Once connected:

- **Clone browser** — the **Clone repository** dialog ({{kbd:clone-repository}}) gains a
  **Bitbucket** tab that lists your repositories to filter and clone. (Cloning a private
  repo uses your system git credentials, e.g. Git Credential Manager — GitDesktop doesn't
  inject the API token into git.)
- **Pull requests** — the **Pull Requests** tab lists a Bitbucket repo's PRs; open one to
  read its **diff**, **comments**, and **build statuses**, and to act on it: **comment**,
  **decline**, **merge** (merge commit, squash, or fast-forward, with an optional
  delete-source-branch), **edit** the title/description, **approve/unapprove**,
  **request changes** (a true toggle — click again to revoke; approving also clears it),
  pick **reviewers** from your workspace members (the PR author can't review their own
  PR, so they never appear), and flip **draft ↔ ready** in either direction. Its
  **line-anchored review comments** render too — grouped by file in the conversation
  column and anchored in the Files diff (see *Review comments* under *Pull requests*) —
  with reply-in-thread and edit/delete of your own thread comments (Bitbucket has no
  thread resolve/unresolve). Use
  **Create** to open a new PR (drafts included) — the create dialog also lets you pick
  **reviewers** up front (leave it empty to keep Bitbucket's default reviewers). An open PR
  also gets a **Tasks** checklist in the conversation column: **add**, **edit**, and
  **delete** tasks, **resolve/unresolve** them (a progress bar tracks completion), and jump
  to the list from an "N open tasks" chip in the PR header; a task attached to a comment
  links back to it. On a closed or merged PR the checklist is read-only. One thing Bitbucket
  itself can't do from the API: **reopening a declined PR** (so there's no Reopen button — a
  Bitbucket platform limit).
- **Pipelines** — the **Actions** tab lists Bitbucket **Pipelines**; open one to see its
  **steps** with their **logs**. You can **rerun** a finished pipeline (re-triggers its
  branch), **trigger** a new one on a branch or tag (with optional variables), and **stop**
  a running pipeline. When the repo's \`bitbucket-pipelines.yml\` defines **custom
  pipelines** (\`pipelines.custom.*\`), the **Run pipeline** dialog adds a **Pipeline**
  picker — run the branch's **Default** pipeline or a named custom one, with the same
  variables.
- **Insights** — the **Insights** tab works on Bitbucket repos: the local-git charts
  (commit activity, code frequency, contributors, punch card), a **Pipelines** duration
  and success-rate chart, and a **More on Bitbucket** card that links out to the
  **Commits**, **Branches**, **Pipelines**, and **Deployments** pages (these only render on
  the web). GitHub-only cards (community, traffic, dependencies) stay hidden.
- **Publish a local repo** — a repo with no remote can be published to Bitbucket. From
  the sync bar's **Publish repository…** (or the not-ready panel), pick **Bitbucket**,
  choose a **workspace**, give it a name (which becomes the URL slug), and optionally a
  description, website, and private/public — GitDesktop creates the repo, adds it as
  \`origin\`, and pushes the current branch. (Bitbucket has no topics, so there's no topics
  field.)
- **Repository settings** — for a repo you **admin**, the repo ⋮ menu's **Repository
  settings** manages the Bitbucket repo: General, Default reviewers, Branch restrictions,
  Variables, Schedules, and Deployments (Pipelines), Webhooks, and a Danger zone (rename,
  visibility, transfer, delete). See **Repository settings → Bitbucket repositories** for
  the details.
- **Issues** — Bitbucket has retired its native issue tracker (issues live in **Jira**),
  so a Bitbucket repo shows no native issues. Instead, **link a Jira project** to browse
  its issues right here (see *Jira issues* under *Issues*) — the Issues tab's empty state
  offers this directly. Private **local to-dos** still work too.

If a Bitbucket panel says it can't sign in, your token may be expired, revoked, or
missing scopes — update it in **Settings → Accounts**.`,
  },
  {
    id: "insights",
    label: "Insights",
    body: `# Insights

The **Insights** tab ({{kbd:tab-insights}}, in the More ▾ menu) is a dashboard of
repository analytics, mixing local Git history with hosted data (GitHub, GitLab, or
Bitbucket).

- **Repository statistics** — commits, contributors, branch and tag counts, sizes, and a
  language-makeup bar.
- **Commit activity** — commits per week, and a **code-frequency** chart of additions and
  deletions over time.
- **Top contributors** and a **punch card** heatmap of commits by day and hour.
- **CI usage** — recent run duration and success rate (GitHub workflow runs, GitLab
  pipelines, or Bitbucket Pipelines).
- On GitHub: **community health** (stars, forks, watchers, a health percentage),
  **traffic** (14-day views, clones, and top referrers — needs push access), and
  **dependencies**.
- Quick links jump to the pages best viewed on the web — GitHub's Pulse, Network, Forks,
  Dependents, and Actions; GitLab's Activity, CI/CD analytics, and value stream analytics;
  or Bitbucket's Commits, Branches, Pipelines, and Deployments.`,
  },
  {
    id: "agent",
    label: "Agent sessions",
    ai: true,
    body: `# Agent sessions

The **Agent** tab turns a configured CLI agent (Claude Code, Codex, GitHub Copilot, or
opencode) into a hands-on teammate that can **research**, **plan**, and **implement** changes
for you — safely, in an isolated copy of your repo. It appears when AI features are enabled.

The **sidebar** lists your research, plans, and sessions. Each carries a stable **#N**
identifier, so an entry can point at what it became — a research run shows the **plan** it
turned into (*Turned into plan #12*), and a plan shows the **session** that implemented it
(*Implemented · Ready to review #10*). Each row also shows its **provider · model**;
**right-click** for a row's actions — a plan's include opening its **session** or filing it as
a **local issue**. The **step-by-step activity log** of each entry is kept across restarts.

## Research a topic (read-only)

**Research** runs a read-only, **web-enabled** agent that explores the web *and* your repo,
then streams a **cited report** right here in the app. Pick an intent — and switch between
them anytime from the follow-up composer, the way you'd switch a model:

- **Brainstorm** — breadth-first. Surveys what's out there and surfaces several distinct
  directions with rough tradeoffs and prior art (who else does this), so you can widen your
  options before committing to one.
- **Deep research** — depth-first. Investigates one direction rigorously — feasibility,
  approaches, libraries, tradeoffs — grounded in primary sources, with a confidence note per
  major claim and an explicit "what I couldn't verify".

The natural flow: start in **Brainstorm** to widen your options, then **switch to Deep
research** to flesh out the direction you chose — the whole conversation carries over, so the
agent keeps everything it already explored. Keep refining with follow-up messages; the agent
keeps its sources in context. When a report is ready you can **Turn it into a Plan** (it
distills the whole session into a plan-ready brief to hand the planner, falling back to the
full session if distillation is unavailable) or **Save report** as a local Markdown
file (written to \`.gitdesktop/research/\` for you to review and commit — never committed for
you). It's **read-only**: it searches and reads, but never changes your code. Pick any agent —
**Claude**, **Codex**, **GitHub Copilot**, or **opencode** — each uses its own native web search
and fetch. (opencode's web *search* needs its Exa integration enabled — web *fetch* always works.)

## Plan a task (read-only)

**Plan a task** runs a read-only agent that explores the current repo and drafts an
**agent-ready issue** — context, approach, affected files, acceptance criteria, and a
test plan. It can ask clarifying questions; answer them and it refines the plan in the
same conversation. The cited file paths are validated against the repo, so the plan stays
grounded. From a finished plan you can **file it as a GitHub or local issue**, or **hand
it straight to an implementing session**.

## Delegate a task

**Delegate** starts a write-capable session. Describe the task, pick the **agent**,
**model**, and **reasoning effort** (Low / Medium / High / Max), and send. The agent works
in an **isolated git worktree** — a throwaway branch (\`gd/session/…\`) that never touches
your working tree — and commits a **checkpoint** each turn. It works in the open: the
conversation shows a **step-by-step transcript** of each file it reads, edits, searches,
and command it runs, interleaved with its narration. **Expand any edit step** to see that
file's diff inline, watch its **live changes** mid-turn, or read the cumulative diff under
**Changes**.

In the composer you can:

- Reference a file with **@** (autocomplete), so the agent reads the right file.
- Run a **slash command** — built-ins like \`/review\`, \`/test\`, \`/fix\`, \`/explain\`,
  and \`/refactor\`, plus the selected CLI's own commands (such as \`/plan\` with Copilot
  or Codex) and your project's custom commands and **skills**.
- Opt into **MCP servers** for the session from the **MCP** picker (appears once you've
  registered some — see below).
- Continue the conversation across turns; **↑ / ↓** recall previous prompts.

## MCP servers

Register **Model Context Protocol** servers under **Settings → MCP servers** — local
(\`stdio\`) processes or remote (HTTP) endpoints, with environment variables / headers and
**secrets kept in your OS keychain**, never in your settings file. Each session opts into
the ones you choose from the composer's **MCP** picker. **Claude**, **Copilot**, and
**opencode** run MCP servers on the **host** *or* in a **container**; **Codex** runs them
in a **container** only (local/\`stdio\` servers — host Codex can't approve MCP tool calls,
so it needs the container's sandbox). A **remote (HTTP)** server whose host isn't on your
**AI allowed hosts** list is flagged with a **host not allowed** badge (and an advisory note
in its editor with a one-click **Allow host**) — a reminder that the CLI connects to that
host outside GitDesktop's AI host allowlist. It's advisory only: nothing is blocked, and the
server keeps working. In a container the servers run *inside* the sandbox,
sharing an npm cache so an \`npx\` server is downloaded only once. A Claude run is **strict** —
it gets *only* the servers you picked and never inherits others on your machine — while
Copilot and opencode layer your picks onto their own config. The composer's **MCP** picker
shows for every agent and tells you when to switch isolation. You can also change the
selection **mid-session** — the picker appears in a running session's reply box too, and a
new choice applies from your next turn.

**The other direction — GitDesktop *as* a server.** At the bottom of the panel, **Use
GitDesktop as an MCP server** lets any external MCP client — Claude Desktop, Cursor, Claude
Code — use *this* repo's tools. **Reads are always on and are the default**: status, log,
diffs, blame, branches, file history/read, PRs, issues, CI logs, labels, milestones,
releases, and a PR's full timeline. The PR, issue, and CI tools work
across **GitHub, GitLab, and Bitbucket** — they route through GitDesktop's forge layer and
dispatch by the repo's remote (Bitbucket covers PRs and pipelines, but not issues — its
native tracker is deprecated). If the repo has a **linked Jira project**, a set of
\`jira_*\` tools list and read that project's issues too — the tools resolve the repo's
stored link themselves, so an agent never passes a site or project. The app itself runs as a stdio server — on macOS and Linux
that's the app binary directly (a Personal config embeds its absolute path), and on Windows a
dedicated update-safe \`gitdesktop-mcp\` copy (so running servers never block app updates) — so
an agent can understand a repo without changing it.
**Copy** the snippet and paste it into your client's config, or hit **Write to
.mcp.json** to merge the \`gitdesktop\` entry into the open repo's \`.mcp.json\` for you —
existing servers are preserved, and you're asked before an existing GitDesktop entry is
replaced. Or **install it globally** for **Claude Code** or **Copilot** — a per-client row
for each adds the \`gitdesktop\` entry to that client's user config (so it's in *every*
project, no per-repo file) via the client's own CLI, with a project-aware \`--repo\` so the
single entry follows whatever repo you open. Each row shows its **live state**: already
installed and pointing at the current launcher, or pointing at an older install (a one-click
**Reinstall** switches it over) — with **Remove** to take it back out, no confirmation needed.
An installed row also reads out the entry's **permission tier** (e.g. *Installed (local +
remote writes)*, or *read-only*), and once you change the permission checkboxes so they no
longer match the installed entry it flags the mismatch and offers **Reinstall** to apply the
new selection.
Two toggles shape what gets written: **Shareable entry** swaps machine-specific
absolute paths for portable \`\${GITDESKTOP_BIN:-gitdesktop-mcp}\` / \`\${CLAUDE_PROJECT_DIR}\`
ones a teammate can commit (they point \`GITDESKTOP_BIN\` at their own launcher, or keep
\`gitdesktop-mcp\` on their PATH), and **Allow write tools** adds \`--allow-write\` so an agent
can also **create**, **comment on**, set the **status** of, and **approve** *this repo's*
local PRs — and create, comment on, and set the status of its **local issues** — GitDesktop's
own app-data review artifacts (nothing is pushed).

To make the bare launcher command actually resolve in a terminal (so the **Shareable
entry** works with no hardcoded path and no \`GITDESKTOP_BIN\`), use the **Command-line
launcher** at the bottom of the disclosure: **Add to PATH** puts the launcher's folder on
your user PATH on Windows so \`gitdesktop-mcp\` resolves, or symlinks \`gitdesktop-mcp\` into
\`~/.local/bin\` on macOS/Linux (open a new terminal afterward on Windows), and **Remove**
undoes exactly that — no admin needed either way. On both platforms, re-running it also
migrates any older \`gitdesktop\`-named entry a previous version left behind.

Writes escalate through **four separate flags**, each unlocking one tier — enabling one
never grants another, and every flag is **off by default**, so read-only stays the default.

Beyond \`--allow-write\` (local PRs and issues, above), **Allow remote write**
(\`--allow-remote-write\`) lets an agent make **real forge writes** in this repo under your
authenticated identity (GitHub \`gh\`, GitLab \`glab\`, or a stored Bitbucket token):
**create, merge, update**, and **close/reopen** pull requests, toggle **draft** state,
**request reviewers**, **edit labels**, set **assignees** (on issues and PRs), **approve**,
**request changes**, or **withdraw** either, **start**, **reply to**, and **resolve** review
threads, add or remove **reactions**, **rerun/cancel/dispatch** CI, **create/update releases**,
**create, comment on, close/reopen**, and set the **milestone** of issues, and — on GitHub —
**create, comment on, answer, and close/reopen discussions**. One caveat: **creating** a
pull request pushes its head branch first, so it additionally needs \`--allow-git-write\`
(below). The same flag also unlocks the
linked Jira project's write \`jira_*\` tools — **comment**, **close/reopen**, **create**,
**assign**, and **update** (due date, priority, labels) its issues. Issue
writes cover GitHub and GitLab (not Bitbucket); discussions are GitHub-only; PR comments cover all three. PR comments an
agent posts carry a small **Posted by GitDesktop** footer so they're identifiable as
automated, and on the read side an agent can pull a pull request's full comment set — the
conversation, review summaries, and the file:line review threads.

**Allow git write** (\`--allow-git-write\`) is a further, independent tier for **recoverable
local-git mutations** of the bound repo — stage/unstage, commit (and undo the last commit),
create/checkout/rename branches, push/pull/fetch, stash push/pop/apply, merge, rebase,
revert, cherry-pick, and tags — plus two always-on reads it pairs with: list stashes and
preview a merge's outcome. On top of that, **Allow destructive** (\`--allow-destructive\`,
which requires \`--allow-git-write\` too — on its own it grants nothing) unlocks the
**irreversible** operations: delete a branch, discard changes, reset, force-push (with
lease), delete a remote branch, drop a stash, and delete a tag. Agent-session branches
(\`gd/session/*\`) are refused by the branch-mutating tools, so an in-flight agent session is
never broken.

The server also exposes GitDesktop's own **AI generation recipes** (always on, no flag):
\`generate_commit_message\`, \`generate_pr_description\`, and \`generate_branch_name\` each hand
the agent the *same* fully assembled context and prompt the in-app feature builds — the
staged or branch diff (with the same low-value-file budgeting), recent commit subjects as a
style reference, your repo and global instructions, and \`.aiignore\` filtering. The tools
don't call a model; the agent completes the returned prompt with its own inference, so you
can trigger GitDesktop's generation from any client. The same three recipes are also exposed
as native **MCP prompts** (\`commit-message\`, \`pr-description\`, \`branch-name\`) — the
slash-command-like primitive many clients surface — each handing your model the assembled
prompt to complete.

New to MCP? **Browse** opens the official Model Context Protocol registry right in that
panel — search it and add a server in a click; it arrives **disabled** for you to review
and enable. You can also reach it from the command palette (*Browse MCP registry*). Each
result carries signals to vet a server first — **GitHub stars** and last-updated, weekly
**npm installs**, deprecation status, and (when you expand it) the source repo plus exactly
**what it runs or connects to** and which secrets it needs. Toggle between two sources: the
**official registry** and **GitHub** (repositories tagged \`mcp-server\`, ranked by stars).
GitHub results are rougher — ones with a manifest add cleanly, the rest arrive marked
*needs setup* for you to finish.

Already have servers configured? Use **Import** in that panel to pull them in from the
open repo's \`.mcp.json\` or your global Claude config — you pick which ones, they arrive
**disabled** for you to review, and any secret-looking values are moved to your keychain.
Nothing is inherited automatically; the source files are left untouched.

Each server is **scoped** either **Global** (every repo) or to **one repo** — import sets
this from where the server came from, and you can change it when editing. The panel groups
the list accordingly, and a repo-scoped server only appears in that repo's session picker,
so the registry stays tidy as it grows.

When you open Settings **with a repo active**, each global server's row shows a per-repo
control: **On** (available and pre-selected here), **Optional** (available but off by
default), **Off** (not offered in this repo), or **Default** to follow its global setting.
That lets you keep a shared server on in one repo and off in another without touching the
others.

## Run several ways at once (Best-of-N)

**Best-of-N** runs the same task across 2–5 arms, each with its own agent, model, and
effort — so different providers attack the problem from different angles. Each arm runs in
its own worktree; review them side by side and **keep the best one** (it discards the
rest). Because fanning out costs real money, you get an upfront cost estimate first.

## Isolation

Every session is sandboxed. By default it runs in a **worktree** (a separate working copy
on a session branch). Optionally, run it inside a **Docker or Podman container** for a
stronger sandbox — with a built-in **terminal** ({{kbd:agent-toggle-terminal}}) running
*inside* the container, where you choose which dev-server port(s) to publish before it
starts. Set the default in **Settings → AI**. A repo can also layer **extra tools** into
that container: commit a \`.gitdesktop/agent.Dockerfile\` (it must start
\`FROM gitdesktop-agent:latest\`), and — after you review and confirm it in
**Settings → AI** — GitDesktop builds it into a per-repo image this repo's container
sessions then run in.

## Finishing up

A session shows its **cost** per turn. When you're happy, **Keep** it (squashes the
checkpoints onto its branch and frees the worktree); **Resume** later to keep going;
**Discard** to throw it away; or turn a kept session into a **local PR**. Sessions persist
across restarts, split into **Active** and **Kept** tabs with search.

> Provider and model are chosen per session. Switching providers mid-session isn't
> supported (each CLI keeps its own conversation), but you can change the model within a
> provider between turns.`,
  },
  {
    id: "ai",
    label: "AI & automations",
    ai: true,
    body: `# AI & automations

GitDesktop uses AI for commit messages, branch names, PR titles/descriptions, issue and
release drafts, PR reviews, CI debugging, and agent sessions. It's entirely optional and
configured in **Settings → AI**.

## Providers

Bring your own model:

- **Anthropic, OpenAI, OpenRouter, Ollama Cloud** — paste an API key (stored in your OS
  keychain, never in app files).
- **OpenAI-compatible** — any endpoint that speaks the OpenAI API, with one-click presets
  for **Vercel AI Gateway, Google Gemini, DeepSeek, Mistral, and Z.ai (GLM)**.
- **Ollama (local or LAN)** — a local model (your code never leaves your machine), or one
  running on another machine on your network — set its URL in Settings.
- **Claude Code, Codex, GitHub Copilot, opencode CLIs** — *keyless*: they reuse your
  existing CLI login, with no API key. The CLI agents are **write-capable** — they power
  agent sessions and plan mode — and can read repo files for deeper reviews.

You can set **separate models** for generation (commit/PR messages) versus review.

**Custom & LAN servers — allowed hosts.** To reach an Ollama or OpenAI-compatible server
that isn't \`localhost\` (a box on your network, or a self-hosted endpoint), enter its URL in
Settings → AI and add its host to the **Allowed hosts** list — or click **Allow host** on the
prompt that appears next to a not-yet-permitted URL. Built-in providers and \`localhost\` are
always allowed; every other host must be on your list, which GitDesktop checks before each AI
request so it never reaches a server you didn't authorize.

## Generation

AI streams into the same inputs you'd type in, so it's always editable: **commit
messages**, **branch names**, **PR titles and descriptions**, **issue drafts**, **release
notes**, and **repository descriptions**.

## Instructions & privacy

- **Instructions** steer every generation. Set **global** instructions in Settings (e.g.
  "Follow Conventional Commits"), or add a per-repo \`.gitdesktop/instructions.md\` that
  takes precedence.
- **AI-ignore patterns** keep sensitive or noisy files (lockfiles, vendored folders) out
  of the AI's context while still committing them normally — global in Settings, or
  per-repo via \`.gitdesktop/aiignore\`.
- **Hide AI** (Settings → General) removes every AI surface from the app while keeping
  your configuration.

## Automations

**Automations** (Settings → Automations, and per-repo via the repo ⋮ menu → *Automations…*)
run an AI action automatically at a point in your workflow — so a routine review happens
without you asking. It's a **lifecycle grid**: one section per moment — *On commit*, *On pull
request opened*, and *On new commits to a reviewed PR* — with **AI code review** and **AI
security audit** as toggles under each. There's no "add a rule" — a given moment × action
exists at most once, so you can't create conflicting duplicates. Reviews use the review model
from the AI section; PR results are posted as a comment, commit results open from a
notification.

- **Branch conditions.** Each enabled action can be scoped to branches: *only these branches*
  (include globs) and *except these* (exclude globs — an exclude always wins; an empty include
  means all branches). For the PR moments, a **Match against** selector picks *Source branch*,
  *Target branch*, or *Either branch*. A **Try a branch** field tells you live whether a branch
  would run, and names the exclude that skips it. Glob syntax matches branch rules — \`*\` within
  a path segment, \`**\` across \`/\`, \`?\` one character, \`{a,b}\` alternation.
- **Save / Discard.** Both surfaces edit a draft behind Save / Discard (no per-toggle
  autosave) — close with unsaved changes and the app confirms first.
- **Per-repo overrides.** The repo dialog shows the **effective** state (global defaults merged
  with this repo's overrides), badges each overridden cell as *Overridden*, and can enable an
  action that's globally off. **Reset to global defaults** drops every override so the repo
  inherits again.

On new commits to a reviewed PR only re-reviews PRs you've already reviewed in that mode, and
cancelling an auto re-review dismisses that commit so it won't run again on restart — a genuinely
new commit still triggers. Existing rules from the older flat list are migrated automatically on
first load; any duplicates are merged and disclosed once with a toast.`,
  },
  {
    id: "hooks",
    label: "Git hooks",
    body: `# Git hooks

**Git hooks…** (in the repo ⋮ menu) manages the scripts in your repo's \`.git/hooks\` —
the small programs Git runs at points like *before commit* or *before push*.

- See every hook with its state (active / disabled / inactive) and **edit** it in a
  built-in editor.
- **Enable or disable** a hook without deleting it, or delete it outright.
- **Templates** give you a one-click starting script for any of the standard hooks
  (pre-commit, commit-msg, pre-push, …).
- If your repo uses a hook manager — **husky**, **pre-commit**, or **lefthook** —
  GitDesktop detects it, opens its config, and can run the right install/update command
  for you.`,
  },
  {
    id: "keyboard",
    label: "Keyboard & navigation",
    body: `# Keyboard & navigation

GitDesktop is built to be driven from the keyboard. The shortcuts below show your current
bindings (formatted for your platform) — rebind any of them in **Settings → Keyboard**.

- **Command palette — {{kbd:command-palette}}.** Search and run any action available right
  now. The fastest way to find a feature when you don't know where it lives.
- **Keyboard shortcuts — {{kbd:show-shortcuts}}.** A cheat sheet of every shortcut, always
  reflecting your customizations.

## Moving around

- **↑ / ↓** navigate every list — files, commits, branches, PRs, runs, sessions, and the
  side rails (Settings, Repository settings, and this guide). **Shift + ↑ / ↓** extends a
  selection in History. **Enter** opens the highlighted item; **Esc** closes dialogs and
  menus.
- **Tabs:** {{kbd:tab-changes}} Changes · {{kbd:tab-history}} History ·
  {{kbd:tab-compare}} Compare · {{kbd:tab-pulls}} Pull Requests · {{kbd:tab-actions}}
  Actions · {{kbd:tab-issues}} Issues · {{kbd:tab-discussions}} Discussions ·
  {{kbd:tab-tags}} Tags · {{kbd:tab-insights}} Insights.{{ai}} The **Agent** tab is
  palette-only by default (bind a key in Settings).{{/ai}}
- {{kbd:show-repositories}} repositories · {{kbd:show-branches}} branches ·
  {{kbd:back-to-repositories}} back to repositories · {{kbd:focus-filter}} focus the
  filter.

## Doing things

- **Repository:** {{kbd:push}} push · {{kbd:pull}} pull · {{kbd:fetch}} fetch ·
  {{kbd:open-in-terminal}} terminal · {{kbd:show-in-explorer}} file manager ·
  {{kbd:open-in-editor}} editor · {{kbd:view-on-github}} GitHub · {{kbd:new-repository}}
  new repo · {{kbd:add-local-repository}} add local · {{kbd:clone-repository}} clone.
- **Branches & stash:** {{kbd:new-branch}} new · {{kbd:rename-branch}} rename ·
  {{kbd:delete-branch}} delete · {{kbd:update-from-default}} update from default ·
  {{kbd:stash-all}} stash all.
- **Changes:** {{kbd:commit}} commit{{ai}} · {{kbd:generate-commit-message}} generate
  commit message{{/ai}} · {{kbd:undo-commit}} undo last commit.
- **Pull requests:** {{kbd:create-pr}} create pull request.
{{ai}}- **Agent:** {{kbd:agent-toggle-terminal}} toggle the session terminal.
{{/ai}}
Every shortcut is **rebindable** in **Settings → Keyboard**: click a binding, press a new
combination, and if it clashes with another action the app moves it for you. Many actions
(creating issues/releases, repository settings, stash views{{ai}}, most agent
commands{{/ai}}) are palette-only until you bind a key. Defaults match GitHub Desktop where
there's an equivalent.`,
  },
  {
    id: "settings",
    label: "Settings & updates",
    body: `# Settings & updates

Open **Settings** from the header gear (or {{kbd:open-settings}}). Sections:

- **General** — hide AI features, keep running in the **system tray** on close (so
  background work continues; launching the app again while it's running —
  tray-hidden or not — focuses the existing window), and privacy options.
{{ai}}- **AI** — providers, models, keys, instructions, agent-session isolation
  (worktree / container), and the container image.
- **Slash commands** — manage built-in and custom agent commands.
- **MCP servers** — register Model Context Protocol servers (secrets in your OS keychain)
  that agent sessions can opt into.
- **Automations** — AI actions that run on triggers.
{{/ai}}- **Notifications** — opt into OS notifications (sent only when the window isn't
  focused) for PR activity, CI checks, reviews on your PRs, and workflow runs finishing.
  Whatever you enable here also lands in the header's **Activity & notifications** bell — a
  persistent, click-to-open history (it survives a restart) so a finished review or a PR
  update is never a missed moment. Open it from the command palette
  ({{kbd:command-palette}} → *Activity & notifications*), click an entry to jump to it,
  arrow-key through the list, and clear items or mark all read.
- **Keyboard** — rebind any shortcut, with live key-capture.
- **Accounts** — your GitHub sign-in, and your **Bitbucket** connection (an Atlassian
  API token: enter your Atlassian account email + a token with the five \`read:…:bitbucket\`
  scopes, plus the \`write:…:bitbucket\` scopes to act on PRs and Pipelines and the
  \`admin:…:bitbucket\` / \`delete:…:bitbucket\` / webhook scopes to manage repositories;
  stored in the OS keychain, replaceable or removable here).{{ai}} A **GitLab** block here
  takes an optional **project or group access token** so your AI reviews post as that
  project's bot rather than your signed-in \`glab\` account (also OS-keychain-stored,
  connect or disconnect here).{{/ai}}
- **Git** — the default branch name for new repos, your global identity, a per-repository
  identity override, and line endings (\`core.autocrlf\`).
- **Syntax** — map file extensions to languages or add custom grammars, personally or
  shared with the repo via \`.gitdesktop/syntax.json\`.
- **External editor / Terminal** — auto-detected, or point at any executable. These power
  the "Open in…" actions throughout the app.
- **About** — app, OS, and component versions, a **health check** for your installed tools
  (Git, the GitHub / GitLab CLIs{{ai}}, and the Claude Code / Codex / Copilot / opencode
  agents{{/ai}}), and the current window position.

## Staying up to date

GitDesktop updates itself from GitHub Releases. It checks for a newer version on launch
and roughly every six hours in the background while the app stays open (you can turn these
automatic checks off in **Settings → Updates**). When an update is waiting it shows a
toast, a dot on the **Settings** gear, and an **Install & restart** banner in
**Settings → Updates** — but it only ever installs **on your consent**, never silently.
Updates are cryptographically signed and verified by the app. You can also check anytime
with **Check for updates now**.`,
  },
];
