import { useLayoutEffect } from "react";
import type { DiffLineAnchor } from "@/features/diff/DiffSurface";
import { usePaintedPublish } from "@/features/diff/file-slot";
import { anchorKey } from "@/features/diff/painted-view";
import type { FileDiff } from "@/lib/git/types";

/**
 * A stand-in diff pane's painted report, as DiffContent publishes one to its
 * file slot: a paint of `data` for `filePath` with the `drawn` anchor rows
 * mounted (none while its rows are still building), a pending paint while
 * it has nothing of its own to draw (`pending`, no data, or another file's)
 * or its host names the paint another commit's (`paintsOtherCommit`), and no
 * report once it unmounts. It models one report per pane: a typechange's
 * text-half report is pinned against the real DiffContent instead.
 */
export function useStandInReport(
  filePath: string,
  data: FileDiff | undefined,
  pending: boolean,
  drawn: readonly DiffLineAnchor[],
  paintsOtherCommit = false,
): void {
  const publish = usePaintedPublish();
  const paints = !pending && data !== undefined && data.filePath === filePath;
  const keys = paints
    ? drawn
        .map((a) => anchorKey(a.side, a.line))
        .sort()
        .join(" ")
    : "";
  const items = paints
    ? drawn
        .flatMap((a) => a.items)
        .sort()
        .join(" ")
    : "";
  const patch = data?.text ?? "";
  const hidden = data?.whitespaceHidden === true;
  const truncated = data?.isTruncated === true;
  useLayoutEffect(() => {
    publish({
      path: filePath,
      patch,
      whitespaceHidden: hidden,
      truncated,
      cut: paints && !paintsOtherCommit ? null : "pending",
      anchors: keys === "" ? [] : keys.split(" "),
      drawn: items === "" ? [] : items.split(" "),
    });
  }, [
    publish,
    filePath,
    patch,
    hidden,
    truncated,
    paints,
    keys,
    items,
    paintsOtherCommit,
  ]);
  useLayoutEffect(() => () => publish(null), [publish]);
}
