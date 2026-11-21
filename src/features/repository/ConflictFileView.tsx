import { ArrowDownIcon, ArrowUpIcon, SparkleIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { InfoNote } from "@/components/info-note";
import { usePanelActive } from "@/components/panel-portal";
import { PathText } from "@/components/path-text";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useDiffPaneHold } from "@/features/diff/diff-pane-hold";
import { HighlightedCode } from "@/features/diff/HighlightedCode";
import { HIGHLIGHT_MAX_CHARS_HLJS } from "@/features/diff/highlight-budget";
import { useFocusOnControlsSwap } from "@/features/diff/use-hidden-trigger-focus";
import { awaitFocusRelease } from "@/lib/await-focus-release";
import { appErrorDetail, presentError } from "@/lib/error-summary";
import {
  gitStatus,
  isSubmoduleConflictRefusal,
  openWithDefault,
  openWithProgram,
} from "@/lib/git/api";
import {
  type ConflictSides,
  changedOnDiskCopy,
  conflictSides,
  type MarkerScan,
} from "@/lib/git/conflict";
import {
  type ConflictChoice,
  conflictCount,
  deletedSide,
  type FallbackArm,
  fallbackArm,
  hasConflictMarkers,
  MARK_RESOLVED_ARMS,
  markNeedsConfirm,
  noLongerConflicted,
  parseConflictSegments,
  resolveBlock,
  type Segment,
} from "@/lib/git/conflict-parse";
import {
  exceedsPromptSection,
  PROMPT_SECTION_MAX,
} from "@/lib/git/conflict-prefilter";
import {
  refreshConflictFile,
  repoKeys,
  useAcceptSubmoduleConflictSide,
  useCheckoutConflictSide,
  useConflictMarkerScan,
  useHeldConflictFile,
  useMarkConflictResolved,
  useResolveConflict,
  useSubmoduleConflict,
} from "@/lib/git/queries";
import type {
  SubmoduleAcceptCheckout,
  SubmoduleCheckoutLeft,
} from "@/lib/git/types";
import { formatBinding, isWindows } from "@/lib/hotkeys/binding";
import { useEffectiveBindings, useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { ACT_PENDING_REASON } from "@/lib/offline-writes";
import {
  useAiEnabled,
  useReviewConfigured,
  useSettings,
} from "@/lib/settings/queries";
import { useConfirm } from "@/lib/stores/confirm";
import { useConflictResolve } from "@/lib/stores/conflict-resolve";
import { type AppError, isAppError } from "@/lib/tauri/invoke";
import { toastError } from "@/lib/toast";
import {
  ARIA_DISABLED_CLASS,
  heldButtonRender,
  useDisabledReason,
} from "@/lib/use-disabled-reason";
import { useLatestRef } from "@/lib/use-latest-ref";
import {
  conflictCount as conflictCountLabel,
  landingOrdinal,
  PANE_SCROLL_KEYS,
} from "./conflict-banner-state";
import { type MarkerFlag, markerStagePrompt } from "./conflict-confirms";
import {
  nextConflictIndex,
  previousConflictIndex,
  shouldLandOnOpen,
} from "./conflict-jump";
import {
  type ReadRefusal,
  readRefusalOf,
  refusedReadFlag,
} from "./conflict-read-refusal";
import { SubmoduleConflictPane } from "./SubmoduleConflictPane";
import { useRefuseIfMoved } from "./use-refuse-if-moved";

const baseName = (path: string) => path.split("/").pop() || path;

/** Focus inside a dialog that neither holds this pane nor sits inside it. */
function inOtherDialog(active: Element | null, root: HTMLElement | null) {
  const dialog = active?.closest('[role="dialog"], [role="alertdialog"]');
  return (
    dialog != null &&
    root !== null &&
    !dialog.contains(root) &&
    !root.contains(dialog)
  );
}

/** Where focus goes once a write settles: a region header by its conflict
 *  ordinal in the post-write file, or the header's pressed control. Pinned to
 *  the file it was armed for, and to the element that had focus at the press. */
type LandRequest = {
  repoPath: string;
  path: string;
  kind: "region" | "header";
  ordinal?: number;
  pressed: HTMLElement | null;
};

/** A per-region accept's pending count announcement, pinned to the read it was
 *  armed over: `committed` once a newer read rendered, `text` when that read
 *  changed the count to a nonzero one, `settled` once the write succeeded. It
 *  disarms as soon as both happened, so a later poll never announces for it. */
type CountAnnounce = {
  repoPath: string;
  path: string;
  count: number;
  read: unknown;
  committed: boolean;
  settled: boolean;
  text: string | null;
};

/** Focuses a region header and reveals it only when it sits outside the body's
 *  viewport. The app root clips overflow, so a browser-driven reveal could shift
 *  it with no scrollbar to undo that; the scroller moves itself, instantly. */
function landConflictRegion(
  scroller: HTMLElement,
  header: HTMLElement,
  focus: boolean,
): void {
  if (focus) header.focus({ preventScroll: true });
  const headerRect = header.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();
  const top = scrollerRect.top + scroller.clientTop;
  if (headerRect.top < top || headerRect.bottom > top + scroller.clientHeight) {
    scroller.scrollBy({ top: headerRect.top - top, behavior: "instant" });
  }
}

/** The `notConflicted` line, and the reason the header's whole-file actions
 *  hold under it. conflict.rs's NOT_CONFLICTED_REFUSAL is its twin, pinned
 *  equal by scripts/conflict-walk-refusal.test.mjs. */
const NOT_CONFLICTED_COPY = "This file is no longer conflicted.";

/** The jump buttons drop to their arrows below a 240px strip, where the count
 *  and both labels stop fitting one row; the aria-label keeps the full name. */
const JUMP_ICON_ONLY =
  "@max-[240px]/conflict-strip:px-1.5 @max-[240px]/conflict-strip:*:data-[slot=jump-label]:hidden";

/** Why the per-region accepts are off for a non-UTF-8 working file: they
 *  rebuild the file from its lossy decode. Names the byte-safe actions as the
 *  header buttons word them. */
const CONFLICT_UNDECODABLE_NOTE =
  "This file isn't UTF-8 text, so it resolves as a whole to keep its bytes exact. Use Accept all current, Accept all incoming, or Open in editor.";

/** Why Resolve with AI holds over a non-UTF-8 working file: the proposal would
 *  be written back from its lossy decode. */
const AI_UNDECODABLE_REASON =
  "This file isn't UTF-8 text, so AI resolution would change its bytes.";

/** Why Resolve with AI holds over a file past the prompt budget: the model gets
 *  a file whole or not at all (conflict-prefilter's `exceedsPromptSection`). */
const AI_TOO_LARGE_LEAD = `Too large for AI: a version of this file is over ${PROMPT_SECTION_MAX.toLocaleString("en-US")} characters.`;
/** Keyed by whether the view shows regions: an arm without them (a deletion,
 *  unparsed markers) has none to point at. */
const AI_TOO_LARGE_REASON = {
  regions: `${AI_TOO_LARGE_LEAD} Resolve it region by region instead.`,
  whole: AI_TOO_LARGE_LEAD,
} as const;

/** Mark resolved's hold while the file is read: the click-time read, a mount or
 *  show's own read, or the re-read after a failed write. */
const MARK_BUSY_REASON = "Checking the file…";

/** Both Mark resolved buttons' hold reason: a read when one runs, else the
 *  write that holds them. */
const markBusyReason = (reading: boolean) =>
  reading ? MARK_BUSY_REASON : ACT_PENDING_REASON;

/** The whole-file sides, worded as the header buttons word them. */
const ACCEPT_ALL_COPY = {
  ours: { side: "current", other: "incoming" },
  theirs: { side: "incoming", other: "current" },
} as const;

/** What taking a whole side actually does, given which side (if either) has no
 *  version at this path; `unclassified` when no sides read has landed. */
type AcceptAllArm = "content" | "takesDeletion" | "keepsFile" | "unclassified";

/** One body per outcome: a modify/delete conflict doesn't "replace" anything —
 *  the backend runs `git rm` for a removing side and re-checks the file out
 *  whole for a surviving one. */
const ACCEPT_ALL_BODY: Record<
  AcceptAllArm,
  (name: string, side: string, other: string) => string
> = {
  content: (name, side, other) =>
    `Replaces ${name} with the whole ${side} version, including any conflict regions you already resolved by hand. The ${other} changes to this file are discarded.`,
  takesDeletion: (name, side, other) =>
    `The ${side} side removed ${name}, so this deletes the file from your working tree and index. The ${other} side's changes to it are discarded.`,
  keepsFile: (name, side, other) =>
    `Keeps ${name} whole as the ${side} side left it, replacing what's in your working tree now. The ${other} side removed the file, and that removal is discarded.`,
  unclassified: (name, side, other) =>
    `Takes the ${side} side for ${name}: its version, or its removal if that side deleted the file. The ${other} side's changes and any conflict regions you already resolved by hand are discarded.`,
};

/** The notice per removing side. "Removed" rather than "deleted": a side that
 *  renamed the file away also has no version at this path. */
const DELETION_COPY = {
  ours: {
    lead: "The current branch removed this file; the incoming change edited it (below).",
    takesDeletion: "Accept all current",
    keepsFile: "Accept all incoming",
  },
  theirs: {
    lead: "The incoming change removed this file; the current branch edited it (below).",
    takesDeletion: "Accept all incoming",
    keepsFile: "Accept all current",
  },
} as const;

// src-tauri/src/git/conflict.rs's conflict_path_refusal opens path-gate refusals with this.
// scripts/conflict-path-refusal.test.mjs pins both sides.
const PATH_REFUSAL_PREFIX = "Can't resolve the conflict in";

// conflict.rs's CONFLICT_LINKED_LEAF: a symbolic link AT the path, which git's
// side checkout replaces or removes itself. Matched with its dash, period and
// closing sentence, so the linked-ancestor reason can never read as this one.
const LINKED_LEAF_REASON = "it's a symbolic link";
const LINKED_LEAF_TAIL = ` — ${LINKED_LEAF_REASON}. Nothing was changed.`;

/** `io` covers a lock, a permission change, or a directory at the path, none
 *  promised to pass. The two read refusals, the submodule refusal and the
 *  path-gate refusals render their own copy; every other error takes the
 *  fallback. */
const READ_ERROR_COPY: Partial<Record<AppError["kind"], ReactNode>> = {
  io: "Couldn't read this file. It may be locked, its permissions may have changed, or a folder may sit at this path. Open it in your editor to resolve the conflict, or try again if it becomes readable.",
};
const READ_ERROR_FALLBACK =
  "Couldn't read this file, so it can't be shown here. Resolve the conflict in your editor.";

const READ_REFUSAL_LEAD: Record<ReadRefusal, string> = {
  tooLarge:
    "This file is too large to show here, so its conflict can't be resolved region by region.",
  binary:
    "This looks like a binary file, so its conflict can't be merged as text.",
};

const READ_REFUSAL_TAIL = (
  <>
    {" "}
    Take a side with <span className="font-medium">Accept all current</span> /{" "}
    <span className="font-medium">incoming</span>, or resolve it outside
    GitDesktop and then <span className="font-medium">Mark resolved</span> to
    stage it exactly as it is on disk.
  </>
);

/** What the too-large strip's marker scan answered so far. */
type ScanTail = "pending" | "markers" | "clean" | "binary" | "failed";

/** The strip's closing sentence per refusal and scan answer: it says the stage
 *  will ask exactly when Mark resolved's own check would. */
const BINARY_TAIL = " You'll be asked to confirm first.";
const SCAN_TAIL_COPY: Record<ScanTail, string | null> = {
  pending: null,
  markers: " It still has conflict markers, so you'll be asked first.",
  clean: null,
  binary: BINARY_TAIL,
  failed:
    " You'll be asked first, because GitDesktop couldn't check this file for conflict markers.",
};

function scanTailOf(scan: {
  isError: boolean;
  data: MarkerScan | undefined;
}): ScanTail {
  switch (true) {
    case scan.isError:
      return "failed";
    case scan.data === undefined:
      return "pending";
    case !scan.data?.exists:
      return "clean";
    case scan.data?.binary:
      return "binary";
    case scan.data?.markers:
      return "markers";
    default:
      return "clean";
  }
}

/** FNV-1a over UTF-16 code units: a cheap content key, not a digest. */
function textHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** React keys for the region list, by each segment's own content plus its
 *  occurrence among equal segments, never its index: an accept merges one
 *  region into its context, and index keys would re-mount (and re-highlight)
 *  every segment after it. */
function segmentKeys(segments: Segment[]): string[] {
  const seen = new Map<string, number>();
  return segments.map((seg) => {
    const base =
      seg.kind === "context"
        ? `ctx-${textHash(seg.text)}`
        : `conflict-${textHash(seg.raw)}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}-${n}`;
  });
}

/** The whole-file writes' answer when git no longer lists the path as
 *  conflicted at the click. */
const notConflictedCopy = (name: string) =>
  `${name} is no longer conflicted — nothing was changed.`;

/** What a submodule side's accept did to the submodule's own checkout, after
 *  the lead naming the side taken; the footer said the same up front. */
const SUBMODULE_ACCEPT_TAIL: Record<
  Exclude<SubmoduleAcceptCheckout["kind"], "left"> | SubmoduleCheckoutLeft,
  (name: string, reason: string | null) => string
> = {
  checkedOut: (name) => ` and checked it out in ${name}.`,
  alreadyThere: (name) => `. ${name} was already on that commit.`,
  dirty: (name) => `. ${name} has local changes, so its checkout stays as is.`,
  notInitialized: (name) =>
    `. ${name} isn't checked out here, so there was no checkout to move.`,
  unusable: (name) =>
    `. ${name}'s folder couldn't be read as a submodule, so its checkout stays as is.`,
  detachedElsewhere: (name) =>
    `. ${name} is on a commit of its own, so its checkout stays as is.`,
  notFetched: (name) =>
    `. That commit isn't fetched in ${name} yet, so its checkout stays as is.`,
  failed: (name, reason) =>
    `. Couldn't check it out in ${name}, so its checkout stays as is${reason ? `: ${reason}` : "."}`,
};

const submoduleAcceptedCopy = (
  name: string,
  side: "ours" | "theirs",
  checkout: SubmoduleAcceptCheckout,
) => {
  const tail =
    checkout.kind === "left"
      ? SUBMODULE_ACCEPT_TAIL[checkout.why](name, checkout.reason)
      : SUBMODULE_ACCEPT_TAIL[checkout.kind](name, null);
  return `Resolved ${name} — took ${ACCEPT_ALL_COPY[side].side}${tail}`;
};

const submoduleChangedCopy = (name: string) =>
  `The submodule conflict in ${name}, or its checkout, changed after it was read — nothing was staged.`;

const REREAD_FAILED_TOAST =
  "Couldn't re-read the file — nothing was marked resolved.";

/** Whether git status still lists `path` as unmerged on either side. */
function listsConflicted(
  status: Awaited<ReturnType<typeof gitStatus>>,
  path: string,
): boolean {
  return status.entries.some(
    (entry) =>
      entry.path === path &&
      (entry.staged === "conflicted" || entry.unstaged === "conflicted"),
  );
}

/** The two working-file states with no text to show, each worded for what
 *  staging it actually records (content vs. a removal). */
const EMPTIED_COPY: Record<
  "emptiedOnDisk" | "emptiedGone",
  { state: string; action: string }
> = {
  emptiedOnDisk: {
    state: "You've emptied this file",
    action: "stages it exactly as it is on disk.",
  },
  emptiedGone: {
    state: "This file is gone from your working tree",
    action: "stages the removal.",
  },
};

/**
 * What a conflicted file shows when the parser found no regions to resolve: a
 * side with no version at this path, an empty file, content already resolved
 * outside the app, or markers it can't trust. Each keeps the header's
 * whole-file actions as the way through; the arms in `MARK_RESOLVED_ARMS` also
 * offer Mark resolved, which confirms first while markers remain. A path that
 * is no longer conflicted gets a plain line until the host drops this pane.
 */
function ConflictFallback({
  path,
  sides,
  arm,
  busy,
  busyReason,
  onMarkResolved,
  plain,
}: {
  path: string;
  sides: ConflictSides;
  arm: FallbackArm;
  busy: boolean;
  busyReason: string;
  onMarkResolved: () => void;
  /** Past the highlight budget: every code block renders as plain text. */
  plain: boolean;
}) {
  const markButton = MARK_RESOLVED_ARMS.has(arm) ? (
    <DisabledReasonButton
      size="xs"
      variant="outline"
      disabled={busy}
      reason={busyReason}
      onClick={onMarkResolved}
    >
      Mark resolved
    </DisabledReasonButton>
  ) : null;
  const markersRemain = markNeedsConfirm(sides);

  if (arm === "notConflicted") {
    return (
      <p className="p-4 text-xs text-muted-foreground">{NOT_CONFLICTED_COPY}</p>
    );
  }

  if (arm === "deletion" || arm === "deletionEdited") {
    // The arm doesn't carry WHICH side removed the file, and the notice names
    // it. Both deletion arms come from a non-null `deletedSide` (asserted).
    const copy = DELETION_COPY[deletedSide(sides) as "ours" | "theirs"];
    const lead = (
      <>
        {copy.lead} <span className="font-medium">{copy.takesDeletion}</span>{" "}
        takes the deletion,{" "}
        <span className="font-medium">{copy.keepsFile}</span> keeps the file.
      </>
    );
    return (
      <>
        {arm === "deletionEdited" ? (
          <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
            <p className="min-w-0 flex-1">
              {lead} You've edited this file —{" "}
              <span className="font-medium">Mark resolved</span> keeps it
              exactly as shown.
              {markersRemain &&
                " It still has conflict markers, so you'll be asked before they're staged."}
            </p>
            {markButton}
          </div>
        ) : (
          <p className="border-b bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
            {lead}
          </p>
        )}
        <HighlightedCode
          path={path}
          content={sides.working || " "}
          plain={plain}
        />
      </>
    );
  }

  if (arm === "emptiedOnDisk" || arm === "emptiedGone") {
    return (
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
        <p className="min-w-0 flex-1">
          {EMPTIED_COPY[arm].state} —{" "}
          <span className="font-medium">Mark resolved</span>{" "}
          {EMPTIED_COPY[arm].action}
        </p>
        {markButton}
      </div>
    );
  }

  if (arm === "bothDeleted") {
    // Nothing to merge as text, and nothing on disk worth staging as-is.
    return (
      <p className="p-4 text-xs text-muted-foreground">
        This file was deleted on both sides — there's nothing to merge. Take a
        side with <span className="font-medium">Accept all current</span> /{" "}
        <span className="font-medium">incoming</span>, or open it in your
        editor.
      </p>
    );
  }

  if (arm === "externallyResolved") {
    return (
      <>
        <div className="flex items-center gap-2 border-b bg-success/10 px-3 py-1.5 text-[11px] text-success">
          <p className="min-w-0 flex-1">
            No conflict markers remain — this file looks resolved. Review it,
            then <span className="font-medium">Mark resolved</span> to stage it
            exactly as it is on disk.
          </p>
          {markButton}
        </div>
        <HighlightedCode path={path} content={sides.working} plain={plain} />
      </>
    );
  }

  // Couldn't parse the markers cleanly (malformed or ambiguous, e.g. a bare
  // 7-char marker inside the content) — show the raw file so nothing is hidden.
  // The markerless form is an entry with only its base stage but real content.
  return (
    <>
      <div className="flex items-center gap-2 border-b bg-warning/10 px-3 py-1.5 text-[11px] text-warning">
        <p className="min-w-0 flex-1">
          {markersRemain ? (
            <>
              Couldn't cleanly parse the conflict markers in this file. Take a
              side with the header actions, or fix it in your editor and then{" "}
              <span className="font-medium">Mark resolved</span>. While markers
              remain, you'll be asked before they're staged.
            </>
          ) : (
            <>
              Couldn't tell how this conflict should resolve. Review the file,
              then <span className="font-medium">Mark resolved</span> to stage
              it exactly as it is on disk, or take a side with the header
              actions.
            </>
          )}
        </p>
        {markButton}
      </div>
      <HighlightedCode path={path} content={sides.working} plain={plain} />
    </>
  );
}

/**
 * The conflicted-file editor: renders the file with git's conflict markers
 * resolved into reviewable regions. Each region shows Current (ours) over
 * Incoming (theirs) with per-region Accept current / incoming / both; the header
 * offers whole-file Accept all current / all incoming, Open in editor, and
 * (when configured) Resolve with AI. Replaces the diff pane for a conflicted
 * file when no AI session is active. Works with AI off — only the AI button is
 * gated.
 */
export function ConflictFileView({
  repoPath,
  path,
  focusSink,
}: {
  repoPath: string;
  path: string;
  /** The host's landing outside this pane, which outlives it: the host drops
   *  the pane once the file stops being conflicted. */
  focusSink?: RefObject<HTMLElement | null>;
}) {
  // Every read of the file's pending / error state goes through the held read:
  // a failing file re-reads every tick and must not flash its spinner.
  const file = useHeldConflictFile(repoPath, path);
  const resolve = useResolveConflict(repoPath);
  const checkoutSide = useCheckoutConflictSide(repoPath);
  const markResolve = useMarkConflictResolved(repoPath);
  const acceptSubmodule = useAcceptSubmoduleConflictSide(repoPath);
  // Whether the view moved to another repo, or went away, while a prompt was
  // open or Mark resolved's re-read ran. A prompt never reaches the closed arm
  // (the confirm store cancels a repo-scoped prompt on a close); the re-read can.
  const refuseIfMoved = useRefuseIfMoved(repoPath);
  // Cleared on unmount and on an <Activity> hide: Accept all's not-conflicted
  // answer can land after the status poll dropped this view.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const aiEnabled = useAiEnabled();
  const reviewConfigured = useReviewConfigured();
  const startResolveAi = useConflictResolve((s) => s.startOne);
  const settings = useSettings();
  const queryClient = useQueryClient();
  const [recovering, setRecovering] = useState(false);
  const [checking, setChecking] = useState(false);
  // Set synchronously by every write handler and cleared only after its write
  // and re-read: a second click inside the render that disables the buttons
  // would otherwise resolve against the segments the first write replaced.
  const inFlightRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const focusSinkRef = useRef<HTMLSpanElement>(null);
  // Armed by a write handler once its write settles; the landing effect below
  // consumes it when the hold drops and the target can take focus.
  const [landRequest, setLandRequest] = useState<LandRequest | null>(null);
  // Set at a write's press, cleared when its landing runs or when the user
  // takes the pane over first (a click, wheel, touch or scroll key in it), so
  // focus that input left on <body> never reads as the write's to move.
  const landPendingRef = useRef(false);
  const takeOverLanding = () => {
    landPendingRef.current = false;
  };
  // The cancel of a landing waiting for focus to leave another dialog; held
  // across the landing effect's own re-run, called by a press or unmount.
  const landWaitRef = useRef<() => void>(() => undefined);
  useLayoutEffect(() => () => landWaitRef.current(), []);
  // The file the on-open landing ran for, or that input forfeited it for. A
  // ref, so an <Activity> re-show (which replays effects) or a poll re-read
  // never lands again; a new path re-arms it and a remount resets it.
  const openLandedRef = useRef<{ repoPath: string; path: string } | null>(null);
  // Armed by a per-region accept before its write; announces the count its
  // re-read lands once that write succeeded, whichever of the two comes first.
  const announceRef = useRef<CountAnnounce | null>(null);
  const [announcement, setAnnouncement] = useState<{
    repoPath: string;
    path: string;
    text: string;
  } | null>(null);
  const labelIdBase = useId();

  // Arms the press marker and returns the control focused at the press,
  // captured before any await: Chromium blurs it to <body> once the hold
  // disables it.
  function capturePress(): HTMLElement | null {
    landWaitRef.current();
    landPendingRef.current = true;
    const active = document.activeElement;
    return active instanceof HTMLElement && rootRef.current?.contains(active)
      ? active
      : null;
  }

  function armLanding(
    kind: LandRequest["kind"],
    pressed: HTMLElement | null,
    ordinal?: number,
  ) {
    setLandRequest({ repoPath, path, kind, ordinal, pressed });
  }

  // Focus inside a pane the host drops falls to <body>, as does focus a write's
  // hold blurred there when the pane drops before its landing; the host's sink
  // outlives the pane. Runs before React detaches this subtree.
  useLayoutEffect(() => {
    const root = rootRef.current;
    return () => {
      const active = document.activeElement;
      const stranded =
        landPendingRef.current && (active === null || active === document.body);
      if (stranded || root?.contains(active))
        focusSink?.current?.focus({ preventScroll: true });
    };
  }, [focusSink]);

  // The file this view last saw a read land for since it mounted or its panel
  // last showed. Cleared on every hide and unmount, so a cached entry, as old
  // as the time off-screen, never reaches live buttons. Joins a read already
  // in flight (the mount's own) rather than spawning a second one.
  const panelActive = usePanelActive();
  const refetchFile = file.refetch;
  const [freshFor, setFreshFor] = useState<{
    repoPath: string;
    path: string;
  } | null>(null);
  useEffect(() => {
    if (!panelActive) return;
    let current = true;
    void refetchFile({ cancelRefetch: false }).then(() => {
      if (current) setFreshFor({ repoPath, path });
    });
    return () => {
      current = false;
      setFreshFor(null);
    };
  }, [panelActive, refetchFile, repoPath, path]);
  const awaitingRead =
    freshFor?.repoPath !== repoPath || freshFor.path !== path;

  // A gitlink conflict: the file read refuses it, and the submodule pane reads
  // both commits instead, under the same fresh-on-show hold as the file's.
  const submoduleArm = file.isError && isSubmoduleConflictRefusal(file.error);
  const submodule = useSubmoduleConflict(repoPath, path, submoduleArm);
  const refetchSubmodule = submodule.refetch;
  const [submoduleFreshFor, setSubmoduleFreshFor] = useState<{
    repoPath: string;
    path: string;
  } | null>(null);
  useEffect(() => {
    if (!panelActive || !submoduleArm) return;
    let current = true;
    void refetchSubmodule({ cancelRefetch: false }).then(() => {
      if (current) setSubmoduleFreshFor({ repoPath, path });
    });
    return () => {
      current = false;
      setSubmoduleFreshFor(null);
    };
  }, [panelActive, submoduleArm, refetchSubmodule, repoPath, path]);
  const awaitingSubmoduleRead =
    submoduleFreshFor?.repoPath !== repoPath || submoduleFreshFor.path !== path;
  // An outside resolve of the gitlink shows only here: the refused file read
  // no longer polls.
  const submoduleData = submodule.isError ? undefined : submodule.data;
  const submoduleResolved =
    submoduleArm &&
    submoduleData !== undefined &&
    submoduleData.base === null &&
    submoduleData.ours === null &&
    submoduleData.theirs === null;
  // The pane draws its sides, and their Accepts: what SubmoduleConflictPane
  // renders past its pending and error arms, short of a resolved read.
  const submoduleSides =
    submoduleArm && submoduleData !== undefined && !submoduleResolved;

  // A read with no index stages renders the no-longer-conflicted line whatever
  // the text holds, so no region offers an Accept on a path git calls merged.
  const segments = useMemo(
    () =>
      file.data && !noLongerConflicted(file.data)
        ? parseConflictSegments(file.data.working)
        : null,
    [file.data],
  );
  // The region map's own render condition. The parse returns null without a
  // region, so the region view always counts at least one.
  const regionView = !file.isError && segments !== null;
  const total = regionView && segments ? conflictCount(segments) : 0;
  // Plain past the diff viewer's whole-buffer hljs budget: the region view
  // shows files up to the display cap.
  const plainCode = (file.data?.working.length ?? 0) > HIGHLIGHT_MAX_CHARS_HLJS;

  // Each mutation re-reads the conflict file before its isPending drops, a
  // failed one re-reads under `recovering`, Mark resolved's click-time read
  // holds under `checking`, and a mount or show waits for its own read
  // (`awaitingRead`), so the buttons stay disabled until fresh segments land:
  // a click on stale segments would resurrect a resolved region. Fetch state
  // stays out of it, so poll ticks neither flicker the buttons nor re-render
  // the view.
  const busy =
    resolve.isPending ||
    checkoutSide.isPending ||
    markResolve.isPending ||
    acceptSubmodule.isPending ||
    checking ||
    recovering ||
    awaitingRead;
  const busyReason = markBusyReason(checking || recovering || awaitingRead);
  const submoduleBusy = busy || awaitingSubmoduleRead;
  const submoduleReading =
    checking || recovering || awaitingRead || awaitingSubmoduleRead;
  // A conflict the backend wouldn't read (binary, too large, or unreadable)
  // can't be text-merged: it offers whole-file resolution + the editor (binary
  // and too large also Mark resolved), and a path-gate refusal leaves only the
  // editor (a leaf link also keeps Accept all).
  const textResolvable = !file.isError;
  const pathRefusal: string | null = (() => {
    if (
      !file.isError ||
      !isAppError(file.error) ||
      file.error.kind !== "invalidArgument"
    ) {
      return null;
    }
    const summary = presentError(file.error).summary;
    return summary.startsWith(PATH_REFUSAL_PREFIX) ? summary : null;
  })();
  const linkedLeaf = pathRefusal?.endsWith(LINKED_LEAF_TAIL) === true;
  // The whole-file accepts' hold: every path refusal but a leaf link.
  const sideRefusal = linkedLeaf ? null : pathRefusal;
  const readErrorBody = (() => {
    switch (true) {
      case linkedLeaf:
        return `${pathRefusal} Accept all current or incoming can still resolve it: git replaces or removes the link itself, not what it points to.`;
      case pathRefusal !== null:
        return `${pathRefusal} Resolve it in your editor or a terminal.`;
      default:
        return (
          (isAppError(file.error) && READ_ERROR_COPY[file.error.kind]) ||
          READ_ERROR_FALLBACK
        );
    }
  })();
  // A file refused as too large or binary can still be staged as it is on disk.
  // Such a read never re-polls, so Mark resolved re-checks status at the click.
  const readRefusal =
    file.isError && pathRefusal === null ? readRefusalOf(file.error) : null;
  // Advisory only: Mark resolved scans again at the click.
  const markerScan = useConflictMarkerScan(
    repoPath,
    path,
    readRefusal === "tooLarge",
  );
  const refusalTail =
    readRefusal === "binary"
      ? BINARY_TAIL
      : SCAN_TAIL_COPY[scanTailOf(markerScan)];
  // Held focusable, so the click-time read never blurs the pressed button. The
  // strip carries the hover reason: the button stays the strip's direct child.
  const markHeld = useDisabledReason({
    disabled: busy,
    reason: busyReason,
  });
  const readErrorView = (() => {
    switch (true) {
      case submoduleResolved:
        return (
          <p className="p-4 text-xs text-muted-foreground">
            {NOT_CONFLICTED_COPY}
          </p>
        );
      case submoduleArm:
        return (
          <SubmoduleConflictPane
            name={baseName(path)}
            read={submodule}
            busy={submoduleBusy}
            reading={submoduleReading}
            onAccept={acceptSubmoduleSide}
          />
        );
      case readRefusal === null:
        return (
          <p className="p-4 text-xs text-muted-foreground">{readErrorBody}</p>
        );
    }
    return (
      <div
        className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground"
        title={markHeld.wrapperTitle}
      >
        <p className="min-w-0 flex-1">
          {READ_REFUSAL_LEAD[readRefusal]}
          {READ_REFUSAL_TAIL}
          {refusalTail}
        </p>
        <Button
          size="xs"
          variant="outline"
          disabled={busy}
          focusableWhenDisabled={!!markHeld.blockedReason}
          aria-describedby={markHeld.describedBy}
          className={ARIA_DISABLED_CLASS}
          render={heldButtonRender(!!markHeld.blockedReason)}
          onClick={markResolved}
        >
          Mark resolved
        </Button>
        {markHeld.blockedReason ? (
          <span id={markHeld.reasonId} className="sr-only">
            {markHeld.blockedReason}
          </span>
        ) : null}
      </div>
    );
  })();
  // The working file alone: per-region accepts rebuild from it, so a clean
  // working file over a non-UTF-8 stage blob stays lossless for them. The AI
  // button holds on it too, but deliberately leaves that blob-only case to
  // ConflictResolveView's `undecodable` block, which keeps the AI flow safe there.
  const workingUndecodable = file.data?.workingUndecodable === true;
  // Offered exactly as for a UTF-8 file; a non-UTF-8 one disables it with a
  // reason instead of hiding it.
  const offersAi = aiEnabled && reviewConfigured && textResolvable;
  // The fire-time belt reads this: a committed Accept's closure predates a flip.
  const workingUndecodableRef = useLatestRef(workingUndecodable);

  const sep = isWindows ? "\\" : "/";
  const absPath = `${repoPath}${sep}${path.replaceAll("/", sep)}`;
  const editorPath = (settings.data?.externalEditor ?? "").trim();

  function openInEditor() {
    const open = editorPath
      ? openWithProgram(editorPath, absPath)
      : openWithDefault(absPath);
    open.catch(toastError);
  }

  // A failed write invalidates nothing (the mutations refresh only on success),
  // and a partial failure (content written, stage failed) must not leave the
  // buttons enabled over stale segments. Keys follow the prop: a PR's resolve
  // worktree hosts this view as well as the open repo.
  async function refreshAfterError() {
    setRecovering(true);
    try {
      await refreshConflictFile(queryClient, repoPath);
    } finally {
      setRecovering(false);
    }
  }

  async function acceptRegion(index: number, choice: ConflictChoice) {
    if (inFlightRef.current || !segments || !file.data) return;
    if (workingUndecodableRef.current) {
      toast.info(CONFLICT_UNDECODABLE_NOTE);
      return;
    }
    const pressed = capturePress();
    const content = resolveBlock(segments, index, choice);
    // Stage once the last marker is gone — same end state as the AI flow.
    const stage = !hasConflictMarkers(content);
    // From the same `file.data` the segments were parsed from.
    const expectedHash = file.data.workingHash;
    const announce: CountAnnounce = {
      repoPath,
      path,
      count: total,
      read: file.data,
      committed: false,
      settled: false,
      text: null,
    };
    announceRef.current = announce;
    // A refused or failed write disarms its announcement in its own arm, so no
    // later poll can announce for it.
    const disarm = () => {
      if (announceRef.current === announce) announceRef.current = null;
    };
    inFlightRef.current = true;
    try {
      const outcome = await resolve.mutateAsync({
        path,
        content,
        stage,
        expectedHash,
      });
      // Detaches the settled write from the observer, so its whole-file
      // variables leave the mutation cache now (its gcTime is 0).
      resolve.reset();
      // Lands on the region that took this one's place (or the new last one);
      // the effect counts regions in the post-write file.
      armLanding("region", pressed, index);
      // A success to the mutation, so its awaited re-read already re-keyed the
      // regions to disk; no error-path refresh.
      if (outcome.kind === "changedOnDisk") {
        disarm();
        toast.info(changedOnDiskCopy(baseName(path)));
        return;
      }
      settleAnnounce(announce);
      if (stage) toast.success(`Resolved ${baseName(path)}`);
    } catch (e) {
      disarm();
      toastError(e);
      resolve.reset();
      await refreshAfterError();
      armLanding("region", pressed, index);
    } finally {
      inFlightRef.current = false;
    }
  }

  function settleAnnounce(armed: CountAnnounce) {
    if (announceRef.current !== armed) return;
    if (!armed.committed) {
      armed.settled = true;
      return;
    }
    announceRef.current = null;
    if (armed.text === null) return;
    setAnnouncement({
      repoPath: armed.repoPath,
      path: armed.path,
      text: armed.text,
    });
  }

  async function acceptAll(side: "ours" | "theirs") {
    // Nothing records which regions were resolved by hand, so every arm warns
    // unconditionally: taking a side re-checks the file out from the index and
    // any manual work in it goes with the other side. Classifies from the last
    // successful read; when none has landed (the first read failed) a deleting
    // side can't be ruled out, so the unclassified arm names both outcomes.
    if (inFlightRef.current) return;
    const pressed = capturePress();
    inFlightRef.current = true;
    try {
      const copy = ACCEPT_ALL_COPY[side];
      const name = baseName(path);
      const deleted = file.data ? deletedSide(file.data) : null;
      const arm: AcceptAllArm = (() => {
        switch (true) {
          case !file.data:
            return "unclassified";
          case deleted === null:
            return "content";
          case deleted === side:
            return "takesDeletion";
          default:
            return "keepsFile";
        }
      })();
      const acceptIn = repoPath;
      const ok = await useConfirm.getState().ask({
        title: `Accept all ${copy.side} in ${name}?`,
        body: ACCEPT_ALL_BODY[arm](name, copy.side, copy.other),
        confirmLabel: `Accept all ${copy.side}`,
        confirmVariant: "destructive",
      });
      if (!ok) return;
      // Advisory, and read before the moved check: an outside `git add` while
      // the confirm is open makes the status poll drop this view, which that
      // check would report as the user leaving. The backend's stage check under
      // the repo lock is authoritative, so a read that fails (a binary,
      // oversized or linked file always does) leaves the verdict to it.
      let fresh: ConflictSides | null;
      setChecking(true);
      try {
        fresh = await conflictSides(repoPath, path, []).catch(() => null);
      } finally {
        setChecking(false);
      }
      const notConflictedToast = notConflictedCopy(name);
      if (fresh !== null && noLongerConflicted(fresh)) {
        toast.info(notConflictedToast);
        if (!mountedRef.current) return;
        await refreshAfterError();
        armLanding("header", pressed);
        return;
      }
      if (refuseIfMoved(acceptIn, "nothing was resolved")) return;
      try {
        await checkoutSide.mutateAsync({ path, side });
        toast.success(
          `Resolved ${baseName(path)} — took ${side === "ours" ? "current" : "incoming"}`,
        );
        armLanding("header", pressed);
      } catch (e) {
        // The backend's stage guard refuses a path git already calls merged.
        if (
          isAppError(e) &&
          e.kind === "invalidArgument" &&
          appErrorDetail(e.kind, e.message) === NOT_CONFLICTED_COPY
        ) {
          toast.info(notConflictedToast);
        } else {
          toastError(e);
        }
        await refreshAfterError();
        armLanding("header", pressed);
      }
    } finally {
      inFlightRef.current = false;
    }
  }

  // Stages the side's commit the pane shows, compared against the read's stage
  // shas and its checkout promise for that side, so nothing moves on a stale
  // read: the backend answers `changed` and the awaited re-read repaints.
  async function acceptSubmoduleSide(side: "ours" | "theirs") {
    if (inFlightRef.current || !submoduleData) return;
    const pressed = capturePress();
    const name = baseName(path);
    const expected = {
      base: submoduleData.base,
      ours: submoduleData.ours?.sha ?? null,
      theirs: submoduleData.theirs?.sha ?? null,
    };
    const expectCheckout = submoduleData[side]?.plan === "checkOut";
    inFlightRef.current = true;
    try {
      const outcome = await acceptSubmodule.mutateAsync({
        path,
        side,
        expected,
        expectCheckout,
      });
      if (outcome.kind === "changed") {
        toast.info(submoduleChangedCopy(name));
        armLanding("header", pressed);
        return;
      }
      toast.success(submoduleAcceptedCopy(name, side, outcome.checkout));
      armLanding("header", pressed);
    } catch (e) {
      // The backend's stage check refuses a path git already calls merged.
      if (
        isAppError(e) &&
        e.kind === "invalidArgument" &&
        appErrorDetail(e.kind, e.message) === NOT_CONFLICTED_COPY
      ) {
        toast.info(notConflictedCopy(name));
      } else {
        toastError(e);
      }
      await refreshAfterError();
      armLanding("header", pressed);
    } finally {
      inFlightRef.current = false;
    }
  }

  // Which fallback state is on screen, and so whether Mark resolved is offered.
  // Gated on !isError as well as data: a refetch that errors (the file became
  // unreadable, binary, oversized, or refused by the path gate) keeps the last
  // data while the pane shows the error copy. A submodule read with no stages
  // left is the same verdict for a gitlink.
  const fileArm =
    file.data && !file.isError && segments === null
      ? fallbackArm(file.data)
      : null;
  const arm: FallbackArm | null = submoduleResolved ? "notConflicted" : fileArm;
  const canMarkResolved =
    (arm !== null && MARK_RESOLVED_ARMS.has(arm)) || readRefusal !== null;

  // A staging write's re-read lands before git status is even requested, and an
  // outside `git add` can beat the status poll: refresh status once, so the host
  // drops this pane. Restarts a status read already in flight, since one begun
  // before an outside `git add` still lists the path as unmerged.
  const notConflicted = arm === "notConflicted";
  useEffect(() => {
    if (!notConflicted) return;
    void queryClient.invalidateQueries({ queryKey: repoKeys.status(repoPath) });
  }, [notConflicted, queryClient, repoPath]);

  // The same budget the walk's gate reads, so the button never offers a run
  // that the walk would block.
  const aiTooLarge = file.data !== undefined && exceedsPromptSection(file.data);
  const aiHeldReason = (() => {
    switch (true) {
      case notConflicted:
        return NOT_CONFLICTED_COPY;
      case workingUndecodable:
        return AI_UNDECODABLE_REASON;
      case aiTooLarge:
        return AI_TOO_LARGE_REASON[regionView ? "regions" : "whole"];
      default:
        return null;
    }
  })();

  // Mark resolved's answer to a failed click-time read: the toast it stops
  // with, or null for a too-large or binary refusal of a path git still lists
  // as conflicted, which takes the refused-read flag. That refused read never
  // re-polls, so the pane can be arbitrarily stale; status decides instead.
  async function rereadFailureStop(error: unknown): Promise<string | null> {
    if (readRefusalOf(error) === null) return REREAD_FAILED_TOAST;
    const status = await gitStatus(repoPath).catch(() => null);
    if (status === null) return REREAD_FAILED_TOAST;
    return listsConflicted(status, path)
      ? null
      : notConflictedCopy(baseName(path));
  }

  // The button and the palette action both land here, so this is the one gate:
  // staging is a plain `git add`, which would take any remaining markers along.
  // It asks the generic stage routes' question, from their shared builder. The
  // question is decided by a read taken at the click, called straight: the
  // view's last read (or a poll joined via fetchQuery) can predate the save.
  async function markResolved() {
    if (inFlightRef.current) return;
    const pressed = capturePress();
    inFlightRef.current = true;
    try {
      const markIn = repoPath;
      // What the confirm asks about, or null to stage without one. A read
      // refused for a file git still lists as conflicted takes the shared
      // refused-read flag: a too-large file asks only when its scan finds
      // markers or fails, a binary one always asks.
      let flag: MarkerFlag | null;
      setChecking(true);
      try {
        const fresh = await conflictSides(repoPath, path, []);
        flag = markNeedsConfirm(fresh)
          ? { name: baseName(path), unchecked: false }
          : null;
      } catch (err) {
        const stop = await rereadFailureStop(err);
        if (stop !== null) {
          toast.info(stop);
          await refreshAfterError();
          armLanding("header", pressed);
          return;
        }
        flag = await refusedReadFlag(repoPath, path, baseName(path), err);
      } finally {
        setChecking(false);
      }
      if (
        refuseIfMoved(
          markIn,
          "nothing was marked resolved",
          "before the check finished",
        )
      )
        return;
      if (flag !== null) {
        const ok = await useConfirm
          .getState()
          .ask(markerStagePrompt([flag], false));
        // A cancel lands on the press like every other exit. The landing waits
        // out the confirm's close.
        if (!ok) {
          armLanding("header", pressed);
          return;
        }
        if (refuseIfMoved(markIn, "nothing was marked resolved")) return;
      }
      try {
        await markResolve.mutateAsync(path);
        toast.success(`Resolved ${baseName(path)}`);
        armLanding("header", pressed);
      } catch (e) {
        // A stale click: the path can be resolved elsewhere (an AI walk, another
        // window) between render and click, leaving NO index entry, and `git
        // add` then exits 128 on a pathspec matching nothing. Only a
        // still-conflicted path is a real failure; a failed status read falls
        // back to the error. The hold starts before that read, so the buttons
        // stay disabled across it.
        setRecovering(true);
        const status = await gitStatus(repoPath).catch(() => null);
        const resolvedElsewhere =
          status !== null && !listsConflicted(status, path);
        if (!resolvedElsewhere) toastError(e);
        await refreshAfterError();
        armLanding("header", pressed);
      }
    } finally {
      inFlightRef.current = false;
    }
  }

  // Palette-only; enabled with the button, busy state included, so the palette
  // can't fire a second stage while one is in flight.
  useHotkeyAction(
    "mark-conflict-resolved",
    markResolved,
    canMarkResolved && !busy,
  );

  // Precompute each segment's conflict ordinal (its index among conflicts, for
  // resolveBlock) up front, so the render map only reads a stable array rather
  // than mutating a counter captured by the per-region onClick lambdas.
  const conflictOrdinals: (number | null)[] = [];
  let conflictSeen = -1;
  for (const seg of segments ?? []) {
    conflictOrdinals.push(seg.kind === "context" ? null : ++conflictSeen);
  }
  const keys = segmentKeys(segments ?? []);
  // Regions the body renders now; none while it shows an error or a fallback.
  const regionCount = file.isError || segments === null ? 0 : conflictSeen + 1;

  // Waits out the hold, so the target is post-re-read and focusable. Consumed
  // whether or not it lands: it never takes focus the user moved elsewhere or
  // took over the pane from, and never lands on another file than its own.
  // The pane stays mounted here, so its own sink is the fallback. Focus inside
  // another dialog (the shared confirm, still closing) isn't the user's: the
  // landing stays pending and waits, bounded, for focus to leave it, then
  // re-arms so these rules run against the live state; at the bound it drops.
  useLayoutEffect(() => {
    if (landRequest === null || busy) return;
    setLandRequest(null);
    const pending = landPendingRef.current;
    landPendingRef.current = false;
    if (!pending) return;
    if (landRequest.repoPath !== repoPath || landRequest.path !== path) return;
    if (inOtherDialog(document.activeElement, rootRef.current)) {
      landPendingRef.current = true;
      const request = landRequest;
      landWaitRef.current = awaitFocusRelease({
        held: () => inOtherDialog(document.activeElement, rootRef.current),
        aborted: () => !landPendingRef.current,
        onRelease: () => setLandRequest(request),
        onTimeout: () => {
          landPendingRef.current = false;
        },
      });
      return;
    }
    const active = document.activeElement;
    if (
      active !== null &&
      active !== document.body &&
      active !== landRequest.pressed
    )
      return;
    const sink = focusSinkRef.current;
    if (landRequest.kind === "header") {
      const pressed = landRequest.pressed;
      (pressed?.isConnected ? pressed : sink)?.focus({ preventScroll: true });
      return;
    }
    const ordinal = landingOrdinal(landRequest.ordinal ?? 0, regionCount);
    const scroller = scrollerRef.current;
    const header =
      ordinal === null
        ? null
        : scroller?.querySelector<HTMLElement>(
            `[data-conflict-ordinal="${ordinal}"]`,
          );
    if (scroller && header) landConflictRegion(scroller, header, true);
    else sink?.focus({ preventScroll: true });
  }, [landRequest, busy, repoPath, path, regionCount]);

  // Anchored on the region header that holds focus, else on where the pane
  // sits; both read the DOM at the press, so no cursor outlives it.
  function jumpToConflict(pick: typeof nextConflictIndex) {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const headers = [
      ...scroller.querySelectorAll<HTMLElement>("[data-conflict-ordinal]"),
    ];
    const owner = document.activeElement?.closest<HTMLElement>(
      "[data-conflict-ordinal]",
    );
    const anchor =
      owner && scroller.contains(owner)
        ? Number(owner.dataset.conflictOrdinal)
        : null;
    const paneTop = scroller.getBoundingClientRect().top + scroller.clientTop;
    const target = pick(
      anchor,
      headers.map((header) => header.getBoundingClientRect().top - paneTop),
    );
    if (target !== null) landConflictRegion(scroller, headers[target], true);
  }
  const jumpNext = () => jumpToConflict(nextConflictIndex);
  const jumpPrevious = () => jumpToConflict(previousConflictIndex);
  // Read-only over the rendered regions, so a write in flight doesn't hold it.
  // A held or preparing diff-pane slot is inert, which global hotkeys ignore.
  const { interactive } = useDiffPaneHold();
  useHotkeyAction("next-conflict", jumpNext, regionView && interactive);
  useHotkeyAction("previous-conflict", jumpPrevious, regionView && interactive);
  const bindings = useEffectiveBindings();
  const jumpTitle = (
    label: string,
    id: "next-conflict" | "previous-conflict",
  ) => {
    const binding = bindings.get(id) ?? null;
    return binding ? `${label} (${formatBinding(binding)})` : label;
  };

  // Scrolls the first region into view on open when it starts below the fold,
  // leaving focus alone. The ref is stamped before the scroll, so it runs once
  // per mount and file.
  useLayoutEffect(() => {
    if (!regionView) return;
    const landed = openLandedRef.current;
    if (landed?.repoPath === repoPath && landed.path === path) return;
    openLandedRef.current = { repoPath, path };
    const scroller = scrollerRef.current;
    const first = scroller?.querySelector<HTMLElement>(
      '[data-conflict-ordinal="0"]',
    );
    if (!scroller || !first) return;
    const paneTop = scroller.getBoundingClientRect().top + scroller.clientTop;
    const firstTop = first.getBoundingClientRect().top - paneTop;
    if (shouldLandOnOpen(firstTop, scroller.clientHeight))
      landConflictRegion(scroller, first, false);
  }, [regionView, repoPath, path]);

  // Input before the read lands forfeits the on-open landing for the file on
  // screen: a pointer press anywhere, or wheel, touch or a scroll key in the
  // pane. Never a scroll-position compare.
  const shownFileRef = useLatestRef({ repoPath, path });
  useEffect(() => {
    const forfeit = () => {
      openLandedRef.current = shownFileRef.current;
    };
    const inPane = (target: EventTarget | null) =>
      target instanceof Node && scrollerRef.current?.contains(target) === true;
    const forfeitInPane = (e: Event) => {
      if (inPane(e.target)) forfeit();
    };
    const forfeitKey = (e: KeyboardEvent) => {
      if (PANE_SCROLL_KEYS.has(e.key)) forfeitInPane(e);
    };
    const passive = { capture: true, passive: true };
    document.addEventListener("pointerdown", forfeit, true);
    document.addEventListener("wheel", forfeitInPane, passive);
    document.addEventListener("touchmove", forfeitInPane, passive);
    document.addEventListener("keydown", forfeitKey, passive);
    return () => {
      document.removeEventListener("pointerdown", forfeit, true);
      document.removeEventListener("wheel", forfeitInPane, true);
      document.removeEventListener("touchmove", forfeitInPane, true);
      document.removeEventListener("keydown", forfeitKey, true);
    };
  }, []);

  // Announces an accept's new count once; the count line itself is no live
  // region, since the poll re-reads it. Keyed on the read, so a re-read that
  // leaves the count unchanged (or at zero) still disarms a settled accept.
  const fileRead = file.data;
  useLayoutEffect(() => {
    const armed = announceRef.current;
    if (armed === null) return;
    if (armed.repoPath !== repoPath || armed.path !== path) {
      announceRef.current = null;
      return;
    }
    if (fileRead === armed.read) return;
    armed.committed = true;
    armed.text =
      total !== armed.count && total !== 0
        ? `${conflictCountLabel(total)} left`
        : null;
    if (!armed.settled) return;
    announceRef.current = null;
    if (armed.text !== null)
      setAnnouncement({ repoPath, path, text: armed.text });
  }, [fileRead, total, repoPath, path]);

  // The strip's buttons leave with the region view (an outside resolve, or
  // the last accept settling): focus lands on the view's sink, never <body>.
  useFocusOnControlsSwap(regionView, focusSinkRef);
  // The header's actions leave as the submodule arm lands: the same rescue.
  useFocusOnControlsSwap(submoduleArm, focusSinkRef);
  // The pane's Accepts leave with its sides, which the submodule read alone can
  // swap out while the arm stays (an outside resolve, a failed read).
  useFocusOnControlsSwap(submoduleSides, focusSinkRef);

  return (
    <div
      ref={rootRef}
      className="ph-no-capture flex h-full flex-col"
      onPointerDownCapture={takeOverLanding}
      onWheelCapture={takeOverLanding}
      onTouchMoveCapture={takeOverLanding}
      onKeyDownCapture={(e) => {
        if (PANE_SCROLL_KEYS.has(e.key)) takeOverLanding();
      }}
    >
      {/* Where a landing goes when its target is gone. */}
      <span ref={focusSinkRef} tabIndex={-1} className="sr-only" />
      {/* Header toolbar — calm, neutral; whole-file + AI actions. From a
          700px pane it is one row whose path truncates; narrower, the path
          takes its own row and the actions wrap under it, right-aligned. */}
      <div className="@container/conflict-toolbar border-b">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-3 py-1.5 @min-[700px]/conflict-toolbar:flex-nowrap">
          {submoduleArm ? (
            <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <PathText path={path} className="font-mono" />
              <span className="shrink-0">· submodule conflict</span>
            </span>
          ) : (
            <>
              <PathText
                path={path}
                className="basis-full font-mono text-xs text-muted-foreground @min-[700px]/conflict-toolbar:basis-auto"
              />
              <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5 @min-[700px]/conflict-toolbar:shrink-0">
                <Button size="xs" variant="ghost" onClick={openInEditor}>
                  Open in editor
                </Button>
                {/* Held on a path git calls merged: Accept all re-checks the file out
                from the index, over any edits made after an outside `git add`. Side
                checkout shares the path gate and refuses a linked ancestor or Windows
                folder link, but git replaces or removes any other leaf link itself, so
                that refusal alone leaves both on. */}
                <DisabledReasonButton
                  size="xs"
                  variant="outline"
                  disabled={busy || notConflicted || sideRefusal !== null}
                  reason={notConflicted ? NOT_CONFLICTED_COPY : sideRefusal}
                  onClick={() => acceptAll("ours")}
                >
                  Accept all current
                </DisabledReasonButton>
                <DisabledReasonButton
                  size="xs"
                  variant="outline"
                  disabled={busy || notConflicted || sideRefusal !== null}
                  reason={notConflicted ? NOT_CONFLICTED_COPY : sideRefusal}
                  onClick={() => acceptAll("theirs")}
                >
                  Accept all incoming
                </DisabledReasonButton>
                {offersAi && (
                  // This view's OWN repoPath scopes the walk — the main repo on the
                  // Changes tab, the hidden worktree in a PR takeover.
                  <DisabledReasonButton
                    size="xs"
                    disabled={
                      busy || notConflicted || workingUndecodable || aiTooLarge
                    }
                    reason={aiHeldReason}
                    onClick={() => startResolveAi(path, repoPath)}
                  >
                    <SparkleIcon data-icon="inline-start" />
                    Resolve with AI
                  </DisabledReasonButton>
                )}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Only over the region view: the fallback arms already resolve whole. */}
      {!file.isError && segments !== null && workingUndecodable && (
        <InfoNote className="shrink-0">{CONFLICT_UNDECODABLE_NOTE}</InfoNote>
      )}

      {/* Mounts in the same commit as the regions, so the body never shifts
          under it; the buttons drop their labels below a 240px strip. */}
      {regionView && (
        <div className="@container/conflict-strip flex shrink-0 items-center justify-between gap-2 border-b bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground">
          <span className="min-w-0 truncate">{`${conflictCountLabel(total)} left`}</span>
          <span role="status" aria-live="polite" className="sr-only">
            {announcement?.repoPath === repoPath && announcement.path === path
              ? announcement.text
              : ""}
          </span>
          {/* A native button takes focus on mousedown, so the header the last
              jump focused would stop anchoring a click; focus stays put. */}
          <span className="flex shrink-0 items-center gap-1">
            <Button
              size="xs"
              variant="ghost"
              aria-label="Previous conflict"
              title={jumpTitle("Previous conflict", "previous-conflict")}
              className={JUMP_ICON_ONLY}
              onMouseDown={(e) => e.preventDefault()}
              onClick={jumpPrevious}
            >
              <ArrowUpIcon data-icon="inline-start" />
              <span data-slot="jump-label">Previous</span>
            </Button>
            <Button
              size="xs"
              variant="ghost"
              aria-label="Next conflict"
              title={jumpTitle("Next conflict", "next-conflict")}
              className={JUMP_ICON_ONLY}
              onMouseDown={(e) => e.preventDefault()}
              onClick={jumpNext}
            >
              <span data-slot="jump-label">Next</span>
              <ArrowDownIcon data-icon="inline-end" />
            </Button>
          </span>
        </div>
      )}

      {/* Body */}
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-auto">
        {file.isPending ? (
          <p className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
            <Spinner className="size-3" />
            Reading the conflict…
          </p>
        ) : file.isError ? (
          readErrorView
        ) : segments === null ? (
          <ConflictFallback
            path={path}
            // Both non-null on this branch: a held read that is neither pending
            // nor failed has landed data, and it's the same data +
            // `segments === null` + not-error condition `arm` was computed under.
            sides={file.data as ConflictSides}
            arm={arm as FallbackArm}
            busy={busy}
            busyReason={busyReason}
            onMarkResolved={markResolved}
            plain={plainCode}
          />
        ) : (
          segments.map((seg, idx) => {
            if (seg.kind === "context") {
              return seg.text === "" ? null : (
                <HighlightedCode
                  key={keys[idx]}
                  path={path}
                  content={seg.text}
                  plain={plainCode}
                  className="px-3 py-1"
                />
              );
            }
            // Non-context segments always have an ordinal (asserted non-null).
            const index = conflictOrdinals[idx] as number;
            return (
              <div key={keys[idx]} className="border-y border-warning/40">
                {/* Focusable by its conflict ordinal: segment keys follow
                    content, not place, so a landing finds its region by
                    this. Named by its label, so a landing announces which
                    conflict it is; the accepts wrap under the label when
                    narrow. */}
                <div
                  role="group"
                  aria-labelledby={`${labelIdBase}-conflict-${index}`}
                  tabIndex={-1}
                  data-conflict-ordinal={index}
                  className="flex flex-wrap items-center justify-between gap-x-2 bg-muted/40 px-3 py-1 text-[11px]"
                >
                  <span
                    id={`${labelIdBase}-conflict-${index}`}
                    className="font-medium text-muted-foreground"
                  >
                    Conflict {index + 1} of {total}
                  </span>
                  {!workingUndecodable && (
                    <span className="ml-auto flex flex-wrap justify-end">
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => acceptRegion(index, "current")}
                      >
                        Accept current
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => acceptRegion(index, "incoming")}
                      >
                        Accept incoming
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => acceptRegion(index, "both")}
                      >
                        Both
                      </Button>
                    </span>
                  )}
                </div>
                <div className="bg-success/5">
                  <div className="px-3 py-0.5 text-[10px] font-medium text-success">
                    Current (ours)
                    {seg.currentLabel ? ` · ${seg.currentLabel}` : ""}
                  </div>
                  <HighlightedCode
                    path={path}
                    content={seg.current || " "}
                    plain={plainCode}
                    className="px-3 py-1"
                  />
                </div>
                <div className="bg-info/5">
                  <div className="px-3 py-0.5 text-[10px] font-medium text-info">
                    Incoming (theirs)
                    {seg.incomingLabel ? ` · ${seg.incomingLabel}` : ""}
                  </div>
                  <HighlightedCode
                    path={path}
                    content={seg.incoming || " "}
                    plain={plainCode}
                    className="px-3 py-1"
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
