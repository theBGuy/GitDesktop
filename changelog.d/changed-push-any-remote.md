- **Push a branch to any remote, not just origin.** Pushing a branch from the branch
  switcher now targets the branch's OWN remote — a branch tracking a fork's `upstream`
  is pushed there, not to origin. On a repo with several remotes, **Publish** offers a
  per-remote choice (one item per remote). The MCP `push` tool gains an optional
  `remote` parameter, and a bare `push {branch}` for a branch tracking a non-origin
  remote now correctly targets that remote instead of pushing to origin under the
  branch's own name.
