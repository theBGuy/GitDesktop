import { type ReactNode, useState } from "react";
import {
  type BinarySizeLine,
  binaryIndexOids,
  binarySizeSummary,
  isTypechangeDiff,
  parseModeChange,
} from "@/lib/git/diff-split";
import { FULL_OID_RE } from "@/lib/git/oid";
import { useBinarySizes } from "@/lib/git/queries";
import { useReportPaneSettled } from "./diff-pane-hold";

// The size line's box holds one constant height per width band, and every
// state (loading, blank, each answer) renders centred inside it, so settling
// never moves the placeholder's icon or message. Above 31rem of pane the
// longest form fits one line: below ~93 GiB the exact-bytes pair is at most
// 37 + 1 + 23 = 61 JetBrains Mono xs characters (7.2px each, 439px) plus two
// 6px gaps and the px-4 padding, 483px; max-w-lg keeps that content box wide
// enough. Below it the pair and end forms stack into the box's two lines,
// separator hidden; nothing ever flex-wraps.
const SIZE_BOX_CLASS =
  "flex h-4 w-full items-center justify-center @max-[31rem]/diff-pane:h-8";
const SIZE_PAIR_CLASS =
  "flex items-center gap-x-1.5 @max-[31rem]/diff-pane:flex-col";
const SIZE_SEPARATOR_CLASS = "@max-[31rem]/diff-pane:hidden";
const SUMMARY_CLASS =
  "flex w-full max-w-lg min-w-0 flex-col items-center gap-1 px-4 text-xs tabular-nums";

const BLANK_LINE: BinarySizeLine = { kind: "blank" };

/**
 * The binary placeholder's size change and mode line. Sizes come from the
 * diff's own `index` ids, so a section without one (forge-reconstructed
 * patches), or a PR surface without a full anchor, gets no size box: only its
 * mode line, or nothing. The size box stays blank until the read answers;
 * while `held` it keeps the line this mount last showed.
 */
export function BinaryFileSummary({
  repoPath,
  filePath,
  text,
  worktreeNewSide,
  anchorCommit,
  held = false,
}: {
  repoPath: string;
  filePath: string;
  /** The binary FileDiff's text; oids and the mode line are parsed here. */
  text: string;
  /** True when the diff's new side is the working tree (imageRevs?.new === null). */
  worktreeNewSide: boolean;
  /** PR surfaces only: the surface's commit oid (PR head / the commit). undefined =
   *  local surface (lookups ungated); null or a non-full value = suppress. */
  anchorCommit?: string | null;
  /** The shown patch is a placeholder (another file's or entity's read): its
   *  ids may not belong to this anchor, so no lookup runs, and the box keeps
   *  the line last shown, which sized that same patch. */
  held?: boolean;
}): ReactNode {
  const oids = binaryIndexOids(text, filePath);
  const mode = parseModeChange(text, filePath);
  // A PR surface's ids abbreviate against the forge's store: lookups need a full
  // anchor commit, though a partial or shallow clone can still match another blob.
  const mount =
    oids !== null &&
    (anchorCommit === undefined || FULL_OID_RE.test(anchorCommit ?? ""));
  // Two absent ids size nothing, so they send no lookup either.
  const lookup = mount && !held && (oids.old !== null || oids.new !== null);
  const query = useBinarySizes(
    repoPath,
    lookup
      ? {
          oldOid: oids.old,
          newOid: oids.new,
          worktreeFile: worktreeNewSide && oids.new !== null ? filePath : null,
          anchorCommit: anchorCommit?.toLowerCase() ?? null,
        }
      : null,
  );
  // Before the null return: a slot holds the previous file until sizes land.
  useReportPaneSettled(!lookup || !query.isPending);
  const fresh = lookup
    ? binarySizeSummary(oids, query.data, isTypechangeDiff(text, filePath))
    : BLANK_LINE;
  // The placeholder body IS the patch last shown, so its line still holds;
  // an unheld render records what it shows, blank included.
  const [shown, setShown] = useState<BinarySizeLine>(BLANK_LINE);
  if (!held && lineKey(fresh) !== lineKey(shown)) setShown(fresh);
  if (!mount) {
    return mode === null ? null : (
      <div className={SUMMARY_CLASS}>
        <p>{mode}</p>
      </div>
    );
  }
  const line = held ? shown : fresh;
  return (
    <div className={SUMMARY_CLASS}>
      <div className={SIZE_BOX_CLASS}>{sizeLineBody(line)}</div>
      {line.kind !== "blank" && <span className="sr-only">{line.sr}</span>}
      {mode !== null && <p>{mode}</p>}
    </div>
  );
}

function sizeLineBody(line: BinarySizeLine): ReactNode {
  switch (line.kind) {
    case "blank":
      return null;
    case "same":
    case "size":
      return (
        <p aria-hidden className="text-center">
          {line.text}
        </p>
      );
    case "pair":
      return sizePair(line.sizes, line.delta);
    case "end":
      return sizePair(line.label, line.size);
    default: {
      const _exhaustive: never = line;
      return _exhaustive;
    }
  }
}

function sizePair(lead: string, trail: string): ReactNode {
  return (
    <p aria-hidden className={SIZE_PAIR_CLASS}>
      <span className="whitespace-nowrap">{lead}</span>
      <span className={SIZE_SEPARATOR_CLASS}>·</span>
      <span className="whitespace-nowrap">{trail}</span>
    </p>
  );
}

function lineKey(line: BinarySizeLine): string {
  return line.kind === "blank" ? "" : line.sr;
}
