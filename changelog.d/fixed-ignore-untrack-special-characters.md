- **File actions and views now use exactly the file you picked when its path
  contains `[`, `*` or `?`.** On a dynamic route like `src/app/[slug]/page.tsx`,
  staging, unstaging, discarding, stashing, ignoring, untracking, force-adding
  and taking one side of a conflict all act on that file alone. Those paths used
  to be handled as match patterns, so a neighbouring file could be swept in
  alongside the one you chose — most seriously, **discarding changes could throw
  away another file's uncommitted work**, and resolving a conflict could silently
  resolve a second file the same way. Reading is exact too: a file's history, and
  its diff in the working tree, in a commit, in a stash, or against another
  branch, no longer fold in a neighbour's commits and hunks. *Ignore* and *Exclude from AI* also
  write a working pattern for a name that ends in a space, which previously
  matched a different file and left the one you picked alone.
