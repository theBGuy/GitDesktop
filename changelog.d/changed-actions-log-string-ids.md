- CI run and job log lookups now thread ids as strings end-to-end, so they stay
  precise even above JavaScript's safe-integer limit (2^53). The MCP workflow
  tools accept a run/job id as either a number or a numeric string, so existing
  callers keep working.
