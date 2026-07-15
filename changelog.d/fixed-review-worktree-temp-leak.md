- Empty `gd-review-*` worktree folders no longer leak into the temp directory:
  the review-worktree cleanup now retries the folder delete past a transient
  Windows file-handle race, and any leftover empty husks are swept on startup.
