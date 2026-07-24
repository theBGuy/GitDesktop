- **Link issues when you open or edit a PR.** The Create and Edit PR dialogs now have a
  **Linked issues** row (GitHub & GitLab, wherever the repo has an issue tracker):
  reference real repo issues that are auto-detected from your branch name and commit
  subjects, proposed for you when you **Generate** the description (from a grounded
  shortlist of your open issues), or added by hand. Toggle each between **Closes**
  (auto-closes the issue on merge) and **Relates to** — they're appended to the
  description as `Closes #N` / `Relates to #N` lines, and opening **Edit** peels any
  trailing ref lines back into chips (keyword preserved) and re-appends them on save, so
  the chips are the single editor for that block. **Local PRs** get the same row (create
  and edit), and their ref lines survive **promotion** verbatim to become real closing
  refs on the forge. On a **Bitbucket** repo with a **linked Jira project**, the row
  surfaces linked-Jira issues (`KEY-123`) as **mention-only** *Relates to* chips (Jira
  tickets are never closed from PR text).
