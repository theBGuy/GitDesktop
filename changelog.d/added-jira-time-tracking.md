- **Jira time tracking.** On a linked Jira Cloud project that has time tracking enabled, the
  issue view now shows the original estimate, remaining, and time spent with a progress bar.
  Log work with Jira's duration grammar (`2d 4h 30m`) and an optional note, set or clear the
  original and remaining estimates, and edit or delete your own worklog entries — the full
  history is a "View all in Jira" link away. Agents get a `jira_log_work` MCP tool and
  original/remaining-estimate parameters on `update_jira_issue`, both behind
  `--allow-remote-write`.
