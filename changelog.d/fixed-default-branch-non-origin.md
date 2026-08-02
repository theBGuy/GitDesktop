- Base-branch detection now works in repositories whose remote isn't named
  `origin` (a clone made with `git clone -o <name>`), so compare views and
  generated branch names start from the right branch.
