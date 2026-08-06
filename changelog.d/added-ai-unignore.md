- AI ignore lists now honor `!` un-ignore lines with full gitignore semantics —
  and your global patterns always outrank a repo's `.gitdesktop/aiignore`, so a
  committed rule can never re-expose a file you excluded globally.
