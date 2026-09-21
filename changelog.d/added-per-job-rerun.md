- **Re-run one CI job.** Failed rows in the pull request's checks rollup and in
  the Actions run view carry their own re-run, offered on GitHub once the
  job's run has finished and on GitLab as soon as the job fails. GitHub
  restarts the job plus any jobs that depend on it; GitLab retries just that
  one. One flaky job costs one click, not a batch.
