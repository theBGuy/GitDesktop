import { CheckIcon, CircleIcon, XIcon } from "@phosphor-icons/react";
import { clipTitle } from "@/lib/clip-title";
import type { PrStackInfo, PrStackMember } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { cn } from "@/lib/utils";

/** Icon + word + tone for a stack member's state. An unrecognized state keeps the
 *  provider's own word at a neutral tone rather than being read as "open" — the
 *  word always carries the meaning, so color is never the only signal. */
function memberPresentation(state: string) {
  const key = state.trim().toLowerCase();
  switch (key) {
    case "merged":
      return { Icon: CheckIcon, tone: "text-merged", word: "merged" };
    case "closed":
      return { Icon: XIcon, tone: "text-destructive", word: "closed" };
    case "open":
      return { Icon: CircleIcon, tone: "text-success", word: "open" };
    default:
      // A member can arrive with no state at all; "unknown" keeps a word beside
      // the icon, which is the only thing carrying the status.
      return {
        Icon: CircleIcon,
        tone: "text-muted-foreground",
        word: key || "unknown",
      };
  }
}

/** Whether this is a forge-NATIVE stack, which merges atomically bottom-up, as
 *  opposed to an inferred chain whose members merge one at a time. The `id` shape
 *  is the contract, and both minting sites are the whole universe: `github/pr.rs`
 *  stringifies the numeric stack number, `forge/gitlab.rs` synthesizes
 *  "mr-<bottom-iid>". Provenance the payload carries itself, so a pending or
 *  failed forge-status probe can't skew it in either direction. */
export function isNativeStack(stack: PrStackInfo | null | undefined): boolean {
  return stack != null && !stack.id.startsWith("mr-");
}

/** Members sorted bottom-first, the order a stack merges in. */
function byPosition(members: PrStackMember[]): PrStackMember[] {
  return members.toSorted((a, b) => a.position - b.position);
}

/**
 * The stack members an atomic merge of `stack`'s PR would take with it:
 * everything still open below it, bottom-first.
 */
function stackMergeBelow(
  stack: PrStackInfo,
  members: PrStackMember[] | undefined,
): PrStackMember[] {
  return byPosition(
    (members ?? []).filter(
      (m) => m.position < stack.position && m.state.toLowerCase() === "open",
    ),
  );
}

/** "#4", "#4 and #5", "#4, #5, and #6" — the numbers a stacked merge sweeps in. */
function numberList(members: PrStackMember[]): string {
  const nums = members.map((m) => `#${m.number}`);
  if (nums.length <= 1) return nums.join("");
  if (nums.length === 2) return `${nums[0]} and ${nums[1]}`;
  return `${nums.slice(0, -1).join(", ")}, and ${nums.at(-1)}`;
}

/** The merge dialog's extra-scope sentence, plus a confirm label when the scope is
 *  known well enough to count. Null when the merge lands this PR alone. `atomic`
 *  gates the known-stack arms: only GitHub cascade-merges a stack bottom-up, while
 *  GitLab merges one MR and retargets the next, so disclosing extra scope there
 *  would describe a merge that never happens. `prNoun` carries the provider
 *  wording. */
export function stackMergeDisclosure({
  stack,
  members,
  stackUnknown,
  prNoun,
  atomic,
  hostCascades,
}: {
  stack: PrStackInfo | null | undefined;
  members: PrStackMember[] | undefined;
  /** The stack probe failed, so a null `stack` means unknown, not unstacked. */
  stackUnknown: boolean;
  prNoun: string;
  /** This KNOWN stack cascades — `isNativeStack`, read off the stack's own id. */
  atomic: boolean;
  /** The detected host is one where stacked merges CAN cascade. Only the unknown
   *  arm may use this: with no stack object there is no id to sniff, so host
   *  detection is the sole signal left — every other arm prefers the id, which
   *  survives a pending or failed forge probe. Best signal available rather than
   *  a guarantee (an unresolved provider routes GHES here too, and GHES has no
   *  stacks API), which is why that arm only ever hedges. */
  hostCascades: boolean;
}): { notice: string; confirmLabel?: string } | null {
  const tail = "the stack merges bottom-up as one operation.";
  if (stack) {
    if (!atomic) return null;
    const position = `This ${prNoun} is position ${stack.position} of ${stack.size} in a stack.`;
    // Known stack, missing member list: the members hop failed, not "nothing is
    // below" — name the scope without a count. (The arm below covers having no
    // stack info at all, which is a weaker claim still.)
    if ((members ?? []).length === 0) {
      if (stack.position <= 1) return null;
      return {
        notice: `${position} Merging it also merges every still-open ${prNoun} below it — ${tail}`,
        confirmLabel: "Merge stack",
      };
    }
    const below = stackMergeBelow(stack, members);
    if (below.length === 0) return null;
    return {
      notice: `${position} Merging it also merges ${numberList(below)} below it — ${tail}`,
      confirmLabel: `Merge ${below.length + 1} ${prNoun}s`,
    };
  }
  // No stack info at all. An unknown is NOT a stack: most such failures land on
  // ordinary unstacked PRs, so the copy hedges and the confirm label keeps its
  // count-free default rather than promising a stack merge that likely isn't one.
  if (!stackUnknown || !hostCascades) return null;
  return {
    notice:
      "Couldn't confirm whether this pull request is part of a stack. " +
      "If it is, merging it also merges every still-open pull request below it " +
      "— check on GitHub before confirming if unsure.",
  };
}

/**
 * The detail view's Stack section: the members of the open PR's stack, listed
 * bottom-first (merge order) with the one being read marked. Renders nothing at
 * all for an UNSTACKED PR — no header, no placeholder; a stacked PR whose member
 * list is missing still gets the header and a muted note. The data rides the
 * caller's PR-details query, so this has no loading state of its own.
 */
export function StackSection({
  stack,
  members,
  currentNumber,
  onSelect,
}: {
  stack: PrStackInfo | null | undefined;
  members: PrStackMember[] | undefined;
  /** The PR the detail view is showing — its row is highlighted and carries
   *  `aria-current`. It stays focusable so arrow-key nav can start from it. */
  currentNumber: number;
  onSelect: (number: number) => void;
}) {
  if (!stack) return null;
  const rows = byPosition(members ?? []);

  // Members ride a second fetch that can fail while the stack summary succeeds
  // (the backend emits the summary with an empty member list then) — still say
  // the PR is stacked, rather than hiding membership over a missing list.
  if (rows.length === 0) {
    return (
      <div>
        {/* Denominator source differs per arm and must stay that way: with no
            rows to count, the summary's own `size` is all there is; the max
            keeps a `position` past it from reading "3 of 2". */}
        <p className="text-xs font-medium text-muted-foreground">
          Stack · {stack.position} of {Math.max(stack.size, stack.position)}
        </p>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Couldn't load the stack's members.
        </p>
      </div>
    );
  }

  // `listKeyboardNav` calls no hooks, so it's safe to build after the early return.
  const onKeyDown = listKeyboardNav({
    items: rows,
    activeIndex: rows.findIndex((m) => m.number === currentNumber),
    onActivate: (member) => onSelect(member.number),
    rowKey: (member) => String(member.number),
  });

  return (
    <div>
      {/* The rows are the members we actually have, so they — not the summary's
          `size`, fetched on a separate hop — set the denominator; the max keeps
          a server `position` past the last row from reading "3 of 2". */}
      <p className="text-xs font-medium text-muted-foreground">
        Stack · {stack.position} of {Math.max(rows.length, stack.position)}
      </p>
      {/* Capped like the checks rollup so a deep stack can't push the tab row
          out of the header; arrow-nav scrolls the active row into view. */}
      <div
        className="mt-1.5 max-h-48 overflow-y-auto border"
        onKeyDown={onKeyDown}
      >
        {rows.map((member) => {
          const { Icon, tone, word } = memberPresentation(member.state);
          const isCurrent = member.number === currentNumber;
          return (
            <button
              key={member.number}
              type="button"
              data-row={String(member.number)}
              aria-current={isCurrent ? "true" : undefined}
              onClick={() => onSelect(member.number)}
              className={cn(
                "flex w-full items-center gap-2 border-b px-3 py-1.5 text-left text-xs last:border-b-0",
                isCurrent
                  ? "bg-accent text-accent-foreground"
                  : "cursor-pointer hover:bg-muted/60",
              )}
            >
              <span className="w-4 shrink-0 text-right text-muted-foreground tabular-nums">
                {member.position}
              </span>
              <span className="shrink-0 font-mono text-muted-foreground">
                #{member.number}
              </span>
              <span
                className="min-w-0 flex-1 truncate"
                onMouseEnter={clipTitle(member.title)}
              >
                {member.title}
              </span>
              <span className={cn("flex shrink-0 items-center gap-1", tone)}>
                <Icon className="size-3 shrink-0" weight="fill" aria-hidden />
                {word}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
