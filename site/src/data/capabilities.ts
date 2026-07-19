// Single source of truth for the capability catalog. The /features page renders
// every entry, grouped by `group`; the home page renders the `highlight` subset
// as "everything else you'd reach for". `ai: true` entries are the hide-AI set —
// on the site they live under [data-view="ai"] so "Just Git" hides them wholesale
// (kept out of the non-AI groups so no group empties out in that view).
//
// Keep labels SHORT and scannable — one atomic capability each, not a paragraph.
// This mirrors the app's real feature set (see README Highlights/Features); when
// a feature ships or changes, update the matching entry here in the same change.

export interface Capability {
  label: string;
  group: string;
  /** AI feature — hidden in the "Just Git" view. */
  ai?: boolean;
  /** Surfaced in the home page's curated highlights. */
  highlight?: boolean;
}

// Non-AI groups render in both views, in this order; AI groups follow, gated.
export const GROUP_ORDER = [
  "Diffs & staging",
  "Branches & history",
  "Rewrite & recovery",
  "Pull requests & review",
  "Forges & trackers",
  "Issues & discussions",
  "CI, tags & releases",
  "Repository & workspace",
  "Admin & settings",
  "Keyboard & Markdown",
  "AI · generate & review",
  "AI · agents & sessions",
  "AI · MCP & providers",
] as const;

export const capabilities: Capability[] = [
  // — Diffs & staging —
  { group: "Diffs & staging", label: "Unified & split diffs, syntax-highlighted in ~190 languages" },
  { group: "Diffs & staging", label: "Line, hunk & file staging — drag across the line numbers" },
  { group: "Diffs & staging", label: "Stage or discard part of a brand-new, untracked file" },
  { group: "Diffs & staging", label: "Image diffing & collapsible surrounding context" },
  { group: "Diffs & staging", label: "Filter the changes list by path or category" },
  { group: "Diffs & staging", label: "Commit with co-authors suggested from history; amend, undo, revert" },
  { group: "Diffs & staging", label: "Recoverable, recycle-bin discards" },

  // — Branches & history —
  { group: "Branches & history", label: "Branch compare — ahead/behind, three-dot diff, jump to PR", highlight: true },
  { group: "Branches & history", label: "Update a branch from its upstream — no checkout needed" },
  { group: "Branches & history", label: "Push or publish a branch to any remote — no checkout needed" },
  { group: "Branches & history", label: "Start a branch from any base — another local branch or a remote ref" },
  { group: "Branches & history", label: "Check out or delete remote-only branches from the switcher" },
  { group: "Branches & history", label: "Archive branches — hide from the switcher without deleting" },
  { group: "Branches & history", label: "Clean up branches in bulk — archive or delete stale ones in one sweep", highlight: true },
  { group: "Branches & history", label: "Paged, filterable commit history with rich detail" },
  { group: "Branches & history", label: "File history & line blame" },
  { group: "Branches & history", label: "Commit-author avatars in history" },
  { group: "Branches & history", label: "Unpushed commits flagged in history" },

  // — Rewrite & recovery —
  { group: "Rewrite & recovery", label: "Interactive rebase — reword / squash / fixup / edit / drop / reorder, atomic replay", highlight: true },
  { group: "Rewrite & recovery", label: "Change base — replay only a branch's own commits onto a new base" },
  { group: "Rewrite & recovery", label: "Cherry-pick commits onto the current or another branch" },
  { group: "Rewrite & recovery", label: "Merge preview — fast-forward / clean / which files conflict, before you merge", highlight: true },
  { group: "Rewrite & recovery", label: "In-app conflict editor — current / incoming / both" },
  { group: "Rewrite & recovery", label: "Stash browser" },
  { group: "Rewrite & recovery", label: "Recover lost work — git fsck for orphaned stashes, restored non-destructively", highlight: true },
  { group: "Rewrite & recovery", label: "Operation journal — records risky ops & recovers if one is interrupted" },

  // — Pull requests & review —
  { group: "Pull requests & review", label: "GitHub PRs + private, offline local PRs", highlight: true },
  { group: "Pull requests & review", label: "Local-PR merges pre-show conflicts, resolved in an isolated worktree" },
  { group: "Pull requests & review", label: "Set labels & assignees when you open a PR/MR (GitHub & GitLab)" },
  { group: "Pull requests & review", label: "Request reviewers on a PR/MR (GitHub, GitLab & Bitbucket)" },
  { group: "Pull requests & review", label: "Inline review comments — reply, resolve, apply suggestions locally", highlight: true },
  { group: "Pull requests & review", label: "Compose a review from the diff — batch drafts, submit with a verdict" },
  { group: "Pull requests & review", label: "Drill into a PR's commits — per-file diffs, whole-commit & line comments" },
  { group: "Pull requests & review", label: "PR activity feed — reviews, comments, grouped commits, stale-approval marks, all timestamped" },
  { group: "Pull requests & review", label: "Comment on commits from History — whole-commit or line-anchored" },
  { group: "Pull requests & review", label: "Fork · Upstream lens — browse & work a fork's PRs and issues or the parent's" },

  // — Forges & trackers —
  { group: "Forges & trackers", label: "GitHub, GitLab & Bitbucket — first-class, each on its own identity", highlight: true },
  { group: "Forges & trackers", label: "GitHub Enterprise — same features, via gh" },
  { group: "Forges & trackers", label: "Multiple accounts, switch the active one per host" },
  { group: "Forges & trackers", label: "Sign in & reconnect in-app — session-expired detection & token-expiry warnings" },
  { group: "Forges & trackers", label: "Repo switcher — forge logo & visibility badge per row, grouped by owner" },
  { group: "Forges & trackers", label: "Jira Cloud — link a project, browse & work issues in-app", highlight: true },
  { group: "Forges & trackers", label: "Jira keys in branches, commits & PRs link back to the Issues tab" },

  // — Issues & discussions —
  { group: "Issues & discussions", label: "GitHub issues & private local to-dos" },
  { group: "Issues & discussions", label: "Code TODOs — scan TODO/FIXME/HACK comments, jump to blame, promote to an issue" },
  { group: "Issues & discussions", label: "Issue types, sub-issues & dependencies" },
  { group: "Issues & discussions", label: "GitHub Discussions — read, post & react" },

  // — CI, tags & releases —
  { group: "CI, tags & releases", label: "GitHub Actions — runs, jobs, steps, re-run, cancel & dispatch", highlight: true },
  { group: "CI, tags & releases", label: "CI checks rollup — pass/fail/pending/skipped, live step progress on running Actions checks" },
  { group: "CI, tags & releases", label: "Tags, releases & cross-platform assets" },
  { group: "CI, tags & releases", label: "Insights graphs — commit activity, churn & more, computed locally" },

  // — Repository & workspace —
  { group: "Repository & workspace", label: "Clone, add local, create (README/.gitignore/license) or fork" },
  { group: "Repository & workspace", label: "Update a fork from its upstream — fetch, then fast-forward or merge" },
  { group: "Repository & workspace", label: "Detach from a fork — remove the upstream remote; leave the fork network on GitHub, GitLab, or Bitbucket (in-app on GitLab)" },
  { group: "Repository & workspace", label: "Publish a local repo to GitHub, GitLab or Bitbucket" },
  { group: "Repository & workspace", label: "Worktree manager — create, switch, promote & remove", highlight: true },
  { group: "Repository & workspace", label: "Submodule status & update" },
  { group: "Repository & workspace", label: "Manage tracked & ignored files" },
  { group: "Repository & workspace", label: "--force-with-lease by default" },
  { group: "Repository & workspace", label: "Auto-fetch — quiet background sync, never auto-pulls", highlight: true },
  { group: "Repository & workspace", label: "Activity & notifications inbox — never miss a finished review or check", highlight: true },
  { group: "Repository & workspace", label: "Environment & CLI health check" },
  { group: "Repository & workspace", label: "Remembers window size & position" },

  // — Admin & settings —
  { group: "Admin & settings", label: "Repo settings & webhooks (admin)" },
  { group: "Admin & settings", label: "Collaborators & invitations (admin)" },
  { group: "Admin & settings", label: "Branch rulesets — create, edit, enable/disable (admin)" },
  { group: "Admin & settings", label: "Code security & analysis toggles (admin)" },
  { group: "Admin & settings", label: "Danger zone — rename, archive, visibility, transfer, delete (admin)" },
  { group: "Admin & settings", label: "GitHub Pages — source, custom domain, HTTPS (admin)" },
  { group: "Admin & settings", label: "Actions/Dependabot/Codespaces secrets & variables (admin)" },
  { group: "Admin & settings", label: "Edit the Sponsor button (.github/FUNDING.yml)" },
  { group: "Admin & settings", label: "Branch-protection rules, locally" },
  { group: "Admin & settings", label: "Git hooks manager — husky / pre-commit / lefthook aware" },
  { group: "Admin & settings", label: "Edit git config — identity, default branch, line endings" },

  // — Keyboard & Markdown —
  { group: "Keyboard & Markdown", label: "Command palette + rebindable keys", highlight: true },
  { group: "Keyboard & Markdown", label: "Arrow-key navigation on every list" },
  { group: "Keyboard & Markdown", label: "Generated shortcut cheat sheet" },
  { group: "Keyboard & Markdown", label: "GitHub-Desktop-compatible defaults" },
  { group: "Keyboard & Markdown", label: "Markdown editor — formatting toolbar & live preview", highlight: true },

  // — AI · generate & review —
  { group: "AI · generate & review", ai: true, label: "Generated commit messages, PR & issue titles/descriptions", highlight: true },
  { group: "AI · generate & review", ai: true, label: "AI suggests PR/MR labels from your repo's existing set" },
  { group: "AI · generate & review", ai: true, label: "AI issue drafting from your repo's templates" },
  { group: "AI · generate & review", ai: true, label: "AI repo descriptions & topics" },
  { group: "AI · generate & review", ai: true, label: "AI code review & security audit on any PR", highlight: true },
  { group: "AI · generate & review", ai: true, label: "Agentic review — reads the full diff, files, search & history, read-only" },
  { group: "AI · generate & review", ai: true, label: "Reviews keep running in the background & finish in the tray" },
  { group: "AI · generate & review", ai: true, label: "Iterative reviews build on the last round & other bots' findings" },
  { group: "AI · generate & review", ai: true, label: "Re-reviews remember the discussion — triage replies honored, context sized to your model" },
  { group: "AI · generate & review", ai: true, label: "AI reviews are clearly machine-authored — post as a GitLab project bot" },
  { group: "AI · generate & review", ai: true, label: "Automations — review or audit on commit, PR open, or new commits" },
  { group: "AI · generate & review", ai: true, label: "Resolve merge conflicts with AI — review the proposal, then accept" },
  { group: "AI · generate & review", ai: true, label: "Debug failed CI with AI — logs to a root-cause & fix" },

  // — AI · agents & sessions —
  { group: "AI · agents & sessions", ai: true, label: "Delegate a task to a Claude, Codex, Copilot or opencode agent", highlight: true },
  { group: "AI · agents & sessions", ai: true, label: "Watch the agent work step by step, with an inline diff per edit" },
  { group: "AI · agents & sessions", ai: true, label: "Best-of-N — run one task across agents/models, keep the best" },
  { group: "AI · agents & sessions", ai: true, label: "Run agents in a Docker/Podman sandbox (opt-in)" },
  { group: "AI · agents & sessions", ai: true, label: "Add per-repo tools to the agent container via a custom image" },
  { group: "AI · agents & sessions", ai: true, label: "Integrated terminal in each session (host & container)" },
  { group: "AI · agents & sessions", ai: true, label: "Research a topic with web search — Brainstorm & Deep research, cited" },
  { group: "AI · agents & sessions", ai: true, label: "Plan a task into an agent-ready issue (read-only)" },
  { group: "AI · agents & sessions", ai: true, label: "Hand an issue or plan to an agent to implement" },
  { group: "AI · agents & sessions", ai: true, label: "Agent sessions — tabs, search & completion alerts" },
  { group: "AI · agents & sessions", ai: true, label: "Slash commands & skills in the agent composer" },

  // — AI · MCP & providers —
  { group: "AI · MCP & providers", ai: true, label: "Use GitDesktop as an MCP server — read-only default, opt-in write ladder", highlight: true },
  { group: "AI · MCP & providers", ai: true, label: "Trigger GitDesktop's AI generation from an external MCP client" },
  { group: "AI · MCP & providers", ai: true, label: "Bring your own MCP servers, opted in per session" },
  { group: "AI · MCP & providers", ai: true, label: "Browse the official MCP registry to add servers" },
  { group: "AI · MCP & providers", ai: true, label: "Bring your own model — Anthropic, OpenAI, OpenRouter, Ollama, or a keyless agent CLI (generation & review)" },
  { group: "AI · MCP & providers", ai: true, label: "Point AI at a custom or LAN Ollama / OpenAI-compatible server" },
  { group: "AI · MCP & providers", ai: true, label: "Keys live in your OS keychain; one switch hides every AI surface" },
];

export const highlightCapabilities = capabilities.filter((c) => c.highlight);
