- Your **AI ignore patterns** now apply when you regenerate the description of an
  already-open pull request or merge request, not only when you create one.
  Excluded files are dropped from the forge's own diff before it reaches the
  provider, and the prompt states how many were held back rather than passing the
  diff off as complete; if every changed file is excluded, nothing is sent at all.
