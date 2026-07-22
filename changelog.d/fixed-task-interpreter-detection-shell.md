- The task editor no longer warns that an interpreter "wasn't detected" when it's
  actually installed. Interpreters installed through a version manager (nvm/fnm for
  Node, and anything else that lives only on your shell's PATH) weren't found by the
  editor's quick check when GitDesktop was launched from the Dock or Finder on macOS
  — even though the task ran fine. The editor now confirms the selected interpreter
  the same way a run resolves it (via your login shell), so it shows the real path
  instead of a false "not detected" warning.
