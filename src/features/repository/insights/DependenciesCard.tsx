import { useVirtualizer } from "@tanstack/react-virtual";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isUserDismissal } from "@/components/panel-portal";
import { Button } from "@/components/ui/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { Input } from "@/components/ui/input";
import type { DependencyPackage, RepoDependencies } from "@/lib/git/types";
import {
  CARD_CLOSE_DELAY,
  CARD_OPEN_DELAY,
  cancelFrame,
  cancelTimer,
} from "@/lib/hover-card-timing";
import { toastError } from "@/lib/toast";
import { fmt } from "./primitives";
import { canFetchPackageInfo, usePackageInfo } from "./usePackageInfo";

/** The package's page on its ecosystem's registry (or repo, for GitHub Actions). */
function packageUrl(ecosystem: string, name: string): string | null {
  switch (ecosystem) {
    case "npm":
      return `https://www.npmjs.com/package/${name}`;
    case "pypi":
    case "pip":
      return `https://pypi.org/project/${name}/`;
    case "cargo":
      return `https://crates.io/crates/${name}`;
    case "githubactions":
    case "actions":
    case "swift":
      // These names are already "owner/repo".
      return `https://github.com/${name}`;
    case "golang":
    case "go":
      return `https://pkg.go.dev/${name}`;
    case "gem":
    case "rubygems":
      return `https://rubygems.org/gems/${name}`;
    case "composer":
      return `https://packagist.org/packages/${name}`;
    case "nuget":
      return `https://www.nuget.org/packages/${name}`;
    case "pub":
      return `https://pub.dev/packages/${name}`;
    case "maven":
      return `https://central.sonatype.com/artifact/${name.replace(":", "/")}`;
    default:
      return null;
  }
}

/** Viewport geometry the card's inert trigger span is pinned to. */
interface AnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A row's handle on its own card — every field stable for the row's life, so
 *  the object doubles as the row's identity in the latch below. */
interface CardOwner {
  timer: React.RefObject<ReturnType<typeof setTimeout> | null>;
  frame: React.RefObject<number | null>;
  pointerHeld: React.RefObject<boolean>;
  setOpen: (open: boolean) => void;
}

/** Which row's card is open, across the whole list. The keyboard route can open
 *  a card on a row the pointer never visits, so no pointer path reaches it and
 *  hovering another row would float a second card beside it. Imperative only;
 *  nothing renders from this. */
let activeCard: CardOwner | null = null;

/** Drops a row's claim, ignoring a row that no longer holds it — an evicted row
 *  must never clear the card that replaced it. */
function releaseCard(owner: CardOwner) {
  if (activeCard === owner) activeCard = null;
}

/** Everything that can open or hold a card, torn down together. The pointer
 *  claim has to go with it: removing a hovered node fires no `pointerleave`, so
 *  a card closed under the pointer would leave the claim set forever, and the
 *  row's next keyboard card would refuse to close on blur. */
function resetCard(owner: CardOwner) {
  cancelTimer(owner.timer);
  cancelFrame(owner.frame);
  owner.pointerHeld.current = false;
  owner.setOpen(false);
  releaseCard(owner);
}

/** Hands the single open card to `owner`, tearing down whoever held it. */
function claimCard(owner: CardOwner) {
  if (activeCard !== null && activeCard !== owner) resetCard(activeCard);
  activeCard = owner;
}

/** One dependency row: clickable name (opens its registry/repo) + a hovercard
 *  that lazily fetches the package's description. */
function DependencyRow({ p }: { p: DependencyPackage }) {
  const [open, setOpen] = useState(false);
  // Kept through the close fade so the exit animation plays where the card was.
  const [rect, setRect] = useState<AnchorRect | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  // One timer for both delays — the row is either dwelling toward an open or
  // waiting out a close, never both.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frame = useRef<number | null>(null);
  // Transient: read once, at open. A state write per pointer move would re-render
  // the row on every pixel.
  const cursorX = useRef(0);
  const cursorY = useRef(0);
  // Whether the pointer rests on the row or inside the popup. Blur must not close
  // a card the mouse still holds — clicking the name blurs it on the way out.
  const pointerHeld = useRef(false);
  // Built once: the latch compares rows by this object's identity, so it has to
  // outlive every render.
  const [card] = useState<CardOwner>(() => ({
    timer,
    frame,
    pointerHeld,
    setOpen,
  }));
  const cardId = useId();
  const url = packageUrl(p.ecosystem, p.name);
  const info = usePackageInfo(p.ecosystem, p.name, open);
  const fetchable = canFetchPackageInfo(p.ecosystem);

  // The card is pinned to the rect measured at open while the virtualized rows
  // translate under it, so any scroll or resize strands it. Capture-phase: the
  // list's own scroll doesn't bubble. A frame late, because Tab's
  // scroll-into-view can land in the same frame the focus route measured after.
  useEffect(() => {
    if (!open) return;
    let subscribed = false;
    const close = () => resetCard(card);
    const raf = requestAnimationFrame(() => {
      subscribed = true;
      window.addEventListener("scroll", close, true);
      window.addEventListener("resize", close);
    });
    return () => {
      cancelAnimationFrame(raf);
      if (!subscribed) return;
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open, card]);

  // The virtualizer evicts rows mid-dwell, and an evicted row that still held
  // the latch would tear down whichever card claims it next.
  useEffect(
    () => () => {
      cancelTimer(card.timer);
      cancelFrame(card.frame);
      releaseCard(card);
    },
    [card],
  );

  function showAt(anchor: AnchorRect) {
    claimCard(card);
    setRect(anchor);
    setOpen(true);
  }

  function dismiss() {
    resetCard(card);
  }

  /** A 1px anchor at the pointer's x spanning the row's height, so the popup
   *  lands under the cursor rather than centered on the full-width row. The row
   *  can scroll out from under a pending dwell, so the pointer has to still be
   *  on it; x is then clamped to it. */
  function openAtCursor() {
    const row = rowRef.current;
    if (!row) return;
    const r = row.getBoundingClientRect();
    if (cursorY.current < r.top || cursorY.current > r.bottom) return;
    const left = Math.min(Math.max(cursorX.current, r.left), r.right - 1);
    showAt({ left, top: r.top, width: 1, height: r.height });
  }

  function armOpen(e: React.PointerEvent) {
    cursorX.current = e.clientX;
    cursorY.current = e.clientY;
    if (timer.current !== null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      openAtCursor();
    }, CARD_OPEN_DELAY);
  }

  /** The grace before an open card goes: re-entering the row or the popup
   *  cancels it. */
  function scheduleClose() {
    cancelTimer(timer);
    timer.current = setTimeout(() => {
      timer.current = null;
      dismiss();
    }, CARD_CLOSE_DELAY);
  }

  function onRowPointerEnter(e: React.PointerEvent) {
    pointerHeld.current = true;
    // Cancels the close armed on the way out — of the row, or of the popup the
    // pointer is coming back from.
    cancelTimer(timer);
    if (open) return;
    armOpen(e);
  }

  function onRowPointerMove(e: React.PointerEvent) {
    // An open card stays where it opened; only a closed one tracks the cursor.
    if (open) return;
    armOpen(e);
  }

  function onRowPointerLeave() {
    pointerHeld.current = false;
    cancelTimer(timer);
    if (open) scheduleClose();
  }

  function onNameFocus(e: React.FocusEvent<HTMLButtonElement>) {
    const el = e.currentTarget;
    // Keyboard arrival only — a click focuses the button too, and popping a card
    // under the pointer that just clicked reads as a misfire.
    if (!el.matches(":focus-visible")) return;
    cancelTimer(timer);
    cancelFrame(frame);
    // A frame late: Tab fires focus before scrolling its target into view, so
    // the rect measured now would be the pre-scroll one.
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const r = el.getBoundingClientRect();
      showAt({ left: r.left, top: r.top, width: r.width, height: r.height });
    });
  }

  function onNameBlur() {
    cancelFrame(frame);
    // A pointer claim outlives focus: resting on the row keeps the card, and the
    // pointer route owns closing that one.
    if (pointerHeld.current) return;
    dismiss();
  }

  /** Opening the registry page hands focus to another application, where no
   *  pointer or blur event can reach a card left open or a dwell left armed. */
  function openPackageUrl(target: string) {
    dismiss();
    openUrl(target).catch(toastError);
  }

  return (
    <>
      <div
        ref={rowRef}
        onPointerEnter={onRowPointerEnter}
        onPointerMove={onRowPointerMove}
        onPointerLeave={onRowPointerLeave}
        className="flex w-full items-baseline gap-2 border-b px-2 py-1 text-xs"
      >
        {url ? (
          <button
            type="button"
            className="min-w-0 flex-1 cursor-pointer truncate text-left font-mono hover:underline focus-visible:underline focus-visible:outline-none"
            aria-describedby={open ? cardId : undefined}
            onFocus={onNameFocus}
            onBlur={onNameBlur}
            onClick={() => openPackageUrl(url)}
          >
            {p.name}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono">{p.name}</span>
        )}
        {p.direct && (
          <span className="shrink-0 rounded-none bg-accent px-1 text-[10px] text-accent-foreground">
            direct
          </span>
        )}
        <span className="shrink-0 rounded-none bg-muted px-1 text-[10px] text-muted-foreground">
          {p.ecosystem}
        </span>
        {p.version && (
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {p.version}
          </span>
        )}
      </div>
      {/* Portalled to the body because the virtualizer gives every row wrapper a
          `transform`, which makes it the containing block for `position: fixed`
          descendants — the trigger span's viewport coordinates would resolve
          against the row instead. Context crosses a portal, so the popup's own
          `usePanelPortalContainer()` still scopes it to the panel. */}
      {createPortal(
        <HoverCard
          open={open}
          // The inert trigger's own hover machinery can never see the pointer
          // over it (pointer-events: none), so it schedules a hover close after
          // every open — metronomic flicker. Only a real dismissal may close it.
          onOpenChange={(next, eventDetails) => {
            if (!next && !isUserDismissal(eventDetails.reason)) {
              eventDetails.cancel();
              return;
            }
            if (!next) {
              dismiss();
              return;
            }
            claimCard(card);
            setOpen(true);
          }}
        >
          {/* Kept mounted through the close fade — an unmounting trigger
              force-closes the card mid-animation. A store-registered trigger is
              what Base UI measures correctly; the positioner's `anchor` prop
              yields a 0×0 rect. */}
          <HoverCardTrigger
            render={
              <span
                aria-hidden
                className="pointer-events-none fixed"
                style={
                  rect
                    ? {
                        left: rect.left,
                        top: rect.top,
                        width: rect.width,
                        height: rect.height,
                      }
                    : { display: "none" }
                }
              />
            }
          />
          <HoverCardContent
            id={cardId}
            className="w-72 space-y-1.5"
            // The card opens empty and fills in, but `aria-describedby` resolves
            // once, at focus — so the popup is a polite live region and the
            // description announces itself when it lands. `aria-busy` holds that
            // announcement until the swap is done.
            role="status"
            aria-busy={fetchable && info.isFetching}
            onPointerEnter={() => {
              pointerHeld.current = true;
              cancelTimer(timer);
            }}
            onPointerLeave={() => {
              pointerHeld.current = false;
              scheduleClose();
            }}
          >
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium">
                {p.name}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {p.direct ? "direct" : "transitive"}
              </span>
            </div>
            {fetchable &&
              (info.isFetching ? (
                <p className="text-[11px] text-muted-foreground italic">
                  Loading…
                </p>
              ) : info.data?.description ? (
                <p className="text-[11px] text-muted-foreground">
                  {info.data.description}
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground italic">
                  No description available.
                </p>
              ))}
            <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
              <span className="truncate">
                {p.ecosystem}
                {p.version ? ` · ${p.version}` : ""}
              </span>
              {url && (
                <button
                  type="button"
                  className="shrink-0 cursor-pointer hover:text-foreground hover:underline"
                  onClick={() => openPackageUrl(url)}
                >
                  Open ↗
                </button>
              )}
            </div>
          </HoverCardContent>
        </HoverCard>,
        document.body,
      )}
    </>
  );
}

export function DependenciesCard({ data }: { data: RepoDependencies }) {
  const [filter, setFilter] = useState("");
  const [directOnly, setDirectOnly] = useState(false);
  // State-backed so the virtualizer observes the scroll element when it mounts.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  const directCount = useMemo(
    () => data.packages.filter((p) => p.direct).length,
    [data.packages],
  );
  const q = filter.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      data.packages.filter(
        (p) =>
          (!directOnly || p.direct) &&
          (!q ||
            p.name.toLowerCase().includes(q) ||
            p.ecosystem.toLowerCase().includes(q)),
      ),
    [data.packages, directOnly, q],
  );

  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => 26,
    overscan: 12,
  });

  if (!data.available) {
    return (
      <p className="text-xs text-muted-foreground">
        No dependency graph for this repository — it may be turned off in
        Settings → Security.
      </p>
    );
  }
  if (data.total === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No dependencies detected by the dependency graph.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground tabular-nums">
            {fmt(data.total)}
          </span>{" "}
          total · <span className="tabular-nums">{fmt(directCount)}</span>{" "}
          direct
          {(q || directOnly) && (
            <>
              {" · "}
              <span className="tabular-nums">{fmt(filtered.length)}</span> shown
            </>
          )}
        </p>
        <Button
          type="button"
          size="xs"
          variant={directOnly ? "secondary" : "ghost"}
          aria-pressed={directOnly}
          onClick={() => setDirectOnly((v) => !v)}
        >
          Direct only
        </Button>
      </div>
      <Input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter dependencies"
        aria-label="Filter dependencies"
        className="h-7"
        autoComplete="off"
      />
      <div ref={setScrollEl} className="h-56 overflow-y-auto border">
        {filtered.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">
            No dependencies match.
          </p>
        ) : (
          <div
            className="relative w-full"
            style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
          >
            {rowVirtualizer.getVirtualItems().map((vi) => {
              const p = filtered[vi.index];
              return (
                <div
                  key={`${p.ecosystem}:${p.name}`}
                  data-index={vi.index}
                  ref={rowVirtualizer.measureElement}
                  className="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${vi.start}px)` }}
                >
                  <DependencyRow p={p} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
