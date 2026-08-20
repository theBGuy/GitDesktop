- **Branch rules** gains a **Promotion branches** list — name the branches whose
  pull requests carry work onward, like `staging`, and GitDesktop stops offering
  to update those pull requests from their base. It covers the
  `staging` → `production` flows and upstream-lens pull requests the
  default-branch detection can't see, and the strip names the head as a promotion
  branch for this repository.
