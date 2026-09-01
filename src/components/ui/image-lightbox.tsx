import {
  ArrowSquareOutIcon,
  CaretLeftIcon,
  CaretRightIcon,
  type Icon,
  ImageBrokenIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
  XIcon,
} from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type KeyboardEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { clipTitleFromText } from "@/lib/clip-title";
import { toastError } from "@/lib/toast";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import { cn } from "@/lib/utils";

/** One image the viewer can show. */
export interface LightboxImage {
  /** Image URL or data: URI — whatever the inline <img> renders. */
  src: string;
  /** Accessible name + caption line; "" allowed. */
  alt: string;
  /** Caption context: a pane label ("Old"/"New") or a filename. */
  label?: string;
  /** Natural dimensions when the host already knows them. */
  naturalWidth?: number;
  naturalHeight?: number;
}

type ZoomMode = "fit" | "actual";

/** Each mode's control describes the mode it switches TO. */
const ZOOM_TOGGLE = {
  fit: {
    Glyph: MagnifyingGlassPlusIcon,
    text: "100%",
    label: "Zoom to 100%",
  },
  actual: {
    Glyph: MagnifyingGlassMinusIcon,
    text: "Fit",
    label: "Fit to window",
  },
} satisfies Record<ZoomMode, { Glyph: Icon; text: string; label: string }>;

const ARROW_STEP: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };

/** Case-insensitive and un-flagged, so `.test` stays stateless for callers. */
export const HTTP_SRC = /^https?:\/\//i;

// The field is dark in both themes, so its controls carry their own light-on-
// dark palette rather than the theme-following defaults of the ghost variant.
const FIELD_BUTTON =
  "shrink-0 text-white/85 hover:bg-white/15 hover:text-white focus-visible:border-white/80 focus-visible:ring-white/80 disabled:opacity-40";

/** The trailing path segment of an http(s) src, for images with no label. */
export function fileNameFromSrc(src: string): string {
  if (!HTTP_SRC.test(src)) return "";
  try {
    const { pathname } = new URL(src);
    return decodeURIComponent(pathname.slice(pathname.lastIndexOf("/") + 1));
  } catch {
    return "";
  }
}

/**
 * Fullscreen viewer for one or more images, with a fit/100% toggle and
 * (for a set) prev/next navigation. Hosts render it nested in their own React
 * tree — Base UI suppresses a parent dialog's Escape only for a nested one, so
 * a sibling-mounted instance would close the surface underneath it too.
 */
export function ImageLightbox({
  images,
  index,
  onIndexChange,
  open,
  onOpenChange,
}: {
  images: LightboxImage[];
  index: number;
  onIndexChange: (index: number) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Zoom, measured size, and load failure are all keyed by the shown image, so
  // moving to another one resets them during render instead of via an effect.
  const [zoomedKey, setZoomedKey] = useState<string | null>(null);
  const [measured, setMeasured] = useState<{
    key: string;
    w: number;
    h: number;
  } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);

  // Clearing the failure is what gives a reopen its retry: the <img> remounts
  // and fetches again, so a transient 401 or dropped connection isn't permanent.
  useSeedOnOpen(open, () => {
    setZoomedKey(null);
    setMeasured(null);
    setFailedKey(null);
  });

  const image = images[index];
  if (!image) return null;

  const key = `${index}:${image.src}`;
  const zoomed = zoomedKey === key;
  const failed = failedKey === key;
  const mode: ZoomMode = zoomed ? "actual" : "fit";
  const toggle = ZOOM_TOGGLE[mode];

  const loaded = measured?.key === key ? measured : null;
  const width = image.naturalWidth ?? loaded?.w;
  const height = image.naturalHeight ?? loaded?.h;
  const caption =
    image.label || image.alt || fileNameFromSrc(image.src) || "Image";
  const webUrl = HTTP_SRC.test(image.src) ? image.src : null;
  const hasNav = images.length > 1;

  async function openInBrowser() {
    if (webUrl === null) return;
    try {
      await openUrl(webUrl);
    } catch (e) {
      toastError(e);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // Fit mode only: at 100% the arrows belong to the scroll field, and a
    // mode-dependent rule beats one that changes meaning at the end-stops.
    if (!hasNav || zoomed) return;
    const step = ARROW_STEP[e.key];
    if (step === undefined) return;
    const next = index + step;
    if (next < 0 || next >= images.length) return;
    e.preventDefault();
    onIndexChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* ph-no-capture: user image content — block from session replay. */}
      <DialogContent
        className="ph-no-capture flex h-[92vh] w-[96vw] max-w-[96vw] flex-col gap-0 overflow-hidden bg-black/95 p-0 text-white ring-white/15 sm:max-w-[96vw]"
        overlayClassName="bg-black/70"
        onKeyDown={onKeyDown}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{caption}</DialogTitle>
        <div className="flex min-h-0 flex-1 overflow-auto">
          {failed ? (
            <div className="m-auto flex flex-col items-center gap-3 px-6 py-10 text-center">
              <ImageBrokenIcon
                aria-hidden="true"
                className="size-8 text-white/50"
              />
              <p className="text-xs text-white/85">Couldn't load this image.</p>
              {webUrl !== null && (
                <Button
                  className={FIELD_BUTTON}
                  onClick={openInBrowser}
                  size="sm"
                  variant="ghost"
                >
                  <ArrowSquareOutIcon />
                  Open in browser
                </Button>
              )}
            </div>
          ) : (
            <button
              aria-label={toggle.label}
              // `m-auto` centers without `justify-center`, which would make the
              // overflowing edges unreachable once the image is at 100%.
              className={cn(
                "m-auto outline-none focus-visible:ring-2 focus-visible:ring-white/80",
                zoomed ? "cursor-zoom-out" : "cursor-zoom-in",
              )}
              onClick={() => setZoomedKey(zoomed ? null : key)}
              type="button"
            >
              <img
                alt={image.alt}
                // A percentage cap can't cross the shrink-wrapped button, so the
                // fit size restates the dialog's own height minus the caption
                // strip (h-11 plus its border) — keep the three in sync.
                className={cn(
                  "block",
                  zoomed
                    ? "max-h-none max-w-none"
                    : "max-h-[calc(92vh-3rem)] max-w-[96vw]",
                )}
                key={key}
                onError={() => setFailedKey(key)}
                onLoad={(e) =>
                  setMeasured({
                    key,
                    w: e.currentTarget.naturalWidth,
                    h: e.currentTarget.naturalHeight,
                  })
                }
                src={image.src}
              />
            </button>
          )}
        </div>
        <div className="flex h-11 shrink-0 items-center gap-1 border-t border-white/15 bg-black px-2">
          <p
            className="min-w-0 flex-1 truncate text-xs text-white/85"
            onMouseEnter={clipTitleFromText}
          >
            {caption}
          </p>
          {!failed && width !== undefined && height !== undefined && (
            <p className="shrink-0 px-1 text-xs text-white/70 tabular-nums">
              {width} × {height}
            </p>
          )}
          {hasNav && (
            <>
              <Button
                aria-label="Previous image"
                className={FIELD_BUTTON}
                disabled={index === 0}
                onClick={() => onIndexChange(index - 1)}
                size="icon-sm"
                variant="ghost"
              >
                <CaretLeftIcon />
              </Button>
              <span className="shrink-0 px-0.5 text-xs text-white/85 tabular-nums">
                <span aria-hidden="true">
                  {index + 1} / {images.length}
                </span>
                <span className="sr-only">
                  Image {index + 1} of {images.length}
                </span>
              </span>
              <Button
                aria-label="Next image"
                className={FIELD_BUTTON}
                disabled={index === images.length - 1}
                onClick={() => onIndexChange(index + 1)}
                size="icon-sm"
                variant="ghost"
              >
                <CaretRightIcon />
              </Button>
            </>
          )}
          {!failed && (
            <Button
              aria-label={toggle.label}
              className={FIELD_BUTTON}
              onClick={() => setZoomedKey(zoomed ? null : key)}
              size="sm"
              variant="ghost"
            >
              <toggle.Glyph />
              {toggle.text}
            </Button>
          )}
          {webUrl !== null && (
            <Button
              className={FIELD_BUTTON}
              onClick={openInBrowser}
              size="sm"
              variant="ghost"
            >
              <ArrowSquareOutIcon />
              Open in browser
            </Button>
          )}
          <DialogClose
            render={
              <Button className={FIELD_BUTTON} size="icon-sm" variant="ghost" />
            }
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
