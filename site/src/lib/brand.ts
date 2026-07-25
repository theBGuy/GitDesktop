// The one canonical description sentence, repeated verbatim wherever the
// project describes itself (homepage footer, README, GitHub About, releases,
// and the Organization JSON-LD). "GitDesktop" collides with GitHub Desktop and
// a discontinued macOS client that owns the .com, so every clause is a
// discriminator no competitor shares. Head.astro and SiteLayout.astro both
// render THIS export so the two copies can't drift; README is markdown and
// remains a manual copy.
export const canonicalSentence =
  "GitDesktop is a free, open-source (Apache-2.0) desktop Git client for " +
  "Windows, macOS, and Linux, built with Tauri 2 and React 19 by theBGuy. " +
  "It works with GitHub, GitLab, and Bitbucket — staging, diffs, branches, " +
  "history, and the full pull-request loop with code review, CI, and issues " +
  "— with optional AI you can hide entirely.";
