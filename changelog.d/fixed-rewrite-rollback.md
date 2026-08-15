- When an interactive-rebase rewrite can't complete, the error now tells the truth
  about the rollback: it confirms your branch was restored, and when the rollback
  itself fails it names the tip your branch had before the run and the exact
  commands to recover.
