- The merge-method menu on a GitHub pull request now respects the repository's
  own merge settings: a method disabled in the repo (allow merge commit / squash /
  rebase) is shown greyed out as "disabled in repository settings" instead of
  failing with a raw error only after you open the confirm dialog and click Merge.
  When no method is enabled by both the repository settings and your branch rules,
  the Merge button is disabled with an explanation.
