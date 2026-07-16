- Opening a pull request now targets a repository explicitly. On a **fork** the
  create dialog lets you choose where the PR lands — your **fork** or the
  **upstream** repository (defaulting to upstream), listing the chosen
  repository's base branches; previously the target was left to `gh`'s implicit
  resolution. Labels and assignees aren't available when you open the PR on the
  upstream repository. Targeting the upstream repository requires an `upstream`
  remote; on a fork cloned without one, the create dialog now offers to add it.
