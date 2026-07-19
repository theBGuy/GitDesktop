- Branch menu rows now show a branch's own push/pull state (↑ to push, ↓ to pull, plus
  markers for never-published and upstream-deleted branches) separately from its divergence
  vs. the default branch, which now reads `+N −M` with the default branch named — previously
  both rendered as identical ↑/↓ arrows, so being ahead of the default looked like unpushed
  work. Rows now span two lines — the branch name on its own line, the details below it —
  giving long branch names more room.
