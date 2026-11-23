- Publishing a branch only ever creates it: when the remote already has a
  branch of that name at another commit (one this clone hasn't fetched), the
  publish stops and says so, and nothing is pushed.
