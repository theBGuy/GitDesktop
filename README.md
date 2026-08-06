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

GitDesktop is a free, open-source (Apache-2.0) desktop Git client for Windows,
macOS, and Linux, built with Tauri 2 and React 19 by theBGuy. It works with
GitHub, GitLab, and Bitbucket — staging, diffs, branches, history, and the full
pull-request loop with code review, CI, and issues — with optional AI you can
hide entirely.

It keeps GitHub Desktop's approachable model and goes further: the full
pull-request lifecycle in the app (including offline "local" PRs), a GitHub
Actions cockpit, and AI woven through commits, reviews, and CI debugging — with
the provider you choose, local models included.

All GitHub access goes through the **GitHub CLI (`gh`)**: no OAuth app, and the
app never stores your tokens. Core git runs
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

- **The whole PR lifecycle, in-app** — review, comment, label, **assign**, **request
  reviewers**, approve, edit, and merge (merge/squash/rebase) GitHub PRs without the
  browser. Set **labels and assignees** right when you **open** a PR/MR (GitHub &
  GitLab), and **link related issues** when you open *or* edit a PR — chips
  **auto-detected** from your branch name and commits (a `fix/123-…` branch seeds
  `#123`), or picked by hand, each toggleable between **Closes** (auto-closes the issue
  on merge) and **Relates to** (GitHub & GitLab; also on **local PRs**, where the refs
  carry into the promoted PR). On a **Bitbucket** repo with a **linked Jira project**,
  the same row surfaces linked-Jira issues (`KEY-123`) as **mention-only** *Relates to*
  chips (Jira tickets aren't closed from PR text). Editing a PR peels any trailing
  `Closes #N` / `Relates to #N` lines back into chips, so the chips stay the single
  editor for the ref block. Request reviewers across GitHub, GitLab &
  Bitbucket. Flip a PR between
  **draft and ready for review** either way — on GitHub, GitLab & Bitbucket — and
  **create new PRs as drafts by default** (Settings → General).
  - **Activity feed** — a PR's Conversation is a **date-sorted timeline** of reviews,
    comments, grouped **pushed commits** (each SHA clickable), and events, every entry
    **timestamped** (hover for the exact time), with an
    **approval marked stale** once later commits land — on GitHub, GitLab, Bitbucket,
    and local PRs (GitLab has no force-push/draft events, Bitbucket no labels or
    review-requests).
  - **CI rollup** — checks fold into a **pass/fail/pending/skipped** summary; a
    running **GitHub Actions** check shows its current step live, a finished one peeks
    its (or a **GitLab pipeline** job's) log inline; **Bitbucket** build statuses link
    out (name/state/URL, no fetchable logs).
  - **Local PRs** — the same loop against any two branches with **no remote**,
    promotable to a real GitHub PR (comments and all) in one click. A merge
    **pre-shows conflicts** and lets you resolve them in an **in-app editor** — in an
    isolated worktree that never touches your working tree — then **Finish** or
    **Abort**.
- **Issues & Discussions, in-app** — triage GitHub issues (types, sub-issues,
  dependencies, linked PRs and branches) and Discussions without the browser, plus
  private **local to-dos** that need no remote.
- **GitHub Actions cockpit** — browse runs, drill into jobs and steps, re-run (all
  or failed), cancel, dispatch a workflow, and read failed-step logs — none of
  which GitHub Desktop does.
- **Explore repositories** — a full-page browser across **GitHub, GitLab & Bitbucket**:
  before you type it shows **your own repositories** (grouped by owner) and a **Popular**
  star-sorted feed (GitHub & GitLab); typing searches GitHub, all public GitLab projects,
  or your Bitbucket workspaces (Bitbucket retired global repo search). Sort by best match,
  most stars, or recently updated, then open a result for its README preview and **clone**,
  **fork** (all three, then offer to clone the fork), or **star** it (GitHub & GitLab) —
  without knowing the URL. Fully keyboard-navigable.
- **GitLab, first-class** — via the **GitLab CLI (`glab`)**, on gitlab.com or
  **self-managed** (any host `glab auth login` knows). Browse and clone projects,
  then read and act on merge requests, issues, pipelines, and releases in the same
  panels (MR comments/commits/diff; an issue's labels/assignees/milestone rail;
  pipeline jobs with logs and a branch CI badge; release notes with asset links):
  - **Merge requests** — comment (edit/delete your own), close/reopen, edit title &
    description, retarget the target branch, react with emoji (on descriptions and
    comments), edit labels & assignees, **approve / unapprove**,
    request changes, and **merge** (merge/squash) — including **auto-merge** when the
    pipeline succeeds (cancelable in place) — plus **create** (push-and-open, drafts,
    duplicate-MR detection)
  - **Issues** — create, comment, close/reopen, edit labels & assignees, set
    **milestone**, **due date** (past-due cue), **confidential**, and **linked related
    issues**; lock/unlock, move to another project, or delete
  - **Time tracking** — estimate + spent, on an issue *or* an MR
  - **Pipelines & releases** — retry / cancel / run pipelines with CI/CD variables and
    **play a manual job**; publish / edit / delete **releases** with asset uploads
  - **Project settings** — **General** (description, topics, default branch, access
    levels, merge method & squash policy), **Members**, **Protected branches**
    (per-rule access + force-push policy), **Webhooks** (delivery log + re-send),
    **CI/CD variables**, and a **Danger zone** (rename, archive, visibility, transfer,
    delete)

  Star a project ("View on GitLab" + a fork link), **publish a local repo** — or local
  issues/PRs — to GitLab, and Insights charts GitLab pipelines. GitHub is unchanged.
- **Bitbucket Cloud** — connect with an **Atlassian API token** (Settings → Accounts),
  then browse & clone repositories and work pull requests and Pipelines (with step
  logs) in the same panels:
  - **Pull requests** — comment (edit/delete your own), decline, merge (merge /
    squash / fast-forward, optionally deleting the source branch), edit, and **create**
    (drafts, reviewers pickable at create time); **approve / unapprove**, **request
    changes** (a true toggle that revokes on every plan), pick reviewers from your
    workspace, and flip **draft ↔ ready** either way
  - **Tasks checklist** — add, edit, resolve/unresolve, and delete, with a progress
    bar and an "N open tasks" header chip (read-only on a closed/merged PR)
  - **Pipelines** — rerun, trigger, and stop; on a repo with custom
    `pipelines.custom.*` in `bitbucket-pipelines.yml`, **pick which pipeline to run**
    (Default or a named custom one, with variables). Insights
    charts Pipeline durations, with a link-out to Bitbucket's
    Commits/Branches/Pipelines/Deployments
  - **Repo settings** (admin) — **General** (description, website, language, fork
    policy, default branch), **default reviewers**, **branch restrictions** (block
    pushes/force-pushes/deletion, restrict merges, require approvals/builds/tasks),
    **pipeline variables** (secured supported) & **schedules** (cron), read-only
    **deployment environments**, **webhooks**, and a **Danger zone** (rename updates
    your local `origin`; no archive)

  **Publish a local repo** to Bitbucket (creates the repo, adds `origin`, pushes).
  Reopening a declined PR isn't available (a platform limit); issues live in **Jira**
  — link a project (below).
- **Jira Cloud issues** — link a Jira Cloud site and project to any repo (the repo ⋯
  menu's **Link Jira project…**, or the palette), and its Issues tab gains a **Jira**
  section. Connect with an **Atlassian API token** (validated, kept in your OS
  keychain) or reuse a Bitbucket credential. Especially handy for **Bitbucket**, whose
  tracker Atlassian retires **2026-08-20**.
  - **Browse & read** — filter issues (open / closed / all, mapped to Jira's status
    categories) and read status, type, priority, assignee, labels, a Markdown
    description, and comments, with **View in Jira** link-outs
  - **Agile fields** (when the project uses them) — **story points** (also on list
    rows), **sprint**, a clickable **epic / parent**, **components**, and **fix
    versions** — auto-discovered per site, nothing to configure
  - **Act** — create (summary, description, type), comment in Markdown, close/reopen
    along the project's workflow (or jump to any status from the chip's status menu),
    assign/unassign, set a due date, change priority, edit labels, **log work** (Jira's
    `2d 4h 30m` duration grammar, with an optional note), **set the original/remaining
    estimates**, and edit/delete your own comments and worklog entries — actions your
    permissions don't allow simply don't appear
  - **Linked in** — issue keys (e.g. `PROJ-123`) spotted in your branch name, commits,
    and PR titles surface as a **referenced Jira issues** row that jumps to the issue;
    a **local issue** can be promoted to Jira (comments carry over, with a back-link)

  Agents reach the linked project through GitDesktop's **MCP server** — `jira_*` tools
  to list and read, and (behind `--allow-remote-write`) comment, close/reopen, create,
  assign, log work (`jira_log_work`), and update an issue's due date, priority, labels,
  and original/remaining estimates.
- **Sign in without leaving the app** — reconnect **GitHub** (`gh`'s device-code flow)
  and **GitLab** (`glab --web`) right from the not-signed-in panels, Settings → Accounts,
  or the palette — no dropping to a terminal (though it stays a fallback). GitDesktop
  tells an **expired-or-revoked session** apart from never-signed-in and network blips,
  badges the affected account with one-click **Reconnect**, and **warns before a token
  lapses** — GitLab and GitHub PAT expiry, plus an optional Bitbucket **expiry date** you
  supply. For GitLab it nudges the **browser (OAuth)** option, whose sessions renew
  themselves instead of expiring.
- **Delegate a task to an agent** — hand a coding task to a **Claude Code**, **Codex**,
  **GitHub Copilot**, or **opencode** agent (the CLI you already have — opencode's
  hosted models are free, no extra subscription). It works in an isolated worktree that
  never touches your checkout.
  - **Watch it work** — follow every file it reads and edits and command it runs,
    expand any edit to its diff inline, then keep the result as a branch, open a local
    PR from it, or discard it
  - **Several at once** — organized into **Active** and **Kept** tabs, searchable, with
    a notification when each finishes
  - **Sandbox** — confine writes to a **Docker/Podman container** (or rely on each CLI's
    own worktree confinement on the host), pick worktree or container **per session**
    from the composer's **Options** (with an inline readiness check before it starts),
    and add per-repo tools (e.g. Playwright) via a committed
    `.gitdesktop/agent.Dockerfile` that GitDesktop builds into a per-repo image after you
    confirm it
  - **Drive each turn** — **slash commands and skills** (built-in starters, custom
    commands, and the agent's own commands and **Agent Skills** — project *and* global,
    incl. the shared `.agents/skills`), `@file` mentions, a model/effort picker, and
    terminal-style prompt history
- **Bring your own MCP servers** — register MCP servers (local `stdio` or remote HTTP,
  secrets in your **OS keychain**) under Settings → MCP servers, then opt a session into
  them from the composer's **MCP** picker; change picks mid-session.
  - **Per agent** — Claude, Copilot, or opencode (host or container), and Codex in a
    container (host Codex can't approve MCP calls). Claude runs **strict** (only your
    picks); Copilot and opencode layer them on. In a container they run inside the
    sandbox, sharing an npm cache so an `npx` server downloads once
  - **Discover** — **Browse** the official registry in-app (with stars, weekly installs,
    and exactly what each runs, so you can vet before adding) or **Import** existing config
- **Use GitDesktop *as* an MCP server** — the reverse direction: expose this repo's
  **read-only-by-default** git & forge tools (status, log, diff, blame, branches, file
  read/history, PRs, issues, CI logs) to any external MCP client — **Claude Desktop**,
  **Cursor**, **Claude Code**. PR/issue/CI tools route across **GitHub, GitLab &
  Bitbucket** by the repo's remote (Bitbucket covers PRs and pipelines, not issues). The
  app runs as a **stdio server** (its own binary on macOS/Linux, an update-safe
  `gitdesktop-mcp` copy on Windows), so an agent can *understand* a repo without touching it.
  - **Set up** — Settings → MCP servers gives a ready-to-paste snippet, **writes it into
    the repo's `.mcp.json`** (with a **Shareable** toggle for portable, committable
    paths), or **installs it globally** for Claude Code or Copilot (into the client's
    user config, available in every project) — per-client rows show
    each install's live state, with one-click **Reinstall** / **Remove** — plus a
    one-click **Add to PATH** so bare `gitdesktop-mcp` resolves in any terminal (user PATH
    on Windows, a `~/.local/bin` symlink on macOS/Linux — reversible, no admin)
  - **Escalating write ladder** — each a separate flag, off by default, so read-only stays
    the default (and agent-session branches are refused by the branch-mutating tools):
    - **`--allow-write`** — this repo's local PRs & issues (GitDesktop's own app-data
      artifacts; nothing is pushed)
    - **`--allow-remote-write`** — real forge writes under your identity (`gh` / `glab` /
      Bitbucket token): create/merge/update PRs, create/extend/dissolve GitHub PR stacks,
      request reviewers, edit labels & assignees, approve or resolve review threads, rerun
      or dispatch CI, cut releases, and file or comment on issues (creating a PR pushes its
      head branch, so it also needs `--allow-git-write`)
    - **`--allow-git-write`** — recoverable git ops (stage, commit, branch,
      push/pull/fetch, stash, merge, rebase, cherry-pick, tags)
    - **`--allow-destructive`** — the irreversible ones (discard, reset, force-push,
      delete branch/tag)
  - **Generation recipes** — hands a connected agent the fully assembled commit-message,
    PR-description, or branch-name prompt (the same context the in-app features build) to
    complete with its own model — as recipe tools *and* as native **MCP prompts**
    (slash-command-like in clients)
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
  titles/descriptions (and **suggested labels** from the repo's existing set, plus
  **proposed issue links** picked from a grounded shortlist of your open issues — or, on
  a Bitbucket repo with a linked Jira project, linked-Jira keys to mention — when
  you generate a PR/MR), repository descriptions and topics, and a streaming code
  review or security audit. Bring your own provider: cloud APIs, local **Ollama**,
  or a **keyless agent CLI** you already pay for (Claude Code, Codex, GitHub
  Copilot, opencode) — usable for generation *and* review via its subscription
  login — the full list is under [AI configuration](#ai-configuration).
- **AI review that doesn't quit or repeat itself** — it keeps running while you move
  between PRs, and finishes in the tray even after you close the window.
  - **Iterative** — re-runs remember the last round, fold in other reviewers' findings,
    and ground against the prior discussion — including the triage replies and decisions
    GitDesktop itself posted — so a finding it already refuted or marked fixed is treated
    as settled instead of re-raised; once rounds accumulate well past the context budget,
    that history is distilled into a compact ledger instead of being trimmed
  - **Sized to your model** — a **Review context** setting scales the review's context
    budget to the reviewing model's window (Auto probes a local **Ollama** model's context
    length live), so a larger model sees more of the PR before agentic review is needed
  - **Timeboxed on your terms** — agent-CLI reviews are timeboxed: agentic ones get 20
    minutes before they're stopped (plain 5; Codex reviews are always agentic), and a
    **Review timeout** setting pins a fixed limit when your reviews need more room — the
    timeout error itself points at the knob. HTTP/API reviews stream without a deadline.
  - **Notes for reviewers** — hand the reviewer context up front: an agent deposits
    per-branch notes via the GitDesktop MCP, or you type them in the Create PR dialog; on
    create they post as the PR's first comment and reach **every** review of a GitHub or
    GitLab PR as first-class context — the automated one (by default a draft's review
    waits until it's marked ready) and the reviews you run yourself — so a deliberate,
    documented decision isn't re-flagged; an **Ignore author notes** toggle in the review
    panel sets them aside
  - **Clearly machine-authored** — a branded header/footer and a robot-avatar
    "GitDesktop" bot on local PRs; with a GitLab project/group access token, posts as
    the real **GitLab project bot** rather than your own account
- **Agentic review — no more "couldn't verify the truncated part"** — the reviewer
  gets read-only tools to pull the *full* PR diff (past the prompt budget), read any
  file at any ref, search the repo, and read the PR's comments and history, reporting
  live what it's exploring ("Reading src/foo.rs…"). **Read-only end to end.**
  - **CLI agent models** (Claude Code, Copilot CLI, opencode) — GitDesktop attaches
    itself as a read-only MCP server
  - **HTTP/API models** (Anthropic, OpenAI, OpenAI-compatible, OpenRouter, Ollama) — a
    native tool loop with no workspace to prepare, so reviews start instantly

  When a diff outgrows the prompt budget, one click enables agentic review for full coverage.
- **Debug failed CI with AI** — turn a failed job's logs into a streamed
  root-cause + fix, ending with a ready-to-paste prompt for a coding agent.
- **Markdown everywhere you write** — Write/Preview tabs and a formatting toolbar
  (with Ctrl+B / I / K) on every comment, reply, and release-notes field, rendered
  to match GitHub's own styling: task lists, heading hierarchy, and
  syntax-highlighted code in ~190 languages (light and dark).
- **Privacy-first** — API keys live in the OS keychain (never in app files), local
  models keep code on your machine, AI-ignore patterns keep sensitive files out of
  context unless you opt into repo-aware review, and a single switch hides every
  AI surface and pauses your automations.
- **Keyboard-first** — rebindable shortcuts with GitHub-Desktop-compatible
  defaults, a generated cheat sheet (Ctrl+/), a command palette (Ctrl+K), and
  arrow-key navigation everywhere.
- **Themes** — System, Light, Dark, and a softer **Slate** (a cool, lifted
  blue-gray) that eases eye strain; switch in **Settings → Appearance** or cycle
  from the command palette.
- **Self-updating** — signed, verified auto-updates from GitHub Releases, checked at
  launch and periodically in the background, with a persistent in-app indicator when
  one is ready — always installed on your consent.

## Features

**Repositories** — clone, add local, create (with README / .gitignore / license
scaffolding), publish to GitHub, and fork.

- **Repo switcher** — groups every repo by owner with a Recent section and filter; each
  row carries identity badges (the forge's logo — GitHub / GitLab / Bitbucket, a cloud
  for an unrecognized remote, a folder for local-only — and a visibility icon: lock /
  buildings / globe for private / internal / public), aliases, and recycle-bin-safe
  removal. Star or unstar from the menu.
- **Locate a moved repository** — when a repo's folder moves on disk, point GitDesktop at
  its new home from the "no longer a git repository" notice; after you confirm the folder,
  the entry keeps its alias and badges, and its local PRs, issues, review history, and
  automations follow along.
- **GitHub repo settings** (admin) — description & topics (with AI suggestions), merge
  options and default commit messages, template & forking, **collaborators &
  invitations**, **branch rulesets** (create/edit, reversible enable/disable), **code
  security & analysis** toggles, **Actions/Dependabot/Codespaces secrets & variables**
  (repo and environment scope), the **Sponsor button** (`.github/FUNDING.yml`), webhooks
  with delivery history, **GitHub Pages** config, a **danger zone** (rename, archive,
  change visibility, transfer, delete), and deep links to the settings GitHub keeps
  browser-only.
- **Manage files** git tracks or ignores (beyond pending changes) — untrack a file
  committed by mistake (kept on disk), or surface every ignored file with the rule
  responsible and force-add it or remove that rule.

**Changes & commits** — unified/split diff with syntax highlighting,
collapsible surrounding context, and image diffing; filter the changes list by
path or category; the working-tree diff is one whole-file view with hunk- and
line-level staging and discarding (drag across the line numbers) — including
committing or discarding only part of a brand-new (untracked) file;
stage/unstage/discard single files or a multi-selection from the context menu;
discarding a whole untracked file goes to the recycle bin. Commit with title + body,
co-authors suggested from history, amend, undo, reset, and revert.

**Branches** — switch (bring-changes / stash prompt), create, rename, delete, and
**archive** (hide from the switcher without deleting). Each switcher row shows a branch's
own **push/pull state** vs. its upstream (↑ to push / ↓ to pull, plus markers for
never-published and upstream-deleted branches) and its **+/− divergence vs. the default
branch**, labeled with the default's name — plus a PR badge.

- **Clean up branches** ⭐ — a bulk sweep that archives or deletes every stale branch
  (merged into the default branch, or with no commits in a chosen window) in one
  reviewed list.
- **No-checkout ops** — update a branch *without* checking it out (from the default
  branch or its own upstream — bring the default current after a merged PR), check out or
  delete remote-only branches from the switcher's Remote section, and remove a branch's
  worktree from its menu.
- **Compare** — a tab with a three-dot diff, commits ahead/behind, merge/rebase, and
  jump-to-PR.
- **Local branch-protection rules** — naming, merge methods, require-PR, force-push;
  shareable via a committed file or importable from GitHub.
- **Advanced merge tooling** ⭐ — predicts the result in memory before you commit
  (fast-forward / clean / which files will conflict), with `--no-ff` and a clearly
  cautioned auto-resolve strategy (`-X ours/theirs`) — which GitHub Desktop doesn't offer.
- **Change base** ⭐ — rebase a branch onto a different base when it was branched off the
  wrong one, replaying only its own commits (the wrong base's are left behind), with a
  preview of exactly which commits will move.

**History & advanced** — paged, filterable history with rich commit detail,
commit-author avatars, and per-file history and line blame reachable from any file
list (History, pull requests, Compare) or the command palette — pinned at that
commit or branch where it applies, with a hover-card preview on each blame line's
commit and a click to jump to it in History. Plus an at-a-glance marker on every
commit that hasn't been pushed yet.

- **Interactive rebase** ⭐ — an *Edit history* editor to reword / squash / fixup / drop
  / reorder unpushed commits behind an atomic replay engine (any conflict rolls back
  untouched), or **edit** a commit to pause and amend its contents (a real resumable
  rebase) — which GitHub Desktop doesn't offer. Cherry-pick onto the current or another
  branch, too.
- **Recover lost work** ⭐ — a stash browser whose scan (via `git fsck`) finds
  orphaned/dangling stashes — uncommitted work a `git stash` saved but that fell out of
  `git stash list` (dropped, or abandoned by an interrupted operation) — and restores any
  of them non-destructively to the working tree.
- **Operation journal** ⭐ — records the risky compound operations GitDesktop runs (local
  PR merges, cherry-picks, history edits, rebases); if one is interrupted by a crash or
  restart, it surfaces a calm recovery notice naming what was interrupted and the exact
  branch + commit it started from (browsable any time via the *Operation history*
  command).
- **Worktree manager** — create, switch between, promote a worktree's branch into your
  main checkout, and remove linked worktrees, so you can work on several branches in
  parallel folders without stashing — with one-click jumps to the main workspace right
  from the branch switcher.
- **Push or publish a branch without switching to it** — from the branch switcher's
  context menu, push a branch that's ahead of the remote it tracks (its own remote,
  not just `origin`) or publish an unpushed one (choosing the remote when there's more
  than one), without checking it out; it works even when the branch is checked out
  in another worktree.
- **Start a branch from any base** — the new-branch dialog's *Base it on* picker is a
  searchable list grouped into local and remote branches, so you can branch off any of
  them. Basing on a remote branch (e.g. `origin/epic/big-feature`) starts from the remote
  tip and leaves the new branch untracked, so its first push publishes it under its own name.

Plus tag and submodule management, and releases — publish, edit, and delete them
with asset uploads; when a **GitHub** release carries a `latest.json` updater
manifest, editing its notes can refresh the manifest in the same save, so apps
updating from that release show the notes you just wrote.

**Syncing** — fetch / pull / push, with the ahead/behind counts shown right on
the Push and Pull buttons; pull is
`--ff-only`, and divergence routes to a guarded force push with
`--force-with-lease`. When a repo has an `upstream` remote, the Pull menu adds
**Update from upstream** — one click fetches upstream and brings your branch up
to date (fast-forward when it can, a merge commit when cleanly diverged, the
conflict editor otherwise), for keeping a fork current. **Auto-fetch** (on by default) quietly runs a background
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

**Pull requests** — full read + write for GitHub PRs, plus **local PRs** (the full PR
workflow against any two branches with no remote at all).

- **AI review + security audit** on any PR, with an activity indicator, a cancel, and a
  concurrency-capped queue — and while one mode streams you can **queue the other to run
  next** instead of waiting. Re-runs are **iterative** — they feed back the previous
  round, fold in other bots' findings, and read GitDesktop's own earlier comments (past
  reviews and any "fixed in `<sha>`" / refutation replies) as soft, re-verifiable
  context, so an already-addressed finding isn't re-raised cold (the current diff is
  always the source of truth). Per PR, ignore the prior review, trim a false finding, or
  opt out of external-bot folding. Pick a **review model** independent of the generation
  model, and optionally a **separate model for security audits** (e.g. a stronger model
  for audits, a faster one for general reviews). By default a **draft** PR waits for its first automated
  review until you mark it ready — flip **Review draft PRs when created** in Settings →
  Automations to review on creation instead.
- **Line-anchored review comments** — from Copilot, CodeRabbit, or humans — render
  grouped by file in the Conversation and at their exact line in the Files diff, with
  reply-in-thread, resolve/unresolve, and edit/delete of your own; a reviewer's
  **suggested change** can be applied straight to your working tree (verified against the
  file, staged when safe) — now on **GitLab and Bitbucket** too, something even GitHub's
  API can't do.
- **Compose your own review** from the diff — click a line number, or drag a range (a
  real multi-line anchor on GitHub & GitLab; Bitbucket anchors at the last line; the "+"
  on any line of a drag opens the range composer). Post a single comment, or **start a
  review** to batch drafts (persisted per-PR, surviving restarts) that render at their
  anchors with a pending-review count, then **Submit** with a verdict (Comment / Approve
  / Request changes, capability-gated per provider), inserting a **provider-correct
  suggestion** pre-filled with the selected code.
- **Commit-level comments** — the Commits tab is arrow-navigable; open a commit for its
  full message, per-file diffs, and a whole-commit thread + line-anchored comments you can
  add, edit, and delete (a real drag-range on GitLab; a single line on GitHub &
  Bitbucket). The same commit comments are available from the **History tab** on any
  pushed commit (an unpushed one shows a push hint).
- **Activity feed** — the Conversation is a **date-sorted timeline** of reviews,
  comments, grouped pushed commits (each SHA clickable), and events, every entry carrying
  a relative **timestamp** (hover for the exact local time), marking an approval
  or changes-request **stale** once later commits land. GitHub carries the full event set
  (force-push, label add/remove, review request, ready-for-review, convert-to-draft,
  close, reopen, merge, rename); **GitLab MRs** add commits, label changes,
  close/reopen/merge, and approvals — approved / changes-requested / approval-withdrawn
  — but no force-push/draft events; **Bitbucket PRs** add
  commits, merge/close, and approved / changes-requested (no labels or review-requests);
  **local PRs** get created → commits → comments → merged/closed.
- **CI rollup** — checks collapse into a **✓ passed · ✕ failed · ● pending · ⊖ skipped**
  summary (auto-expanding on failure); a running **GitHub Actions** check shows its
  current step inline and a live step checklist when expanded, while finished **GitHub
  Actions** and **GitLab pipeline** jobs peek their log inline and **Bitbucket** and
  other external checks link out (name/state/URL, no fetchable logs).
- **Stacked PRs** — a stack **position badge** (*2/3*) on stacked rows in the PR list, and a
  **Stack** section on the PR view listing every member bottom → top, keyboard-navigable
  (with palette commands for the next and previous PR in the stack). GitHub's **native
  stacks** come straight from its API; on **GitLab**, chains of merge requests are
  **detected automatically** — and on **GitHub** you can **build the stack yourself** from
  the PR view: when your open pull requests already form a chain (same-repo PRs, in a list
  it can see whole), GitDesktop offers to **create a stack** from it, or to **add it to**
  the stack the PR already sits on, with a **preview** of exactly what will be stacked,
  bottom → top, before anything is created. **Dissolve** (confirmed) takes a stack apart
  again and leaves every pull request open on its branch. On GitHub, merging is
  **stack-aware**: merging a stacked pull request merges it *and* every still-open pull
  request below it, bottom-up, as one operation — or, when the base branch uses a **merge
  queue**, hands the stack to the queue to land when it clears. The merge dialog spells out
  that full scope before you confirm, naming the pull requests it will merge, in order,
  whenever it has the list. Separately, the **Edit** dialog can **retarget a PR's base
  branch** on **GitHub**, **GitLab**, and **Bitbucket** — on a stacked GitHub PR the picker
  asks you to dissolve the stack first.
- **Record management** — open a local PR's context menu in the list to **Archive / Unarchive**
  or **Delete** it (Delete confirms; the branches are untouched), also from the command
  palette.
- **Fork · Upstream lens** — on a GitHub fork (a repo with an `upstream` remote), a
  **Fork | Upstream** switch in the list toolbar (remembered per repo, defaulting to your
  fork; also the **Switch to fork / upstream view** palette commands) points the remote
  PR list — and every PR you open under it: description, comments, reviews, and metadata —
  at your fork or the **parent** repository. Opening a PR targets a repository explicitly,
  offering your fork or the upstream repo on a fork. When you're done with a fork, the
  settings **Danger zone** can **remove the upstream remote** (a local detach — reversible)
  or **leave the fork network** entirely: on **GitLab** this happens right in the app
  (Owner-only — open MRs to the parent close), and on **GitHub** and **Bitbucket** it links
  out to the provider's detach page. A **Re-check fork status** button refreshes the fork
  badge in place afterward.

A Write/Preview markdown editor (formatting toolbar + live preview) is everywhere you author.

![A pull request open in GitDesktop with an inline AI review summarizing the diff; the left sidebar lists both local and GitHub pull requests, and the footer offers Approve, Comment, and Publish-to-GitHub actions.](site/src/assets/app-review.png)

**Issues & to-dos** — a dedicated tab for GitHub issues and private **local
to-dos** (no remote needed; publishable to GitHub in one click). Browse, create,
and edit (drafting with AI from your repo's issue templates), react with emoji,
and manage the full metadata: labels, assignees, milestones, issue type,
sub-issues, dependencies (blocked-by / blocking), and development links (linked
and closing PRs and branches, plus create-a-branch). Duplicate, transfer,
pin/unpin, lock/unlock, or delete. On a **fork**, the same **Fork | Upstream**
lens as the PR tab browses the parent repository's issues (and creating one under
the Upstream lens opens it **on the parent**); a fork with issues turned off
offers a one-click switch to Upstream instead of a dead end.

![An issue open in GitDesktop with its description, labels, assignees, milestone, sub-issues, and a linked development branch and pull request; local and GitHub issues appear together in the sidebar.](site/src/assets/app-issues.png)

**Code TODOs** — a tab that scans your working tree for real `TODO`, `FIXME`,
`HACK`, `BUG`, and `XXX` comment markers (tracked and new-but-not-ignored files),
groups them by file, and lets you filter by text/path or marker. Select one for a
syntax-highlighted excerpt with blame attribution (who wrote the line, and how long
ago); then **open it in your editor**, **copy its `path:line`**, or **promote it to a
local issue** — pre-filled with the comment and a `path:line` reference — from where
it's publishable to GitHub or Jira like any other local issue.

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

**Tasks** — save your own scripts (your release or build flow, say) and run them from
a dedicated **Tasks** tab or the command palette ("**Run a task…**"), without dropping
to a terminal. Point a task at an **existing script in the repo** — it runs the live file,
so edits take effect next run — or write one **inline**; with an AI provider connected,
**generate** an inline script from a plain description, or **Analyze with AI** to read the
script and fill in its name, description, and the **arguments it accepts** (`--help`-style
docs, shown as a reference when you run). Each task carries a description and default
**arguments** (e.g. `--preview` — quoted values stay intact), and a confirm-gated run lets
you **adjust the arguments per run**. Runs happen in an **interactive** in-app terminal in
the repo's folder, so scripts that prompt you (a version to release, a yes/no) work and
keep their colour; **Stop** kills the run and its child processes, **Rerun** starts a
fresh one. Pick the interpreter — **PowerShell**, **cmd**, **Git Bash**, **bash/sh/zsh**,
**Node**, **Deno**, **Bun**, **Python**, or **Ruby** — with the editor showing **which it
detected** on your machine (and where). Task definitions live in your app data — never
read from repository content, so a cloned repo can't plant one — running is **off until you
enable it**, and each task can **confirm before it runs**.

**Automations** — a lifecycle grid (on commit / on PR opened / on new commits to a
reviewed PR) that runs AI review or security audit automatically, with per-action
branch conditions, Save/Discard drafts, global defaults, and per-repo overrides
(paused while **Hide AI** is on).

**Integrations** — open in any editor or terminal (auto-detected, point at any
executable, or set a full custom command with a `{path}` placeholder), and tunable
OS notifications for PR activity, checks, and CI runs.

**Activity & notifications** — a persistent bell in the header that collects terminal
events (a finished review, checks passing/failing, a PR approved/commented/merged, a
review requested from you, a completed CI run, or a finished agent / research / plan run) into a clickable,
clearable history that survives a restart — so a review that finishes while you're away is
never a missed click. Open it from the command palette; which events show follows your
notification settings. A cancelled or failed **automated** review also lingers in a
**Stopped** group with one-click **Re-run** (re-firing exactly that run's mode) and
**Dismiss**, so a stopped automation isn't a dead end. The *review failed* notification
row itself also states why the run failed, and for automated runs carries the same
one-click **Re-run** right on the row.

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
- **Custom instructions** (included in every generation and every AI review):
  - **Global** — Settings → AI instructions (e.g. "Follow Conventional Commits").
  - **Per-repo** — `.gitdesktop/instructions.md` in the repo. Takes precedence.
- **AI ignore patterns** (keep files out of AI context; they still commit
  normally), in `.gitignore` syntax: `secrets.env` hides that file at any depth,
  `/secrets.env` only the copy at the repo root, `node_modules` or `vendor/` a
  folder wherever it sits, and `docs/*.log` just that folder's logs. A `!` line
  puts back something a broader pattern hid, and your global patterns are
  applied last, so a repo's committed file can never re-expose what you excluded
  yourself. A model that reads your repository itself isn't limited by them —
  that's what the PR panel's **Agentic review** toggle turns on.
  - **Global** — Settings → Excluded files (one pattern per line).
  - **Per-repo** — `.gitdesktop/aiignore` in the repo. A changed file's
    context menu → **Exclude from AI** (file, folder, or file type — or a
    multi-selection) creates and updates this file for you, adding anchored
    lines like `/src/config.ts` and `/vendor/` that mean exactly what you picked.
- **Keys** live in the OS keychain (Windows Credential Manager, macOS Keychain,
  libsecret). **Hide AI** (Settings → General) hides the AI surfaces and pauses
  your automations while keeping your config — rules start firing again when you
  turn AI features back on.

## Updates

GitDesktop checks GitHub Releases on launch and about every six hours in the
background while the app stays open (opt-out in Settings → Updates). A pending
update shows a dot on the Settings gear and an **Install & restart** banner in
Settings → Updates, and installs **only on your consent**. Updates are
cryptographically signed and verified by the app — separate from OS code signing.
Maintainer release steps: [docs/deployment-updates.md](docs/deployment-updates.md).

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
