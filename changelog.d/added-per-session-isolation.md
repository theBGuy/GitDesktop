- **Per-session isolation.** Pick **Worktree** or **Container** for a single agent session
  from the composer's **Options**, overriding your Settings → AI default for that one run
  (Best-of-N arms share the pick). Choosing a container checks readiness inline — Docker or
  Podman installed, the engine running, the agent image built — and keeps **Send** disabled
  until it is, naming what's missing and offering a jump to Settings where that's what it
  takes to fix it.
