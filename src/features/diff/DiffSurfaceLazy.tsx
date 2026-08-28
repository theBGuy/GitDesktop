import { type ComponentProps, lazy, Suspense } from "react";

import { LazyPanelFallback } from "@/components/lazy-panel-fallback";

// @git-diff-view (and DiffSurface's render graph — Shiki wiring, the
// multi-select workaround, DiffFile building) is heavy and only needed once a
// diff is actually shown. Loading the real module lazily keeps that whole
// chunk off the boot path: it splits into its own bundle and loads on first
// use (tens of ms from local disk in a Tauri app). Every runtime consumer
// OUTSIDE src/features/diff/ routes through these wrappers so the entry chunk
// no longer eagerly pulls the library in. Files inside src/features/diff/
// (DiffViewer &c.) keep importing ./DiffSurface directly.
//
// Prop types are derived from the real components via a type-only import of
// the module below — types erase at build time, so this does NOT drag the
// eager module back into the graph. NOTE: `typeof <type-only-imported value>`
// is a TYPE QUERY and is valid TypeScript (the standard way to take a
// component's props without a runtime import); only *value*-position use of a
// type-only import is illegal. `tsc -b` compiles this file clean.
import type {
  DiffContent as DiffContentImpl,
  DiffSurface as DiffSurfaceImpl,
  GitDiffView as GitDiffViewImpl,
} from "./DiffSurface";

// Re-export the shared types so consumers keep a single import site — these
// are erased at build time and pull in no runtime code.
export type {
  DiffContentRevs,
  DiffLineAnchor,
  LineWidget,
  SyntaxPrefs,
} from "./DiffSurface";

// The diff panes these render into already show their own placeholders /
// skeletons before data arrives, and the chunk loads in tens of ms — so the
// fallback paints nothing (rows={[]}) while still marking the region busy and
// naming the wait for assistive tech.
const fallback = <LazyPanelFallback name="the diff" rows={[]} />;

const DiffSurfaceLazyImpl = lazy(() =>
  import("./DiffSurface").then((m) => ({ default: m.DiffSurface })),
);

export function DiffSurface(props: ComponentProps<typeof DiffSurfaceImpl>) {
  return (
    <Suspense fallback={fallback}>
      <DiffSurfaceLazyImpl {...props} />
    </Suspense>
  );
}

const DiffContentLazyImpl = lazy(() =>
  import("./DiffSurface").then((m) => ({ default: m.DiffContent })),
);

export function DiffContent(props: ComponentProps<typeof DiffContentImpl>) {
  return (
    <Suspense fallback={fallback}>
      <DiffContentLazyImpl {...props} />
    </Suspense>
  );
}

const GitDiffViewLazyImpl = lazy(() =>
  import("./DiffSurface").then((m) => ({ default: m.GitDiffView })),
);

export function GitDiffView(props: ComponentProps<typeof GitDiffViewImpl>) {
  return (
    <Suspense fallback={fallback}>
      <GitDiffViewLazyImpl {...props} />
    </Suspense>
  );
}
