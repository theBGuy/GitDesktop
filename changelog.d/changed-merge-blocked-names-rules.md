- **A blocked merge names what it's waiting on.** When a GitHub pull request
  merges cleanly but the base branch's protection rules won't let it land, the
  strip under the header now says so and lists the required checks still
  outstanding, and a refused merge repeats that line alongside the forge's own
  message. **Merge** stays available, since a bypass actor can still merge.
