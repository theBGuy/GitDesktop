- **Push** from the sync bar and the branch menu, **Publish branch** in the
  sync bar, and the MCP server's push tools follow Git's push-remote
  settings: a branch with `branch.<name>.pushRemote`, or a repository with
  `remote.pushDefault`, pushes to that remote. The branch menu's Push item
  names the destination, and when the setting names no usable remote it
  reads a plain **Push**, which says why when pressed.
