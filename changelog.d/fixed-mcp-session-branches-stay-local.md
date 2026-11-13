- The MCP server's `push`, `force_push` and `create_pull_request` tools,
  and Push, Publish, Create PR and Publish repository in the app, keep
  agent-session branches (`gd/session/*`) off your remotes: each refuses to
  publish one, and the push tools also refuse a push that would land on one
  through another branch. On an agent-session branch the sync bar holds
  Push, Publish and Force push and says why.
