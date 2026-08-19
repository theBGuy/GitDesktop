- **Cherry-pick to branch** with a single commit now pauses on the destination
  branch when it conflicts, so you resolve it in the app and continue like any
  other conflict — and a resolution that keeps the destination's own version
  finishes from the banner too. **Operation history** shows the pick as
  *Paused* until you finish or abort it. Picking several commits at once still rolls the
  whole batch back, and the dialog now refuses to start while another merge,
  rebase, cherry-pick or revert is in progress.
