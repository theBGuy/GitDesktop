- Force pushes now pass `--force-if-includes` alongside `--force-with-lease`:
  the push refuses to overwrite work you haven't incorporated, even when a
  background fetch has already brought it into your remote-tracking refs
  (which is enough to satisfy the lease alone). On a Git older than 2.30,
  or a branch without a reflog for the check to read, pushes keep the
  previous lease-only guard.
