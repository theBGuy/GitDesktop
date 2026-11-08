- With several files selected in the Changes list, Stash, Ignore and Untrack
  count each file once, Untrack skips staged deletions so the rest of the
  selection still untracks, and the Stash confirmation says when a stash also
  takes changes you didn't select. Discard leaves selected conflicted files
  out and discards the rest, showing "N of M", and Stash waits, marked
  "resolve conflicts first", until no file is conflicted.
