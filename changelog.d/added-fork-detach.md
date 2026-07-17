- **Detach from a fork.** The repository settings Danger zone now offers two ways
  to break a fork's ties: **Remove upstream remote** detaches your clone from the
  parent locally (the Fork/Upstream switcher and "Update from upstream" disappear;
  reversible by re-adding the remote), and **Leave fork network** detaches the
  repository from its fork network. On GitLab this happens right in the app
  (Owner-only — open merge requests to the parent are closed), while GitHub and
  Bitbucket link out to the provider's detach page. A **Re-check fork status**
  button refreshes the fork badge in place once you've done it.
