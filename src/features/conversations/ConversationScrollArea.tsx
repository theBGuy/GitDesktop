import { ArrowDownIcon, ArrowUpIcon } from "@phosphor-icons/react";
import { AnimatePresence, m } from "motion/react";
import {
  type ReactNode,
  type Ref,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { quickTransition } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** The palette's route to a thread's extremes. Both jumps hand focus to the
 *  scroller afterwards, so Home/End/arrows keep scrolling natively. */
export interface ConversationScrollHandle {
  jumpToTop(): void;
  jumpToBottom(): void;
}

// Within this many px of an extreme counts as being there — the same slack as
// the agent canvas's "Latest" pill.
const EDGE_SLACK = 48;

// Each button owns a fixed slot of its own size, so neither moves while the
// other enters or leaves.
const JUMP_SLOT_CLASS = "size-6";

const JUMP_BUTTON_CLASS =
  "pointer-events-auto flex size-6 items-center justify-center border bg-background p-1 shadow-sm transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none";

// The vendored Viewport's own focus ring is a box-shadow the Root's
// overflow-hidden clips away, so the wrapper draws one: inset (its own
// overflow-hidden would clip an outset ring) and on an overlay above the
// thread's content, matched on OUR viewport only, not a nested scroll area's.
const VIEWPORT_FOCUS_RING_CLASS =
  "after:pointer-events-none after:absolute after:inset-0 has-[>[data-slot=scroll-area]>[data-slot=scroll-area-viewport]:focus-visible]:after:ring-2 has-[>[data-slot=scroll-area]>[data-slot=scroll-area-viewport]:focus-visible]:after:ring-ring has-[>[data-slot=scroll-area]>[data-slot=scroll-area-viewport]:focus-visible]:after:ring-inset";

// The vendored ScrollArea puts children inside Base UI's Viewport, and the
// Viewport is the element that actually scrolls.
function viewportOf(area: HTMLElement | null) {
  return (
    area?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ??
    null
  );
}

function edgesOf(el: HTMLElement) {
  return {
    atTop: el.scrollTop < EDGE_SLACK,
    atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < EDGE_SLACK,
  };
}

/**
 * A conversation thread's scroll region with scroll-aware jump-to-top/bottom
 * buttons over its bottom-right corner. Each button shows only while its
 * extreme is out of reach, so a thread that fits renders neither.
 */
export function ConversationScrollArea({
  ref,
  className,
  children,
}: {
  ref?: Ref<ConversationScrollHandle>;
  /** Layout classes for the outer wrapper (it supplies its own
   *  `relative min-h-0 overflow-hidden`). */
  className?: string;
  children: ReactNode;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  // True while a smooth jump animates, so the intermediate positions don't
  // flicker the buttons; the jump settles the real edges once it lands.
  const jumping = useRef(false);
  const cancelJump = useRef<(() => void) | null>(null);
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const el = viewportOf(areaRef.current);
    if (!el) return;
    const measure = () => {
      if (jumping.current) return;
      const edges = edgesOf(el);
      setAtTop(edges.atTop);
      setAtBottom(edges.atBottom);
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    // Content growth while parked at an extreme never fires a scroll event, so
    // the content box is observed too, not just the viewport.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
      cancelJump.current?.();
    };
  }, []);

  function jump(to: "top" | "bottom") {
    const el = viewportOf(areaRef.current);
    if (!el) return;
    cancelJump.current?.();
    // The destination's edges up front, so the activated button leaves now
    // rather than once the animation lands.
    const fits = el.scrollHeight - el.clientHeight < EDGE_SLACK;
    setAtTop(to === "top" || fits);
    setAtBottom(to === "bottom" || fits);
    const top = to === "top" ? 0 : el.scrollHeight - el.clientHeight;
    // A jump already at its target never fires `scrollend`, so it scrolls
    // nothing and arms no guard (the edges set above already describe it);
    // arming one would suppress measures until the fallback.
    const moves = Math.abs(el.scrollTop - top) >= 1;
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (moves && reduceMotion) {
      el.scrollTop = top;
    } else if (moves) {
      jumping.current = true;
      const cleanup = () => {
        el.removeEventListener("scrollend", done);
        window.clearTimeout(fallback);
        jumping.current = false;
        cancelJump.current = null;
      };
      const done = () => {
        cleanup();
        const edges = edgesOf(el);
        setAtTop(edges.atTop);
        setAtBottom(edges.atBottom);
      };
      el.addEventListener("scrollend", done);
      // For engines without `scrollend`.
      const fallback = window.setTimeout(done, 1000);
      cancelJump.current = cleanup;
      el.scrollTo({ top, behavior: "smooth" });
    }
    // The activated button may unmount at its extreme; parking focus on the
    // scroller keeps it useful. Only while it overflows: Base UI makes it
    // tabbable then, and Tab-unreachable otherwise.
    if (el.scrollHeight > el.clientHeight) el.focus({ preventScroll: true });
  }

  useImperativeHandle(ref, () => ({
    jumpToTop: () => jump("top"),
    jumpToBottom: () => jump("bottom"),
  }));

  // overflow-hidden on both layers contains the thread's natural height (the
  // vendored Root is `relative`-only), so a long thread can't leak a window
  // scrollbar.
  return (
    <div
      className={cn(
        "relative min-h-0 overflow-hidden",
        VIEWPORT_FOCUS_RING_CLASS,
        className,
      )}
    >
      <ScrollArea ref={areaRef} className="h-full overflow-hidden">
        {children}
      </ScrollArea>
      {/* right-4 clears the w-2.5 scrollbar rail; pointer-events-none keeps an
          empty slot from swallowing clicks meant for the thread. */}
      <div className="pointer-events-none absolute right-4 bottom-3 z-10 flex flex-col gap-1">
        <div className={JUMP_SLOT_CLASS}>
          <AnimatePresence>
            {!atTop && (
              <m.button
                key="top"
                type="button"
                aria-label="Jump to top"
                title="Jump to top"
                onClick={() => jump("top")}
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={quickTransition}
                className={JUMP_BUTTON_CLASS}
              >
                <ArrowUpIcon className="size-3.5" aria-hidden="true" />
              </m.button>
            )}
          </AnimatePresence>
        </div>
        <div className={JUMP_SLOT_CLASS}>
          <AnimatePresence>
            {!atBottom && (
              <m.button
                key="bottom"
                type="button"
                aria-label="Jump to bottom"
                title="Jump to bottom"
                onClick={() => jump("bottom")}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                transition={quickTransition}
                className={JUMP_BUTTON_CLASS}
              >
                <ArrowDownIcon className="size-3.5" aria-hidden="true" />
              </m.button>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
