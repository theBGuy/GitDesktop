- Pulling with rebase on a branch that shares its name with a tag checks for
  commits a rewritten upstream would drop, as it does on every other branch.
  Deleting a remote's default branch is refused with a clear message, even
  when a tag or local branch named like it (such as `origin/main`) exists.
