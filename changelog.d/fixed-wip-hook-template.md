- The **Block pushing WIP commits** hook template lets a new branch through
  when every WIP commit on it is already on the remote you're pushing to,
  going by this clone's remote-tracking branches for that remote. It also
  catches WIP commits in a push over a branch tip you haven't fetched and
  on a new branch in a SHA-256 repository, and it refuses a push whose
  commits it can't read. If you installed the hook earlier, re-apply it:
  **Git hooks…** → pre-push → **Templates** → **Block pushing WIP commits**,
  then save.
