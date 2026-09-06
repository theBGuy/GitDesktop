# Codex implementer arm (experimental)

**Status:** experimental, owner-ratified 2026-09-06. The codex CLI
(`codex-cli` 0.153.3) driving **`gpt-6-astra`** is a second sanctioned writer in
this repo alongside the Opus `implementer` agent — nothing else about /delegate
changes. Codex packages get the same work-package spec, the same
`spec-reviewer` (Opus) pass, and the same orchestrator integration gates as
Opus packages. The arm exists because the codex reviewer-lane pilot showed
classes astra finds well; treat every dispatch as evidence for or against
keeping it.

## Routing — which packages go to codex

- Astra's proven niche from the reviewer-lane pilot: **platform/encoding/parser
  and reachability-regime classes on fresh surfaces.** Start it on
  self-contained packages — pure-logic Rust, wire/serde shapes, scripts, test
  fixtures, CI plumbing.
- **Opus keeps idiom-dense React/UI packages.** The repo-idiom playbooks
  (`gd-conventions`, the frontend rules) are preloaded into the Opus agents and
  reach codex only through cold file reads, so idiom drift is the expected
  failure mode there.
- **The first codex dispatch of any adoption phase doubles as the smoke test** —
  smallest package first, before anything depends on the lane working.

## Astra behavior notes (OpenAI model guidance, fetched 2026-09-06)

- **Asks for clarification more readily than prior GPT models.** Headless `exec`
  has nobody to answer, which is why the preamble grants authorization up front
  and says to decide and note. OpenAI's recommended counter-phrasing: "You don't
  need user permission for reversible tasks, read-only actions, reviews or
  fixes, or anything for which authorization is provided earlier in the
  session."
- **Over-verifies small changes.** The official calibration line:
  "Do not write tests for reversible, low-impact changes that mirror the implementation".
  The spec's Verification field is authoritative — run exactly that list.
- **More sensitive to instruction files** (`AGENTS.md`, skill files) than prior
  models: every rule it reads gets enforced hard, so rules stay short, accurate,
  and non-vague —
  "A short, accurate AGENTS.md is more useful than a long file full of vague rules".
  Audit wording changes to either file with that in mind.
- **Reasoning effort** runs none (the default — never leave it) / low / medium /
  high / xhigh: low for well-scoped mechanical packages, high as the
  implementer-package default, xhigh for long reasoning-heavy ones — the routing
  shape /delegate already uses for Opus effort.
- **Default output is verbose and markdown-heavy**, hence the plain-prose report
  line in the preamble.
- **Reader-facing copy:** OpenAI's guidance discourages contrastive framing and
  stock phrases, converging with this repo's reader-facing-prose rules in
  `CLAUDE.md`. The repo rules still govern and still get swept.

Sources:

- https://developers.openai.com/api/docs/guides/latest-model
- https://learn.chatgpt.com/guides/best-practices

## Dispatch recipe

Prompt goes in over **stdin**, never argv: argv is capped near 32 KB and the
`.cmd` shim mangles newline-containing arguments. The heredoc forms on this page
are POSIX shell — on this Windows machine run them through the Bash tool, never
PowerShell.

**Assert the workspace root before dispatching:**
`(task-worktree-path)/.git` must be a **file** (the `gitdir:` pointer that marks
a linked worktree). A `.git` **directory** means the root is main-checkout
shaped — abort the dispatch rather than fix the flags.

Then, one command (continuations are for the page width):

```sh
codex exec --cd (task-worktree-path) -m gpt-6-astra -s workspace-write \
  -c model_reasoning_effort="high" \
  -c sandbox_workspace_write.network_access=false \
  -o (scratchpad)/(package)-report.md - <<'EOF'
... preamble + spec ...
EOF
```

- **`--cd` takes an absolute path.** A relative `--cd` resolves against the
  shell's cwd, and a run rooted at the main checkout has `.git` inside its
  workspace, where the sandbox permits git mutations.
- `(scratchpad)` is the session scratchpad directory and `(package)` the package
  name — the report file never lands in the repo.
- **Set `-c model_reasoning_effort` on every dispatch.** The default prints
  `none` in the run header.
- The run header also prints a **`session id:`** line. Capture it — it is the
  only handle on the session.
- `--output-schema (file)` exists for typed reports. Available, **not yet
  validated here**; the markdown report via `-o` is the current path.

## Fix rounds

Batch all findings for a package into one message and resume the same session.
The message goes in over stdin exactly like the dispatch, for the same
argv-cap reason — batched findings are long:

```sh
cd (task-worktree-path) && codex exec resume (session-id) \
  -m gpt-6-astra -s workspace-write \
  -c model_reasoning_effort="high" \
  -c sandbox_workspace_write.network_access=false \
  -o (scratchpad)/(package)-fix1-report.md - <<'EOF'
... batched findings ...
EOF
```

**`resume` has no `--cd` flag** — it roots at the shell's cwd, so every resume
runs from inside the worktree in one Bash-tool command, as above. Read the
resume header's workdir line as the per-run check that it rooted where you
meant.

**Repeat every flag the dispatch form carries on each resume** — the pin
`-c sandbox_workspace_write.network_access=false` included, alongside `-m`,
`-o`, `-s`, and `-c model_reasoning_effort`. Flags do not reliably carry over.
Measured: a session dispatched without `-m` resumed as the config's default
model at its configured effort, so a resume can silently run a different model
than the dispatch did. Resume prints the full run header (model, effort,
sandbox, session id); read it as the truth for what the run actually used.

`--last` is safe only while a single codex session is in flight; with more than
one, resume by id. The session listing is cwd-filtered by default (`--all`
disables the filter), so a `--last` issued from the right worktree cwd already
scopes to that worktree's sessions — one more reason the `cd` matters. Measured:
a resumed session retained knowledge of files it had created earlier without
re-reading them, and the AGENTS.md instruction persisted across the resume.

Resume re-runs the trust / git-repo check rather than inheriting
`--skip-git-repo-check` from the original invocation, so resuming outside a git
repo fails with:

```text
Not inside a trusted directory and --skip-git-repo-check was not specified.
```

Irrelevant for task worktrees, which are git repos — but don't misread it as a
broken session while smoke-testing in a scratch directory.

## Measured sandbox behavior (2026-09-05, linked worktree)

- File writes inside the worktree **succeed**. Git **reads** (`status`, `log`,
  `diff`) work.
- **Commands that write the git dir are denied.** Measured blocked: `git add`,
  `git commit`, `git checkout -- (file)`, `git rm --cached (file)`, and
  `git stash push`, each on the out-of-workspace index lock:

  ```text
  fatal: Unable to create '(main-repo)/.git/worktrees/(wt)/index.lock': Permission denied
  ```

  A linked worktree's real git dir lives outside the workspace root, so the
  sandbox blocks the write the index lock needs.
- **Commands that touch only worktree files are not denied.** Measured
  permitted: `git clean -n` and `git clean -fd` — the `-fd` run deleted the
  probe's untracked file, with only benign config-read warnings. So the sandbox
  is no guard for untracked WIP; the no-git-mutation policy is.
- **HARD RULE: dispatch codex only in linked task worktrees, never in the main
  checkout.** There `.git` sits inside the workspace root and even the git-dir
  writes would be permitted. That block is what keeps the no-git-mutation rule
  enforced rather than merely stated for the git-dir-writing subset; every other
  mutation — `git clean` being the measured counterexample — rests on the policy
  alone. For the same reason, never pass `--add-dir` pointing at the main repo.
- **Network is off** under `workspace-write` by default, and pinned off
  explicitly by the forms above — a machine profile can turn it on
  (`sandbox_workspace_write.network_access=true`), which is why the flag rides
  every invocation. With it off, `pnpm install` fails, so dependencies must be
  pre-installed when the worktree is set up (already the /delegate pattern).
- The sandbox may emit benign Permission-denied warnings while reading
  out-of-workspace config (measured on `~/.config/git/ignore`). Not findings.
- `AGENTS.md` at the workspace root is auto-read by codex (measured with a
  marker token), which is why the repo ships one.
- A machine may layer a global `~/.codex/AGENTS.md` under the repo one: codex
  loads both, and the more specific file takes precedence — the repo `AGENTS.md`
  wins any conflict, the global one only fills machine-wide gaps. The owner's
  machine has one, exposing user-global rule files as pointers, and the
  sandbox permits reading them (both probed 2026-09-06), so the repo file need
  not duplicate machine-global rules.

## Run lifecycle

- **A killed or timed-out run leaves partial edits.** Diagnose with
  `git -C (worktree) --no-pager status` and `git -C (worktree) --no-pager diff`
  before resuming or redispatching; a half-applied package looks like a fresh
  one to the next run.
- **Windows kills don't tree-kill.** Kill the codex node process and verify it
  is gone before treating the worktree as free.
- **One codex session per worktree at a time** — concurrent sessions share the
  working tree and overwrite each other's edits.
- Resume by the captured session id. `--last` is only safe while a single
  session is in flight.
- Runs consume the owner's ChatGPT subscription. A run that dies on expired auth
  must be **flagged for `codex login`**, never silently skipped or retried into
  the void.

## Watch items

- Implementer-length runs are untested against plan limits — the free tier once
  died mid-review on a 26-file diff. Watch for truncated or missing reports on
  long packages and report the suspicion.

## Preamble — paste above every codex spec

```text
You are executing one work-package spec in a linked task worktree of
GitDesktop. Binding context, in order: AGENTS.md (auto-loaded), CLAUDE.md, and
.claude/skills/gd-conventions/SKILL.md — read the latter two before writing
anything.

- Stay strictly inside the spec's "Files in scope". A spec conflict, or a fix
  that needs another file, is reported back — never improvised around. Nobody
  can answer questions mid-run, so for in-scope implementation choices (naming,
  placement, minor idiom) pick a reasonable option and note it in the report;
  you do not need permission for work the spec already authorizes.
- Make the smallest change that satisfies the acceptance criteria.
- No scratch or temp files inside the repo.
- Git mutations are forbidden; the sandbox additionally blocks the git-dir
  writers. Read-only git only (diff / status / log / show, branch --list).
- A Permission-denied on a path outside the workspace is an environment limit:
  report it and continue.
- Lint-fix only the files you touched, using the command the spec's
  Verification field names. NEVER pnpm lint — it rewrites all of src/ and
  site/. In a fresh worktree, never judge formatting from a tree-wide check:
  the CRLF checkout false-fails files you never edited. The trustworthy form is
  the LF-copy biome ci gate the spec names for each ts/tsx you edit.
- Run exactly the spec's Verification commands and quote any failure verbatim.
  Do not invent broader test scaffolding for small, reversible changes.
- Your final message is the report: Outcome (one sentence) / Changes (per file)
  / Verification (each command with its actual result) / Deviations & concerns.
  Write it in plain prose sentences — no tables, no decorative formatting.
```
