- **AI reviews converge in fewer rounds** — a fuller first review, then fewer of them. A re-review now checks each applied fix's own
  hunks — and how the fixes interact — in the same round, and suggested fixes spell out
  what else they oblige you to touch, so one round's fix stops becoming the next round's
  finding. A problem repeated across files is reported once with every affected location,
  and everything the reviewer is confident about lands in the first review instead of
  trickling out over several.
- Re-reviews no longer raise fresh optional nits about code that hasn't changed, and wrap
  up in a line once nothing substantive is left. Decisions you recorded in the PR
  description or *Notes for reviewers* are respected for every kind of finding, and when a
  large diff crowds out GitDesktop's own earlier comments the review is told they were
  omitted rather than quietly losing the record.
