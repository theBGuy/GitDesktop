- History says it couldn't load the commit log, with the reason and a Retry,
  when the repository can't be read, instead of showing the first-commit
  welcome, and a file's history does the same instead of reporting none. A
  failed refresh or Load more keeps the loaded commits on screen with a note, a
  failed search of all history says so rather than reporting no matches, and
  when the check for unpushed commits fails, squash and Edit history say they
  couldn't check which commits are pushed instead of treating them all as
  already pushed.
