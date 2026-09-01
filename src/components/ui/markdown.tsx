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
import {
  fileNameFromSrc,
  ImageLightbox,
  type LightboxImage,
} from "@/components/ui/image-lightbox";
import { diffLang } from "@/features/diff/diff-lang";
import { forgeRepoUrl } from "@/lib/git/api";
import { issueDetailsOptions } from "@/lib/git/queries";
import type { RemoteLens } from "@/lib/git/types";
import { lensKey } from "@/lib/repo-lens/queries";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { useRetained } from "@/lib/use-retained";
import { cn } from "@/lib/utils";
import { hljsUpgradeStore, upgradeToFullHljs } from "./markdown-hljs";
import {
  cachedRefKind,
  isPullRefUrl,
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

// The preview card renders without a `PreviewCard.Trigger` — one card serves a
// whole body, positioned at whichever anchor is active — so none of Base UI's
// hover machinery applies and the delays are hand-rolled from its own constants.
const CARD_OPEN_DELAY = 600;
const CARD_CLOSE_DELAY = 300;

/** The card's own subtree, for telling "the pointer left the anchor" apart from
 *  "the pointer moved into the card" — which the DOM reports identically, the
 *  popup being portaled out of the body. Both slots: `hover-card.tsx` stamps the
 *  popup, and the portal wrapper covers the positioner between them. */
const CARD_POPUP_SELECTOR =
  '[data-slot="hover-card-content"],[data-slot="hover-card-portal"]';

function cancelTimer(
  ref: React.RefObject<ReturnType<typeof setTimeout> | null>,
) {
  if (ref.current !== null) {
    clearTimeout(ref.current);
    ref.current = null;
  }
}

/** Natural-size floor, both axes, for an image the viewer will open: it clears
 *  shields-style badges (~120×20) and emoji (~20×20) while any screenshot passes.
 *  One knob — widen or narrow it here. */
const LIGHTBOX_MIN_PX = 48;

/** Whether an embedded image is worth opening fullscreen. A linked image belongs
 *  to its link whatever the href — badges are near-universally wrapped in one —
 *  one inside a collapsed `<details>` isn't on screen to be opened or navigated
 *  past, and an image that hasn't loaded (or failed) reports 0 for both axes,
 *  which the floor rejects on its own. */
function isLightboxImage(img: HTMLImageElement): boolean {
  if (img.closest("a") || img.closest("details:not([open])")) return false;
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
 * Links open in the system browser instead of navigating the webview.
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
      return DOMPurify.sanitize(raw);
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
  // The anchor is state rather than a ref because the positioner re-resolves only
  // when the value it was handed changes: a switch straight from one reference to
  // another (a Tab between two, which batches the close and the open into one
  // commit) would otherwise leave the card sitting at the first anchor. It
  // survives a close so the exit animation keeps its position.
  const [cardAnchor, setCardAnchor] = useState<HTMLAnchorElement | null>(null);
  const cardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The pointer's claim on the card — resting on a reference, or inside the
  // popup. Read by the blur path, which must not close a card the mouse owns.
  const cardHovered = useRef(false);
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
  // `cardAnchor` deliberately survives: only the positioner reads it, and
  // clearing it here would drop the closing card to the origin mid-fade — the
  // next `showCard` overwrites it before it can be read again.
  // `html` is the trigger, not a value this reads — same shape as the parse memo.
  // biome-ignore lint/correctness/useExhaustiveDependencies: html is the intentional reset trigger
  useEffect(() => {
    cancelTimer(cardTimer);
    cardHovered.current = false;
    setCardTarget(null);
    setLightbox(null);
    return () => cancelTimer(cardTimer);
  }, [html]);

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
    for (const img of root.querySelectorAll("img")) {
      const onLoad = () => markLightboxImage(img);
      img.addEventListener("load", onLoad);
      offs.push(() => img.removeEventListener("load", onLoad));
      markLightboxImage(img);
    }
    return () => {
      for (const off of offs) off();
    };
  }, [html]);

  /** Open the viewer on `img`, with every other qualifying image in the body
   *  behind its prev/next. Any hover intent in flight is dropped: a card opening
   *  over the viewer would be positioned against a body the user can't see. */
  function openLightbox(img: HTMLImageElement) {
    const root = bodyRef.current;
    if (!root) return;
    const imgs = lightboxImagesIn(root);
    const index = imgs.indexOf(img);
    if (index < 0) return;
    cancelTimer(cardTimer);
    cardHovered.current = false;
    setCardTarget(null);
    setLightbox({ images: imgs.map(toLightboxImage), index });
  }

  function showCard(anchor: HTMLAnchorElement, target: MarkdownRefTarget) {
    cancelTimer(cardTimer);
    setCardAnchor(anchor);
    setCardTarget(target);
  }

  /** The grace period before an open card goes: re-entering either the anchor or
   *  the popup cancels it. */
  function scheduleCardClose() {
    cancelTimer(cardTimer);
    cardTimer.current = setTimeout(() => {
      cardTimer.current = null;
      setCardTarget(null);
    }, CARD_CLOSE_DELAY);
  }

  function onPointerOver(e: React.PointerEvent) {
    const anchor = (e.target as HTMLElement).closest("a");
    const target = anchor && refTarget(anchor);
    if (!anchor || !target) return;
    cardHovered.current = true;
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
    if (!anchor || !refTarget(anchor)) return;
    // Crossing into the card is not leaving it. The popup portals outside this
    // wrapper, so the browser reports the move as a plain pointerout on the
    // anchor; treating that as a close would arm a timer the popup's own enter
    // has to race, and losing that race reopens from the anchor and cycles.
    if ((e.relatedTarget as Element | null)?.closest?.(CARD_POPUP_SELECTOR))
      return;
    cardHovered.current = false;
    cancelTimer(cardTimer);
    if (cardTarget) scheduleCardClose();
  }

  function onFocusCapture(e: React.FocusEvent) {
    const anchor = (e.target as HTMLElement).closest("a");
    const target = anchor && refTarget(anchor);
    if (!anchor || !target) return;
    // Keyboard arrival only. Landing on a reference by Tab is already the
    // deliberate ask the hover delay waits for, but a click focuses the anchor
    // too — and popping a card under the pointer there reads as a misfire,
    // worst on `@user`, where the browser takes over and the view never changes.
    if (!anchor.matches(":focus-visible")) return;
    showCard(anchor, target);
  }

  function onBlurCapture(e: React.FocusEvent) {
    const anchor = (e.target as HTMLElement).closest("a");
    if (!anchor || !refTarget(anchor)) return;
    // The keyboard's claim on the card ends here — card content is
    // non-interactive, so focus cannot have moved into it. The pointer may still
    // hold a claim of its own, on a reference or inside the popup, and a mouse
    // user's card must not close because focus went somewhere unrelated.
    if (cardHovered.current) return;
    cancelTimer(cardTimer);
    setCardTarget(null);
  }

  /**
   * The reference this anchor addresses, or null when it isn't one this body can
   * act on. Body-authored raw HTML reaches the DOM with its `data-*` intact
   * (DOMPurify keeps them by design), so the kind is checked against THIS forge's
   * row and every value against the grammar the renderer emits. Synchronous
   * because the click handler decides whether to claim the event on its answer.
   */
  function refTarget(anchor: HTMLAnchorElement): MarkdownRefTarget | null {
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

  /** Navigate to whatever a validated reference target points at. */
  async function openRef(target: MarkdownRefTarget) {
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

  // Event delegation over the rendered body, most specific target first: a forge
  // reference navigates in-app, then any external link opens in the system browser
  // rather than navigating the embedded webview, and an unlinked image big enough
  // to be worth seeing opens fullscreen. The anchor branches claim the event only
  // for a target that fully validates, so a `data-ref` this renderer didn't emit
  // keeps whatever behavior its href already gives it — and an image under an
  // anchor stays that anchor's, which is what makes the image branch last.
  function onClick(e: React.MouseEvent) {
    const el = e.target as HTMLElement;
    const anchor = el.closest("a");
    if (anchor) {
      const target = refTarget(anchor);
      if (target) {
        e.preventDefault();
        void openRef(target);
        return;
      }
      const href = anchor.getAttribute("href");
      if (href && /^(https?:|mailto:)/.test(href)) {
        e.preventDefault();
        openUrl(href);
      }
      return;
    }
    const img = el.closest("img");
    if (img && isLightboxImage(img)) {
      e.preventDefault();
      openLightbox(img);
    }
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
      {refs ? (
        <MarkdownRefCard
          id={cardId}
          refs={refs}
          target={cardTarget}
          anchor={cardAnchor}
          onOpenChange={(open) => {
            if (open) return;
            cancelTimer(cardTimer);
            setCardTarget(null);
          }}
          onPointerEnter={() => {
            cardHovered.current = true;
            cancelTimer(cardTimer);
          }}
          onPointerLeave={() => {
            cardHovered.current = false;
            scheduleCardClose();
          }}
        />
      ) : null}
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
