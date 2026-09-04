- Agent CLI detection and the container-engine fallback probe less: an absent
  CLI is remembered briefly instead of re-spawning a login shell on every
  check, and when the preferred engine is stopped, turns land on the running
  engine without re-probing the stopped one each time.
