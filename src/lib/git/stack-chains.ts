import type { PrInfo, PrStackInfo } from "./types";

/** Whether this is a forge-NATIVE stack, which merges atomically bottom-up, as
 *  opposed to an inferred chain whose members merge one at a time. The `id` shape
 *  is the contract, and both minting sites are the whole universe: `github/pr.rs`
 *  stringifies the numeric stack number, `forge/gitlab.rs` synthesizes
 *  "mr-<bottom-iid>". Provenance the payload carries itself, so a pending or
 *  failed forge-status probe can't skew it in either direction. */
export function isNativeStack(stack: PrStackInfo | null | undefined): boolean {
  return stack != null && !stack.id.startsWith("mr-");
}

/** A stack write the open list says is available for the PR on screen: either a
 *  brand-new stack over an unstacked chain, or an append onto the stack that
 *  chain already sits on. `members` is always bottom→top, the order GitHub
 *  stacks and merges in. */
export type StackOffer =
  | { kind: "create"; members: number[] }
  | {
      kind: "add";
      stackNumber: number;
      /** The attach stack's size when the offer was detected, so a preview can
       *  number the members by where they'll LAND (baseSize+1…) rather than
       *  1…N. */
      baseSize: number;
      members: number[];
    };

/** Whether a row is already part of a stack — such rows are chain NEIGHBORS but
 *  never offer members (you can't stack what's stacked). */
function isStacked(pr: PrInfo | undefined): boolean {
  return pr?.stack != null;
}

/**
 * The stack operation `current`'s branch chain offers, or null when there is
 * none. Pure and total — no I/O, no throws.
 *
 * Chain topology mirrors the GitLab inference in `forge/gitlab.rs`
 * (`infer_mr_stacks`) rule for rule, so the two stay diffable: parents are open
 * PRs whose head branch is the child's base; ambiguity (a base claimed by two
 * open PRs, or a parent with two open children) poisons the whole CONNECTED
 * COMPONENT rather than just the link, since a PR whose own base is ambiguous
 * is not a chain bottom; a component with no parentless bottom is a cycle and
 * yields nothing.
 *
 * On top of that shared topology sit the GitHub write rules: a chain that
 * bottoms out on a stacked PR can only be APPENDED, and only when that PR is
 * its stack's open top (GitHub rejects mid-stack attachment); an unstacked
 * chain needs two members before GitHub will make a stack of it.
 *
 * A row flagged `stackUnknown` voids the whole list: the list's stack join is
 * fail-open, so on a failed join every row arrives looking unstacked and a
 * "create" preview would assert something false about PRs that are already
 * stacked.
 *
 * The caller guarantees GitHub, `current` open, unstacked, and not
 * `stackUnknown`.
 */
export function detectStackOffer(
  current: PrInfo,
  open: PrInfo[],
): StackOffer | null {
  // The join fails for the WHOLE list, so one flag anywhere voids every row —
  // checked before the state filter so a marked row can't be filtered away
  // ahead of its own warning.
  if (open.some((p) => p.stackUnknown === true)) return null;
  // Only rows the forge still reports OPEN take part. The caller passes an open
  // list, so this is a belt-and-braces guard that also keeps the function total
  // against a row with a missing/odd state.
  const rows = open.filter((p) => (p.state ?? "").toUpperCase() === "OPEN");
  if (isStacked(current)) return null;
  if (!rows.some((p) => p.number === current.number)) return null;
  const byNumber = new Map(rows.map((p) => [p.number, p]));

  // Head branch → the open PRs offering it, so a PR's parent candidates are
  // `sources[its base]`.
  const sources = new Map<string, number[]>();
  for (const p of rows) {
    const owners = sources.get(p.headRefName);
    if (owners) owners.push(p.number);
    else sources.set(p.headRefName, [p.number]);
  }

  const neighbors = new Map<number, number[]>();
  const hasParent = new Set<number>();
  const children = new Map<number, number[]>();
  const ambiguous = new Set<number>();
  const link = (from: number, to: number) => {
    const list = neighbors.get(from);
    if (list) list.push(to);
    else neighbors.set(from, [to]);
  };
  for (const p of rows) {
    // A PR can't be its own parent — a self-targeting PR just sits on a branch.
    const candidates = (sources.get(p.baseRefName) ?? []).filter(
      (n) => n !== p.number,
    );
    // Candidate links join the component even when AMBIGUOUS: that's what lets
    // one bad link poison the whole chain instead of silently splitting it.
    for (const parent of candidates) {
      link(p.number, parent);
      link(parent, p.number);
    }
    if (candidates.length === 1) {
      hasParent.add(p.number);
      const kids = children.get(candidates[0]);
      if (kids) kids.push(p.number);
      else children.set(candidates[0], [p.number]);
    } else if (candidates.length > 1) {
      ambiguous.add(p.number);
    }
  }
  // A PR with two open children is a branching stack, which GitHub disallows.
  for (const [parent, kids] of children) {
    if (kids.length > 1) ambiguous.add(parent);
  }

  // `current`'s connected component, over the candidate links above.
  const seen = new Set<number>([current.number]);
  const component = [current.number];
  const queue = [current.number];
  while (queue.length > 0) {
    const node = queue.pop() as number;
    for (const next of neighbors.get(node) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      component.push(next);
      queue.push(next);
    }
  }
  if (component.some((n) => ambiguous.has(n))) return null;

  // Unambiguous: every link is unique in both directions, so the component is
  // one chain. No parentless member means a cycle — nothing to offer.
  const bottom = component.find((n) => !hasParent.has(n));
  if (bottom === undefined) return null;
  const chain = [bottom];
  let cursor = bottom;
  // Bounded by the component: an unambiguous component can't join a cycle to a
  // parentless bottom, so the cap is belt-and-braces against an infinite walk.
  while (chain.length < component.length) {
    const kids = children.get(cursor);
    if (kids?.length !== 1) break;
    cursor = kids[0];
    chain.push(cursor);
  }

  // The unstacked run containing `current`: stacked members bound it on both
  // sides, so an offer never proposes a PR that already belongs to a stack.
  const index = chain.indexOf(current.number);
  if (index < 0) return null;
  let lo = index;
  while (lo > 0 && !isStacked(byNumber.get(chain[lo - 1]))) lo--;
  let hi = index;
  while (hi + 1 < chain.length && !isStacked(byNumber.get(chain[hi + 1]))) hi++;
  const members = chain.slice(lo, hi + 1);

  const attach = lo > 0 ? byNumber.get(chain[lo - 1]) : undefined;
  if (attach?.stack) {
    // GitHub appends on top only, and only to its own native stacks — a
    // GitLab-inferred chain has no stack number to write to, and attaching
    // below a stack's top is rejected outright.
    if (!isNativeStack(attach.stack)) return null;
    if (attach.stack.position !== attach.stack.size) return null;
    const stackNumber = Number(attach.stack.id);
    if (!Number.isInteger(stackNumber) || stackNumber <= 0) return null;
    return {
      kind: "add",
      stackNumber,
      baseSize: attach.stack.size,
      members,
    };
  }
  // A new stack needs two members — GitHub's minimum.
  if (members.length < 2) return null;
  return { kind: "create", members };
}
