- Hand-edited `branch-rules.json` and `automations.json` values now heal on
  load: unknown entries in a protection's allowed merge methods are dropped
  (both the personal store and a committed `.gitdesktop/branch-rules.json`),
  and every enumerated field falls back to a valid choice instead of quietly
  restricting merges.
