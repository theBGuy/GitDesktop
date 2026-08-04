- AI review automations no longer double-run a pull request that was already
  reviewed when a second GitDesktop window or instance — or a restarted dev
  session — watches the same repository: automation decisions now read the
  review history on disk instead of a stale in-memory copy.
