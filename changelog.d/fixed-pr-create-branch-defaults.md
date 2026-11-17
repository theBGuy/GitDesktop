- **Create pull request** (**Create merge request** on GitLab) and **New local
  pull request** start from the branch you're on with the default branch as
  the base, unless you opened them with branches already picked. Where the
  dialog can't tell which branch you mean (you're on the default branch
  itself, say, or the default branch isn't known), that picker is left for
  you to choose and the dialog starts on it. For a pull or merge request on
  GitHub, GitLab or Bitbucket, the commit count and a generated description
  are measured against the remote's copy of the base branch (as of your last
  fetch) when it has one, so they match the request you're about to open.
