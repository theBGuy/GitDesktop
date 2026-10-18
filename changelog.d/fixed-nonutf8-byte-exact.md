- Files that aren't UTF-8 text (cp1252, Shift-JIS, GBK and the like) now keep
  their bytes exact when you stage, discard or resolve conflicts in them. Their
  diffs note that the file stages and discards as a whole, their conflicts
  resolve with the whole-file accept buttons, and AI conflict resolution
  explains why it leaves them to you.
