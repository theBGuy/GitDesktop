import { useState } from "react";
import {
  ImageLightbox,
  type LightboxImage,
} from "@/components/ui/image-lightbox";
import type { FileBytes } from "@/lib/git/api";
import { useFileAtRev } from "@/lib/git/queries";

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

interface Pane {
  key: PaneKey;
  label: string;
  /** null = the backend refused these bytes; the side renders a refusal box. */
  src: string | null;
}

function ImageSide({
  label,
  size,
  src,
  onOpen,
  onMeasure,
}: {
  label: string;
  /** The parent's record of this side's measurement — the caption's only
   *  source, so the two can't disagree about which file is on screen. */
  size: Size | undefined;
  src: string;
  onOpen: () => void;
  onMeasure: (size: Size) => void;
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
        <p className="text-xs text-muted-foreground">Too large to preview</p>
      </div>
    </figure>
  );
}

/** Measured sides and the open viewer, scoped to the pair they belong to. */
interface PanesState {
  id: string;
  old?: Size;
  new?: Size;
  viewing?: number;
}

/**
 * The old/new comparison panes by themselves — also embedded above the text
 * diff for SVGs, which are text but deserve a rendered preview too.
 */
export function ImagePanes({
  repoPath,
  filePath,
  revs,
}: {
  repoPath: string;
  filePath: string;
  revs: ImageRevs;
}) {
  const oldFile = useFileAtRev(repoPath, revs.old, filePath, true);
  const newFile = useFileAtRev(repoPath, revs.new, filePath, true);
  // Keyed by the pair being shown, so a switch to another file drops the
  // previous one's measurements and viewer index during render.
  const [state, setState] = useState<PanesState>({ id: "" });

  const pending = oldFile.isPending || newFile.isPending;
  const oldSide = oldFile.data ?? null;
  const newSide = newFile.data ?? null;

  if (pending) {
    return null;
  }

  const id = [filePath, revs.old, revs.new].join("|");
  const current = state.id === id ? state : null;
  const patch = (next: Partial<PanesState>) =>
    setState((prev) =>
      prev.id === id ? { ...prev, ...next } : { id, ...next },
    );

  // The sniffed type wins over the extension, which any commit spells freely;
  // it's per-side because the two revisions can hold different formats.
  const paneSrc = (side: FileBytes) =>
    side.base64 === null
      ? null
      : `data:${side.mime ?? imageMime(filePath) ?? "application/octet-stream"};base64,${side.base64}`;

  const panes: Pane[] = [];
  if (oldSide !== null) {
    panes.push({
      key: "old",
      label: newSide === null ? "Deleted" : "Old",
      src: paneSrc(oldSide),
    });
  }
  if (newSide !== null) {
    panes.push({
      key: "new",
      label: oldSide === null ? "Added" : "New",
      src: paneSrc(newSide),
    });
  }

  // A refused side has nothing to show fullscreen, so the viewer indexes only
  // the sides that rendered an image.
  const shown = panes.filter(
    (pane): pane is Pane & { src: string } => pane.src !== null,
  );
  const images: LightboxImage[] = shown.map((pane) => ({
    src: pane.src,
    alt: pane.label,
    label: pane.label,
    naturalWidth: current?.[pane.key]?.w,
    naturalHeight: current?.[pane.key]?.h,
  }));
  const viewing = current?.viewing ?? null;

  return (
    <div className="flex items-start justify-center gap-8 p-6">
      {panes.map((pane) =>
        pane.src === null ? (
          <RefusedSide key={`${id}|${pane.key}`} label={pane.label} />
        ) : (
          <ImageSide
            // Keyed by the pair as well as the slot: an `<img>` kept across a
            // file switch paints the previous file until the new src decodes.
            key={`${id}|${pane.key}`}
            label={pane.label}
            onMeasure={(size) => patch({ [pane.key]: size })}
            onOpen={() =>
              patch({ viewing: shown.findIndex((s) => s.key === pane.key) })
            }
            size={current?.[pane.key]}
            src={pane.src}
          />
        ),
      )}
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
    </div>
  );
}

/**
 * Old/new rendering for binary image files, replacing the "binary file"
 * placeholder wherever local revisions are available.
 */
export function ImageDiff({
  repoPath,
  filePath,
  revs,
}: {
  repoPath: string;
  filePath: string;
  revs: ImageRevs;
}) {
  return (
    // ph-no-capture: user image content + path — block from session replay.
    <div className="ph-no-capture flex h-full flex-col">
      <div className="border-b px-3 py-1.5">
        <p className="truncate font-mono text-xs text-muted-foreground">
          {filePath}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <ImagePanes repoPath={repoPath} filePath={filePath} revs={revs} />
      </div>
    </div>
  );
}
