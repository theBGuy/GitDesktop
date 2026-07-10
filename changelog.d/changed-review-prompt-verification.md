- **AI PR reviews verify before flagging.** The review now checks the typed contract
  before reporting a possible null/undefined issue — a field the types declare
  non-optional (or that every code path visibly sets) is no longer flagged — and it
  omits a finding relayed from another AI reviewer when it cannot verify that finding
  against the diff, rather than passing it along with a "could not verify" hedge.
