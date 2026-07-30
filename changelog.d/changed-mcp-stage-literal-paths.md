- The MCP `stage_files`, `unstage_files` and `stash_push` tools now read each
  entry as one exact file or directory, so an agent acting on
  `src/app/[slug]/page.tsx` no longer touches its neighbours alongside it — which
  for `stash_push` meant sweeping another file's uncommitted work out of the
  working tree. Pass `literal: false` on the call to use a git pathspec or glob
  such as `*.log`.
