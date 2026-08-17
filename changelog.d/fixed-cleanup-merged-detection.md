- **Clean up branches** now sees the work that landed on the default branch through
  a pull request, not only the merges your local history records, so squash- and
  rebase-merged branches turn up in the list with a `merged #123` badge naming the
  pull request that took them. The match goes by branch name, so it only ever badges
  a row: what comes pre-checked is still what your own history shows — merged into
  the default branch, or idle past the window you picked.
