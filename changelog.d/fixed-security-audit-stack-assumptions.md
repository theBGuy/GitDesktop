- **Security audits no longer assume GitDesktop's own tech stack.** The audit prompt opened
  with a block headed *"in THIS codebase (Tauri: Rust backend + React/TypeScript frontend)"*
  and sent it to **every** repository — so an audit of a C, Python, or Go project was told,
  as fact, that the code in front of it was Rust and React. Sitting under that false premise
  were exemptions written for GitDesktop itself: anything reachable through environment
  variables or command-line flags was declared trusted outright, with no condition attached —
  untrue for a server, a container, a shared CI runner, or an elevated binary — and missing
  authorization was waved off in frontend code on the assumption that a separate backend was
  re-checking it, which does not hold for a frontend-only app or a frontend change reviewed
  without its backend. Exemptions written for memory-safe languages and for React's automatic
  escaping sat under the same false header, inviting them to be applied to code that was
  neither. Every one of those rules is now judged against the code actually under review —
  reported where it genuinely applies, still suppressed where it truly cannot happen — and an
  audit now sizes up the change's own language, trust boundary, and existing validators
  first, weighing a change that bypasses the project's established guards more heavily than
  one that follows them. **Prototype pollution** is now a named category as well.
- **Sharper severity and confidence on security findings.** *Critical* is now a severity that
  a finding can actually carry — remote code execution, code execution triggered by content
  you merely clone or open, full system compromise, or a mass data breach — where before it
  was referenced by the reporting rules but never defined, so the worst issues had nowhere to
  go but High. The 1-10 confidence score is now calibrated by what the reviewer actually saw,
  so a 9 means the exact source, sink, and missing guard were all in view rather than partly
  inferred, and the bar a finding must clear now scales with its severity instead of sitting
  at one flat number that contradicted it.
