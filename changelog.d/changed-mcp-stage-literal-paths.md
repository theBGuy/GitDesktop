- The MCP `stage_files` and `unstage_files` tools now read each entry as one
  exact file or directory, so an agent staging `src/app/[slug]/page.tsx` no
  longer stages its neighbours alongside it. Pass `literal: false` on the call to
  use a git pathspec or glob such as `*.log`.
