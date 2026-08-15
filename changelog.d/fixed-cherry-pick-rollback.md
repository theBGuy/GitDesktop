- A cherry-pick onto another branch that fails for any reason — a conflict, a
  timeout, an unreadable repository — now rolls the whole batch back: the target
  branch is left as it was and you end up back on the branch you started from.
