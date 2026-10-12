import { type ReactNode, useLayoutEffect, useRef } from "react";

import { cn, PLACEHOLDER_FADE } from "@/lib/utils";

/** Spread on the frame's PARENT, which must not be inert: an inert subtree is
 *  out of the accessibility tree, its aria-busy with it. */
export function heldParentProps(holding: boolean): { "aria-busy"?: true } {
  return holding ? { "aria-busy": true } : {};
}

/**
 * Wraps a detail view's content for `useEntityHold`: while `holding`, the old
 * item stays in flow, inert and dimmed the way the diff pane dims a held file.
 * Pass the layout classes the content needs from its box (`flex h-full
 * min-h-0 flex-col`) as `className`. Renders a focus sink just before the
 * frame, so its parent gets two children; the sink is absolutely positioned
 * (`sr-only`), so flex and grid layouts ignore it.
 */
export function HeldFrame({
  holding,
  inert = false,
  className,
  children,
}: {
  holding: boolean;
  /** Inert without the held dim, for a slot preparing out of sight. */
  inert?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  // A sibling of the frame: inside it, `inert` would blur the sink too, and a
  // focusable ancestor would take focus on every click into the content.
  const sinkRef = useRef<HTMLSpanElement>(null);
  // `inert` blurs a focused descendant to <body> after this commit; hand focus
  // to the sink first. Focus outside the frame (the list row the user moved
  // to) is left where it is.
  useLayoutEffect(() => {
    if (holding && frameRef.current?.contains(document.activeElement))
      sinkRef.current?.focus({ preventScroll: true });
  }, [holding]);
  return (
    <>
      <span ref={sinkRef} tabIndex={-1} className="sr-only" />
      <div
        ref={frameRef}
        className={cn(
          PLACEHOLDER_FADE,
          // The delay keeps a fast swap from flashing a half-dimmed view.
          holding && "opacity-80 delay-100",
          className,
        )}
        inert={holding || inert}
      >
        {children}
      </div>
    </>
  );
}
