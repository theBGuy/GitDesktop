- **Start a new branch from any base.** The new-branch dialog's **Base it on** picker is
  now a searchable list grouped into **Local** and **Remote** branches, so you can base a
  branch on any of them instead of only the current or default branch. Basing on a remote
  branch (e.g. `origin/epic/big-feature`) starts from the remote tip and leaves the new
  branch untracked, so its first push publishes it under its own name. Agents get the same
  option via the MCP `create_branch` tool's `noTrack` flag.
