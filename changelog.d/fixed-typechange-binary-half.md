- When a binary file other than an image becomes a symbolic link, or a link
  becomes one, its diff now shows both sides: the binary file's size, when
  known, and the link's text. This covers the Changes list, History, branch
  comparisons, stashes and agent sessions, plus pull requests where a link
  became a binary file.
