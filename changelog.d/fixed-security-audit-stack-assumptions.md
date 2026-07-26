- **Security audits no longer assume GitDesktop's own tech stack.** The audit prompt told the
  model, as fact, that the code in front of it was Rust and React, and applied exemptions
  written for that stack to every repository you audit. Anything reachable through
  environment variables or command-line flags was trusted outright (untrue for a server, a
  container, or a shared CI runner), and missing authorization was waved off in frontend code on
  the assumption that a separate backend was re-checking it. Each of those rules is now judged
  against the code actually under review, and an audit sizes up the change's own language, trust
  boundary, and existing validators first. **Prototype pollution** is now a named category too.
- **Sharper severity and confidence on security findings.** *Critical* is now a severity that a
  finding can actually carry — remote code execution, code execution triggered by content you
  merely clone or open, full system compromise, or a mass data breach — where before it was
  referenced by the reporting rules but never defined, so the worst issues had nowhere to go but
  High. Confidence is now calibrated by what the reviewer actually saw, and the flat
  ">80% confident" rule that contradicted the severity-scaled thresholds is gone.
