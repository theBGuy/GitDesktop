- The MCP `list_pull_request_comments` tool now caps each review thread's diff
  hunk to its last few lines, so a comment on a brand-new file no longer drags
  the whole file into the response. Pass `include_diff_hunk: false` to drop the
  hunks entirely when you only need the threads' structure.
