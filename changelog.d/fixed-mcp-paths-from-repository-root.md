- The MCP server's `stage_files`, `unstage_files`, and `stash_push` tools read
  paths, including `literal=false` patterns, from the repository root, as
  `repo_status` lists them, when the server is started in a subfolder.
