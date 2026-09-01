/**
 * One-card-at-a-time exclusivity for a family of hovercards whose members each
 * own their card state. That state can't enforce it alone: a keyboard-opened
 * card closes only on blur or dismissal, so opening one elsewhere in the family
 * fires none of the first one's close routes and both float.
 *
 * Each surface builds its OWN latch. One shared instance would make unrelated
 * families — a rendered markdown body and the Insights dependency list —
 * mutually exclusive, which is a behavior change rather than deduplication.
 *
 * `Owner` is whatever a member uses as its stable identity; the latch only ever
 * compares it by reference and never reads it. `reset` is the surface's own
 * teardown for an evicted member, and MUST end by releasing that member — the
 * surface calls it directly on its own close paths too, not only through
 * `claim`.
 *
 * Written and read imperatively only — nothing renders from a latch.
 */
export function createCardLatch<Owner>(reset: (owner: Owner) => void) {
  let active: Owner | null = null;
  return {
    /** Hands the single open card to `owner`, tearing down whoever held it.
     *  Re-claiming from the owner that already holds it is not a takeover. */
    claim(owner: Owner) {
      if (active !== null && active !== owner) reset(active);
      active = owner;
    },
    /** Drops `owner`'s claim, ignoring one that no longer holds it — an evicted
     *  or unmounted member must never clear the card that replaced it. */
    release(owner: Owner) {
      if (active === owner) active = null;
    },
  };
}
