- **Re-reviews end with a verdict** — every AI re-review, general or security audit, now
  closes with one of two explicit lines: `Verdict: blocking issues remain`, or
  `Verdict: no blocking issues — remaining items are non-blocking; merge when ready`.
  A round that resolved everything but noticed one nit used to read as another round;
  now it says which it is.
- **Reviews know where your docs live.** A general review is given the repository's
  documentation surfaces by path — README, changelog, changelog fragments, docs
  directories — so a user-facing change that leaves any of them stale comes back as one
  finding naming every affected surface, including ones the diff never touched, instead
  of one surface per round. A repo's own `.gitdesktop/instructions.md` now reaches
  reviews too, as conventions to judge the change against.
- **The opening comment now keeps a guaranteed share of the budget, not just its
  place in the queue.** Being kept rather than dropped only settles which comments
  make it in; how much of each one survives is decided earlier, and there the opening
  comment was treated as just another block — so on a long thread it was squeezed to
  the same per-comment minimum as a one-line "fixed in `<sha>`" reply. It is now
  allotted its share before the rest divide up what remains, and the decision-ledger
  distiller reads more of every comment on shorter threads.
