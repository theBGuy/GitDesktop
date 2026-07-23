- **Stash selected files** now captures only the files you selected.
  Previously any other *staged* changes were silently saved into the stash
  entry too (a `git stash push -- <paths>` limitation); your unselected staged
  and unstaged changes are now left exactly as they were.