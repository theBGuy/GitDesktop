- The MCP `list_pull_request_comments` tool and the AI PR review now emit
  leaner comment payloads, omitting always-empty default fields (avatar URL,
  state, permalink, minimized flags, and review id) from each comment and
  review thread — the same JSON both consumers read, so agent runs and reviews
  spend fewer tokens on empty fields.
