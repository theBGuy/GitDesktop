import type { RendererExtension, TokenizerExtension, Tokens } from "marked";
import { type MentionTrigger, TRIGGERS } from "@/lib/git/mention-triggers";
import type { ForgeProvider, RemoteLens } from "@/lib/git/types";

/** What a rendered markdown body needs to linkify forge references: whose
 *  reference grammar applies, plus the repo and lens a click resolves under. */
export interface MarkdownRefs {
  provider: ForgeProvider;
  repoPath: string;
  lens: RemoteLens;
}

/** The `data-ref` values the renderer emits; the click dispatch in markdown.tsx
 *  routes on exactly these. `issue-or-pr` is GitHub's single number space, which
 *  nothing in the body can resolve — that happens at click time. */
export type MarkdownRefKind = "issue-or-pr" | "issue" | "mr" | "user";

/** What each forge's triggers ADDRESS. Which triggers are live at all stays
 *  TRIGGERS' call (the app's shipped per-forge autolink contract), so the two
 *  tables can't disagree — Bitbucket autolinks nothing, and lists nothing. */
const REF_KIND: Record<
  ForgeProvider,
  Partial<Record<MentionTrigger, MarkdownRefKind>>
> = {
  github: { "#": "issue-or-pr", "@": "user" },
  gitlab: { "#": "issue", "!": "mr", "@": "user" },
  bitbucket: {},
};

/** The grammars of the VALUES this renderer emits into `data-ref-num` /
 *  `data-ref-user`. Both the tokenizer's match and the click dispatch's
 *  re-validation are built from these fragments so the two can never drift.
 *  No forge numbers an item 0, so `#0` is prose; handles follow GitHub's rule
 *  (alphanumerics with single internal hyphens, 39 chars at most), which is
 *  deliberately conservative for GitLab, whose logins may hold dots. */
const NUMBER_SRC = String.raw`[1-9]\d{0,9}`;
const USER_SRC = String.raw`[a-zA-Z0-9](?:-?[a-zA-Z0-9]){0,38}`;

const NUMBER_RE = new RegExp(String.raw`^([#!])(${NUMBER_SRC})(?!\w)`);
/** A following `.`/`/` that CONTINUES into a word belongs to a longer name or
 *  path (`@jane.doe`, `@group/sub`), so the whole thing stays plain rather than
 *  linking a prefix; sentence-ending punctuation still closes a mention. */
const USER_RE = new RegExp(String.raw`^@(${USER_SRC})(?![\w-])(?![./]\w)`);
const NUMBER_VALUE_RE = new RegExp(String.raw`^${NUMBER_SRC}$`);
const USER_VALUE_RE = new RegExp(String.raw`^${USER_SRC}$`);

/** Whether an anchor's `data-ref-num` is one this renderer could have emitted.
 *  Raw HTML authored in a body survives sanitization with its `data-*` intact,
 *  so the dispatch re-checks before it navigates or builds a forge URL. */
export function isValidRefNum(value: string | undefined): value is string {
  return value !== undefined && NUMBER_VALUE_RE.test(value);
}

/** The `data-ref-user` twin of {@link isValidRefNum} — rejects paths and any
 *  other crafted value that could steer the profile URL. */
export function isValidRefUser(value: string | undefined): value is string {
  return value !== undefined && USER_VALUE_RE.test(value);
}

/** A reference only opens at a boundary: a word char keeps `word#123` plain, `/`
 *  keeps a URL fragment plain, and `&` keeps entities like `&#39;` unlinkified.
 *  Emphasis inherits the asymmetry — `**bold**#278` links where `_italic_#278`
 *  stays plain, because `_` is itself a word char. */
const BLOCKED_BEFORE = /[\w/&]/;

let activeRefs: MarkdownRefs | null = null;

/**
 * Point the extensions at the body about to be parsed. `md.parse` is synchronous
 * (`{ async: false }`) and JS is single-threaded, so a set → parse → clear around
 * that one call can never interleave with another body's parse.
 */
export function setActiveMarkdownRefs(refs: MarkdownRefs | null): void {
  activeRefs = refs;
}

/** Inert fallbacks: a provider string from outside the union (wire drift) must
 *  degrade to plain text, never throw mid-render. */
const NO_TRIGGERS: readonly string[] = [];
const NO_KINDS: Partial<Record<MentionTrigger, MarkdownRefKind>> = {};

/** A forge's two tables, or null when nothing can match — a forge that autolinks
 *  nothing (Bitbucket) must not pay for a scan. */
function tablesFor(provider: ForgeProvider): {
  triggers: readonly string[];
  kinds: Partial<Record<MentionTrigger, MarkdownRefKind>>;
} | null {
  const triggers =
    (TRIGGERS[provider] as readonly string[] | undefined) ?? NO_TRIGGERS;
  if (triggers.length === 0) return null;
  return { triggers, kinds: REF_KIND[provider] ?? NO_KINDS };
}

/** {@link tablesFor} for the body currently being parsed. */
function activeTables() {
  return activeRefs ? tablesFor(activeRefs.provider) : null;
}

/** Whether `kind` is one this renderer could have emitted for `provider` — the
 *  dispatch's guard against a `data-ref` naming a kind this forge never
 *  produces (GitLab's `mr` on GitHub, anything at all on Bitbucket). Derived
 *  from the same two tables the tokenizer reads, so the pair can't drift. */
export function isEmittableRefKind(
  provider: ForgeProvider,
  kind: string | undefined,
): kind is MarkdownRefKind {
  const tables = tablesFor(provider);
  if (!tables || kind === undefined) return false;
  return tables.triggers.some(
    (ch) => tables.kinds[ch as MentionTrigger] === kind,
  );
}

/** What `ch` addresses on the active forge — undefined with no context, or when
 *  this forge doesn't autolink that trigger. */
function activeKind(ch: string): MarkdownRefKind | undefined {
  const tables = activeTables();
  if (!tables?.triggers.includes(ch)) return undefined;
  return tables.kinds[ch as MentionTrigger];
}

interface RefToken extends Tokens.Generic {
  type: "forgeRef";
  raw: string;
  kind: MarkdownRefKind;
  num?: string;
  user?: string;
}

export const forgeRefExtension: TokenizerExtension & RendererExtension = {
  name: "forgeRef",
  level: "inline",
  // marked calls `start` with the source MINUS its first character and cuts the
  // pending text token right before the returned index — that cut is what lands
  // the tokenizer on a reference. Returning undefined when there is no context
  // leaves the cut, and so the output, byte-identical to unextended marked.
  start(src) {
    const tables = activeTables();
    if (!tables) return undefined;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (!tables.triggers.includes(ch)) continue;
      if (!tables.kinds[ch as MentionTrigger]) continue;
      if (i > 0 && BLOCKED_BEFORE.test(src[i - 1])) continue;
      return i;
    }
    return undefined;
  },
  tokenizer(src, tokens) {
    // marked's two raw-HTML states, both fatal to a nested anchor: inside a link
    // label the HTML parser splits the anchor and strands the outer href, and
    // inside a `<pre|code|kbd|script>` run the reference is quoted text that
    // must stay text.
    if (this.lexer.state.inLink || this.lexer.state.inRawBlock)
      return undefined;
    const kind = activeKind(src[0]);
    if (!kind) return undefined;
    // The tokenizer gets no lookbehind and `start` cannot see the character
    // before its own slice, so the preceding token's last char is the only way
    // to enforce the boundary at those two positions.
    const prev = tokens.at(-1)?.raw;
    if (prev && BLOCKED_BEFORE.test(prev.slice(-1))) return undefined;
    if (kind === "user") {
      const user = USER_RE.exec(src);
      return user
        ? { type: "forgeRef", raw: user[0], kind, user: user[1] }
        : undefined;
    }
    const num = NUMBER_RE.exec(src);
    return num
      ? { type: "forgeRef", raw: num[0], kind, num: num[2] }
      : undefined;
  },
  renderer(token) {
    const ref = token as RefToken;
    // Both regexes admit only alphanumerics, `-` and the trigger char, so the
    // interpolated values carry nothing HTML-special. `href="#"` keeps the link
    // focusable and hoverable; the click dispatch preventDefaults it.
    const attr = ref.user
      ? `data-ref-user="${ref.user}"`
      : `data-ref-num="${ref.num}"`;
    return `<a href="#" data-ref="${ref.kind}" ${attr}>${ref.raw}</a>`;
  },
};
