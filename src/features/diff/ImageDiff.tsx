import { useState } from "react";
import {
  ImageLightbox,
  type LightboxImage,
} from "@/components/ui/image-lightbox";
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
  src: string;
}

function ImageSide({
  label,
  src,
  onOpen,
  onMeasure,
}: {
  label: string;
  src: string;
  onOpen: () => void;
  onMeasure: (size: Size) => void;
}) {
  const [size, setSize] = useState<Size | null>(null);
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
            onLoad={(e) => {
              const next = {
                w: e.currentTarget.naturalWidth,
                h: e.currentTarget.naturalHeight,
              };
              setSize(next);
              onMeasure(next);
            }}
            src={src}
          />
        </button>
      </div>
      {size && (
        <p className="text-[11px] text-muted-foreground tabular-nums">
          {size.w} × {size.h}
        </p>
      )}
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
  const mime = imageMime(filePath) ?? "application/octet-stream";
  const oldFile = useFileAtRev(repoPath, revs.old, filePath, true);
  const newFile = useFileAtRev(repoPath, revs.new, filePath, true);
  // Keyed by the pair being shown, so a switch to another file drops the
  // previous one's measurements and viewer index during render.
  const [state, setState] = useState<PanesState>({ id: "" });

  const pending = oldFile.isPending || newFile.isPending;
  const oldB64 = oldFile.data ?? null;
  const newB64 = newFile.data ?? null;

  if (pending) {
    return null;
  }

  const id = [filePath, revs.old, revs.new].join("|");
  const current = state.id === id ? state : null;
  const patch = (next: Partial<PanesState>) =>
    setState((prev) =>
      prev.id === id ? { ...prev, ...next } : { id, ...next },
    );

  const panes: Pane[] = [];
  if (oldB64 !== null) {
    panes.push({
      key: "old",
      label: newB64 === null ? "Deleted" : "Old",
      src: `data:${mime};base64,${oldB64}`,
    });
  }
  if (newB64 !== null) {
    panes.push({
      key: "new",
      label: oldB64 === null ? "Added" : "New",
      src: `data:${mime};base64,${newB64}`,
    });
  }

  const images: LightboxImage[] = panes.map((pane) => ({
    src: pane.src,
    alt: pane.label,
    label: pane.label,
    naturalWidth: current?.[pane.key]?.w,
    naturalHeight: current?.[pane.key]?.h,
  }));
  const viewing = current?.viewing ?? null;

  return (
    <div className="flex items-start justify-center gap-8 p-6">
      {panes.map((pane, i) => (
        <ImageSide
          // Keyed by the pair as well as the slot: a side that kept its element
          // across a file switch would caption the new image with the previous
          // one's dimensions until the new one decodes.
          key={`${id}|${pane.key}`}
          label={pane.label}
          onMeasure={(size) => patch({ [pane.key]: size })}
          onOpen={() => patch({ viewing: i })}
          src={pane.src}
        />
      ))}
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
