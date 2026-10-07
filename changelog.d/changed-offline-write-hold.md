- **Offline-safe remote actions.** While you're offline, actions that change
  the remote for good are unavailable, with the reason shown on the control,
  and work again as soon as you reconnect. Held actions are never queued for
  later. That covers merging or closing a pull request, updating its branch,
  resolving its conflicts, and submitting or discarding a review. It covers
  closing, transferring, or deleting an issue, and closing or deleting a
  discussion. It covers creating pull requests, issues, discussions, and
  releases, and publishing a branch or repository. Pushing, pulling,
  fetching, deleting a remote branch, and editing, publishing, or deleting a
  release (assets included) are held too, as are pushing a tag or deleting it
  from origin in the tag's own view. Comments and other quick edits still
  queue and send when you reconnect.
