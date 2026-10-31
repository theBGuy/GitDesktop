- Renaming, deleting, archiving or cleaning up branches, resetting a branch
  to its upstream, and retrying a pull, merge or rebase from its prompt now
  check for a running push when you confirm, so a push that started while
  the dialog was open is left to finish. After a **Clean up branches**
  batch that partly fails, the branches you unchecked stay unchecked. The
  **Show branches** shortcut does nothing while you're working in a dialog.
