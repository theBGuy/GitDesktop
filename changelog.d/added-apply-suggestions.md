- **Apply suggested changes locally.** Apply a reviewer's suggested change to
  your working tree straight from the review thread on a GitHub PR — GitDesktop's
  local answer to GitHub's *Commit suggestion*, which has no public API. The edit
  is verified against the file first (refused if the code has drifted), keeps the
  file's line endings and BOM, and is staged when the file had no other local
  changes (otherwise applied unstaged, with a note). Disabled with a reason when
  the thread is outdated or a branch other than the PR's head is checked out.
