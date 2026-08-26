- **Line counts on the changes list.** File rows in the Changes tab now show
  how many lines they add and remove, so you can size a change before opening
  its diff. The Staged and Changes rows count separately: a file you staged and
  then edited again shows what's staged for the commit on one row and what's
  still outside it on the other. Binary files read `bin`, and untracked files
  show no counts (git has nothing to compare them against yet).
