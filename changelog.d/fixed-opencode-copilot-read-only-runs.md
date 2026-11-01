- AI reviews and AI-written text (commit messages, PR descriptions, branch
  names, Debug with AI) that run on opencode use only read-only tools,
  whatever the repository's own opencode settings say. On opencode,
  diff-only reviews and generated commit messages, PR descriptions and
  branch names can't open your files at all, so your AI-ignore patterns
  hold for them. Claude reviews and read-only Plan and Research sessions
  ignore the repository's own Claude settings and hooks, so reviewing a
  pull request can't run commands it adds. Copilot's diff-only review runs
  without write or shell access. opencode Plan and Research sessions use
  read-only tools too (plus web search and fetch in Research), unless the
  repository's own opencode config or plugins change them.
