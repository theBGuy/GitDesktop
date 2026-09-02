- Staging, committing, and other local Git work stay available while a pull is
  transferring: the network phase runs on the repository's network lock alone,
  and the merge or rebase then applies exactly the commits that fetch delivered.
