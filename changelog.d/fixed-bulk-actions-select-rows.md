- Bulk actions in the Changes panel act on exactly the rows you selected: each
  menu item shows how many of them it applies to and one that applies to none
  is left out (Stage instead stays in view, unavailable, when every selected
  unstaged file has a Windows-reserved name), Discard reaches a staged
  deletion's untracked copy only when you select that copy's row, and a file
  with both staged and unstaged edits changes only on the side you picked.
  Stash, Ignore and Untrack count each file once, Untrack skips staged
  deletions so the rest of the selection still untracks, and the Stash
  confirmation says when a stash also takes changes you didn't select.
  Discard leaves selected conflicted files out and discards the rest, showing
  "N of M", and Stash waits, marked "resolve conflicts first", until no file
  is conflicted.
