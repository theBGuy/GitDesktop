- **Security audits no longer assume GitDesktop's own tech stack.** The audit prompt
  carried a list of "this codebase" exemptions written for GitDesktop itself (a Rust +
  React app), and sent them to *every* repository — so an audit of a C or C++ change was
  told buffer overflows and use-after-free "are not possible", an audit of a
  non-React frontend had cross-site-scripting waved off, an audit of a server or API
  handler had missing authorization treated as somebody else's problem, and anything
  reachable through environment variables or command-line flags was assumed trusted even
  on a shared CI runner or an elevated binary. Each of those is now judged against the
  code actually under review and reported when it genuinely applies, while staying
  suppressed where it truly can't happen. The audit also sizes up the change's own
  language, trust boundary, and existing validators first, and weighs a change that
  bypasses the project's established guards more heavily than one that follows them.
- **Sharper severity and confidence on security findings.** *Critical* is now a severity
  a finding can actually carry — reserved for remote code execution, full system
  compromise, or a mass data breach — where before it was referenced by the reporting
  rules but never defined, so the worst issues had to be filed as merely High. The 1-10
  confidence score is now calibrated by what the reviewer actually saw, so a 9 means the
  exact source, sink, and missing guard were all in view rather than partly inferred.
  Prototype pollution and integrity-free deserialization are now named categories too.
