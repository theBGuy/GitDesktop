import { CheckIcon, CircleIcon, XIcon } from "@phosphor-icons/react";
import {
  type Ref,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { clipTitle } from "@/lib/clip-title";
import {
  offerIdentity,
  type StackOffer as StackOfferKind,
} from "@/lib/git/stack-chains";
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
  onDissolve,
  dissolving,
  disabled,
}: {
  stack: PrStackInfo | null | undefined;
  members: PrStackMember[] | undefined;
  /** The PR the detail view is showing — its row is highlighted and carries
   *  `aria-current`. It stays focusable so arrow-key nav can start from it. */
  currentNumber: number;
  onSelect: (number: number) => void;
  /** Runs the caller's confirmed dissolve. Absent ⇒ no Dissolve affordance —
   *  the caller owns the eligibility (native stack, open, writable). */
  onDissolve?: () => void;
  dissolving?: boolean;
  /** Holds the Dissolve action without claiming a write is running — the caller
   *  sets it while its own handler would refuse (e.g. a PR switch in flight). */
  disabled?: boolean;
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
        <StackHeader
          label={`Stack · ${stack.position} of ${Math.max(stack.size, stack.position)}`}
          onDissolve={onDissolve}
          dissolving={dissolving}
          disabled={disabled}
        />
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
      <StackHeader
        label={`Stack · ${stack.position} of ${Math.max(rows.length, stack.position)}`}
        onDissolve={onDissolve}
        dissolving={dissolving}
        disabled={disabled}
      />
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

/** The section's header line, plus the optional Dissolve action. The button is
 *  always visible (no hover-reveal) and its label carries the meaning — the
 *  destructive tone only arrives on hover/focus. */
function StackHeader({
  label,
  onDissolve,
  dissolving,
  disabled,
}: {
  label: string;
  onDissolve?: () => void;
  dissolving?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <p className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
        {label}
      </p>
      {onDissolve && (
        <Button
          variant="ghost"
          size="xs"
          className="shrink-0 cursor-pointer text-muted-foreground hover:text-destructive focus-visible:text-destructive"
          disabled={dissolving || disabled}
          onClick={onDissolve}
        >
          {dissolving && <Spinner data-icon="inline-start" />}
          Dissolve
        </Button>
      )}
    </div>
  );
}

/** Imperative surface for the palette twins of the offer's button: expand the
 *  preview from outside, exactly as pressing the button does. */
export interface StackOfferHandle {
  expand: () => void;
}

/** One offer member, as the detail view derives it from the open PR list. */
export interface StackOfferRow {
  number: number;
  title: string;
}

/**
 * The contextual stack offer that takes StackSection's place on an UNSTACKED
 * PR whose branch chain can be stacked. Collapsed it's one quiet line plus its
 * button; pressing the button (or the palette twin) expands an inline preview
 * of exactly what will be written, with Confirm/Cancel — never a modal, since
 * the offer is contextual to what's already on screen.
 */
export function StackOffer({
  offer,
  rows,
  pending,
  error,
  onConfirm,
  onCancel,
  disabled,
  ref,
}: {
  offer: StackOfferKind;
  /** The offer's members, bottom→top — same order as `offer.members`. */
  rows: StackOfferRow[];
  pending: boolean;
  /** The write's failure message, shown verbatim: the forge's 422s name the
   *  exact rule that was broken, which no rewrite of ours would improve. */
  error: string | null;
  onConfirm: () => void;
  /** Collapses the preview; the caller also clears any error with it. */
  onCancel: () => void;
  /** Holds Confirm and the collapsed expand button without claiming a write is
   *  running — the caller sets it while its own handler would refuse. Expanding
   *  has to hold too: it focuses Confirm, which is disabled here. Cancel stays
   *  live: it only dismisses. */
  disabled?: boolean;
  ref?: Ref<StackOfferHandle>;
}) {
  const [expanded, setExpanded] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  // A different offer (another PR, or the chain changed under us) starts
  // collapsed — a render-time reset, not an effect.
  const offerKey = offerIdentity(offer);
  const [lastKey, setLastKey] = useState(offerKey);
  if (offerKey !== lastKey) {
    setLastKey(offerKey);
    setExpanded(false);
  }
  // Expanding replaces the button that was focused, so focus has to be moved
  // deliberately or a keyboard user lands back on the document.
  useEffect(() => {
    if (expanded) confirmRef.current?.focus();
  }, [expanded]);
  // The focus call covers an ALREADY-expanded offer, where the effect above
  // won't re-fire; the first expansion is the effect's, since Confirm hasn't
  // mounted yet at this point.
  useImperativeHandle(
    ref,
    () => ({
      expand: () => {
        setExpanded(true);
        confirmRef.current?.focus();
      },
    }),
    [],
  );

  const count = offer.members.length;
  const line =
    offer.kind === "create"
      ? `These ${count} pull requests form a chain.`
      : `This chain sits on stack #${offer.stackNumber}.`;

  if (!expanded) {
    return (
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {line}
        </p>
        <Button
          variant="outline"
          size="xs"
          className="shrink-0 cursor-pointer"
          disabled={disabled}
          onClick={() => setExpanded(true)}
        >
          {offer.kind === "create" ? "Create stack" : "Add to stack"}
        </Button>
      </div>
    );
  }

  const confirmLabel =
    offer.kind === "create"
      ? `Create stack (${count} pull requests)`
      : count === 1
        ? `Add to stack #${offer.stackNumber}`
        : `Add ${count} to stack #${offer.stackNumber}`;

  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{line}</p>
      {/* The rows stay non-interactive (the members' own rows live in the PR
          list), but the scroller itself is a tab stop so its overflow is
          keyboard-scrollable — WebKit, unlike Chromium, doesn't make scrollers
          focusable on its own, and this preview is the pre-write safety check.
          Capped like the Stack section so a long chain can't push the tab row
          out of the header. */}
      <div
        role="group"
        aria-label={
          offer.kind === "create"
            ? "Pull requests to stack, bottom to top"
            : `Pull requests to add to stack #${offer.stackNumber}`
        }
        tabIndex={0}
        className="mt-1.5 max-h-48 overflow-y-auto border outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
      >
        {rows.map((row, i) => (
          <div
            key={row.number}
            className="flex w-full items-center gap-2 border-b px-3 py-1.5 text-xs last:border-b-0"
          >
            {/* The position each member will LAND at: an append starts above the
                stack's existing members, a new stack starts at 1. */}
            <span className="w-4 shrink-0 text-right text-muted-foreground tabular-nums">
              {(offer.kind === "add" ? offer.baseSize : 0) + i + 1}
            </span>
            <span className="shrink-0 font-mono text-muted-foreground">
              #{row.number}
            </span>
            <span
              className="min-w-0 flex-1 truncate"
              onMouseEnter={clipTitle(row.title)}
            >
              {row.title}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {offer.kind === "create"
          ? "They'll merge as one stack, bottom to top."
          : "It'll merge with the stack, bottom to top."}
      </p>
      <div className="mt-1.5 flex items-center gap-2">
        <Button
          ref={confirmRef}
          size="xs"
          className="cursor-pointer"
          disabled={pending || disabled}
          onClick={onConfirm}
        >
          {pending && <Spinner data-icon="inline-start" />}
          {confirmLabel}
        </Button>
        <Button
          variant="outline"
          size="xs"
          className="cursor-pointer"
          disabled={pending}
          onClick={() => {
            setExpanded(false);
            onCancel();
          }}
        >
          Cancel
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-1.5 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
