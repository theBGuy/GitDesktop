- **MCP: cap or widen PR/issue lists.** The MCP server's `list_pull_requests` and
  `list_issues` tools take an optional `limit` — omit it for the provider's default page
  (GitHub ~30; GitLab and Bitbucket a full page), or pass one to raise or lower how many an
  agent pulls back in a call.
