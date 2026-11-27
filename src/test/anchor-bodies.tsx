import type { ReactNode } from "react";
import type { DiffLineAnchor } from "@/features/diff/DiffSurface";

/** A test anchor that names its body inline. */
export type BodyAnchor = Omit<DiffLineAnchor, "items"> & {
  render: () => ReactNode;
};

const bodyOf = new Map<string, () => ReactNode>();
const idOf = new WeakMap<() => ReactNode, string>();
let next = 0;

/** Placements for test anchors: each one's item names its body function, so
 *  the same functions give value-equal placements and a new one moves them. */
export function bodies(list: readonly BodyAnchor[]): DiffLineAnchor[] {
  return list.map(({ render, ...placement }) => {
    let id = idOf.get(render);
    if (id === undefined) {
      id = `body-${next++}`;
      idOf.set(render, id);
      bodyOf.set(id, render);
    }
    return { ...placement, items: [id] };
  });
}

/** The `renderAnchor` for placements from {@link bodies}. */
export function renderBody(anchor: DiffLineAnchor): ReactNode {
  return bodyOf.get(anchor.items[0] ?? "")?.() ?? null;
}
