import { type ReactNode, useLayoutEffect, useState } from "react";
import { ImageLightbox, type LightboxImage } from "@/components/image-lightbox";
import { IMAGE_CAPTION_REASON } from "@/components/markdown/markdown-images";
import { Button } from "@/components/ui/button";
import { useRetryFocusRescue } from "@/features/conversations/ConversationListPanel";
import { formatBytes } from "@/lib/format-bytes";
import type { FileBytes } from "@/lib/git/api";
import { isAppError } from "@/lib/tauri/invoke";
import { cn } from "@/lib/utils";
import {
  contentSourceKey,
  type ForgePatch,
  useFileAtSource,
} from "./content-source";
import { useReportPaneSettled } from "./diff-pane-hold";

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

/** The MIME type when the path looks like a displayable image. */
export function imageMime(filePath: string): string | null {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return null;
  return IMAGE_MIME[filePath.slice(dot + 1).toLowerCase()] ?? null;
}

/** Where to read each side of an image diff: a rev, or null = working tree. */
export interface ImageRevs {
  old: string | null;
  new: string | null;
}

interface Size {
  w: number;
  h: number;
}

type PaneKey = "old" | "new";

/** Why a side's read failed: a refusal (a linked, non-regular or refused path,
 *  or an invalid rev) answers the same on every read, so only a failed read
 *  offers Retry. */
type SideError = "notImage" | "readFailed";

interface Pane {
  key: PaneKey;
  label: string;
  /** null = no bytes to show: a pending or failed side (see `pending` and
   *  `error`), else one whose bytes the backend refused (a refusal box). */
  src: string | null;
  /** The read failed, so this side's existence is unknown. */
  error?: SideError;
  /** The side is reading again after a failure; the other side stays shown. */
  pending?: true;
  /** The side's byte length; null or absent = unknown, so no size is shown. */
  bytes?: number | null;
}

/** A side's read: its bytes (null = not in that version), why it couldn't be
 *  read, or still pending. A failure with bytes already loaded keeps showing
 *  them. */
type SideRead =
  | { bytes: FileBytes | null }
  | { error: SideError }
  | { pending: true };

function sideRead(
  read: {
    data: FileBytes | null | undefined;
    isPending: boolean;
    isError: boolean;
    error: unknown;
    fetchStatus: string;
  },
  forge: boolean,
): SideRead {
  if (read.data !== undefined) return { bytes: read.data };
  // A forge read that can't run is unavailable, never loading: a disabled one
  // (no full sha) answers the same every time, a paused one (offline) may not.
  if (forge && read.isPending && read.fetchStatus === "idle")
    return { error: "notImage" };
  if (forge && read.isPending && read.fetchStatus === "paused")
    return { error: "readFailed" };
  if (read.isPending) return { pending: true };
  if (!read.isError) return { bytes: null };
  return {
    error:
      isAppError(read.error) && read.error.kind === "invalidArgument"
        ? "notImage"
        : "readFailed",
  };
}

function ImageSide({
  label,
  size,
  bytes,
  src,
  onOpen,
  onMeasure,
  onFail,
}: {
  label: string;
  /** The parent's record of this side's measurement — the caption's only
   *  source, so the two can't disagree about which file is on screen. */
  size: Size | undefined;
  /** Rides the measured caption only, so it never adds a line of its own. */
  bytes?: number | null;
  src: string;
  onOpen: () => void;
  onMeasure: (size: Size) => void;
  /** The image failed to decode: it will never measure. */
  onFail: () => void;
}) {
  return (
    <figure className="min-w-0 max-w-[45%] space-y-1.5 text-center">
      <figcaption className="text-xs font-medium text-muted-foreground">
        {label}
      </figcaption>
      <div
        className="inline-block border"
        // Checkerboard so transparency reads as transparency.
        style={{
          backgroundImage:
            "conic-gradient(rgba(128,128,128,0.2) 25%, transparent 0 50%, rgba(128,128,128,0.2) 0 75%, transparent 0)",
          backgroundSize: "16px 16px",
        }}
      >
        <button
          aria-label={`View ${label} image fullscreen`}
          className="block cursor-zoom-in outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
          onClick={onOpen}
          type="button"
        >
          <img
            alt={label}
            className="max-h-[60vh] max-w-full"
            onError={onFail}
            onLoad={(e) =>
              onMeasure({
                w: e.currentTarget.naturalWidth,
                h: e.currentTarget.naturalHeight,
              })
            }
            src={src}
          />
        </button>
      </div>
      {size !== undefined && (
        <p className="text-[11px] text-muted-foreground tabular-nums">
          {size.w} × {size.h}
          {bytes != null
            ? ` · ${formatBytes(bytes).replace(" ", "\u00a0")}`
            : ""}
        </p>
      )}
    </figure>
  );
}

/** A side whose bytes the backend withheld — an oversized file, or a raster whose
 *  header declares more than the webview's decoder should be handed. Visible, so a
 *  refusal never reads as a blank pane. A pixel-count refusal arrives without
 *  a size, so only a byte-cap refusal names one. */
function RefusedSide({
  label,
  bytes,
}: {
  label: string;
  bytes?: number | null;
}) {
  return (
    <figure className="min-w-0 max-w-[45%] space-y-1.5 text-center">
      <figcaption className="text-xs font-medium text-muted-foreground">
        {label}
      </figcaption>
      <div className="flex h-40 w-56 max-w-full items-center justify-center border px-4">
        <p className="text-xs text-muted-foreground">
          {IMAGE_CAPTION_REASON.tooLarge}
          {bytes != null
            ? ` (${formatBytes(bytes).replace(" ", "\u00a0")})`
            : ""}
        </p>
      </div>
    </figure>
  );
}

/** A side reading again after a failure, in the refusal box's look: empty, so a
 *  local read that settles at once doesn't flash a message. */
function PendingSide({ label }: { label: string }) {
  return (
    <figure className="min-w-0 max-w-[45%] space-y-1.5 text-center">
      <figcaption className="text-xs font-medium text-muted-foreground">
        {label}
      </figcaption>
      <div aria-busy="true" className="h-40 w-56 max-w-full border" />
    </figure>
  );
}

/** A side whose read failed, in the refusal box's look: the reason, and a
 *  Retry when another read could answer differently. */
function FailedSide({
  label,
  error,
  onRetry,
  retryRef,
}: {
  label: string;
  error: SideError;
  onRetry: () => void;
  retryRef: ReturnType<typeof useRetryFocusRescue>["retryRef"];
}) {
  return (
    <figure className="min-w-0 max-w-[45%] space-y-1.5 text-center">
      <figcaption className="text-xs font-medium text-muted-foreground">
        {label}
      </figcaption>
      <div className="flex h-40 w-56 max-w-full flex-col items-center justify-center gap-2 border px-4">
        <p className="text-xs text-muted-foreground">
          {IMAGE_CAPTION_REASON[error]}
        </p>
        {error === "readFailed" && (
          <Button
            ref={retryRef}
            variant="outline"
            size="sm"
            className="cursor-pointer"
            onClick={onRetry}
          >
            Retry
          </Button>
        )}
      </div>
    </figure>
  );
}

/** Measured sides and the open viewer, scoped to the file (a forge-patch host)
 *  or the pair (any other host) they belong to. */
interface PanesState {
  id: string;
  old?: Size;
  new?: Size;
  /** Sides whose image fired `error`, so they will never measure. */
  failed?: Partial<Record<PaneKey, true>>;
  /** The side the viewer shows: a side, never a slot of the shown ones, which
   *  shift when a new-only pair gains its old side. */
  viewing?: PaneKey;
  /** A forge-patch host's last settled reads of this file, drawn while a new
   *  pair's first reads are in flight. */
  settled?: Record<PaneKey, SettledSide>;
}

/** A settled read with the path it was read at: a kept side's type fallback
 *  reads that path, never the pair now reading. */
interface SettledSide {
  read: SideRead;
  path: string;
}

/** The same answer: the same FileBytes object, never a compare of its bytes. */
function sameRead(a: SideRead, b: SideRead): boolean {
  if ("bytes" in a) return "bytes" in b && a.bytes === b.bytes;
  if ("error" in a) return "error" in b && a.error === b.error;
  return "pending" in b;
}

/** The same image: one compare of the bytes, made only when the reads'
 *  FileBytes changed. */
function sameBytes(a: SideRead, b: SideRead): boolean {
  if (!("bytes" in a) || !("bytes" in b)) return false;
  const [x, y] = [a.bytes, b.bytes];
  return (
    x === y ||
    (x !== null && y !== null && x.base64 === y.base64 && x.mime === y.mime)
  );
}

/** `prev` keeping `next` as its settled reads: a side whose bytes changed
 *  drops its measurement and decode failure, which were the previous image's. */
function keepSettled(
  prev: PanesState,
  next: Record<PaneKey, SettledSide>,
): PanesState {
  const out: PanesState = { ...prev, settled: next };
  for (const key of ["old", "new"] as const) {
    if (
      prev.settled === undefined ||
      sameBytes(prev.settled[key].read, next[key].read)
    )
      continue;
    out[key] = undefined;
    if (out.failed?.[key]) out.failed = { ...out.failed, [key]: undefined };
  }
  return out;
}

/**
 * The old/new comparison panes by themselves — also embedded above the text
 * diff for SVGs, which are text but deserve a rendered preview too.
 */
export function ImagePanes({
  repoPath,
  filePath,
  oldPath,
  revs,
  forgePatch,
  lineKeeper,
}: {
  repoPath: string;
  filePath: string;
  /** The old side's path: the diff's rename source, else `filePath`. */
  oldPath: string;
  revs: ImageRevs;
  /** A forge-patch host: each side reads from its source, by sha. */
  forgePatch?: ForgePatch;
  /** Set where the panes sit above a diff's rows: called after every change of
   *  their layout, so the reader's top line stays put. */
  lineKeeper?: { readonly current: (() => void) | null };
}) {
  // A source not known yet reads nothing.
  const source = forgePatch === undefined ? "local" : forgePatch.source;
  const forge = source !== null && source !== "local";
  const oldFile = useFileAtSource({
    repo: repoPath,
    source: source ?? "local",
    rev: revs.old,
    path: oldPath,
    enabled: source !== null,
  });
  const newFile = useFileAtSource({
    repo: repoPath,
    source: source ?? "local",
    rev: revs.new,
    path: filePath,
    enabled: source !== null,
  });
  // Keyed by the file on a forge-patch host, whose panes outlive a pair
  // change, else by the pair: a switch to another file drops the previous
  // one's measurements and viewer index during render.
  const [state, setState] = useState<PanesState>({ id: "" });

  // Only a first read holds the pair back; a side reading again after a failure
  // (Retry, a focus refetch) pends on its own while the other stays shown. A
  // read that can't run (disabled, paused) never holds it: it's unavailable.
  const pending =
    (oldFile.isPending &&
      oldFile.errorUpdateCount === 0 &&
      oldFile.fetchStatus === "fetching") ||
    (newFile.isPending &&
      newFile.errorUpdateCount === 0 &&
      newFile.fetchStatus === "fetching");
  const oldRead = sideRead(oldFile, forge);
  const newRead = sideRead(newFile, forge);
  // A local first read holds the pair whatever its fetch status.
  const held =
    pending ||
    (!forge &&
      (("pending" in oldRead && oldFile.errorUpdateCount === 0) ||
        ("pending" in newRead && newFile.errorUpdateCount === 0)));
  const keeps = forgePatch !== undefined;
  const pairId = [
    filePath,
    oldPath,
    revs.old,
    revs.new,
    source === null ? "unknown" : contentSourceKey(source),
  ].join("|");
  const id = keeps ? filePath : pairId;
  const current = state.id === id ? state : null;
  // While a new pair's first reads are in flight, a forge-patch host draws
  // this file's last settled reads, so panes on screen never blank and swap
  // in one commit; a new read that failed or can't run shows at once.
  const snapshot = keeps && pending ? (current?.settled ?? null) : null;
  const drawn = (live: SideRead, path: string, key: PaneKey): SettledSide =>
    snapshot !== null && !("error" in live)
      ? snapshot[key]
      : { read: live, path };
  const { read: drawnOld, path: drawnOldPath } = drawn(oldRead, oldPath, "old");
  const { read: drawnNew, path: drawnNewPath } = drawn(
    newRead,
    filePath,
    "new",
  );
  const drawnHeld = held && snapshot === null;
  if (
    keeps &&
    !held &&
    (current?.settled === undefined ||
      !sameRead(current.settled.old.read, oldRead) ||
      !sameRead(current.settled.new.read, newRead) ||
      current.settled.old.path !== oldPath ||
      current.settled.new.path !== filePath)
  )
    setState((prev) =>
      keepSettled(prev.id === id ? prev : { id }, {
        old: { read: oldRead, path: oldPath },
        new: { read: newRead, path: filePath },
      }),
    );
  // Absent only when the read answered so: a failed side might exist.
  const oldAbsent = "bytes" in drawnOld && drawnOld.bytes === null;
  const newAbsent = "bytes" in drawnNew && drawnNew.bytes === null;
  // One rescue per side, so each Retry keeps its own claim on focus: a retry
  // resets its read to pending, which unmounts that side's Retry.
  const oldRescue = useRetryFocusRescue(
    !drawnHeld && "error" in drawnOld && drawnOld.error === "readFailed",
  );
  const newRescue = useRetryFocusRescue(
    !drawnHeld && "error" in drawnNew && drawnNew.error === "readFailed",
  );
  const hostRef = (node: HTMLDivElement | null) => {
    oldRescue.hostRef(node);
    newRescue.hostRef(node);
  };
  const patch = (next: Partial<PanesState>) =>
    setState((prev) =>
      prev.id === id ? { ...prev, ...next } : { id, ...next },
    );
  // Merged inside the update: both sides can fail in one tick.
  const markFailed = (key: PaneKey) =>
    setState((prev) => {
      const base: PanesState = prev.id === id ? prev : { id };
      return { ...base, failed: { ...base.failed, [key]: true } };
    });

  // The sniffed type wins over the extension, which any commit spells freely;
  // it's per-side because the two revisions can hold different formats.
  const paneSrc = (side: FileBytes, path: string) =>
    side.base64 === null
      ? null
      : `data:${side.mime ?? imageMime(path) ?? "application/octet-stream"};base64,${side.base64}`;

  const toPane = (
    key: PaneKey,
    read: SideRead,
    path: string,
    label: string,
  ): Pane | null => {
    if ("pending" in read) return { key, label, src: null, pending: true };
    if ("error" in read) return { key, label, src: null, error: read.error };
    return read.bytes === null
      ? null
      : {
          key,
          label,
          src: paneSrc(read.bytes, path),
          bytes: read.bytes.size,
        };
  };
  const panes = [
    toPane("old", drawnOld, drawnOldPath, newAbsent ? "Deleted" : "Old"),
    toPane("new", drawnNew, drawnNewPath, oldAbsent ? "Added" : "New"),
  ].filter((pane): pane is Pane => pane !== null);

  // A refused side has nothing to show fullscreen, so the viewer indexes only
  // the sides that rendered an image.
  const shown = panes.filter(
    (pane): pane is Pane & { src: string } => pane.src !== null,
  );
  // A data: URL decodes after the bytes land, and the box sizes (and the w × h
  // caption appears) only then, so settle waits for every shown image of THIS
  // pair to load or fail. Refused sides and the no-image line are final.
  useReportPaneSettled(
    !drawnHeld &&
      !panes.some((pane) => pane.pending) &&
      shown.every(
        (pane) =>
          current?.[pane.key] !== undefined || current?.failed?.[pane.key],
      ),
  );

  // Every change of the panes' layout, a measured caption included.
  const layout = drawnHeld
    ? ""
    : JSON.stringify([
        panes.map((p) => [p.key, p.label, p.src === null, p.error, p.pending]),
        current?.old,
        current?.new,
        current?.failed,
      ]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: it runs once per layout, which `layout` names
  useLayoutEffect(() => {
    lineKeeper?.current?.();
  }, [lineKeeper, layout]);

  // The root renders on every arm, pending included (empty and unpadded, so an
  // embedding view lays out as before): it is where a pressed Retry's focus
  // lands once the retried read swaps the panes out.
  const shell = (content: ReactNode) => (
    <div
      ref={hostRef}
      tabIndex={-1}
      className={cn(
        "flex items-start justify-center gap-8 outline-none",
        !drawnHeld && "p-6",
      )}
    >
      {content}
    </div>
  );

  if (drawnHeld) {
    return shell(null);
  }

  // Keyed by side, so the viewer's zoom and image survive a side's move to
  // another index (a new-only pair gaining its old side).
  const images: LightboxImage[] = shown.map((pane) => ({
    id: pane.key,
    src: pane.src,
    alt: pane.label,
    label: pane.label,
    naturalWidth: current?.[pane.key]?.w,
    naturalHeight: current?.[pane.key]?.h,
  }));
  // The viewer's slot follows its side; a side that left closes it for good.
  const viewingAt = shown.findIndex((pane) => pane.key === current?.viewing);
  const viewing = viewingAt === -1 ? null : viewingAt;
  if (current?.viewing !== undefined && viewing === null)
    patch({ viewing: undefined });

  return shell(
    <>
      {panes.map((pane) => {
        // Keyed by the panes' scope as well as the slot: an `<img>` kept
        // across a file switch paints the previous file until the new src
        // decodes, while a forge-patch host's new pair reuses it.
        const key = `${id}|${pane.key}`;
        if (pane.pending) {
          return <PendingSide key={key} label={pane.label} />;
        }
        if (pane.error !== undefined) {
          const read = pane.key === "old" ? oldFile : newFile;
          const rescue = pane.key === "old" ? oldRescue : newRescue;
          return (
            <FailedSide
              key={key}
              label={pane.label}
              error={pane.error}
              onRetry={() => void read.refetch()}
              retryRef={rescue.retryRef}
            />
          );
        }
        if (pane.src === null) {
          return (
            <RefusedSide key={key} label={pane.label} bytes={pane.bytes} />
          );
        }
        const { src } = pane;
        return (
          <ImageSide
            key={key}
            label={pane.label}
            onMeasure={(size) => patch({ [pane.key]: size })}
            onFail={() => markFailed(pane.key)}
            onOpen={() => patch({ viewing: pane.key })}
            size={current?.[pane.key]}
            bytes={pane.bytes}
            src={src}
          />
        );
      })}
      {panes.length === 0 && (
        <p className="py-8 text-xs text-muted-foreground">
          Could not load this image.
        </p>
      )}
      {/* Nested here rather than at a shared host: Base UI suppresses a parent
          dialog's Escape only for a dialog inside its React tree, and these
          panes render inside StashesDialog on one of their routes. */}
      <ImageLightbox
        images={images}
        index={viewing ?? 0}
        onIndexChange={(next) => patch({ viewing: shown[next]?.key })}
        onOpenChange={(open) => {
          if (!open) patch({ viewing: undefined });
        }}
        open={viewing !== null}
      />
    </>,
  );
}

/**
 * Old/new rendering for binary image files, replacing the "binary file"
 * placeholder wherever local revisions are available.
 */
export function ImageDiff({
  repoPath,
  filePath,
  oldPath,
  revs,
  forgePatch,
}: {
  repoPath: string;
  filePath: string;
  /** The old side's path: the diff's rename source, else `filePath`. */
  oldPath: string;
  revs: ImageRevs;
  /** See {@link ImagePanes}' prop of the same name. */
  forgePatch?: ForgePatch;
}) {
  return (
    // ph-no-capture: user image content — block from session replay.
    <div className="ph-no-capture flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <ImagePanes
          repoPath={repoPath}
          filePath={filePath}
          oldPath={oldPath}
          revs={revs}
          forgePatch={forgePatch}
        />
      </div>
    </div>
  );
}
