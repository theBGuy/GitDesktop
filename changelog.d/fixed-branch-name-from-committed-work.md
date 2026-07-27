- **Generate from changes** now works on a branch whose work is already
  committed. With a clean working tree it names the branch from its committed
  work instead — the diff and commit subjects vs. the default branch — which is
  exactly the case a rename usually needs. Applies in the app and to the MCP
  `generate_branch_name` tool and prompt, and when the button *is* disabled it
  now says why.
