- **A branch whose remote was deleted now offers "Publish branch."** After a PR
  merge deletes the remote branch, the sync bar no longer shows stale Push/Pull
  against the dead ref — it shows **Publish branch**, which recreates the remote
  branch on push. Undo-commit is available again on such a branch, and amending
  its tip no longer wrongly demands a force-push.
