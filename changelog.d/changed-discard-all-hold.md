- Discard all runs as one atomic operation: another GitDesktop action
  attempted mid-discard is refused with a labeled busy notice, and the
  discard finishes on the snapshot it started from.
