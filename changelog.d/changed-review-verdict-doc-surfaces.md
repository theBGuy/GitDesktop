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
- **The opening comment survives a long PR.** Once enough of GitDesktop's own comments
  piled up on a pull request, the author's opening context comment collapsed to a
  fraction of itself in a single step, re-opening everything it had pre-empted. It now
  keeps a guaranteed share of the review's comment budget, and the decision-ledger
  distiller reads more of it on shorter records.
