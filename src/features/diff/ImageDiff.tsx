import { type ReactNode, useState } from "react";
import { IMAGE_CAPTION_REASON } from "@/components/markdown/markdown-images";
import { PathText } from "@/components/path-text";
import { Button } from "@/components/ui/button";
import {
  ImageLightbox,
  type LightboxImage,
} from "@/components/ui/image-lightbox";
import { useRetryFocusRescue } from "@/features/conversations/ConversationListPanel";
import type { FileBytes } from "@/lib/git/api";
import { useFileAtRev } from "@/lib/git/queries";
import { isAppError } from "@/lib/tauri/invoke";
import { cn } from "@/lib/utils";
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
  /** null = the backend refused these bytes; the side renders a refusal box. */
  src: string | null;
  /** The read failed, so this side's existence is unknown. */
  error?: SideError;
  /** The side is reading again after a failure; the other side stays shown. */
  pending?: true;
}

/** A side's read: its bytes (null = not in that version), why it couldn't be
 *  read, or still pending. A failure with bytes already loaded keeps showing
 *  them. */
type SideRead =
  | { bytes: FileBytes | null }
  | { error: SideError }
  | { pending: true };

function sideRead(read: {
  data: FileBytes | null | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
}): SideRead {
  if (read.data !== undefined) return { bytes: read.data };
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
  src,
  onOpen,
  onMeasure,
  onFail,
}: {
  label: string;
  /** The parent's record of this side's measurement — the caption's only
   *  source, so the two can't disagree about which file is on screen. */
  size: Size | undefined;
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
        </p>
      )}
    </figure>
  );
}

/** A side whose bytes the backend withheld — an oversized file, or a raster whose
 *  header declares more than the webview's decoder should be handed. Visible, so a
 *  refusal never reads as a blank pane. */
function RefusedSide({ label }: { label: string }) {
  return (
    <figure className="min-w-0 max-w-[45%] space-y-1.5 text-center">
      <figcaption className="text-xs font-medium text-muted-foreground">
        {label}
      </figcaption>
      <div className="flex h-40 w-56 max-w-full items-center justify-center border px-4">
        <p className="text-xs text-muted-foreground">
          {IMAGE_CAPTION_REASON.tooLarge}
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

/** Measured sides and the open viewer, scoped to the pair they belong to. */
interface PanesState {
  id: string;
  old?: Size;
  new?: Size;
  /** Sides whose image fired `error`, so they will never measure. */
  failed?: Partial<Record<PaneKey, true>>;
  viewing?: number;
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
}: {
  repoPath: string;
  filePath: string;
  /** The old side's path: the diff's rename source, else `filePath`. */
  oldPath: string;
  revs: ImageRevs;
}) {
  const oldFile = useFileAtRev(repoPath, revs.old, oldPath, true);
  const newFile = useFileAtRev(repoPath, revs.new, filePath, true);
  // Keyed by the pair being shown, so a switch to another file drops the
  // previous one's measurements and viewer index during render.
  const [state, setState] = useState<PanesState>({ id: "" });

  // Only a first read holds the pair back; a side reading again after a failure
  // (Retry, a focus refetch) pends on its own while the other stays shown.
  const pending =
    (oldFile.isPending && oldFile.errorUpdateCount === 0) ||
    (newFile.isPending && newFile.errorUpdateCount === 0);
  const oldRead = sideRead(oldFile);
  const newRead = sideRead(newFile);
  // Absent only when the read answered so: a failed side might exist.
  const oldAbsent = "bytes" in oldRead && oldRead.bytes === null;
  const newAbsent = "bytes" in newRead && newRead.bytes === null;
  // One rescue per side, so each Retry keeps its own claim on focus: a retry
  // resets its read to pending, which unmounts that side's Retry.
  const oldRescue = useRetryFocusRescue(
    !pending && "error" in oldRead && oldRead.error === "readFailed",
  );
  const newRescue = useRetryFocusRescue(
    !pending && "error" in newRead && newRead.error === "readFailed",
  );
  const hostRef = (node: HTMLDivElement | null) => {
    oldRescue.hostRef(node);
    newRescue.hostRef(node);
  };

  const id = [filePath, oldPath, revs.old, revs.new].join("|");
  const current = state.id === id ? state : null;
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
      : { key, label, src: paneSrc(read.bytes, path) };
  };
  const panes = [
    toPane("old", oldRead, oldPath, newAbsent ? "Deleted" : "Old"),
    toPane("new", newRead, filePath, oldAbsent ? "Added" : "New"),
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
    !pending &&
      !panes.some((pane) => pane.pending) &&
      shown.every(
        (pane) =>
          current?.[pane.key] !== undefined || current?.failed?.[pane.key],
      ),
  );

  // The root renders on every arm, pending included (empty and unpadded, so an
  // embedding view lays out as before): it is where a pressed Retry's focus
  // lands once the retried read swaps the panes out.
  const shell = (content: ReactNode) => (
    <div
      ref={hostRef}
      tabIndex={-1}
      className={cn(
        "flex items-start justify-center gap-8 outline-none",
        !pending && "p-6",
      )}
    >
      {content}
    </div>
  );

  if (pending) {
    return shell(null);
  }

  const images: LightboxImage[] = shown.map((pane) => ({
    src: pane.src,
    alt: pane.label,
    label: pane.label,
    naturalWidth: current?.[pane.key]?.w,
    naturalHeight: current?.[pane.key]?.h,
  }));
  const viewing = current?.viewing ?? null;

  return shell(
    <>
      {panes.map((pane) => {
        // Keyed by the pair as well as the slot: an `<img>` kept across a
        // file switch paints the previous file until the new src decodes.
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
          return <RefusedSide key={key} label={pane.label} />;
        }
        const { src } = pane;
        return (
          <ImageSide
            key={key}
            label={pane.label}
            onMeasure={(size) => patch({ [pane.key]: size })}
            onFail={() => markFailed(pane.key)}
            onOpen={() =>
              patch({ viewing: shown.findIndex((s) => s.key === pane.key) })
            }
            size={current?.[pane.key]}
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
        onIndexChange={(next) => patch({ viewing: next })}
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
}: {
  repoPath: string;
  filePath: string;
  /** The old side's path: the diff's rename source, else `filePath`. */
  oldPath: string;
  revs: ImageRevs;
}) {
  return (
    // ph-no-capture: user image content + path — block from session replay.
    <div className="ph-no-capture flex h-full flex-col">
      <div className="border-b px-3 py-1.5">
        <PathText
          path={filePath}
          className="font-mono text-xs text-muted-foreground"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <ImagePanes
          repoPath={repoPath}
          filePath={filePath}
          oldPath={oldPath}
          revs={revs}
        />
      </div>
    </div>
  );
}
