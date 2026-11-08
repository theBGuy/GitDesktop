- The **Block pushing WIP commits** hook template lets a new branch through
  when every WIP commit on it is already on the remote you're pushing to, as
  far as this clone last fetched it. It also catches WIP commits when the
  branch tip on the remote hasn't been fetched yet and on new branches in
  SHA-256 repositories, and it stops a push whose commits it can't read. If
  you installed the hook earlier, re-apply it: **Git hooks…** → pre-push →
  **Templates** → **Block pushing WIP commits**, then save.
