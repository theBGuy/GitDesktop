- Fixed AI PR reviews failing to run when a third-party bot review or a prior
  comment contained an emoji. The review prompt could be truncated in the middle
  of an emoji, leaving an invalid Unicode fragment that the model provider
  rejected ("unexpected end of hex escape" / "Invalid body"); prompt truncation
  now respects character boundaries so emoji are never split.
