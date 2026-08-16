- A line selection in the staging diff can now cover added **and** removed lines
  at once. Hold the platform modifier (**Ctrl**, **Cmd** on macOS) while dragging
  the line numbers and the new run joins the selection instead of replacing it,
  so a single **Stage**, **Unstage**, or **Discard** can carry a whole edit —
  both halves of a rewritten line, across as many hunks as you like. A plain
  drag still starts a fresh selection, and the hint above the diff names the key
  for your platform.
