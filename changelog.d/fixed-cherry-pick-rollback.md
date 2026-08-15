- A cherry-pick onto another branch that fails for any reason — a conflict, a
  timeout, an unreadable repository — now always rolls back: the target branch is
  left exactly as it was and you end up back on the branch you started from.
