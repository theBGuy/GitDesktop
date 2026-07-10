- Large file diffs no longer flash or re-render while loading. The diff now waits
  for its syntax-highlighting inputs (the whole-file context reads and any
  lazily-loaded language grammar) to settle and paints once, instead of showing a
  brief hunk-only pass that restructured a moment later.
