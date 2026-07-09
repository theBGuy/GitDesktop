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
