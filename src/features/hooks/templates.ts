/** A ready-made hook script the user can install with one click. */
export interface HookTemplate {
  id: string;
  name: string;
  description: string;
  /** Which hook this targets (matches a hook name in the list). */
  hook: string;
  body: string;
}

export const HOOK_TEMPLATES: HookTemplate[] = [
  // ── pre-commit ─────────────────────────────────────────────────────────
  {
    id: "protected-branch",
    name: "Block commits to protected branches",
    description: "Refuse direct commits on main / master / release.",
    hook: "pre-commit",
    body: `#!/bin/sh
# Block direct commits to protected branches — use a feature branch + PR.
protected="main master release"
# Empty on a detached HEAD, which matches no protected name.
head=$(git symbolic-ref --quiet HEAD)
branch=\${head#refs/heads/}
for b in $protected; do
  if [ "$branch" = "$b" ]; then
    echo "Direct commits to '$branch' are blocked. Use a feature branch and a pull request." >&2
    exit 1
  fi
done
`,
  },
  {
    id: "block-large-files",
    name: "Block large files",
    description: "Refuse staged files over 5 MB.",
    hook: "pre-commit",
    body: `#!/bin/sh
# Block committing files larger than the limit (default 5 MB).
limit=$((5 * 1024 * 1024))
fail=0
for file in $(git diff --cached --name-only --diff-filter=AM); do
  [ -f "$file" ] || continue
  size=$(wc -c < "$file")
  if [ "$size" -gt "$limit" ]; then
    echo "$file is over the $((limit / 1024 / 1024)) MB limit." >&2
    fail=1
  fi
done
exit $fail
`,
  },
  {
    id: "run-lint",
    name: "Run lint before committing",
    description: 'Runs the package.json "lint" script if one exists.',
    hook: "pre-commit",
    body: `#!/bin/sh
# Run the project's lint script before committing, if one exists.
if [ -f package.json ] && grep -q '"lint"' package.json; then
  npm run -s lint || {
    echo "Lint failed. Fix the issues, or commit with --no-verify to skip." >&2
    exit 1
  }
fi
`,
  },

  // ── prepare-commit-msg ─────────────────────────────────────────────────
  {
    id: "prefix-issue-key",
    name: "Prefix message with issue key",
    description: "Prepend the branch's ABC-123 key to the commit message.",
    hook: "prepare-commit-msg",
    body: `#!/bin/sh
# Prepend the branch's issue key (e.g. ABC-123) to the commit message.
case "$2" in merge|squash|commit) exit 0 ;; esac
head=$(git symbolic-ref --quiet HEAD)
branch=\${head#refs/heads/}
key=$(printf '%s' "$branch" | grep -oE '[A-Z]+-[0-9]+' | head -n1)
if [ -n "$key" ] && ! grep -q "$key" "$1"; then
  sed -i.bak "1s/^/$key /" "$1" && rm -f "$1.bak"
fi
`,
  },

  // ── commit-msg ─────────────────────────────────────────────────────────
  {
    id: "conventional-commit",
    name: "Conventional Commits",
    description: "Validate the message matches type(scope)?!: subject.",
    hook: "commit-msg",
    body: `#!/bin/sh
# Enforce Conventional Commits, e.g. "feat(api): add login".
msg=$(head -n1 "$1")
case "$msg" in
  "Merge "*|"Revert "*|"fixup! "*|"squash! "*) exit 0 ;;
esac
pattern='^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)([(][a-z0-9_/.-]*[)])?!?: .+'
if ! printf '%s' "$msg" | grep -Eq "$pattern"; then
  echo "Commit message must follow Conventional Commits, e.g. 'feat(api): add login'." >&2
  echo "  Got: $msg" >&2
  exit 1
fi
`,
  },

  // ── post-commit ────────────────────────────────────────────────────────
  {
    id: "warn-large-commit",
    name: "Warn on large commits",
    description: "Note when a commit touches a lot of files.",
    hook: "post-commit",
    body: `#!/bin/sh
# Warn (post-commit can't block) when a commit touches many files.
n=$(git show --name-only --pretty=format: HEAD | grep -c .)
if [ "$n" -gt 50 ]; then
  echo "That commit touched $n files — consider smaller, focused commits." >&2
fi
`,
  },

  // ── pre-merge-commit ───────────────────────────────────────────────────
  {
    id: "block-conflict-markers",
    name: "Block unresolved conflicts",
    description: "Stop a merge with conflict markers or whitespace errors.",
    hook: "pre-merge-commit",
    body: `#!/bin/sh
# Block a merge commit that still has conflict markers or whitespace errors.
if ! git diff --cached --check; then
  echo "Refusing to merge: fix conflict markers / whitespace errors first." >&2
  exit 1
fi
`,
  },

  // ── post-merge ─────────────────────────────────────────────────────────
  {
    id: "reinstall-after-merge",
    name: "Reinstall deps on lockfile change",
    description: "Run install when a lockfile changed in the merge.",
    hook: "post-merge",
    body: `#!/bin/sh
# Reinstall dependencies when a lockfile changed in the merge.
if git diff-tree -r --name-only ORIG_HEAD HEAD | grep -qE '(package-lock[.]json|pnpm-lock[.]yaml|yarn[.]lock)$'; then
  echo "Lockfile changed — installing dependencies..."
  if [ -f pnpm-lock.yaml ]; then pnpm install
  elif [ -f yarn.lock ]; then yarn install
  else npm install; fi
fi
`,
  },

  // ── post-checkout ──────────────────────────────────────────────────────
  {
    id: "reinstall-after-checkout",
    name: "Reinstall deps on branch switch",
    description: "Run install when a lockfile differs after switching.",
    hook: "post-checkout",
    body: `#!/bin/sh
# On a branch switch, reinstall deps if a lockfile changed.
[ "$3" = "1" ] || exit 0
if git diff-tree -r --name-only "$1" "$2" | grep -qE '(package-lock[.]json|pnpm-lock[.]yaml|yarn[.]lock)$'; then
  echo "Lockfile changed across branches — installing dependencies..."
  if [ -f pnpm-lock.yaml ]; then pnpm install
  elif [ -f yarn.lock ]; then yarn install
  else npm install; fi
fi
`,
  },

  // ── pre-rebase ─────────────────────────────────────────────────────────
  {
    id: "protect-rebase",
    name: "Block rebasing shared branches",
    description: "Refuse to rebase main / master / release / develop.",
    hook: "pre-rebase",
    body: `#!/bin/sh
# Refuse to rebase shared branches — it rewrites history others rely on.
branch="$2"
if [ -z "$branch" ]; then
  head=$(git symbolic-ref --quiet HEAD)
  branch=\${head#refs/heads/}
fi
case "$branch" in
  main|master|release|develop)
    echo "Refusing to rebase '$branch' — rebasing a shared branch rewrites history." >&2
    exit 1 ;;
esac
`,
  },

  // ── post-rewrite ───────────────────────────────────────────────────────
  {
    id: "force-push-reminder",
    name: "Remind to force-push",
    description:
      "Note after amend/rebase that pushed commits need a force-push.",
    hook: "post-rewrite",
    body: `#!/bin/sh
# After amend/rebase, note how many commits were rewritten.
n=$(wc -l)
if [ "$n" -gt 0 ]; then
  echo "Rewrote $n commit(s). If they were already pushed, a force-push is needed." >&2
fi
`,
  },

  // ── pre-push ───────────────────────────────────────────────────────────
  {
    id: "protect-push",
    name: "Block pushing to protected branches",
    description: "Refuse direct pushes to main / master / release.",
    hook: "pre-push",
    body: `#!/bin/sh
# Block pushing directly to a protected branch — open a pull request instead.
protected="main master release"
while read -r local_ref local_oid remote_ref remote_oid; do
  name=$(printf '%s' "$remote_ref" | sed 's#refs/heads/##')
  for b in $protected; do
    if [ "$name" = "$b" ]; then
      echo "Refusing to push directly to '$name'. Open a pull request instead." >&2
      exit 1
    fi
  done
done
exit 0
`,
  },
  {
    id: "no-wip-push",
    name: "Block pushing WIP commits",
    description: "Refuse to push WIP / fixup! / squash! commits.",
    hook: "pre-push",
    body: `#!/bin/sh
# Block pushing work-in-progress commits (WIP / fixup! / squash!).
z="0000000000000000000000000000000000000000"
while read -r local_ref local_oid remote_ref remote_oid; do
  [ "$local_oid" = "$z" ] && continue
  if [ "$remote_oid" = "$z" ]; then
    range="$local_oid"
  else
    range="$remote_oid..$local_oid"
  fi
  if git rev-list -n 1 --grep 'WIP' --grep 'fixup!' --grep 'squash!' "$range" | grep -q .; then
    echo "Refusing to push: $local_ref has WIP/fixup/squash commits." >&2
    exit 1
  fi
done
exit 0
`,
  },
];
