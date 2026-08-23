import {
  CheckCircleIcon,
  CircleDashedIcon,
  GitPullRequestIcon,
} from "@phosphor-icons/react";
import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ForgeUserAvatar } from "@/components/forge-user-avatar";
import type {
  MentionCandidate,
  MentionSource,
  MentionTrigger,
} from "@/features/conversations/useMentionCandidates";
import { eventToBinding } from "@/lib/hotkeys/binding";
import { getCaretCoordinates } from "@/lib/textarea-caret";
import { cn } from "@/lib/utils";

/** Every trigger char, whichever provider is in play: a token's query never spans
 *  one, so `@a#b` opens on `#b` rather than completing `a#b`. */
const ALL_TRIGGERS = "@#!";

/** `w-72` — the popover's fixed width, needed before it is laid out to clamp it. */
const POPOVER_WIDTH = 288;
/** `max-h-56` — the ceiling the viewport clamp works down from. */
const MAX_LIST_HEIGHT = 224;
/** Keeps the popover off the viewport edges. */
const GUTTER = 8;
/** Enough of a row to estimate the list's height before it renders. */
const ROW_HEIGHT = 28;
/** Below this the flipped side is not worth taking. */
const MIN_LIST_HEIGHT = 72;

/** Keys that can move the caret without changing the text — the token has to be
 *  recomputed after them or a popover outlives the token it belongs to. The
 *  vertical arrows only qualify when the popover declined them (no matches to
 *  walk), which is when the caret actually moves. */
const RESYNC_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
]);

/** Cached per trigger set: the token regexes are rebuilt on every keystroke otherwise. */
const REGEX_CACHE = new Map<string, RegExp>();

/** A trigger char at the start of the text or after whitespace, then the query. */
function tokenRegex(triggers: readonly MentionTrigger[]): RegExp {
  const key = triggers.join("");
  const cached = REGEX_CACHE.get(key);
  if (cached) return cached;
  const re = new RegExp(`(?:^|\\s)([${key}])([^\\s${ALL_TRIGGERS}]*)$`);
  REGEX_CACHE.set(key, re);
  return re;
}

/** An open token plus the viewport-fixed box the popover was placed in for it. */
interface ActiveToken {
  trigger: MentionTrigger;
  query: string;
  /** Index of the trigger char in the draft. */
  start: number;
  left: number;
  /** Set when the popover hangs below the caret line; `bottom` is set instead when
   *  it was flipped above. */
  top: number | null;
  bottom: number | null;
  maxHeight: number;
}

/** Place the popover against the caret: below its line by default, flipped above
 *  when the space under it can't hold the list, and always inside the gutters. */
function place(
  textarea: HTMLTextAreaElement,
  caret: number,
  rowCount: number,
): Omit<ActiveToken, "trigger" | "query" | "start"> {
  const rect = textarea.getBoundingClientRect();
  const coords = getCaretCoordinates(textarea, caret);
  const caretTop = rect.top + coords.top - textarea.scrollTop;
  const caretBottom = caretTop + coords.height;
  const left = Math.min(
    Math.max(rect.left + coords.left - textarea.scrollLeft, GUTTER),
    Math.max(window.innerWidth - POPOVER_WIDTH - GUTTER, GUTTER),
  );
  const wanted = Math.min(
    MAX_LIST_HEIGHT,
    Math.max(rowCount, 1) * ROW_HEIGHT + GUTTER,
  );
  const spaceBelow = window.innerHeight - caretBottom - 2 - GUTTER;
  const spaceAbove = caretTop - 2 - GUTTER;
  // Flip only when the space above is actually the better of the two — a caret with
  // no room on either side keeps the reading direction it started in.
  if (spaceBelow < wanted && spaceAbove > spaceBelow) {
    return {
      left,
      top: null,
      bottom: window.innerHeight - caretTop + 2,
      maxHeight: Math.max(
        Math.min(MAX_LIST_HEIGHT, spaceAbove),
        MIN_LIST_HEIGHT,
      ),
    };
  }
  return {
    left,
    top: caretBottom + 2,
    bottom: null,
    maxHeight: Math.max(Math.min(MAX_LIST_HEIGHT, spaceBelow), MIN_LIST_HEIGHT),
  };
}

/**
 * GitHub-style `@`/`#`/`!` completion for a textarea: token detection, the caret-
 * anchored listbox, and the keyboard contract the popover owns while a token is
 * open. Opt-in — with no `mentions` source nothing is rendered, listened to, or
 * queried, which is what keeps the surfaces that don't wire it byte-identical.
 *
 * Ported from the session composer's mention mechanics; two details there are
 * load-bearing and kept verbatim: rows commit on `mousedown` with `preventDefault`
 * so the textarea never blurs before the splice lands, and the insert goes through
 * `document.execCommand` so one undo reverts the whole completion.
 */
export function useMentionAutocomplete({
  mentions,
  textareaRef,
  value,
  onChange,
  suspended,
}: {
  mentions: MentionSource | undefined;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
  /** Preview mode or a disabled editor: no token opens and an open one closes. */
  suspended: boolean;
}) {
  const [token, setToken] = useState<ActiveToken | null>(null);
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  // Swallows the one onChange an accepted completion produces (see `insert`).
  const skipSync = useRef(false);
  // Whether the popover took the last keydown, read by its keyup twin.
  const lastConsumed = useRef(false);
  const listId = useId();

  // Render-time reset rather than an effect: a popover must never paint over a
  // preview pane or a frozen editor, not even for one commit.
  if (token && (suspended || !mentions)) setToken(null);

  const open = token !== null && !suspended && !!mentions;
  const result = open ? mentions.query(token.trigger, token.query) : null;
  const items = result?.items ?? [];
  // The list can shrink under a stale index while data arrives.
  const activeIndex = items.length > 0 ? Math.min(index, items.length - 1) : 0;

  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      // The listbox scrolls itself as you arrow through it; only the page moving
      // underneath invalidates the caret anchor.
      const list = listRef.current;
      if (list && e.target instanceof Node && list.contains(e.target)) return;
      setToken(null);
    };
    const dismiss = () => setToken(null);
    const opts = { capture: true, passive: true } as const;
    window.addEventListener("scroll", onScroll, opts);
    window.addEventListener("resize", dismiss, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll, opts);
      window.removeEventListener("resize", dismiss);
    };
  }, [open]);

  /** Recompute the token from the text up to the caret, and re-place the popover. */
  function sync(next: string, caret: number) {
    const ta = textareaRef.current;
    if (skipSync.current) {
      setToken(null);
      return;
    }
    if (!mentions || suspended || !ta || mentions.triggers.length === 0) {
      setToken(null);
      return;
    }
    const m = next.slice(0, caret).match(tokenRegex(mentions.triggers));
    if (!m) {
      setToken(null);
      return;
    }
    const trigger = m[1] as MentionTrigger;
    const query = m[2];
    mentions.onActive();
    setIndex(0);
    setToken({
      trigger,
      query,
      start: caret - query.length - 1,
      ...place(ta, caret, mentions.query(trigger, query).items.length),
    });
  }

  /** Re-sync from the live caret — for the keys that move it without editing. */
  function resync() {
    const ta = textareaRef.current;
    if (ta) sync(ta.value, ta.selectionStart ?? ta.value.length);
  }

  function insert(candidate: MentionCandidate) {
    const ta = textareaRef.current;
    if (!token || !ta) return;
    const end = token.start + 1 + token.query.length;
    const rest = value.slice(end);
    // No double space when completing mid-sentence.
    const text = `${token.trigger}${candidate.insert}${rest.startsWith(" ") ? "" : " "}`;
    setToken(null);
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(token.start, end);
    // execCommand keeps the textarea's native undo stack intact, so one Ctrl+Z
    // reverts the whole completion (see the editor's runAction for the same reason).
    // Its synchronous `input` event reaches the editor's onChange, which would
    // re-open the token it just completed when the completion needed no trailing
    // space (the caret then still sits at the end of `@login`).
    skipSync.current = true;
    const ok = document.execCommand("insertText", false, text);
    skipSync.current = false;
    if (!ok) {
      // Fallback (not expected on our webviews): a controlled rewrite, which lands
      // one frame later and so has to restore the caret itself.
      onChange(value.slice(0, token.start) + text + rest);
      const pos = token.start + text.length;
      requestAnimationFrame(() => {
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(pos, pos);
      });
    }
  }

  function handleKey(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!open) return false;
    // The submit chord always reaches the consumer, popover or not.
    if (e.key === "Enter" && eventToBinding(e)?.startsWith("mod+"))
      return false;
    // An Enter that commits an IME composition belongs to the composition: the
    // reference titles searched here are frequently CJK, so consuming it would
    // splice a suggestion in place of the text being typed. The token survives and
    // re-syncs on the commit's own onChange.
    if (e.key === "Enter" && e.nativeEvent.isComposing) return false;
    if (e.key === "Escape") {
      e.preventDefault();
      // The line-widget composers close themselves on Escape; dismissing a
      // suggestion must not also throw away the box it was typed in.
      e.stopPropagation();
      setToken(null);
      return true;
    }
    if (items.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setIndex((i) => (Math.min(i, items.length - 1) + 1) % items.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setIndex(
          (i) =>
            (Math.min(i, items.length - 1) - 1 + items.length) % items.length,
        );
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insert(items[activeIndex]);
        return true;
      }
    } else if (e.key === "Enter" || e.key === "Tab") {
      // Token open with nothing to complete: dismiss rather than submit the
      // half-typed reference.
      e.preventDefault();
      setToken(null);
      return true;
    }
    return false;
  }

  /** Returns true when the popover consumed the key. */
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
    const consumed = handleKey(e);
    lastConsumed.current = consumed;
    return consumed;
  }

  // A source whose provider offers no trigger never opens a token, so it gets no
  // handlers and advertises no autocomplete.
  const wired = !!mentions && mentions.triggers.length > 0;

  const textareaProps = wired
    ? {
        "aria-autocomplete": "list" as const,
        "aria-expanded": open,
        "aria-controls": open ? listId : undefined,
        "aria-activedescendant":
          open && items.length > 0 ? `${listId}-${activeIndex}` : undefined,
        onBlur: () => setToken(null),
        onMouseDown: () => setToken(null),
        onKeyUp: (e: KeyboardEvent<HTMLTextAreaElement>) => {
          // Only an arrow the popover declined moved the caret; re-syncing after
          // one it consumed would reset the row that arrow just highlighted.
          if (!lastConsumed.current && RESYNC_KEYS.has(e.key)) resync();
        },
      }
    : undefined;

  const popover =
    open && token ? (
      <MentionPopover
        listId={listId}
        listRef={listRef}
        items={items}
        loading={result?.loading ?? false}
        activeIndex={activeIndex}
        ghHost={mentions.ghHost}
        token={token}
        onPick={insert}
        onHover={setIndex}
      />
    ) : null;

  return { textareaProps, sync, onKeyDown, popover };
}

/** Open/closed glyph for a suggested reference. Mirrors the Issues panel's
 *  `StateIcon` (shape carries the state, not the tint alone); local rather than
 *  imported so the editor doesn't pull the issue-relations module into its chunk. */
function RefGlyph({ state, isPr }: { state: string; isPr: boolean }) {
  if (isPr) {
    return (
      <GitPullRequestIcon
        className={cn(
          "size-3.5 shrink-0",
          state === "OPEN" ? "text-success" : "text-merged",
        )}
      />
    );
  }
  return state === "CLOSED" ? (
    <CheckCircleIcon className="size-3.5 shrink-0 text-merged" />
  ) : (
    <CircleDashedIcon className="size-3.5 shrink-0 text-success" />
  );
}

/** The caret-anchored suggestion listbox. Portalled to the body and fixed-
 *  positioned: the composer sits inside overflow containers that would clip it. */
function MentionPopover({
  listId,
  listRef,
  items,
  loading,
  activeIndex,
  ghHost,
  token,
  onPick,
  onHover,
}: {
  listId: string;
  listRef: RefObject<HTMLDivElement | null>;
  items: MentionCandidate[];
  loading: boolean;
  activeIndex: number;
  ghHost: string | null;
  token: ActiveToken;
  onPick: (candidate: MentionCandidate) => void;
  onHover: (i: number) => void;
}) {
  // Keep the keyboard-highlighted row visible while arrowing through a list that
  // is taller than the box.
  useEffect(() => {
    document
      .getElementById(`${listId}-${activeIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [listId, activeIndex]);

  return createPortal(
    <div
      ref={listRef}
      id={listId}
      role="listbox"
      aria-label="Mention suggestions"
      style={{
        position: "fixed",
        left: token.left,
        top: token.top ?? undefined,
        bottom: token.bottom ?? undefined,
        maxHeight: token.maxHeight,
      }}
      className="z-50 w-72 overflow-y-auto border bg-popover shadow-md ring-1 ring-foreground/10"
    >
      {items.length === 0 ? (
        <p className="px-2.5 py-2 text-[11px] text-muted-foreground">
          {loading ? "Loading…" : "No matches"}
        </p>
      ) : (
        items.map((c, i) => (
          <button
            key={c.key}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === activeIndex}
            type="button"
            // mousedown (not click) so the textarea doesn't blur before the insert
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(c);
            }}
            onMouseMove={() => onHover(i)}
            className={cn(
              "flex w-full min-w-0 items-center gap-1.5 px-2.5 py-1.5 text-left text-xs",
              i === activeIndex
                ? "bg-accent text-accent-foreground"
                : "hover:bg-muted/60",
            )}
          >
            {c.user && (
              <ForgeUserAvatar user={c.user} ghHost={ghHost} decorative />
            )}
            {c.refGlyph && (
              <>
                <RefGlyph state={c.refGlyph.state} isPr={c.refGlyph.isPr} />
                <span className="shrink-0 font-mono text-muted-foreground">
                  {c.refGlyph.numberLabel}
                </span>
              </>
            )}
            <span className="truncate">{c.label}</span>
            {c.detail && (
              <span className="truncate text-[11px] text-muted-foreground">
                {c.detail}
              </span>
            )}
          </button>
        ))
      )}
    </div>,
    document.body,
  );
}
