- **Re-run one CI job.** Failed rows in the pull request's checks rollup and in
  the Actions run view carry a per-job re-run: GitHub's **Re-run job** restarts
  the job plus any jobs that depend on it, GitLab's **Retry job** retries just
  that one. One flaky job costs one click, not a batch.
