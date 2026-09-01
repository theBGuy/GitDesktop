import { queryOptions } from "@tanstack/react-query";
import { invoke } from "@/lib/tauri/invoke";

/**
 * The Open Graph fields the backend read off a linked page. Each is
 * independently absent: all three null is a SETTLED answer (the page carries no
 * og data), not a failure, and the card renders its URL-only form for it.
 */
export type LinkPreview = {
  title: string | null;
  description: string | null;
  /** The og image as a complete `data:image/<subtype>;base64,…` URI — bytes the
   *  backend already fetched through its own per-hop-validated client, never a
   *  URL for the webview to resolve. An `<img src>` follows redirects with no
   *  host re-validation, so a public image host could 302 into the user's LAN
   *  and reduce the backend's URL vetting to decoration. */
  imageData: string | null;
};

/** Reads a page's Open Graph card. Rejects on a refused or unreachable URL —
 *  the backend validates the scheme and refuses private hosts, so a rejection
 *  is a verdict about this URL rather than a transient miss. */
export function fetchLinkPreview(url: string): Promise<LinkPreview> {
  return invoke<LinkPreview>("fetch_link_preview", { url });
}

/**
 * An entry carries the og image's BYTES, not a URL, so `gcTime` is this cache's
 * memory bound rather than a convenience knob, and is deliberately short: five
 * minutes covers re-hovering a link while reading around it, and caps retention
 * at minutes of hovering rather than half an hour of it. `staleTime` stays
 * infinite — while an entry is cached it is settled, and a re-hover repaints
 * with no request at all.
 *
 * A FAILED one needs the two mount options as much as `retry`: the card
 * remounts on every hover, and `staleTime` doesn't cover an error, so without
 * them each re-hover re-invokes the command and can pay the full timeout again
 * for an answer the backend already gave (a private host it refuses by design).
 * That memory expires with the entry: a refusal is re-earned once per `gcTime`,
 * which is the price of bounding what the cache holds.
 */
export const linkPreviewOptions = (url: string) =>
  queryOptions({
    queryKey: ["link-preview", url] as const,
    queryFn: () => fetchLinkPreview(url),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
    retry: false,
    retryOnMount: false,
    refetchOnWindowFocus: false,
  });
