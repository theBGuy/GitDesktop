- **Long review threads keep their recorded decisions.** When GitDesktop's own comments
  on a pull request outgrow the review-context budget, the AI review now reliably
  distills them into a compact decision ledger — reading the complete comments rather
  than the already-trimmed ones, and giving an agent-CLI generation model the time it
  needs to finish — so refutations and "fixed in `<sha>`" notes survive a long thread
  instead of being cut away with the text.
