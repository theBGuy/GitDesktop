- **File actions now affect exactly the file you picked when its path contains
  `[`, `*` or `?`.** On a dynamic route like `src/app/[slug]/page.tsx`, staging,
  unstaging, discarding, stashing, ignoring, untracking, force-adding and taking
  one side of a conflict all act on that file alone. Those paths used to be
  handled as match patterns, so a neighbouring file could be swept in alongside
  the one you chose — most seriously, **discarding changes could throw away
  another file's uncommitted work**, and resolving a conflict could silently
  resolve a second file the same way.
