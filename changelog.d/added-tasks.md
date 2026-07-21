- **Tasks — save scripts and run them in-app.** A new **Tasks** tab (and a
  command-palette **Run a task…**) lets you register your own scripts — a release or
  build flow, say — and run them without dropping to a terminal. Point a task at an
  **existing script in the repo** (it runs the live file, so edits take effect on the next
  run) or write one **inline**; with an AI provider connected, **Generate** writes an
  inline script from a plain description. Each runs in an **interactive** terminal in the
  repository's folder, so scripts that prompt you (a version to release, a yes/no) work and
  keep their colour; **Stop** kills the run and its child processes, **Rerun** starts a
  fresh one. Choose the interpreter (PowerShell, cmd, bash/sh/zsh, Node, or Python) and pass
  arguments (e.g. `--preview`, with quoted values kept intact). Task
  definitions live in your app data and are never read from repository content, running is
  off until you enable it, and each task can ask for confirmation before it runs.
