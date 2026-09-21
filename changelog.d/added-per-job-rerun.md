- **Re-run one CI job.** Failed rows in the pull request's checks rollup and in
  the Actions run view carry their own re-run: on GitHub it restarts the job
  plus any jobs that depend on it once the run has finished, on GitLab it
  retries just that one as soon as the job fails. One flaky job costs one
  click, not a batch.
