import type { ReactNode, Ref } from "react";
import { PathText } from "@/components/path-text";

// Boot-path file: the lazy wrappers' Suspense fallback renders from here, so it
// must not import DiffSurface, DiffViewer or diff-rows (DiffSurfaceLazy.tsx
// states the chunk rule), or the diff chunk joins the entry bundle.

/** The diff pane's root, shared by DiffContent's shell and the lazy fallback:
 *  the size line's and the truncated label's container variants name
 *  `diff-pane`, and a fallback on other geometry would shift at the swap.
 *  ph-no-capture: the pane shows user paths and code session replay must not
 *  see. */
export const DIFF_PANE_ROOT_CLASS =
  "ph-no-capture @container/diff-pane flex h-full flex-col";

/**
 * The diff pane's path row: the file's path, optional `meta` beside it, then
 * the controls cluster holding `children`. DiffContent's shell and the lazy
 * fallback both render it, so the fallback-to-shell swap moves nothing.
 */
export function DiffPathRow({
  filePath,
  meta,
  controlsRef,
  children,
}: {
  filePath: string;
  meta?: ReactNode;
  controlsRef?: Ref<HTMLSpanElement>;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
      <PathText
        path={filePath}
        className="flex-1 font-mono text-xs text-muted-foreground"
      />
      {meta}
      {/* min-h-7 pins the cluster to the language picker's h-7 trigger, so
          the row keeps one height in every arm and in the lazy fallback: an
          extensionless file keeps only the xs (h-6) mode toggle, and the arms
          without controls keep none. tabIndex/outline-none make it a silent
          landing spot for focus when the picker closes with its trigger
          already hidden, or when the toolbar comes back. */}
      <span
        ref={controlsRef}
        tabIndex={-1}
        className="flex min-h-7 shrink-0 items-center gap-1.5 outline-none"
      >
        {children}
      </span>
    </div>
  );
}

/**
 * A lazy DiffSurface/DiffContent while the diff chunk loads: the shell's root
 * and path row over a blank busy body, so the pane's header is already in
 * place. Reports no settle gate, so a slot hosting it stays unsettled.
 */
export function DiffPaneFallback({ filePath }: { filePath: string }) {
  return (
    <div className={DIFF_PANE_ROOT_CLASS}>
      <DiffPathRow filePath={filePath} />
      {/* A sibling of the busy region, never inside it: aria-busy suppresses
          its descendants' live announcements. */}
      <span role="status" className="sr-only">
        Loading the diff…
      </span>
      <div aria-busy className="min-h-0 flex-1" />
    </div>
  );
}
