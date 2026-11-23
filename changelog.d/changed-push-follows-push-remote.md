- **Push** and **Publish** follow Git's push-remote settings: a branch with
  `branch.<name>.pushRemote`, or a repository with `remote.pushDefault`,
  pushes to that remote from the sync bar, the branch menu and the MCP
  server's push tools, and the menu item and progress name the destination.
  A setting that names no usable remote stops the push with the reason.
