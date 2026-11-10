import type { FileDiff } from "./types";

// Every FileDiff field, as a record so the compiler rejects a field the
// comparison would otherwise skip (missing key) or one FileDiff dropped (extra).
const FIELDS = {
  filePath: true,
  isBinary: true,
  isTruncated: true,
  text: true,
  undecodable: true,
  oldPath: true,
  whitespaceHidden: true,
  whitespaceOnly: true,
} satisfies Record<keyof FileDiff, true>;

export const FILE_DIFF_FIELDS = Object.keys(FIELDS) as (keyof FileDiff)[];

/** Whether `shown` carries the same diff as `stamped`, field by field: two
 *  observers can each build their own copy of one read, and identical content
 *  renders and anchors identically whichever commit it came from. */
export function sameDiffContent(
  stamped: FileDiff,
  shown: FileDiff | undefined,
): boolean {
  return (
    shown !== undefined &&
    (shown === stamped ||
      FILE_DIFF_FIELDS.every((key) => shown[key] === stamped[key]))
  );
}
