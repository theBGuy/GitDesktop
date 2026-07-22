- **Tasks — save scripts and run them in-app.** A new **Tasks** tab (and a
  command-palette **Run a task…**) lets you register your own scripts — a release or
  build flow, say — and run them without dropping to a terminal. Point a task at an
  **existing script in the repo** (it runs the live file, so edits take effect on the next
  run) or write one **inline**; with an AI provider connected, **Generate** writes an
  inline script from a plain description, and **Analyze with AI** reads a script and fills
  in its name, description, and the arguments it accepts. Each task carries a description
  and default arguments (quoted values kept intact), documents its arguments
  `--help`-style, and a confirm-gated run lets you adjust the arguments per run. Runs
  happen in an **interactive** terminal in the repository's folder, so scripts that prompt
  you (a version to release, a yes/no) work and keep their colour; **Stop** kills the run
  and its child processes, **Rerun** starts a fresh one. Choose the interpreter
  (PowerShell, cmd, bash/sh/zsh, Node, or Python). Task definitions live in your app data
  and are never read from repository content, running is off until you enable it, and each
  task can ask for confirmation before it runs.
