- **Generate from changes** now works on a branch whose work is already
  committed. Whenever the working tree can't describe the branch being named —
  it's clean, or you're renaming a branch you aren't on — it names the branch
  from that branch's own committed work instead: the diff and commit subjects
  vs. the default branch. That's exactly the case a rename usually needs.
  Applies in the app and to the MCP `generate_branch_name` tool and prompt, and
  when the button *is* disabled it now says why.
