- Renamed files show as renames when you open them one at a time in History,
  Compare, staged changes, agent sessions and stashes: you see only what
  actually changed, image previews show the file as it was before the rename,
  and unstaging a hunk of a staged rename keeps the rename. A file's history
  shows each commit under the name the file had then, so commits from before a
  rename show their changes too. The MCP `commit_diff` and `working_diff` tools
  pair renames the same way.
