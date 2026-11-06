import { ArrowSquareOutIcon, FolderOpenIcon } from "@phosphor-icons/react";
import {
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  openNearestFolder,
  openWithDefault,
  revealInExplorer,
} from "@/lib/git/api";
import {
  type BinaryIndexOids,
  type BinarySizeLine,
  binaryIndexOids,
  binarySizeSummary,
  isTypechangeDiff,
  parseModeChange,
} from "@/lib/git/diff-split";
import { FULL_OID_RE } from "@/lib/git/oid";
import { useBinarySizes, useGithubBlobSizes } from "@/lib/git/queries";
import type { BlobSizes } from "@/lib/git/types";
import { isWindows } from "@/lib/hotkeys/binding";
import { useRepoLens } from "@/lib/repo-lens/queries";
import { toastError } from "@/lib/toast";
import { useReportPaneSettled } from "./diff-pane-hold";
import { useFocusOnControlsSwap } from "./use-hidden-trigger-focus";

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

/** Sides the diff names that a lookup should size; null sends nothing. */
interface SideOids {
  oldOid: string | null;
  newOid: string | null;
}

/**
 * The binary placeholder's size change, mode line and, over a working-tree
 * file, its open actions. Sizes come from the diff's own `index` ids, so a
 * section without one (forge-reconstructed patches), or a PR surface without a
 * full anchor, gets no size box: only its mode line, or nothing. A PR surface
 * asks GitHub for a side its local store couldn't size. The size box stays
 * blank until the read answers; while `held` it keeps the line this mount last
 * showed.
 */
export function BinaryFileSummary({
  repoPath,
  filePath,
  text,
  worktreeNewSide,
  anchorCommit,
  held = false,
  variant = "placeholder",
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
  /** `band`: a typechange's binary half above or below its text half. It never
   *  offers actions: the path on disk may be the other half's kind. */
  variant?: "placeholder" | "band";
}): ReactNode {
  const oids = binaryIndexOids(text, filePath);
  const mode = parseModeChange(text, filePath);
  // A PR surface's ids abbreviate against the forge's store: lookups need a full
  // anchor commit; a shallow or partial clone answers unknown, and on GitHub.com
  // GitHub fills those sides.
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
  // The local read alone: GitHub's may outlast the hold's bound.
  useReportPaneSettled(!lookup || !query.isPending);
  const local = lookup ? query.data : undefined;
  const typechange = isTypechangeDiff(text, filePath);
  // Presence comes from the diff alone, so nothing pops in. A typechange pane
  // never offers them: the path on disk may be the other half's kind.
  const actions =
    !held &&
    variant === "placeholder" &&
    !typechange &&
    worktreeNewSide &&
    oids !== null ? (
      <BinaryFileActions
        repoPath={repoPath}
        filePath={filePath}
        deleted={oids.new === null}
      />
    ) : null;
  const summary = (github?: BlobSizes) => (
    <SizeSummary
      fresh={
        local === undefined || oids === null
          ? BLANK_LINE
          : binarySizeSummary(oids, mergeSizes(local, github), typechange)
      }
      held={held}
      mount={mount}
      mode={mode}
      actions={actions}
    />
  );
  // Only a PR surface mounts the lens and GitHub reads, so a local pane sends
  // neither; no surface flips between the two.
  if (anchorCommit === undefined) return summary();
  return (
    <AnchoredSizeFallback
      repoPath={repoPath}
      missing={
        local === undefined || oids === null ? null : missingSides(oids, local)
      }
    >
      {summary}
    </AnchoredSizeFallback>
  );
}

/** The sides the diff names that the local lookup couldn't size (objects not
 *  fetched, or a shallow or partial clone's null answer); null when none. */
function missingSides(
  oids: BinaryIndexOids,
  local: BlobSizes,
): SideOids | null {
  const oldOid = local.oldSize === null ? oids.old : null;
  const newOid = local.newSize === null ? oids.new : null;
  return oldOid === null && newOid === null ? null : { oldOid, newOid };
}

/** Per side, the local answer wins; GitHub fills only what it left null. */
function mergeSizes(
  local: BlobSizes,
  github: BlobSizes | undefined,
): BlobSizes {
  return {
    oldSize: local.oldSize ?? github?.oldSize ?? null,
    newSize: local.newSize ?? github?.newSize ?? null,
  };
}

/** A PR surface's GitHub lookup for its missing sides, under the lens the PR
 *  surfaces read. A pending, failed or parked read leaves those sides null. */
function AnchoredSizeFallback({
  repoPath,
  missing,
  children,
}: {
  repoPath: string;
  missing: SideOids | null;
  children: (github: BlobSizes | undefined) => ReactNode;
}): ReactNode {
  const lens = useRepoLens(repoPath);
  const github = useGithubBlobSizes(
    repoPath,
    missing === null ? null : { ...missing, lens },
  );
  return children(github.data);
}

function SizeSummary({
  fresh,
  held,
  mount,
  mode,
  actions,
}: {
  fresh: BinarySizeLine;
  held: boolean;
  mount: boolean;
  mode: string | null;
  actions: ReactNode;
}): ReactNode {
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
      {actions}
    </div>
  );
}

/** Opens a working-tree binary, or shows it in the file manager. A deleted
 *  file's path is gone, so only its nearest existing folder opens. A file gone
 *  since the diff read fails into the error toast. */
function BinaryFileActions({
  repoPath,
  filePath,
  deleted,
}: {
  repoPath: string;
  filePath: string;
  deleted: boolean;
}): ReactNode {
  // git spells paths with "/"; reveal and open expect the OS separator.
  const sep = isWindows ? "\\" : "/";
  const absolutePath = `${repoPath}${sep}${filePath.replaceAll("/", sep)}`;
  // Open leaves when a poll reads the file as deleted: only focus it held as it
  // left (read in its wrapper's ref cleanup, which runs before removal) lands on
  // Show in Explorer; focus on <body> or anywhere else never moves.
  const openHeldFocus = useRef(false);
  const captureOpenRef = useCallback(
    (node: HTMLSpanElement | null) => () => {
      if (node !== null && node.contains(document.activeElement))
        openHeldFocus.current = true;
    },
    [],
  );
  const showRef = useRef<HTMLButtonElement>(null);
  const rescueRef = useRef<HTMLElement | null>(null);
  // No dependency array: it consumes the record every commit, after that
  // commit's ref cleanups wrote it and before the swap rescue below runs.
  useLayoutEffect(() => {
    rescueRef.current = openHeldFocus.current ? showRef.current : null;
    openHeldFocus.current = false;
  });
  useFocusOnControlsSwap(deleted, rescueRef);
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
      {!deleted && (
        // `contents` keeps the button a flex item of the row; a plain host span
        // runs the cleanup only when Open leaves, never on Button's ref churn.
        <span ref={captureOpenRef} className="contents">
          <Button
            variant="outline"
            size="sm"
            onClick={() => openWithDefault(absolutePath).catch(toastError)}
          >
            <ArrowSquareOutIcon data-icon="inline-start" />
            Open with default program
          </Button>
        </span>
      )}
      <Button
        ref={showRef}
        variant="outline"
        size="sm"
        onClick={() =>
          (deleted
            ? openNearestFolder(repoPath, filePath)
            : revealInExplorer(absolutePath)
          ).catch(toastError)
        }
      >
        <FolderOpenIcon data-icon="inline-start" />
        Show in Explorer
      </Button>
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
