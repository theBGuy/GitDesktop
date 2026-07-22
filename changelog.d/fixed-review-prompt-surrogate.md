- Fixed AI features failing when their input text contained an emoji near a size
  limit. When a prompt was truncated to fit its budget, the cut could split an
  emoji (a UTF-16 surrogate pair) and leave an invalid Unicode fragment that the
  model provider rejected ("unexpected end of hex escape" / "Invalid body") — most
  visibly breaking AI PR reviews when a bot review or prior comment contained an
  emoji, but the same flaw affected PR-description and commit generation, issue
  drafting, merge-conflict resolution, and repo/discussion prompts. Prompt
  truncation now respects character boundaries everywhere, so emoji are never split.
