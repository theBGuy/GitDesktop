# Changelog

All notable, user-facing changes to GitDesktop are recorded here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries are curated for humans. Each user-facing change adds a small fragment file
under `changelog.d/` (see its README); those are assembled here at release time by
`pnpm release:prepare`, so `## [Unreleased]` is generated — don't hand-edit it.
`pnpm changelog` drafts starting-point bullets from the commit history and
`pnpm changelog:preview` shows the pending fragments.

## [Unreleased]

## [0.9.1] - 2026-08-16

### Changed

- The comment box now keeps a separate draft for each discussion, pull request,
  issue, and History commit you're working in, so you can switch between them
  and pick up where you left off.
- Pull request and issue actions explain why they're unavailable while the one
  you picked is still loading — **Review…**, merge, approve, request changes,
  close, reopen, the draft toggle, sub-issues and the metadata pickers all say
  so — and a missing write or triage permission is named ahead of the loading
  note. Reaction and upvote buttons hold the same way — in discussions too —
  until the one you picked is on screen.

### Fixed

- When a cherry-pick onto another branch can't complete, the automatic
  rollback returns the target branch to its prior tip and puts you back on
  the branch you started from; if that rollback itself can't complete, the
  error names the target's pre-run tip and the exact commands to recover.
- Dropdowns read the same collapsed as they do open — the session composer's
  agent, model, and effort pickers, the research intent picker, the pull request
  review provider picker, and the selects across Settings and repository
  settings all show their full labels.
- Error toasts name the failure you actually hit: a push, checkout, or fetch
  error stays on screen as itself even when a commit message or file name
  mentions conflicts, and a paused cherry-pick reads as a cherry-pick however
  the commit it stopped on is titled.
- Dialog text stays put while a dialog closes — confirms keep the branch, tag,
  commit, file, task, pull request, or repository they were about, and the error
  and AI result viewers keep their contents, all the way through the closing
  animation.
- Switching between light and dark re-colors highlighted code instantly: diffs
  and webhook delivery payloads pick up the new theme's syntax colors in place.
- Reconnecting a GitHub account picks up the token scopes it just granted right
  away, so scope-gated actions become available immediately.
- Local PR branch fields now accept only real branch names — a Git revision
  expression such as `feature~1` or `main^` (possible via the MCP server's
  `create_local_pr`) previously passed validation and could merge a different
  commit than the branch it named.
- The model picker now tells you why the live model list couldn't load — the
  provider's own message for a rejected key, or the blocked-host hint for a custom
  server — and refreshes as soon as you save or clear the API key.
- Picking a folder in **Open repository…** that isn't a git repository says so
  plainly and stops there; the **Locate…** and **Remove** fixes stay with the
  recent-repository list, where they have a row to act on.
- AI-generated release notes follow the repo's own `.gitdesktop/instructions.md`,
  the same as every other generation.
- Release actions always act on the tag you selected: publishing, editing,
  deleting a release and adding, downloading or removing its assets wait —
  saying so — until that tag's release has loaded.
- Edits and deletions of a pending review comment report a failure even when you
  move to another pull request while the write is in flight.
- When an interactive-rebase rewrite can't complete, the error now tells the truth
  about the rollback: it confirms your branch was restored, and when the rollback
  itself fails it names the tip your branch had before the run and the exact
  commands to recover.
- The repository **visibility** and Dependabot **check for updates** pickers
  read the same closed as they do open — the selected value is capitalized to
  match the entry you chose.
- Shortcut hints name the keys your Mac actually uses: the markdown toolbar's
  **Bold**, **Italic**, and **Link** buttons show Cmd, and Settings → Keyboard
  names Cmd and Option while you record a binding.
- Stashing is now refused while a merge, rebase or cherry-pick is in progress —
  including one whose conflicts you have already resolved and staged — so the
  resolution stays with the operation git is still tracking, and promoting a
  worktree is blocked while the main workspace is mid-operation, before the
  point of no return.

## [0.9.0] - 2026-08-14

### Added

- **Default agent.** A new choice in Settings → AI decides which CLI a new
  Session, Plan, or Research run opens on: leave it on **Auto** to follow your AI
  provider whenever it's an agent CLI, or pin Claude, Codex, GitHub Copilot, or
  opencode for every new run.
- **Findings on GitLab.** The **Findings** tab now works on GitLab repositories:
  it reads the newest completed pipeline for your branch (falling back to the
  default branch, and saying so, and picking up scans that run in triggered
  child pipelines) and lists its **SAST**, **secret detection**, and
  **code quality** findings — on every tier, Free included, where GitLab's own
  vulnerability report is Ultimate-only. Each finding opens with its severity,
  file and line, scanner, and identifiers, plus **View file on GitLab** at the
  scanned commit; every section says why it has nothing to show — scanning not
  set up, a report that isn't downloadable, expired artifacts, or a pipeline
  that hasn't finished — so an empty list only reads as clean when a report
  proved it.
- **Maintainer actions for pull requests from a fork.** Approve a workflow run
  GitHub is holding for approval, update a pull request's branch when it falls
  behind its base (a merge, or a rebase you confirm), and push follow-up commits
  straight to the contributor's fork — with a guard that catches publishing a
  fork pull request's branch to the wrong repository.
- **Google AI Studio** is now a provider in its own right. Paste an AI Studio API
  key in **Settings → AI** and pick from your live Gemini catalog — no base URL to
  copy in first. It replaces the OpenAI-compatible **Google Gemini** preset;
  setups already using that preset keep working, and moving to the new provider
  only needs the key pasted once.

### Changed

- Comment boxes across pull requests, issues, commits, and discussions now
  share the same keyboard-shortcut hint, and the submit shortcut no longer
  triggers on an empty draft.
- **Google AI Studio suggests models a free key can actually run.** The suggested
  Gemini list is now Flash-tier only — Pro models reject a free AI Studio key
  outright, so they were a dead end for most new setups. Pro is still one pick
  away in the live model list.
- The GitLab issue side rail now lists **assignees**, **labels**, and
  **milestone** in the same order as the GitHub rail, so an issue's metadata sits
  where you expect it on either provider — and the read-only sidebar's empty
  state now says exactly which fields are unset.
- Release asset sizes are easier to scan — formatted the same way sizes
  appear everywhere else in the app.
- Pull request and issue **Close**, **Reopen**, and draft controls now say why
  they're unavailable when your role doesn't allow the action, instead of
  failing at the server.

### Fixed

- Stopping an AI review or agent session now always takes effect, even
  in the first moments of a run, and a stuck agent process can no longer
  leave the run hanging past its time limit.
- Plan, research, and agent-session completion notifications now arrive
  even when a different repository's Agent tab is in front.
- **AI failures explain themselves.** A failed **Test connection**, generation, or AI
  review now shows the provider's own reason (e.g. "Invalid Auth key.", a quota
  message, or Ollama's "model not found") instead of a bare "Bad Request", and the
  connection-test result clears whenever what it tested changes — key saved or
  removed, provider or model switched, allowed hosts edited — so a setup you just
  fixed no longer looks broken.
- Release-asset and linked-issue rows show their remove buttons at all times, so
  you can see what a row lets you do without hovering it first.
- Deleting a release asset now asks you to confirm first, on both GitHub and
  GitLab.
- A pull request's Merge menu now stays closed while merging is unavailable
  (draft, no write access, or the merge safety check still loading).
- A contributor's fork branch with the same name as yours no longer masquerades as
  your own work: branch pull-request badges, the Compare tab's and Create dialog's
  duplicate checks, Bitbucket's duplicate-create guard, and GitLab stacked-MR
  detection all now skip fork pull requests.
- Editing a comment now focuses the text box immediately, and Ctrl+Enter
  (Cmd+Enter on macOS) saves it — on pull request conversations, review
  threads, commit comments, issues, discussions, and pending review drafts
  alike.
- An AI-generated commit message now stays with the repository and branch
  it was started on — switching away mid-generation stops the stream
  instead of filling the other branch's commit box.
- Switching items in the pull request, issue, Jira, discussion, and
  commit views now resets everything in progress for the previous item —
  comment drafts, open dialogs and confirmations, and label picks — and
  stops an in-flight AI description, so nothing typed or armed for one
  item can land on another.
- Multi-step Git operations now run as one uninterruptible unit, so
  editing history, resolving a conflict by taking one side, and keeping
  or discarding an agent session can no longer collide with another Git
  operation running at the same time — from a second window or your own
  next click. A commit made alongside one of these is kept instead of
  being swept away if the operation rolls itself back.
- Copying a commit's SHA right after selecting it now always copies the commit you
  selected, the Jira button opens the issue you selected rather than the one still
  on screen, detail views visibly indicate when they are still loading the next
  item instead of silently showing the previous one, and a diff can no longer
  render under another file's header.
- The repository-files and merge-picker dialogs, the stash-drop prompt, the
  task-run prompt, and the MCP replace prompt hold their contents while
  closing instead of flashing blank or stale copy for the last instant.
- Buttons that are unavailable for a stated reason explain themselves on hover;
  outside of menu and popover triggers they also stay reachable by keyboard, so
  screen readers announce the reason.
- **Fork** is no longer offered on repositories you personally own — in Explore on
  GitHub and GitLab, and in the GitHub repository menu — since a fork always lands
  under your own account. Organization repositories remain forkable.
- Relative timestamps ("3 minutes ago") stay live while a view is open, and a
  running CI job, step or GitHub Actions check counts its elapsed time up
  second by second.
- GitLab CI/CD variable values — including variables passed when running a
  pipeline manually — and webhook secret tokens now reach glab over stdin instead
  of the command line, keeping them out of the system process table.
- Screen readers now name the repository glyphs in **Explore** and the clone
  browser, the star counts in Explore, and each CI check and workflow step's
  state in a pull request's checks list, so nothing in those rows is left to
  shape and color.
- Setting up the MCP launcher no longer fails with a spurious error when
  several parts of the app prepare it at the same time.
- Pushes GitDesktop makes on your behalf (PR/MR creation, repository publish, tag
  push) now validate the branch or tag name up front and only ever touch that
  exact ref on the remote, and the same tag rules guard creating, editing, and
  deleting releases on GitHub and GitLab.
- The MCP registry browser and the Insights dependency hovercards now shrug off
  odd data from a package registry: you still get the rest of the results.
- Pressing the submit shortcut in an empty reply box (review-thread replies,
  discussion replies, and commit line comments) no longer fires the app-wide
  Commit action.
- Plans and research runs now follow a relocated repository immediately,
  and stay with it after the move.
- On forks, pending review comments, AI review history, and related caches
  are now kept separately for your fork's pull requests and the
  upstream repository's, so a review can't be drafted on one and
  submitted against the other.
- Pull request views always open on a tab that's there: jumping to a review from
  the activity dock, or turning AI features off while reading one, now lands you
  on the Conversation tab whenever the AI Review tab isn't available.
- Agent sessions started while the app is still loading are no longer
  dropped from the sidebar.
- Saving settings no longer overwrites recent-repository details or your
  Bitbucket token's expiry date when they changed in the background while
  the Settings screen was open.
- The composer's `/` command menu and Add to PATH no longer make the app
  hitch while they read from disk.
- Repositories with very large ignore lists no longer hit spurious
  30-second timeouts when listing ignored files or filtering AI-hidden
  paths, and posting long GitHub or GitLab API bodies can no longer hang.
- Typing or pasting into a terminal or task that has stopped reading its
  input no longer freezes the app, and closing it always works.
- Reaction chips and discussion upvotes announce their on/off state to screen
  readers, so the toggle you're on is clear without relying on the highlight.
- The hook list in **Git hooks** walks with the arrow keys, matching the rest of
  the app's lists.
- Long label, assignee, and reviewer names that get truncated in pickers now
  show their full text on hover.
- The window's size and position are remembered as you arrange them, so your
  layout comes back the next time you launch — even if the app never got a clean
  exit.

## [0.8.0] - 2026-08-09

### Added

- **Code scanning and secret scanning in the Findings tab.** The tab now lists a
  GitHub repo's open code scanning alerts (grouped by rule) and secret scanning alerts
  (grouped by kind, each with a validity chip for the leaked credential) next to its
  Dependabot alerts and security advisories, and a Dependabot alert's detail spells out
  a base-metric table per CVSS version the advisory carries, its CWEs, its references
  as labeled links, and whether the vulnerable package is a direct or transitive
  dependency. A category the repository hasn't switched on says so and, with repo-admin
  access, offers **Open security settings** to turn it on.
- **Install with Homebrew on macOS.** GitDesktop is now on a Homebrew tap, so a
  single command puts it on your Mac — no download-and-drag:
  `brew install --cask thebguy/tap/gitdesktop`.
- **macOS menu bar.** The **File** menu now opens repositories the way the rest
  of the app does — **New Repository…**, **Open Repository…**, **Clone
  Repository…**, and an **Open Recent** submenu of your last ten repos — and
  **Settings…** sits in the GitDesktop menu where macOS apps keep it.

### Changed

- **Open, Clone and Create repository from any screen.** Their keyboard shortcuts and
  command-palette entries stay available wherever you are in the app — Settings, the user
  guide and Explore included.

### Fixed

- Branch-name generation no longer blames your AI ignore rules for files it hid because
  their names aren't readable text — the AI is now told the two causes separately.
- The Linux AppImage now starts on current distributions (Fedora 42+, Arch, and
  other systems with recent Mesa graphics drivers) instead of aborting with an
  EGL error or showing an empty window — it no longer bundles an outdated
  Wayland library that conflicted with the host's graphics drivers.
- Git, the GitHub/GitLab CLIs, agent tools, and commands run in the built-in
  terminal no longer inherit the AppImage bundle's library paths — fixing
  fetches and pushes failing with a `git-remote-https: symbol lookup error`
  on newer Linux distributions.
- The in-app guide now names both stash-and-reapply toggles under **Settings → General**
  and documents the Merge dialog's *already up to date* preview outcome.
- Syntax highlighting in a large file's diff no longer paints everything after a
  hunk as one long comment or string. Each hunk is now highlighted on its own, so
  a comment, template literal, or parameter list the hunk cuts in half can't
  bleed color across the collapsed gaps between hunks.
- On forks, switching the pull-request or issue list between the fork and upstream
  views no longer briefly shows the other side's rows — or, for pull requests, their
  CI icons — while the new list loads.
- Write controls across pull requests, issues, CI runs and releases — merging,
  labels, assignees, reviewers, milestones, hiding comments, pinning, locking,
  sub-issues and dependencies, re-running or cancelling a run, publishing a release,
  and the rest — now follow your actual access to the repository: where you don't
  have the access an action needs, it stays visible but disabled and says what it
  requires, instead of failing when you press it.
- Leaving a local pull request's conflict-resolution view part-way through
  **Resolve all** now leaves the Changes tab on your own working tree, instead of
  showing the file the resolution run had reached inside the merge's hidden
  worktree.
- On Windows, a Git operation that hits its time limit is now stopped together
  with the helper processes it started, instead of continuing to change the
  repository in the background after the app reported it as failed.
- Deleting a worktree with a big working tree — `node_modules`, build output, a
  large checkout — now runs to completion instead of failing with a 30-second
  timeout, and a deletion that was cut short part-way finishes on the next try
  rather than insisting the worktree isn't there.

## [0.7.0] - 2026-08-08

### Added

- AI ignore lists now honor `!` un-ignore lines with full gitignore semantics —
  and a repo's committed `.gitdesktop/aiignore` can never re-expose a file your
  global patterns exclude.
- **Findings tab:** browse a GitHub repo's open Dependabot alerts (grouped by
  package, with severity, affected range, and first patched version) and its
  security advisories without leaving the app — with a direct path to turn
  scanning on when it's off.
- **Pull-request conflicts, surfaced and resolved in-app.** A remote pull request
  now shows whether it merges cleanly into its base — as GitHub and GitLab report
  it, and as a local prediction on Bitbucket — with a **Conflicts** chip on the
  open rows in the list. When it doesn't, **Resolve conflicts** merges the base
  into the PR's head in a hidden isolated worktree, leaving your branch and
  working tree untouched: resolve the files in the in-app conflict editor, then
  **Finish & push** updates the pull request's head branch (never force-pushed).
  **Discard** throws the attempt away, and an unfinished resolution is offered
  back when you return to the pull request.
- **Stack management:** when your open GitHub pull requests already
  form a chain, the PR view offers to make a stack of them — or to add them to the
  stack that PR sits on — showing exactly what will be stacked, bottom to top,
  before anything happens; **Dissolve** takes a stack apart again and leaves every
  pull request open on its branch. The Edit dialog can also **retarget a pull
  request's base branch** on GitHub, GitLab, and Bitbucket.
- **Stacked pull requests:** stack position badges in the PR list, a stack
  navigator on the PR view (GitHub native stacks; GitLab stacked MRs detected
  automatically), and, on GitHub, stack-aware merging that merges a stack
  bottom-up as one operation.
- **Stash and reapply:** when a pull or branch update is blocked by uncommitted
  changes — or you switch branches with work in progress — GitDesktop offers to
  stash them (untracked files included), run the operation, and reapply them on
  the other side. A reapply that hits conflicts lands the files in the changes
  list; one that can't run at all leaves them safely stashed — the backup stash
  is kept either way. **Automatically stash and reapply on pull and branch
  updates** (Settings → General) makes it the default for both, and the
  branch-switch prompt remembers a **Reapply after switching** choice of
  its own.
- **Worktree context menu in the branch dropdown.** Right-click a worktree row to
  open it, copy its path, rename, lock or unlock, promote to the main workspace,
  or delete it — worktree management right where the worktrees are listed, no
  dialog detour. The Worktrees dialog's own row menu gains **Copy path** too.

### Changed

- AI ignore patterns now filter staged and branch diffs through Git's own ignore
  engine, matching .gitignore semantics exactly — and a renamed file is hidden
  entirely when either its old or new name matches.
- **One name for deleting a worktree.** The branch row's *Remove worktree…* action
  is now *Delete worktree…*, matching the Worktrees dialog and the new worktree-row
  menu, so the same action reads the same wherever you find it.

### Fixed

- Dialogs that generate text with AI no longer let you save past a suggestion
  that is still being written. Create branch, Rename branch, the repository
  General settings on GitHub, GitLab and Bitbucket, and the task editor now keep
  their confirm button (and the Enter key) disabled until the suggestion lands.
  Closing either branch dialog also cancels the suggestion instead of leaving it
  running, which previously let a late result drop into the name field the next
  time the dialog opened — even when it was naming a different branch.
- The Commit button now finishes the moment your commit lands. It no longer
  waits for pull request, issue, and CI lists to refresh over the network
  first — a wait that could stretch to minutes on a slow connection.
- Switching to a different file while an AI conflict resolution is still
  streaming now stops that resolution instead of leaving it running unseen
  against your AI provider.
- AI review automations no longer double-run a pull request that was already
  reviewed when a second GitDesktop window or instance — or a restarted dev
  session — watches the same repository: automation decisions now read the
  review history on disk instead of a stale in-memory copy.
- **Hide AI features** now also pauses your configured automations — while AI is
  hidden, nothing new runs or posts review comments, and Settings → General notes
  when automations you've turned on are paused. Your rules are kept and start
  firing again the moment you show AI features. The PR review panel also no longer
  fetches your provider's model catalog until you open the model picker.
- **Deleting a locked worktree now works, and a refused deletion says so.** A
  locked worktree is removed for real — folder and git registration together —
  instead of leaving a ghost entry stuck in the worktree list.
  When git declines a deletion (the worktree is locked, or holds uncommitted
  work), GitDesktop reports why and leaves the folder untouched, so you can
  unlock it or confirm the forced delete. Renaming a locked worktree is blocked
  up front too — the menu item says why, and **Unlock** is the way through —
  instead of failing with a raw git error.
- **GitDesktop's MCP server now speaks the current protocol revision.** Clients
  that negotiate the 2026-07-28 revision of the Model Context Protocol get
  correctly formed tool results, so newer agents connect to the server cleanly.
- **GitDesktop's MCP server now identifies itself by name.** Agents and MCP
  clients list the connected server as **GitDesktop**, at the app's own version,
  instead of the name and version of the underlying SDK.
- **Continuing a conflicted merge records just your merge message.** Git's
  `# Conflicts:` comment block stays out of the commit, so what lands — and what
  everyone reads on the forge — is the message you meant. GitDesktop cleans that
  message the way git's own editor flow does, so any line that *starts* with `#`
  is dropped from a merge message you wrote yourself; a `#` mid-line, like the
  issue reference in `Fix #42`, is left alone.
- Staged and unstaged diffs now get the same VSCode-fidelity syntax highlighting
  as every other diff surface for TSX, JSX, Rust, Astro, Svelte, and other
  TextMate-highlighted languages — including very large diffs, which now
  highlight off the UI thread.

## [0.6.1] - 2026-08-03

### Added

- **Keep updater notes in step with the release.** When a GitHub release carries a
  `latest.json` updater manifest, editing its notes offers to update the manifest's
  notes in the same save (on by default), so the "what's new" your installed apps
  show matches the release page. The manifest's version, dates, and platform
  signatures are left untouched.

### Changed

- **Room to write release notes.** The notes editor in the New release and Edit
  release dialogs now fills the dialog — replacing the short fixed box and its
  drag-to-resize handle — so a long release body is readable and editable at a
  glance in Write and Preview alike. The Edit release dialog is wider to match.

### Fixed

- A failed AI run no longer passes its error text off as a result: an outage or a
  usage limit that interrupts a review never gets posted to your PR, and one that
  interrupts a generation never lands in the commit-message or other drafts.
  Failed reviews land in **Activity & notifications** with the reason (automated
  ones with a one-click re-run), and posting a review that stopped part-way asks
  first.
- On Windows, AI-ignore patterns that use a backslash escape — the form a file
  whose name ends in a space needs — now hide that file from the staged and
  branch diffs sent to AI, matching how the rest of the app reads the same list.
- Your **AI ignore patterns** now cover **new (untracked) files** when a
  **branch name** is generated — in the app and over MCP — where their names
  previously reached the provider whatever your patterns said. Names that match
  are held back and counted in the prompt's hidden-files note instead.
- Branch-name suggestions in repositories whose remote isn't named `origin` now
  compare your work against that remote's branch instead of a possibly stale
  local copy of it.
- Base-branch detection now works in repositories whose remote isn't named
  `origin` (a clone made with `git clone -o <name>`), so compare views and
  generated branch names start from the right branch.
- Automated PR reviews no longer run twice right after a push, so a re-review
  costs one run instead of two.
- MCP tools that can replace or discard things you didn't list — assignees and
  reviewers, a milestone, a Jira assignee or label set, reviewer notes, a merge
  that auto-resolves conflicts — now carry a destructive hint, so a connected
  agent can ask first.
- Editing a release through the MCP server now keeps the `latest.json` updater
  notes in sync with the release notes, matching the in-app editor, so installed
  apps show the same "what's new" however the release was edited.
- A merged pull request's timeline now shows the commit it was merged as.
- Stashing selected files now tells you when there was nothing to stash, instead
  of reporting a stash that was never created.
- The MCP `stash_push` tool now says when the paths it was given matched nothing,
  so an agent can tell an empty stash from a successful one.
- Removing an ignore rule deletes exactly the rule you picked, even when another
  line in the same `.gitignore` differs from it only by a trailing escape.

## [0.6.0] - 2026-07-31

### Added

- Terminal settings gained a **Custom command…** mode — give a full command with a
  `{path}` placeholder (for example `wt -d {path}` or `tmux new-window -c {path}`) for
  multiplexers, wrappers, or any terminal the auto-detection doesn't know. The command
  runs shell-free, and macOS "Custom…" now also launches plain (non-`.app`) executables
  correctly.
- **Explore repositories.** A new full-page browser for finding a repo without knowing its
  URL, with **GitHub**, **GitLab**, and **Bitbucket** tabs, a search box, and a sort control
  (best match / most stars / recently updated). Before you type it shows **your own
  repositories** grouped by owner and a **Popular** star-sorted feed (GitHub & GitLab);
  typing searches all of GitHub (up to 1,000 results), all public GitLab projects, or your
  Bitbucket workspaces. Open a result for its README preview and **Clone** it, **Fork** it
  (all three providers, then clone the fork), **Star / Unstar** it (GitHub & GitLab), or
  view it on its host. Reachable from the welcome screen and the command palette, and fully
  keyboard-navigable.
- **Per-session isolation.** Pick **Worktree** or **Container** for a single agent session
  from the composer's **Options**, overriding your Settings → AI default for that one run
  (Best-of-N arms share the pick). Choosing a container checks readiness inline — Docker or
  Podman installed, the engine running, the agent image built — and keeps **Send** disabled
  until it is, naming what's missing and offering a jump to Settings where that's what it
  takes to fix it.
- **Link issues when you open or edit a PR.** The Create and Edit PR dialogs now have a
  **Linked issues** row (GitHub & GitLab, wherever the repo has an issue tracker):
  reference real repo issues that are auto-detected from your branch name and commit
  subjects, proposed for you when you **Generate** the description (from a grounded
  shortlist of your open issues), or added by hand. Toggle each between **Closes**
  (auto-closes the issue on merge) and **Relates to** — they're appended to the
  description as `Closes #N` / `Relates to #N` lines, and opening **Edit** peels any
  trailing ref lines back into chips (keyword preserved) and re-appends them on save, so
  the chips are the single editor for that block. **Local PRs** get the same row (create
  and edit), and their ref lines survive **promotion** verbatim to become real closing
  refs on the forge. On a **Bitbucket** repo with a **linked Jira project**, the row
  surfaces linked-Jira issues (`KEY-123`) as **mention-only** *Relates to* chips (Jira
  tickets are never closed from PR text).
- **Locate a moved repository.** Moved a repo on disk? The "no longer a git
  repository" notice now offers **Locate…** to point GitDesktop at the folder's
  new location — the entry keeps its alias, badges, and settings, and its app data
  (local PRs and issues, review history, automations, and any Jira link) follows the
  repo to its new home — alongside the existing Remove.
- **Reviews you run yourself now read the author's Notes for reviewers.** Until now only
  automated reviews saw them; the Review and Security audit buttons feed them to the model
  too. A new **Ignore author notes** toggle in the review panel sets them aside for a run,
  alongside the existing opt-outs for your previous review and external bot findings.
- **Queue a second AI review.** Run a code review and a security audit on the same
  pull request without waiting: start one while the other is streaming and it
  **queues**, then runs automatically when the first finishes. A chip shows what's
  up next (with **Dismiss** to drop it), and cancelling the running review still
  lets the queued one proceed.

### Changed

- The MCP `stage_files`, `unstage_files` and `stash_push` tools now read each
  entry as one exact file or directory, so an agent acting on
  `src/app/[slug]/page.tsx` no longer touches its neighbours alongside it — which
  for `stash_push` meant sweeping another file's uncommitted work out of the
  working tree. Pass `literal: false` on the call to use a git pathspec or glob
  such as `*.log`. The read-side `commit_diff` and `working_diff` tools' `path`
  argument now also matches exactly, as their descriptions always said.
- **AI reviews converge in fewer rounds** — a fuller first review, then fewer of them.
  A re-review now checks each applied fix's own hunks — and how the fixes interact — in
  the same round, and suggested fixes spell out what else they oblige you to touch, so
  one round's fix stops becoming the next round's finding. A problem repeated across
  files is reported once with every affected location, and everything the reviewer is
  confident about lands in the first review instead of trickling out over several.
- **General** re-reviews collect late-noticed polish in an explicitly non-blocking
  leftover list instead of letting it hold rounds open, and every re-review — general or
  security audit — wraps up in a line once nothing substantive is left. Decisions
  you recorded in the PR description or *Notes for reviewers* are respected for every
  kind of finding, and when a large diff crowds out GitDesktop's own earlier comments
  the review is told they were omitted rather than quietly losing the record.
- Agentic AI reviews now get 20 minutes before timing out (up from 10), and a new
  **Review timeout** setting under *Settings → AI* lets you raise or pin the limit
  for agent-CLI reviews.
- **Re-reviews end with a verdict** — every AI re-review, general or security audit, now
  closes with one of two explicit lines: `Verdict: blocking issues remain`, or
  `Verdict: no blocking issues — remaining items are non-blocking; merge when ready`.
  A round that resolved everything but noticed one nit used to read as another round;
  now it says which it is.
- **Reviews know where your docs live.** A general review is given the repository's
  documentation surfaces by path — README, changelog, changelog fragments, docs
  directories — so a user-facing change that leaves any of them stale comes back as one
  finding naming every affected surface, including ones the diff never touched, instead
  of one surface per round. Your **custom instructions** now reach reviews too — the
  global ones from Settings and a repo's own `.gitdesktop/instructions.md` — as
  conventions to judge the change against.
- **The opening comment now keeps a guaranteed share of the budget, not just its
  place in the queue.** Being kept rather than dropped only settles which comments
  make it in; how much of each one survives is decided earlier, and there the opening
  comment was treated as just another block — so on a long thread it was squeezed to
  the same per-comment minimum as a one-line "fixed in `<sha>`" reply. It is now
  allotted its share before the rest divide up what remains, and the decision-ledger
  distiller reads more of every comment on shorter threads.

### Fixed

- **AI ignore patterns now follow `.gitignore`'s matching rules.** A bare name
  matches at any depth (`secrets.env` also covers `config/secrets.env`), a bare
  folder name hides that folder's contents wherever it sits (`node_modules`), a
  leading `/` anchors a pattern to the repo root, and `*` stops at a `/`, so
  `docs/*.log` covers `docs/a.log` but not `docs/sub/b.log`. **Patterns you
  already have may hide more than they did:** saved lines carry no anchor —
  including every one *Exclude from AI* added — so a stored `notes.md` now hides
  each file of that name rather than only the copy at the root, and a stored
  `build` or `node_modules` now hides those folders instead of nothing at all.
  That only ever withholds more from a model, never less, but it's worth a look
  at your lists. *Exclude from AI* now writes anchored lines
  (`/src/config.ts`, `/vendor/`) that mean the one file or folder you picked,
  matching what *Ignore* writes to `.gitignore`. `!` re-include lines aren't
  supported.
- **Files with unusual names survive diff parsing.** git escapes a non-ASCII path
  like `café.txt` when it writes a diff, and GitDesktop skipped those files when
  splitting a combined diff into per-file sections — so such a file showed no
  diff in a pull-request or commit view, and was dropped from the diff sent for
  an AI review or a generated description rather than being weighed against your
  ignore patterns.
- Your **AI ignore patterns** are now honored by AI reviews — the ones you start
  from the PR panel and the automated ones alike, including the "changes since
  your last review" delta they build on — where the whole diff previously
  reached the provider. The prompt states how many files were held back rather
  than passing the diff off as complete, and if every changed file is excluded,
  nothing is sent at all. As everywhere else, a model that reads your repository
  itself isn't limited by these patterns — that's what **Agentic review** on a
  pull request turns on.
- An automation review claim left behind by a crashed or outdated app instance no
  longer blocks that pull request's review for other instances — a stale claim is
  reclaimed after 30 minutes instead of waiting for the 30-day sweep. The
  missed-review catch-up now works per review mode, so a failed general review is
  retried even when the security audit already ran.
- Your **AI ignore patterns** are now honored when generating the description
  for a pull request you're creating (local PRs included, and the MCP
  `generate_pr_description` tool), when generating a squashed commit's message,
  and when generating a reworded commit's message in Edit history — those paths
  previously sent the whole branch diff to the provider. The prompt states how
  many files were held back rather than passing the diff off as complete.
- **Generate from changes** now works on a branch whose work is already
  committed. Whenever the working tree can't describe the branch being named —
  it's clean, or you're renaming a branch you aren't on — it names the branch
  from that branch's own committed work instead: the diff and commit subjects
  vs. the default branch. That's exactly the case a rename usually needs.
  Applies in the app and to the MCP `generate_branch_name` tool and prompt, and
  when the button *is* disabled it now says why.
- Editing or deleting a commit comment while viewing a fork through the
  parent-repository (upstream) lens now targets the same repository the comment
  was created on, instead of failing against the fork.
- External AI-reviewer findings now fair-share the review-context budget instead of each
  being cut at a small fixed size, a trimmed finding says so explicitly, and the **Review
  context** size setting now reaches that section of the prompt.
- **File actions and views now use exactly the file you picked when its path
  contains `[`, `*` or `?`.** On a dynamic route like `src/app/[slug]/page.tsx`,
  staging, unstaging, discarding, stashing, ignoring, untracking, force-adding
  and taking one side of a conflict all act on that file alone. Those paths used
  to be handled as match patterns, so a neighbouring file could be swept in
  alongside the one you chose — most seriously, **discarding changes could throw
  away another file's uncommitted work**, and resolving a conflict could silently
  resolve a second file the same way. Reading is exact too: a file's history, and
  its diff in the working tree, in a commit, in a stash, or against another
  branch, no longer fold in a neighbour's commits and hunks. *Ignore* and
  *Exclude from AI* also write a working pattern for a name that ends in a
  space, which previously matched a different file and left the one you picked
  alone.
- Jira estimate fields no longer keep showing the "Enter a Jira duration" warning
  after the value refreshes from the server.
- AI re-reviews now read long GitDesktop-posted PR comments (context briefs, triage
  summaries) in full when the review-context budget has room — previously every such comment
  was silently cut to 1,500 characters no matter how much budget was free, so a reviewer
  could be handed a numbered list that stopped after item 2. A comment that still has to be
  trimmed now says so explicitly in the prompt instead of trailing off in a bare ellipsis.
- **Long review threads keep their recorded decisions.** When GitDesktop's own comments
  on a pull request substantially outgrow the review-context budget, the AI review now
  reliably distills them into a compact decision ledger — reading the complete comments
  rather than the already-trimmed ones, and giving an agent-CLI generation model the time
  it needs to finish — so refutations and "fixed in `<sha>`" notes survive a long thread
  instead of being cut away with the text.
- When a PR's own-comments context outgrows its budget, the opening context comment is now
  kept alongside the newest follow-ups instead of being the first thing dropped.
- Merging a repository's old app data — on relocate, or when older path-keyed
  records are folded onto its stable identity — no longer lets duplicate legacy
  records (including records without ids) through.
- Your **AI ignore patterns** now apply when you regenerate the description of an
  already-open pull request or merge request, not only when you create one.
  Excluded files are dropped from the forge's own diff before it reaches the
  provider, and the prompt states how many were held back rather than passing the
  diff off as complete; if every changed file is excluded, nothing is sent at all.
- The error shown when a history-rewrite operation is blocked by uncommitted
  changes no longer contains garbled characters — the dash renders properly.
- **Security audits no longer assume GitDesktop's own tech stack.** The audit prompt told the
  model, as fact, that the code in front of it was Rust and React, and applied exemptions
  written for that stack to every repository you audit. Anything reachable through
  environment variables or command-line flags was trusted outright (untrue for a server, a
  container, or a shared CI runner), and missing authorization was waved off in frontend code on
  the assumption that a separate backend was re-checking it. Each of those rules is now judged
  against the code actually under review, and an audit sizes up the change's own language, trust
  boundary, and existing validators first. **Prototype pollution** is now a named category too.
- **More vulnerability classes can actually be reported.** The audit's list of risk categories
  read as closed, so a real issue that fit none of its buckets — cross-site request forgery or a
  missing origin check, over-permissive CORS, clickjacking — had nowhere to be filed; the list is
  now explicitly open-ended. Memory-safety problems are also caught in the unsafe corners of
  otherwise-managed languages (Java's `sun.misc.Unsafe`, Swift's `Unsafe*Pointer`, a Kotlin/JNI
  boundary), and a value read from a cloned repository's own content and passed to a spawned
  command is no longer treated as trusted just because the tool runs on your machine.
- **Sharper severity and confidence on security findings.** *Critical* is now a severity that a
  finding can actually carry — remote code execution, code execution triggered by content you
  merely clone or open, full system compromise, or a mass data breach — where before it was
  referenced by the reporting rules but never defined, so the worst issues had nowhere to go but
  High. Confidence is now calibrated by what the reviewer actually saw, and the flat
  ">80% confident" rule that contradicted the severity-scaled thresholds is gone.
- Updating a single submodule whose path contains `[`, `*` or `?` now updates
  that submodule. It previously initialized and checked out a *different* one
  whose path happened to match, and left the one you asked for untouched.

## [0.5.2] - 2026-07-23

### Fixed

- The Settings **API key** field is now properly associated with its label, so
  screen readers announce the input and clicking the label text focuses it.
- Opening the diff of a generated or minified file (a `tsconfig.tsbuildinfo`,
  minified bundle, or source map that is one enormous line) no longer freezes
  the app: such files show a *generated or minified* notice with one-click
  **Show diff anyway**, and extremely long lines are shortened for display in
  every diff view.
- The fork badge, provider label, and **Leave fork network** row now appear on
  the first open after cloning a fork. Previously they could take a second open
  (or a visit to the repo list) to show up, and a repo's stored forge metadata
  briefly reset on every open.
- A failed AI review notification is no longer a dead end: the **Activity &
  notifications** inbox row now says why the run failed, and an automated
  failure offers a one-click **Re-run** right from the row.
- **Stash selected files** now captures only the files you selected.
  Previously any other *staged* changes were silently saved into the stash
  entry too (a `git stash push -- <paths>` limitation); your unselected staged
  and unstaged changes are now left exactly as they were.

## [0.5.1] - 2026-07-23

### Fixed

- Fixed cloning, fetching, pulling, and pushing **private Bitbucket** repositories
  over HTTPS failing with `could not read Password for '…@bitbucket.org': terminal
  prompts disabled` on macOS and Linux. GitDesktop now hands your stored Bitbucket
  API token to git's credential store over STDIN (never placed on the command line),
  so operations authenticate without a prompt wherever git has a credential helper —
  the system keychain on macOS, Git Credential Manager on Windows, or a configured
  helper on Linux. Cloning over SSH was unaffected.
- The task editor no longer warns that an interpreter "wasn't detected" when it's
  actually installed. Interpreters installed through a version manager (nvm/fnm for
  Node, and anything else that lives only on your shell's PATH) weren't found by the
  editor's quick check when GitDesktop was launched from the Dock or Finder on macOS
  — even though the task ran fine. The editor now confirms the selected interpreter
  the same way a run resolves it (via your login shell), so it shows the real path
  instead of a false "not detected" warning.

## [0.5.0] - 2026-07-22

### Added

- **Re-run a stopped automated review.** When an automation-triggered AI review or
  security audit is cancelled or fails, it now stays in the Activity popover under a
  **Stopped** group with **Re-run** and **Dismiss**, so you can retry exactly that run
  (and mode) without hunting for the commit or PR again. A failed automated run also
  lands a *review failed* notification in the inbox — matching manual runs — when
  automation notifications are on.
- **Create pull requests as drafts by default.** A new Settings → General toggle,
  **Create pull requests as drafts** (off by default), pre-checks the Create pull request
  dialog's *Create as draft* box so you can open PRs as drafts without remembering to tick
  it each time — still overridable per PR. Paired with *Review draft PRs when created*, a
  draft's automated first review then waits until you mark it ready.
- **See how long reviews take.** The Activity & notifications popover now shows a live
  elapsed timer on a running AI review, notes how long a stopped (cancelled or failed)
  automated run ran before it stopped, and the **Previous reviews** list shows each
  finished review's total run duration. The PR review panel also ticks a live elapsed
  timer beside Cancel while a review runs, and shows the total time it took once it's done.
- **Notes for reviewers.** Hand review context to the AI reviewer: an agent (or any
  MCP client with write access) deposits per-branch notes via the GitDesktop MCP, and
  the Create pull request dialog shows an optional **Notes for reviewers** field that
  pre-fills from that deposit for the head branch. On create the notes are posted as the
  PR's first comment and fed to the automated review as first-class context, so
  deliberate, documented decisions stop getting re-flagged. A new *Review draft PRs when
  created* automation setting (off by default) holds a draft PR's first review until it's
  marked ready for review.
- **Dedicated security-audit model.** Give AI security audits their own provider and model,
  separate from the general review model — e.g. a stronger model for audits and a faster one
  for everyday reviews. Toggle **Use a different model for security audits** under the review
  model in Settings → AI; left off, audits keep using the review model exactly as before. The
  choice applies to both automated audits and the **Security audit** button on a PR (an
  in-panel model pick still overrides both for that one run).
- **Tasks — save scripts and run them in-app.** A new **Tasks** tab (and a
  command-palette **Run a task…**) lets you register your own scripts — a release or
  build flow, say — and run them without dropping to a terminal. Point a task at an
  **existing script in the repo** (it runs the live file, so edits take effect on the next
  run) or write one **inline**; with an AI provider connected, **Generate** writes an
  inline script from a plain description, and **Analyze with AI** reads a script and fills
  in its name, description, and the arguments it accepts. Each task carries a description
  and default arguments (quoted values kept intact), documents its arguments
  `--help`-style, and a confirm-gated run lets you adjust the arguments per run. Runs
  happen in an **interactive** terminal in the repository's folder, so scripts that prompt
  you (a version to release, a yes/no) work and keep their colour; **Stop** kills the run
  and its child processes, **Rerun** starts a fresh one. Choose the interpreter — PowerShell,
  cmd, Git Bash, bash/sh/zsh, Node, Deno, Bun, Python, or Ruby, with the editor showing which
  it detected on your machine. Task definitions live in your app data
  and are never read from repository content, running is off until you enable it, and each
  task can ask for confirmation before it runs.
- **Themes.** Choose how GitDesktop looks in **Settings → Appearance**: **System**
  (follow your OS), **Light**, **Dark**, or a softer **Slate** — a cool, lifted
  blue-gray that eases eye strain on long sessions. Cycle themes from the command
  palette too.

### Changed

- CI run and job log lookups now thread ids as strings end-to-end, so they stay
  precise even above JavaScript's safe-integer limit (2^53). The MCP workflow
  tools accept a run/job id as either a number or a numeric string, so existing
  callers keep working.
- **Toggle a PR between draft and ready on every provider.** The pull-request footer's
  **Ready for review** / **Convert to draft** pair now works both ways on **GitHub**,
  **GitLab**, and **Bitbucket** — not just Bitbucket, and no longer one-directional. Both
  actions are also in the command palette, and the GitDesktop MCP `set_pull_request_draft`
  tool now covers all three providers too.

### Fixed

- Ignore and AI-exclude toasts now report how many patterns were actually
  added, rather than the size of the selection — so a fully-covered selection
  says everything was already ignored instead of claiming entries were added.
- **Publishing a draft release no longer clears its Latest status.** Publishing
  a draft from the app now follows GitHub's default and becomes the **Latest**
  release on publish, instead of being forced non-latest. The Edit dialog explains
  that Latest applies only to published releases rather than offering a toggle
  GitHub would silently ignore on a draft. The MCP `update_release` tool had the
  same issue and is fixed too.
- Fixed AI features failing when their input text contained an emoji near a size
  limit. When a prompt was truncated to fit its budget, the cut could split an
  emoji (a UTF-16 surrogate pair) and leave an invalid Unicode fragment that the
  model provider rejected ("unexpected end of hex escape" / "Invalid body") — most
  visibly breaking AI PR reviews when a bot review or prior comment contained an
  emoji, but the same flaw affected PR-description and commit generation, issue
  drafting, merge-conflict resolution, and repo/discussion prompts. Prompt
  truncation now respects character boundaries everywhere, so emoji are never split.
- User-facing copy no longer hardcodes "right-click": on macOS the in-app guide
  and branch-status tooltips now say **Control-click**, matching how context
  menus actually open on trackpads and swapped-button mice. References to "its
  right-click menu" are now the platform-neutral "context menu" — across the
  in-app guide, README, and marketing site.
- Terminal and editor auto-detection now works on macOS and Linux, not just
  Windows. Settings → Terminal / External editor populate with the terminals and
  editors you actually have installed (Terminal, iTerm, Warp, Ghostty, VS Code,
  Cursor, Sublime Text, Zed, Xcode, JetBrains IDEs, and more), and "Open in
  terminal" / "Open in editor" now honor the one you pick instead of always
  falling back to the system default.

## [0.4.0] - 2026-07-19

### Added

- **Exclude files from AI in flow.** Right-click a changed file to keep it out of
  AI context — new **Exclude from AI** actions (the file, its folder, or its file
  type, plus a bulk action for multi-selections) append to the repo's
  `.gitdesktop/aiignore`, creating the file (and the `.gitdesktop` folder) if
  needed.
- **Start a new branch from any base.** The new-branch dialog's **Base it on** picker is
  now a searchable list grouped into **Local** and **Remote** branches, so you can base a
  branch on any of them instead of only the current or default branch. Basing on a remote
  branch (e.g. `origin/epic/big-feature`) starts from the remote tip and leaves the new
  branch untracked, so its first push publishes it under its own name. Agents get the same
  option via the MCP `create_branch` tool's `noTrack` flag.
- **Keyboard shortcuts in the PR and issue dialogs.** Press **Ctrl/Cmd+Enter** from any
  field in the **Create pull request**, **Create local PR**, or **Edit title/description**
  dialog (for pull requests and issues alike) to submit it, matching the shortcut already
  used to send comments. When AI features are on, the **generate commit message** shortcut
  (Ctrl/Cmd+G by default) runs **Generate** for the title and description while a create or
  edit PR dialog is open.
- **Type-to-filter the author/label filter.** The pull-request and issue
  author/label filter now has a search box — start typing to narrow both the
  Author and Label sections, just like the branch switcher.
- **Detach from a fork.** The repository settings Danger zone now offers two ways
  to break a fork's ties: **Remove upstream remote** detaches your clone from the
  parent locally (the Fork/Upstream switcher and "Update from upstream" disappear;
  reversible by re-adding the remote), and **Leave fork network** detaches the
  repository from its fork network. On GitLab this happens right in the app
  (Owner-only — open merge requests to the parent are closed), while GitHub and
  Bitbucket link out to the provider's detach page. A **Re-check fork status**
  button refreshes the fork badge in place once you've done it.
- A **GitHub Actions** check that's still running in the pull-request view now shows
  its **current step** inline in the checks rollup, and a **live step checklist** when
  you expand it — real progress as the run advances, instead of an empty log skeleton.
- **PR timeline timestamps.** Every entry in a pull request's activity feed now
  shows when it happened — review-thread replies and pushed-commit groups (both the
  group header and each commit) gained relative timestamps that were previously
  missing — and hovering any timeline time reveals the exact local date and time.
- **Push a branch without switching to it.** From a branch's right-click menu in the
  branch switcher, push a branch that's ahead of its origin remote (**Push to
  _origin/…_**) or publish an unpushed one (**Publish branch**) — without checking it
  out. Works even when the branch is checked out in another worktree, since a push
  touches refs, never a working tree.
- New rebindable **Push to origin** shortcut (default **Ctrl+Alt+P** / **Cmd+Option+P**)
  pushes or publishes a branch to **origin** — the current branch, or, with the branches
  list open, the highlighted one. When there's nothing to push (diverged, up to date, or
  tracking a different remote), it says so instead.
- **New Settings → AI "Review context" size.** Auto fits the review prompt
  budget to the reviewing model's context window (probing Ollama models live), or
  pick Compact/Standard/Expanded manually.

### Changed

- Branch menu rows now show a branch's own push/pull state (↑ to push, ↓ to pull, plus
  markers for never-published and upstream-deleted branches) separately from its divergence
  vs. the default branch, which now reads `+N −M` with the default branch named — previously
  both rendered as identical ↑/↓ arrows, so being ahead of the default looked like unpushed
  work. Rows now span two lines — the branch name on its own line, the details below it —
  giving long branch names more room.
- The **Compare** tab's base-branch picker is now a searchable combobox: type to filter,
  archived branches are hidden, and each branch shows whether it's checked out in another
  worktree and — when it has diverged — how far it's ahead of and behind your current
  branch.
- The **Compare** tab now lives in the header's **More ▾** menu instead of the primary
  tab rail, keeping the rail focused on **Changes**, **History**, and **Pull Requests**.
  Its keyboard shortcut is unchanged.
- **Push a branch to any remote, not just origin.** Pushing a branch from the branch
  switcher now targets the branch's OWN remote — a branch tracking a fork's `upstream`
  is pushed there, not to origin. On a repo with several remotes, **Publish** offers a
  per-remote choice (one item per remote). The MCP `push` tool gains an optional
  `remote` parameter, and a bare `push {branch}` for a branch tracking a non-origin
  remote now correctly targets that remote instead of pushing to origin under the
  branch's own name.
- The header sync buttons are ordered **Fetch / Pull / Push** — mirroring the natural
  fetch → pull → push flow — and the ahead/behind counts appear directly on the **Push**
  and **Pull** buttons — making it clear which button acts on them — instead of in separate
  arrow badges.

### Fixed

- AI re-reviews now actually see the follow-up replies and triage decisions
  GitDesktop itself posted: review-thread replies GitDesktop posted (triage
  dispositions made through GitDesktop's agent/MCP tools) are harvested into the
  review context, the newest of GitDesktop's own PR comments win the context
  budget instead of the oldest, and when rounds accumulate past the budget the
  prior discussion is distilled into a compact decision ledger instead of being
  cut off.
- Repo-aware AI reviews and sessions run with the Claude CLI can now actually
  call the attached GitDesktop MCP tools. Previously the tools were exposed but
  never granted permission, so every call was denied in headless mode and the
  reviewer silently fell back to files on disk (losing full-diff, PR-metadata,
  and blame lookups); the read-only server's tools are now granted explicitly.
- Push, pull, fetch, and clone to private repos no longer fail with "Repository not
  found" when a stale credential in the system keychain (macOS Keychain, Windows
  Credential Manager) shadows your `gh`/`glab` sign-in — Git is now told to use exactly
  the signed-in CLI's identity for that host. Tag pushes, remote branch deletion, and
  fork PR pushes now authenticate the same way.
- The pull-request and issue **author/label filter** popup no longer overflows
  the window on repos with many authors — it now caps its height and scrolls
  internally instead of forcing the whole window to scroll.
- **Screen readers now announce every form field by name.** Labels across the app's
  dialogs and settings are programmatically associated with their controls (`Base it on`,
  select fields, the compare picker, and a dozen more), so assistive tech announces the
  field name instead of just its value — and clicking a label focuses or opens its control.
- Keyboard shortcuts owned by a visible surface no longer fall through to the underlying
  webview when that action is momentarily disabled — so Ctrl+P won't open a print dialog
  (nor F5 reload the app) when there's nothing to push or fetch. Shortcuts for surfaces
  that aren't on screen keep their native behavior. The Fetch, Pull, and Push buttons'
  tooltips now show their shortcuts, and expose them to screen readers.
- Pull requests you open **outside** GitDesktop — with the `gh`/`glab` CLI, on the
  web, or via a bot — now get their initial automated AI review too. Previously the
  *On pull request opened* automation fired only for PRs created through the app's own
  dialog, so externally-opened PRs got no first pass. The poller now catches up your
  own non-draft, recently-opened, unreviewed PRs and runs the review automatically.
- AI reviews no longer prepend the agent's streamed working narration ("I'll examine
  the code… let me check the call sites…") to the review body — the review is now the
  agent's final answer, and the narration is preserved under a collapsible **Thought
  process** disclosure. This applies to CLI and agentic HTTP reviews, automation-posted
  comments, and research report synthesis.
- Skipped CI checks (and neutral or stale ones) in a pull request's checks rollup
  now show as their own muted **skipped** segment instead of masquerading as
  amber **pending** — on GitHub and for GitLab's skipped pipeline jobs alike.

## [0.3.1] - 2026-07-17

### Added

- **In-app forge sign-in, reconnect & session health.** Sign in to GitHub (`gh`'s
  device-code flow) and GitLab (`glab --web`) without leaving the app — from the
  not-signed-in panels, **Settings → Accounts**, or the command palette; a terminal
  stays a fallback. GitDesktop now distinguishes an **expired or revoked session** from
  never-signed-in and passing network blips, badges the affected account with one-click
  **Reconnect**, and **warns before a token expires** — GitLab and GitHub personal
  access tokens, plus an optional Bitbucket token **expiry date** you supply. GitLab
  sign-in recommends the browser (OAuth) option, whose sessions renew themselves instead
  of forcing periodic re-login.

### Changed

- Refreshed frontend dependencies: security fixes in the HTML sanitizer (DOMPurify)
  and Markdown renderer (marked), a fix for streamed AI tool calls that could execute
  with incomplete arguments, smoother dialog exit animations, and a diff-view fix so
  inline widgets (like AI review comments) no longer have their text color forced by
  the library.

## [0.3.0] - 2026-07-16

### Added

- **AI generation can now run through your agent CLI.** Commit messages, PR
  descriptions, branch names, issue drafts, release notes, and repo descriptions
  can be generated by an installed agent CLI — **Claude Code, Codex, GitHub
  Copilot, or opencode** — using its own subscription login, no API key needed.
  Pick a CLI as your AI provider in **Settings → AI**. Generation stays
  prompt-only (the agent never explores the repo), and because it runs the CLI
  per request it's slower than an HTTP provider and draws on your plan's quota.
- **Code TODOs tab.** Scan your working tree for `TODO`, `FIXME`, `HACK`, `BUG`, and
  `XXX` comment markers (tracked and new-but-not-ignored files), grouped by file and
  filterable by text, path, or marker. Select one for a syntax-highlighted excerpt with
  blame attribution, then open it in your editor, copy its `path:line`, or promote it to a
  local issue (pre-filled with the comment and a `path:line` reference) that you can publish
  to GitHub or Jira.
- **Fork · Upstream lens for GitHub forks.** On a fork (a repo with an
  `upstream` remote), the **Pull Requests** and **Issues** tabs gain a
  **Fork | Upstream** switcher in the list toolbar — remembered per repo,
  defaulting to your fork. Switch to **Upstream** and the remote list, detail
  views, comments, reactions, and metadata pickers all read and write the
  **parent** repository (your local to-dos and Jira issues are untouched).
  Creating an issue under the Upstream lens opens it **on the parent**, with the
  dialog saying so plainly. Two palette commands, **Switch to fork view** and
  **Switch to upstream view**, flip the lens without the mouse. A fork with
  issues turned off now offers a one-click **Switch to upstream** to browse the
  parent's issues instead of a dead end.

### Changed

- Large diffs in TextMate-highlighted languages (Rust, TSX, Astro, Svelte, and
  other Shiki-rendered or custom-grammar languages) no longer lose their
  VSCode-fidelity highlighting past the size budget, in every read-only diff
  surface: commits and history, pull requests, branch compare, stashes, file
  history, session changes, and conflict resolution. They now tokenize in a
  background thread and fill in when ready, with standard highlighting shown in
  the interim.
- Opening a pull request now targets a repository explicitly. On a **fork** the
  create dialog lets you choose where the PR lands — your **fork** or the
  **upstream** repository (defaulting to upstream), listing the chosen
  repository's base branches; previously the target was left to `gh`'s implicit
  resolution. Labels and assignees aren't available when you open the PR on the
  upstream repository. Targeting the upstream repository requires an `upstream`
  remote; on a fork cloned without one, the create dialog now offers to add it.

### Fixed

- **Fixed over-eager AI label suggestions in generated PR descriptions.** The AI
  PR-description generator now weighs each label's stated purpose (its description),
  not just its name, and follows a conservative policy: for most changes the right
  outcome is one label or none. It no longer pushes rare process labels — changelog
  or release controls, triage states, and dependency-bot ecosystem labels (a
  language or tooling name a bot applies to dependency bumps) — onto ordinary code
  changes, suggesting them only when the change is precisely that case.
- On a GitHub fork, the app now consistently targets **your fork** instead of the
  parent repository. Previously the GitHub CLI's own auto-resolution preferred the
  upstream repo, so PR and issue surfaces (lists, detail views, comments, reviews,
  merges, labels, assignees, milestones, stars, reactions) and the PR-notification
  poller could silently act on the parent's data. They now all pin to the fork's
  own `origin`. This also covers the History tab: commit diffs and commit comments
  resolve against your fork, and a new commit comment is posted to your fork rather
  than the parent. Forks with issues turned off (GitHub's default for new forks) now
  show an informative "issues are disabled" notice instead of a failing retry.
  Repositories without an `upstream` remote are unaffected — the behavior there is
  identical to before.
- **Fixed private-repo Fetch/Pull/Push failing on a Finder-launched macOS app.**
  When the app was launched from Finder or the Dock, network operations against a
  private HTTPS repo could fail with "Repository not found" because git's
  credential helper couldn't find `gh`/`glab` on the minimal launchd PATH, so the
  request went out unauthenticated. Fetch, pull, and push now inject the forge
  credential helper with a resolved absolute CLI path, so authentication is
  deterministic regardless of how the app was launched.

## [0.2.3] - 2026-07-15

### Changed

- The MCP `list_pull_request_comments` tool and the AI PR review now emit
  leaner comment payloads, omitting always-empty default fields (avatar URL,
  state, permalink, minimized flags, and review id) from each comment and
  review thread — the same JSON both consumers read, so agent runs and reviews
  spend fewer tokens on empty fields.
- Remote (HTTP) MCP servers now surface the same allowed-hosts affordance as
  custom AI provider URLs: the add/edit dialog shows an advisory note under a
  URL whose host isn't on your AI allowlist, with a one-click **Allow host**,
  and the MCP servers list flags such a server with a **host not allowed**
  badge. It's advisory only — nothing is blocked or disabled, and existing
  servers keep working — a reminder that the CLI connects to that host outside
  GitDesktop's AI host allowlist.
- Merging a pull request in the app now kicks off a background fetch (with
  prune) right after the merge succeeds, so branches, ahead/behind counts, and
  history reflect the merge immediately instead of staying stale until you
  click Fetch. On a merge that deletes the head branch, the prune also drops
  the now-stale remote-tracking ref.

### Fixed

- The blame view now announces as a structured list to screen readers, so each
  line is read as an item with its position (line 12 of 340) instead of an
  unstructured run of text.
- History commit avatars now fall back to a GitHub author's real avatar instead
  of their initials when their commit email isn't a GitHub no-reply and has no
  Gravatar — resolved in a batch from the recent-commits window for GitHub repos.
- Jira project admins can now edit and delete other people's worklogs and
  comments from the issue view — GitDesktop previously only offered those
  actions on your own entries, even when your Jira role held the project-wide
  edit/delete permissions.
- MCP servers scoped to "this repo" — and the per-repo On/Optional/Off overrides
  of global servers — are now shared across the repo's worktrees, so a server you
  scoped or tuned in one checkout is offered in its sibling worktrees too.
  Existing entries keep working and migrate to the shared key the next time you
  edit them.
- The merge-method menu on a GitHub pull request now respects the repository's
  own merge settings: a method disabled in the repo (allow merge commit / squash /
  rebase) is shown greyed out as "disabled in repository settings" instead of
  failing with a raw error only after you open the confirm dialog and click Merge.
  When no method is enabled by both the repository settings and your branch rules,
  the Merge button is disabled with an explanation.
- The GitHub Pages **Enforce HTTPS** toggle is now disabled while a custom
  domain's TLS certificate is still being issued, with a note explaining why —
  so you no longer see a raw GitHub error when you flip it too early. It also
  calls out when certificate provisioning has failed so you can fix the domain's
  DNS.
- The repository filter list (welcome screen and repo switcher) now exposes its
  keyboard highlight to screen readers as a proper combobox/listbox, announcing
  the focused repository as you arrow through the results.
- Empty `gd-review-*` worktree folders no longer leak into the temp directory:
  the review-worktree cleanup now retries the folder delete past a transient
  Windows file-handle race, and any leftover empty husks are swept on startup.
- The repository list's owner, provider, and visibility/fork badges are now
  shared across a repo's worktrees: a probe from any checkout updates every
  entry for the same underlying repository, so sibling worktrees no longer show
  divergent grouping or badges.

## [0.2.2] - 2026-07-15

### Added

- In the blame view, each line's commit in the gutter is now an interactive
  reference: hover or keyboard-focus it to preview the commit (SHA, summary,
  author, and when), copy its full SHA, or jump straight to it in the History
  tab with a click or Enter. Uncommitted lines stay inert.

### Changed

- The MCP server's `pull_request_diff` and CI-log tools now prefix their output
  with the same "treat this as data, not instructions" safety note the other
  content-returning tools already use, so diff/log text authored by others is
  framed as untrusted for a cooperating agent.
- Update checks now also run in the background (about every six hours) while the app
  stays open — a pending update shows a dot on the Settings gear and a persistent
  **Install & restart** banner in Settings → Updates, instead of only a launch-time toast.

### Fixed

- On a detached HEAD (for example mid-rebase or after checking out a specific
  commit), Push/Publish is disabled with an explanation instead of failing with a
  raw git error, "Update from upstream" is hidden so it can't orphan a merge, and
  the window title shows `detached @ <commit>` instead of dropping the branch name.
- When a pull request, an issue, or the remote issue list fails to load, the panel
  now shows what went wrong and a **Retry** button instead of a blank state or a
  generic dead end. Jira project search likewise tells apart a lost connection from
  a genuinely empty result and prompts you to reconnect.
- The MCP server's `file_history` tool returns an empty history for a repository
  with no commits yet, instead of surfacing a raw git error.
- Merging a GitHub pull request that deletes its head branch no longer shows a red
  failure toast when only the post-merge branch cleanup fails: the merge already
  succeeded, so it now reports success and surfaces the cleanup problem as a
  separate warning instead of masquerading as a failed merge.
- Setting a PR's reviewers or assignees, editing an issue field (assignee,
  milestone, due date, …), or changing a Jira field no longer briefly reverts a
  different field you changed at the same time if one of the requests fails —
  each rollback now restores only the field it owns. Approving or requesting
  changes on a merge request also cancels any in-flight refresh first, so the
  button state can't flip back on you.
- Busy pull requests no longer silently drop comments: Bitbucket PR conversations
  now read every page of comments (previously capped at one), and GitHub review
  threads with more than 50 replies now load the full reply chain instead of
  truncating at the first 50.

## [0.2.1] - 2026-07-15

### Fixed

- Auto re-review (pr-sync) automations now fire even when the repository isn't
  the one currently open — GitDesktop keeps watching recent repositories that
  have a re-review rule, so pushing and switching repos no longer delays the
  review until you switch back.
- **macOS: GitHub and Git are found when launched from Finder or the Dock.** A
  GUI launch doesn't inherit your shell's `PATH`, so a Homebrew-installed `gh` or
  `git` used to read as "not found" everywhere except the About screen — breaking
  clone, pull requests, issues, and other GitHub features. GitDesktop now finds
  these tools the same way the About screen already did.
- Creating a local PR from an agent session or the Compare tab no longer leaves
  the dialog stuck open (and impossible to close) after the PR is created — the
  app now switches to the new PR with the dialog closed, as intended.

## [0.2.0] - 2026-07-14

### Added

- **Per-repo custom agent container image.** A repository can now add extra tools to its
  containerized agent sessions — e.g. Playwright for browser tests — by committing a
  `.gitdesktop/agent.Dockerfile` that starts `FROM gitdesktop-agent:latest`. GitDesktop
  builds it into a per-repo image (layered on the managed agent base) and runs that repo's
  container sessions and Test shell in it. Manage it under **Settings → AI → Agent session
  isolation**: a status line shows whether the custom image is built, **Review & build**
  shows the Dockerfile and asks you to confirm before building (the build runs the file's
  commands, so it never happens automatically — the guard for a cloned repo you don't fully
  trust), and **Add custom tools…** scaffolds a starter Dockerfile for you to edit and commit.
- **Bitbucket Cloud (read).** Connect Bitbucket in **Settings → Accounts** with an
  **Atlassian API token** (created at id.atlassian.com, used with your Atlassian
  account email; stored in your OS keychain), then **browse & clone** your Bitbucket
  repositories and read **pull requests** (diffs, comments, build statuses) and watch
  **Pipelines** with step logs — all in the same panels as GitHub and GitLab. Bitbucket
  has retired its native issue tracker (issues now live in Jira), so issues aren't shown
  for Bitbucket repositories.
- **Bitbucket Cloud pull request & Pipeline actions.** Beyond reading, you can now act on
  Bitbucket Cloud from GitDesktop: **comment**, **decline**, **merge** (merge commit,
  squash, or fast-forward, with an optional delete-source-branch), **edit**, **create**
  (drafts included), and **approve/unapprove** pull requests, plus **rerun**, **trigger**
  (with variables), and **stop** Pipelines. Add the `write:pullrequest:bitbucket` and
  `write:pipeline:bitbucket` token scopes in **Settings → Accounts** to enable them.
  Reopening a declined PR isn't available — a Bitbucket platform limit.
- **Bitbucket Cloud PR reviews & drafts.** Bitbucket pull requests gain the rest of the
  review flow: **request changes** as a true toggle (click again to revoke — unlike
  GitLab, Bitbucket's revoke works on every plan; approving also clears it), a
  **reviewers picker** that lists your workspace members (minus the PR author, whom
  Bitbucket won't accept as a reviewer), and a both-ways **draft toggle** — mark a draft
  **ready for review** or convert a ready PR **back to draft**.
- **Bitbucket Cloud publish, Insights & repository settings.** Three more Bitbucket
  surfaces come online. **Publish a local repo** — a repo with no remote can be published
  to Bitbucket from the sync bar's **Publish repository…** (or the not-ready panel): pick a
  **workspace**, give it a name (which becomes the URL slug), optionally a description,
  website, and public/private, and GitDesktop creates the repo, adds it as `origin`, and
  pushes the current branch. **Insights** now works on Bitbucket repos — the local-git
  charts, a **Pipelines** duration and success-rate chart, and a *More on Bitbucket* card
  that links out to Commits, Branches, and Pipelines (the GitHub-only community, traffic,
  and dependencies cards stay hidden). And **repository settings** (for a repo you admin)
  manage a Bitbucket repo end to end: **General** (description, website, language, fork
  policy, default branch), **Default reviewers** (from your workspace members), **Branch
  restrictions** (prevent pushes / force-pushes / deletion, restrict merges, require
  approvals / passing builds / resolved tasks, by glob pattern), pipeline **Variables**
  (secured supported, with an enable-Pipelines toggle) and **Schedules** (cron, enable /
  disable, delete), **Webhooks** (create / edit / delete with an event checklist — Bitbucket
  has no delivery-log API, so there's no deliveries view), and a **Danger zone** (rename,
  which updates your local `origin` remote automatically; change visibility; transfer via a
  link out to Bitbucket; and delete — Bitbucket has no archive).
- **Bitbucket Cloud PR tasks, custom pipelines, deployments & create-time reviewers.** Four
  more Bitbucket surfaces. A Bitbucket pull request now has a **Tasks** checklist in its
  conversation view — add, edit, resolve/unresolve, and delete tasks, with a completion
  progress bar, an "N open tasks" chip in the PR header that jumps to the list, and
  comment-attached tasks that link back to their comment (read-only once the PR is closed or
  merged). The **Run pipeline** dialog gains a **Pipeline** picker on Bitbucket repos whose
  `bitbucket-pipelines.yml` defines custom pipelines (`pipelines.custom.*`) — run the
  branch's Default pipeline or a named custom one, with the same variables. **Repository
  settings → Pipelines → Deployments** lists the repo's **deployment environments**
  (read-only, with tier and not-yet-used / admin-only hints and a *Manage on Bitbucket…*
  link out), and the Insights *More on Bitbucket* card gains a **Deployments** link.
  Finally, the **Create pull request** dialog lets you pick **reviewers** up front (an empty
  selection keeps Bitbucket's default reviewers).
- **GitLab time tracking.** Track time on a GitLab issue or merge request without
  leaving the app: set an **estimate** (e.g. `3h`) and log **spent** time (e.g.
  `45m`, or subtract with `-15m`), with a progress bar and an "over" note when
  spent exceeds the estimate. Issues show it in the side rail; merge requests show
  a compact clock summary in the header that opens the same controls in a popover.
- **GitLab related issues.** Link a GitLab issue to other issues in the project
  right from its side rail — pick one from the inline search, open a linked issue,
  or unlink it. Read-only once the issue is closed.
- **Play manual GitLab jobs.** A manual pipeline job — one that waits for a manual
  trigger — now shows a **Run job** button in the pipeline detail view that plays
  it, so you don't have to switch to GitLab to start it.
- **GitLab auto-merge.** Arm merge-when-pipeline-succeeds from the merge request
  view while a pipeline is running — the merge menu offers auto-merge (merge or
  squash) variants, and once armed the footer shows an "Auto-merge enabled"
  indicator you can cancel in place. GitLab merges it for you when the pipeline
  passes.
- **PR notifications & remote pr-sync on GitLab and Bitbucket.** The background PR
  poller — OS notifications for pull requests opened, merged, or closed, and the
  **remote pr-sync** automation that re-reviews an open remote PR when its head
  advances — now works on GitLab and Bitbucket repositories, not just GitHub. (Check
  and review-decision notifications stay GitHub-only for now: GitLab and Bitbucket
  don't report a check rollup or approval state in the list responses the poll uses.)
- **Copy the branch name or HEAD SHA.** The repository menu (and command palette)
  gained two clipboard actions alongside "copy the repo path": **Copy branch name**
  copies the current branch, and **Copy HEAD SHA** copies the full commit SHA of
  `HEAD` — each with a quick confirmation toast. Each disables when its value
  isn't available: Copy branch name on a detached HEAD, and Copy HEAD SHA in a
  fresh repo with no commits yet.
- **GitLab, in the same panels.** GitDesktop now speaks GitLab as well as GitHub,
  through the **GitLab CLI (`glab`)** — same delegated-auth model as `gh`, no tokens stored.
  Point the app at a GitLab repo (or **browse and clone your GitLab projects** from the
  **GitLab** tab in the clone dialog) and the **Pull Requests** panel lists its **merge
  requests** right alongside any local PRs — open and closed/merged, searchable and
  filterable. Open one for the description, comments, commits, and a syntax-highlighted
  **diff** (plus an "Open on GitLab" link) — and **comment** on a GitLab MR,
  **close / reopen** it, **edit its title and description**, **approve / unapprove** it
  (a GitLab reviewer action, with the
  approval count shown inline), **request changes** (the blocking reviewer state — the app
  adds you as a reviewer if needed and posts your drafted comment alongside; approving
  clears it), **react with emoji** on the description and comments (GitLab's award
  emoji, the same reaction bar as GitHub), **merge** it (merge or squash, optionally deleting the
  source branch — guarded so it never merges a head you didn't see), and edit its **labels**
  and **assignees**. The **AI Review tab** works on GitLab MRs too — run a code review or
  security audit of the MR diff and post it as a comment.
  You can also **create a merge request** right from the app (the New menu, the command
  palette, or the Compare tab) — it pushes your branch and opens the MR, draft included, and
  the Compare tab now spots an **existing open MR** from your branch and offers **View**
  instead of a duplicate **Create**. The **Issues** panel speaks GitLab
  too — its issues (open and closed) next to your local issues, and an issue view with the
  description, comments, and a side rail of labels, assignees, and milestone — with GitLab
  issue **writes**: **comment**, **close / reopen**, **edit the title and description**,
  **react with emoji**, editing **labels**, **assignees**, and the **milestone**
  right in that side rail, and **creating issues** (with labels, assignees, and a
  milestone) from the same
  dialog GitHub uses. Publishing a **local** issue or PR to GitLab works too. The
  **Actions** panel covers GitLab **CI pipelines** — the run list, a branch CI badge, a
  pipeline view with its **jobs** (status, durations, and per-job **logs**), plus the
  actions: **cancel** a running pipeline, **retry** a failed or canceled one, and
  **run a fresh pipeline** on any branch or tag with optional **CI/CD variables**. The
  **Tags** panel manages GitLab **releases** too — alongside your local tags: read the
  notes, the Latest badge, and asset links (open in browser), and **publish**, **edit**,
  and **delete** releases, **upload** files as asset links, and remove them (GitLab has no
  draft/pre-release toggles — it picks the latest release itself). The repository menu
  speaks GitLab too — **View on GitLab**, **star / unstar**, a **Fork on GitLab** link,
  and "Create issue on GitLab" — and you can **publish a local repository to GitLab**:
  the publish dialog (and the sync bar's Publish button) now offers **GitHub or GitLab**
  when both CLIs are signed in, creates the project, adds it as `origin`, and pushes.
  **Insights** rounds it out: the local-git charts always worked, and the CI card now
  charts **GitLab pipeline durations and success rate** (the GitHub-only cards —
  community, traffic, dependencies — hide, with GitLab's web-only analytics linked
  instead). GitHub repositories are
  completely unaffected.
- **Self-managed GitLab.** Everything above now works on your own GitLab instance,
  not just gitlab.com — sign `glab` in to the host (`glab auth login --hostname …`)
  and GitDesktop recognizes repositories on it automatically, labels them
  correctly ("View on GitLab"), and routes every read and write through your
  per-host `glab` credentials.
- **GitLab issue lock, move, and delete.** The issue view's "More actions" menu now
  works on GitLab: **lock / unlock** the conversation (GitLab locks without a
  reason, so there's no reason submenu), **move** the issue to another project you
  have access to (with project suggestions; the original closes with a "moved"
  marker), **duplicate** it, and **delete** it (Owner-only, type-to-confirm).
- **GitLab project settings.** The repository-settings dialog now manages GitLab
  projects end to end: **General** (description, topics — AI-generate works here
  too — default branch, per-feature access levels with proper
  everyone/members-only/disabled tri-states, merge method, squash policy, and the
  merge checks), **Members** (add/re-role/remove by username, with inherited group
  members shown read-only), **Webhooks** (create/edit/delete with per-event
  triggers and a secret token, send a test event, and debug with the **delivery
  log** — request/response payloads and one-click **re-send**), **CI/CD
  variables** (add/edit/delete, protected and masked flags), and the **Danger
  zone** (rename with path redirect, archive/unarchive, visibility, transfer to
  another namespace, delete — Owner-only actions explain themselves when you're
  a Maintainer). Gated by your actual GitLab role, straight from the repository
  menu.
- **GitLab protected branches.** Manage protected branches from repository
  settings: protect a branch or wildcard with per-rule push/merge access levels
  and a force-push policy, toggle force push in place, and unprotect — rules
  inherited from a group show read-only.
- **GitLab issue due dates and confidential issues.** Two GitLab-unique fields
  in the issue view's side rail: a **due date** (type a date and press Enter or
  pick from the calendar; one click clears it, and an open issue past its date
  reads **Past due**) and a **confidential** toggle that hides the issue from
  non-members. GitLab-only — the rail on GitHub repositories is unchanged.
- **A browsable, persistent Agent sidebar.** Several quality-of-life upgrades to the Agent list:
  the **activity log now survives a restart** — reopening the app no longer drops a session's,
  plan's, or research run's **step-by-step tool log** (the full interleaved transcript of reads,
  edits, commands, and web is persisted, not just the flat prose). Every entry now carries a
  **GitHub-style `#N` identifier** (a stable, global number) shown on its row, so an entry can point
  at what it became — a research run shows the plan it turned into (*Turned into plan #12*), and a
  plan shows the session that implemented it (*Implemented · Ready to review #10*). Each row also shows its
  **provider · model** (e.g. `Codex · gpt-5`) for browsing by agent, and **right-clicking a row**
  opens a context menu of its actions — Open, Resume/Keep/Discard a session, Save/Copy/Turn-into-Plan
  a research report, jump from a plan to its session or file it as a local issue, and so on.
- **See every step the agent takes — now with inline diffs.** The agent surfaces (Delegate, Plan,
  Research) show the agent's work as one **step-by-step transcript** — each file it reads, edits,
  searches, command it runs, and page it fetches, interleaved with its narration in the order it
  happened (the way Claude Code and the VS Code agent read). In a write **session** you can now
  **expand any edit step to see that file's diff inline** — the file's cumulative change in the
  session, syntax-highlighted, without leaving the conversation. (Read-only Plan and Research don't
  edit, so their steps stay informational.)
- **Research mode — Brainstorm & Deep research.** A new read-only, web-enabled agent mode in the
  **Agent** tab, sitting upstream of Plan. **Brainstorm** surveys the web and your repo and surfaces
  several distinct directions with prior art; **Deep research** investigates one direction in depth
  and streams a **cited** report — rendered right in the app, never bounced to an external editor.
  The two are **one switchable mode**, not separate sessions: start in Brainstorm to widen your
  options, then **switch to Deep research from the follow-up composer** to flesh out the direction
  you chose — the whole conversation carries over (just like switching a model mid-session). When
  you're happy, hand a report **straight to Plan** or **save** it as a local Markdown file (written
  to `.gitdesktop/research/` for you to review and commit — never committed automatically). Keep
  refining with follow-up messages; several runs go side by side. Read-only throughout: it searches
  and reads, but can never write. Runs on **any agent** — Claude, Codex, GitHub Copilot, or
  opencode — each using its own native web search and fetch (opencode's web *search* needs its Exa
  integration enabled; web *fetch* always works).
- **Custom & LAN AI servers, with an allowed-hosts list.** You can now point GitDesktop at an
  Ollama (or any OpenAI-compatible) server running on **another machine on your network** — not
  just `localhost`. Set the server's URL under **Settings → AI** (now available for the review
  model too, not only generation), then allow its host in the new **Allowed hosts** list — or
  just click **Allow host** on the inline prompt that appears when you enter a URL that isn't
  permitted yet. Built-in providers and `localhost` are always allowed; everything else must be
  on your list, which is the gate the app enforces before every AI request — so a typo or a
  compromised page can't quietly reach an arbitrary server.
- **Advanced merge tooling.** The **Merge into current** picker now **predicts the merge before
  you run it** — a calm status line shows *fast-forward*, *already up to date*, *clean merge*, or
  *which files will conflict*, computed in memory with `git merge-tree` (it touches nothing). Two
  options join it: **Always create a merge commit** (`--no-ff`), and an **On conflict** strategy —
  *Stop and let me resolve* (default), *Prefer current branch* (`-X ours`), or *Prefer incoming
  branch* (`-X theirs`) — that auto-resolves conflicting hunks in one side's favor, clearly
  cautioned that the other side's conflicting changes are dropped (and the preview then reframes to
  "N files auto-resolved"). Degrades quietly on older git. GitHub Desktop has none of this.
- **Interactive rebase — "Edit history".** A new **Edit history…** item in the History
  context menu opens an editor over your unpushed commits where each commit gets a per-row
  action — **pick**, **reword**, **squash**, **fixup**, **edit**, or **drop** — plus **↑/↓
  reorder** and inline message editing (reword loads the full original message and can regenerate
  it with AI). A live "Result: N commits" footer shows what you'll end up with. Edit-free plans
  run the **atomic** conflict-safe replay engine (any conflict rolls everything back untouched).
  Choosing **edit** instead starts a real, resumable rebase that **pauses at that commit so you
  can amend its contents** — the Changes banner reads "Rebase paused — amend… then Continue", you
  amend with the normal stage/commit flow, and Continue/Abort finish it (conflicts on this path
  are resolvable, not rolled back). It refuses a dirty tree, merge commits, or already-pushed
  history. The quick **Squash N commits…** multi-select shortcut stays; the standalone Reorder
  dialog is folded into the editor. GitHub Desktop has no equivalent.
- **GitHub Enterprise support.** GitDesktop no longer assumes `github.com` — every GitHub
  feature runs through `gh`, which detects each repository's host from its remote, so an
  Enterprise Server repo (`github.acme.com`) gets the same pull requests, issues, Actions, and
  repository-settings features once you've signed in with
  `gh auth login --hostname your.github.example`. **Settings → Accounts** now groups signed-in
  accounts by host and switches the active account **per host** (a single-host user sees the same
  flat list as before); author avatars, profile links, and the `gh auth refresh` scope hints all
  resolve on the repo's actual host. Unlike GitHub Desktop, no separate Enterprise sign-in flow —
  it follows whatever hosts you've added to `gh`.
- **Auto-fetch (background sync).** GitDesktop now keeps the open repo's view of its remote
  current on its own: an opt-out periodic background `git fetch` (Settings → General; on by
  default, every 5 / 10 / 15 / 30 / 60 minutes) runs while the window is focused, plus once when
  you return to the app or open a repo and it's been at least one interval. It's quiet — no
  toasts, the Fetch button just spins, and its tooltip shows when the repo was last fetched. It
  only updates remote-tracking refs, so the behind-count and incoming commits stay fresh **without
  ever pulling, merging, or touching your files** — pushing and pulling stay manual.
- **Conflict resolution, in-app.** Selecting a conflicted file no longer shows an empty pane —
  it opens a **conflict editor**: the file rendered with each conflict region called out as
  **Current (ours)** over **Incoming (theirs)**, with **Accept current / Accept incoming /
  Accept both** on every region, or whole-file **Accept all current / Accept all incoming** and
  **Open in editor** in the header. Resolve as granularly or as bluntly as you like; the file is
  marked resolved automatically once the last conflict is gone. Works with AI off.
- **AI conflict resolution.** The same editor's **Resolve with AI** asks your model to merge a
  file: it streams a proposal you review **as a diff** against your side (flip to the full
  proposed file or the *ours* / *theirs* / *base* versions), then **Accept & stage** applies it —
  nothing is written until you accept; **Regenerate** retries, **Discard** drops it. The conflict
  banner's **Resolve all with AI** walks every conflicted file in turn. It uses your configured
  **Review** model, so it runs on any provider including local Ollama and keyless Claude Code /
  Codex agents, honors your AI ignore patterns, and is hidden entirely when AI features are off.
  Unlike GitHub Desktop's Copilot-only equivalent, there's no subscription or sign-in lock-in.
- **Worktree manager.** A new **Worktrees…** dialog (repository ⋯ menu, or the command
  palette) lists the repo's linked worktrees and lets you **create** one (a new branch
  from any base, or an existing branch, checked out into its own folder), **open** one to
  switch the active repository to it, **rename** one, **lock / unlock** one (with an optional
  reason, to guard it from accidental removal — handy for a worktree on a removable or network
  drive), and **remove** one safely (the branch is kept; a worktree with uncommitted changes
  asks before force-removing). A **Repair links** action re-connects worktrees after you've
  moved or renamed the repository folder. The **branch
  switcher** is worktree-aware too: a branch already checked out in another worktree is
  badged, and selecting it offers to open that worktree instead of failing. Worktrees let
  you work on several branches at once without stashing or switching, and the ones AI agent
  sessions use internally stay hidden and protected — you can't list, rename, or delete them
  by accident.
- **Use GitDesktop as an MCP server.** GitDesktop can now *be* a Model Context Protocol
  server, not just consume them. A new **Use GitDesktop as an MCP server** panel in
  **Settings → MCP servers** shows a ready-to-paste config snippet that points any external
  MCP client — Claude Desktop, Cursor, Claude Code — at this repo. The app runs as a
  **read-only** stdio server (`gitdesktop mcp --repo <path>`) exposing ~20 git & GitHub tools
  (status, log, diffs, blame, branches, file history/read, PRs, issues, CI logs), so an agent
  can *understand* a repository without changing it.
- **MCP servers for agent sessions (Claude, host).** A new **Settings → MCP servers**
  panel lets you register Model Context Protocol servers — local (stdio) or remote
  (HTTP), with environment variables / headers and **secrets kept in your OS keychain**
  — and a new **MCP** picker in the agent composer opts a session into the ones you
  choose. A Claude session passes *only* the servers you picked, in strict mode, so a run
  never inherits other MCP servers on your machine; with no servers registered, nothing
  changes. Don't have any yet? **Browse** opens the official Model Context Protocol
  registry right in the panel — search it and add a server in a click. Each result shows
  signals to **vet a server before adding it**: GitHub **stars** and activity, weekly **npm
  installs**, deprecation status, the source repo, and — expanded — exactly **what it runs
  or connects to** and which secrets it needs. Browse has two sources you can toggle
  between — the **official registry** and **GitHub** (repositories tagged `mcp-server`,
  ranked by stars, with the same vetting signals; ones with a manifest add cleanly, others
  arrive marked *needs setup*). Added servers still land disabled for review.
  Already have servers set up? **Import** pulls them in from the open repo's
  `.mcp.json` or your global Claude config — reviewed, started disabled, with any secret
  values moved to your keychain (the source files aren't touched). Each server is **scoped
  Global or to a specific repo** (import sets this from where it came from), so a repo's
  servers only show up in that repo's sessions and the registry stays tidy. And a shared
  **global server can be tuned per repo** — set it **On**, **Optional** (available but off
  by default), or **Off** for the repo you're in, or leave it on **Default** to follow the
  global setting. ([design](docs/mcp-agent-sessions-tier1.md).)

- **MCP servers for Codex (container sessions).** Codex agent sessions can now use your
  registered MCP servers too — in **container** isolation. (Host Codex can't approve MCP
  tool calls non-interactively — an upstream limitation — but a container session bypasses
  approvals safely because the container *is* the sandbox.) The composer's **MCP** picker
  now appears for Codex and tells you to switch to container isolation if you're on host;
  it offers **local (`stdio`) servers** (Codex's remote-MCP config can't carry the arbitrary
  headers our HTTP servers use). Your picks are written into the session's sandboxed Codex
  config — secrets stay in the OS keychain, never in the command line — and, because a
  container's Codex home is clean, the session sees *only* the servers you picked.

- **MCP servers for Copilot and opencode (host sessions).** Your registered MCP servers
  now work on **GitHub Copilot** and **opencode** host sessions too — alongside Claude on
  the host and Codex in a container. The composer's **MCP** picker appears for both (local
  `stdio` *and* remote HTTP servers), and your picks are handed to the CLI for that session
  only — secrets stay in your OS keychain, never on the command line. Both CLIs approve the
  servers' tools automatically, so a non-interactive run never stalls on a prompt; Copilot
  and opencode layer your picks onto their own config, while Claude alone runs in strict,
  only-these mode.

- **MCP servers in container sessions, for every agent.** Your registered MCP servers now
  work in **container** isolation for **Claude**, **Copilot**, and **opencode** too — not
  just Codex. Each session's picks are written into the agent's config *inside* the sandbox
  (secrets stay in your OS keychain, never on the command line), so the servers run in the
  container alongside the agent. A shared **npm cache** means an `npx`-based server is
  downloaded once and reused across turns and sessions instead of re-fetching every run.
  You pick servers from the composer the same way whether a session runs on the host or in
  a container. (Tip: a Claude server takes a few seconds to connect inside a fresh
  container, so the very first thing in a turn may not see it yet — it's there once the
  agent gets going.)

- **Change a session's MCP servers mid-conversation.** The composer's **MCP** picker now
  appears on an active session too, not just a new one — toggle servers on or off and the
  new selection applies from your next turn (and survives a reload).

- **MCP servers in best-of-N runs.** The composer's **MCP** picker now appears in best-of-N
  mode too — your selection is **shared across every arm**, so each agent attacks the task
  with the same tools (a fair comparison). Each arm automatically drops any server its own
  agent or isolation can't use.

- **GitHub Pages config, in the app.** A new **Pages** tab in repository settings: enable
  Pages from a branch + folder or via **GitHub Actions**, see the live URL and build
  status, change the source, set a **custom domain**, **enforce HTTPS**, and disable the
  site. Part of the org/repo governance buildout.

- **Branch rulesets, in the app.** A new **Rules** tab in repository settings manages
  GitHub's modern branch rulesets: list them, flip **enforcement** (Active / Evaluate /
  Disabled) right from the list — including the **reversible "disabled" soft-off** that
  keeps the ruleset instead of deleting it — and create or edit one with a focused editor
  (target branches, require a PR with approvals / code-owner review / stale-dismissal,
  require status checks, block force pushes, restrict deletions, require linear history,
  require signed commits). Editing preserves any advanced rules the editor doesn't
  surface, and org-level rulesets show read-only. Part of the org/repo governance
  buildout ([docs](docs/github-governance-expansion.md)).

- **Repository danger zone, in the app.** The General tab of repository settings gained a
  **Danger zone**: **rename**, **archive / unarchive** (reversible), **change visibility**
  (public / private / internal), **transfer ownership**, and **delete** the repository.
  The three irreversible actions (visibility, transfer, delete) are each behind a
  type-the-`owner/repo`-name confirmation that spells out the consequences first. Deleting
  detects when your `gh` sign-in lacks the `delete_repo` scope and shows the exact
  `gh auth refresh` command to run. Your local clone is never touched. Part of the
  org/repo governance buildout ([docs](docs/github-governance-expansion.md)).

- **Code security & analysis toggles, in the app.** A new **Security** tab in repository
  settings collects secret scanning (and its **AI-detection** and **non-provider-pattern**
  sub-toggles), push protection, code scanning (CodeQL default setup), Dependabot alerts
  and security updates, and private vulnerability reporting behind a **save/discard bar**
  — flip what you want and save once (changes apply in the right dependency order). On
  private repos it notes which features need GitHub Advanced Security. **Dependabot
  version updates** — which GitHub only configures through `.github/dependabot.yml` — gets
  a **scaffold**: pick your package ecosystems and schedule and it writes the file to your
  working tree for you to commit (it won't overwrite an existing one). The remaining
  API-less options (dependency graph, grouped security updates, self-hosted runners)
  appear as **"Manage on GitHub"** links rather than dead toggles.

- **Manage repo collaborators & invitations, in the app.** A new **Access** tab in
  repository settings lists your collaborators with their role, lets you **invite**
  someone by username at any level (Read / Triage / Write / Maintain / Admin), **change**
  a collaborator's role inline, and **remove** them — plus a **pending invitations** list
  you can re-role or cancel. (Removing someone revokes only their direct access; team/org
  access is managed at the org level, coming later.) Part of the org/repo governance
  buildout ([docs/github-governance-expansion.md](docs/github-governance-expansion.md)).

- **Edit the Sponsor button, in the app.** A new **Sponsor** tab in repository settings
  edits `.github/FUNDING.yml` — the file that powers your repo's **Sponsor** button —
  with fields for GitHub Sponsors, Patreon, Open Collective, Ko-fi, Liberapay, Buy Me a
  Coffee, Polar, Tidelift, and custom URLs. Saving writes `.github/FUNDING.yml` to your
  working tree — review and commit it like any other change to publish; one click removes
  it. (GitHub has no API for the "Sponsorships" *feature* toggle, but it's on by default —
  the file is what matters, which is why this is the right lever.)

- **Manage GitHub secrets & variables, in the app.** A new **Secrets & variables** tab
  in repository settings lists and edits **Actions, Dependabot, and Codespaces secrets**
  and **Actions variables**, at **repository or environment** scope. Secret values are
  encrypted on your machine before they're sent (GitDesktop never handles the raw
  encryption), and — as on GitHub — can't be read back, only replaced or removed; a
  reused name updates the existing variable. Part of the broader org/repo governance
  buildout ([docs/github-governance-expansion.md](docs/github-governance-expansion.md)).

- **More GitHub repo settings, in the app.** The repository-settings dialog gained a
  **template repository** toggle, **default squash/merge commit message** pickers, and
  an **allow forking** toggle (shown only on org-owned private repos, the one place
  GitHub lets it change) — plus an **"Only on GitHub"** list that deep-links the five
  settings GitHub exposes to no app (sponsor button, commenting on commits,
  LFS-in-archives, per-push branch/tag limit, auto-close issues on merge), so they're
  discoverable instead of silently missing. This is the first slice of a broader
  org/repo governance plan ([docs/github-governance-expansion.md](docs/github-governance-expansion.md));
  the app can now also read your `gh` token's OAuth scopes, groundwork for features that
  prompt for the exact `gh auth refresh -s <scope>` they need.

- **More of your git config, editable in the app.** Settings → **Git** gained two
  controls that write straight to your global git config: **line endings**
  (`core.autocrlf`) — with a note on the right choice per OS — and, when a repository
  is open, a **per-repository identity override** (`git config --local user.name` /
  `user.email`) so you can commit as a different author in just that repo without
  touching your global identity. The override clears back to the global identity with
  one click, and both apply immediately. They join the global identity and
  default-branch fields already in that panel.

- **Integrated terminal.** Every agent session gained a built-in terminal — toggle it
  with the terminal hotkey (`Ctrl`/`⌘`+`J`) or the **Terminal** button — so you can
  run commands right inside GitDesktop instead of opening a separate window. It's a real
  shell (a PTY) in a resizable bottom dock that keeps running while hidden, so a dev
  server you start stays up. For a **container** session the terminal runs *inside* the
  session's Docker/Podman container — clicking **Terminal** opens a small popover to
  choose which dev-server port(s) to publish *before* it spins up (so a busy host port
  doesn't kill the launch), where you can also **reconnect** to or **stop** a container
  that's still running; for a host session it's a shell in the worktree.

- **Run a task several ways at once (best-of-N).** The Delegate composer gained a
  **Best-of-N** button: run the same task across 2–5 arms, **each with its own agent,
  model, and effort** — mix Claude, Codex, Copilot, and opencode so different providers
  attack the problem from different angles. Each arm runs in its own worktree; review
  them side by side and **keep the best one** with a single click (it discards the
  rest). Because fanning out multiple agents costs real money, a confirmation first
  shows an **upfront estimate** drawn from what your own recent sessions actually cost
  (scaling with the arm count), and the ensemble's **running total** is shown while it
  works. It's opt-in and never the default — best for open-ended tasks with several
  good approaches.

- **Plan a task before you build it.** A new read-only **Plan** mode in the Agent
  surface: describe a task (or start from an existing issue with the new **Plan**
  button on any issue) and a repo-aware agent explores your actual code, then drafts
  an agent-ready issue — problem, proposed approach, affected files, acceptance
  criteria, and a verify plan — **without changing anything**. Cited file paths are
  checked against your repo, so hallucinated references are flagged before you file.
  The planning run's cost is shown when reported. If the plan left any decisions
  open, they appear as an **answerable panel** (modeled on Claude Code's clarifying
  questions): pick from the suggested answers or write your own, and **Refine plan**
  *continues the same planning conversation* with your answers — the agent keeps its
  exploration in context and refines incrementally instead of starting over. A
  **follow-up composer** lets you keep chatting to revise the plan anytime, and the
  whole thing **persists across restarts** — close the app and your plans (and their
  conversation) are right where you left them, still resumable. (Plans are a read-only
  agent conversation: read tools only, no worktree, never a write.) Review it, then
  create a local or GitHub issue from it in one click. Plans live in the **Agent
  sidebar** alongside your sessions and **run several at once** — start one, switch to
  another, and come back; none are lost, and an **OS notification** tells you when each
  one finishes (ready, awaiting your answers, or failed) unless you're watching it.
  Reach it from the Agent tab's "Plan a task" mode, the command palette, or an issue's
  Plan button.
- **Hand a plan or issue straight to an agent.** A finished plan gets an **Implement**
  button that **starts a write-capable session directly** (a quick popover sets the
  agent / model / effort first); any open local or GitHub issue gets **Solve with
  agent** (it's a problem to investigate → diagnose → fix), which seeds the Delegate
  composer to confirm. Either way the agent works in an isolated worktree, the way
  every agent session does. Once a plan is being implemented it becomes a **read-only
  reference** (its row tracks the session's live status), and it **archives to its own
  Archived tab** once that session is accepted. Closes the loop from planning to a
  working change.
- **Bring any OpenAI-compatible provider.** A new "OpenAI-compatible" provider lets
  you point GitDesktop at any OpenAI-compatible `/chat/completions` endpoint with your
  own API key. One-click presets cover the **Vercel AI Gateway** (one key, many
  models), **Google Gemini**, **DeepSeek**, **Mistral**, and **Z.ai** — or type any
  base URL. Live model lists and "Test connection" work just like the built-in
  providers. (A custom host outside the presets must be added to the app's network
  allowlist.)
- **Slash commands _and skills_ in the agent composer.** Type `/` to pick a reusable
  prompt or a skill. The menu pulls together built-in starters (`/review`, `/test`,
  `/fix`, `/explain`, `/refactor`, plus `/clear`); custom commands you define under
  **Settings → Slash commands**; and — tailored to the **selected agent** — its own
  commands and **Agent Skills**, discovered from both the project and your home
  directory, including the shared `.agents/skills` store (so your **global skills**
  show up too), plus a curated set of the CLI's own **built-in commands** (like
  `/init`). Type `/` to browse the whole list — it's scrollable, no narrowing
  needed. Commands support `$ARGUMENTS` (and `$1`, `$2`…) and are expanded in-app
  before reaching the agent; picking a **skill** nudges the agent to use it by name, so
  the CLI loads the real skill (scripts, references and all) instead of pasting it in.
  The menu is keyboard-driven, like `@file` mentions.
- **opencode joins the agent line-up.** You can now drive agent sessions and AI
  reviews with [opencode](https://opencode.ai) alongside Claude Code, Codex, and
  GitHub Copilot — pick it in the agent composer or as a review provider. opencode's
  **free hosted models need no API key**, so it's a genuinely keyless option out of
  the box (point it at your own provider for paid models too). Sessions run on the
  host, confined to their throwaway worktree, and resume cleanly across turns and
  app restarts like the other agents.
- **The window remembers where you left it.** GitDesktop now reopens at the size,
  position, and maximized state from your last session, validated against your
  current monitors so an unplugged display can't strand it off-screen. Settings →
  About also gained a live readout of the window's current position, size, and
  display, with a button to copy the coordinates.
- **Watch an agent session work, live.** The Changes tab now reflects the worktree's
  uncommitted edits *as the agent makes them*, before each turn's checkpoint commit
  — so you can follow along instead of waiting for the commit to land.
- **Test a session's changes before you keep them.** Every active session gained an
  **Open** menu — open its worktree in your editor, a terminal, or the file manager and
  run it for real before you Keep or Discard. The worktree is a full checkout on the
  session's branch, isolated from your working tree. For a **container** session, whose
  dependencies were installed for Linux, the live shell is the integrated **terminal**
  (above) — a shell *inside* the same image with the worktree mounted, so `pnpm install`
  and running it happen in the matching environment rather than failing against
  host-incompatible deps; that's where you choose the dev-server ports to publish and
  reconnect to or stop a still-running container. Keeping or discarding the session
  shuts its test container down for you.
- **Promote a kept session to a local PR.** A kept agent session gained a **Create
  PR** button (and command-palette action) that opens a local pull request from its
  branch, prefilled and ready — a one-click hand-off from "agent finished" to review.
- **See a session's pull-request and merge state on its row.** Agent session and plan
  rows now show a pull-request audit chip — **PR open**, **PR closed**, or **Merged** —
  derived from the session branch's local *and* GitHub pull request, so you can tell at
  a glance whether the agent's work actually landed. An implemented plan reads
  "Implemented · Merged" once its session's PR is merged. Merge status is read from the
  pull request itself (not `git merge-base`), so it stays correct through squash and
  rebase merges, including a local PR you've promoted to GitHub.
- **opencode runs in the container sandbox too.** opencode joins Claude and Codex as
  a container-isolated agent (kernel-enforced filesystem confinement) — add it under
  Settings → AI → agent image and rebuild. Its free hosted models need no key, so the
  container runs keyless.
- **Deeper opencode reviews.** Turn on "Read repo files for context" for an opencode
  review and it explores surrounding files (via opencode's read-only plan agent — it
  can read but never write), not just the diff.
- **GitHub Copilot runs in the container sandbox too.** Copilot joins Claude, Codex,
  and opencode as a container-isolated agent — add it under Settings → AI → agent
  image and rebuild. Copilot has no credentials file to mount (its login lives in the
  OS keychain), so its container authenticates from your GitHub CLI token (`gh auth
  token`), passed securely by environment — never written to disk or visible in the
  container's arguments.
- **Deeper Copilot reviews.** "Read repo files for context" now works with Copilot
  too: it reads surrounding files for context while a hard deny on the write and shell
  tools keeps it strictly read-only, even when reviewing in your live repo.
- **Global skills reach container sessions.** A container-isolated agent session now
  mounts your global skills (`~/.agents/skills`) read-only, so a skill invoked by name
  resolves inside the container just as it does for a host session — previously only
  skills committed to the repo were visible there.
- **AI re-reviews build on GitLab bot findings.** When you re-review a GitLab merge
  request, GitDesktop now folds in what third-party AI reviewers (CodeRabbit, Copilot,
  and the like) already flagged in the MR discussion — the same "build on external
  reviews" context it has offered on GitHub — so the model doesn't re-report findings
  another tool already raised. Bitbucket has no equivalent bot-review ecosystem, so it
  stays out of this path.
- **Provider-aware AI prompts.** AI review, summary, and commit-message prompts now speak
  the host's vocabulary — "merge request" on GitLab and Bitbucket, "pull request" on
  GitHub — and use each platform's markdown flavor, and release-notes generation no
  longer shells out to the GitHub CLI on a GitLab or Bitbucket repository.
- **Agentic PR review.** When your review model is a CLI agent (Claude Code, Copilot CLI,
  or opencode), turn on **Agentic review** and GitDesktop attaches itself to the run as a
  read-only MCP server: the reviewer pulls the full PR diff (past the prompt's truncation
  budget), reads any file at any ref, runs blame and history, and reads the PR's existing
  comments — reporting what it explores live in the status line. It's read-only end to end
  (no write tools, no repo changes), and after a run whose diff outgrew the prompt budget
  the panel nudges you to enable agentic review or switch to a CLI agent model for full
  coverage. Codex reviews explore the repo natively but can't attach the GitDesktop tools.
- **AI reviews are clearly machine-authored.** Every AI-posted review now carries a
  branded GitDesktop header and footer, and AI comments on a local PR show a "GitDesktop"
  bot author with a robot avatar. On GitLab, add a project or group access token in
  **Settings → Accounts** and AI reviews post as the real GitLab project bot instead of
  your signed-in account.
- **AI Generate proposes labels.** The **Generate** button in the Create pull request
  dialog now also suggests labels alongside the title and description, chosen only from
  the repository's existing labels and **added** to your current selection (it never
  invents a label).
- **Apply suggested changes locally.** Apply a reviewer's suggested change to
  your working tree straight from the review thread on a GitHub PR — GitDesktop's
  local answer to GitHub's *Commit suggestion*, which has no public API. The edit
  is verified against the file first (refused if the code has drifted), keeps the
  file's line endings and BOM, and is staged when the file had no other local
  changes (otherwise applied unstaged, with a note). Disabled with a reason when
  the thread is outdated or a branch other than the PR's head is checked out.
- **Blame and file history from any file list — not just the Changes panel.** Right-click a
  file row in a commit's file list (in History, or a PR's Commits tab), in a pull request's
  Files tab, or in a Compare / local-PR file list, and you now get **View file history…** and
  **Blame…** — the same actions the Changes panel already had. On those surfaces Blame is
  pinned at that commit or branch, so you see the file *as of* that revision. A new **Blame
  file…** command in the palette opens a fuzzy picker of every tracked file (arrow-key
  navigable) and blames the one you choose.
- **Clean up stale branches in bulk.** A new **Clean up branches…** action in the
  branch switcher (and command palette) gathers stale local branches — merged into
  the default branch, or with no commits in the last 30/60/90 days — and lets you
  **archive** them (reversible) or **delete** them together after reviewing and
  trimming the list. The current branch, the default branch, and protected
  branches are never included.
- **Collapse the Local and remote sections of the pull-request and issue lists.**
  Click a section header to fold that section away; the header keeps a count of the
  hidden rows so nothing gets lost, and the choice is remembered across restarts.
- **Comment on a PR's commits.** A commit's detail view carries a whole-commit comment
  thread plus line-anchored comments on its diff — create, edit, and delete your own,
  applied optimistically — on GitHub, GitLab, and Bitbucket pull requests.
- **Bitbucket PR reviewers who've acted now show as completed chips.** On a Bitbucket
  pull request, participants who have approved or requested changes now appear as
  read-only completed-reviewer chips carrying their verdict, and drop off the
  pending-request list so they no longer double-render as still-pending.
- **GitLab MR reviewers who've acted now show as completed chips.** On a GitLab merge
  request, reviewers who have approved or requested changes now appear as read-only
  completed-reviewer chips carrying their verdict, and drop off the pending-request list
  so they no longer double-render as still-pending.
- **See finished reviewers in the PR Reviewers section.** The Reviewers rail now shows
  reviewers who've already reviewed as read-only chips carrying their verdict — a check for
  approved, an X for changes requested, a speech bubble for commented — so a completed
  review (including **Copilot**'s) stays visible after the reviewer drops off the
  pending-request list. State is conveyed by icon shape plus the word, never color alone.
- **Copy CI logs.** Job logs and failed-step logs in the **Actions** panel, and the inline
  log peek on a pull request's **CI checks**, now carry a copy button in the log's top-right
  corner — grab the whole log with one click to paste into an issue, a chat, or an agent.
- **Delete a remote-only branch from the switcher.** Branches in the branch switcher's
  **Remote** section now have a **Delete on origin…** action that deletes the branch on its
  remote for everyone. It's a confirmed, server-side delete that can't be undone from the
  app, and protected branch names are blocked from it.
- **Edit and delete your own comments** on GitLab merge requests and issues, and
  on Bitbucket pull requests — including comments inside inline review threads —
  the same inline editor and delete confirmation that GitHub comments already had,
  now wired to each provider's native commands.
- **Fork repos are marked in the repository lists.** A repo that's a fork on its provider
  now shows a fork glyph beside the public/private badge in both the repo switcher and the
  welcome screen's Repositories list. The glyph carries a "Fork of &lt;owner/repo&gt;" label
  (or just "Fork" when the upstream isn't known), so its meaning isn't conveyed by shape
  alone. Like the visibility badge, it resolves in the background and clears if the remote
  goes away.
- **Edit GitHub PR assignees.** Assignee editing on an open pull request now works on
  **GitHub** too, reaching parity with GitLab merge requests — pick assignees from the
  same rail affordance in the PR view.
- **Commit-author avatars in History.** The History log, commit detail, and
  file-history views now show each author's avatar — derived from GitHub or
  Gravatar, falling back to their initials.
- **Commit comments from the History tab.** Open any pushed commit in History and
  comment on it straight away — a whole-commit thread plus **line-anchored
  comments** (click or drag line numbers to anchor them) — on GitHub, GitLab, and
  Bitbucket. An unpushed commit shows a push hint, and local-only repos are
  unchanged.
- **Agentic review now works with API review models.** Beyond the CLI agents, turning on
  **Agentic review** with an HTTP/API model (Anthropic, OpenAI, OpenAI-compatible,
  OpenRouter, or Ollama) gives it a native read-only tool loop: it pulls the full PR diff
  past the prompt budget, reads any file at any ref, searches the repo, and runs history
  — reporting what it explores live in the status line. There's no review workspace
  to prepare, so these reviews start instantly, and it's read-only end to end. Each tool
  step is an extra model call (slower and pricier), and small local models that can't do
  tool calling fail with a clear message to turn agentic off or pick another model.
- **Inline review comments.** Line-anchored review comments — from Copilot,
  CodeRabbit, or humans — on GitHub PRs, GitLab MRs, and Bitbucket PRs now render
  in the app: grouped by file in the Conversation tab and anchored at their exact
  line in the Files diff (unified or split), with reply-in-thread and
  resolve/unresolve. GitHub threads show the anchored code excerpt they were left
  on, reviewer suggestions render as labeled change diffs, and any thread can be
  copied as Markdown (line range, excerpt, and every reply). Resolved threads
  collapse behind a per-file expander, and outdated ones are flagged.
  Previously they were invisible (GitHub) or shown as context-free flat
  comments (GitLab/Bitbucket).
- Jira issues now show agile fields — **story points** (in the list and the detail),
  **sprint**, a clickable **epic / parent**, **components**, and **fix versions** —
  discovered automatically per site, with nothing to configure.
- **Jira issue writes.** Create, comment on, close/reopen (following the project's own
  workflow, with the real resulting status named in the confirmation), and assign Jira issues right
  from the Issues tab of a linked Jira Cloud project. Each action is gated on your Jira
  permissions — anything your token and role can't do stays hidden.
- **Linked Jira Cloud projects.** Connect a Jira site and project to any repository and
  browse its issues (status, type, priority, assignee, labels, Markdown description, and
  comments) from the Issues tab, with View-in-Jira link-outs. Bitbucket repos get a
  one-click path, since Bitbucket's native issue tracker retires 2026-08-20. Read-only for
  now; connect with an Atlassian API token (or reuse an existing Bitbucket credential).
- **Jira issue links, promote-to-Jira, and agent access.** The linked project's issue keys
  (e.g. `PROJ-123`) are now spotted in the current branch name, a commit's message, and a PR's
  title/description, and surfaced as a compact "referenced Jira issues" row that jumps to the
  issue in the Issues tab. A local issue can be promoted to Jira (alongside GitHub or GitLab
  when both are available) — its comments carry over and the local one closes with a back-link.
  And agents connected through GitDesktop's MCP server get `jira_*` tools to list and read the
  linked project's issues, plus comment, close/reopen, create, and assign behind the
  `--allow-remote-write` opt-in. The status chip in the Jira issue view is now also a menu
  (when your permissions allow transitions) for moving an issue to any of its workflow's
  available statuses, alongside the existing close/reopen quick action.
- **Edit more of a Jira issue.** Set or clear a **due date**, change the **priority**, edit
  the **labels**, and **edit or delete your own comments** — all from the Issues tab of a
  linked Jira Cloud project, and each control gated on your Jira permissions so anything your
  token and role can't do stays hidden. Agents reach the same edits through the MCP server's
  new `update_jira_issue` tool (due date, priority, labels) under the `--allow-remote-write`
  opt-in.
- **Jira time tracking.** On a linked Jira Cloud project that has time tracking enabled, the
  issue view now shows the original estimate, remaining, and time spent with a progress bar.
  Log work with Jira's duration grammar (`2d 4h 30m`) and an optional note, set or clear the
  original and remaining estimates, and edit or delete your own worklog entries — the full
  history is a "View all in Jira" link away. Agents get a `jira_log_work` MCP tool and
  original/remaining-estimate parameters on `update_jira_issue`, both behind
  `--allow-remote-write`.
- **Resolve local-PR merge conflicts without touching your working tree.** When a local
  pull-request merge hits conflicts, GitDesktop now runs the merge in an isolated,
  hidden worktree — your branch and working tree stay exactly as they were, so you never
  need a clean tree (unless you're merging into the branch you're currently on). The PR
  view opens a dedicated resolve surface with the conflicted files and the in-app conflict
  editor (per-region accept + AI resolution), then **Finish merge** (commit + mark the PR
  merged) or **Abort** (throw the merge away). The PR also pre-shows whether a merge will
  conflict before you start.
- **Local PR activity feed.** A local PR's Conversation is now a date-sorted activity feed
  too: it opens with a **created** marker, interleaves the branch's pushed commits (grouped,
  each short SHA clickable to that commit's detail) with your comments, and ends with a
  **merged** or **closed** marker once the PR reaches that state.
- **GitHub Discussions tools for GitDesktop's MCP server.** When run *as* an MCP server
  against a GitHub repo, an agent can now browse discussions: **list categories**, **list
  discussions**, and **read a full thread** with its nested replies (always-on reads). With
  `--allow-remote-write` it can also **create** a discussion in a category, **comment** on
  one, **mark/unmark a reply as the answer**, and **close or reopen** a discussion — under
  your authenticated `gh` identity, with a **Posted by GitDesktop** footer on posted
  comments. Discussions are a GitHub feature, so these tools return an actionable error on a
  GitLab or Bitbucket remote.
- **Full PR/issue forge-write surface for GitDesktop's MCP server.** The
  `--allow-remote-write` tools now go well beyond commenting: an agent can create, merge,
  update, and close/reopen a pull request, toggle its draft state, request reviewers, edit
  labels, set assignees (on issues and PRs), approve or withdraw approval, reply to and
  resolve review threads, rerun/cancel/dispatch CI, and create or update releases — all
  under your authenticated forge identity (GitHub `gh`, GitLab `glab`, or a stored Bitbucket
  token). New read tools round it out: list labels, milestones, and releases, get a release,
  list assignable users, and fetch a PR's full timeline. It stays gated behind the same
  `--allow-remote-write` opt-in, off by default.
- **AI generation recipes over MCP.** GitDesktop's MCP server exposes three ungated
  `generate_commit_message`, `generate_pr_description`, and `generate_branch_name` tools that
  hand a connected agent the *same* fully assembled context and prompt the in-app AI features
  build — the staged or branch diff with GitDesktop's low-value-file budgeting, recent commit
  subjects as a style reference, your repo and global instructions, and `.aiignore`
  filtering. The tools don't call a model themselves; the agent completes the returned prompt
  with its own inference, so you can trigger GitDesktop's generation from any MCP client.
- **Local-git write tools for GitDesktop's MCP server.** Run *as* an MCP server, GitDesktop
  can now let a connected agent mutate the bound repo's working tree, index, and refs —
  stage/unstage, commit (and undo the last commit), create/checkout/rename branches,
  push/pull/fetch, stash push/pop/apply, merge, rebase, revert, cherry-pick, and tags —
  behind a new `--allow-git-write` flag. A further `--allow-destructive` flag (required *on
  top of* `--allow-git-write`) unlocks the irreversible operations: delete branch, discard
  changes, reset, force-push (with lease), delete a remote branch, drop a stash, and delete a
  tag. Two new read tools — list stashes and preview a merge's outcome — stay ungated. Both
  flags are off by default, and agent-session branches (`gd/session/*`) are refused by the
  branch-mutating tools so an in-flight agent session can never be broken.
- **See and manage your global MCP install per client.** In **Settings → MCP servers →
  Use GitDesktop as an MCP server**, the *Install globally* section now shows a live row for
  **Claude Code** and **Copilot**: whether GitDesktop is installed in that client's user
  config, and whether it points at the current launcher or an older install (with a
  one-click **Reinstall** to switch it over). Each installed client gets a **Remove** button
  that takes the entry back out via the client's own CLI.
- **One-click global MCP install (Claude Code / Copilot).** *Use GitDesktop as an MCP
  server* (Settings → MCP servers) can now install `gitdesktop` into a client's **global
  user config** — available in every project, no per-repo `.mcp.json` — alongside the
  existing project `.mcp.json` write. **Claude Code** and **Copilot** each get a one-click
  button that runs the client's own CLI (`claude mcp add-json … -s user` /
  `copilot mcp add …`), using a project-aware `--repo` so the single global entry follows
  whatever repo the client opens. The read-only/local-write/remote-write toggles carry over,
  and an existing entry is replaced only after you confirm.
- **See which permission tier your global MCP install runs.** In **Settings → MCP servers →
  Use GitDesktop as an MCP server**, each *Install globally* row (Claude Code / Copilot) now
  reads out the installed entry's permission tier — e.g. *Installed (local + remote writes)*,
  or *Installed (read-only)*. When the installed permissions no longer match the checkboxes
  you've selected, the row switches to a warning and offers **Reinstall** to apply them, so a
  stale global entry can't keep running old flags unnoticed.
- **MCP: fetch a CI job's full log.** GitDesktop's built-in MCP server gains a
  `workflow_job_logs` tool that returns a single CI job's complete log by job id (from a
  run's `jobs[].id`) — the whole job's output, not just its failed steps — so an agent can
  drill from a run's jobs into any one job's logs (GitHub Actions and GitLab CI).
- **Local-issue tools for GitDesktop's MCP server.** Alongside the existing local-PR tools,
  the `--allow-write` opt-in now also lets a connected agent create a local issue, comment on
  one, and set its status — GitDesktop's own app-data issue records for the bound repo,
  nothing pushed to a forge. New ungated read tools list and get local issues (and list/get
  local PRs), so an agent can read the app's local review artifacts without any write opt-in.
- **One-click "add `gitdesktop` to PATH."** *Use GitDesktop as an MCP server* (Settings →
  MCP servers) now has a **Command-line launcher** with an **Add to PATH** button, so the
  bare `gitdesktop mcp …` command resolves in any terminal without a hardcoded path or
  `GITDESKTOP_BIN`. It appends the app to your user PATH on Windows (no admin — open a new
  terminal afterward) or symlinks `gitdesktop` into `~/.local/bin` on macOS/Linux, shows
  whether it's already on your PATH, and **Remove** reverses exactly what it added.
- **AI generation recipes are now also MCP prompts.** GitDesktop's MCP server exposes its
  commit-message, PR-description, and branch-name generation recipes as native MCP prompts
  (`commit-message`, `pr-description`, `branch-name`) — the slash-command-like primitive many
  clients surface — alongside the existing recipe tools. Each assembles the *same* fully
  prepared context and prompt the in-app AI feature builds and hands it to the client's own
  model to complete. The prompts are read-only and always available, with no opt-in flag.
- **Cross-forge PR/issue/CI tools for GitDesktop's MCP server.** When run *as* an MCP
  server, GitDesktop's pull-request, issue, and CI tools now work across GitHub,
  GitLab, and Bitbucket — routed through the forge abstraction, they dispatch by the
  repo's remote (Bitbucket covers PRs and pipelines; Bitbucket issues come later via
  Jira). And a new set of **remote-write** tools can create and comment on issues,
  close/reopen them, and comment on pull requests, gated behind a separate
  `--allow-remote-write` flag. These make real writes to the repo's forge under your
  authenticated identity (GitHub `gh`, GitLab `glab`, or a stored Bitbucket token), and
  are kept distinct from the local-PR `--allow-write` tools: enabling one never grants
  the other, and read-only remains the default. PR comments an agent posts carry a
  **Posted by GitDesktop** attribution footer, and a read tool returns a pull request's
  full comment set — the conversation, review summaries, and file:line review threads —
  so an agent can read a review before replying to it.
- **More forge-write tools for GitDesktop's MCP server.** The `--allow-remote-write`
  surface now lets an agent **start a new file:line review thread** on a pull request
  (not just reply to an existing one), **request changes** or **withdraw** a change
  request, **edit an issue's** title/body and set its **milestone**, and **add or remove
  reactions** on an issue or pull request (or one of its comments) — all under your
  authenticated forge identity (GitHub `gh`, GitLab `glab`, or a stored Bitbucket token),
  and still gated behind the same `--allow-remote-write` opt-in, off by default.
- **Write GitDesktop's MCP config straight into `.mcp.json`.** The *Use GitDesktop
  as an MCP server* panel now writes (and merges) its `gitdesktop` entry into your
  repo's `.mcp.json` for you, preserving any other servers — no more copy-paste.
  A **Shareable entry** toggle switches between machine-specific absolute paths and
  portable `${GITDESKTOP_BIN}` / `${CLAUDE_PROJECT_DIR}` paths a teammate can commit,
  and an **Allow write tools** toggle adds `--allow-write` so agents can create,
  comment on, approve, and set the status of *this repo's* local PRs — kept off by
  default, leaving the server read-only.
- **MCP server write tiers as checkboxes.** The *Use GitDesktop as an MCP server*
  panel now has toggles for all four write tiers — **Allow write tools**, **Allow
  remote write**, **Allow git writes** (`--allow-git-write`, recoverable repo
  mutations: stage/commit, branches, push/pull, stash, merge/rebase, tags), and
  **Allow destructive git writes** (`--allow-destructive`, only enabled once git
  writes are on: discard, reset, force-push, force deletions). Each toggle threads
  its flag into the copyable snippet, the *Write to .mcp.json* action, and both
  global installs, so you no longer hand-edit the config to grant a tier.
- **Multi-line comment ranges.** Drag across a range of lines in a diff and the
  comment now lands as a **true multi-line anchor** on **GitHub and GitLab** —
  across one-off review comments, pending-review drafts, and GitLab commit
  comments — and clicking the **+** on any line of the drag reopens the same
  range. Where a provider's API is single-line only (Bitbucket comments, and
  GitHub/Bitbucket commit comments), the composer says so and anchors at the
  last line rather than silently collapsing the range.
- **Activity & notifications inbox.** The header activity control is now a persistent bell:
  alongside in-progress work (AI reviews, with Cancel) it keeps a **history of terminal
  events** — a finished review, checks passing/failing, a PR approved / changes-requested /
  commented / merged, a review requested from you, a completed CI run, or a finished agent,
  research, or plan run. Each entry click-navigates to its source, unread items carry a badge, and the
  list survives an app restart, so a review that finishes while you're away is never a
  missed click. Open it with the command palette (**Activity & notifications**), clear items
  or mark all read, and arrow-key through the list. Which events appear follows your
  **Settings → Notifications** choices. (New-comment / new-review / review-requested
  detection is GitHub-only for now.)
- **Operation journal & interrupted-op recovery.** GitDesktop now records the risky
  compound operations it runs — local PR merges, cherry-picks, history edits, and
  interactive rebases — each with the exact branch and commit it started from. If one is
  interrupted by a crash or restart, a calm recovery notice appears above the **Changes**
  list naming what was interrupted and the state it began from; it only informs (the
  git-native Continue/Abort stay in the conflict bar). Browse the full log any time via the
  **Operation history** command or the branch ⋮ menu.
- **PR activity feed.** A pull request's Conversation is now a single date-sorted activity
  feed that interleaves reviews, comments, pushed commits, and events — on **GitHub**,
  **GitLab MRs**, and **Bitbucket PRs** alike. A run of pushes collapses into a "pushed N
  commits" row that expands to the commits, and each commit's short SHA is clickable — it
  jumps to that commit's detail. GitHub shows the full event set (force-push, label
  add/remove, review request, ready-for-review, convert-to-draft, close, reopen, merge,
  rename); GitLab MRs add label add/remove, close/reopen/merge, and approval events
  (approved / changes-requested / approval-withdrawn), with no force-push or draft events;
  Bitbucket PRs add merge/close and approved / changes-requested, with no labels or
  review-requests. An approval or changes-request that predates a later push is flagged
  **stale · N commits since**.
- **CI checks rollup with inline logs.** A pull request's checks now fold into a rollup
  summary — ✓ passed · ✕ failed · ● pending, each count with its own icon and word — that
  auto-expands whenever something failed and lists the checks failures-first. This now
  covers **GitHub PRs**, **GitLab MRs** (from the MR's pipeline jobs), and **Bitbucket PRs**
  (from the PR head commit's build statuses). A failing **GitHub Actions** or **GitLab
  pipeline** job peeks its job log inline, without leaving the PR, with an "Open full run"
  link; external checks and **Bitbucket** build statuses (which expose no fetchable logs)
  link straight out.
- **PR commit detail.** The Commits tab of a pull request is now navigable — arrow
  through the rows and open any commit for its own detail view. A remote commit shows
  its full message body and per-file diffs with a copy-SHA control; a local PR's commit
  opens the full history commit detail. Works on GitHub, GitLab, and Bitbucket PRs.
- **Labels & assignees when creating a PR/MR.** The Create pull request dialog now has
  **Labels** and **Assignees** pickers for GitHub and GitLab — set them up front instead
  of after the PR/MR is open. (Bitbucket PRs have no labels or assignees, so it still
  shows only its reviewers picker.)
- **AI Generate when editing a PR/MR.** The Edit dialog now offers the same **Generate**
  button as the create flow, so you can write or regenerate an existing pull request's (or
  merge request's) title and description with AI — including for PRs from forks, whose head
  branch isn't checked out locally.
- **Request reviewers on GitHub and GitLab pull/merge requests.** The reviewers picker —
  previously Bitbucket-only — now works on GitHub and GitLab too: request a review from a
  collaborator (GitHub) or project member (GitLab) right from the PR/MR view, and see who's
  currently requested, each shown with their avatar. (GitLab's free tier keeps only one
  reviewer per merge request; if it drops the rest, GitDesktop tells you rather than
  reporting a silent success.)
- **Promote a worktree branch to your main workspace.** From the Worktrees dialog (or the
  command palette), bring the branch you've been working on in a linked worktree into your
  main checkout in one step — it frees the branch, stashes any uncommitted work in the main
  workspace so the checkout can't be blocked, and checks the branch out there. The branch
  switcher also lets you jump straight to the main workspace (or any other worktree) instead
  of routing through a checked-out branch, and reminds you when a checkout will land in a
  linked worktree rather than the main one.
- **Rebase a branch onto a different base.** A new **Change base…** action in the
  branch switcher (and command palette) fixes the "I branched off the wrong branch"
  case: pick the branch you meant to base on plus the one you actually based on, and
  GitDesktop replays only your branch's own commits onto the new base — leaving the
  wrong base's commits behind. A moving-commits preview shows exactly what will move
  before you run it, guards against a dirty tree, warns when the branch is already
  pushed, and routes any conflicts into the usual resolve flow.
- **Recover lost work — restore orphaned stashes without the CLI.** A new **Recover lost
  work…** action (in the branch ⋮ menu and the command palette) opens a **Recoverable** tab
  in the stashes dialog that scans your repository with `git fsck` for orphaned/dangling
  stashes — uncommitted work a `git stash` saved but that has since fallen out of `git stash
  list` (dropped, or abandoned by an interrupted operation). Preview each one's files and
  diff, then **Restore to working tree** re-applies it non-destructively (it applies the
  stash, never dropping or committing), so you can recover work you thought was gone.
- **Remove a worktree from the branch menu.** A branch that's checked out in another
  worktree now has a **Remove worktree…** action in its right-click menu in the branch
  switcher, so you don't have to open the worktree manager to free it. The branch stays,
  and its **Delete…** action un-disables once the worktree is gone.
- The Rename branch dialog can now suggest a name from your in-progress changes with AI — the same **✧ Generate from changes** action the New branch dialog has.
- Repo switcher and welcome list rows now show identity badges at a glance: a GitHub, GitLab, or Bitbucket logo for the forge the repo lives on (a cloud icon for a remote on an unrecognized host, a folder for a local-only repo), and a trailing lock (private), buildings (internal), or globe (public) for its visibility.
- **Compose a review, line by line.** Click a line number (or drag across a range) in a
  pull request's Files diff to open an inline composer: post a single comment right away,
  or **Start a review** to batch drafts — which persist to disk per PR and survive a
  restart. Pending drafts show at their anchors with edit and delete, a bar tracks the
  count, and **Submit review…** posts the whole batch with a verdict (Comment, Approve,
  or Request changes — offered where the provider allows, and Request changes needs a
  summary). The composer can also insert a provider-correct `suggestion` block pre-filled
  with the selected code, and reviewer suggestions now **apply to your working tree on
  GitLab and Bitbucket too**, not just GitHub.
- **Update a branch from its own upstream without switching to it.** When a branch is
  behind the remote it tracks, its right-click menu in the branch switcher now offers
  **Update from origin/…** — fast-forwarding it (or merging in place if it's the current
  branch) without leaving the branch you're on. Made for the "just merged a PR, bring the
  default branch current before I switch back" flow: the default branch's row shows how far
  behind its upstream it is after a fetch, and *Update default branch from its remote* is
  available from the command palette.
- **Update a fork from its upstream.** When a repo has an `upstream` remote, the Pull menu
  (and the command palette) gain **Update from upstream**: it fetches upstream, resolves its
  default branch, and brings your current branch up to date — fast-forwarding silently when it
  can, creating a merge commit when the histories have cleanly diverged, and routing conflicts
  to the usual conflict editor. It never pushes for you; the Push button lights up on its own
  once you're ahead.

### Changed

- **One unified "Publish repository…" control.** The sync bar and the hosted-feature
  empty states (Pull Requests, Issues, Discussions, Actions) now share a single publish
  affordance: a plain button when one provider can publish a local-only repo, or a menu
  to pick between GitHub, GitLab, and Bitbucket when more than one is ready — no more
  stacked per-provider buttons. In those empty states, publishing now takes precedence
  over the GitHub CLI setup steps whenever another provider can already publish the repo.
- **Empty states now teach their surface and offer the next action.** Compare's
  detached-HEAD and no-other-branches states explain what's needed and offer *Switch
  branch* / *New branch*; Actions' empty runs list explains where runs come from
  (provider-aware) with a *Run workflow/pipeline* button, and its branch-scoped empty
  offers *Show all branches*; History's filtered no-match adds a *Clear filter* button;
  and the Tags, PR Tasks, and Discussions empty states got clearer, more helpful copy.
- **Automations redesigned around a lifecycle grid.** Automations (Settings → Automations,
  and per-repo from a repository's ⋯ menu) are now grouped by moment — *On commit*, *On pull
  request opened*, and *On new commits to a reviewed PR* — with AI code review and security
  audit as toggles under each, so duplicate or conflicting rules are no longer possible. Each
  enabled action can be scoped with **branch conditions** (include/exclude globs, plus a
  Source / Target / Either match for PR events) and a "Try a branch" preview. Both the global
  and per-repo surfaces now edit behind **Save / Discard** rather than saving on every toggle,
  and the per-repo dialog shows the effective settings, badges overridden cells, can enable an
  action that's globally off, and offers "Reset to global defaults". Your existing automations
  are migrated automatically on first launch, with any duplicate rules merged and noted once.
- **Faster startup.** The app now boots from a much smaller core bundle — agent sessions, diff rendering, the git-hooks editor, and the AI provider SDKs each load on first use instead of on launch.
- **Codex model suggestions.** The model picker for the **Codex (CLI)** provider —
  in AI review, agent sessions, and plans — now suggests real model ids
  (`gpt-5.5`, `gpt-5.4-mini`) instead of showing an empty list. Pick one, type your
  own, or leave it blank to keep using your Codex account's default (still the
  default when you switch to Codex, since the right model depends on your plan).
- Collaborator and member avatars in Repository Settings now use the standard
  avatar component, showing a letter fallback when a user has no picture instead
  of a blank circle.
- Copying a PR review's markdown now includes its file-anchored review threads —
  the diff excerpt, every comment, and any suggested changes — so AI and bot
  reviews (Copilot, CodeRabbit) paste complete instead of losing their findings.
- **Syntax highlighting holds up in large files.** Diffs keep their syntax colors
  much further into big files — an edit deep in a long file (past ~2,000 lines) no
  longer silently drops all highlighting, and the size limit before a diff falls
  back to plain text is now tuned per highlighter (400 KB for highlight.js,
  150 KB for Shiki languages like Rust and TSX, up from a flat 100 KB).
- **Calmer error toasts.** Long git and forge errors now show a single
  humanized summary line with a **Details** action that opens a dialog with the
  full, selectable text and a Copy button; short errors are unchanged and keep
  their Copy action.
- Forge views feel snappier. Repeated origin-remote lookups from the many forge queries a pull-request or merge-request view fires are now served from a short-lived in-memory cache instead of re-shelling out to `git` each time — noticeably fewer process spawns on Windows.
- **Provider avatars for assignees and authors.** The assignee picker now shows each user's
  photo (like the reviewers picker), and author avatars on pull/merge requests, issues, and
  comments now use the person's real GitLab or Bitbucket profile photo instead of falling back
  to their initial. (GitHub already showed avatars, derived from the username.)
- The History tab stays smooth with thousands of loaded commits — rows now
  render only as they scroll into view.
- The Jira issue view now puts type, assignee, reporter, dates, agile fields, labels, and
  time tracking in a right-hand side panel like the GitHub and GitLab issue views, so the
  header stays compact and the description and comments get the freed space.
- The MCP `list_pull_request_comments` tool now caps each review thread's diff
  hunk to its last few lines, so a comment on a brand-new file no longer drags
  the whole file into the response. Pass `include_diff_hunk: false` to drop the
  hunks entirely when you only need the threads' structure.
- **MCP `approve_pull_request` and `request_changes` now work on GitHub.** Both forge write
  tools previously dead-ended on GitHub repos with a "goes through the Review menu" error;
  they now route the GitHub arm through `gh pr review`, so approving and requesting changes on
  a PR work across GitHub, GitLab, and Bitbucket. (GitHub's `request_changes` requires a
  non-empty body; the error surfaces if it's omitted, and withdrawing a requested-changes
  review stays unsupported on GitHub, as `gh` can't do it.)
- **MCP: cap or widen PR/issue lists.** The MCP server's `list_pull_requests` and
  `list_issues` tools take an optional `limit` — omit it for the provider's default page
  (GitHub ~30; GitLab and Bitbucket a full page), or pass one to raise or lower how many an
  agent pulls back in a call.
- **MCP `create_pull_request` now requires `--allow-git-write` in addition to
  `--allow-remote-write`.** Opening a pull request pushes the head branch to origin first — a
  local-git write — so it now correctly demands the git-write tier as well, honoring the
  rule that enabling one capability tier never grants another.
- **MCP: PR/issue text is flagged as untrusted to connected agents.** The built-in MCP
  server's read tools that return third-party prose — `list_pull_requests`,
  `get_pull_request`, `list_pull_request_comments`, `list_issues`, and `get_issue` — now
  prepend a note marking the titles, bodies, and comments as data to analyze, never as
  instructions to follow, so an agent pulling a PR's comments in is less exposed to prompt
  injection from an attacker-authored comment. Defense-in-depth: forge writes remain gated
  behind `--allow-remote-write`.
- Snappier UI after issue, pull-request, and Jira actions: closing, editing,
  commenting, and changing labels/priority/due-date now refresh just the item
  you touched instead of refetching the whole repository's data.
- Notifications now always show which repository they're for and, for new-pull-request
  notifications, the author with their avatar; the Activity & notifications panel is
  slightly wider to fit.
- Research → Plan → Implement handoffs now carry forward what the prior stage
  already examined (files, searches, web sources), so the next agent starts from
  that grounding instead of re-exploring from zero.
- **Create-PR branch picker.** The branch dropdown now widens to fit the longest branch name (up to a limit) instead of clipping to the field width, and each option shows a chip when that branch is checked out in another worktree or is archived.
- **Pull request rows now show when each PR was opened**, matching the issue list —
  `#12 · author · 3 hours ago · head → base`. Local pull request rows show their age
  too. Each row also gains a small CI indicator a moment after the list loads — on
  GitHub and GitLab, and on Bitbucket wherever a PR reports build statuses: a check for
  passing, a cross for failing, and a clock for checks still running (rows with no
  checks show none). Each icon has a distinct shape and a hover label, so the signal
  never relies on color alone.
- **Archived branches no longer clutter the create-PR branch pickers.** When opening a
  pull request (GitHub/GitLab or a local PR), the base and compare dropdowns now hide
  branches you've archived, matching the branch switcher. A branch that's still a seeded
  default (your current branch, say) stays selectable even when archived.
- **Local-PR record actions moved off the footer.** A local PR's footer is now just the
  merge decision; **Archive / Unarchive** and **Delete** moved to a right-click menu on
  the PR's list row (Delete still confirms, and never touches the branches). Both are also
  in the command palette as **Archive pull request** and **Delete pull request**, acting
  on the selected local PR.
- **AI review factors in its own prior comments.** When you re-review a pull request, the AI
  review now reads the comments GitDesktop has already posted on it — past reviews and any
  agent follow-ups (a refutation, or a "fixed in `<sha>`" reply) — and treats a finding it
  already resolved or refuted as settled instead of raising it cold again, unless the current
  diff still shows the problem. Works on GitHub PRs and GitLab MRs (remote PRs only).
- Smoother rendering across major surfaces — the changes list, staging diff,
  settings, sync controls, conflict view, and history editor were silently
  opted out of React Compiler optimization; they now compile and re-render less.
- **AI-generated repo descriptions are less terse.** The **Generate** button for a
  repository's About description now aims for a fuller single line (roughly 200–325
  characters) that says what the project does and what makes it stand out, instead
  of the old ~140-character cap that often produced a thin one-liner. GitHub's About
  field already accepts up to 350 characters, so the result still fits. Long READMEs
  are now condensed to keep their features and highlights breadth — dropping install
  and development boilerplate — instead of being blindly cut off at 6,000 characters,
  so the model sees what the project actually does rather than just its opening.
- **Repository settings: friendlier Description and Topics fields.** In *Settings →
  General*, the **Description** is now a multi-line box so a long "About" wraps
  instead of clipping mid-word (GitHub and GitLab; Bitbucket already did). **Topics**
  are now removable chips with an inline add-box: type a topic and press **Enter** or
  comma to add it. On GitHub, each token is normalized to a valid topic as you add it and
  the chip shows exactly what will be saved — so `C++` becomes `c` and `React_Native`
  becomes `react-native`, and pasted or space-separated text lands as clean chips instead
  of being silently mangled on save; the field caps at 20 with a live count. On
  GitLab, topics keep their case and spaces, so "React Native" stays one topic. Chips are
  fully keyboard-navigable — arrow between them, remove the focused one with Enter or its
  ✕, and Backspace in an empty add-box removes the last one.
- "Turn into a Plan" now distills the research session into a clean plan brief (via
  one extra turn that forks the conversation, so it never disturbs the research
  session itself) instead of handing the plan the raw multi-turn transcript — with
  automatic fallback to the full report if distillation fails or is cancelled.
  Distillation is currently available for Claude; other agents fall back to the full
  report.
- AI code review now has to trace its data-flow claims: a statement like "X arrives as
  parameter Y, sliced to N" must point at a real call site or be left out — fewer fabricated
  parameter and slicing claims in review findings.
- **AI PR reviews verify before flagging.** The review now checks the typed contract
  before reporting a possible null/undefined issue — a field the types declare
  non-optional (or that every code path visibly sets) is no longer flagged — and it
  omits a finding relayed from another AI reviewer when it cannot verify that finding
  against the diff, rather than passing it along with a "could not verify" hedge.
- **Review comments read in context.** On a GitHub PR, each review's line comments now
  appear **inline under that review** in the Conversation timeline (grouped by file),
  instead of being pooled in one block at the bottom — so you follow a review right where
  it lands. Standalone line comments, and every thread on GitLab and Bitbucket (which
  don't tie comments to a review), still gather in a by-file block below, retitled *Other
  line comments* when some already appear inline above. Reply, resolve, apply-suggestion,
  and keyboard navigation work the same in both places.
- Repo-aware AI review starts faster: the PR head is no longer pre-fetched when its objects
  are already present locally.
- The app starts leaner: diff syntax-highlighting grammars and the session
  terminal now load on first use instead of at startup, and markdown code
  blocks highlight all languages — the rarer ones load their highlighter on
  first use.
- Dialogs are a little wider by default, and long branch names now wrap instead of overflowing — applied once in the shared dialog component, so every dialog (create/rename branch, the merge/rebase picker, and the rest) benefits.

### Fixed

- **Deleting a worktree with installed dependencies now works on Windows.** Removing an
  agent-session (or manually created) worktree that had `node_modules` installed — where
  pnpm links packages through junctions/symlinks — used to fail with
  *"failed to delete '…': Invalid argument"*, leaving the worktree half-removed. GitDesktop
  now finishes the removal itself (correctly deleting those links) when git's own delete
  trips on the reparse points, and if a file is still locked by another program it says so
  plainly instead of showing git's cryptic error.
- **Checking out a remote-only branch that lives on more than one remote now works.**
  Clicking a remote branch in the branch switcher used to fail with *"matched multiple
  remote tracking branches"* when the same branch name existed on two or more remotes.
  The switcher now creates the local branch tracking exactly the remote shown on that
  row, so the checkout matches what the row promised.
- **Windows local-path repositories are no longer mislabeled with a bogus owner or host.**
  A repository whose `origin` points at a local path (e.g. `C:\path\to\repo`) was
  misread as a hosted remote, tagging it with a nonsensical owner and host. Local-path
  remotes are now recognized as having neither.
- **The review-model picker no longer changes your global default.** Switching the provider
  or model in a pull request's **Review** panel now applies to **that review only** — it no
  longer overwrites the default review model in Settings → AI. The panel shows a small note
  while a one-off model is in effect, and resets to your default for the next PR.
- **Windows: tools added to `PATH` after the app started are now found without a restart.**
  Windows never pushes a `PATH` change into an already-running program, so a CLI you
  installed (or added to `PATH`) while GitDesktop was open — `glab`, `gh`, or an agent CLI —
  used to read **"Not found"** in Settings → About until you fully relaunched the app. The
  resolver now also reads your *live* user and system `PATH` straight from the registry, so
  detection (and the **Re-check** button) picks up a freshly-installed tool immediately.
- **Host GitHub Copilot sessions no longer fail with "batch file arguments are invalid"
  on Windows.** When the VS Code Copilot extension is installed, it puts a `copilot.bat`
  wrapper on your `PATH` *ahead* of the real `copilot.exe` — and Windows won't let an app
  pass a multi-line prompt to a batch file. GitDesktop now prefers a real `.exe` over a
  `.cmd`/`.bat` shim found earlier on `PATH` when locating any agent CLI, so it launches
  the actual Copilot binary. (CLIs that ship only a `.cmd`, like Codex, are unaffected.)

- **Codex agent sessions no longer show a blank "No response."** Codex delivers its whole
  reply at the end of a turn (it doesn't stream it incrementally like the other CLIs), and
  the session view was discarding that final message — so every Codex turn looked empty.
  The message is now displayed.

- **A finished plan or agent run on a background tab now notifies you.** The OS
  notification for a completed plan/session was suppressed whenever the window was
  focused and that run was selected — but since plans and sessions live on the Agent
  tab, a focused user reading another tab (Changes, Pull Requests, …) was wrongly
  treated as "watching it" and got nothing. The notification now only stays quiet when
  the Agent tab is the one actually on screen. A plan that finishes **with clarifying
  questions** — a blocking handoff that idles until you answer — now always notifies,
  even while you're looking right at it.
- **The "default branch for new repositories" setting now updates git itself.**
  Settings → Git's default-branch field used to be a GitDesktop-only preference: it
  changed what the app's *Create repository* dialog did, but never touched your global
  git config — so `git config --global init.defaultBranch` (and a command-line
  `git init`) still used the old branch. The setting now reads from and writes to your
  global git config (`init.defaultBranch`), with its own **Save**, the same as the Git
  identity field beside it — so GitDesktop and the command line finally agree.
- **Container agent sessions now actually run the agent.** A container-isolated
  session was launching `node` instead of the agent CLI inside the container (the CLI
  name wasn't passed as the command), so Claude/Codex/opencode sessions failed to
  start in container mode. They now run correctly. (Host sessions were unaffected.)
- **AI reviews now show why they failed.** A failed PR/local review used to revert
  silently to the empty "Run a review…" placeholder with no explanation; it now
  displays the actual error (and keeps any partial output that streamed first).
  CLI-agent failures also no longer surface as a useless `[object Object]`.
- **The co-author picker is fully keyboard-navigable.** When adding a commit
  co-author, ↑/↓ now move through the suggestions and Enter adds the highlighted
  one (it's a proper combobox), instead of only being able to add the top match or
  reach for the mouse.
- **A couple of dead-ends now explain themselves.** The repository Insights error
  no longer prints a raw error string, and the Actions toolbar's "Run workflow" and
  refresh buttons, when disabled, now say they need a GitHub CLI sign-in instead of
  greying out silently.
- Stopping or timing out an agent session now terminates the CLI's entire
  process tree, so helper processes (language workers, MCP servers, tool
  subprocesses) can no longer keep running in the background — previously on
  Windows only the top-level CLI was killed, leaving its children consuming
  tokens and holding worktree file handles.
- **A cancelled automated PR review no longer re-runs after a restart.** Cancelling an
  automatic re-review of new commits on a pull request now remembers that commit, so it isn't
  reviewed again when you relaunch the app. A genuinely new commit still triggers a review as
  before.
- Automations no longer fire twice when two app instances (for example a main
  checkout and a linked worktree) watch the same repository — a run is now claimed
  atomically across processes before any AI work, so only one instance posts the
  review.
- Concurrent automation-settings saves no longer overwrite each other — the
  global defaults and a repository's overrides are each re-derived from fresh
  state when saved, so two overlapping saves can't drop one another's change.
- Review threads on busy pull requests no longer disappear: Bitbucket comment
  pages and GitHub review-thread pages are now followed across multiple pages,
  instead of stopping at the first 100 and silently dropping the rest.
- Blaming a very large file no longer freezes the app — the blame view now
  virtualizes its rows and syntax-highlights only the lines currently on
  screen, instead of rendering and highlighting every line at once.
- Bot authors like **dependabot**, **renovate**, and **github-actions** now show
  their real avatars in PR, issue, and timeline surfaces and in History, instead
  of falling back to an initial — GitHub serves no login-derived avatar for bot
  accounts, so GitDesktop now resolves them through the GitHub API once and caches
  the result.
- **A branch whose remote was deleted now offers "Publish branch."** After a PR
  merge deletes the remote branch, the sync bar no longer shows stale Push/Pull
  against the dead ref — it shows **Publish branch**, which recreates the remote
  branch on push. Undo-commit is available again on such a branch, and amending
  its tip no longer wrongly demands a force-push.
- **Cherry-picking commits onto another branch no longer risks uncommitted work.** Cherry-picking onto the branch you're currently on could, if it hit a conflict, discard your uncommitted changes during rollback — it now refuses up front on a dirty working tree with a clear "commit or stash your changes first" message. (Untracked files are still fine.)
- Repository **Access** settings no longer offer the Triage, Maintain, or Admin
  collaborator roles on a personal (user-owned) repository. GitHub silently keeps
  collaborators at Write there — picking a higher role returned success but never
  applied — so the picker now shows Read and Write only (organization repos keep the
  full set), with a short note explaining why.
- Switching to the Compare tab no longer clears the commit selected in History —
  each tab now keeps its own selection.
- **A requested Copilot review now shows in a pull request's Reviewers.** A pending GitHub Copilot (or other bot) review request is displayed as a read-only chip in the PR Reviewers section instead of being invisible. The chip is display-only — the reviewer picker never adds or removes a bot, so managing human reviewers can't drop a pending Copilot request.
- Large file diffs no longer flash or re-render while loading. The diff now waits
  for its syntax-highlighting inputs (the whole-file context reads and any
  lazily-loaded language grammar) to settle and paints once, instead of showing a
  brief hunk-only pass that restructured a moment later.
- **On a fork, the Actions tab now shows your fork's workflow runs, not the upstream
  repository's.** When a fork has an `upstream` remote, GitHub's CLI would resolve the
  parent repository, so the Actions list, run details/logs, re-run/cancel, "Run workflow"
  dispatch, and the run notifications could all target the original repo. Every Actions
  operation is now pinned to your `origin` remote. Single-remote repositories are
  unaffected.
- On a fork with an `upstream` remote, repo administration now always targets
  **your fork** (the origin remote) rather than the upstream parent. This covers
  repo settings, webhooks, Pages, collaborators & invitations, insights, code
  security, rulesets, secrets & variables, generated release notes, branch-
  protection import, and — most importantly — repository rename, transfer, and
  delete.
- The GitLab auto-merge status poll now pauses while the Pulls tab is hidden,
  instead of quietly polling the server every 8–30 seconds in the background.
  Switching back to the Pulls tab refreshes it immediately.
- **Long branch names no longer overflow the repository header.** A very long
  current-branch name used to push the header wider than the window, adding
  horizontal (and cascaded vertical) scrollbars and hiding the sync controls.
  The branch name now truncates with an ellipsis — hover it to see the full
  name — while the icons, detached badge, and Fetch/Pull/Publish controls stay
  fully visible. The truncation order is deliberate: the branch name gives way
  first, then the CI badge's workflow label, and the repository name last.
- **Long repository names no longer overflow the header.** A repository name
  or alias longer than the trigger's width used to paint past its box over
  neighboring controls. It now truncates cleanly with an ellipsis — hover it to
  see the full name — and at narrow window widths the repository and branch
  triggers shrink together instead of the branch giving way alone.
- Hidden tabs and unfocused windows no longer keep polling — Actions run and
  workflow queries pause while their tab is hidden, and GitLab merge-state and
  agent-session diff polling stops while the window is in the background.
- Arrow-key navigation on the custom slash-commands list (Settings) and the
  submodules list — move between rows with the arrow keys and act on the
  active row (edit a command, or initialize/update a submodule) with Enter.
- **Pull request, issue, and discussion lists no longer stop silently at 30 or 50.**
  These lists used to cap at the underlying CLI's default page (30 pull requests and
  issues, 50 discussions) with no indication more existed. They now load the first 100
  and, when a full page comes back, offer a "Load 100 more" row at the bottom that pages
  the rest in — with a "Showing first N" count so you always know where you stand.
- **Long pull request, issue, and discussion lists no longer stretch the window with
  empty space.** A list taller than the viewport could spill its full height into the
  page, adding an outer window scrollbar over a large empty void. Lists (and the detail
  panels) now contain their own scrolling, so the window stays put and only the list
  scrolls.
- The local pull-request dialog's branch picker no longer lists internal agent-session branches (`gd/session/*`).
- **Installing the MCP server globally now finds `claude` / `copilot` reliably.** The
  global install resolves the client CLI the same way the rest of the app does — checking
  the system PATH, known install locations, and (on Windows) the live registry PATH — so
  it no longer reports the CLI as "not found" when it lives in a directory that was added
  to PATH after GitDesktop started.
- **MCP server no longer blocks installs or gets killed by updates (Windows).** When you
  use GitDesktop as an MCP server, the generated config now launches a dedicated
  `gitdesktop-mcp` copy of the app instead of the installed executable. Running MCP
  servers no longer lock the installer out with a "Files in Use" dialog, and are no
  longer silently terminated mid-session by a passive auto-update. **Add to PATH** now
  points at this launcher and migrates any older install-folder entry automatically.
- **The merge dialog no longer offers to delete a branch it can't.** When merging a
  pull/merge request, the "Delete _branch_ on the remote after merging" option is now
  hidden when the head is the repository's **default branch** (which every forge refuses
  to delete) and disabled with a reason when a **branch rule** protects it — matching the
  branch switcher. Applies to GitHub, GitLab, and Bitbucket, including GitLab auto-merge.
- Merge-confirm dialog: long branch names (e.g. Dependabot's) no longer overflow the delete-branch checkbox label or the dialog description — the text now wraps cleanly.
- New branch dialog: a long base-branch name (e.g. `feature/ollama-cloud-provider-custom-endpoints`) no longer overflows the dialog — the "Branches from …" description and the base-branch selector now stay within bounds and the name wraps cleanly.
- A UI polish sweep across the app: disabled buttons now explain why they're disabled on hover, bot authors like dependabot display properly on PR rows and headers, PR list fetch failures show an error with retry instead of looking empty, relative times no longer show "24 hours ago" next to "1 day ago", and keyboard navigation & screen-reader labels were added to several lists and icon buttons.
- Creating a pull request with labels or assignees no longer records each one
  **twice** on the PR's activity timeline (e.g. "added the documentation label"
  appearing twice). Labels and assignees are now applied right after the PR is
  created rather than during creation, which GitHub's CLI double-recorded.
- Very large pull requests now show their full diff and complete file list
  instead of failing or stopping at 100 files. When GitHub refuses the whole-PR
  diff (its 300-file limit) or caps the file list at 100, both are rebuilt from
  the paginated files API so every changed file appears in the rail and renders
  its hunks.
- Merging a GitHub pull request with **Delete branch** checked now removes only the
  *remote* branch, matching GitLab and Bitbucket — your local branch and whatever you
  have checked out are left untouched (it previously deleted the local branch too and
  switched you to the default branch).
- Running automation AI reviews now appear in the header's activity indicator —
  where they can be cancelled — instead of a persistent toast that floated over
  the pull-request action bar. Toasts now announce only the result and can be
  dismissed with a close button.
- **PR detail no longer truncates commits, reviews, or conversation comments at 100.**
  A pull request with more than 100 commits, reviews, or conversation comments previously
  showed only the first 100 as if that were the whole list (GitHub's GraphQL connections
  cap there). The PR view now completes each list from the paginated REST API, matching how
  the changed-files rail already worked.
- When promoting a local PR or issue, or creating a sub-issue, a failure that happens
  after the remote object was already created now tells you what was created (with a View
  link) and closes the dialog, instead of showing a generic error that invited creating a
  duplicate.
- Removing the **currently open** repository while also moving it to the **system trash**
  (Recycle Bin on Windows, Trash on macOS/Linux) now closes it first, so the move no longer
  fails with a raw "Some operations were aborted" error. If the folder is still locked by
  another program, the message now explains that an open editor, terminal, or file-explorer
  window is likely holding it — and the repository stays listed so you can close them and retry.
- Switching between repositories no longer briefly shows the previous repository's
  pull requests, issues, discussions, or other lists before the new repository's load.
  The panels now drop straight to a loading state on a repo switch, while still keeping
  their rows in place during in-repo navigation like "Load more" and Open/Closed tab
  switches.
- Fixed a rare lost update in stored AI review history: when two changes to a
  PR's reviews landed at nearly the same time — for example an automated review
  finishing while you edit or delete another review's text — one change could
  silently overwrite the other. Overlapping writes are now serialized so neither
  is dropped.
- Review-thread expand/collapse in the Files diff now toggles correctly under
  rapid clicks, and clipped file paths in the review-comments list show the full
  path on hover.
- Internal agent-session branches (`gd/session/*`) no longer show up in the
  cherry-pick target, GitHub Pages source, or default-branch pickers, nor in the
  MCP server's `list_branches` tool or branch-name generation context.
- GitDesktop now enforces a single running instance: launching the app again focuses the existing window — restoring it from the tray if needed — instead of opening a duplicate whose automations could double-fire (e.g. two AI reviews posted on the same PR).
- **Review-thread replies no longer clutter the PR timeline.** Replying to a
  review thread on a GitHub PR used to leave a bare, context-free "commented"
  card in the conversation timeline (GitHub auto-wraps the reply in an empty
  review); it now renders as a compact "replied in a review thread" row with the
  file and line, plus a jump-to-thread link. On Bitbucket, thread replies no
  longer appear twice -- once in the timeline and once inside their thread.
- On a branch that hasn't been published yet, the History tab no longer marks
  **every** commit as "not pushed" — it now compares against the remote and flags
  only the commits actually made on the branch (the ones above where it forked
  from the default branch).
- Deleting a branch that's checked out in another worktree now explains which worktree
  holds it instead of failing with a raw git error, and the branch-cleanup dialog leaves
  such branches out of its delete list (they can still be archived).
- **Kept session worktrees no longer leak their folder on Windows.** When a worktree
  couldn't be removed because git's own recursive delete tripped over reparse-point
  links (how `node_modules` is laid out on Windows), the folder was left behind on disk.
  Removal now finishes the job itself once it confirms the worktree has no uncommitted
  work — a worktree with real unsaved changes is still preserved and surfaced, never
  silently discarded.
- Merging a local pull request into a base branch that's checked out in another worktree
  now fast-forwards that worktree instead of refusing, keeping its working tree in sync
  (and failing with a clear message if that worktree has uncommitted changes).
- Local pull requests, issues, review history, review drafts, branch rules, and
  automation rules are now keyed by repository identity rather than checkout path, so
  they're shared across all of a repo's worktrees — a PR created in one worktree now
  shows up in the main checkout, and the MCP server's local-PR tools no longer report
  "no local PRs found" when the server is bound to a worktree.

### Changed

- **The GitLab clone browser lists your most recently active projects first.** The listing
  is capped at 100 projects, so ordering by activity also means anything past the cap is
  the least-recently-active — not an arbitrary hundred.
- **Sharper AI security reviews.** The security-review prompt was rebuilt to cut false
  positives and surface real, exploitable issues. Every finding must now spell out a
  concrete exploit scenario (no attack path, no finding) and carries a **confidence score**,
  reported against a severity-scaled bar — eager on critical-impact issues, strict on
  low-severity ones. Each risk category now pins its own *"not an issue"* list right beside
  it, the model must **name the specific guard** that makes a risky sink safe before
  dismissing it, and an exclusion list tuned to this codebase tells it what *not* to flag —
  e.g. memory-safety bugs in Rust, React XSS without `dangerouslySetInnerHTML`, missing
  client-side auth checks, DoS/rate-limiting, outdated dependencies, and attacks that depend
  on controlling environment variables or CLI flags. **Prompt-injection (XPIA)** is now a
  first-class category, with a carve-out so GitDesktop's own intentional embedding of repo,
  PR, and diff content into its AI prompts isn't mistaken for a vulnerability. Applies to
  both the quick (diff-only) and repo-aware security reviews, on any provider.
- **Higher-signal AI code reviews.** The general code-review prompt was tightened to
  raise signal without narrowing its scope. Findings are now ordered by severity with
  clear definitions for **blocker**, **should-fix**, and **nit**; the real ones must
  cite the concrete case that triggers them (the input, state, or code path), not just
  an assertion; and the reviewer is told to include a finding only when it's confident,
  skip formatting a linter already handles, and never let nits crowd out the real
  issues. It stays a broad review — correctness, edge cases, security smells,
  performance, clarity, and tests — and runs on any provider, including local models.
- **A steadier, tidier agent composer.** The task box (Delegate, Plan, and the
  in-conversation reply) now docks to the bottom of its panel like a terminal: the
  text grows **upward** so the action row and **Send** never drift as you type. The
  run controls also stopped overflowing — the provider and model stay out for quick
  access, and run mode, reasoning effort, and MCP servers fold into a single
  **Options** popover (with a count + summary so you can still tell at a glance
  what's set). Best-of-N, the Codex-on-host MCP hint, and changing effort/MCP
  mid-session all work as before.
- **Calmer repository settings.** The repository settings dialog moved from a wrapping
  row of eight tabs to a vertical sidebar — grouped into Repository, Security,
  Publishing, and Automation — matching the app's main Settings. The **Danger zone** is
  now its own sidebar item instead of riding the bottom of the General tab, so delete /
  transfer / visibility live behind a deliberate click rather than below your topics.
  Arrow keys move between sections, and the panel crossfades as you switch (respecting
  "reduce motion").
- **The in-app user guide caught up with the app.** The guide (press the *Open user
  guide* shortcut, or the **?** menu) was rewritten and expanded to cover everything
  that's shipped — **Agent sessions** (plan, delegate, best-of-N, isolation), the
  **Issues**, **Discussions**, **Releases & tags**, **Insights**, and **Repository
  settings** surfaces, the full provider list, and more — with arrow-key navigation in
  its section rail. Keyboard shortcuts shown in the guide now read from your **actual
  bindings** (so they show ⌘ on macOS and reflect anything you've rebound), and when
  **Hide AI features** is on the guide hides its AI sections and mentions too.
- **Keyboard-navigable section sidebars everywhere.** The Settings, Repository settings,
  and user-guide sidebars now share one component, so all three navigate the same way —
  **↑ / ↓** to move between sections with a visible focus ring (the Settings sidebar was
  the last one missing this).
  pick the image's **Node version** (default 24 LTS, or 22 / 20) and **which agents**
  to install (Claude / Codex), and adds **Rebuild** — which pulls a fresh base image
  and reinstalls the CLIs so newer releases are picked up. Previously the image was
  built once with a fixed Node version and every agent baked in, with no way to
  update it. A stale image (built for a different Node/agent selection) is flagged
  for rebuild, and starting an agent the image wasn't built with now fails with a
  clear message instead of a cryptic in-container error.
- **Subtle, calm transitions in a few spots.** A handful of state changes now ease
  in instead of popping: the Send/Stop, Generate/Cancel, and Review/Cancel buttons
  when an AI task starts or stops; agent sessions sliding in and out of the list as
  you start, keep, or delete them; the "jump to latest" button in an agent chat;
  the ahead/behind badges in the toolbar; and a soft fade as the Changes list
  replaces its loading placeholder. Everything respects your system "reduce motion"
  setting (it falls back to a plain fade or no animation).
- **The mint brand color now lives in the app, as a restrained accent.** Primary
  actions (Open repository, Commit, Send a task…), the current selection in lists,
  and keyboard focus rings are now GitDesktop's mint instead of flat gray — so the
  one primary action and where the keyboard is focused are obvious at a glance on
  every screen. The calm monochrome base is unchanged; mint only marks action,
  selection, and focus. Under the hood, the status colors (added / modified /
  deleted, success / warning / error, merged) are now driven by shared design
  tokens, so they stay consistent across every view instead of drifting per-screen,
  and the diff line-selection highlight uses the accent instead of a one-off blue.

### Fixed

- **Rust diffs no longer lose syntax highlighting partway down a file.** A large
  Rust diff could render the top of a file highlighted and everything past a
  certain line as plain text — a quirk of the lightweight highlighter mis-reading
  a character literal or lifetime and giving up on the rest of the file. Rust now
  renders with the same VS Code-grade grammar already used for TypeScript, Vue,
  and others, which highlights every line reliably.

### Added

- **GitHub Copilot CLI joins Claude Code and Codex as an agent.** Pick **GitHub
  Copilot** in the agent-session composer to delegate a task to it — keyless, via
  your Copilot subscription. It runs worktree-confined on the host (its file edits
  are limited to the worktree), and multi-turn follow-ups resume the same session.
  Copilot is also available as a code-review provider, and it appears in Settings →
  About alongside the other CLIs. (Container isolation and repo-aware review for
  Copilot are coming next; an `opencode` slot is recognized for a future release.)
- **Delegate a task to an AI agent, and iterate with it (agent sessions).** A new
  **Agent** tab lets you hand a coding task to an AI agent that writes the code for
  you. It runs full-auto inside an isolated, throwaway git worktree — a separate
  checkout, so your working tree, staged changes, and current branch are never
  touched no matter what the agent does. For stronger confinement you can opt
  into running each session inside an **ephemeral Docker/Podman container**
  (Settings → AI), so the agent's filesystem writes are limited to the worktree
  by the kernel — GitDesktop builds the small agent image for you. It's a
  **conversation**: watch the agent
  work as its narration streams into the conversation, then send follow-ups ("now
  also handle the empty case", "undo that part") and it keeps going with full
  context — each turn becomes a reviewable checkpoint commit. The composer stays
  pinned while output streams (it grows as you type, then scrolls), Enter sends
  and Shift+Enter adds a line, and a **Latest** button jumps you back to the
  newest output if you've scrolled up. **Press ↑/↓ to recall your previous
  prompts** (like a terminal), and any turn that came back empty or errored
  offers **Edit & resend** to pull its prompt back into the composer and retry.
  Type **`@` to reference a repo file**, and **file paths the agent mentions are
  clickable** — they open in your editor. Flip
  between the **Conversation** and a dedicated **Changes** view (the full diff so
  far) right in the session. Pick the **provider** (Claude, Codex, or Copilot),
  the **model**, and a **reasoning-effort level** for the session — model and
  effort are changeable as you go (effort maps to each CLI's own mechanism, so it
  applies where the provider supports it). **Run
  several sessions at once** — each gets its own worktree and runs independently,
  listed in the sidebar so you can start one, switch to another while it works
  (arrow keys included), and come back. The sidebar groups sessions into
  **Active** and **Kept** tabs (with counts) so finalized work doesn't crowd
  what's ready to review, and a **search** box filters by task, branch, or any
  message. An **OS notification** fires when a turn finishes — unless you're
  already watching that session — so you can start one and step away. **Sessions
  are remembered across
  restarts** — close and reopen the app and your sessions are still there, ready
  to keep iterating (a follow-up picks up right where it left off). When you're
  happy, **Keep** the work — optionally squashing the per-turn commits into one —
  and it lands on its own branch ready to open as a PR. **Kept sessions stay in
  the list**, so you can come back later: **Resume** re-opens one and continues
  the conversation right where it left off, or **Delete** removes it from the app
  (the branch is preserved). **Discard** throws an in-progress session away
  entirely (branch and all). New session, Keep, Resume, Delete, Discard, and the
  view toggle are all in the command palette and keyboard-bindable. It
  builds on the CLI agent you already have — **Claude Code** or **Codex** (pick
  it per session — Codex confines its own writes to the worktree with its OS
  sandbox, so it needs no Docker; the container is an optional stronger boundary) —
  no separate subscription, and only appears when AI features are enabled.
- **Commit — or discard — part of a brand-new file.** Line- and hunk-level
  staging now works on untracked (new) files too, not just files git already
  tracks — drag across the lines you want in a new file's diff and stage just
  those, leaving the rest for a later commit. (Previously a new file could only
  be staged whole.) The unstaged remainder keeps showing as you go. Discarding a
  new file's lines works the same way: drag (or use a hunk's Discard) to drop
  just those lines from the file — discarding the whole new file still goes to
  the recycle bin.
- **See what you haven't pushed.** The History list now marks every commit that
  isn't on the remote yet with a small up-arrow (hover for "ahead of
  origin/…") — so it's clear at a glance what a push would send. On a branch
  with no upstream, every commit is marked until you publish it. The markers
  clear themselves once the push lands.
- **Reviews build on other AI reviewers.** If GitHub Copilot, CodeRabbit, or
  another review bot has already weighed in on a GitHub pull request, an AI
  review or security audit now folds their findings — including their
  line-anchored inline comments — in as soft context, the same way it builds on
  your own previous review. So instead of starting cold, your review begins from
  what's already been flagged and re-verifies each point against the current diff
  (their findings are treated as hints, never fact): it confirms the real ones
  (crediting the bot when they match), and — most usefully — briefly calls out
  the ones that are wrong or already fixed, triaging their false positives for
  you instead of silently dropping them. It only pulls from recognized code-review
  bots — deploy and CI bots are ignored — notes when a finding was made against
  an older commit, and a per-PR banner lets you opt out for a clean pass.
- **Copy an AI review without posting it.** The PR review panel now has a
  **Copy** button next to "Post as comment," so you can grab the review (or
  security audit) as markdown for use elsewhere without having to post it to the
  pull request first.
- **Insights tab.** A new **Insights** tab (Ctrl/Cmd-9, or "Insights…" in the
  repository menu) with a GitHub-style board of repository graphs. Four of them —
  **commit activity** (per week), **code frequency** (additions vs. deletions per
  week), **contributors** (commits + line churn), and a **punch card** (commits by
  day-of-week × hour) — are computed **locally from your clone**, so they work
  offline, on private repos, with no token or rate limit, and without GitHub's
  10,000-commit chart degradation. Alongside them: the at-a-glance **overview**
  (commits, contributors, languages, sizes — the old "Repository statistics"
  dialog, now folded in), a **GitHub Actions** success-rate and run-duration
  trend computed from runs already fetched, and a **community-health** card
  (stars, forks, watchers, README/license/templates). It also surfaces repository
  **traffic** (14-day views, clones, referrers, and popular paths — when you have
  push access), a searchable **dependencies** card from the dependency graph
  (direct vs. transitive, each linking to its registry with a description on
  hover), and quick links to the insights GitHub only renders on the web (Pulse,
  network graph, forks, dependents, Actions usage/performance, stars over time).
  Every chart ships a one-line caption, a data-table fallback, and keyboard
  navigation.

- **Manage repository files beyond pending changes.** A new **Manage files…**
  entry in the repository menu opens a dialog with two tabs. **Tracked** lists
  every file git tracks so you can untrack one that was committed by mistake —
  it stays on disk and is added to `.gitignore` so it doesn't come back.
  **Ignored** lists every file an ignore rule is hiding, showing the exact rule
  (`.gitignore:line · pattern`) responsible — so you can **force-add** a file
  that's ignored by mistake, or **remove the rule** that's ignoring it. Both
  tabs are filterable, virtualized for huge repos, multi-select (with arrow-key
  and Shift-range keyboard navigation), and confirm before anything that touches
  `.gitignore` or the index.

- **More of the app is reachable from the keyboard.** The command palette
  (Ctrl/Cmd-K) and Settings → Keyboard now include the repository-menu actions
  that were previously click-only: **manage files**, **star / unstar**,
  **repository settings**, **branch rules**, **git hooks**, **submodules**, and
  **copy repository path** — each respecting the same availability as its menu
  item, and rebindable like every other shortcut.

- **Ignore or untrack multiple files at once.** Select several files in the
  Changes list (Ctrl/Cmd-click or Shift-click) and the right-click menu now
  offers **Ignore N files** and **Untrack N files** alongside the existing bulk
  stage / discard / stash — previously these were single-file only. Untrack
  applies to the tracked files in the selection (kept on disk), and ignoring a
  batch skips any `.gitignore` lines that are already there.

- **Settings → About: a one-glance environment check.** A new **About** section
  shows your app, OS and Tauri versions plus a **Components** table for every
  command-line tool GitDesktop relies on — git, the GitHub and GitLab CLIs, and
  the Claude/Codex agent CLIs. Each row shows whether it's installed, its version
  and resolved path, and (where it applies) whether you're signed in — with a
  one-click **Install** link for anything that's missing. Several features quietly
  degrade when a CLI is absent or signed out; now the dependency is explicit.

- **Cleaner in-progress logs for GitHub Actions.** While a job is still running,
  its logs section now shows a tidy "logs appear when this job finishes" note
  with a **Watch live on GitHub** link — instead of GitHub's raw "still in
  progress" message (the API only serves a job's log once it's archived on
  completion). The moment the job finishes, its logs load in automatically — no
  need to reopen the section.

- **Syntax-highlighted code blocks in rendered markdown.** Fenced code blocks —
  in PR / issue / discussion descriptions and comments, AI review output, and
  release notes — are now syntax-highlighted with the GitHub color palette
  (light and dark), across ~190 languages. Language tags and common aliases
  (`ts`, `js`, `py`, `sh`, `yml`, `rs`…) are recognized; untagged or unknown
  blocks render as plain text, same as before.

- **Write/Preview markdown everywhere, with a formatting toolbar.** Every place
  you write markdown now has GitHub-style **Write / Preview** tabs and a
  formatting toolbar — pull request, issue and discussion comments and replies,
  comment edits, and release notes. The toolbar covers bold, italic, heading,
  quote, code, link, and bulleted / numbered / task lists, with `Ctrl+B`,
  `Ctrl+I` and `Ctrl+K` shortcuts; it wraps your current selection (or drops in
  a placeholder), and Preview renders exactly what the conversation will show.
  Rendered markdown also got a refresh — a clearer heading hierarchy with
  GitHub-style underlines, roomier spacing, and proper task-list checkboxes — so
  descriptions, comments and AI review output read the way they do on GitHub.

- **Iterative AI reviews that remember the last round.** When you re-run a code
  review or security audit on a pull request, it now builds on the previous
  one: the earlier findings and a diff of what changed since travel along as
  soft context, so the reviewer can confirm what you fixed (a "Resolved since
  last review" list) and stop re-raising the same points. The previous findings
  are treated as hints to re-verify, never as fact — the current diff stays the
  source of truth — and you stay in control: a per-mode banner lets you ignore
  the previous review for a clean pass, and a **Previous reviews** list lets you
  expand, trim a false finding before re-running, or delete past reviews. When a
  branch was rebased or the PR isn't checked out, it says so and falls back to a
  full review. Reviews that run automatically (via an automation rule) are
  remembered too, so a later manual re-run builds on them.
- **Auto re-review on new commits.** A new automation trigger, **"On new commits
  to a reviewed PR,"** watches the PRs you've already reviewed and re-runs the
  review automatically when you push new commits to one — building on the last
  review, so the new pass confirms what you fixed and focuses on what's new.
  It's opt-in per PR (it only re-reviews PRs you've reviewed at least once, not
  every open PR) and fires at most once per new head. Works for local PRs (the
  moment you commit) and for GitHub PRs (within a minute of a push) — including
  PRs whose branch isn't checked out locally. Add it under
  **Settings → Automations**.
- **Repo-aware CLI reviews read the right branch.** When a Claude Code / Codex
  review is set to read repo files for context, it now reviews the pull
  request's actual files even when that branch isn't the one you have checked
  out — GitDesktop spins up a throwaway, detached worktree at the PR's head for
  the duration of the review and cleans it up afterward, so your working branch
  never moves.
- **Close to tray / background running.** Closing the window now hides GitDesktop
  to the system tray and keeps it running, so a long AI review finishes in the
  background instead of being cut off — you get an OS notification when it's done
  and can reopen from the tray icon (right-click for Open / Quit). Prefer closing
  to quit? Turn off **Settings → General → "Keep running in the tray"**.
- **Ollama Cloud provider.** Alongside the local Ollama server, you can now use
  Ollama's hosted models (e.g. `gpt-oss:120b`, `qwen3-coder:480b`) with an API
  key from [ollama.com/settings/keys](https://ollama.com/settings/keys) — no
  local install required. The model picker lists the cloud catalog live, just
  like the other keyed providers.
- **Activity indicator for AI reviews.** A code review or security audit you
  start on a pull request no longer disappears when you switch the PR's sub-tab
  or open a different PR — it keeps running in the background, surfaced by a
  compact indicator that's hidden when nothing's happening: in the header while
  you're in a repository, and a thin strip along the bottom on the other
  screens. Open it to watch progress, cancel a run, or jump straight back to a
  finished review; the result is also waiting on the PR's Review panel when you
  return. Running reviews on several pull requests at once is paced to your
  hardware — cloud providers run many in parallel, while local CLI-agent and
  Ollama runs are capped more conservatively to your CPU — and any extras wait
  in a short queue and start automatically as running ones finish.

### Changed

- **The Insights tab does nothing until you open it.** Its repository scans and
  GitHub calls used to run in the background every time you opened a repository,
  even if you never visited the tab. They now start only when you first open
  Insights, so opening a repo is lighter.

- **Faster startup.** Analytics and the Insights charting library are no longer
  bundled into the initial app load — they load on demand (the charts the first
  time you open Insights), so the app starts quicker.

- **Staging is one whole-file view now.** The working-tree diff used to render
  each hunk as a separate card; it's now a single scrollable file view with full
  syntax highlighting and GitHub-style collapsible context — expand the unchanged
  lines around a change, then a "Collapse expanded context" control restores the
  original hunks. It keeps one-click Stage / Unstage / Discard per hunk and
  drag-to-stage for individual lines — which now spans the whole file, not just
  one hunk at a time.

### Fixed

- **The repository switcher no longer jumps when you open it.** The list groups
  your repositories by owner, and that grouping used to wait on a lookup that ran
  fresh each time the menu opened — so the list would briefly show ungrouped and
  then visibly reshuffle into its owner sections, occasionally moving a row out
  from under your cursor. Each repo's owner is now remembered, so the menu opens
  already grouped and stays put.

- **Diffs highlight with full-file context, and show expandable surrounding
  lines.** When a diff's first visible line landed in the middle of a multi-line
  comment, the code after the comment could be mis-colored (highlighted as if it
  were still inside the comment), because only the changed hunk — not the file
  around it — was handed to the highlighter. Commit, stash, new-file, and
  working-tree staging diffs now read the whole file for context, so highlighting
  is correct, and you can expand the unchanged lines above and below each change
  in place (GitHub-style), instead of just a fixed "Show full diff." Only very
  large files and truncated diffs keep the previous lightweight view.

- **Links to external pages use the pointer cursor.** Buttons and link-styled
  text that open something in your browser — the "GitHub" / "View on GitHub"
  buttons across pull requests, issues, discussions, tags, and the compare view;
  the issue sidebar's Projects/Notifications links; setup links (Download Git,
  Install GitHub CLI); the Settings privacy-policy and component-install links;
  the Actions step/run deep-links; and the linked-PR/issue rows — now show the
  hand (pointer) cursor on hover instead of the default arrow, so they read as
  the links they are. The link-styled in-app toggles (show/hide a hidden comment,
  show/hide archived, ignore a prior review) got the same treatment for
  consistency.

- **The Changes list stays fast (and stops crashing) on huge working trees.**
  Repositories with thousands of changed files used to bog down or crash the
  Changes tab. The list is now virtualized — only the visible rows are rendered —
  and the per-file right-click menu was consolidated into one shared menu instead
  of mounting a menu for every row. Selecting, filtering, and arrow-key
  navigation stay smooth no matter how many files have changed.

- **"Debug with AI" no longer cancels when you close the dialog.** The Actions
  failure-diagnosis used to stop and discard itself the moment you closed its
  window — so an accidental close threw away the analysis. Now closing just hides
  it: the run keeps streaming in the background and reopening shows the same
  (in-progress or finished) diagnosis. Only the explicit **Cancel** button stops
  a run.

- **The commit message clears instantly when you commit.** The title and
  description now empty the moment you hit Commit, instead of staying on screen
  until the commit finishes and then snapping blank — so a fast local commit
  feels snappy. If the commit fails, your message (and amend mode) comes back so
  nothing is lost.

- **Undo/redo now works in the markdown editor.** `Ctrl+Z` / `Ctrl+Y` (and
  `Ctrl+Shift+Z`) reliably undo and redo in every comment, reply, and
  description field — including formatting-toolbar actions (bold, lists, links),
  which previously couldn't be undone at all. Switching between the **Write** and
  **Preview** tabs no longer wipes your undo history either.

- **Settings → AI: "Test connection" now tests the key you've typed**, even
  before you save it — so you can verify a new API key before committing it to
  the keychain, instead of getting a "no key saved" error.

- **macOS: the Changes-list file actions use the right path.** Right-clicking a
  file and choosing **Copy file path**, **Show in Finder**, **Open in editor**,
  or **Open with default program** built a Windows-style path on macOS and
  failed. They now use the correct separator on every platform.

- **Line-by-line staging always targets the right hunk.** When two changed
  regions of a file happened to share an identical header line, selecting and
  staging individual lines could occasionally act on the wrong region. Each
  region now has a stable identity, so the lines you pick are the lines that
  stage.

- **Clearer message when AI needs a key.** Generating a pull-request description
  with AI now points you to **Settings → AI** when no API key is configured,
  instead of showing a generic error — matching the AI issue drafter.

## [0.1.0] - 2026-06-19

First release. GitDesktop is an AI-native, keyboard-first desktop Git client
built on Tauri 2; every GitHub feature runs through the GitHub CLI (`gh`).

### Added

- **Repositories** — clone, add a local repo, create one (with README,
  `.gitignore` template, and license scaffolding), publish to GitHub, and fork.
  A header repo switcher groups every repo by owner with a Recent section and a
  filter; repositories support aliases, repository and branch statistics, and
  recycle-bin-safe removal. Star or unstar a repo, and — as an admin — edit
  GitHub repo settings (description and topics with AI suggestions, merge options,
  and webhooks with delivery history) from the app.
- **Changes & commits** — a unified/split diff viewer with syntax highlighting
  and image diffing; filter the changes list by path or category; hunk- and
  line-level (drag-to-stage) staging; stage, unstage, or discard single files or
  a multi-selection from the
  context menu; untrack tracked files; and recycle-bin-safe discard. Commit with
  a 72-character title budget, co-authors suggested from history, amend, undo,
  reset, and revert; in-progress commit messages are preserved per repository and
  branch.
- **AI assistance** — streamed commit messages, branch names, pull-request and
  issue titles/descriptions (drafted from your issue templates), repository
  descriptions and topics, plus a code review or focused security audit on any PR.
  Bring your own provider: Anthropic, OpenAI, OpenRouter, local **Ollama**, or
  **keyless Claude Code / Codex CLI agents**. Global and per-repo instructions,
  gitignore-style AI-ignore patterns, and a single switch to hide every AI
  surface. API keys are stored in the OS keychain.
- **Branches** — create, switch (with a bring-changes / stash prompt), rename,
  delete, and **archive** (hide from the switcher without deleting). Per-branch
  ahead/behind counts and a PR badge in the switcher, updating a branch without
  checking it out, a Compare tab
  (three-dot diff, commits ahead/behind, merge/rebase), and local
  branch-protection rules (naming, merge methods, require-PR, force-push) that
  can be shared via a committed file or imported from GitHub.
- **History & advanced git** — paged, filterable history; a rich commit detail
  view; per-file history and line blame; cherry-pick onto the current or another
  branch (including a multi-selection); squash and reorder unpushed commits
  through an atomic replay engine; a stash browser; and submodule management.
- **Syncing** — fetch, pull, and push with ahead/behind indicators. Pull is
  `--ff-only`, and divergence routes to a guarded force push with
  `--force-with-lease`; an in-progress merge/rebase/cherry-pick shows a conflict
  banner with gated Continue and Abort.
- **Pull requests** — the full lifecycle in-app for GitHub PRs (comment, review,
  edit title/body, manage labels, merge with merge/squash/rebase, draft → ready,
  close) and for **local PRs** — the same workflow against any two branches with
  no remote, promotable to a real GitHub PR (comments included) in one click.
- **Issues & Discussions** — a tab for GitHub issues and private **local to-dos**
  (no remote needed; publishable to GitHub): browse, create, edit, and react;
  manage labels, assignees, milestones, issue type, sub-issues, dependencies
  (blocked-by / blocking), and development links (linked and closing PRs and
  branches, plus create-a-branch); and duplicate, transfer, pin, lock, or delete.
  A separate Discussions tab reads, creates, edits, reacts to, and upvotes a
  repository's GitHub Discussions.
- **Tags & releases** — a Tags tab listing every git tag with its GitHub release
  status (latest / pre-release / draft); create a tag, check it out, push, or
  delete it; and create, edit, publish, or delete GitHub releases with uploadable
  assets. Generate release notes from GitHub's commit-and-PR summary or with AI,
  with the previous tag resolved automatically (semver- and monorepo-aware) and
  a tabbed branch / recent-commit target picker.
- **GitHub Actions** — a dedicated tab listing workflow runs with live status; a
  run detail view with jobs and steps; re-run (all or failed), cancel, and
  manual workflow dispatch; inline failed-step logs; **Debug with AI**, which
  turns a failed job's logs into a root-cause + fix and a ready-to-paste agent
  prompt; a current-branch CI badge in the header; and run-completion
  notifications.
- **Git hooks** — view, edit, enable/disable, and template `.git/hooks`, with
  husky / pre-commit / lefthook detection and install integration.
- **Automations** — rules such as "on PR open → run AI review + security audit,"
  with global defaults and per-repo overrides.
- **Keyboard** — fully rebindable shortcuts with GitHub-Desktop-compatible
  defaults, a generated cheat sheet (Ctrl+/), a command palette (Ctrl+K), and
  arrow-key navigation across every list.
- **Integrations** — open in any editor or terminal (auto-detected or a custom
  executable path), and tunable OS notifications for pull-request activity,
  checks, and CI runs.
- **Auto-updates** — signed, verified updates from GitHub Releases, installed
  only on your consent, with an opt-out launch check.
- **Privacy & analytics** — anonymous, aggregate usage analytics (on by default,
  shown on first run with a one-switch opt-out; no source code, diffs, or commit
  content is captured) plus opt-in, masked session replay for diagnosing UI
  issues.

### Fixed

- Diff-renderer exceptions are caught by an error boundary instead of taking
  down the whole app.

[Unreleased]: https://github.com/theBGuy/GitDesktop/compare/v0.9.1...HEAD
[0.9.1]: https://github.com/theBGuy/GitDesktop/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/theBGuy/GitDesktop/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/theBGuy/GitDesktop/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/theBGuy/GitDesktop/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/theBGuy/GitDesktop/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/theBGuy/GitDesktop/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/theBGuy/GitDesktop/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/theBGuy/GitDesktop/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/theBGuy/GitDesktop/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/theBGuy/GitDesktop/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/theBGuy/GitDesktop/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/theBGuy/GitDesktop/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/theBGuy/GitDesktop/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/theBGuy/GitDesktop/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/theBGuy/GitDesktop/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/theBGuy/GitDesktop/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/theBGuy/GitDesktop/releases/tag/v0.1.0
