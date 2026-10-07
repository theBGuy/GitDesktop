- Pulling a branch that shares its name with a tag checks for commits a
  rewritten upstream would drop, as it does on every other branch. Resetting
  the checked-out branch to its upstream points you to the sync controls, and
  deleting a remote's default branch is refused with a clear message, even
  when a tag is named after either one (such as `main` or `origin/main`).
