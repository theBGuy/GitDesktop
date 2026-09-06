---
name: delegate
description: >-
  Orchestrate delegated implementation in GitDesktop — the main model (Fable
  or Opus) architects, plans, and integrates; Opus subagents implement and
  review, with an experimental codex implementer lane alongside. Gated to
  Fable/Opus orchestrators (Sonnet and smaller work inline instead). Use
  whenever the user asks to delegate, fan out, or parallelize implementation
  work, says "have opus build/implement X", or hands over a well-scoped
  multi-file feature that should be built by subagents rather than inline.
  Also applies when resuming a partially delegated feature.
argument-hint: "[task description]"
---

# /delegate — Fable or Opus orchestrates, Opus (or the codex arm) implements

The division of labor: **you** (the main conversation) own architecture,
decomposition, dispatch, integration, and everything the user sees. The
**`implementer`** agent (Opus) turns written work-package specs into code; it
and the experimental **codex implementer arm** (`gpt-6-astra` via `codex exec`)
are the two sanctioned writers in this repo — the codex arm is sandbox-confined
to linked task worktrees (see `references/codex-implementer.md`). The
**`spec-reviewer`** agent (Opus, read-only) adversarially checks the result.

## Phase 0 — Gate & ground

- **Orchestrator gate.** This workflow requires a Fable- or Opus-family
  orchestrator (`claude-fable-5` or any `claude-opus-*` id) as the MAIN
  conversation model — check your own identity in your system prompt. If you
  are Sonnet, Haiku, or any smaller model: **STOP.** Tell the user /delegate
  is gated to Fable/Opus and offer to do the work inline instead. Never
  switch models to satisfy the gate; when working inline, apply the
  `subagent-discipline` skill's rituals to your own work.
- **Opus-orchestrator addendum.** If you are Opus (not Fable), you are a
  weaker orchestrator than this workflow was originally tuned for, so apply
  `subagent-discipline` to your OWN architecture, decomposition, and
  integration — not just the subagents' work. Read its
  `references/orchestrator.md` § "When the orchestrator is Opus or Sonnet"
  (you open that file for spec-shaping in Phase 1 regardless). Concretely:
  keep an epic-level constraint ledger in a scratchpad, and never accept a
  subagent's "done" as evidence — run the integration checks and read the
  load-bearing hunks yourself.
- Confirm this is an implementation session, not a grooming/planning session
  (if the user is researching or thinking out loud, produce plans instead —
  standing feedback).
- `git --no-pager status` — record the baseline. **Never skip this**; the
  Phase 5 footprint sweep depends on it. (Codex or colocated worktree packages:
  take the baseline in the task worktree — Phase 3.)
- If the task shapes or polishes UI, run the `impeccable` skill BEFORE
  decomposing — its confirmed brief becomes part of the spec (standing
  feedback; an AskUserQuestion round is not a substitute).

## Right-sizing — pick the mode before anything else

Review is never skipped; **who reviews scales.** Each avoided agent session is
~100K tokens, so this choice dominates cost:

- **Lite mode** — single package, few files: ONE implementer + your own
  orchestrator-review of the diff + one integration build. No Explore
  grounding when you already know the area; no separate reviewer. (Codex
  packages are never lite-mode — Phase 4 item 6.)
- **Full mode** — genuinely multi-file, parallelizable work: packages +
  spec-reviewer(s), everything below.
- Threshold is conservative: orchestrator self-review loses the fresh-eyes
  property that catches idiom and spec drift — when in doubt, use the
  reviewer.

## Phase 1 — Architect (in-loop; this is your job — don't delegate it)

Research with read-only fan-outs when needed: `Explore` for codebase
questions, `Plan` for competing strategies, Workflow for bigger read-only
sweeps (see Workflows below). Every research/review agent prompt must state:
**strictly read-only — no file writes, no git mutations, no test files.** The
two sanctioned writers (the `implementer` agent and the codex implementer arm)
are the only agent-side exceptions to the *file-write* rule, each only when
executing a spec — you keep the Phase 4 trivial-fix carve-out. The
no-git-mutation rule has no exceptions, for any agent, ever.

Then write one **work-package spec** per package. Keep specs tight — they are
replayed into both the implementer's and reviewer's contexts — but never
under-specified: a well-specified first turn is what buys the turn-count
savings. Before your first spec of a session, read the `subagent-discipline`
skill's `references/orchestrator.md` — its spec-shaping checklist and Sonnet
stage-prompt scaffolding compensate for the dispatched models' documented
failure modes.

```text
## Package: <name>
Objective: <one paragraph — what and why>
Files in scope: <explicit list; the implementer must not touch others>
Contracts: <types/interfaces/commands it must expose or consume>
Acceptance criteria: <checkable statements>
Verification: <SCOPED checks only — `tsc -b`; the LF-copy `__cigate__` biome ci
  gate on EVERY ts/tsx the package edits or authors (see Environment notes —
  `biome lint` alone is NOT the CI gate); the whole-project build runs once,
  orchestrator-side, at integration>
Docs-sync: <README/site/help/changelog items, or "orchestrator handles">
Out of scope: <adjacent things it must leave alone>
```

Every spec's Objective or Acceptance answers one more question: **what does this
change make newly REACHABLE?** Both arms — code paths (a cap raised, a guard
removed, a dead path revived) and interactions (state that stops resetting,
controls that become operable during transient windows, stale data that becomes
actionable). PR #207 spent eight review rounds discovering that answer post-hoc;
it is a design-time question.

## Phase 2 — Decompose

- Package file scopes must be **disjoint** — that is what makes parallel
  dispatch safe. Shared contracts (types, `src/lib/git/api.ts` shapes, Tauri
  command signatures) go in a first, sequential package; dependents follow in
  parallel.
- Rust-side and frontend-side of one feature usually split cleanly at the IPC
  boundary — pin the exact command/payload shape in both specs.
- Fewer/larger packages beat many tiny ones (less integration risk, fewer
  agent sessions).

## Phase 3 — Dispatch

- Spawn `implementer` (Agent tool, `subagent_type: "implementer"`), one
  package per agent, spec included verbatim plus any context the agent can't
  discover (branch intent, related in-flight packages, impeccable brief).
- **Route effort per package** (frontmatter `high` is the default when
  unrouted):
  `effort: "low"` for mechanical packages (docs-sync, changelog, renames);
  `effort: "xhigh"` for the single hardest package of a feature. Set via the
  Agent tool's `effort` param at dispatch.
- Parallel dispatches go in one message. Track which agent owns which files.
- Iterate with the SAME agent via SendMessage (it keeps its context) — don't
  spawn a fresh implementer to fix its own package.

### Codex implementer arm (experimental)

Routing a package to codex? Follow `references/codex-implementer.md` — recipe,
measured sandbox behavior, and the spec preamble live there. The hard rules:

- **The worktree is a prerequisite, and only the user can create it.** Codex
  routing needs a linked task worktree with `pnpm install` already run (the
  sandbox has no network, so a run cannot install anything). `git worktree` is
  off every agent whitelist, so ASK the user to create it before you dispatch,
  and take the Phase 0 baseline in it once it exists.

- **Linked task worktrees only** — the sandbox git-block does not exist in the
  main checkout, where `.git` sits inside the workspace root.
- **Never pass `--add-dir` pointing at the main repo** — one way to defeat the
  confinement from an otherwise correct dispatch; a resume that drops `-s` is
  the other.
- Feed the preamble + spec through **stdin** (heredoc), never argv.
- Set `-c model_reasoning_effort` explicitly; the default is `none`.
- Capture the `session id:` line from the run header.
- Fix rounds go through `codex exec resume (session-id)` from inside the
  worktree (`cd <worktree> && codex exec resume …` — `resume` has no `--cd`),
  not a fresh dispatch.
- **Repeat every flag the dispatch form carries on each resume** — `-m`, `-o`,
  `-s workspace-write`, `-c model_reasoning_effort`, and the network pin
  `-c sandbox_workspace_write.network_access=false`. Unspecified flags fall
  back to the machine config (measured: a dropped `-m` resumed as the config
  default), so a dropped `-s` can silently change the sandbox — read the run
  header's sandbox line before trusting it.
- Network is off under `workspace-write` by default AND pinned off by
  `-c sandbox_workspace_write.network_access=false` on every invocation, since
  a machine profile can enable it; dependencies must already be installed when
  the worktree is set up.
- The Phase 0 baseline and the Phase 5 footprint sweep run **in the task
  worktree** (`git -C <worktree> --no-pager status`). A feature split across
  Opus and codex packages colocates in ONE worktree so the sweep sees every
  package's files.

## Phase 4 — Verify (never skip; never trust the report alone)

1. **Full mode:** one whole-feature `spec-reviewer` given ALL the specs +
   touched-file lists is the DEFAULT for ≤2 coupled packages (ask for
   per-package verdicts; raise its `maxTurns` per-dispatch for large
   reviews — a capped-out reviewer returns a truncated review); use
   per-package reviewers only for larger fan-outs.
   **Lite mode:** you review the diff yourself against the spec and
   gd-conventions.
2. Run the integration checks yourself in the main loop: `pnpm build`, the
   check-only lint, and the cargo suite when Rust changed — package-level
   green doesn't guarantee the merged working tree is green.
3. UI work: dogfood live via the `drive-ui` skill — edge cases (first/last/
   empty, boundaries) and visual polish, before declaring done.
4. **Batch fix rounds:** collect ALL findings for a package into ONE message
   to the owning agent (every extra round replays its whole context — ~100k
   tokens even for a one-line diff). Re-review = the delta + prior findings
   only, not the full protocol again. The delivery path follows the dispatch
   path: an Opus package takes one SendMessage; a codex package takes one
   stdin message via `cd (worktree) && codex exec resume (session-id)` with
   the flags repeated — SendMessage reaches Agent-tool dispatches only.
5. **Trivial-fix exception (user-authorized 2026-07-02):** the orchestrator
   may apply a trivial fix directly instead of a fix round — ≤ ~3 lines,
   confirmed by the spec-reviewer or by live validation, and changing no
   contract, API, or design. Disclose every such fix in the report and re-run
   the package's verification. Anything beyond trivial still round-trips to
   the owning implementer; this never loosens the no-git-mutation rule.
6. **Codex packages always get a `spec-reviewer` pass** while the arm is
   experimental (lite-mode orchestrator self-review stays available for Opus
   packages only), plus the integration checks in the main loop. Its `-o`
   report file is the analogue of an agent report and earns the same skepticism.

## Phase 5 — Close out

- Docs-sync complete (README, site, help content, CHANGELOG — per CLAUDE.md).
- Footprint sweep: `git --no-pager status` against the Phase 0 baseline —
  every difference is accounted for by a package or the user's own parallel
  work; nothing stray, nothing staged, no probe/scratch files left behind.
  (Codex or colocated worktree packages: sweep the task worktree — Phase 3.)
- Report to the user: outcome first, then per-package summary, verification
  results verbatim, and open concerns. **Never commit — the user commits.**

## When things go wrong

- **Package blocked** (spec wrong, dependency missing): resolve it yourself —
  rewrite the spec or implement that piece inline — don't ask the agent to
  improvise around it.
- **Reviewer verdict "rework":** the approach is wrong, so rewrite the SPEC
  first; then redispatch — to the same agent if the correction is
  communicable, to a fresh implementer if the old approach would anchor it.
- **Scope collision** (two packages need the same file): serialize them;
  re-issue the later spec against the post-merge state of that file.
- **An agent stops without a usable report:** check its file scope with
  `git --no-pager status`, then SendMessage "produce your report now"; if
  resume fails, spawn fresh with the spec + a summary of the prior state.
- **An agent mutated git state despite the rules:** stop all dispatches, do
  not attempt cleanup, report exactly what happened to the user and wait for
  direction.

## Workflows (the Workflow tool) — read-only stages only

- Read-only fan-outs via `agent(prompt, {agentType: 'spec-reviewer'})` are
  supported — the same agent registry resolves, with per-call `model` /
  `effort` overrides available. Good for review panels and research sweeps.
- **Never dispatch `implementer` via Workflow.** Workflow agents run in the
  background where no permission prompt can surface — the run burns a full
  read-and-plan session and dies at its first Edit.
- Background agents get silent DENIALS for anything off the allowlist — tell
  Workflow-spawned reviewers to treat tool denials as environment limits
  (note and continue), never as findings or reasons to stall.
- SendMessage-resume is validated only for foreground Agent-tool dispatches;
  follow-ups to Workflow-spawned agents go via fresh dispatch.

## Environment notes (hard-won; trust these)

- Agent definitions normally register at **session start** (observed
  hot-loading mid-session once — don't count on it). If `implementer` /
  `spec-reviewer` aren't in the available-agents list, restart the session or
  use `/agents`. Skills hot-load reliably.
- **First dispatch of a session doubles as a smoke test.** Start with the
  smallest package. If the harness denies the implementer's Write, don't
  fight it: implement that package inline from the same spec and note the
  environment limit to the user.
- Subagents receive CLAUDE.md and the session-start memory snapshot
  automatically; they do NOT see mid-session memory edits or your
  conversation. Everything a package needs must be in its spec.
- **Worktree runs** (validated 2026-07-02; format-gate form hardened across
  several CI reds since): fresh worktrees check out CRLF (`core.autocrlf=true`),
  so tree-wide `biome check`/`ci` false-fails on formatting noise. The reliable
  worktree gates are `tsc -b`, `pnpm build`, and — for EVERY ts/tsx a package
  edits or authors, in every spec and every fix round — the LF-copy `biome ci`
  form: copy the file LF-normalized to `__cigate__<name>` beside the original
  (so config resolves; or a temp dir with `--config-path=.`), run literal
  `pnpm exec biome ci` on the copy, delete it. `biome lint` alone is NOT the CI
  gate (it skips the formatter and assists), `--formatter-enabled=false`
  disables exactly the layer under test, and stdin modes both skip assists AND
  echo their input, so an output-vs-input diff can never fail. Negative-control
  the gate once per session: an over-wrapped line appended to a copy must go
  red. Deps need `pnpm install` first. If the main checkout advances
  mid-run, the final patch may not apply clean — re-apply divergent hunks by
  hand against current HEAD. Clean up with `git worktree remove` + `prune`
  (Windows: node_modules may need `cmd /c rd /s /q` afterwards).
