- AI ignore patterns now cover files whose names contain tabs, line breaks,
  or other control characters in GitLab merge requests and commits and in
  GitHub pull requests too large for a single diff, and PR and commit file
  views now show those files' diffs. While ignore patterns are set, any diff
  section that can't be matched against them is also left out of AI requests.
