- **Automation history and on-demand runs.** A new **Automation history** view
  (activity bell footer, or the repository menu) records what each automation
  did and why: reviews posted, heads skipped as already covered, branch
  conditions that didn't match, heads handed off to another review run, and
  runs the app closed on. Saved commit reviews open straight from their
  Automation history row. **Run automations on this pull request** (command
  palette) runs the configured reviews on demand for the open PR, confirming
  the modes and the posted comment before it spends a model call.
