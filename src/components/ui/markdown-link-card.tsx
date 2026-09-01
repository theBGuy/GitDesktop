import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { linkPreviewOptions } from "@/lib/link-preview";
import { useFetchLinkPreviews } from "@/lib/settings/queries";

/** The two schemes the card can be opened for arrive already filtered by the
 *  body's dispatch; these tell them apart and gate the fetch. Case-insensitive
 *  to match that dispatch — a `HTTPS://` href reaches the DOM verbatim.
 *  Hoisted out of render: the patterns are constant. */
const HTTP_SCHEME = /^https?:/i;
const MAILTO_SCHEME = /^mailto:/i;
const WWW_PREFIX = /^www\./;

/** The only shape the og image may take: bytes the backend already fetched and
 *  inlined. Matched exactly (no case fold) against the pinned wire format, so a
 *  drifting shape can never put a fetchable URL — or a non-image payload — in
 *  an `src` the webview would resolve. */
const DATA_IMAGE = /^data:image\//;

/** Bidi controls, stripped from every string a page or its author supplies.
 *  U+202E and its siblings reorder rendered text, so a URL can read as one host
 *  while addressing another — in the one surface built for judging that. CSS
 *  `unicode-bidi` can't stand in: it sets the paragraph's own direction, while
 *  these characters keep reordering the text INSIDE it. */
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

function stripBidi(text: string): string {
  return text.replace(BIDI_CONTROLS, "");
}

/** The site a URL belongs to, or null when it isn't parseable as one. The URL
 *  parser hands back an IDN host already punycoded, so what lands here is
 *  ASCII. */
function displayHost(href: string): string | null {
  let host: string;
  try {
    host = new URL(href).hostname;
  } catch {
    return null;
  }
  if (!host) return null;
  // `www.` is dropped for reading only, and only when a host still remains —
  // stripping it from `www.com` would name a different site.
  const bare = host.replace(WWW_PREFIX, "");
  return bare.includes(".") ? bare : host;
}

/** The address a `mailto:` link writes to, without the scheme or a
 *  `?subject=`-style tail — those are the message, not the recipient. Decoding
 *  comes before the bidi strip, since a percent-escape can encode one. A link
 *  addressing nobody (`mailto:?subject=hi`) falls back to what was written,
 *  rather than showing an empty card. */
function mailAddress(href: string): string {
  const raw = href.replace(MAILTO_SCHEME, "").split("?")[0];
  if (!raw) return stripBidi(href);
  try {
    return stripBidi(decodeURIComponent(raw));
  } catch {
    return stripBidi(raw);
  }
}

/** The card's settled maximum, reserved up front: the og image box over four
 *  text lines — a `line-clamp-2` title above a `line-clamp-2` description — at
 *  the popup's own `text-xs/relaxed` line box. The card may SHRINK on settle
 *  (the bottom edge retracts, away from the anchor) but must never grow: Base
 *  UI re-runs collision avoidance as the popup resizes, and one that flips to
 *  the anchor's other side lands out from under the pointer and closes. */
function LinkCardSkeleton() {
  return (
    <div className="flex flex-col gap-1.5">
      <Skeleton className="aspect-[1.91/1] w-full" />
      <Skeleton className="h-[1.625em] w-full" />
      <Skeleton className="h-[1.625em] w-4/5" />
      <Skeleton className="h-[1.625em] w-full" />
      <Skeleton className="h-[1.625em] w-3/5" />
    </div>
  );
}

/**
 * What an external link opens, shown on hover or keyboard focus: the browser
 * status bar's answer (site and full URL) with no network at all, plus the
 * page's own Open Graph card once the backend fetches it.
 *
 * The URL-only form is the SETTLED state, not a loading one — a page with no og
 * data, a refused fetch, and the setting turned off all rest there, so nothing
 * below the URL ever reads as an error.
 */
export function MarkdownLinkCard({ href }: { href: string }) {
  const isHttp = HTTP_SCHEME.test(href);
  const previewsOn = useFetchLinkPreviews();
  const { data, isFetching } = useQuery({
    ...linkPreviewOptions(href),
    // A `mailto:` addresses no page, and the setting is the user's standing
    // answer about contacting the linked site — either way nothing is fetched.
    enabled: previewsOn && isHttp,
  });
  // The setting gates the RENDER too, not just the fetch: a preview cached
  // before it was turned off outlives it (staleTime Infinity), and painting one
  // would show content pulled from a site the user has since said not to
  // contact.
  const preview = previewsOn ? data : undefined;
  // Which image payload failed, rather than a bare flag: the card carries no
  // state to reset when a re-render swaps it to another link.
  const [failedImage, setFailedImage] = useState<string | null>(null);

  if (!isHttp) {
    return (
      <div className="ph-no-capture">
        <p className="break-all">{mailAddress(href)}</p>
      </div>
    );
  }

  const host = displayHost(href);
  const image = preview?.imageData;
  // Belt and braces over the backend's byte-sniff and dimension gate — see DATA_IMAGE.
  const showImage =
    image !== null &&
    image !== undefined &&
    DATA_IMAGE.test(image) &&
    image !== failedImage;

  return (
    // ph-no-capture: third-party page titles, descriptions, and imagery — keep
    // them out of session replay.
    <div className="ph-no-capture flex flex-col gap-1.5">
      {host ? <p className="truncate font-medium">{host}</p> : null}
      <p className="line-clamp-3 break-all text-muted-foreground">
        {stripBidi(href)}
      </p>
      {isFetching && preview === undefined ? <LinkCardSkeleton /> : null}
      {showImage ? (
        <img
          src={image}
          alt=""
          className="aspect-[1.91/1] w-full object-cover"
          // A corrupt payload still fails to decode; hiding the block keeps a
          // broken-image glyph out of a card the user only hovered.
          onError={() => setFailedImage(image)}
        />
      ) : null}
      {preview?.title ? (
        <p className="line-clamp-2 font-medium">{stripBidi(preview.title)}</p>
      ) : null}
      {preview?.description ? (
        <p className="line-clamp-2 text-muted-foreground">
          {stripBidi(preview.description)}
        </p>
      ) : null}
    </div>
  );
}
