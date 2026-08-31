import { useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import DOMPurify from "dompurify";
// Static `lib/common` (~37 languages) so the common fences highlight instantly
// with no flicker. Rarer tags trigger a one-time lazy load of the full ~192-lang
// build (see markdown-hljs.ts), which registers into this same core singleton.
import hljs from "highlight.js/lib/common";
import { Marked } from "marked";
import { useMemo, useSyncExternalStore } from "react";
import { diffLang } from "@/features/diff/diff-lang";
import { forgeRepoUrl } from "@/lib/git/api";
import { issueDetailsOptions } from "@/lib/git/queries";
import type { RemoteLens } from "@/lib/git/types";
import { lensKey } from "@/lib/repo-lens/queries";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { hljsUpgradeStore, upgradeToFullHljs } from "./markdown-hljs";
import {
  forgeRefExtension,
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
  const selectPr = useUiStore((s) => s.selectPr);
  const selectIssue = useUiStore((s) => s.selectIssue);
  const setRepoTab = useUiStore((s) => s.setRepoTab);
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

  /** Navigate to whatever a rendered reference anchor points at. */
  async function openRef(anchor: HTMLAnchorElement) {
    if (!refs) return;
    const { repoPath, lens } = refs;
    const kind = anchor.dataset.ref;
    if (kind === "user") {
      const user = anchor.dataset.refUser;
      if (!user) return;
      try {
        // Origin off the repo's server-truth web URL, so GitHub Enterprise and
        // self-managed GitLab hosts resolve without a host table.
        const origin = new URL(await forgeRepoUrl(repoPath)).origin;
        await openUrl(`${origin}/${user}`);
      } catch (e) {
        toastError(e);
      }
      return;
    }
    const number = Number(anchor.dataset.refNum);
    if (!Number.isInteger(number)) return;
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
      try {
        const details = await queryClient.fetchQuery(
          issueDetailsOptions(repoPath, number, lens),
        );
        await openUrl(details.url);
      } catch (e) {
        toastError(e);
      }
      return;
    }
    // GitHub's `#N` addresses one number space, so the kind resolves here: a
    // cached list that already holds the number answers for free (its issue
    // lists exclude PRs), and otherwise the issues endpoint answers for PR
    // numbers too — a `/pull/` URL is what tells the two apart.
    const cachedHas = (list: "pr-list" | "issue-list") =>
      queryClient
        .getQueriesData<{ number: number }[]>({
          queryKey: ["repo", repoPath, list, lens],
        })
        .some(([, rows]) => rows?.some((row) => row.number === number));
    if (cachedHas("pr-list")) {
      openPr();
      return;
    }
    if (cachedHas("issue-list")) {
      openIssue();
      return;
    }
    try {
      const issue = await queryClient.fetchQuery(
        issueDetailsOptions(repoPath, number, lens),
      );
      if (issue.url.includes("/pull/")) openPr();
      else openIssue();
    } catch (e) {
      toastError(e);
    }
  }

  // Event delegation over the rendered body, most specific target first: a forge
  // reference navigates in-app, and any other external link opens in the system
  // browser rather than navigating the embedded webview.
  function onClick(e: React.MouseEvent) {
    const anchor = (e.target as HTMLElement).closest("a");
    if (!anchor) return;
    if (anchor.dataset.ref) {
      e.preventDefault();
      void openRef(anchor);
      return;
    }
    const href = anchor.getAttribute("href");
    if (href && /^(https?:|mailto:)/.test(href)) {
      e.preventDefault();
      openUrl(href);
    }
  }

  return (
    <div
      onClick={onClick}
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
        className,
      )}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
