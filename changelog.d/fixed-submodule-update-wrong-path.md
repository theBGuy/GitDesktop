- Updating a single submodule whose path contains `[`, `*` or `?` now updates
  that submodule. It previously initialized and checked out a *different* one
  whose path happened to match, and left the one you asked for untouched.
