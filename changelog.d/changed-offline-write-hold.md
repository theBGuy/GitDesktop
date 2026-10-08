- **Offline-safe remote actions.** While you're offline, actions that change
  the remote for good are unavailable, with the reason shown on the control,
  and work again as soon as you reconnect. Held actions are never queued for
  later. That covers merging or closing a pull request, updating its branch,
  resolving its conflicts, and submitting or discarding a review. It covers
  closing, transferring, or deleting an issue, and closing or deleting a
  discussion. It covers creating pull requests, issues, discussions, and
  releases, and publishing a branch or repository. It covers forking a
  repository, approving a workflow run, and deleting a project or one of its
  views. Pushing, pulling, fetching, deleting a remote branch, and editing,
  publishing, or deleting a release (assets included) are held too, as are
  pushing a tag or deleting it from origin. Comments and other quick edits
  still queue and send when you reconnect, as long as GitDesktop stays open
  until then. If any are still waiting when you quit from the tray, close the
  window with **Keep running in the tray when the window is closed** turned
  off, or install an update, GitDesktop asks before discarding them.
