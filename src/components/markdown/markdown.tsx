import { useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import DOMPurify from "dompurify";
// Static `lib/common` (~37 languages) so the common fences highlight instantly
// with no flicker. Rarer tags trigger a one-time lazy load of the full ~192-lang
// build (see markdown-hljs.ts), which registers into this same core singleton.
import hljs from "highlight.js/lib/common";
import { Marked } from "marked";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import {
  fileNameFromSrc,
  ImageLightbox,
  type LightboxImage,
} from "@/components/ui/image-lightbox";
import { diffLang } from "@/features/diff/diff-lang";
import { forgeRepoUrl } from "@/lib/git/api";
import { issueDetailsOptions } from "@/lib/git/queries";
import type { ForgeProvider, RemoteLens } from "@/lib/git/types";
import { createCardLatch } from "@/lib/hover-card-latch";
import {
  CARD_CLOSE_DELAY,
  CARD_OPEN_DELAY,
  cancelFrame,
  cancelTimer,
} from "@/lib/hover-card-timing";
import { lensKey } from "@/lib/repo-lens/queries";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { useRetained } from "@/lib/use-retained";
import { cn } from "@/lib/utils";
import { hljsUpgradeStore, upgradeToFullHljs } from "./markdown-hljs";
import {
  cachedRefKind,
  isPullRefUrl,
  type MarkdownForgeTarget,
  type MarkdownLinkTarget,
  MarkdownRefCard,
  type MarkdownRefTarget,
} from "./markdown-ref-card";
import {
  forgeRefExtension,
  isEmittableRefKind,
  isValidRefNum,
  isValidRefUser,
  type MarkdownRefs,
  setActiveMarkdownRefs,
} from "./markdown-refs";
import "./markdown-highlight.css";

/**
 * Resolve a fenced code block's info string to a highlight.js language id, or
 * null to render it as plain text. highlight.js resolves its own aliases
 * (`js`, `ts`, `py`, `sh`, `yml`…); if that misses, we treat the tag as a file
 * extension and reuse the diff's extension→language map (so `rs` → rust etc.).
 *
 * A miss can mean the language lives only in the full highlight.js build (not the
 * static `lib/common` set), so we kick off the one-time lazy upgrade; once it
 * lands, subscribed Markdown components re-parse and the fence highlights.
 */
function resolveCodeLang(info: string | undefined): string | null {
  if (!info) return null;
  const tag = info.trim().toLowerCase().split(/\s+/)[0];
  if (!tag) return null;
  if (hljs.getLanguage(tag)) return tag;
  const mapped = diffLang(`f.${tag}`);
  if (mapped && hljs.getLanguage(mapped)) return mapped;
  // Unknown to the currently-loaded set: the full build may know it — load it
  // once. If it's unknown even to the full build, the fence stays plain (the
  // renderer's guard never highlights an unresolved tag, so it can't throw).
  upgradeToFullHljs();
  return null;
}

/**
 * A marked instance whose code renderer syntax-highlights fenced blocks with
 * highlight.js: the ~37 common languages highlight instantly from the static
 * `lib/common` import, and the first fence naming a rarer language lazy-loads the
 * full ~192-language build (keeping its ~2MB off the startup bundle) and
 * re-highlights once it arrives. Tokens are emitted as `hljs-*`-classed spans,
 * colored by the GitHub palette in `markdown-highlight.css` (scoped to
 * `.markdown-body`). Untagged or still-unknown languages return `false` so marked
 * falls back to its default escaped block.
 */
const md = new Marked({ gfm: true });
md.use({
  renderer: {
    code({ text, lang }) {
      const language = resolveCodeLang(lang);
      if (!language) return false;
      const { value } = hljs.highlight(text, {
        language,
        ignoreIllegals: true,
      });
      return `<pre><code class="hljs language-${language}">${value}</code></pre>`;
    },
  },
});
// Forge references (`#N` / `!N` / `@user`) are GitHub-style post-processing, not
// GFM, so they only linkify through this extension — and only while a body's
// active context names a provider (see markdown-refs.ts).
md.use({ extensions: [forgeRefExtension] });

/** The card's own subtree, for telling "the pointer left the anchor" apart from
 *  "the pointer moved into the card" — which the DOM reports identically, the
 *  popup being portaled out of the body. Both slots: `hover-card.tsx` stamps the
 *  popup, and the portal wrapper covers the positioner between them. */
const CARD_POPUP_SELECTOR =
  '[data-slot="hover-card-content"],[data-slot="hover-card-portal"]';

/** The schemes a rendered link opens directly in the system browser.
 *  Case-insensitive because schemes are: marked emits `HTTPS://…` verbatim and
 *  DOMPurify's own allowlist keeps it, so a case-sensitive test would drop the
 *  href through to the any-scheme rule below and leave a perfectly good link
 *  inert, with no card on the deceptive-looking URLs this most needs to expose. */
const EXTERNAL_HREF = /^(https?:|mailto:)/i;

/** Where each forge serves a file from the repo's default branch, appended to
 *  the repo's own web URL. A body's href resolves against this base, so `./`,
 *  `../`, and percent-escapes are the URL parser's job rather than ours. */
const BLOB_PATH: Record<ForgeProvider, string> = {
  github: "blob/HEAD/",
  gitlab: "-/blob/HEAD/",
  bitbucket: "src/HEAD/",
};

/** The repo URL's own trailing slash, dropped before the blob path is appended:
 *  a doubled slash mid-path is a segment the forge doesn't serve. */
const TRAILING_SLASH = /\/+$/;

/** Any scheme at all, in RFC 3986's shape. DOMPurify's default allowlist admits
 *  far more than the two above (`tel:`, `ftp:`, `sms:`, `cid:`, `xmpp:` …), and
 *  a scheme-bearing href is not a repository path, so it never becomes one. */
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Two leading slashes, in either slash. `new URL` reads both `//host/x` and
 *  `\\host\x` against an https base as an AUTHORITY, resolving to that host — so
 *  an href in either shape would otherwise wear a repo-file card naming the
 *  forge while opening somewhere else entirely. Backslashes reach the DOM only
 *  through a body's raw HTML; marked percent-encodes them in its own syntax. */
const AUTHORITY_PREFIX = /^[\\/]{2}/;

/** Tab, LF, and CR — the URL parser removes these from ANYWHERE in an href. */
const URL_REMOVED = /[\t\n\r]/g;

/** The single leading separator of a root-relative href, dropped so it resolves
 *  against the repository root rather than the forge's site root. */
const LEADING_SEPARATOR = /^[\\/]/;

/** An href as the URL parser will read it: those three gone, then the
 *  leading/trailing C0-and-space run stripped (`String.trim` misses C0).
 *  DOMPurify only edge-trims attribute values, so both shapes reach the DOM, and
 *  judging the raw text would judge a different string than the one that
 *  resolves: `/<tab>/evil.com` reads as a path and resolves to an authority.
 *  The edge walk is by code point; a control-character regex class fails lint. */
function normalizeHref(raw: string): string {
  const s = raw.replace(URL_REMOVED, "");
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 0x20) start++;
  while (end > start && s.charCodeAt(end - 1) <= 0x20) end--;
  return s.slice(start, end);
}

/** A body's handle on its own card — every field stable for the body's life, so
 *  the object doubles as that body's identity in the latch below. */
interface CardOwner {
  timer: React.RefObject<ReturnType<typeof setTimeout> | null>;
  frame: React.RefObject<number | null>;
  pointerAnchor: React.RefObject<HTMLAnchorElement | null>;
  setTarget: (target: MarkdownRefTarget | null) => void;
}

/** Everything that can open or hold one body's card, torn down together. The
 *  pointer claim goes with it: a card closed from outside its own routes fires
 *  no `pointerout`, and a claim left set would block that body's next keyboard
 *  card from closing on blur. */
function resetCard(owner: CardOwner) {
  cancelTimer(owner.timer);
  cancelFrame(owner.frame);
  owner.pointerAnchor.current = null;
  owner.setTarget(null);
  releaseCard(owner);
}

/** This family is every rendered Markdown body, so the two cards it keeps apart
 *  are typically a conversation's description and one of its comments. */
const { claim: claimCard, release: releaseCard } =
  createCardLatch<CardOwner>(resetCard);

/** THE rulebook for what a non-reference anchor opens: the click dispatch and
 *  the preview card read this one verdict, so the set that opens and the set
 *  that previews are the same set by construction. Null means "opens nothing" —
 *  the dispatch still claims the click, and no card is offered. Judged on the
 *  normalized RAW attribute rather than the resolved `anchor.href`, so the card
 *  names exactly what the click will act on. */
function linkTarget(
  anchor: HTMLAnchorElement,
  hasRefs: boolean,
): MarkdownLinkTarget | null {
  const raw = anchor.getAttribute("href");
  // No href attribute is the ONE not-a-link case — every other shape gets a
  // card explaining why it won't open, even though the click stays inert.
  if (raw === null) return null;
  const href = normalizeHref(raw);
  if (href === "") return { kind: "inert", variant: "empty", href };
  if (EXTERNAL_HREF.test(href)) return { kind: "external", href };
  // A fragment addresses nothing: marked emits no heading ids.
  if (href.startsWith("#")) return { kind: "inert", variant: "fragment", href };
  if (ANY_SCHEME.test(href)) return { kind: "inert", variant: "scheme", href };
  if (AUTHORITY_PREFIX.test(href))
    return { kind: "inert", variant: "external", href };
  if (!hasRefs) return { kind: "inert", variant: "repoNoForge", href };
  return { kind: "repoFile", href };
}

/** Natural-size floor, both axes, for an image the viewer will open: it clears
 *  shields-style badges (~120×20) and emoji (~20×20) while any screenshot passes.
 *  One knob — widen or narrow it here. */
const LIGHTBOX_MIN_PX = 48;

/** Whether an embedded image is worth opening fullscreen. A linked image belongs
 *  to its link whatever the href — badges are near-universally wrapped in one —
 *  one in a `<summary>` belongs to the disclosure, whose toggle the viewer's own
 *  `preventDefault` would swallow, one inside a collapsed `<details>` isn't on
 *  screen to be opened or navigated past, and an image that hasn't loaded (or
 *  failed) reports 0 for both axes, which the floor rejects on its own. */
function isLightboxImage(img: HTMLImageElement): boolean {
  if (
    img.closest("a") ||
    img.closest("summary") ||
    img.closest("details:not([open])")
  )
    return false;
  return (
    img.naturalWidth >= LIGHTBOX_MIN_PX && img.naturalHeight >= LIGHTBOX_MIN_PX
  );
}

/** Every qualifying image in a body, in document order — the set the viewer's
 *  prev/next walks, whichever one was clicked. */
function lightboxImagesIn(root: Element): HTMLImageElement[] {
  return Array.from(root.querySelectorAll("img")).filter(isLightboxImage);
}

/** Make a loaded, qualifying image reachable without a pointer. Non-qualifying
 *  images are left exactly as the body wrote them. The zoom cursor and focus
 *  ring hang off `data-lightbox` rather than class tokens added here — the
 *  wrapper's own `[&_img[data-lightbox]]:` rules then carry them, in the same
 *  cascade layer and at a higher specificity than its `[&_img]:` block. */
function markLightboxImage(img: HTMLImageElement) {
  if (!isLightboxImage(img)) return;
  // The viewer's own caption fallback, so the two name an image identically.
  // It carries its own http(s) guard, so a data: URI resolves to "" here.
  const name = img.alt || fileNameFromSrc(img.src);
  img.tabIndex = 0;
  img.setAttribute("role", "button");
  img.setAttribute("aria-label", name ? `View image: ${name}` : "View image");
  img.dataset.lightbox = "";
}

function toLightboxImage(img: HTMLImageElement): LightboxImage {
  // `label` stays unset so the viewer falls back to alt, then the filename.
  return {
    src: img.src,
    alt: img.alt,
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
  };
}

/** Stable empty set for a viewer that has never been opened. */
const NO_IMAGES: LightboxImage[] = [];

/**
 * Renders GitHub-flavored Markdown (PR descriptions, comments, AI output).
 *
 * GitHub comments routinely embed raw HTML — Dependabot and netlify use
 * <details>/<summary>, tables, and <img> badges — so we render through marked
 * (markdown → HTML) and sanitize with DOMPurify before injecting. Fenced code
 * blocks are syntax-highlighted with highlight.js (see `md` above).
 *
 * No link navigates the webview: web and mail links open in the system browser,
 * a repository-relative one opens the file on the forge, and an href this body
 * can't place is inert.
 */
export function Markdown({
  children,
  className,
  refs,
}: {
  children: string;
  className?: string;
  /** Forge context that linkifies `#N` / `!N` / `@user` and routes a click on
   *  one in-app. Omitted (or before forge status resolves) the body renders
   *  exactly as it did without the extension. */
  refs?: MarkdownRefs;
}) {
  const queryClient = useQueryClient();
  // Whether this body has forge context, as a primitive: every consumer of the
  // classifier reads THIS rather than re-testing `refs`, so the card, the click,
  // and the cursor walk can't disagree about it — and the walk effect gets a
  // dependency that changes when context arrives. Truthiness, matching the
  // `!refs` guards elsewhere in the file rather than an `undefined` test.
  const hasRefs = !!refs;
  // Cold list caches are the norm on local surfaces, so the resolve fetch can be
  // the only gap between click and navigation. The fetch is cache-first, so the
  // cursor plus aria-busy is the whole affordance: a spinner or a toast would be
  // louder than this warrants.
  const [resolving, setResolving] = useState(false);
  // Subscribe to the highlight.js upgrade: when a fence's exotic language pulls
  // in the full build, this snapshot changes, re-parsing so the previously-plain
  // fence highlights. (Module state read during render is invisible to the React
  // Compiler — the store subscription is the sanctioned reactive path.)
  const hljsVersion = useSyncExternalStore(
    hljsUpgradeStore.subscribe,
    hljsUpgradeStore.getSnapshot,
    hljsUpgradeStore.getServerSnapshot,
  );
  // hljsVersion is a deliberate rebuild trigger: marked reads the now-upgraded
  // hljs during parse via module state, not a value passed in, so bumping it is
  // what forces the re-parse that highlights the previously-plain fence.
  // The ref deps are the three primitives rather than `refs` itself, so a caller
  // rebuilding the object each render can't re-parse every body.
  // biome-ignore lint/correctness/useExhaustiveDependencies: hljsVersion is an intentional rebuild trigger, and `refs` is deliberately tracked by its primitives
  const html = useMemo(() => {
    setActiveMarkdownRefs(refs ?? null);
    try {
      const raw = md.parse(children, { async: false }) as string;
      // A form submit and an image-map area click are both top-level
      // navigation with no anchor for the dispatch below to claim, and the
      // webview ships no CSP to fall back on — so the tags that carry them
      // don't survive sanitization at all.
      return DOMPurify.sanitize(raw, { FORBID_TAGS: ["form", "area", "map"] });
    } finally {
      setActiveMarkdownRefs(null);
    }
  }, [children, hljsVersion, refs?.provider, refs?.repoPath, refs?.lens]);
  // React 19 diffs `dangerouslySetInnerHTML` by the WRAPPER OBJECT's identity,
  // not the string inside (probed live: commitUpdate re-set an equal-content
  // innerHTML on every re-render, replacing every injected node — which
  // detached the hovercard's anchor and cycled it closed). One object per parse
  // keeps the body's DOM stable across unrelated state changes.
  const htmlProp = useMemo(() => ({ __html: html }), [html]);

  // The preview card's own state, deliberately apart from the click path's
  // `resolving`: hovering a reference must never flip the body's cursors — the
  // card's skeleton is the whole busy affordance for a hover.
  const [cardTarget, setCardTarget] = useState<MarkdownRefTarget | null>(null);
  // Which anchor the card belongs to: the pointer routes compare against it, and
  // the `aria-describedby` effect writes to it. Never the card's geometry —
  // reopening on the SAME element is a state no-op, so a rect derived from it
  // would survive a scroll the reference has already moved under.
  const [cardAnchor, setCardAnchor] = useState<HTMLAnchorElement | null>(null);
  // Measured at each open instead (a fresh DOMRect every time, so the positioner
  // always re-resolves), and kept through the close so the exit animation plays
  // where the card was. The focus route measures a frame late — see the pending
  // frame below — because Tab scrolls its target into view after firing focus.
  const [cardRect, setCardRect] = useState<DOMRect | null>(null);
  const cardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The focus route's pending open, held so a blur or a re-parse can cancel it
  // rather than measuring an anchor that is gone or no longer where it was.
  const cardFrame = useRef<number | null>(null);
  // WHICH reference the pointer claims: the anchor it rests on, or the open
  // card's own anchor while it rests inside the popup. Null is no claim. The
  // blur path must not close a card the mouse owns, and only the anchor's
  // identity can tell that apart from a claim on some unrelated reference.
  const cardPointerAnchor = useRef<HTMLAnchorElement | null>(null);
  // Built once: the latch compares bodies by this object's identity, so it has
  // to outlive every render.
  const [card] = useState<CardOwner>(() => ({
    timer: cardTimer,
    frame: cardFrame,
    pointerAnchor: cardPointerAnchor,
    setTarget: setCardTarget,
  }));
  const cardId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  // Null is closed. The viewer copies src strings rather than nodes, so this
  // holds nothing a re-parse could detach; retaining the last set keeps the
  // close fade from playing over an empty field.
  const [lightbox, setLightbox] = useState<{
    images: LightboxImage[];
    index: number;
  } | null>(null);
  const shownLightbox = useRetained(lightbox);

  // A re-parse replaces every injected anchor (a fence's lazy highlight.js
  // upgrade re-runs it), so an open card would track a detached node, and a
  // viewer opened from the old body no longer describes what's on screen.
  // The anchor and its rect deliberately survive: clearing the rect here would
  // drop the closing card to the origin mid-fade, and the next `showCard`
  // overwrites both anyway.
  // `html` is the trigger, not a value this reads — same shape as the parse memo.
  // biome-ignore lint/correctness/useExhaustiveDependencies: html is the intentional reset trigger
  useEffect(() => {
    closeCardNow();
    setLightbox(null);
    // Unmount (or another re-parse) must drop the claim too: a body that still
    // held it would tear down whichever card claims it next.
    return () => {
      cancelTimer(cardTimer);
      cancelFrame(cardFrame);
      releaseCard(card);
    };
  }, [html]);

  // The card is pinned to the rect its anchor had when it opened, so anything
  // that moves the reference strands it: the hover routes end at the pointer
  // leaving, but a focused one would sit at stale coordinates while its
  // reference scrolls away. Capture-phase, since a pane's scroll doesn't bubble.
  // The listeners go on a frame late even though the focus route already opens a
  // frame late: Tab's scroll-into-view can land in that same frame, and closing
  // on the very scroll the rect was measured after would shut the card on
  // arrival.
  useEffect(() => {
    if (cardTarget === null) return;
    let subscribed = false;
    const close = () => {
      cancelTimer(cardTimer);
      // The claim describes the card that just closed; a lingering one would
      // block the blur path from closing the NEXT card (pointerover re-arms it).
      cardPointerAnchor.current = null;
      setCardTarget(null);
      // Released explicitly rather than through `resetCard`, which would also
      // cancel a pending focus-open — one measuring AFTER this scroll, so it
      // opens at a rect that is still good.
      releaseCard(card);
    };
    const raf = requestAnimationFrame(() => {
      subscribed = true;
      window.addEventListener("scroll", close, true);
      window.addEventListener("resize", close);
    });
    return () => {
      cancelAnimationFrame(raf);
      if (!subscribed) return;
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [cardTarget, card]);

  // The open card describes its anchor. Set on the node rather than rendered:
  // the anchor is injected HTML, same as the image affordances below. The
  // cleanup covers both a close and a swap to another anchor.
  useEffect(() => {
    if (!cardAnchor || !cardTarget) return;
    cardAnchor.setAttribute("aria-describedby", cardId);
    return () => cardAnchor.removeAttribute("aria-describedby");
  }, [cardAnchor, cardTarget, cardId]);

  // Qualifying images become focus targets in place. Natural size is only known
  // once an image has loaded, so every image gets a `load` listener AND an
  // immediate attempt: the two orders (already decoded, or decoding past this
  // commit) both have to land, and marking is idempotent, so the overlap is
  // free. The listeners come off with the body that owns them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: html is the intentional re-walk trigger
  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    const offs: (() => void)[] = [];
    // A link that won't open shows the help cursor (its card IS how you learn
    // why), so it can't read as a normal pointer link. Keyed on `anyTarget`, not
    // `linkTarget`: a rendered `#123`/`@user` carries `href="#"`, which the
    // classifier alone reads as a fragment — the reference arm has to win here
    // exactly as it does for the card and the click.
    // Marking is two-directional because forge context arrives async: a body
    // with no reference syntax re-parses to an IDENTICAL html string, so these
    // same nodes persist and a mark set while `hasRefs` was false must come off.
    for (const a of root.querySelectorAll("a")) {
      if (anyTarget(a)?.kind === "inert") a.dataset.inertLink = "";
      else delete a.dataset.inertLink;
    }
    for (const img of root.querySelectorAll("img")) {
      const onLoad = () => markLightboxImage(img);
      img.addEventListener("load", onLoad);
      offs.push(() => img.removeEventListener("load", onLoad));
      markLightboxImage(img);
    }
    // Expanding a `<details>` qualifies the images inside it, which nothing else
    // re-evaluates — a click would open one the keyboard could never reach.
    // `toggle` doesn't bubble, so the root only sees it in capture.
    const onToggle = () => {
      for (const img of root.querySelectorAll("img")) markLightboxImage(img);
    };
    root.addEventListener("toggle", onToggle, true);
    offs.push(() => root.removeEventListener("toggle", onToggle, true));
    return () => {
      for (const off of offs) off();
    };
  }, [html, hasRefs]);

  /** Open the viewer on `img`, with every other qualifying image in the body
   *  behind its prev/next. Any hover intent in flight is dropped: a card opening
   *  over the viewer would be positioned against a body the user can't see. */
  function openLightbox(img: HTMLImageElement) {
    const root = bodyRef.current;
    if (!root) return;
    const imgs = lightboxImagesIn(root);
    const index = imgs.indexOf(img);
    if (index < 0) return;
    closeCardNow();
    setLightbox({ images: imgs.map(toLightboxImage), index });
  }

  /** Drop the card and every intent behind it — the open one, a pending hover
   *  timer, and a pending focus frame. Every path that takes the user somewhere
   *  else ends here: both anchor branches of the click dispatch, and the
   *  lightbox, which would otherwise position a card against a hidden body. */
  function closeCardNow() {
    resetCard(card);
  }

  /** The one open route — both the hover timer and the focus frame land here, so
   *  claiming the latch here is what makes the card exclusive across bodies.
   *  Re-opening this body's own card is not a takeover: `claimCard` tears down
   *  the previous holder only when it is a different one. */
  function showCard(anchor: HTMLAnchorElement, target: MarkdownRefTarget) {
    claimCard(card);
    cancelTimer(cardTimer);
    setCardAnchor(anchor);
    setCardRect(anchor.getBoundingClientRect());
    setCardTarget(target);
  }

  /** The grace period before an open card goes: re-entering either the anchor or
   *  the popup cancels it. */
  function scheduleCardClose() {
    cancelTimer(cardTimer);
    cardTimer.current = setTimeout(() => {
      cardTimer.current = null;
      cardPointerAnchor.current = null;
      setCardTarget(null);
      releaseCard(card);
    }, CARD_CLOSE_DELAY);
  }

  function onPointerOver(e: React.PointerEvent) {
    const anchor = (e.target as HTMLElement).closest("a");
    const target = anchor && anyTarget(anchor);
    if (!anchor || !target) return;
    cardPointerAnchor.current = anchor;
    // Cancels the close armed on the way out — of the anchor itself, or of the
    // popup the pointer is coming back from.
    cancelTimer(cardTimer);
    // Re-entering the anchor a card already tracks is the whole job; reopening
    // would only restart its resolve.
    if (cardTarget && anchor === cardAnchor) return;
    // A card belonging to some OTHER anchor describes a reference the pointer
    // has already left, and it sits at that anchor — so it goes now rather than
    // lingering misplaced for the length of this one's open delay.
    if (cardTarget) setCardTarget(null);
    cardTimer.current = setTimeout(() => {
      cardTimer.current = null;
      showCard(anchor, target);
    }, CARD_OPEN_DELAY);
  }

  function onPointerOut(e: React.PointerEvent) {
    const anchor = (e.target as HTMLElement).closest("a");
    if (!anchor || !anyTarget(anchor)) return;
    // Crossing into the card is not leaving it. The popup portals outside this
    // wrapper, so the browser reports the move as a plain pointerout on the
    // anchor; treating that as a close would arm a timer the popup's own enter
    // has to race, and losing that race reopens from the anchor and cycles.
    if ((e.relatedTarget as Element | null)?.closest?.(CARD_POPUP_SELECTOR))
      return;
    // The pointer has left a reference for something that isn't the popup, so it
    // holds no claim on any card — including one it never opened, a sweep across
    // a reference too brief to beat the open delay.
    cardPointerAnchor.current = null;
    cancelTimer(cardTimer);
    // Only the anchor the card belongs to may close it. A card opened by
    // keyboard on another reference is not this pointer's to close — doing so
    // would leave it with no way back, the keyboard route reopening only on a
    // fresh focus.
    if (cardTarget && anchor === cardAnchor) scheduleCardClose();
  }

  function onFocusCapture(e: React.FocusEvent) {
    const anchor = (e.target as HTMLElement).closest("a");
    const target = anchor && anyTarget(anchor);
    if (!anchor || !target) return;
    // Keyboard arrival only. Landing on a reference by Tab is already the
    // deliberate ask the hover delay waits for, but a click focuses the anchor
    // too — and popping a card under the pointer there reads as a misfire,
    // worst on `@user`, where the browser takes over and the view never changes.
    if (!anchor.matches(":focus-visible")) return;
    // A frame late, so the rect is measured after the browser has scrolled this
    // anchor into view — Tab fires focus first and scrolls during the update
    // that follows, and scroll steps run before animation-frame callbacks.
    // Harmless on an engine that scrolls first, and on an anchor already in view.
    cancelFrame(cardFrame);
    cardFrame.current = requestAnimationFrame(() => {
      cardFrame.current = null;
      showCard(anchor, target);
    });
  }

  function onBlurCapture(e: React.FocusEvent) {
    const anchor = (e.target as HTMLElement).closest("a");
    if (!anchor || !anyTarget(anchor)) return;
    // A pending focus-open belongs to the anchor being blurred, so it dies here
    // whatever the pointer is doing — otherwise it would open a card for a
    // reference the keyboard has already left.
    cancelFrame(cardFrame);
    // The keyboard's claim on the card ends here — card content is
    // non-interactive, so focus cannot have moved into it. What survives is a
    // pointer claim on THIS card: the pointer resting on the card's own anchor,
    // or inside the popup (which claims that same anchor). A claim on some other
    // reference is not a reason to keep this card, which is how a keyboard card
    // on B closes while the mouse sits on A.
    const claim = cardPointerAnchor.current;
    if (claim !== null && claim === cardAnchor) return;
    cancelTimer(cardTimer);
    setCardTarget(null);
    // Released explicitly, not via `resetCard`: a pointer claim on some OTHER
    // reference has to survive this close (that is what lets a keyboard card on
    // B close while the mouse rests on A).
    releaseCard(card);
  }

  /**
   * The reference this anchor addresses, or null when it isn't one this body can
   * act on. Body-authored raw HTML reaches the DOM with its `data-*` intact
   * (DOMPurify keeps them by design), so the kind is checked against THIS forge's
   * row and every value against the grammar the renderer emits. Synchronous
   * because the click handler decides whether to claim the event on its answer.
   */
  function refTarget(anchor: HTMLAnchorElement): MarkdownForgeTarget | null {
    if (!refs) return null;
    const kind = anchor.dataset.ref;
    if (!isEmittableRefKind(refs.provider, kind)) return null;
    if (kind === "user") {
      const user = anchor.dataset.refUser;
      return isValidRefUser(user) ? ({ kind, user } as const) : null;
    }
    const refNum = anchor.dataset.refNum;
    return isValidRefNum(refNum)
      ? ({ kind, number: Number(refNum) } as const)
      : null;
  }

  /** Whatever this anchor opens a preview card for. A forge reference wins over
   *  the link it also is — a rendered `#12` carries an href too, and its card
   *  describes the item, not the URL. Every hover and focus route reads this
   *  one answer, so the card opens on the same set of anchors either way. */
  function anyTarget(anchor: HTMLAnchorElement): MarkdownRefTarget | null {
    return refTarget(anchor) ?? linkTarget(anchor, hasRefs);
  }

  /** Navigate to whatever a validated reference target points at. */
  async function openRef(target: MarkdownForgeTarget) {
    if (!refs) return;
    const { repoPath, lens } = refs;
    const { kind } = target;
    if (kind === "user") {
      const { user } = target;
      setResolving(true);
      try {
        // Origin off the repo's server-truth web URL, so GitHub Enterprise and a
        // self-managed GitLab at a host root need no host table. An instance
        // served under a path prefix loses that prefix here.
        const origin = new URL(await forgeRepoUrl(repoPath)).origin;
        await openUrl(`${origin}/${encodeURIComponent(user)}`);
      } catch (e) {
        toastError(e);
      } finally {
        setResolving(false);
      }
      return;
    }
    const { number } = target;
    // Fire-time reads of stable store actions: subscribing would put three
    // listeners on every rendered body, most of which never carry a reference.
    const { selectPr, selectIssue, setRepoTab } = useUiStore.getState();
    const openPr = () => {
      selectPr({ kind: "remote", id: String(number) });
      setRepoTab("pulls");
    };
    const openIssue = () => {
      selectIssue({ kind: "remote", id: String(number) });
      setRepoTab("issues");
    };
    // GitLab's two kinds skip the lens check below: the origin/upstream lens is
    // GitHub-fork-only, so a mismatch can't arise here.
    if (kind === "mr") {
      openPr();
      return;
    }
    if (kind === "issue") {
      openIssue();
      return;
    }
    // selectPr/selectIssue hand over a bare number that the destination view
    // resolves under the repo's ACTIVE lens, so a body rendered under the other
    // one (a local view, or any surface pinned to origin) can only reach the
    // right item by leaving the app. A cold cache reads as "origin", matching
    // useRepoLens' own fallback.
    const activeLens =
      queryClient.getQueryData<RemoteLens>(lensKey(repoPath)) ?? "origin";
    if (activeLens !== lens) {
      setResolving(true);
      try {
        const details = await queryClient.fetchQuery(
          issueDetailsOptions(repoPath, number, lens),
        );
        await openUrl(details.url);
      } catch (e) {
        toastError(e);
      } finally {
        setResolving(false);
      }
      return;
    }
    // GitHub's `#N` addresses one number space, so the kind resolves here — by
    // the same two steps the preview card takes, off the same helpers.
    const cached = cachedRefKind(queryClient, repoPath, lens, number);
    if (cached === "pr") {
      openPr();
      return;
    }
    if (cached === "issue") {
      openIssue();
      return;
    }
    setResolving(true);
    try {
      const issue = await queryClient.fetchQuery(
        issueDetailsOptions(repoPath, number, lens),
      );
      if (isPullRefUrl(issue.url)) openPr();
      else openIssue();
    } catch (e) {
      toastError(e);
    } finally {
      setResolving(false);
    }
  }

  /** Open a repository-relative href on the forge. The base is built at click
   *  time off the repo's server-truth web URL, so GitHub Enterprise and a
   *  self-managed GitLab need no host table. The origin gate is a backstop under
   *  the classifier, not a duplicate: only a URL still on the repo's own host is
   *  opened, and the scheme test rides with it because opaque origins compare
   *  equal. */
  async function openRepoFile(href: string) {
    if (!refs) return;
    const { repoPath, provider, lens } = refs;
    setResolving(true);
    try {
      // Through the body's OWN lens: a fork's body rendered under `upstream`
      // names paths that live in the parent, not in the fork.
      const repoUrl = (await forgeRepoUrl(repoPath, lens)).replace(
        TRAILING_SLASH,
        "",
      );
      const base = `${repoUrl}/${BLOB_PATH[provider]}`;
      // A root-relative href addresses the REPOSITORY root, which is how both
      // GitHub and GitLab render one in a repo document — so the leading
      // separator comes off and it resolves under the blob base like any other
      // path. Only one: the classifier already refused two (an authority).
      const resolved = new URL(href.replace(LEADING_SEPARATOR, ""), base);
      if (
        (resolved.protocol === "http:" || resolved.protocol === "https:") &&
        resolved.origin === new URL(base).origin
      ) {
        await openUrl(resolved);
      }
    } catch (e) {
      toastError(e);
    } finally {
      setResolving(false);
    }
  }

  /** Every anchor branch of the dispatch: a forge reference navigates in-app,
   *  and every other anchor obeys `linkTarget` — the same verdict the card
   *  opens on, so the two can't admit different sets. The reference branch
   *  claims the event only for a target that fully validates, so a `data-ref`
   *  this renderer didn't emit falls through to its href like any other link. */
  function dispatchAnchor(
    e: React.MouseEvent,
    anchor: HTMLAnchorElement,
    /** True on the middle-click route, which suppresses rather than activates:
     *  a reference's in-app navigation is a primary action, and firing it from
     *  the third button would move the view the user meant to leave alone. */
    aux: boolean,
  ) {
    const target = refTarget(anchor);
    if (target) {
      e.preventDefault();
      if (aux) return;
      // Same reason as the link branches below: `@user` and the cross-lens
      // number path both hand off to the system browser, and the in-app ones
      // switch the view out from under the card either way.
      closeCardNow();
      void openRef(target);
      return;
    }
    // No href at all is not a link and keeps whatever the anchor already did.
    // Every real href is claimed, `href=""` included — marked emits that for
    // `[a]()`, and its default navigation reloads the app's own document.
    // Claimed BEFORE the classifier and the async resolve behind it, so the
    // webview can never navigate while one is in flight.
    if (anchor.getAttribute("href") === null) return;
    e.preventDefault();
    const link = linkTarget(anchor, hasRefs);
    // An inert link is claimed (the preventDefault above) but opens nothing —
    // its card is the whole affordance. Everything the classifier admits to a
    // destination opens; the rest stays put with an explanation.
    if (!link || link.kind === "inert") return;
    // The system browser takes focus from here, so a card that is open (or one
    // frame from opening) would hang over an app the user has left.
    closeCardNow();
    // Both branches surface their own failure: a scheme-only href like `https:`
    // classifies external and the Rust side rejects it, which would otherwise
    // reach only the global unhandled-rejection handler.
    if (link.kind === "external") void openUrl(link.href).catch(toastError);
    else void openRepoFile(link.href);
  }

  // Event delegation over the rendered body: anchors first, then an unlinked
  // image big enough to be worth seeing opens fullscreen. An image under an
  // anchor stays that anchor's, which is what makes the image branch last.
  function onClick(e: React.MouseEvent) {
    const el = e.target as HTMLElement;
    const anchor = el.closest("a");
    if (anchor) {
      dispatchAnchor(e, anchor, false);
      return;
    }
    const img = el.closest("img");
    if (img && isLightboxImage(img)) {
      e.preventDefault();
      openLightbox(img);
    }
  }

  /** A middle click's default open rides `auxclick`, which never fires `click` —
   *  so the anchor dispatch has to be reachable from here too, or every branch
   *  it claims would navigate the webview on the third button. The image branch
   *  has no middle-click behavior to displace. */
  function onAuxClick(e: React.MouseEvent) {
    if (e.button !== 1) return;
    const anchor = (e.target as HTMLElement).closest("a");
    if (anchor) dispatchAnchor(e, anchor, true);
  }

  /** The image branch's keyboard twin — the anchors above are real links and
   *  already answer Enter themselves. */
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "Enter" && e.key !== " ") return;
    const img = (e.target as HTMLElement).closest("img");
    if (!img || !isLightboxImage(img)) return;
    // Space would scroll the pane out from under the image otherwise.
    e.preventDefault();
    openLightbox(img);
  }

  return (
    <>
      <div
        ref={bodyRef}
        onClick={onClick}
        onAuxClick={onAuxClick}
        onKeyDown={onKeyDown}
        onPointerOver={onPointerOver}
        onPointerOut={onPointerOut}
        onFocusCapture={onFocusCapture}
        onBlurCapture={onBlurCapture}
        // The cursor can't reach a keyboard or screen-reader user; aria-busy is
        // the same signal for them.
        aria-busy={resolving}
        className={cn(
          "markdown-body text-xs/relaxed break-words",
          // Margins collapse at the edges so previews/comments have no leading or
          // trailing gap (matches GitHub's rendered-markdown reset).
          "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
          // Heading scale with GitHub-style underlines on h1/h2 for clear hierarchy.
          "[&_h1]:mt-5 [&_h1]:mb-3 [&_h1]:border-b [&_h1]:border-border [&_h1]:pb-1.5 [&_h1]:font-heading [&_h1]:text-xl [&_h1]:font-semibold",
          "[&_h2]:mt-5 [&_h2]:mb-3 [&_h2]:border-b [&_h2]:border-border [&_h2]:pb-1.5 [&_h2]:font-heading [&_h2]:text-lg [&_h2]:font-semibold",
          "[&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:font-heading [&_h3]:text-base [&_h3]:font-semibold",
          "[&_h4]:mt-4 [&_h4]:mb-2 [&_h4]:font-heading [&_h4]:text-sm [&_h4]:font-semibold",
          "[&_h5]:mt-4 [&_h5]:mb-2 [&_h5]:font-heading [&_h5]:text-xs [&_h5]:font-semibold",
          "[&_h6]:mt-4 [&_h6]:mb-2 [&_h6]:font-heading [&_h6]:text-xs [&_h6]:font-semibold [&_h6]:text-muted-foreground",
          "[&_p]:my-2.5 [&_ul]:my-2.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1",
          // Nested lists hug their parent item rather than opening a full gap.
          "[&_li_ul]:my-1 [&_li_ol]:my-1",
          "[&_a]:cursor-pointer [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:text-foreground",
          // AFTER the anchor block, not before: tw-merge keeps the later of two
          // `[&_a]:cursor-*` classes, so listing this first leaves the anchor on
          // cursor-pointer and the busy state invisible where the pointer actually is.
          resolving && "cursor-progress [&_a]:cursor-progress",
          // A link that won't open shows the help cursor, since hovering is how
          // its card explains why. After the anchor block, matching the image
          // affordance below: `a[data-inert-link]` outranks the bare `[&_a]`
          // cursor by specificity, so this wins wherever the walk marked it.
          "[&_a[data-inert-link]]:cursor-help",
          "[&_code]:rounded-none [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]",
          "[&_pre]:my-2.5 [&_pre]:overflow-x-auto [&_pre]:border [&_pre]:border-border [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:text-[0.85em] [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[1em]",
          "[&_blockquote]:my-2.5 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
          "[&_hr]:my-4 [&_hr]:border-border [&_strong]:font-semibold [&_em]:italic",
          "[&_table]:my-2.5 [&_table]:block [&_table]:overflow-x-auto [&_th]:border [&_th]:border-border [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-1.5",
          // Task lists (`- [ ]`) render as checkboxes with no bullet, like GitHub.
          "[&_input[type=checkbox]]:mr-1.5 [&_input[type=checkbox]]:align-middle [&_li:has(input[type=checkbox])]:list-none [&_li:has(input[type=checkbox])]:-ml-5",
          // Collapsible details blocks (release notes, changelogs, command lists)
          "[&_details]:my-2.5 [&_summary]:cursor-pointer [&_summary]:py-1 [&_summary]:font-medium [&_summary]:select-none",
          // Inline badges (compatibility score) and embedded previews (QR codes)
          "[&_img]:my-1 [&_img]:inline-block [&_img]:max-w-full",
          // The zoom affordance for an image the viewer will open, keyed on the
          // attribute the marking effect sets. Authored here rather than added to
          // the element's own class list so it shares a layer with the rules
          // above and outranks the `[&_img]:` block instead of tying with it.
          "[&_img[data-lightbox]]:cursor-zoom-in [&_img[data-lightbox]]:outline-none",
          "[&_img[data-lightbox]:focus-visible]:ring-1 [&_img[data-lightbox]:focus-visible]:ring-ring/50",
          className,
        )}
        dangerouslySetInnerHTML={htmlProp}
      />
      {/* Portalled so the body div above stays its parent's ONLY in-flow child:
          the card's trigger span is always mounted, and a `space-y-*` parent
          (Tailwind compiles it to `> :not(:last-child)`) would otherwise hang a
          phantom margin off the body. Context crosses a portal, so the popup's
          own `usePanelPortalContainer()` still scopes it to the panel. */}
      {/* Unconditional: an external link previews on every surface, including
          the ones with no forge context at all (the help screen, AI output).
          The card takes `refs` only for the reference kinds, which can't arise
          without it. */}
      {createPortal(
        <MarkdownRefCard
          id={cardId}
          refs={refs}
          target={cardTarget}
          rect={cardRect}
          onOpenChange={(open) => {
            if (open) return;
            cancelTimer(cardTimer);
            cardPointerAnchor.current = null;
            setCardTarget(null);
            // Explicit release rather than `resetCard`, which would also cancel
            // a pending focus-open the dismissal never addressed.
            releaseCard(card);
          }}
          onPointerEnter={() => {
            // Inside the popup the pointer claims the card, so it claims the
            // anchor the card belongs to — the blur path compares identities.
            cardPointerAnchor.current = cardAnchor;
            cancelTimer(cardTimer);
          }}
          onPointerLeave={() => {
            cardPointerAnchor.current = null;
            scheduleCardClose();
          }}
        />,
        document.body,
      )}
      <ImageLightbox
        images={shownLightbox?.images ?? NO_IMAGES}
        index={shownLightbox?.index ?? 0}
        onIndexChange={(index) =>
          setLightbox((shown) => (shown ? { ...shown, index } : shown))
        }
        open={lightbox !== null}
        onOpenChange={(open) => {
          if (!open) setLightbox(null);
        }}
      />
    </>
  );
}
