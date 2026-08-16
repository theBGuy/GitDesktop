- Switching between pull requests no longer flashes the wrong footer action:
  **Ready for review** and **Convert to draft** now wait for the incoming pull
  request's own draft state instead of borrowing the previous one's for a beat.
  Their keyboard shortcuts wait on the same state, so neither can act on the pull
  request you just left.
