#!/usr/bin/env node
// Mechanical guards for convention classes that a 6-wave audit already paid to
// close once — each check exists so its class cannot silently re-open one PR at
// a time. Node built-ins only (no deps): CI runs this with bare `node`.
//
// Adding a check is one CHECKS entry. An allowlist entry is a deliberate,
// rationale-carrying exception — never a way to quiet a fresh violation.
// The predicates are exported and pinned by scripts/checks.test.mjs; the CLI
// body below runs only when this file is the entry point.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPR_KEYWORDS,
  EXPR_OPENERS,
  lineOf,
  maskNonCode,
  matchBrace,
  ScanError,
} from "./lib/ts-mask.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
/** The extensions every check reads; stylesheets are never scanned. */
export const EXTENSIONS = [".ts", ".tsx"];

// Widest gap (normalized chars) still counted as "the same expression" for a
// two-token match. Sized so a formatter-wrapped class list stays one match while
// two unrelated uses elsewhere in the file don't pair up.
const PAIR_GAP = 160;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A Tailwind class name as a standalone token. Without the boundary guards a
 *  raw-substring match for `hidden` also fires on `overflow-hidden`, pairing
 *  layout utilities with an unrelated `group-hover:` class. */
const token = (s) => `(?<![\\w-])${escapeRe(s)}(?![\\w-])`;

/**
 * Comment text blanked out, line structure preserved — a documented example of
 * a banned pattern is not a use of it. String literals are tracked just far
 * enough that `https://` and a quoted `/*` don't read as comment starts.
 * Residual gaps, all zero-instance today: regex literals aren't parsed and JSX
 * text isn't distinguished from code, so a `//` inside a regex literal or JSX
 * prose blanks the rest of that line. Quote state resets at each line, but
 * block-comment state deliberately PERSISTS across lines — so a `/*` appearing
 * inside a multi-line template literal or JSX prose blanks everything up to the
 * next block-comment close, potentially the rest of the file. Not a parser.
 */
export function stripComments(lines) {
  const out = [];
  let inBlock = false;
  for (const line of lines) {
    let code = "";
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      const next = line[i + 1];
      if (inBlock) {
        if (c === "*" && next === "/") {
          inBlock = false;
          i++;
        }
        continue;
      }
      if (quote) {
        code += c;
        if (c === "\\") {
          code += next ?? "";
          i++;
        } else if (c === quote) {
          quote = null;
        }
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        quote = c;
        code += c;
        continue;
      }
      if (c === "/" && next === "/") break;
      if (c === "/" && next === "*") {
        inBlock = true;
        i++;
        continue;
      }
      code += c;
    }
    out.push(code);
  }
  return out;
}

/** A file's scannable view: comment-stripped lines, plus those lines joined
 *  into one string with each line's start offset — so a match that spans a
 *  wrapped expression still reports a real line number. `source` rides along
 *  for a scan that needs the raw text (a ts-mask lexer). */
export function view(source) {
  const lines = stripComments(source.split(/\r?\n/));
  const starts = [];
  let offset = 0;
  const parts = lines.map((line) => {
    starts.push(offset);
    const part = line.trim();
    offset += part.length + 1;
    return part;
  });
  return { lines, text: parts.join(" "), starts, source };
}

/** 1-based source line owning a normalized-text offset. */
function lineAt(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Scanner: every line matching `re` (never pass a `g` regex — `test` is
 *  stateful with it). */
const perLine =
  (re) =>
  ({ lines }) =>
    lines.flatMap((line, i) => (re.test(line) ? [i + 1] : []));

/** Scanner: every match of a `g` regex against the whitespace-normalized whole
 *  file, so a match spanning a wrapped expression still counts. Reports the line
 *  the match starts on. */
const perFile = (re) => {
  return ({ text, starts }) => {
    const hits = new Set();
    for (const m of text.matchAll(re)) hits.add(lineAt(starts, m.index));
    return [...hits];
  };
};

/** Scanner: `a` and `b` within PAIR_GAP of each other in either order, wrapped
 *  lines included. Reports the line the match starts on. */
const nearPair = (a, b) => {
  const [x, y] = [token(a), token(b)];
  const re = new RegExp(
    `${x}[\\s\\S]{0,${PAIR_GAP}}?${y}|${y}[\\s\\S]{0,${PAIR_GAP}}?${x}`,
    "g",
  );
  return perFile(re);
};

/** Scanner: the union of several scanners — one check, one allowlist, every
 *  route to the same banned thing (including routes that want different
 *  views: `perLine` for a token, `perFile` for one that can wrap). */
const anyOf = (scans) => (v) => [...new Set(scans.flatMap((scan) => scan(v)))];

/** Scanner: `scan`'s hits, but only in files whose whole-file view also matches
 *  `gate` — a file-scoped AND for a class where each half is legitimate alone,
 *  so only their co-presence is the defect. The `lastIndex` reset is what makes
 *  a `g`-flagged `gate` safe: `test` is stateful with one, so it would otherwise
 *  resume mid-file and alternate between hit and miss down the file list. */
const onlyWhen = (gate, scan) => (v) => {
  gate.lastIndex = 0;
  return gate.test(v.text) ? scan(v) : [];
};

/** Scanner: `scan`'s hits, unless the whole-file view matches EVERY regex in
 *  `required` — the negative twin of `onlyWhen`, for a class whose remedy is the
 *  PRESENCE of shared helpers rather than the absence of a bad shape. All-or-
 *  nothing on purpose: a file carrying any subset of `required` is exactly the
 *  half-guarded shape worth reporting. Same `lastIndex` reset, for the same
 *  reason. */
const unlessAllPresent = (required, scan) => (v) => {
  for (const re of required) re.lastIndex = 0;
  return required.every((re) => re.test(v.text)) ? [] : scan(v);
};

/** Scanner: the union of several `nearPair`s — one check, one allowlist, every
 *  Tailwind spelling of the same idiom. */
const anyPair = (pairs) => anyOf(pairs.map(([a, b]) => nearPair(a, b)));

// The same hover-reveal in each of its Tailwind spellings: the hiding utility
// paired with the `group-hover:` class that undoes it. `inline` and
// `inline-flex` are separate entries because the token boundary guard stops
// `group-hover:inline` from matching inside `group-hover:inline-flex`.
// The `hidden` arm is the noisy one: `hidden` is common standalone (responsive
// layout) in a way `opacity-0` is not, so two SIBLING elements within PAIR_GAP
// can pair by accident. That failure is loud — a named file and line — and the
// allowlist is its remedy, so it is preferred over missing the real idiom.
const HOVER_REVEAL_PAIRS = [
  ["opacity-0", "group-hover:opacity-100"],
  ["invisible", "group-hover:visible"],
  ["hidden", "group-hover:block"],
  ["hidden", "group-hover:flex"],
  ["hidden", "group-hover:inline"],
  ["hidden", "group-hover:inline-flex"],
];

// `undefined` as the LAST argument of a `setQueryData` call. Two traps:
//   1. The call wraps — the updater lands on its own line — so this runs over
//      the whitespace-normalized whole-file view, not per line.
//   2. Type arguments nest: `setQueryData<Record<string, Foo>>(…)`. A
//      `<[^>]*>` generic group stops at the INNER `>` and then fails on the
//      leftover `>`; `<[^(]*?>` is lazy and bounded by the call's own paren
//      (the same trap check-dead-surface.mjs documents for `invoke`).
// The argument run is greedy so a key expression containing commas still
// resolves to the call's LAST argument, but `;`-free and length-bounded so the
// whole-file view can't pair one call's paren with a distant `, undefined)`.
// Both halves of that bound are approximations, in opposite directions:
//   - a `;` INSIDE a string key (`["a;b", repo]`) ends the run early and the
//     call is missed — the only fail-open here, zero instances today;
//   - `;` is not the only statement boundary, so JSX props or object members
//     within the 200-char window can still pair one call's `(` with another
//     expression's `, undefined)` — a loud false positive, not a miss.
// 200 chars is ~7x headroom: across the 57 call sites under src/, the longest
// first argument measures 27 chars (PR #208 review round 1).
const SET_QUERY_DATA_RE =
  /setQueryData\s*(?:<[^(]*?>)?\s*\([^;]{0,200},\s*undefined\s*[),]/g;

// An inline clip-measured tooltip: a `.title` ASSIGNMENT within PAIR_GAP of an
// overflow measure, in either order. Anchoring on the write — never a bare
// `.title` read — is what keeps data reads (`draft.title` near a
// scroll-to-bottom, measured on PlanView) from pairing; the idiom's direct
// spellings all write `.title` in range of their measure, while setAttribute,
// a hoisted measure, or a JSX `title={…}` prop would evade — a tripwire, not
// a boundary. `(?!=)` keeps `==`/`===` comparisons out.
const INLINE_CLIP_TITLE_RE = new RegExp(
  `\\.title\\s*=(?!=)[\\s\\S]{0,${PAIR_GAP}}?\\b(?:scrollWidth|scrollHeight)\\b` +
    `|\\b(?:scrollWidth|scrollHeight)\\b[\\s\\S]{0,${PAIR_GAP}}?\\.title\\s*=(?!=)`,
  "g",
);

// The superseded Select-row tooltip shapes, both dead once SelectClipText's
// self-bounded span owns the row: a clipTitle handler on — or a hand-rolled
// clip span inside — a SelectItem (the item no longer overflows, so an
// item-level measure can never fire), and the bare `block truncate` child
// (never engages under the shrink-refusing ItemText). The gap is [\s\S], not
// a same-tag [^>] bound, because prop expressions carry `=>` arrows; the
// tempered `(?!</SelectItem\b)` step stops each scan at the item's closing
// tag, so an adjacent picker's trigger handler can never pair across items.
// Accepted evasions: an aliased or wrapped handler, a reordered/interleaved
// class string, a wrapper component around SelectItem, and a bare text child
// with no affordance at all, the shape most converted sites had, which no arm
// can see. The only in-item path row now routes through PathText, whose
// classes live in path-text.tsx and are invisible to these patterns.
const SELECT_ITEM_CLIP_TITLE_RE = new RegExp(
  `<SelectItem\\b(?:(?!</SelectItem\\b)[\\s\\S]){0,${PAIR_GAP}}?\\bclipTitle`,
  "g",
);
const SELECT_ITEM_BLOCK_TRUNCATE_RE = new RegExp(
  `<SelectItem\\b(?:(?!</SelectItem\\b)[\\s\\S]){0,${PAIR_GAP}}?\\bblock truncate\\b`,
  "g",
);
// The flex sibling of that dead span: a `min-w-0 flex-1 truncate` child, equally
// inert unless the item ALSO carries a first-child shrink override — a pairing no
// static pattern can see, so a legal site takes an allowlist entry. The window
// doubles PAIR_GAP for headroom, which 160 alone would not give: the override
// plus the item's own props already put the one live site 150 normalized chars
// from its tag, and a site drifting past a bare-PAIR_GAP window would turn its
// allowlist entry stale rather than report. Reach stays bounded by the tempered
// `(?!</SelectItem\b)` step, which holds only while no SelectItem in src/ is
// self-closing (grep-verified: 67 tags, 67 closers).
const SELECT_ITEM_FLEX_TRUNCATE_RE = new RegExp(
  `<SelectItem\\b(?:(?!</SelectItem\\b)[\\s\\S]){0,${PAIR_GAP * 2}}?` +
    `\\bmin-w-0 flex-1 truncate\\b`,
  "g",
);

// A `.mutate(` call in any spelling — the token, not the callbacks object it
// may carry. Matching the object instead would have to recognize every way one
// reaches the call: inline literal, hoisted variable (`.mutate(v, opts)`),
// spread, shorthand keys. The token has no such surface, and it stays cheap
// because every `.mutate(` left under src/ is a single-argument call in an
// allowlisted file whose hook reports its own failure, or whose failure is
// harmless (a cosmetic preference, a background reconcile); every other
// mutation is awaited.
// `.mutateAsync(` does not match: the `(` must follow `mutate` directly.
const MUTATE_CALL_RE = /\.mutate\s*\(/;

// The dot-less route to the same call: `const { mutate } = useX()` reaches
// `.mutate` off a destructured binding, so the token above never sees it (one
// live site, allowlisted). The `\b` after `mutate` is what keeps
// `{ mutateAsync }` clean, while a renamed `{ mutate: save }` still hits. Run
// over the whole-file view, not per line: a destructure long enough to wrap is a
// shape this codebase already produces, and `[^}]*` can't cross the
// destructure's own closing brace, so the joined view adds no reach.
const DESTRUCTURED_MUTATE_RE = /\bconst\s*\{[^}]*\bmutate\b[^}]*\}\s*=/g;

// The broken shared-ContextMenu suppression: a `setMenu<X>(null)` reset followed
// by a bare `preventDefault()`. Base UI's trigger keeps its own same-element
// bubble listener, so without the `stopPropagation` that `suppressContextMenu`
// carries the menu still opens — as an empty popup whose backdrop swallows the
// next click. A fixed site holds no `preventDefault` token at all, so the helper
// needs no exemption here and a file mixing one fixed and one broken path still
// reports. Two deliberate bounds: `[^}]` keeps the pair inside one block, and
// the order is set-then-prevent. Each leaves a fail-open, zero instances today:
// the reverse order, and a suppression path with no state reset at all.
const CONTEXT_MENU_SUPPRESS_RE =
  /\bset[A-Z]\w*\(\s*null\s*\)[^}]{0,160}?\.preventDefault\s*\(\s*\)/g;

// The superseded disabled-trigger idiom: a reason exposed as `title` on a
// wrapper around a popover/menu trigger whose control is natively disabled —
// hover-only, because a disabled trigger leaves the tab order entirely, so
// keyboard and assistive tech reach neither the control nor its reason.
// Anchoring on the titled WRAPPER rather than on where `disabled` sits is what
// lets one pattern cover both spellings the class shipped in (`disabled` on the
// trigger, and `disabled` inside a plain `<Button/>` render element), and it is
// what excludes the legitimate neighbours structurally instead of by name: a
// titled span around a disabled Input or Switch carries no trigger tag, and a
// menu SUB-trigger keeps its reason in its own label (a disabled item has no
// room for a tooltip), so neither is ever wrapped in one. Sub/Submenu triggers
// are excluded by name as well, pinning that idiom rather than resting on the
// absence of a wrapper. Discriminating on a `Reason`-suffixed value instead
// would have missed sites whose hint was a bare conditional string rather
// than a named reason (the discussions category menu and the branch trigger,
// both since converted).
// The tempered `(?!</)` steps hold the match inside one unclosed element chain,
// so a titled span that already closed cannot pair with a later sibling's
// trigger; the `DisabledReasonButton` step makes the FIXED composition
// unmatchable even where a wrapper survives to carry layout classes. Both
// windows are PAIR_GAP with ~1.4x headroom: across the live sites the widest
// title→trigger run measured 113 normalized chars, the widest trigger→disabled
// 84 (measured at #305, before those sites converted). Accepted evasions, all
// zero-instance today: a hint delivered by something other than `title`, a
// wrapper that is a component rather than a tag, and a `disabled` computed
// too far from the tag.
const TITLED_TRIGGER_DISABLED_RE = new RegExp(
  `title\\s*=(?:(?!</|DisabledReasonButton)[\\s\\S]){0,${PAIR_GAP}}?` +
    `<(?![A-Za-z][\\w.]*Sub(?:menu)?Trigger\\b)[A-Za-z][\\w.]*Trigger\\b` +
    `(?:(?!</|DisabledReasonButton)[\\s\\S]){0,${PAIR_GAP}}?\\bdisabled\\s*=`,
  "g",
);

// A `<Badge>` whose explanation rides a `title` prop — mouse-only, since keyboard,
// touch, and assistive tech never see a title. Bounded to the OPEN TAG rather than
// a two-token proximity pair: badges sit beside clip-titled siblings constantly,
// and a PAIR_GAP window would pair one with the other. The attribute run steps
// over `=>` arrows but stops at any other `>`, and runs over the joined view, so
// a formatter-wrapped tag is one match. The `\s` before `title` keeps
// `subtitle=` and `data-title=` out. Accepted evasions, zero-instance today: an
// attribute value holding JSX or a `>` comparison ahead of the title ends the tag
// early, and a title spread in through `{...props}` is invisible.
const TITLED_BADGE_RE = /<Badge\b(?:=>|[^>=]|=(?!>))*?\stitle\s*=/g;

// Vendored shadcn/Base UI primitives are off-limits to edit (CLAUDE.md), so a
// hit inside them could only ever be silenced by an allowlist entry, never
// fixed. Their CALL SITES — the app code that composes them — stay scanned.
const notVendoredUi = (file) => !file.startsWith("src/components/ui/");

// An effect whose FIRST statement is an `open` guard — the seed-on-open shape,
// in both its spellings (`if (open) …` / `if (!open) return`). Run over the
// whole-file view because the guard sits on the line after the arrow. Matching
// the first statement rather than an `open` read anywhere in the body is what
// keeps this off the many effects that merely gate a query on the same flag.
// Bounded by the identifier: a dialog whose flag is `isOpen` or `show` passes
// unseen, so this catches the house spelling rather than the whole class.
const SEED_ON_OPEN_RE =
  /use(?:Layout)?Effect\(\(\)\s*=>\s*\{\s*if\s*\(!?open\b/g;

// A hand-rolled diff-stat pair: a `text-success` element whose own content opens
// with an interpolated `+` count, within PAIR_GAP of a `text-destructive` one
// opening with a `-` count. Both minus spellings match — the ASCII hyphen the
// canonical sites use and the U+2212 the Insights pair used.
// Unlike the class-name checks above, the two tokens are matched as bare
// substrings rather than through `token()`: the boundary guard would drop
// `text-success/70` and `group-hover:text-destructive`, which are the same idiom
// in a different Tailwind spelling. Requiring each element's own `>` is what
// bounds the false positives instead — a class named far from any count can't
// pair. The run to that `>` is 200 chars because a realistic `cn(...)` list with
// conditional utilities measures 95 (probed while sizing this check); the old
// 60 missed it.
// Three deliberate bounds, zero instances today: the deleted-then-added order is
// not matched, nor is a count rendered through a helper call rather than a brace
// interpolation (`>+{fmt(n)}` matches; `>{plus(n)}` does not), nor one built in a
// template literal (`>{`+${n}`}` — no `+` precedes the brace).
const DIFF_STAT_PAIR_RE = new RegExp(
  `text-success[\\s\\S]{0,200}?>\\s*\\+\\s*\\{[\\s\\S]{0,${PAIR_GAP}}?` +
    `text-destructive[\\s\\S]{0,200}?>\\s*[-−]\\s*\\{`,
  "g",
);

// A conditionally rendered DiffStat: the element as the right operand of
// `&&` / `||` / `??`, or either branch of a ternary, behind any parens. Matched
// by SHAPE, whatever the condition or prop spelling, since each spelling-bound
// form failed open on the next one. Run over ts-mask's masked text so comments
// and strings can neither trigger nor hide a hit. Over-matches loudly (a total
// hidden on its own flag) — such a site takes an allowlist entry.
const CONDITIONAL_DIFF_STAT_RE =
  /(?:&&|\|\||\?\?|\?|:)\s*(?:\(\s*)*<DiffStat\b/g;

/** Scanner for {@link CONDITIONAL_DIFF_STAT_RE}. A file ts-mask can't lex
 *  throws with its path: the check refuses rather than passing unread code. */
const conditionalDiffStat = ({ source }, file) => {
  let masked;
  try {
    masked = maskNonCode(source, true);
  } catch (e) {
    if (e instanceof ScanError)
      throw new Error(
        `list-row-diff-stat-slot: cannot lex ${file ?? "<input>"}: ${e.message}`,
      );
    throw e;
  }
  const hits = new Set();
  for (const m of masked.matchAll(CONDITIONAL_DIFF_STAT_RE))
    hits.add(lineOf(source, m.index));
  return [...hits];
};

// An icon-only copy control built by hand: a `<button>`/`<Button>` whose SOLE
// child is a self-closing `<CopyIcon/>`. Requiring the opening tag's own `>`
// directly before the icon, and the matching close directly after it, is what
// keeps icon+text sites clean (visible text on either side breaks the match).
// Empty `{}` pairs left where stripComments blanked a JSX comment are skipped
// on either side of the icon (`{" "}` and other real expressions still break
// the match). The attribute runs step over `=>` arrows but stop at any other
// `>`, so two evasions stay open, both zero-instance today: an attribute
// holding JSX or a `>` comparison ends the tag early and the site is missed,
// and so is a non-self-closing `<CopyIcon></CopyIcon>`.
const RAW_COPY_ICON_BUTTON_RE =
  /<(button|Button)\b(?:=>|[^>=]|=(?!>))*>\s*(?:\{\s*\}\s*)*<CopyIcon\b(?:=>|[^>=]|=(?!>))*\/>\s*(?:\{\s*\}\s*)*<\/\1>/g;

// A local DEFINITION of the change-kind badge table — the `const KIND_BADGE`
// binding, not a read of the shared one (an import names it without `const`).
// Matched per line: nothing wraps between the keyword and the name. A table
// under a different name is invisible here, so this holds the copy-paste route
// the two duplicates actually took, not the whole class.
const KIND_BADGE_DEF_RE = /\bconst\s+KIND_BADGE\b/;

// Reads "Binary files" as a whole string (line-break escape or `^` leads,
// RegExp() strings too), a template's closing line, or a regex literal (plus
// `[\n]`, `(?<=\n)`, `(?<![^\n])` leads); exact labels and quoted/code-spanned
// mentions trip it: reword or allowlist. Not read: singular "Binary file" (UI
// copy); extra text, other escapes or interpolation in or beside the words;
// split or joined literals; a repeat in an exempt or allowlisted file; and
// lines that stripComments blanks.
const BINARY_MARKER_RE = new RegExp(
  [
    /(["'`])(?:\\{1,2}[nr]|\\x0[aA]|\\u000[aA]|\\u\{0*[aA]\}|\^)*[Bb]inary [Ff]iles ?\1/
      .source,
    /^\s*[Bb]inary [Ff]iles ?`/.source,
    /\/(?:\\[nr]|\\x0[aA]|\\u000[aA]|\\u\{0*[aA]\}|\^|\[\\n\]|\(\?<!\[\^\\n\]\)|\(\?<=\\n\))*[Bb]inary [Ff]iles ?\??\//
      .source,
  ].join("|"),
);

// `<Activity` as a JSX open tag. The lookahead is what separates it from the
// app's own `<ActivityDock>`/`<ActivityBell>`/`<ActivityStrip>` components, and
// comment stripping is what keeps the many prose mentions of `<Activity>` clean.
const ACTIVITY_JSX_RE = /<Activity(?![\w$])/;

// A `fallback` prop whose value is the literal `null`, on any component — the
// converted sites were all Suspense, but an ErrorBoundary-style host trips it
// too; allowlist deliberate cases. Run over the whole-file view because a
// formatter puts the prop on its own line. Two blind spots, no in-repo
// instances: a fallback naming a BINDING that holds null is invisible, and so
// is one built by a conditional — the bare literal is the shape every
// converted site had.
const NULL_FALLBACK_RE = /\bfallback\s*=\s*\{\s*null\s*\}/g;

// ---------------------------------------------------- preparing-slot-hide
// A two-slot host's PREPARING slot hides only by a full clip plus `inert`
// (gd-conventions, 'The preparing-slot rule'). The reader lexes with ts-mask,
// parses statements and expressions tolerantly (only type syntax and module
// clauses are skipped; code it cannot parse is still walked), and tracks which
// slot roles each class expression can apply to, so negations, `&&` chains
// and `!== "shown"` resolve by role. Only slot context is analysed: a file
// naming the slot vocabulary, or a slot-shaped map.

/** The slot roles: the members of EntitySlotRole and SlotPhase, pinned equal
 *  to both unions by scripts/checks.test.mjs. */
export const SLOT_ROLES = ["held", "preparing", "shown"];
const ROLE_BITS = new Map(SLOT_ROLES.map((role, i) => [role, 1 << i]));
const ALL_ROLES = (1 << SLOT_ROLES.length) - 1;
const PREPARING = ROLE_BITS.get("preparing");
/** Names that read as the preparing flag (`isPreparing`, `slot.preparing`). */
const FLAG_NAMES = new Set(["preparing", "isPreparing"]);
const CLASS_COMBINERS = new Set(["cn", "clsx", "cx", "classNames", "twMerge"]);
/** Identifiers that contribute no class and need no resolving. */
const INERT_IDS = new Set(["undefined", "null", "true", "false"]);
/** Files whose text can hold no site skip the parse (they are still lexed):
 *  every site needs a role literal, a flag, or the host vocabulary. */
const SLOT_CANDIDATE_RE =
  /preparing|Preparing|["'`](?:held|shown)["'`]|EntitySlotRole|EntityHoldSlot|SlotPhase|entityHoldSlots/;
const SLOT_HOST_VOCABULARY = new Set([
  "EntitySlotRole",
  "SlotPhase",
  "entityHoldSlots",
  "EntityHoldSlot",
]);
const SLOT_CLIP = "[clip-path:inset(50%)]";
/** Tailwind 4.3.3's own utilities that set `clip-path` (both set it beside
 *  their 1px or static box); every other clip-path token is an arbitrary
 *  `[clip-path:…]` or `[-webkit-clip-path:…]` property. */
const CLIP_PATH_UTILITIES = new Set(["sr-only", "not-sr-only"]);
/** What DOM class parsing splits on: ASCII whitespace only. */
const CLASS_SEPARATOR = /[\t\n\f\r ]+/;
const LINE_TERMINATORS = new Set([
  "\n",
  "\r",
  String.fromCharCode(0x2028),
  String.fromCharCode(0x2029),
]);

/** A string or template literal's raw source body cooked as JS reads it,
 *  through cookStringBody. That helper reads the joined view, where a line
 *  continuation is a backslash before a space; raw source spells it as a
 *  backslash before a line terminator, and a backslash-escaped space is just a
 *  space, so both are rewritten into its terms first. */
function cookLiteral(raw) {
  let body = "";
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "\\") {
      body += raw[i];
      continue;
    }
    const next = raw[i + 1] ?? "";
    if (next === "\r" && raw[i + 2] === "\n") {
      body += "\\ ";
      i += 2;
    } else if (LINE_TERMINATORS.has(next)) {
      body += "\\ ";
      i++;
    } else if (next === " ") {
      body += "\\x20";
      i++;
    } else {
      body += `\\${next}`;
      i++;
    }
  }
  return cookStringBody(body);
}

/** Arbitrary properties that set or reset `clip-path`. */
const CLIP_DEFEATING_PROPERTIES = new Set(["clip-path", "-webkit-clip-path", "all"]);
/** Whether a utility is an arbitrary property that sets or resets
 *  `clip-path`. The property name is lowercased first: CSS names are
 *  case-insensitive, and Tailwind emits `[cLIP-PATH:none]` (a name starting
 *  `-` or a-z) as a working rule. */
function clipDefeating(utility) {
  const property = /^\[([^:\]]+):/.exec(utility);
  return property !== null && CLIP_DEFEATING_PROPERTIES.has(property[1].toLowerCase());
}
/** Whether a plain class string's only clip-path token is the bare clip: no
 *  variant, the `!` marker at one end at most, an arbitrary value's
 *  `!important` stripped. An `[all:…]` token resets clip-path as well, so it
 *  counts as a second clip-path token, and so do `sr-only`/`not-sr-only`. */
function soleBareClip(text) {
  const clips = text
    .split(CLASS_SEPARATOR)
    .filter(Boolean)
    .map((token) => ({ token, ...splitClassToken(token) }))
    .map((c) => ({ ...c, utility: c.utility.replace(/_?!important\]$/, "]") }))
    .filter(
      (c) => clipDefeating(c.utility) || CLIP_PATH_UTILITIES.has(c.utility),
    );
  if (clips.length !== 1) return false;
  const [{ token, variants, utility }] = clips;
  const bothEnds = token.startsWith("!") && token.endsWith("!");
  return variants.length === 0 && utility === SLOT_CLIP && !bothEnds;
}
/** Whether a class token is an arbitrary property that sets or resets
 *  clip-path, with any variant or `!` marker. */
const arbitraryClipPath = (token) =>
  clipDefeating(splitClassToken(token).utility);

/** A string, or a template with no interpolation: its cooked text. */
function cookedLiteralText(node) {
  const n = unwrapSlot(node);
  if (n?.k === "str") return n.text;
  if (n?.k === "tpl" && n.exprs.length === 0) return n.texts[0];
  return undefined;
}
/** The slot role a member key names, read cooked. A computed key resolves
 *  to a literal, directly or through `resolve` along a chain of same-file
 *  consts; a cycle or any other computed key is `unreadable`. */
function keyRole(key, resolve) {
  if (key.kind !== "computed")
    return { role: ROLE_BITS.get(key.text), unreadable: false };
  let n = unwrapSlot(key.node);
  const seen = new Set();
  while (n?.k === "id") {
    if (seen.has(n.name)) return { role: undefined, unreadable: true };
    seen.add(n.name);
    n = unwrapSlot(resolve(n.name));
  }
  const text = cookedLiteralText(n);
  if (text === undefined) return { role: undefined, unreadable: true };
  return { role: ROLE_BITS.get(text), unreadable: false };
}

/** The five XML named character references; JSX decodes these and numeric
 *  ones in attribute strings. */
const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
/** A JSX attribute string's text: no backslash escapes, but HTML character
 *  references decode. A numeric reference or one of the five XML names is
 *  read; any other reference is `unknown`, and fails closed in slot context. */
function decodeJsxEntities(raw) {
  let unknown = false;
  const text = raw.replace(
    /&(#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g,
    (whole, ref) => {
      if (ref[0] === "#") {
        const hex = ref[1] === "x" || ref[1] === "X";
        const code = hex ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1));
        if (code <= 0x10ffff) return String.fromCodePoint(code);
      } else if (Object.hasOwn(XML_ENTITIES, ref)) return XML_ENTITIES[ref];
      unknown = true;
      return whole;
    },
  );
  return { text, unknown };
}
const SLOT_HIDE_EXACT = new Set([
  "invisible",
  "collapse",
  "[visibility:hidden]",
  "[visibility:collapse]",
  "hidden",
  "[display:none]",
  "[content-visibility:hidden]",
]);

/** A class token split at its top-level `:` into variant segments and the
 *  utility, the `!` important marker stripped from either end. */
function splitClassToken(cls) {
  const variants = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < cls.length; i++) {
    if (cls[i] === "[") depth++;
    else if (cls[i] === "]") depth--;
    else if (cls[i] === ":" && depth === 0) {
      variants.push(cls.slice(start, i));
      start = i + 1;
    }
  }
  return { variants, utility: cls.slice(start).replace(/^!|!$/g, "") };
}

/** Whether an arbitrary opacity may be below full: a number under 1, a
 *  percentage under 100, or anything the scan cannot read (`var(…)`). */
function partialOpacity(value) {
  const percent = /^(\d*\.?\d+)%$/.exec(value);
  if (percent) return Number(percent[1]) < 100;
  if (/^\d*\.?\d+$/.test(value)) return Number(value) < 1;
  return true;
}

/** Whether a utility hides: visibility, opacity below full, display, or
 *  `sr-only`'s 1px box. An arbitrary value's `!important` is stripped first,
 *  and a value the scan cannot read hides: Tailwind v4's `opacity-(--x)`
 *  variable shorthand, and a visibility or display value that is not a plain
 *  keyword. `srOnly` false reads `sr-only` as screen-reader text, not a hide:
 *  only the slot's own classes (a map entry, a class-position arm) count it. */
function isSlotHide(raw, srOnly = true) {
  const utility = raw.replace(/_?!important\]$/, "]");
  // `sr-only` collapses the slot to 1px, so it never lays out at full size.
  if (utility === "sr-only") return srOnly;
  if (SLOT_HIDE_EXACT.has(utility)) return true;
  if (/^opacity-\(.*\)$/.test(utility)) return true;
  const property = /^\[(?:content-)?(?:visibility|display):(.*)\]$/.exec(utility);
  if (property && !/^[a-z-]+$/.test(property[1])) return true;
  const scale = /^opacity-(\d+)$/.exec(utility);
  if (scale) return Number(scale[1]) < 100;
  const arbitrary = /^(?:opacity-\[|\[opacity:)(.*)\]$/.exec(utility);
  return arbitrary !== null && partialOpacity(arbitrary[1]);
}

/** The class tokens of a literal's text. */
const classTokens = (text) => text.split(/\s+/).filter(Boolean);
const textHides = (text, srOnly = true) =>
  classTokens(text).some((cls) =>
    isSlotHide(splitClassToken(cls).utility, srOnly),
  );

/** Punctuators, longest first. `>` is always one token (generics close with
 *  it), so the parser re-joins `>=` and shifts from adjacent tokens. */
const SLOT_PUNCTUATORS = [
  "...",
  "===",
  "!==",
  "**=",
  "<<=",
  "&&=",
  "||=",
  "??=",
  "=>",
  "==",
  "!=",
  "<=",
  "&&",
  "||",
  "??",
  "?.",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "**",
  "<<",
];
const SLOT_IDENT_RE = /[\p{ID_Start}$_#][\p{ID_Continue}$\u200c\u200d]*/uy;
const SLOT_NUMBER_RE =
  /(?:0[xXoObB][\da-fA-F_]+n?|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?n?|\.\d[\d_]*(?:[eE][+-]?\d+)?)/y;

/**
 * Tokens of `source`, read over ts-mask's `masked` text (comment, string,
 * template, regex and JSX text bodies blanked), so the same decisions ts-mask
 * made locate every literal. A template is one token (its quasis plus each
 * interpolation's tokens), and so is a JSX element (attributes and children).
 */
function lexSlotTokens(source, masked, jsx) {
  const fail = (what, at) => {
    throw new ScanError(`${what} at line ${lineOf(source, at)}`);
  };
  const ws = (i) => {
    while (i < masked.length && /\s/.test(masked[i])) i++;
    return i;
  };
  const exprStartAt = (i) => {
    let k = i - 1;
    while (k >= 0 && /\s/.test(masked[k])) k--;
    if (k < 0) return true;
    if (/[\w$]/.test(masked[k])) {
      let s = k;
      while (s > 0 && /[\w$]/.test(masked[s - 1])) s--;
      return EXPR_KEYWORDS.has(masked.slice(s, k + 1));
    }
    return EXPR_OPENERS.has(masked[k]);
  };
  const quotedEnd = (i) => {
    const end = masked.indexOf(masked[i], i + 1);
    if (end === -1) fail("unterminated string", i);
    return end;
  };

  function template(start) {
    const quasis = [];
    const exprs = [];
    let from = start + 1;
    for (let i = start + 1; i < masked.length; i++) {
      if (masked[i] === "`") {
        quasis.push(source.slice(from, i));
        return { t: "tpl", s: start, e: i + 1, quasis, exprs };
      }
      if (masked[i] === "$" && masked[i + 1] === "{") {
        quasis.push(source.slice(from, i));
        const inner = code(i + 2, true);
        exprs.push(inner.toks);
        i = inner.end;
        from = i + 1;
      }
    }
    return fail("unterminated template literal", start);
  }

  /** A JSX element at `start`, or null for a TS generic's `<T,>`. */
  function element(start) {
    let i = ws(start + 1);
    const name = /[\w$.:-]*/y;
    name.lastIndex = i;
    const tag = name.exec(masked)[0];
    i += tag.length;
    if (tag && /^\s*(,|extends\b)/.test(masked.slice(i, i + 40))) return null;
    if (tag && masked[i] === "<") {
      let depth = 0;
      for (; i < masked.length; i++) {
        if (masked[i] === "<") depth++;
        else if (masked[i] === ">" && masked[i - 1] !== "=" && --depth === 0)
          break;
      }
      if (depth !== 0) fail("unreadable JSX type arguments", start);
      i++;
    }
    const attrs = [];
    for (;;) {
      i = ws(i);
      const c = masked[i];
      if (c === "/" && masked[i + 1] === ">")
        return { t: "jsx", s: start, e: i + 2, attrs, children: [] };
      if (c === ">") break;
      if (!tag || i >= masked.length) fail("unreadable JSX tag", start);
      if (c === "{") {
        const inner = code(i + 1, true);
        attrs.push({ spread: inner.toks, s: i });
        i = inner.end + 1;
        continue;
      }
      const attrName = /[\w$:-]+/y;
      attrName.lastIndex = i;
      const m = attrName.exec(masked);
      if (!m) fail("unreadable JSX attribute", i);
      const attr = { name: m[0], s: i, value: null };
      i = ws(i + m[0].length);
      if (masked[i] === "=") {
        i = ws(i + 1);
        if (masked[i] === '"' || masked[i] === "'") {
          const end = quotedEnd(i);
          attr.value = { t: "str", s: i, e: end + 1, v: source.slice(i + 1, end) };
          i = end + 1;
        } else if (masked[i] === "{") {
          const inner = code(i + 1, true);
          attr.value = { t: "expr", s: i, e: inner.end + 1, toks: inner.toks };
          i = inner.end + 1;
        } else if (masked[i] === "<") {
          attr.value = element(i) ?? fail("unreadable JSX attribute", i);
          i = attr.value.e;
        } else fail("unreadable JSX attribute value", i);
      }
      attrs.push(attr);
    }
    const children = [];
    for (i++; i < masked.length; ) {
      if (masked[i] === "{") {
        const inner = code(i + 1, true);
        children.push({ t: "expr", s: i, e: inner.end + 1, toks: inner.toks });
        i = inner.end + 1;
      } else if (masked[i] === "<") {
        const next = ws(i + 1);
        if (masked[next] === "/") {
          const end = masked.indexOf(">", next);
          if (end === -1) fail("unterminated JSX closing tag", i);
          return { t: "jsx", s: start, e: end + 1, attrs, children };
        }
        const child = element(i) ?? fail("unreadable JSX child", i);
        children.push(child);
        i = child.e;
      } else i++;
    }
    return fail("unterminated JSX element", start);
  }

  /** Tokens from `i`; inside a `${…}` or JSX `{…}` (`inExpr`) it stops at the
   *  `}` closing the expression and returns its index as `end`. */
  function code(i, inExpr) {
    const toks = [];
    let depth = 0;
    let nl = false;
    const push = (tok) => {
      tok.nl = nl;
      nl = false;
      toks.push(tok);
      return tok.e;
    };
    while (i < masked.length) {
      const c = masked[i];
      if (c === "\n") {
        nl = true;
        i++;
      } else if (/\s/.test(c)) {
        i++;
      } else if (c === '"' || c === "'") {
        const end = quotedEnd(i);
        i = push({ t: "str", s: i, e: end + 1, v: source.slice(i + 1, end) });
      } else if (c === "`") {
        i = push(template(i));
      } else if (c === "/" && exprStartAt(i)) {
        const end = masked.indexOf("/", i + 1);
        if (end === -1) fail("unterminated regex literal", i);
        let k = end + 1;
        while (k < masked.length && /[a-z]/i.test(masked[k])) k++;
        i = push({ t: "regex", s: i, e: k });
      } else {
        const el = jsx && c === "<" && exprStartAt(i) ? element(i) : null;
        if (el) {
          i = push(el);
          continue;
        }
        if (inExpr && c === "}" && depth === 0) {
          return { toks, end: i };
        }
        if (inExpr && c === "{") depth++;
        else if (inExpr && c === "}") depth--;
        SLOT_IDENT_RE.lastIndex = i;
        SLOT_NUMBER_RE.lastIndex = i;
        const id = SLOT_IDENT_RE.exec(masked);
        const num = !id && /[\d.]/.test(c) ? SLOT_NUMBER_RE.exec(masked) : null;
        if (id) {
          i = push({ t: "id", s: i, e: i + id[0].length, v: id[0] });
        } else if (num && num[0] !== ".") {
          i = push({ t: "num", s: i, e: i + num[0].length, v: num[0] });
        } else {
          let p = SLOT_PUNCTUATORS.find((x) => masked.startsWith(x, i)) ?? c;
          if (p === "?." && /\d/.test(masked[i + 2] ?? "")) p = "?";
          i = push({ t: "punct", s: i, e: i + p.length, v: p });
        }
      }
    }
    if (inExpr) fail("unterminated `{…}` expression", i);
    return { toks, end: i };
  }

  return code(0, false).toks;
}

const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = { "(": ")", "[": "]", "{": "}" };
const bracketCache = new WeakMap();

/** Each bracket token's partner index in `toks`. */
function bracketMatches(toks) {
  let m = bracketCache.get(toks);
  if (m) return m;
  m = new Map();
  const stack = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t !== "punct") continue;
    if (OPENERS.has(t.v)) stack.push(i);
    else if (t.v === ")" || t.v === "]" || t.v === "}") {
      const open = stack.pop();
      if (open === undefined || CLOSERS[toks[open].v] !== t.v)
        throw Object.assign(new ScanError(`unbalanced \`${t.v}\``), { at: t.s });
      m.set(open, i);
      m.set(i, open);
    }
  }
  if (stack.length > 0) {
    const open = toks[stack[0]];
    throw Object.assign(new ScanError(`unclosed \`${open.v}\``), { at: open.s });
  }
  bracketCache.set(toks, m);
  return m;
}

const ASSIGN_OPS = new Set([
  "=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "**=",
  "<<=",
  "&=",
  "|=",
  "^=",
  "&&=",
  "||=",
  "??=",
]);
const BINARY_PRECEDENCE = {
  "??": 1,
  "||": 1,
  "&&": 2,
  "|": 3,
  "^": 4,
  "&": 5,
  "==": 6,
  "!=": 6,
  "===": 6,
  "!==": 6,
  "<": 7,
  ">": 7,
  "<=": 7,
  ">=": 7,
  instanceof: 7,
  in: 7,
  "<<": 8,
  ">>": 8,
  ">>>": 8,
  "+": 9,
  "-": 9,
  "*": 10,
  "/": 10,
  "%": 10,
  "**": 11,
};
const EQUALITY_OPS = new Set(["===", "==", "!==", "!="]);
const MEMBER_MODIFIERS = new Set([
  "public",
  "private",
  "protected",
  "static",
  "readonly",
  "abstract",
  "override",
  "declare",
  "accessor",
]);
const TYPE_PREFIXES = new Set([
  "keyof",
  "typeof",
  "readonly",
  "unique",
  "infer",
  "asserts",
]);
const UNARY_KEYWORDS = new Set(["typeof", "void", "delete", "await"]);
/** Import-clause words that bind nothing. */
const IMPORT_WORDS = new Set(["type", "typeof", "as", "from", "with", "assert"]);
/** Statement kinds: each child is its own mention extent. */
const SLOT_STATEMENTS = new Set([
  "block",
  "if",
  "switch",
  "loop",
  "func",
  "try",
  "labeled",
]);

/**
 * A tolerant recursive-descent parser over one token array (a range of it).
 * Only type syntax and module clauses are skipped (annotations, `as`,
 * generics, interfaces, type aliases, `declare`, `implements`, import and
 * export clauses), so a type literal never reads as an object. Every other
 * region is parsed (decorators, enum initializers, pattern defaults and the
 * `extends` expression included), and anything it cannot parse becomes an
 * `opaque` node whose bracket groups are still parsed and walked. `decls`
 * collects every binding's kind.
 */
class SlotParser {
  constructor(toks, from, to, decls) {
    this.toks = toks;
    this.p = from;
    this.end = to;
    this.m = bracketMatches(toks);
    this.decls = decls;
  }
  sub(from, to) {
    return new SlotParser(this.toks, from, to, this.decls);
  }
  peek(k = 0) {
    const i = this.p + k;
    return i < this.end ? this.toks[i] : null;
  }
  is(v, k = 0) {
    const t = this.peek(k);
    return t !== null && t.t === "punct" && t.v === v;
  }
  isId(v, k = 0) {
    const t = this.peek(k);
    return t !== null && t.t === "id" && (v === undefined || t.v === v);
  }
  last() {
    return this.toks[this.p - 1].e;
  }
  close() {
    return this.m.get(this.p);
  }
  semi() {
    if (this.is(";")) this.p++;
  }
  /** Skips a bracket group at `p`, returning its close index. */
  skipGroup() {
    const close = this.close();
    this.p = close + 1;
    return close;
  }

  statements() {
    const out = [];
    while (this.p < this.end) {
      const before = this.p;
      const s = this.statement();
      if (s) out.push(s);
      if (this.p === before) out.push(this.skipOne());
    }
    return out;
  }
  stmtOrSkip() {
    if (this.p >= this.end) return null;
    const before = this.p;
    const s = this.statement();
    return this.p === before ? this.skipOne() : s;
  }
  /** One token the grammar couldn't place: a bracket group is parsed as
   *  statements so its contents are still walked. */
  skipOne() {
    const t = this.peek();
    if (t.t === "punct" && OPENERS.has(t.v)) {
      const close = this.close();
      const children = this.sub(this.p + 1, close).statements();
      this.p = close + 1;
      return { k: "opaque", s: t.s, e: this.last(), children };
    }
    this.p++;
    const node = this.tokenNode(t);
    return node ?? { k: "opaque", s: t.s, e: t.e, children: [] };
  }
  tokenNode(t) {
    if (t.t === "str")
      return { k: "str", v: t.v, text: cookLiteral(t.v), s: t.s, e: t.e };
    if (t.t === "tpl") return this.templateNode(t);
    if (t.t === "jsx") return this.jsxNode(t);
    if (t.t === "id") return { k: "id", name: t.v, s: t.s, e: t.e };
    if (t.t === "num" || t.t === "regex") return { k: t.t, s: t.s, e: t.e };
    return null;
  }

  statement() {
    const t = this.peek();
    if (t.t === "punct") {
      if (t.v === ";") {
        this.p++;
        return null;
      }
      if (t.v === "{") return this.block();
      if (t.v === "@") {
        const expr = this.decorator();
        return expr && { k: "expr", expr, s: expr.s, e: expr.e };
      }
    }
    if (t.t === "id") {
      const n1 = this.peek(1);
      switch (t.v) {
        case "import":
          if (this.is("(", 1) || this.is(".", 1)) break;
          this.skipModuleClause(true);
          return null;
        case "export":
          this.p++;
          if (this.isId("default")) {
            this.p++;
            const expr = this.assign();
            this.semi();
            return expr && { k: "expr", expr, s: expr.s, e: expr.e };
          }
          if (this.isId("type") && this.is("{", 1)) this.p++;
          if (this.is("{") || this.is("*")) {
            this.skipModuleClause();
            return null;
          }
          if (this.is("=")) this.p++;
          return this.p < this.end ? this.stmtOrSkip() : null;
        case "interface":
          if (n1?.t !== "id") break;
          while (this.p < this.end && !this.is("{")) {
            if (this.is("<")) this.skipAngles();
            else this.p++;
          }
          if (this.is("{")) this.skipGroup();
          return null;
        case "type":
          if (n1?.t !== "id" || !(this.is("=", 2) || this.is("<", 2))) break;
          this.p += 2;
          if (this.is("<")) this.skipAngles();
          if (this.is("=")) this.p++;
          this.skipType();
          this.semi();
          return null;
        case "declare":
          if (n1?.t !== "id") break;
          this.skipDeclare();
          return null;
        case "enum":
          if (n1?.t !== "id") break;
          return this.enumNode();
        case "namespace":
        case "module":
          if (n1?.t !== "id" && n1?.t !== "str") break;
          this.p++;
          while (this.p < this.end && !this.is("{")) this.p++;
          return this.p < this.end ? this.block() : null;
        case "abstract":
          if (!this.isId("class", 1)) break;
          this.p++;
          return this.classNode();
        case "const":
          if (this.isId("enum", 1)) {
            this.p++;
            return this.enumNode();
          }
          return this.varDecl();
        case "let":
        case "var":
          if (n1?.t === "id" || this.is("{", 1) || this.is("[", 1))
            return this.varDecl();
          break;
        case "function":
          return this.functionNode();
        case "async":
          if (!this.isId("function", 1)) break;
          this.p++;
          return this.functionNode();
        case "class":
          return this.classNode();
        case "if":
          return this.ifStatement();
        case "switch":
          return this.switchStatement();
        case "for":
        case "while":
          return this.loopStatement();
        case "do": {
          this.p++;
          const body = this.stmtOrSkip();
          const node = { k: "loop", head: [], test: null, body, s: t.s };
          if (this.isId("while") && this.is("(", 1)) {
            this.p++;
            node.test = this.groupExpression();
          }
          this.semi();
          node.e = this.last();
          return node;
        }
        case "try": {
          this.p++;
          const body = [];
          while (this.p < this.end) {
            if (this.is("{")) body.push(this.block());
            else if (this.isId("catch") || this.isId("finally")) {
              this.p++;
              if (this.is("(")) {
                body.push(...this.bindingNames(this.p + 1, this.close()));
                this.skipGroup();
              }
            } else break;
          }
          return { k: "try", body, s: t.s, e: this.last() };
        }
        case "return":
        case "throw": {
          this.p++;
          const n = this.peek();
          const arg =
            n && !n.nl && !this.is(";") && !this.is("}")
              ? this.expression()
              : null;
          this.semi();
          return { k: "return", arg, s: t.s, e: this.last() };
        }
        case "break":
        case "continue":
          this.p++;
          let label = null;
          if (this.isId() && !this.peek().nl) label = this.toks[this.p++].v;
          this.semi();
          return { k: "jump", label, s: t.s, e: this.last() };
      }
      if (this.is(":", 1) && !EXPR_KEYWORDS.has(t.v)) {
        this.p += 2;
        const body = this.stmtOrSkip();
        return { k: "labeled", label: t.v, body, s: t.s, e: this.last() };
      }
    }
    const expr = this.expression();
    if (!expr) return null;
    this.semi();
    return { k: "expr", expr, s: expr.s, e: expr.e };
  }
  block() {
    const t = this.peek();
    const close = this.close();
    const body = this.sub(this.p + 1, close).statements();
    this.p = close + 1;
    return { k: "block", body, s: t.s, e: this.last() };
  }
  /** An import or re-export clause, through its module specifier. An import
   *  notes every name in its clause as a binding (a renamed specifier's
   *  exported name too, which only makes resolution stricter). */
  skipModuleClause(importing = false) {
    this.p++;
    const note = (t) => {
      if (importing && t.t === "id" && !IMPORT_WORDS.has(t.v))
        this.decls.note(t.v, null);
    };
    while (this.p < this.end && !this.is(";")) {
      const t = this.peek();
      if (t.t === "punct" && OPENERS.has(t.v)) {
        const close = this.close();
        for (let i = this.p + 1; i < close; i++) note(this.toks[i]);
        this.skipGroup();
        if (!this.isId("from") && !this.isId("as")) break;
        continue;
      }
      this.p++;
      note(t);
      if (t.t === "str") {
        if (this.isId("with") || this.isId("assert")) {
          this.p++;
          if (this.is("{")) this.skipGroup();
        }
        break;
      }
    }
    this.semi();
  }
  skipDeclare() {
    while (this.p < this.end && !this.is(";")) {
      if (this.is("{")) {
        this.skipGroup();
        if (!this.is("[") && !this.is("|") && !this.is("&")) return;
        continue;
      }
      if (this.is("(") || this.is("[")) this.skipGroup();
      else this.p++;
    }
    this.semi();
  }
  /** An enum: its member initializers are code, parsed and walked. */
  enumNode() {
    const start = this.peek().s;
    while (this.p < this.end && !this.is("{")) this.p++;
    if (!this.is("{")) return null;
    const close = this.close();
    const children = this.sub(this.p + 1, close).statements();
    this.p = close + 1;
    return { k: "opaque", s: start, e: this.last(), children };
  }
  /** A decorator's expression, kept so it is walked like any other code. */
  decorator() {
    this.p++;
    return this.postfix();
  }
  /** Notes the names one binding target at `p` binds (an identifier or a
   *  destructuring pattern, nested ones included), stopping before its own
   *  annotation or default. Returns the pattern's inner default values and
   *  computed keys, which are code. */
  bindingTarget() {
    if (this.isId()) {
      this.decls.note(this.peek().v, null);
      this.p++;
      return [];
    }
    if (!this.is("{") && !this.is("[")) return [];
    const object = this.is("{");
    const close = this.close();
    const q = this.sub(this.p + 1, close);
    this.p = close + 1;
    const code = [];
    while (q.p < q.end) {
      if (q.is(",")) {
        q.p++;
        continue;
      }
      if (q.is("...")) {
        q.p++;
        code.push(...q.bindingTarget());
      } else if (object) {
        const key = q.propertyKey();
        if (key?.kind === "computed") code.push(key.node);
        if (key && q.is(":")) {
          q.p++;
          code.push(...q.bindingTarget());
        } else if (key?.kind === "id") q.decls.note(key.name, null);
      } else code.push(...q.bindingTarget());
      if (q.is("=")) {
        q.p++;
        const value = q.assign();
        if (value) code.push(value);
      }
      while (q.p < q.end && !q.is(",")) code.push(q.skipOne());
    }
    return code.filter(Boolean);
  }
  /** The names a binding range [from, to) binds (a catch clause's). */
  bindingNames(from, to) {
    return this.sub(from, to).bindingTarget();
  }
  varDecl() {
    const kw = this.peek();
    this.p++;
    const decls = [];
    while (this.p < this.end) {
      let name = null;
      if (this.isId()) {
        name = this.peek().v;
        this.p++;
      } else if (this.is("{") || this.is("[")) {
        for (const init of this.bindingTarget()) decls.push({ name, init });
      } else break;
      if (this.is("!")) this.p++;
      if (this.is(":")) {
        this.p++;
        this.skipType();
      }
      let init = null;
      if (this.is("=")) {
        this.p++;
        init = this.assign();
      }
      if (name !== null) this.decls.note(name, kw.v === "const" ? init : null);
      decls.push({ name, init });
      if (!this.is(",")) break;
      this.p++;
    }
    this.semi();
    return { k: "var", decls, s: kw.s, e: this.last() };
  }
  /** A parameter list's range; returns its default-value expressions. */
  params(from, to) {
    const q = this.sub(from, to);
    const defaults = [];
    while (q.p < q.end) {
      if (q.is(",")) {
        q.p++;
        continue;
      }
      while (q.is("@")) {
        const d = q.decorator();
        if (d) defaults.push(d);
      }
      while (
        q.isId() &&
        MEMBER_MODIFIERS.has(q.peek().v) &&
        (q.peek(1)?.t === "id" || q.is("{", 1) || q.is("[", 1))
      )
        q.p++;
      if (q.is("...")) q.p++;
      if (q.is("{") || q.is("[") || q.isId()) defaults.push(...q.bindingTarget());
      else {
        q.p++;
        continue;
      }
      if (q.is("?")) q.p++;
      if (q.is(":")) {
        q.p++;
        q.skipType();
      }
      if (q.is("=")) {
        q.p++;
        const d = q.assign();
        if (d) defaults.push(d);
      }
      while (q.p < q.end && !q.is(",")) q.p++;
    }
    return defaults;
  }
  /** After a method or function name: generics, params, return type, body. */
  callableRest(start) {
    if (this.is("<")) this.skipAngles();
    let defaults = [];
    if (this.is("(")) {
      const close = this.close();
      defaults = this.params(this.p + 1, close);
      this.p = close + 1;
    }
    if (this.is(":")) {
      this.p++;
      this.skipType();
    }
    const body = this.is("{") ? this.block() : null;
    if (!body) this.semi();
    return { k: "func", defaults, body, s: start, e: this.last() };
  }
  functionNode() {
    const start = this.peek().s;
    this.p++;
    if (this.is("*")) this.p++;
    if (this.isId()) {
      this.decls.note(this.peek().v, null);
      this.p++;
    }
    return this.callableRest(start);
  }
  classNode() {
    const start = this.peek().s;
    this.p++;
    if (this.isId() && !this.isId("extends") && !this.isId("implements")) {
      this.decls.note(this.peek().v, null);
      this.p++;
    }
    // The `extends` expression is code; type parameters and `implements`
    // lists are types.
    const heritage = [];
    while (this.p < this.end && !this.is("{")) {
      if (this.isId("extends")) {
        this.p++;
        const base = this.postfix();
        if (base) heritage.push({ kind: "junk", value: base });
      } else if (this.is("<")) this.skipAngles();
      else if (this.is("(") || this.is("[")) this.skipGroup();
      else this.p++;
    }
    if (!this.is("{"))
      return { k: "class", members: heritage, s: start, e: this.last() };
    const close = this.close();
    const members = [
      ...heritage,
      ...this.sub(this.p + 1, close).classMembers(),
    ];
    this.p = close + 1;
    return { k: "class", members, s: start, e: this.last() };
  }
  /** Whether a property key starts at offset `k`. */
  keyAhead(k) {
    const t = this.peek(k);
    if (t === null) return false;
    if (t.t === "id" || t.t === "str" || t.t === "num") return true;
    return t.t === "punct" && (t.v === "[" || t.v === "*");
  }
  propertyKey() {
    const t = this.peek();
    if (t === null) return null;
    if (t.t === "id" || t.t === "str" || t.t === "num") {
      this.p++;
      const kind = t.t === "id" ? "id" : t.t;
      const text = t.t === "str" ? cookLiteral(t.v) : t.v;
      return { kind, name: t.v, text, s: t.s, e: t.e };
    }
    if (t.t === "tpl") {
      this.p++;
      return { kind: "computed", node: this.templateNode(t), s: t.s, e: t.e };
    }
    if (this.is("[")) {
      const close = this.close();
      const node = this.expressionIn(this.p + 1, close);
      this.p = close + 1;
      return { kind: "computed", node, s: t.s, e: this.last() };
    }
    return null;
  }
  classMembers() {
    const members = [];
    while (this.p < this.end) {
      const before = this.p;
      if (this.is(";") || this.is(",")) {
        this.p++;
        continue;
      }
      while (this.is("@")) members.push({ kind: "junk", value: this.decorator() });
      while (this.isId() && MEMBER_MODIFIERS.has(this.peek().v) && this.keyAhead(1))
        this.p++;
      if (this.isId("static") && this.is("{", 1)) {
        this.p++;
        members.push({ kind: "block", body: this.block() });
        continue;
      }
      // An index signature, `[key: string]: T`.
      if (this.is("[") && this.peek(1)?.t === "id" && this.is(":", 2)) {
        this.skipGroup();
        if (this.is(":")) {
          this.p++;
          this.skipType();
        }
        this.semi();
        continue;
      }
      const member = this.member(true);
      if (member) members.push(member);
      if (this.p === before) members.push({ kind: "junk", value: this.skipOne() });
    }
    return members;
  }
  /** One object or class member: `kind` is init, shorthand, method, get, set
   *  or spread; `value` is its expression, `body` a callable's node. */
  member(inClass) {
    const start = this.peek();
    if (this.is("...")) {
      this.p++;
      return { kind: "spread", value: this.assign(), s: start.s };
    }
    let kind = "init";
    if ((this.isId("get") || this.isId("set")) && this.keyAhead(1)) {
      kind = this.peek().v;
      this.p++;
    } else if (this.isId("async") && this.keyAhead(1) && !this.peek(1).nl) {
      kind = "method";
      this.p++;
    }
    if (this.is("*")) {
      kind = "method";
      this.p++;
    }
    const key = this.propertyKey();
    if (!key) return null;
    if (this.is("?") || (inClass && this.is("!"))) this.p++;
    if (this.is("(") || this.is("<")) {
      const body = this.callableRest(key.s);
      return { kind: kind === "init" ? "method" : kind, key, body, s: key.s };
    }
    if (inClass) {
      if (this.is(":")) {
        this.p++;
        this.skipType();
      }
      let value = null;
      if (this.is("=")) {
        this.p++;
        value = this.assign();
      }
      this.semi();
      return { kind: "init", key, value, s: key.s };
    }
    if (this.is(":")) {
      this.p++;
      return { kind: "init", key, value: this.assign(), s: key.s };
    }
    if (this.is("=")) {
      this.p++;
      this.assign();
    }
    if (key.kind !== "id") return { kind: "junk", value: null, s: key.s };
    const value = { k: "id", name: key.name, s: key.s, e: key.e };
    return { kind: "shorthand", key, value, s: key.s };
  }
  objectMembers() {
    const members = [];
    while (this.p < this.end) {
      if (this.is(",")) {
        this.p++;
        continue;
      }
      const before = this.p;
      const member = this.member(false);
      if (member) members.push(member);
      if (this.p === before) members.push({ kind: "junk", value: this.skipOne() });
      else if (!this.is(",") && this.p < this.end)
        members.push({ kind: "junk", value: this.skipOne() });
    }
    return members;
  }
  ifStatement() {
    const start = this.peek().s;
    this.p++;
    const test = this.is("(") ? this.groupExpression() : null;
    const cons = this.stmtOrSkip();
    let alt = null;
    if (this.isId("else")) {
      this.p++;
      alt = this.stmtOrSkip();
    }
    return { k: "if", test, cons, alt, s: start, e: this.last() };
  }
  switchStatement() {
    const start = this.peek().s;
    this.p++;
    const disc = this.is("(") ? this.groupExpression() : null;
    const cases = [];
    if (this.is("{")) {
      const close = this.close();
      const q = this.sub(this.p + 1, close);
      this.p = close + 1;
      while (q.p < q.end) {
        const head = q.peek();
        let test = null;
        if (q.isId("case")) {
          q.p++;
          test = q.expression();
        } else if (q.isId("default")) q.p++;
        else {
          q.skipOne();
          continue;
        }
        if (q.is(":")) q.p++;
        const body = [];
        while (
          q.p < q.end &&
          !q.isId("case") &&
          !(q.isId("default") && q.is(":", 1))
        ) {
          const s = q.stmtOrSkip();
          if (s) body.push(s);
        }
        cases.push({ test, body, s: head.s });
      }
    }
    return { k: "switch", disc, cases, s: start, e: this.last() };
  }
  loopStatement() {
    const start = this.peek();
    this.p++;
    if (this.isId("await")) this.p++;
    let head = [];
    let test = null;
    if (this.is("(")) {
      const close = this.close();
      if (start.v === "while") test = this.expressionIn(this.p + 1, close);
      else head = this.sub(this.p + 1, close).statements();
      this.p = close + 1;
    }
    const body = this.stmtOrSkip();
    return { k: "loop", head, test, body, s: start.s, e: this.last() };
  }
  /** The expression inside the parenthesized group at `p`. */
  groupExpression() {
    const close = this.close();
    const node = this.expressionIn(this.p + 1, close);
    this.p = close + 1;
    return node;
  }
  /** A range parsed as one expression; leftovers become an opaque wrapper. */
  expressionIn(from, to) {
    const q = this.sub(from, to);
    const node = q.expression();
    if (q.p >= to) return node;
    const children = node ? [node, ...q.statements()] : q.statements();
    return { k: "opaque", s: this.toks[from].s, e: this.toks[to - 1].e, children };
  }
  /** A comma-separated range (arguments, array elements); holes skipped. */
  listIn(from, to) {
    const q = this.sub(from, to);
    const out = [];
    while (q.p < q.end) {
      if (q.is(",")) {
        q.p++;
        continue;
      }
      const start = q.peek();
      let node;
      if (q.is("...")) {
        q.p++;
        const arg = q.assign();
        node = arg && { k: "spread", arg, s: start.s, e: arg.e };
      } else node = q.assign();
      out.push(node ?? q.skipOne());
      if (q.p < q.end && !q.is(",")) out.push(q.skipOne());
    }
    return out;
  }

  expression() {
    const first = this.assign();
    if (!first || !this.is(",")) return first;
    const list = [first];
    while (this.is(",")) {
      this.p++;
      const next = this.assign();
      if (!next) break;
      list.push(next);
    }
    return { k: "seq", list, s: first.s, e: list.at(-1).e };
  }
  assign() {
    const arrow = this.arrow();
    if (arrow) return arrow;
    if (this.isId("yield")) {
      const t = this.peek();
      this.p++;
      if (this.is("*")) this.p++;
      const arg = this.peek()?.nl ? null : this.assign();
      return { k: "unary", op: "yield", arg, s: t.s, e: this.last() };
    }
    const left = this.conditional();
    if (!left) return null;
    const t = this.peek();
    if (t && t.t === "punct" && ASSIGN_OPS.has(t.v)) {
      this.p++;
      const r = this.assign();
      return { k: "assign", l: left, r, s: left.s, e: this.last() };
    }
    return left;
  }
  /** The `=>` index when an arrow function starts at `i`, else -1. */
  arrowAt(i) {
    const t = this.toks[i];
    if (!t || i >= this.end) return -1;
    if (t.t === "id") {
      const n = this.toks[i + 1];
      return i + 1 < this.end && n.t === "punct" && n.v === "=>" ? i + 1 : -1;
    }
    if (t.t !== "punct") return -1;
    let open = i;
    if (t.v === "<") {
      const j = this.typeArgsEnd(i);
      if (j === -1) return -1;
      open = j;
    }
    const o = this.toks[open];
    if (!o || o.t !== "punct" || o.v !== "(") return -1;
    let j = this.m.get(open) + 1;
    const after = this.toks[j];
    if (j < this.end && after.t === "punct" && after.v === ":") {
      const save = this.p;
      this.p = j + 1;
      this.skipType();
      j = this.p;
      this.p = save;
    }
    const arrow = this.toks[j];
    return j < this.end && arrow.t === "punct" && arrow.v === "=>" ? j : -1;
  }
  arrow() {
    const start = this.peek();
    if (!start) return null;
    let i = this.p;
    if (this.isId("async") && !this.peek(1)?.nl && this.arrowAt(i + 1) !== -1) i++;
    const arrowIdx = this.arrowAt(i);
    if (arrowIdx === -1) return null;
    let defaults = [];
    const first = this.toks[i];
    if (first.t === "punct") {
      const open = first.v === "<" ? this.typeArgsEnd(i) : i;
      defaults = this.params(open + 1, this.m.get(open));
    } else this.decls.note(first.v, null);
    this.p = arrowIdx + 1;
    const body = this.is("{") ? this.block() : this.assign();
    return { k: "func", defaults, body, s: start.s, e: this.last() };
  }
  conditional() {
    const test = this.binary(0);
    if (!test || !this.is("?")) return test;
    this.p++;
    const cons = this.assign();
    if (this.is(":")) this.p++;
    const alt = this.assign();
    return { k: "cond", test, cons, alt, s: test.s, e: this.last() };
  }
  /** The binary operator at `p` and its token count, re-joining `>` runs. */
  binaryOp() {
    const t = this.peek();
    if (t === null) return null;
    if (t.t === "id")
      return t.v === "instanceof" || t.v === "in" ? [t.v, 1] : null;
    if (t.t !== "punct") return null;
    if (t.v !== ">") return [t.v, 1];
    const adjacent = (k) => {
      const next = this.peek(k);
      return next?.t === "punct" && next.s === this.peek(k - 1).e ? next.v : null;
    };
    let op = ">";
    while (op.length < 3 && adjacent(op.length) === ">") op += ">";
    if (adjacent(op.length) === "=") return [`${op}=`, op.length + 1];
    return [op, op.length];
  }
  binary(minPrec) {
    let left = this.unary();
    if (!left) return null;
    for (;;) {
      if (this.isId("as") || this.isId("satisfies")) {
        this.p++;
        this.skipType();
        left = { k: "wrap", expr: left, s: left.s, e: this.last() };
        continue;
      }
      const found = this.binaryOp();
      if (!found) break;
      const [op, n] = found;
      const prec = BINARY_PRECEDENCE[op];
      if (prec === undefined || prec < minPrec) break;
      this.p += n;
      const right = this.binary(op === "**" ? prec : prec + 1);
      if (!right) break;
      left = { k: "bin", op, l: left, r: right, s: left.s, e: right.e };
    }
    return left;
  }
  unary() {
    const t = this.peek();
    if (t === null) return null;
    if (t.t === "punct" && ["!", "-", "+", "~", "++", "--"].includes(t.v)) {
      this.p++;
      const arg = this.unary();
      return arg && { k: "unary", op: t.v, arg, s: t.s, e: arg.e };
    }
    if (t.t === "id" && UNARY_KEYWORDS.has(t.v) && this.peek(1)) {
      const n = this.peek(1);
      if (!(n.t === "punct" && /^[),;\]}:=?.]/.test(n.v))) {
        this.p++;
        const arg = this.unary();
        return arg && { k: "unary", op: t.v, arg, s: t.s, e: arg.e };
      }
    }
    if (t.t === "punct" && t.v === "<") {
      const j = this.angleEnd(this.p);
      if (j === -1) return null;
      this.p = j;
      return this.unary();
    }
    return this.postfix();
  }
  postfix() {
    let e = this.primary();
    if (!e) return null;
    for (;;) {
      const t = this.peek();
      if (t === null) break;
      if (t.t === "tpl") {
        this.p++;
        e = { k: "call", callee: e, args: [this.templateNode(t)], s: e.s, e: t.e };
        continue;
      }
      if (t.t !== "punct") break;
      if (t.v === "." || t.v === "?.") {
        this.p++;
        if (t.v === "?." && this.is("(")) {
          e = this.callArgs(e);
          continue;
        }
        if (t.v === "?." && this.is("[")) {
          e = this.computedMember(e);
          continue;
        }
        if (!this.isId()) break;
        const n = this.peek();
        this.p++;
        e = { k: "member", obj: e, name: n.v, s: e.s, e: n.e };
      } else if (t.v === "[") e = this.computedMember(e);
      else if (t.v === "(") e = this.callArgs(e);
      else if (t.v === "!" && !t.nl) {
        this.p++;
        e = { k: "wrap", expr: e, s: e.s, e: t.e };
      } else if ((t.v === "++" || t.v === "--") && !t.nl) {
        this.p++;
        e = { k: "unary", op: t.v, arg: e, s: e.s, e: t.e };
      }
      else if (t.v === "<") {
        const j = this.typeArgsEnd(this.p);
        const n = this.toks[j];
        if (j === -1 || j >= this.end) break;
        if (!(n.t === "tpl" || (n.t === "punct" && n.v === "("))) break;
        this.p = j;
      } else break;
    }
    return e;
  }
  computedMember(obj) {
    const close = this.close();
    const prop = this.expressionIn(this.p + 1, close);
    this.p = close + 1;
    return { k: "member", obj, prop, s: obj.s, e: this.last() };
  }
  callArgs(callee) {
    const close = this.close();
    const args = this.listIn(this.p + 1, close);
    this.p = close + 1;
    return { k: "call", callee, args, s: callee.s, e: this.last() };
  }
  primary() {
    const t = this.peek();
    if (t === null) return null;
    if (t.t === "id") {
      if (t.v === "function") return this.functionNode();
      if (t.v === "class") return this.classNode();
      if (t.v === "async" && this.isId("function", 1)) {
        this.p++;
        return this.functionNode();
      }
      if (t.v === "new" && !this.is(".", 1)) {
        this.p++;
        const callee = this.unary();
        if (!callee) return { k: "id", name: "new", s: t.s, e: t.e };
        return { k: "new", callee, s: t.s, e: this.last() };
      }
      this.p++;
      return { k: "id", name: t.v, s: t.s, e: t.e };
    }
    if (t.t === "punct") {
      if (t.v === "(") {
        const close = this.close();
        const expr = this.expressionIn(this.p + 1, close);
        this.p = close + 1;
        return { k: "wrap", expr, s: t.s, e: this.last() };
      }
      if (t.v === "[") {
        const close = this.close();
        const elems = this.listIn(this.p + 1, close);
        this.p = close + 1;
        return { k: "arr", elems, s: t.s, e: this.last() };
      }
      if (t.v === "{") {
        const close = this.close();
        const members = this.sub(this.p + 1, close).objectMembers();
        this.p = close + 1;
        return { k: "obj", members, s: t.s, e: this.last() };
      }
      if (t.v === "@") {
        const decorator = this.decorator();
        const next = this.primary();
        if (!decorator || !next) return next ?? decorator;
        const children = [decorator, next];
        return { k: "opaque", s: t.s, e: next.e, children };
      }
      return null;
    }
    this.p++;
    return this.tokenNode(t);
  }
  /** A nested token array (a template interpolation, a JSX `{…}`). */
  nested(toks) {
    if (toks.length === 0) return null;
    return new SlotParser(toks, 0, toks.length, this.decls).expressionIn(
      0,
      toks.length,
    );
  }
  templateNode(t) {
    const exprs = t.exprs.map((toks) => this.nested(toks)).filter(Boolean);
    const texts = t.quasis.map(cookLiteral);
    return { k: "tpl", quasis: t.quasis, texts, exprs, s: t.s, e: t.e };
  }
  jsxNode(t) {
    const attrs = t.attrs.map((a) => {
      if (a.spread) return { spread: this.nested(a.spread) };
      let value = null;
      if (a.value?.t === "str") {
        // No backslash escapes here, but character references decode; an
        // unreadable one matters only where the string is classes.
        const { text, unknown } = decodeJsxEntities(a.value.v);
        const { s, e } = a.value;
        const cls = a.name === "className" || a.name === "class";
        const badEntity = unknown && cls;
        value = { k: "str", v: a.value.v, text, badEntity, s, e };
      }
      else if (a.value?.t === "jsx") value = this.jsxNode(a.value);
      else if (a.value) value = this.nested(a.value.toks);
      return { name: a.name, value };
    });
    const children = t.children
      .map((c) => (c.t === "jsx" ? this.jsxNode(c) : this.nested(c.toks)))
      .filter(Boolean);
    return { k: "jsx", attrs, children, s: t.s, e: t.e };
  }

  /** Skips a `<…>` run at `p`, or only its `<` when it never closes. */
  skipAngles() {
    const j = this.angleEnd(this.p);
    this.p = j === -1 ? this.p + 1 : j;
  }
  /** Index past a `<…>` run at `i` (types are lenient), or -1. */
  angleEnd(i) {
    let depth = 0;
    for (let j = i; j < this.end; j++) {
      const t = this.toks[j];
      if (t.t !== "punct") continue;
      if (OPENERS.has(t.v)) j = this.m.get(j);
      else if (t.v === "<") depth++;
      else if (t.v === ">" && --depth === 0) return j + 1;
      else if (t.v === ";") return -1;
    }
    return -1;
  }
  /** Index past a call's type arguments at `i`: only type grammar inside, so
   *  `a < b && c > (d)` stays a comparison. -1 when not type arguments. */
  typeArgsEnd(i) {
    let depth = 0;
    for (let j = i; j < this.end; j++) {
      const t = this.toks[j];
      if (t.t !== "punct") continue;
      if (OPENERS.has(t.v)) j = this.m.get(j);
      else if (t.v === "<") depth++;
      else if (t.v === ">") {
        if (--depth === 0) return j + 1;
      } else if (![",", ".", "|", "&", "=>", "?", ":", "...", "-"].includes(t.v))
        return -1;
    }
    return -1;
  }
  /** Skips one type at `p`. */
  skipType() {
    for (;;) {
      while (this.is("|") || this.is("&")) this.p++;
      while (
        this.isId() &&
        TYPE_PREFIXES.has(this.peek().v) &&
        (this.peek(1)?.t === "id" ||
          this.is("(", 1) ||
          this.is("[", 1) ||
          this.is("{", 1))
      )
        this.p++;
      const t = this.peek();
      if (t === null) return;
      if (t.t === "punct") {
        if (t.v === "(") {
          this.skipGroup();
          if (this.is("=>")) {
            this.p++;
            continue;
          }
        } else if (t.v === "[" || t.v === "{") this.skipGroup();
        else if (t.v === "<") {
          const j = this.angleEnd(this.p);
          if (j === -1) return;
          this.p = j;
          continue;
        } else if (t.v === "-") {
          this.p++;
          continue;
        } else return;
      } else if (t.t === "id") {
        this.p++;
        if (t.v === "new" || t.v === "abstract") continue;
        while (this.is(".") && this.isId(undefined, 1)) this.p += 2;
        if (t.v === "import" && this.is("(")) this.skipGroup();
      } else if (t.t === "str" || t.t === "num" || t.t === "tpl") this.p++;
      else return;
      for (;;) {
        if (this.is("<")) {
          const j = this.angleEnd(this.p);
          if (j === -1) break;
          this.p = j;
        } else if (this.is("[") && !this.peek().nl) this.skipGroup();
        else if (this.is(".") && this.isId(undefined, 1)) this.p += 2;
        else break;
      }
      if (this.isId("is") || this.isId("extends")) {
        const conditional = this.peek().v === "extends";
        this.p++;
        this.skipType();
        if (conditional && this.is("?")) {
          this.p++;
          this.skipType();
          if (this.is(":")) {
            this.p++;
            continue;
          }
        }
        return;
      }
      if (this.is("|") || this.is("&")) continue;
      return;
    }
  }
}

/** Every binding name the file declares. A name resolves only when exactly
 *  one `const` with an initializer binds it and nothing else in the file does:
 *  an import specifier, a destructured or catch binding, a function or class
 *  name, a parameter, a `let`/`var` or a second const each make it
 *  unresolvable. */
function slotDeclarations() {
  const consts = new Map();
  const others = new Set();
  return {
    note(name, init) {
      if (init) consts.set(name, [...(consts.get(name) ?? []), init]);
      else others.add(name);
    },
    resolve(name) {
      const list = consts.get(name);
      return list && list.length === 1 && !others.has(name) ? list[0] : null;
    },
    /** Every const initializer bound to the name, resolvable or not. */
    candidates(name) {
      return consts.get(name) ?? [];
    },
  };
}

/** The child nodes of any statement or expression node. */
function slotChildren(n) {
  switch (n.k) {
    case "block":
    case "try":
      return n.body;
    case "labeled":
      return [n.body];
    case "expr":
      return [n.expr];
    case "return":
      return [n.arg];
    case "var":
      return n.decls.map((d) => d.init);
    case "if":
      return [n.test, n.cons, n.alt];
    case "switch":
      return [n.disc, ...n.cases.flatMap((c) => [c.test, ...c.body])];
    case "loop":
      return [...n.head, n.test, n.body];
    case "func":
      return [...n.defaults, n.body];
    case "class":
    case "obj":
      return (n.members ?? []).flatMap((m) => [
        m.key?.node,
        m.value,
        m.body,
      ]);
    case "opaque":
      return n.children;
    case "tpl":
      return n.exprs;
    case "jsx":
      return [
        ...n.attrs.map((a) => (a.spread !== undefined ? a.spread : a.value)),
        ...n.children,
      ];
    case "member":
      return [n.obj, n.prop];
    case "call":
      return [n.callee, ...n.args];
    case "new":
      return [n.callee];
    case "unary":
      return [n.arg];
    case "bin":
    case "assign":
      return [n.l, n.r];
    case "cond":
      return [n.test, n.cons, n.alt];
    case "seq":
      return n.list;
    case "wrap":
      return [n.expr];
    case "arr":
      return n.elems;
    case "spread":
      return [n.arg];
    default:
      return [];
  }
}

/** Whether any string or template literal under `node` carries a hide
 *  (`sr-only` excepted: a branch or mention extent renders other elements,
 *  where it is screen-reader text). */
function literalsHide(node) {
  if (!node) return false;
  if (node.k === "str") return textHides(node.text, false);
  if (node.k === "tpl" && node.texts.some((q) => textHides(q, false)))
    return true;
  return slotChildren(node).some(literalsHide);
}

/** Whether a statement always ends its clause: `return` or `throw`, a
 *  `break`/`continue` that is unlabelled or names a label outside it, a
 *  block whose last statement ends it, or an `if`/`else` whose two arms
 *  both do. A labelled statement only adds its label; `try` never ends a
 *  clause (conservative: its roles fall through). */
function endsClause(s, labels) {
  if (!s) return false;
  switch (s.k) {
    case "return":
      return true;
    case "jump":
      return s.label === null || !labels.has(s.label);
    case "block":
      return endsClause(s.body.at(-1), labels);
    case "if":
      return endsClause(s.cons, labels) && endsClause(s.alt, labels);
    case "labeled":
      return endsClause(s.body, new Set([...labels, s.label]));
    default:
      return false;
  }
}
/** Whether a clause body ends the clause: only its last statement counts, so
 *  no role set falls through it into the next clause. */
const terminates = (body) => endsClause(body.at(-1), new Set());

const unwrapSlot = (n) => {
  while (n && n.k === "wrap") n = n.expr;
  return n;
};
/** The role bit of a role literal, read cooked, else undefined. */
const roleLiteral = (node) => ROLE_BITS.get(cookedLiteralText(node));
/** A preparing-flag read: an identifier, member or literal element access
 *  (`x["isPreparing"]`) whose last name is a flag. */
function isFlagRead(node) {
  const n = unwrapSlot(node);
  if (n?.k === "id") return FLAG_NAMES.has(n.name);
  if (n?.k !== "member") return false;
  return FLAG_NAMES.has(n.name ?? cookedLiteralText(n.prop));
}
const isCombiner = (callee) => {
  const n = unwrapSlot(callee);
  return n?.k === "id" && CLASS_COMBINERS.has(n.name);
};
/** A string, template, JSX, combiner or composition of them: an arm that
 *  produces class code even outside a className or combiner argument. */
function classLike(node) {
  const n = unwrapSlot(node);
  if (!n) return false;
  switch (n.k) {
    case "str":
    case "tpl":
    case "jsx":
      return true;
    case "arr":
      return n.elems.some((el) => classLike(el?.k === "spread" ? el.arg : el));
    case "call":
      return isCombiner(n.callee);
    case "cond":
      return classLike(n.cons) || classLike(n.alt);
    case "bin":
      if (n.op === "&&") return classLike(n.r);
      return (
        (n.op === "||" || n.op === "??" || n.op === "+") &&
        (classLike(n.l) || classLike(n.r))
      );
    default:
      return false;
  }
}

const UNKNOWN_ROLES = { may: ALL_ROLES, not: ALL_ROLES, atoms: [], broken: [] };
/** Swaps the roles a condition may be true and false for. */
const swapRoles = (x) => ({ ...x, may: x.not, not: x.may });
/** The roles an arm can apply to: the guard's set inside the enclosing one. */
const narrowRoles = (set, context) => set & context;
const RELATIONAL_OPS = new Set(["<", ">", "<=", ">=", "instanceof", "in"]);

/** Which roles a condition may be true for (`may`) and false for (`not`),
 *  with the role atoms it read. An identifier `resolve` maps to a const whose
 *  condition reads atoms is that condition (an alias). An identifier naming
 *  such a const that does not resolve (another binding shares the name) is
 *  listed in `broken`, and the caller fails it closed. Anything that is not
 *  a role atom, an alias, `!`, `&&`, `||` or parentheses is unknown: true
 *  and false for every role. */
function roleSets(node, resolve, seen, candidates) {
  const n = unwrapSlot(node);
  if (!n) return UNKNOWN_ROLES;
  const sets = (x) => roleSets(x, resolve, seen, candidates);
  if (n.k === "unary" && n.op === "!") return swapRoles(sets(n.arg));
  if (n.k === "bin" && (n.op === "&&" || n.op === "||")) {
    const a = sets(n.l);
    const b = sets(n.r);
    const atoms = [...a.atoms, ...b.atoms];
    const broken = [...a.broken, ...b.broken];
    return n.op === "&&"
      ? { may: a.may & b.may, not: a.not | b.not, atoms, broken }
      : { may: a.may | b.may, not: a.not & b.not, atoms, broken };
  }
  if (n.k === "bin" && EQUALITY_OPS.has(n.op)) {
    const negated = n.op === "!==" || n.op === "!=";
    for (const side of [n.l, n.r]) {
      const bit = roleLiteral(side);
      if (bit === undefined) continue;
      const atom = {
        may: bit,
        not: ALL_ROLES & ~bit,
        atoms: [unwrapSlot(side)],
        broken: [],
      };
      return negated ? swapRoles(atom) : atom;
    }
    for (const [flag, other] of [
      [n.l, n.r],
      [n.r, n.l],
    ]) {
      const o = unwrapSlot(other);
      if (!isFlagRead(flag) || o?.k !== "id") continue;
      if (o.name !== "true" && o.name !== "false") continue;
      const flagSets = sets(flag);
      return (o.name === "true") !== negated ? flagSets : swapRoles(flagSets);
    }
    return UNKNOWN_ROLES;
  }
  if (isFlagRead(n)) {
    const not = ALL_ROLES & ~PREPARING;
    return { may: PREPARING, not, atoms: [n], broken: [] };
  }
  if (n.k === "id" && !seen.has(n.name)) {
    // `seen` holds this path's aliases only: a repeated reference is no cycle.
    const path = new Set([...seen, n.name]);
    const inner = (x) => roleSets(x, resolve, path, candidates);
    const init = resolve(n.name);
    if (init === null) {
      const held = candidates(n.name).some((c) => inner(c).atoms.length > 0);
      return held ? { ...UNKNOWN_ROLES, atoms: [n], broken: [n] } : UNKNOWN_ROLES;
    }
    const alias = inner(init);
    if (alias.atoms.length > 0) return { ...alias, atoms: [n] };
  }
  return UNKNOWN_ROLES;
}

/** Flag reads anywhere in a condition the guard grammar did not read. */
function flagReadsIn(node) {
  const n = unwrapSlot(node);
  if (!n) return [];
  if (isFlagRead(n)) return [n];
  if (n.k === "member") return n.prop ? flagReadsIn(n.prop) : [];
  return slotChildren(n).flatMap(flagReadsIn);
}

/** The role keys of an object literal's members, read cooked, as one bit
 *  set. */
function memberRoles(members, resolve) {
  let roles = 0;
  for (const m of members)
    if (m.key) roles |= keyRole(m.key, resolve).role ?? 0;
  return roles;
}
/** A class value: a string or template, a combiner call, or a conditional
 *  or array of those. */
function classValue(node) {
  const n = unwrapSlot(node);
  if (!n) return false;
  if (n.k === "str" || n.k === "tpl") return true;
  if (n.k === "call") return isCombiner(n.callee);
  if (n.k === "cond") return classValue(n.cons) && classValue(n.alt);
  if (n.k === "arr") return n.elems.length > 0 && n.elems.every(classValue);
  return false;
}
/** A slot-shaped object or class body: a `preparing` key beside a `held` or
 *  `shown` member whose value is a class value. */
const slotShaped = (members, resolve) =>
  (memberRoles(members, resolve) & PREPARING) !== 0 &&
  members.some(
    (m) =>
      m.value != null &&
      (memberRoles([m], resolve) & ~PREPARING) !== 0 &&
      classValue(m.value),
  );

/**
 * The preparing-slot reading of one file: every site (`index` an offset in
 * `source`), whether each failed, and the host verdict. A file ts-mask cannot
 * lex, or one the reader itself cannot read (a nesting deep enough to exhaust
 * the stack), throws with its path, so the check refuses rather than passing
 * unread code; any other throw is reported as the reader's own bug.
 */
function readPreparingSlots(source, file) {
  const name = file ?? "<input>";
  try {
    return readSlotsUnguarded(source, file);
  } catch (e) {
    if (e instanceof ScanError) {
      const where = e.at === undefined ? "" : ` at line ${lineOf(source, e.at)}`;
      throw new Error(
        `preparing-slot-hide: cannot lex ${name}: ${e.message}${where}`,
      );
    }
    if (e instanceof RangeError)
      throw new Error(`preparing-slot-hide: cannot read ${name}: ${e.message}`);
    // Anything else is a reader bug, not a file shape.
    throw new Error(
      `preparing-slot-hide: internal error reading ${name}: ${e.message}`,
      { cause: e },
    );
  }
}

/** Every literal under a token list (strings, template quasis, JSX attribute
 *  strings), as `[offset, text]`, cooked as JS reads it (a JSX attribute
 *  string takes no backslash escapes but decodes character references). */
const tokenLiterals = (list) =>
  list.flatMap((t) => {
    if (t.t === "str") return [[t.s, cookLiteral(t.v)]];
    if (t.t === "tpl")
      return [
        ...t.quasis.map((q) => [t.s, cookLiteral(q)]),
        ...t.exprs.flatMap(tokenLiterals),
      ];
    if (t.t !== "jsx") return [];
    return [
      ...t.attrs.flatMap((a) => {
        if (a.spread) return tokenLiterals(a.spread);
        if (a.value?.t === "str")
          return [[a.value.s, decodeJsxEntities(a.value.v).text]];
        if (a.value?.t === "jsx") return tokenLiterals([a.value]);
        return a.value ? tokenLiterals(a.value.toks) : [];
      }),
      ...t.children.flatMap((c) =>
        c.t === "jsx" ? tokenLiterals([c]) : tokenLiterals(c.toks),
      ),
    ];
  });
/** Every literal under an AST node, as `[offset, text]`. */
function nodeLiterals(node) {
  if (!node) return [];
  if (node.k === "str") return [[node.s, node.text]];
  const own = node.k === "tpl" ? node.texts.map((q) => [node.s, q]) : [];
  return [...own, ...slotChildren(node).flatMap(nodeLiterals)];
}

function readSlotsUnguarded(source, file) {
  const jsx = file ? file.endsWith(".tsx") : true;
  const masked = maskNonCode(source, jsx);
  const sites = [];
  if (!SLOT_CANDIDATE_RE.test(source))
    return { sites, host: null, hostFailed: false, shapeFailures: [] };
  const toks = lexSlotTokens(source, masked, jsx);
  const decls = slotDeclarations();
  const program = new SlotParser(toks, 0, toks.length, decls).statements();

  // The host check's vocabulary, and whether the file renders classes.
  let vocabulary = null;
  let rendersClasses = false;
  const scanTokens = (list) => {
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (t.t === "id" && vocabulary === null && SLOT_HOST_VOCABULARY.has(t.v))
        vocabulary = t.s;
      if (
        t.t === "id" &&
        (t.v === "cn" || t.v === "clsx") &&
        list[i + 1]?.t === "punct" &&
        list[i + 1].v === "("
      )
        rendersClasses = true;
      if (t.t === "tpl") for (const x of t.exprs) scanTokens(x);
      if (t.t === "jsx") {
        for (const a of t.attrs) {
          if (a.name === "className") rendersClasses = true;
          if (a.spread) scanTokens(a.spread);
          else if (a.value?.t === "expr") scanTokens(a.value.toks);
          else if (a.value?.t === "jsx") scanTokens([a.value]);
        }
        for (const c of t.children) scanTokens(c.t === "jsx" ? [c] : c.toks);
      }
    }
  };
  scanTokens(toks);
  const hostFile = vocabulary !== null;

  // A plain class string: a string literal, an interpolation-free template, a
  // `+` chain of those (parenthesized or not), or a same-file const of one.
  const plainLiteral = (node) => {
    const n = unwrapSlot(node);
    if (n?.k === "str") return n.badEntity ? null : n.text;
    if (n?.k === "tpl" && n.exprs.length === 0) return n.texts[0];
    if (n?.k !== "bin" || n.op !== "+") return null;
    const l = plainLiteral(n.l);
    const r = plainLiteral(n.r);
    return l === null || r === null ? null : l + r;
  };
  /** A plain class string's cooked text and the node holding it, or null. */
  const plainClass = (node) => {
    const n = unwrapSlot(node);
    const target = n?.k === "id" ? decls.resolve(n.name) : n;
    const text = target === null ? null : plainLiteral(target);
    return text === null ? null : { text, target };
  };

  // A slot-host file's slot maps, found before the walk so the class
  // reader can accept a read of a map entry. In a host a map is a slot map by
  // its KEYS, counting a spread of a const object as that object's keys. A
  // preparing key makes it one beside another role key, any spread, or a
  // computed key the scan cannot read whose value is a class string. Without
  // one, computed keys the scan cannot read whose values are class strings
  // count as possible roles: two of them, or one beside a role key, make a
  // slot map too.
  /** A spread member's object, when it resolves to a same-file literal. */
  const spreadObject = (m) => {
    let n = unwrapSlot(m.value);
    if (n?.k === "id") n = unwrapSlot(decls.resolve(n.name));
    return n?.k === "obj" ? n : null;
  };
  /** A value that is class code: a class value or a plain class string. */
  const classString = (value) =>
    classValue(value) || (value != null && plainClass(value) !== null);
  const slotKeyed = (members) => {
    let roles = memberRoles(members, decls.resolve);
    let unread = 0;
    for (const m of members) {
      if (m.kind === "spread") {
        const obj = spreadObject(m);
        if (obj) roles |= memberRoles(obj.members, decls.resolve);
      } else if (
        m.key &&
        keyRole(m.key, decls.resolve).unreadable &&
        classString(m.value)
      )
        unread++;
    }
    const spread = members.some((m) => m.kind === "spread");
    const preparing = (roles & PREPARING) !== 0;
    const other = (roles & ~PREPARING) !== 0;
    // A spread the scan cannot read is evidence only beside a known
    // preparing key: `{ ...state, [key]: value }` is ordinary state.
    if (preparing) return other || spread || unread > 0;
    return unread > 0 && (other || unread > 1);
  };
  const slotMaps = [];
  // Offsets of a host's failures outside the walk's sites (map entries and
  // keys, writes to a preparing member, stray clip-path tokens, unreadable
  // character references), each reported by its line.
  const shapeFailures = [];
  // Literal offsets whose clip-path tokens are allowed: a slot map's preparing
  // entry and the const it resolves to.
  const allowedClips = new Set();
  const allowLiterals = (node) => {
    for (const [at] of nodeLiterals(node)) allowedClips.add(at);
  };
  if (hostFile) {
    const collect = (node) => {
      if (!node) return;
      const map = node.k === "obj" || node.k === "class";
      if (map && slotKeyed(node.members)) slotMaps.push(node);
      for (const c of slotChildren(node)) collect(c);
    };
    for (const s of program) collect(s);
  }
  const slotMapNodes = new Set(slotMaps);
  /** Whether a node resolves, directly or through a same-file const, to one
   *  of the host's slot maps. */
  const isSlotMap = (node) => {
    let n = unwrapSlot(node);
    if (n?.k === "id") n = unwrapSlot(decls.resolve(n.name));
    return slotMapNodes.has(n);
  };
  /** A computed key or prop's role, read cooked through same-file consts. */
  const computedRole = (node) =>
    keyRole({ kind: "computed", node }, decls.resolve);
  /** Whether a write keyed by `key` on `object` may set the preparing entry:
   *  the key is the preparing role, or a key the scan cannot read on an
   *  object that is a slot map. */
  const preparingKey = (object, key) => {
    const { role, unreadable } = computedRole(key);
    return role === PREPARING || (unreadable && isSlotMap(object));
  };
  /** Whether a write target is, or holds in its destructuring pattern, a
   *  member that may be the preparing entry. */
  function preparingTarget(target) {
    const n = unwrapSlot(target);
    if (!n) return false;
    if (n.k === "member")
      return n.prop ? preparingKey(n.obj, n.prop) : n.name === "preparing";
    if (n.k === "assign") return preparingTarget(n.l);
    if (n.k === "spread") return preparingTarget(n.arg);
    if (n.k === "arr") return n.elems.some(preparingTarget);
    if (n.k === "obj")
      return n.members.some((m) => preparingTarget(m.value ?? null));
    return false;
  }
  /** `Global.name(…)` or `Global["name"](…)`. */
  const globalCall = (callee, global, names) => {
    const n = unwrapSlot(callee);
    if (n?.k !== "member" || unwrapSlot(n.obj)?.name !== global) return false;
    return names.includes(n.name ?? cookedLiteralText(n.prop));
  };
  /** An `Object.assign` source's verdict: "preparing" when its object
   *  (directly, through a const, or through a spread in it) carries a
   *  preparing key, "unread" when part of it cannot be read, else "clear". */
  function assignSource(arg, seen = new Set()) {
    let n = unwrapSlot(arg);
    if (n?.k === "spread") return "unread";
    if (n?.k === "id") {
      if (seen.has(n.name)) return "unread";
      seen.add(n.name);
      n = unwrapSlot(decls.resolve(n.name));
    }
    if (n?.k !== "obj") return "unread";
    let verdict = "clear";
    for (const m of n.members) {
      const v =
        m.kind === "spread"
          ? assignSource(m.value, seen)
          : !m.key
            ? "clear"
            : keyRole(m.key, decls.resolve).role === PREPARING
              ? "preparing"
              : keyRole(m.key, decls.resolve).unreadable
                ? "unread"
                : "clear";
      if (v === "preparing") return v;
      if (v === "unread") verdict = v;
    }
    return verdict;
  }
  /** Whether a node may write the preparing entry: an assignment or update
   *  of such a member, or `Object.assign` / `Object.defineProperties` (its
   *  descriptors argument as the only source) / `Object.defineProperty` /
   *  `Reflect.set` / `Reflect.defineProperty` naming one. What the scan cannot
   *  read fails closed when it lands on a slot map. */
  function preparingWrite(node) {
    if (node.k === "assign") return preparingTarget(node.l);
    if (node.k === "unary" && (node.op === "++" || node.op === "--"))
      return preparingTarget(node.arg);
    if (node.k !== "call") return false;
    const assign = globalCall(node.callee, "Object", ["assign"]);
    if (assign || globalCall(node.callee, "Object", ["defineProperties"])) {
      const sources = assign ? node.args.slice(1) : node.args.slice(1, 2);
      const verdicts = sources.map((a) => assignSource(a));
      if (verdicts.includes("preparing")) return true;
      return verdicts.includes("unread") && isSlotMap(node.args[0]);
    }
    const keyed =
      globalCall(node.callee, "Object", ["defineProperty"]) ||
      globalCall(node.callee, "Reflect", ["set", "defineProperty"]);
    return keyed && node.args.length > 1 && preparingKey(node.args[0], node.args[1]);
  }
  if (hostFile) {
    const writes = (node) => {
      if (!node) return;
      if (preparingWrite(node)) shapeFailures.push(node.s);
      for (const c of slotChildren(node)) writes(c);
    };
    for (const s of program) writes(s);
    for (const map of slotMaps)
      for (const m of map.members)
        if (m.key && keyRole(m.key, decls.resolve).role === PREPARING) {
          allowLiterals(m.value ?? m.body);
          const plain = m.value ? plainClass(m.value) : null;
          if (plain) allowLiterals(plain.target);
        }
  }
  /** Whether a node reads a slot map's entry for the preparing slot or for
   *  whichever role is in force. It is one when keyed by the preparing role
   *  (`D.preparing`, `D["preparing"]`, a same-file const of it) or by the
   *  role variable: an identifier the scan cannot resolve (`D[r]`), a
   *  member chain of `.name` reads (`D[slot.role]`), or a same-file const
   *  of either. It is not when keyed by another role (`D.held`) or any
   *  other expression (`D[flag ? "held" : "shown"]`, `D[pick(role)]`,
   *  `D[roles[i]]`, a const of one). The class reader accepts it as
   *  readable: the shape rule holds the entry. */
  const slotEntryRead = (node) => {
    const n = unwrapSlot(node);
    if (n?.k !== "member") return false;
    let obj = unwrapSlot(n.obj);
    if (obj?.k === "id") obj = unwrapSlot(decls.resolve(obj.name));
    if (!slotMapNodes.has(obj)) return false;
    if (!n.prop) return n.name === "preparing";
    const { role, unreadable } = keyRole(
      { kind: "computed", node: n.prop },
      decls.resolve,
    );
    if (!unreadable) return role === PREPARING;
    // A member chain of `.name` reads; its root is never resolved.
    const dottedChain = (key) => {
      const k = unwrapSlot(key);
      if (k?.k === "id") return true;
      return k?.k === "member" && k.name !== undefined && dottedChain(k.obj);
    };
    // The role variable, followed through same-file consts: an identifier
    // that does not resolve, or a dotted chain; a cycle or anything else
    // refuses.
    const roleVariable = (key, seen) => {
      const k = unwrapSlot(key);
      if (k?.k === "member") return dottedChain(k);
      if (k?.k !== "id" || seen.has(k.name)) return false;
      const init = decls.resolve(k.name);
      if (init === null) return true;
      seen.add(k.name);
      return roleVariable(init, seen);
    };
    return roleVariable(n.prop, new Set());
  };

  // Slot context: the whole of a host file, or a slot-shaped object literal
  // or class body and everything nested in it. Outside it nothing is reported.
  let inSlot = hostFile;
  const consumed = new Set();
  const mentions = [];
  const addSite = (kind, span, index) => {
    const s = { index, kind, value: source.slice(span.s, span.e), failed: false };
    sites.push(s);
    return s;
  };
  // A role-condition alias the scan cannot resolve fails closed, once.
  const brokenAliases = new Set();
  const roles = (n) => {
    const r = roleSets(n, decls.resolve, new Set(), decls.candidates);
    for (const id of r.broken) {
      if (brokenAliases.has(id)) continue;
      brokenAliases.add(id);
      addSite("guard", id, id.s).failed = true;
    }
    return r;
  };
  /** Every role atom anywhere under a node. */
  const roleAtomsIn = (node) => {
    const n = unwrapSlot(node);
    if (!n) return [];
    const r = roles(n);
    return r.atoms.length > 0 ? r.atoms : slotChildren(n).flatMap(roleAtomsIn);
  };
  const consume = (atoms) => {
    for (const atom of atoms) {
      consumed.add(atom);
      if (atom.k === "member" && atom.prop) consumed.add(unwrapSlot(atom.prop));
    }
  };
  /** A class token whose variant names the preparing role. */
  const variantSites = (literals) => {
    for (const [at, text] of literals) {
      for (const cls of classTokens(text)) {
        const { variants, utility } = splitClassToken(cls);
        const named = variants.some((v) => v.toLowerCase().includes("preparing"));
        if (named && isSlotHide(utility))
          sites.push({ index: at, kind: "variant", value: cls, failed: true });
      }
    }
  };
  /** Whether an operand only yields a boolean, by syntax alone: a
   *  comparison, a `!`, a boolean literal, `&&`/`||` of those, or a const
   *  whose initializer is one. A flag-named read is a value like any other. */
  const booleanValued = (node, seen = new Set()) => {
    const n = unwrapSlot(node);
    if (!n) return true;
    if (n.k === "unary" && n.op === "!") return true;
    if (n.k === "bin" && (EQUALITY_OPS.has(n.op) || RELATIONAL_OPS.has(n.op)))
      return true;
    if (n.k === "bin" && (n.op === "&&" || n.op === "||"))
      return booleanValued(n.l, seen) && booleanValued(n.r, seen);
    if (n.k !== "id") return false;
    if (n.name === "true" || n.name === "false") return true;
    const init = decls.resolve(n.name);
    if (init === null || seen.has(n.name)) return false;
    return booleanValued(init, new Set([...seen, n.name]));
  };

  // How deep the class reader is inside JSX elements an arm renders.
  let jsxDepth = 0;
  /** The class-expression reader: a class expression's reachable operands,
   *  each read or failed, and its hides (a may-analysis). */
  function evalClass(node, ctx, site, seen) {
    if (!(ctx & PREPARING)) return;
    const n = unwrapSlot(node);
    if (!n) return;
    const fail = () => {
      site.failed = true;
    };
    const text = (t) => {
      if (textHides(t, jsxDepth === 0)) fail();
    };
    switch (n.k) {
      case "str":
        if (n.badEntity) fail();
        text(n.text);
        return;
      case "tpl":
        n.texts.forEach(text);
        for (const x of n.exprs) evalClass(x, ctx, site, seen);
        return;
      case "num":
        return;
      case "id": {
        if (INERT_IDS.has(n.name)) return;
        const init = decls.resolve(n.name);
        if (init === null) return fail();
        if (seen.has(n.name)) return;
        seen.add(n.name);
        evalClass(init, ctx, site, seen);
        return;
      }
      case "cond": {
        const r = roles(n.test);
        const known = r.atoms.length > 0;
        evalClass(n.cons, known ? narrowRoles(r.may, ctx) : ctx, site, seen);
        evalClass(n.alt, known ? narrowRoles(r.not, ctx) : ctx, site, seen);
        return;
      }
      case "bin": {
        // `||` and `??` yield their left operand when it is truthy or
        // non-nullish, so its classes apply; `&&` yields it only when falsy.
        if ((n.op === "||" || n.op === "??") && !booleanValued(n.l))
          evalClass(n.l, ctx, site, seen);
        if (n.op === "&&" || n.op === "||") {
          const r = roles(n.l);
          const set = n.op === "&&" ? r.may : r.not;
          const arm = r.atoms.length > 0 ? narrowRoles(set, ctx) : ctx;
          evalClass(n.r, arm, site, seen);
          return;
        }
        if (n.op === "??") return evalClass(n.r, ctx, site, seen);
        if (n.op === "+") {
          evalClass(n.l, ctx, site, seen);
          evalClass(n.r, ctx, site, seen);
          return;
        }
        if (EQUALITY_OPS.has(n.op) || RELATIONAL_OPS.has(n.op)) return;
        return fail();
      }
      case "unary":
        if (n.op !== "!") fail();
        return;
      case "arr":
        for (const el of n.elems) evalClass(el, ctx, site, seen);
        return;
      case "spread":
        evalClass(n.arg, ctx, site, seen);
        return;
      case "call":
        if (!isCombiner(n.callee)) return fail();
        for (const arg of n.args) evalClass(arg, ctx, site, seen);
        return;
      case "obj":
        for (const m of n.members) {
          if (m.kind === "spread") evalClass(m.value, ctx, site, seen);
          if (m.kind !== "init" && m.kind !== "shorthand") continue;
          const r = roles(m.value);
          const set = r.atoms.length > 0 ? narrowRoles(r.may, ctx) : ctx;
          if (!(set & PREPARING)) continue;
          if (m.key.kind === "computed") evalClass(m.key.node, set, site, seen);
          else text(m.key.text);
        }
        return;
      case "jsx":
        // An element an arm renders: `sr-only` there is screen-reader text.
        jsxDepth++;
        for (const a of n.attrs) {
          if (a.spread !== undefined) fail();
          else if (a.name === "className" || a.name === "class")
            evalClass(a.value, ctx, site, seen);
          else if (a.value) walk(a.value, ctx, a.value, false);
        }
        for (const c of n.children) {
          if (c.k === "jsx") evalClass(c, ctx, site, seen);
          else walk(c, ctx, c, false);
        }
        jsxDepth--;
        return;
      case "member":
        // A read of a slot map's entry: the shape rule holds the entry itself.
        if (!slotEntryRead(n)) fail();
        return;
      default:
        fail();
    }
  }

  /** The return arguments of a callable's body, nested callables excluded. */
  function returnsOf(node) {
    if (!node) return [];
    if (node.k === "return") return node.arg ? [node.arg] : [];
    if (node.k === "func" || node.k === "class") return [];
    const statements = ["block", "if", "switch", "loop", "opaque", "try", "labeled"];
    if (!statements.includes(node.k)) return [];
    return slotChildren(node).flatMap(returnsOf);
  }

  /** An object or class member: role keys narrow the context, and in slot
   *  context a preparing key is an entry site. */
  function member(m, ctx) {
    if (m.kind === "block") return walk(m.body, ctx, m.body, false);
    if (m.kind === "spread" || m.kind === "junk")
      return m.value && walk(m.value, ctx, m.value, false);
    const { role } = keyRole(m.key, decls.resolve);
    if (m.key.kind === "computed") {
      if (role === undefined) walk(m.key.node, ctx, m.key.node, false);
      else consume([unwrapSlot(m.key.node)]);
    }
    const set = role === undefined ? ctx : narrowRoles(role, ctx);
    if (inSlot && role === PREPARING && set & PREPARING) {
      const site = addSite("entry", m.body ?? m.value ?? m.key, m.key.s);
      const values = m.body ? returnsOf(m.body.body) : [m.value];
      for (const v of values) evalClass(v, set, site, new Set());
      return;
    }
    if (m.body) walk(m.body, set, m.body, false);
    else if (m.value) walk(m.value, set, m.value, false);
  }

  /** A guard's arm: a site when it can apply to the preparing slot and holds
   *  class code; otherwise walked under its narrowed context. */
  function arm(node, set, classPos, root, guard) {
    if (!node) return;
    if (set & PREPARING && (classPos || classLike(node))) {
      evalClass(node, set, addSite("guard", node, guard.s), new Set());
    } else walk(node, set, root, classPos);
  }

  /** A statement-level role branch: every literal in it is its class code. */
  function branch(node, set) {
    if (!node) return;
    if (set & PREPARING) {
      const site = addSite("branch", node, node.s);
      if (literalsHide(node)) site.failed = true;
    }
    walk(node, set, node, false);
  }

  /** A guard whose condition read no role atom may still hide a flag inside
   *  an unrecognized test (`Boolean(isPreparing)`): those are mentions. */
  function unreadGuard(test, root) {
    for (const flag of flagReadsIn(test)) mentions.push({ node: flag, root });
  }

  /** Role branches over a `switch`: a role switch labels its clauses with
   *  role literals, and a `switch (true)` gives each clause a role condition,
   *  true for the roles no earlier case condition took; `default` applies
   *  where every case condition can be false. A clause's roles carry into the
   *  next one, in source order, only through a body that falls through. */
  function roleSwitch(n, ctx) {
    const disc = unwrapSlot(n.disc);
    const truthSwitch = disc?.k === "id" && disc.name === "true";
    const hasRoles = n.cases.some((c) =>
      truthSwitch
        ? c.test !== null && roles(c.test).atoms.length > 0
        : roleLiteral(c.test) !== undefined,
    );
    if (!hasRoles) return false;
    walk(n.disc, ctx, n.disc, false);
    let labelled = 0;
    if (!truthSwitch)
      for (const c of n.cases) labelled |= roleLiteral(c.test) ?? 0;
    // JS tests every case before it takes `default`, wherever it sits, so
    // `default` applies where all case conditions can be false.
    let unmatched = ALL_ROLES;
    if (truthSwitch)
      for (const c of n.cases) if (c.test !== null) unmatched &= roles(c.test).not;
    let remaining = ALL_ROLES;
    let pending = 0;
    for (const c of n.cases) {
      let set;
      if (c.test === null) set = truthSwitch ? unmatched : ALL_ROLES & ~labelled;
      else if (truthSwitch) {
        const r = roles(c.test);
        if (r.atoms.length > 0) consume(r.atoms);
        else walk(c.test, ctx, c.test, false);
        set = r.may & remaining;
        remaining &= r.not;
      } else if (roleLiteral(c.test) !== undefined) {
        consume([unwrapSlot(c.test)]);
        set = roleLiteral(c.test);
      } else {
        walk(c.test, ctx, c.test, false);
        set = 0;
      }
      pending |= set;
      if (c.body.length === 0) continue;
      const applies = narrowRoles(pending, ctx);
      if (terminates(c.body)) pending = 0;
      const span = { s: c.body[0].s, e: c.body.at(-1).e };
      if (applies & PREPARING) {
        const site = addSite("branch", span, c.s);
        if (c.body.some(literalsHide)) site.failed = true;
      }
      for (const s of c.body) walk(s, applies, s, false);
    }
    return true;
  }

  /** The generic walk: `ctx` is the role set in force, `root` the extent a
   *  mention climbs to, `classPos` whether the node is class code. Role
   *  analysis runs only in slot context. */
  function walk(node, ctx, root, classPos) {
    const n = node;
    if (!n) return;
    const slot = inSlot;
    switch (n.k) {
      case "str":
        if (slot && n.badEntity) shapeFailures.push(n.s);
        if (slot && n.text === "preparing" && !consumed.has(n))
          mentions.push({ node: n, root });
        return;
      case "tpl":
        if (
          slot &&
          n.exprs.length === 0 &&
          n.texts[0] === "preparing" &&
          !consumed.has(n)
        )
          mentions.push({ node: n, root });
        for (const x of n.exprs) walk(x, ctx, root, classPos);
        return;
      case "expr":
        return walk(n.expr, ctx, n.expr, false);
      case "return":
        return walk(n.arg, ctx, n.arg, false);
      case "var":
        for (const d of n.decls) walk(d.init, ctx, d.init, false);
        return;
      case "func":
        for (const d of n.defaults) walk(d, ctx, d, false);
        return walk(n.body, ctx, n.body, false);
      case "if": {
        const r = slot ? roles(n.test) : UNKNOWN_ROLES;
        if (r.atoms.length > 0) {
          consume(r.atoms);
          branch(n.cons, narrowRoles(r.may, ctx));
          branch(n.alt, narrowRoles(r.not, ctx));
          return walk(n.test, ctx, n.test, false);
        }
        break;
      }
      case "switch":
        if (slot && roleSwitch(n, ctx)) return;
        break;
      case "cond": {
        const r = slot ? roles(n.test) : UNKNOWN_ROLES;
        if (r.atoms.length > 0) {
          consume(r.atoms);
          arm(n.cons, narrowRoles(r.may, ctx), classPos, root, n);
          arm(n.alt, narrowRoles(r.not, ctx), classPos, root, n);
          return walk(n.test, ctx, root, false);
        }
        if (slot) unreadGuard(n.test, root);
        walk(n.test, ctx, root, false);
        walk(n.cons, ctx, root, classPos);
        return walk(n.alt, ctx, root, classPos);
      }
      case "bin": {
        // `||` and `??` yield their left operand as a value.
        const leftValue = n.op === "||" || n.op === "??" || n.op === "+";
        if (n.op === "&&" || n.op === "||") {
          const r = slot ? roles(n.l) : UNKNOWN_ROLES;
          if (r.atoms.length > 0) {
            consume(r.atoms);
            const set = n.op === "&&" ? r.may : r.not;
            arm(n.r, narrowRoles(set, ctx), classPos, root, n);
            const value = n.op === "||" && !booleanValued(n.l);
            return walk(n.l, ctx, root, classPos && value);
          }
          if (slot) unreadGuard(n.l, root);
        }
        const keeps = leftValue || n.op === "&&";
        walk(n.l, ctx, root, classPos && leftValue);
        return walk(n.r, ctx, root, classPos && keeps);
      }
      case "call":
        walk(n.callee, ctx, root, false);
        if (!isCombiner(n.callee)) {
          // A role condition handed to a helper in class code, anywhere in
          // its arguments: the helper's classes depend on it, and the scan
          // cannot read the helper.
          const fed = slot && classPos ? n.args.flatMap(roleAtomsIn) : [];
          if (fed.length > 0) {
            consume(fed);
            addSite("guard", n, n.s).failed = true;
          }
          for (const a of n.args) walk(a, ctx, root, false);
          return;
        }
        for (const a of n.args) {
          const arg = unwrapSlot(a);
          if (arg?.k !== "obj") {
            walk(a, ctx, a, true);
            continue;
          }
          // A clsx object: each key's classes apply when its value is true.
          for (const m of arg.members) {
            if (m.kind !== "init" && m.kind !== "shorthand") {
              member(m, ctx);
              continue;
            }
            const r = slot ? roles(m.value) : UNKNOWN_ROLES;
            if (r.atoms.length === 0) {
              if (m.key.kind === "computed") walk(m.key.node, ctx, a, true);
              walk(m.value, ctx, m.value, false);
              continue;
            }
            consume(r.atoms);
            const set = narrowRoles(r.may, ctx);
            if (set & PREPARING) {
              const site = addSite("guard", m.key, m.s);
              if (m.key.kind === "computed")
                evalClass(m.key.node, set, site, new Set());
              else if (textHides(m.key.text)) site.failed = true;
            }
            walk(m.value, ctx, m.value, false);
          }
        }
        return;
      case "obj":
      case "class": {
        const shaped = !slot && slotShaped(n.members, decls.resolve);
        if (shaped) {
          inSlot = true;
          variantSites(nodeLiterals(n));
        }
        for (const m of n.members) member(m, ctx);
        if (shaped) inSlot = false;
        return;
      }
      case "jsx":
        for (const a of n.attrs) {
          const v = a.spread !== undefined ? a.spread : a.value;
          const cls = a.name === "className" || a.name === "class";
          walk(v, ctx, v, cls);
        }
        for (const c of n.children) walk(c, ctx, c, false);
        return;
      case "wrap":
      case "arr":
      case "spread":
        for (const c of slotChildren(n)) walk(c, ctx, root, classPos);
        return;
    }
    const own = SLOT_STATEMENTS.has(n.k);
    for (const c of slotChildren(n)) walk(c, ctx, own ? c : root, false);
  }

  for (const s of program) walk(s, ALL_ROLES, s, false);

  for (const { node, root } of mentions) {
    const site = addSite("mention", root ?? node, node.s);
    if (literalsHide(root)) site.failed = true;
  }
  if (hostFile) variantSites(tokenLiterals(toks));

  // The host check is a shape rule. In a slot-host file every slot map's
  // preparing entry (a spread of a const object included) is a plain class
  // string whose cooked text holds exactly one clip-path token, the bare clip,
  // with no spread after it; a key the scan cannot read fails; a host that
  // renders classes keeps at least one slot map; and no arbitrary clip-path
  // token sits anywhere but a slot map's preparing entry.
  /** Whether a preparing value is a plain string holding only the bare clip. */
  const clippedEntry = (value) => {
    const plain = value ? plainClass(value) : null;
    return plain !== null && soleBareClip(plain.text);
  };
  if (hostFile) {
    const perMap = slotMaps.map((map) =>
      map.members.flatMap((m, i) => {
        if (m.kind === "spread") {
          // A const object spread in acts as its own preparing entries.
          const obj = spreadObject(m);
          const entries = (obj?.members ?? []).filter(
            (x) => x.key && keyRole(x.key, decls.resolve).role === PREPARING,
          );
          for (const x of entries) {
            allowLiterals(x.value ?? x.body);
            const plain = x.value ? plainClass(x.value) : null;
            if (plain) allowLiterals(plain.target);
          }
          const plainValue = (x) =>
            (x.kind === "init" || x.kind === "shorthand") && clippedEntry(x.value);
          return entries.every(plainValue) ? [] : [m.s];
        }
        if (!m.key) return [];
        const { role, unreadable } = keyRole(m.key, decls.resolve);
        if (unreadable) return [m.key.s];
        if (role !== PREPARING) return [];
        const value = m.kind === "init" || m.kind === "shorthand";
        const spreadAfter = map.members
          .slice(i + 1)
          .some((x) => x.kind === "spread");
        const fails = !value || spreadAfter || !clippedEntry(m.value);
        return fails ? [m.key.s] : [];
      }),
    );
    // Every slot map counts, not just one of them.
    shapeFailures.push(...perMap.flat());
    outsideClips();
  }

  /** A host's arbitrary clip-path or `[all:…]` tokens outside its slot map
   *  entries (string keys included): each fails. */
  function outsideClips() {
    const literals = (node) => {
      if (!node) return [];
      const own =
        node.k === "str"
          ? [[node.s, node.text]]
          : node.k === "tpl"
            ? node.texts.map((q) => [node.s, q])
            : [];
      const keys =
        node.k === "obj" || node.k === "class"
          ? node.members
              .filter((m) => m.key?.kind === "str")
              .map((m) => [m.key.s, m.key.text])
          : [];
      return [...own, ...keys, ...slotChildren(node).flatMap(literals)];
    };
    for (const [at, text] of program.flatMap(literals))
      if (!allowedClips.has(at) && classTokens(text).some(arbitraryClipPath))
        shapeFailures.push(at);
  }
  const isHost = hostFile && rendersClasses;
  return {
    sites,
    host: isHost ? vocabulary : null,
    hostFailed: isHost && slotMaps.length === 0,
    shapeFailures,
  };
}

/** Every preparing-slot site in `source` as `{ index, kind, value }`: kind
 *  entry (a role-keyed preparing entry), guard (a role-guarded class arm, a
 *  clsx entry, or a role condition fed to a class helper), branch (a role
 *  `switch` clause or `if` arm), variant (a class token whose variant names
 *  the role) or mention (a `"preparing"` literal or flag read no other kind
 *  consumed, valued by the extent it climbs to). Slot context only: a slot
 *  host file, or a slot-shaped object. */
export function preparingSlotSites(source, file) {
  return readPreparingSlots(source, file).sites.map(({ index, kind, value }) => ({
    index,
    kind,
    value,
  }));
}

/** Whether the host check treats `source` as a two-slot host. */
export function isPreparingSlotHost(source, file) {
  return readPreparingSlots(source, file).host !== null;
}

/** Scanner: every failed site's line; every slot map entry or key the shape
 *  rule refuses, stray clip-path token, preparing assignment and unreadable
 *  character reference; and a host's first vocabulary line when it keeps no
 *  slot map. */
const preparingSlotHide = ({ source }, file) => {
  const { sites, host, hostFailed, shapeFailures } = readPreparingSlots(
    source,
    file,
  );
  const lines = new Set();
  for (const s of sites) if (s.failed) lines.add(lineOf(source, s.index));
  for (const at of shapeFailures) lines.add(lineOf(source, at));
  if (hostFailed) lines.add(lineOf(source, host));
  return [...lines];
};

// A `<Label>` open tag carrying no ASSOCIATION. Only two attributes associate a
// label with what it names — `htmlFor` for a single control, `id` for a caption
// an `aria-labelledby` points at — so the key is those, not attribute-vs-bare:
// `className` styles a label without naming anything. `\/?` is what also catches
// the self-closing forms. A `<Label>` that WRAPS its control is associated at
// RUNTIME, which no static pattern can see, so those ride the allowlist.
// Runs over the JOINED view so an open tag the formatter split across lines is
// still one match — the props of a wrapping label wrap routinely. That view
// trims each line and rejoins with a single space, which the `\s` between
// attributes absorbs; both `[^>]*` spans still stop at the tag's own `>`.
// Two documented edges, both zero-instance today. One fails OPEN: an attribute
// merely ENDING in `id` (`data-id=`) satisfies the `\b` and reads as associated.
// One fails CLOSED: those `[^>]*` spans stop at the FIRST `>`, so an attribute
// VALUE containing `>` ahead of the `htmlFor` (a template-literal title
// reordered before it) hides the association and reports a correct label.
const UNASSOCIATED_LABEL_RE =
  /<Label(?![^>]*\b(?:htmlFor|id)\s*=)(?:\s[^>]*)?\/?>/g;

// A key-dispatch path that compares a live event against a user binding and
// swallows the key, in a file missing any predicate of the canonical clause.
// ALL THREE are required because each covers a different escape: the two target
// guards refuse different surfaces (a text field vs a typeahead-driven list),
// and the key half keeps named keys reaching preventDefault on a surface the
// target guards alone would hand back. A file carrying a subset is the
// half-guarded shape — drift between two dispatchers is the regression this
// exists for. Deliberately COARSE — presence anywhere in the file, not on the
// right path — so it can report a file that guards one handler and not the one
// added next to it. It is a ratchet, not a proof: its job is to make a NEW
// dispatch path stop a reader at the allowlist rather than merge unnoticed.
const EVENT_TO_BINDING_RE = /\beventToBinding\s*\(/;
const PREVENT_DEFAULT_RE = /\.preventDefault\s*\(/;
const EDITABLE_GUARD_RE = /\bisEditableTarget\s*\(/;
const TYPEAHEAD_GUARD_RE = /\bisTypeaheadTarget\s*\(/;
const TYPEAHEAD_KEY_RE = /\bisTypeaheadKey\s*\(/;

// A generator dialog that stays mounted across its own close: a one-shot AI
// generator hook, in a file that also seeds on open. Both halves are needed —
// the generator is what a close would otherwise strand, and `useSeedOnOpen` is
// what would wipe the finished draft on the next open. Surfaces with a
// deliberate abort-on-close (the PR/issue EDIT dialogs, TaskDialog) carry no
// seed-on-open, and the branch-name / commit-message generators are not in the
// list, so both stay out by construction rather than by allowlist.
// The hook list is explicit rather than a `useGenerate\w+` shape: the chord and
// the commit-message path share that prefix without owning a dialog draft. That
// makes the list the gate's reach: a NEW one-shot generator hook must be
// appended here, or every dialog adopting it escapes this ratchet silently.
// Bounded to .tsx, which is what keeps each hook's own definition file (a .ts
// whose export line matches the call pattern) from reading as a call site.
const GENERATOR_HOOK_RE =
  /\buse(?:GeneratePrDescription|GenerateIssueDraft|GenerateReleaseNotes|GenerateRepoDescription)\s*\(/;
const USE_SEED_ON_OPEN_CALL_RE = /\buseSeedOnOpen\s*\(/g;
const FINISH_AND_SURFACE_RE = /\buseFinishAndSurface\s*\(/g;

// A create's settle closes the dialog holding the draft it sent, so nothing may
// revise that draft once it is in flight: while the form submits, Generate
// holds, and the generate chord with it. Statically: in a file that builds a
// form (`useAppForm(` or `withForm(`, code only), every `useGenerateChord(`
// call passes an object literal whose own `enabled` value is a top-level `&&`
// chain with `!isSubmitting` as one conjunct (redundant parens stripped). A
// top-level `||`, `??` or ternary in that value, a missing, shorthand,
// duplicated or spread-overridable `enabled`, and an unreadable call all
// report. File-scoped: a form and a chord in different components of one file
// still pair, a loud over-match the allowlist answers. The visible Generate's
// own hold is render output this can't see; the chord is the ratcheted half.
const FORM_HOST_RE = /\b(?:useAppForm|withForm)\s*\(/g;
const GENERATE_CHORD_CALL_RE = /\buseGenerateChord\s*\(/g;

/** Walks `src` skipping string and template contents, calling `visit(i)` at
 *  each bracket-depth-0 index; a truthy return stops the walk and is returned.
 *  null on unbalanced brackets or an unclosed string, so callers fail closed. */
function walkTopLevel(src, visit) {
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      if (j >= src.length) return null;
      i = j;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth < 0) return null;
    } else if (depth === 0) {
      const out = visit(i);
      if (out) return out;
    }
  }
  return depth === 0 ? false : null;
}

/** `src` split at its depth-0 occurrences of `sep`, or null if unreadable. */
function splitAtTopLevel(src, sep) {
  const parts = [];
  let from = 0;
  const walked = walkTopLevel(src, (i) => {
    if (i >= from && src.startsWith(sep, i)) {
      parts.push(src.slice(from, i));
      from = i + sep.length;
    }
  });
  if (walked === null) return null;
  parts.push(src.slice(from));
  return parts;
}

/** `src` trimmed, minus any parens wrapping the WHOLE expression. */
function stripOuterParens(src) {
  let s = src.trim();
  while (s.startsWith("(") && balancedEnd(s, 0, "(", ")") === s.length - 1)
    s = s.slice(1, -1).trim();
  return s;
}

/** Whether `expr` has a depth-0 `||`, `??` or ternary `?` (optional chaining
 *  aside); null if unreadable. */
function hasTopLevelAlternative(expr) {
  const found = walkTopLevel(expr, (i) => {
    if (expr.startsWith("||", i)) return true;
    if (expr[i] !== "?") return false;
    // `?.` before a non-digit is optional chaining; `??` and a bare `?` aren't.
    return !(expr[i + 1] === "." && !/\d/.test(expr[i + 2] ?? ""));
  });
  return found === null ? null : Boolean(found);
}

/** The `&&` conjuncts of `expr`, flattening parenthesized `&&` chains; null
 *  when `expr` itself is not a pure conjunction or can't be read. */
function conjuncts(expr) {
  const e = stripOuterParens(expr);
  if (hasTopLevelAlternative(e) !== false) return null;
  const parts = splitAtTopLevel(e, "&&");
  if (parts === null) return null;
  if (parts.length === 1) return [e];
  return parts.flatMap((p) => conjuncts(p) ?? [stripOuterParens(p)]);
}

/** Whether a `useGenerateChord` call's argument source (between its parens)
 *  holds the chord on submit, per the class comment above. */
export function chordOptionsHoldSubmit(args) {
  const obj = args.trim();
  if (!obj.startsWith("{") || balancedEnd(obj, 0, "{", "}") !== obj.length - 1)
    return false;
  const props = splitAtTopLevel(obj.slice(1, -1), ",");
  if (props === null) return false;
  const entries = props.map((p) => p.trim()).filter((p) => p !== "");
  // A spread can supply or override `enabled` out of sight.
  if (entries.some((p) => p.startsWith("..."))) return false;
  const keyed = entries.filter((p) => /^(["']?)enabled\1\s*(?::|$)/.test(p));
  // Missing, duplicated, or shorthand (`{ enabled, run }`): unreadable.
  if (keyed.length !== 1) return false;
  const colon = keyed[0].indexOf(":");
  if (colon === -1) return false;
  const terms = conjuncts(keyed[0].slice(colon + 1));
  return (
    terms !== null &&
    terms.some((t) => t.replace(/\s+/g, "") === "!isSubmitting")
  );
}

/** Each `useGenerateChord(` call in a view's text, with whether it holds on
 *  submit; an unclosed call reads as unheld. */
export function generateChordCalls(text) {
  return [...text.matchAll(GENERATE_CHORD_CALL_RE)].map((m) => {
    const open = m.index + m[0].length - 1;
    const close = balancedEnd(text, open, "(", ")");
    return {
      index: m.index,
      held: close !== -1 && chordOptionsHoldSubmit(text.slice(open + 1, close)),
    };
  });
}

const chordIgnoresSubmit = ({ text, starts }) =>
  generateChordCalls(text)
    .filter((call) => !call.held)
    .map((call) => lineAt(starts, call.index));

// The two halves of an async settings rollback. The gate: an OPTIMISTIC patch of
// the settings cache — the file flips the preference itself so the UI can commit
// before the store write resolves. The hit: that file's mutation FAILURE arm
// restoring by REFETCH rather than by writing the snapshot back, which lands the
// restore a commit or more later — too late for a focus hand-off armed on the
// flip, so focus drops to <body> on a refused write. Either failure spelling
// counts: an `onError` callback, or the `catch` of an awaited `mutateAsync`
// (the `.catch(` arrow the settings writers use, or a try/catch block).
// Co-presence is the class, and the gate is FORWARD-looking: nothing trips the
// failure half today, since every settings invalidate under src/ is
// success-path. What the gate buys is that a file which legitimately refetches
// settings from a failure arm with nothing optimistic to roll back (DangerZone,
// RepoList, useRepoVisibilityProbe are each one edit from that shape) can never
// read as a violation.
// The cost of file-scoping, accepted: one file that patches the settings cache
// for its own feature AND refetches settings from an unrelated mutation's
// failure arm pairs them anyway — a loud false positive, allowlist as remedy. It
// buys the reverse, which matters more: the patch and the mutation it guards may
// sit in different functions of the same hook file, and a proximity pair would
// miss that. The reported line is the failure arm, which is the site to rewrite.
// The failure-arm half is itself a PAIR_GAP proximity pair, not a parse: it
// does not prove the invalidate sits INSIDE the arm, so a success-path
// invalidate within PAIR_GAP after an unrelated `catch` also reports.
// The optional type-argument group uses the same `<[^(]*?>` class as
// SET_QUERY_DATA_RE above, for the same reason: a `<[^>]*>` group stops at the
// INNER `>` of a nested generic (`setQueryData<Record<string, Foo>>`), and the
// lazy run bounded by the call's own paren resolves it. Missing a typed spelling
// here would turn this file's whole gate off, not just skip one line.
const OPTIMISTIC_SETTINGS_PATCH_RE =
  /setQueryData\s*(?:<[^(]*?>)?\s*\(\s*settingsKeys\.settings\b/;
const SETTINGS_ROLLBACK_REFETCH_RE = new RegExp(
  `\\b(?:onError|catch)\\b[\\s\\S]{0,${PAIR_GAP}}?invalidateQueries\\s*\\(\\s*\\{\\s*` +
    `queryKey:\\s*settingsKeys\\.settings\\b`,
  "g",
);

// The routes around the notification gate, each matched at its IMPORT. Every
// module specifier is anchored on its trailing PATH SEGMENT rather than on the
// alias spelling, because `@/lib/stores/notifications`, `./notifications` and
// `../stores/notifications` all resolve to the same module and a producer may
// legitimately sit in either directory (repo-description-generation.ts already
// imports `./notifications` for an unrelated helper). No other module under
// src/ ends in `/notifications` or `/notify`, so the segment anchor costs no
// precision; a future one would need the banned identifier to report at all.
//
// The inbox route keys on the `pushNotification` identifier inside the
// specifier list, so the type-only and helper exports the same module carries
// (NotificationKind, NotificationTone, NotificationTarget, repoNameFromPath)
// stay legal; `[^}]*` cannot cross the import's own closing brace, so a
// neighbouring import can never supply the token. A NAMESPACE import defeats
// that specifier match outright — `notifs.pushNotification(row)` names nothing
// at the import — so it takes its own arm, module path alone. The OS route
// needs neither: every export of the notify module is a direct ping, so the
// module path alone covers its specifier and namespace forms together.
//
// All three run over the whole-file view: the formatter puts each specifier on
// its own line. Accepted evasions, zero instances today: a dynamic `import()`
// of either module (no `from` clause), and a re-export chain through a third
// module.
const PUSH_NOTIFICATION_IMPORT_RE =
  /\bimport\s+(?:type\s+)?\{[^}]*\bpushNotification\b[^}]*\}\s*from\s*["'][^"']*\/notifications["']/g;
const NOTIFICATIONS_NAMESPACE_IMPORT_RE =
  /\bimport\s+\*\s+as\s+[\w$]+\s+from\s*["'][^"']*\/notifications["']/g;
const NOTIFY_MODULE_IMPORT_RE = /\bfrom\s*["'][^"']*\/notify["']/g;

// The two routes to opening a `@tauri-apps/plugin-store` store by hand, each of
// which re-opens the rejected-load class: `storePromise ??= load(...)` memoizes the
// REJECTED promise as readily as a resolved one, so one unreadable file leaves that
// store dead for the rest of the session.
//
// The import arm is the primary anchor, matched on the `load` SPECIFIER inside the
// braces (`[^}]*` cannot cross the import's own closing brace, so a neighbouring
// import can never supply the token, and an alias — `load as loadStore` — still
// hits). A type-only `import type { Store }` carries no `load` specifier and stays
// legal, which is what lets the stores that still take a `Store`-typed parameter
// import the type. The call arm is the backstop for a route the specifier match
// cannot see (a namespace import, or a re-export chain), anchored on the house
// spelling `load(storeName(` — a load naming its file some other way evades it.
// Both run over the whole-file view: the formatter puts each specifier, and a long
// argument list, on its own line.
const PLUGIN_STORE_LOAD_IMPORT_RE =
  /\bimport\s+(?:type\s+)?\{[^}]*\bload\b[^}]*\}\s*from\s*["']@tauri-apps\/plugin-store["']/g;
const LOAD_STORE_NAME_CALL_RE = /\bload\s*\(\s*storeName\s*\(/g;

// A raw `.reload(` on a plugin store. A SINGLE-LINE `window.location.reload()` is a
// different API entirely, excluded structurally by the lookbehind rather than by an
// allowlist entry — a reload of the WEBVIEW has nothing to do with a store's disk
// cache.
// FALSE-POSITIVE direction, by design: the receiver is unchecked, so any future
// non-store `.reload()` — `router.reload()`, an aliased location binding — goes red
// with a store-flavored message. The lookbehind is narrower than it looks, and in the
// same direction: `view()` joins each trimmed line with a SPACE, so a `location` split
// from its `.reload()` by the formatter reads as `window.location .reload(` and the
// lookbehind sees the space, not `location` — the webview reload then MATCHES too
// (measured against the live scanner; the single-line form is the only excluded one).
// The remedy for every one of these is an allowlist entry with rationale, NOT a
// narrowed receiver pattern: naming the store receivers would fail-OPEN on the next
// store whose variable is spelled differently, which is the direction that matters.
const RAW_STORE_RELOAD_RE = /(?<!location)\.reload\s*\(/g;

// The repo-identity query key, spelled as a literal anywhere but its factory —
// which is the only way to observe that key without the factory's options. All
// three quote styles (a template literal is as valid a key segment as either
// quote), and the CLOSING quote is the anchor rather than a token boundary: a
// longer key sharing this exact prefix (`"repo-identity-scope"`) would
// substring-match without it. Blind to a key built from a CONSTANT, which no
// site does today; comment stripping keeps the several doc mentions clean.
const INLINE_REPO_IDENTITY_KEY_RE = /(["'`])repo-identity\1/g;

// Every module specifier in an import/export position, captured for path analysis.
// Matching the specifier and normalizing it beats one big pattern: `.`/`..` segments
// that still resolve to the target are what a regex silently misses.
const MODULE_SPECIFIER_RE = /\b(?:from|import)\s*\(?\s*(["'`])([^"'`]+)\1/g;

/** A specifier with any vite query/fragment suffix dropped, `.`/`..` segments
 *  collapsed and the extension removed, so every spelling that RESOLVES to one
 *  module compares equal. `?raw` / `?worker` still address the same file. */
function normalizeSpecifier(spec) {
  const segments = [];
  for (const part of spec.replace(/[?#].*$/, "").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/").replace(/\.[jt]sx?$/, "");
}

/**
 * Whether a module specifier resolves to the git-queries package's private
 * internals, from OUTSIDE the package. Normalized first, so `queries/./internal`
 * and `queries/core/../internal` cannot slip past. The `git/` anchor is
 * segment-aligned (`local-git/queries/internal` is a different package), and the
 * trailing boundary admits subpaths, so internal.ts growing into an internal/
 * directory stays covered.
 * Known bound: a string LITERAL holding one of these paths counts as a use —
 * only comments are stripped.
 * Known bound: the bare `queries/internal` arm also fires on another package's
 * `../queries/internal`, since a relative specifier's landing site is invisible here.
 */
export function reachesGitQueriesInternal(spec) {
  const path = normalizeSpecifier(spec);
  // This literal spells the same package as QUERIES_DIR but matches SPECIFIERS
  // rather than repo paths, so it cannot reuse the constant — moving the package
  // means updating both, and the queries-internal-present pin fails loudly if only
  // one of them is updated.
  return (
    /(^|\/)git\/queries\/internal(\/|$)/.test(path) ||
    path === "queries/internal" ||
    path.startsWith("queries/internal/")
  );
}

/** The same question asked from INSIDE the package, where internal.ts is reached
 *  as the bare sibling `./internal` — a form that carries no `queries/` segment. */
export function reachesQueriesInternalFromSibling(spec) {
  const path = normalizeSpecifier(spec);
  return (
    path === "internal" ||
    path.startsWith("internal/") ||
    reachesGitQueriesInternal(spec)
  );
}

/** Scanner: import/export specifiers that reach the git-queries internals. */
const queriesInternalSpecifiers = ({ text, starts }) => {
  const hits = new Set();
  for (const m of text.matchAll(MODULE_SPECIFIER_RE)) {
    if (reachesGitQueriesInternal(m[2])) hits.add(lineAt(starts, m.index));
  }
  return [...hits];
};

/** Scanner: the barrel naming its own private module, in any spelling — the
 *  sibling form and every absolute/relative path that resolves to it. */
const barrelInternalSpecifiers = ({ text, starts }) => {
  const hits = new Set();
  for (const m of text.matchAll(MODULE_SPECIFIER_RE)) {
    if (reachesQueriesInternalFromSibling(m[2]))
      hits.add(lineAt(starts, m.index));
  }
  return [...hits];
};

// RE-EXPORT positions only: `export * from "x"`, `export * as ns from "x"`, and
// `export { a, b } from "x"`. The gap is bounded by BOTH `;` and the `import`
// keyword: a semicolon-less export DECLARATION (`export enum E { A }`) would
// otherwise reach past itself and pair with a later plain import's specifier.
const REEXPORT_SPECIFIER_RE =
  /\bexport\b(?:(?!\bimport\b)[^;])*?\bfrom\s*(["'`])([^"'`]+)\1/g;

// An import statement's clause plus its specifier, for binding analysis. The clause
// capture already spans `type { … }` and the inline `{ type a }` modifier, whose
// keyword clauseNames strips per entry.
const IMPORT_CLAUSE_RE = /\bimport\s+([^;]*?)\s*\bfrom\s*(["'`])([^"'`]+)\2/g;
// A bare `export { … }` clause; group 2 is non-empty when a `from` follows, which
// makes it a re-export the specifier arm above already owns. `type` is optional
// because a TYPE-only re-export still publishes the name — erased at runtime, but
// `export type { workingTreeKeys }` puts it in the barrel's type space all the same.
const EXPORT_CLAUSE_RE =
  /\bexport\s*(?:type\s+)?\{([^}]*)\}\s*(from\s*["'`])?/g;
const EXPORT_DEFAULT_RE = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;/g;

/** The LOCAL binding each clause entry introduces or re-exports: `a as b` binds b
 *  on import and re-exports local `a` on export, so the side that matters differs. */
function clauseNames(clause, side) {
  const names = [];
  for (const raw of clause.split(",")) {
    const entry = raw.trim().replace(/^type\s+/, "");
    if (!entry) continue;
    const parts = entry.split(/\s+as\s+/);
    const name = side === "import" ? parts.at(-1) : parts[0];
    if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
  }
  return names;
}

/** Scanner: a package module RE-EXPORTING the private internals. `export *` chains
 *  republish, so one of these anywhere in the package puts every internal helper on
 *  the barrel's public surface — while a plain `import` of it stays legal.
 *
 *  Two arms, because a re-export can be SPLIT across two statements: the specifier
 *  arm catches `export … from "./internal"`, and the binding arm catches
 *  `import { x } from "./internal"` paired with a later bare `export { x }` or
 *  `export default x` — a form that carries no specifier at all, so no
 *  specifier-matching pattern can ever see it. */
const reexportsInternalSpecifiers = ({ text, starts }) => {
  const hits = new Set();
  for (const m of text.matchAll(REEXPORT_SPECIFIER_RE)) {
    if (reachesQueriesInternalFromSibling(m[2]))
      hits.add(lineAt(starts, m.index));
  }

  // Locals bound from internal in THIS file — including aliases, which is the
  // spelling that makes the split form look innocent at the export site.
  const fromInternal = new Set();
  for (const m of text.matchAll(IMPORT_CLAUSE_RE)) {
    if (!reachesQueriesInternalFromSibling(m[3])) continue;
    const clause = m[1].replace(/[{}]/g, " ").replace(/^\s*\*\s*as\s+/, "");
    for (const name of clauseNames(clause, "import")) fromInternal.add(name);
  }
  if (fromInternal.size === 0) return [...hits];

  for (const m of text.matchAll(EXPORT_CLAUSE_RE)) {
    if (m[2]) continue; // `export { … } from "…"` — the specifier arm owns it
    if (clauseNames(m[1], "export").some((n) => fromInternal.has(n)))
      hits.add(lineAt(starts, m.index));
  }
  for (const m of text.matchAll(EXPORT_DEFAULT_RE)) {
    if (fromInternal.has(m[1])) hits.add(lineAt(starts, m.index));
  }
  return [...hits];
};

const QUERIES_DIR = "src/lib/git/queries/";
const QUERIES_BARREL = `${QUERIES_DIR}index.ts`;
const QUERIES_INTERNAL = `${QUERIES_DIR}internal.ts`;
const JIRA_QUERIES = "src/lib/jira/queries.ts";
/** The local-entity query modules. Same repo-scoped create shape as the git
 *  package, in their own directories, so they are named into scope one by one
 *  rather than reached by a directory prefix. */
const LOCAL_QUERIES = ["src/lib/pulls/queries.ts", "src/lib/issues/queries.ts"];
/** The modules that declare repo-scoped mutation hooks, shared by the two
 *  mutation-identity checks. */
const isMutationModule = (file) =>
  (file.startsWith(QUERIES_DIR) && file.endsWith(".ts")) ||
  file === JIRA_QUERIES ||
  LOCAL_QUERIES.includes(file);
/** Floor near the real module count (38): a low floor would let a typo in
 *  QUERIES_DIR leave the scan almost entirely inert and still pass. */
const MUTATION_MODULES_SCANNED = {
  atLeast: 35,
  hint: `${QUERIES_DIR}*.ts + ${JIRA_QUERIES} + ${LOCAL_QUERIES.join(" + ")}`,
};

// The mutation-identity family. Anchors are deliberately structural rather than
// textual: the defect is a repo-scoped call carrying no mutation key, so its
// pending write holds the next repo's controls busy — a shape, not a spelling.
/** Any `function use…` declaration, exported or not. The generic list is matched
 *  separately (see `paramListOpen`): `function useRepoMutation<TArgs, TData>(` puts
 *  a `<` where a `(` would be, and an anchor demanding the paren swallows the whole
 *  hook silently. */
const HOOK_DECL_RE = /\b(export\s+)?function\s+(use[A-Za-z0-9_$]*)\s*(?=[<(])/g;
const MUTATION_CALL_RE = /\buse(?:Repo)?Mutation\s*\(/g;
/** `identity:` is useRepoMutation's spelling of `mutationKey:`; either pins. */
const MUTATION_KEYED_RE = /\b(?:identity|mutationKey)\s*:/;
/** A `repo` parameter in the hook's own signature — the closure a pin names. A
 *  hook taking repo through its VARIABLES instead is the other valid remedy (see
 *  useMoveBoardCard) and correctly never matches. */
const REPO_PARAM_RE = /(?:^|[,{(\s])repo\s*[:,)]/;
const CREATE_HOOK_RE = /Create/;
/** Widest gap (normalized chars) still read as one callback for the seed arm.
 *  Past it the seed is not seen and the site reads CLEAN — the bound fails toward
 *  under-matching, so a long `onSuccess` body can hide its own `setQueryData`.
 *  (Within the window an unrelated pair can also over-match, which is merely a
 *  named file and line with the allowlist as its remedy.) */
const SEED_WINDOW = 400;
/** The GAP-5 shape: a response seeded into a hook-scope key on success, whose
 *  pending write a pin keeps from holding the newly-live repo's controls. */
const ONSUCCESS_SEED_RE = new RegExp(
  `\\bonSuccess\\s*:[\\s\\S]{0,${SEED_WINDOW}}?\\bsetQueryData\\b`,
);

/** Index of the balanced closer for the opener at `open`, or -1. Counts brackets
 *  inside string literals too (`view` keeps them), so an unbalanced bracket in a
 *  string would skew the span — zero instances in the scanned scope today. */
function balancedEnd(text, open, o, c) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === o) depth++;
    else if (text[i] === c) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Index of the `(` opening a declaration's parameter list, stepping over a generic
 *  list first, or -1. `>` preceded by `=` is an arrow inside a constraint, not a
 *  close. */
function paramListOpen(text, from) {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] === "<") {
    let depth = 0;
    for (; i < text.length; i++) {
      if (text[i] === "<") depth++;
      else if (text[i] === ">" && text[i - 1] !== "=") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    while (i < text.length && /\s/.test(text[i])) i++;
  }
  return text[i] === "(" ? i : -1;
}

/** A parameter or argument list split on its TOP-LEVEL commas. With `params`, `<`
 *  opens a nesting level and `>` closes one unless an `=` precedes it (an arrow), so
 *  a comma inside `Promise<Record<string, unknown>>` stays in its parameter.
 *  Argument lists keep bracket-only counting: there `<`/`>` can be comparisons, and
 *  `a < b, c > d` is two arguments. */
export function splitTopLevel(list, { params = false } = {}) {
  const out = [];
  let depth = 0;
  let cur = "";
  let prev = "";
  for (const ch of list) {
    if ("([{".includes(ch) || (params && ch === "<")) depth++;
    else if (")]}".includes(ch) || (params && ch === ">" && prev !== "="))
      depth--;
    prev = ch;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Both spellings of a conditional key spread, the same name required on each side
 *  so an unrelated pair can't match: `...(x ? { mutationKey: x } : {})` and
 *  `...(x && { mutationKey: x })`. */
const CONDITIONAL_KEY_SPREAD_RE =
  /\.\.\.\(\s*([A-Za-z_$][\w$]*)\s*(?:\?\s*\{\s*mutationKey\s*:\s*\1\s*\}\s*:\s*\{\s*\}|&&\s*\{\s*mutationKey\s*:\s*\1\s*\})\s*\)/;

/**
 * The index of the wrapper parameter its mutation key is CONDITIONAL on (a
 * `...(key ? { mutationKey: key } : {})` spread; no live instance, fixture-pinned),
 * or -1 when the key is unconditional.
 * `MUTATION_KEYED_RE` sees that spread and reads the wrapper as pinned no matter
 * what its delegators pass, so the obligation moves to the delegating call: it has
 * to supply the argument.
 */
function conditionalKeyParam(wrapper, text) {
  for (const call of wrapper.body.matchAll(MUTATION_CALL_RE)) {
    const open = wrapper.bodyOpen + call.index + call[0].length - 1;
    const close = balancedEnd(text, open, "(", ")");
    if (close < 0) continue;
    const spread = text.slice(open, close).match(CONDITIONAL_KEY_SPREAD_RE);
    if (!spread) continue;
    const index = wrapper.params.findIndex((p) =>
      new RegExp(`^${spread[1]}\\s*[?:]`).test(p),
    );
    if (index >= 0) return index;
  }
  return -1;
}

/** Every `function use…` in the file that takes a `repo`, as body spans. */
function repoScopedHooks(text) {
  const out = [];
  for (const decl of text.matchAll(HOOK_DECL_RE)) {
    const paramOpen = paramListOpen(text, decl.index + decl[0].length);
    if (paramOpen < 0) continue;
    const paramClose = balancedEnd(text, paramOpen, "(", ")");
    if (paramClose < 0) continue;
    if (!REPO_PARAM_RE.test(text.slice(paramOpen + 1, paramClose))) continue;
    const bodyOpen = text.indexOf("{", paramClose);
    if (bodyOpen < 0) continue;
    const bodyClose = balancedEnd(text, bodyOpen, "{", "}");
    if (bodyClose < 0) continue;
    out.push({
      name: decl[2],
      exported: Boolean(decl[1]),
      params: splitTopLevel(text.slice(paramOpen + 1, paramClose), {
        params: true,
      }),
      bodyOpen,
      body: text.slice(bodyOpen, bodyClose),
    });
  }
  return out;
}

/**
 * Scanner: create-family and cache-seeding mutations declared in a repo-scoped hook
 * whose call carries no `identity:`/`mutationKey:`. Works on the whitespace-
 * normalized whole-file view, so a key formatted across several lines — as the
 * five-line jira-create-issue pin is — still reads as pinned.
 *
 * Delegation is resolved ONE level: a create hook that builds its mutation through a
 * private wrapper in the same file (useCreateWebhook → useWebhookMutation) is checked
 * at the wrapper, which is where the key has to go — and when that wrapper's key
 * rides a conditional spread on an optional parameter, at the DELEGATING CALL too,
 * which is the only place the difference is visible. The shapes this still cannot
 * see are listed in the check's `message`, which is the single inventory; some of
 * them are live, so a green run is not a clean bill for the whole class.
 */
const unpinnedMutationIdentity = ({ text, starts }) => {
  const hits = new Set();
  const hooks = repoScopedHooks(text);
  const wrappers = hooks.filter((h) => !h.exported);
  /** Unpinned mutation calls in `scope`, reported at their own line. */
  const unpinned = (scope, accept) => {
    for (const call of scope.body.matchAll(MUTATION_CALL_RE)) {
      const callOpen = scope.bodyOpen + call.index + call[0].length - 1;
      const callClose = balancedEnd(text, callOpen, "(", ")");
      if (callClose < 0) continue;
      const args = text.slice(callOpen, callClose);
      if (MUTATION_KEYED_RE.test(args)) continue;
      if (!accept(args)) continue;
      hits.add(lineAt(starts, callOpen));
    }
  };
  for (const hook of hooks) {
    if (!hook.exported) continue;
    const isCreate = CREATE_HOOK_RE.test(hook.name);
    unpinned(hook, (args) => isCreate || ONSUCCESS_SEED_RE.test(args));
    if (!isCreate) continue;
    for (const wrapper of wrappers) {
      const delegation = new RegExp(`\\b${wrapper.name}\\s*\\(`, "g");
      let delegates = false;
      // A conditionally-keyed wrapper is only pinned if the delegating call passes
      // the argument the key hangs on; the wrapper body reads pinned either way.
      // Depends on the wrapper alone, so it is resolved once per wrapper.
      const needed = conditionalKeyParam(wrapper, text);
      for (const call of hook.body.matchAll(delegation)) {
        delegates = true;
        if (needed < 0) continue;
        const callOpen = hook.bodyOpen + call.index + call[0].length - 1;
        const callClose = balancedEnd(text, callOpen, "(", ")");
        if (callClose < 0) continue;
        const passed = splitTopLevel(
          text.slice(callOpen + 1, callClose),
        ).length;
        if (passed <= needed) hits.add(lineAt(starts, callOpen));
      }
      if (delegates) unpinned(wrapper, () => true);
    }
  }
  return [...hits];
};

// The settle-cache-write family. query-core runs `onMutate` once, at mutate time,
// and keeps its result on the mutation's state, so a key returned there is the one
// the write fired under whichever options the settle callbacks run from.
/** A settle callback as a property (`onSuccess:`) or a method (`onSuccess(…) {`);
 *  a member CALL (`opts.onSuccess(…)`) is excluded by the lookbehind. */
const SETTLE_CALLBACK_RE =
  /(?<![\w$.])on(?:Success|Error|Settled)\s*(:\s*|(?=\())/g;
const CACHE_WRITE_RE = /\bset(?:Query|Queries)Data\s*/g;
/** Identity axes by name: a bare one in a settle key is hook scope even where the
 *  scan finds no declaration for it (a module-level helper's parameter). */
const IDENTITY_NAMES = new Set(["repo", "lens", "link"]);
const FUNCTION_DECL_RE = /\bfunction\s+[A-Za-z_$][\w$]*\s*(?=[<(])/g;
/** A hook spelled as an arrow: `const useX = (…) => …`. */
const ARROW_HOOK_RE = /\b(?:const|let)\s+use[A-Za-z0-9_$]*\s*=\s*/g;
/** A plain `name = …` assignment (not `==`, `=>`, or a compound operator). */
const ASSIGN_RE = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*=(?![=>])/g;
const DECL_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*|[{[])/g;
const IDENT_RE = /[A-Za-z_$][\w$]*/g;
/** Words a key expression can carry that never name a binding. */
const NON_BINDINGS = new Set([
  "as",
  "async",
  "await",
  "const",
  "false",
  "function",
  "in",
  "instanceof",
  "keyof",
  "new",
  "null",
  "readonly",
  "return",
  "satisfies",
  "this",
  "true",
  "typeof",
  "undefined",
  "void",
]);

/** Index where the expression starting at `from` ends: a top-level `,`, `;`, or the
 *  closer of the bracket that contains it. Brackets inside string literals count,
 *  the residual `balancedEnd` shares. */
function expressionEnd(text, from) {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) {
      if (depth === 0) return i;
      depth--;
    } else if ((ch === "," || ch === ";") && depth === 0) return i;
  }
  return text.length;
}

/** The function literal (arrow or `function`) at `at`: its parameter text and its
 *  body span, or null when the value is anything else — a callback passed by name,
 *  or a call returning one. */
function functionLiteralAt(text, at) {
  let i = at;
  const rest = () => text.slice(i);
  const skipWs = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  if (/^async\b/.test(rest())) {
    i += 5;
    skipWs();
  }
  let params;
  if (/^function\b/.test(rest())) {
    i += 8;
    skipWs();
    i += rest().match(/^[A-Za-z_$][\w$]*/)?.[0].length ?? 0;
    const open = paramListOpen(text, i);
    if (open < 0) return null;
    const close = balancedEnd(text, open, "(", ")");
    const bodyOpen = text.indexOf("{", close);
    if (close < 0 || bodyOpen < 0) return null;
    return {
      params: text.slice(open + 1, close),
      start: bodyOpen,
      end: balancedEnd(text, bodyOpen, "{", "}"),
    };
  }
  const single = rest().match(/^([A-Za-z_$][\w$]*)\s*=>\s*/);
  if (single) {
    params = single[1];
    i += single[0].length;
  } else {
    const open = paramListOpen(text, i);
    if (open < 0) return null;
    const close = balancedEnd(text, open, "(", ")");
    if (close < 0) return null;
    params = text.slice(open + 1, close);
    i = close + 1;
    skipWs();
    // A return-type annotation sits between the list and the arrow.
    if (text[i] === ":") i = text.indexOf("=>", i);
    if (i < 0 || !rest().startsWith("=>")) return null;
    i += 2;
    skipWs();
  }
  if (text[i] === "{")
    return { params, start: i, end: balancedEnd(text, i, "{", "}") };
  return { params, start: i, end: expressionEnd(text, i) };
}

/** Names a destructuring pattern's inside binds: `a`, the `b` of `a: b`, and the
 *  same again inside nested patterns. */
function patternBindings(inner, names) {
  for (const part of splitTopLevel(inner, { params: true })) {
    const element = part.replace(/^\.\.\./, "");
    const renamed = element.match(/^[A-Za-z_$][\w$]*\s*:\s*/);
    const target = renamed ? element.slice(renamed[0].length) : element;
    bindingTarget(target, names);
  }
}

/** Names one binding target binds: an identifier, or a nested pattern. */
function bindingTarget(target, names) {
  const open = target[0];
  if (open === "{" || open === "[") {
    const close = balancedEnd(target, 0, open, open === "{" ? "}" : "]");
    if (close > 0) patternBindings(target.slice(1, close), names);
    return;
  }
  const name = target.match(/^[A-Za-z_$][\w$]*/);
  if (name) names.add(name[0]);
}

/** The method body at `at` (`onSuccess(…) { … }` with `at` on the `(`), or null
 *  when the parentheses open a call rather than a method definition. */
function methodLiteralAt(text, at) {
  const close = balancedEnd(text, at, "(", ")");
  if (close < 0) return null;
  let i = close + 1;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== "{") return null;
  return {
    params: text.slice(at + 1, close),
    start: i,
    end: balancedEnd(text, i, "{", "}"),
  };
}

/** Whether a parameter's OWN annotation is a function type, read at its top level:
 *  `f: () => T` is, `opts: { onDone?: () => void }` is not. A default value ends
 *  the annotation. */
function hasFunctionType(param) {
  let depth = 0;
  let typed = false;
  for (let i = 0; i < param.length; i++) {
    const ch = param[i];
    if ("([{<".includes(ch)) depth++;
    else if (")]}".includes(ch) || (ch === ">" && param[i - 1] !== "="))
      depth--;
    else if (depth === 0 && ch === ":") typed = true;
    else if (depth === 0 && typed && ch === "=") return param[i + 1] === ">";
  }
  return false;
}

/** The names a parameter list binds; with `valuesOnly`, a parameter whose type
 *  is a function is skipped — a key built THROUGH a passed-in builder is fine. */
function parameterBindings(list, valuesOnly = false) {
  const names = new Set();
  for (const param of splitTopLevel(list, { params: true })) {
    if (valuesOnly && hasFunctionType(param)) continue;
    bindingTarget(param.replace(/^\.\.\./, ""), names);
  }
  return names;
}

/** Every `const`/`let`/`var` in `src`, in order, as its bound names, its offset,
 *  and the expression its value comes from: the initializer, or the iterable of a
 *  `for (… of|in …)` head (empty when there is neither). */
function declarations(src) {
  const out = [];
  for (const m of src.matchAll(DECL_RE)) {
    const names = new Set();
    let after = m.index + m[0].length;
    if (m[1] === "{" || m[1] === "[") {
      const open = after - 1;
      const close = balancedEnd(src, open, m[1], m[1] === "{" ? "}" : "]");
      if (close < 0) continue;
      patternBindings(src.slice(open + 1, close), names);
      after = close + 1;
    } else names.add(m[1]);
    const source = src
      .slice(after)
      .match(/^\s*(?::[^=]*)?=(?!=)|^\s+(?:of|in)\s+/);
    const initStart = source ? after + source[0].length : after;
    out.push({
      at: m.index,
      names,
      init: source ? src.slice(initStart, expressionEnd(src, initStart)) : "",
    });
  }
  return out;
}

/** Every plain assignment in `src` as the same shape {@link declarations} returns,
 *  so a binding declared bare and assigned later is read at its assignment. */
function assignments(src) {
  return [...src.matchAll(ASSIGN_RE)].map((m) => {
    const initStart = m.index + m[0].length;
    return {
      at: m.index,
      names: new Set([m[1]]),
      init: src.slice(initStart, expressionEnd(src, initStart)),
    };
  });
}

/** The hook scopes the scan reads: every `function` declaration and every arrow
 *  `const use… =`, as parameter text plus body span. */
function hookHosts(text) {
  const hosts = [];
  for (const decl of text.matchAll(FUNCTION_DECL_RE)) {
    const open = paramListOpen(text, decl.index + decl[0].length);
    if (open < 0) continue;
    const close = balancedEnd(text, open, "(", ")");
    const bodyOpen = close < 0 ? -1 : text.indexOf("{", close);
    const bodyClose = bodyOpen < 0 ? -1 : balancedEnd(text, bodyOpen, "{", "}");
    if (bodyClose < 0) continue;
    hosts.push({ params: text.slice(open + 1, close), bodyOpen, bodyClose });
  }
  for (const decl of text.matchAll(ARROW_HOOK_RE)) {
    const fn = functionLiteralAt(text, decl.index + decl[0].length);
    if (!fn || fn.end < 0) continue;
    hosts.push({ params: fn.params, bodyOpen: fn.start, bodyClose: fn.end });
  }
  return hosts;
}

/** The binding names an expression reads: no member names (`ctx.key` reads `ctx`),
 *  no object-literal property names, nothing inside a string literal. A template's
 *  `${…}` parts are kept, since they are code. */
function bareReferences(expr) {
  const code = expr
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, (tpl) =>
      [...tpl.matchAll(/\$\{([^}]*)\}/g)].map((p) => p[1]).join(" "),
    );
  const out = [];
  for (const m of code.matchAll(IDENT_RE)) {
    const before = code.slice(0, m.index).trimEnd();
    if (/[\w$]$/.test(code.slice(0, m.index))) continue;
    if (before.endsWith(".") && !before.endsWith("...")) continue;
    const after = code.slice(m.index + m[0].length).trimStart();
    if (/^:(?!:)/.test(after) && /[{,]$/.test(before)) continue;
    if (NON_BINDINGS.has(m[0])) continue;
    out.push(m[0]);
  }
  return out;
}

/**
 * Scanner: a `setQueryData`/`setQueriesData` inside an `onSuccess`/`onError`/
 * `onSettled` function literal whose KEY argument reads hook scope — a bare
 * `repo`/`lens`/`link`, a value parameter of the enclosing function, a name declared
 * in its body outside the callback, or a callback local built from any of those.
 * Reads of the callback's own parameters (`ctx.key`, `args.number`) are what a fix
 * looks like. The shapes it cannot see are listed in the check's `message`.
 */
const settleCacheWriteFromHookScope = ({ text, starts }) => {
  const hits = new Set();
  const hosts = hookHosts(text);
  for (const m of text.matchAll(SETTLE_CALLBACK_RE)) {
    const at = m.index + m[0].length;
    const callback =
      m[1] === "" ? methodLiteralAt(text, at) : functionLiteralAt(text, at);
    if (!callback || callback.end < 0) continue;
    // Every function around the callback is hook scope it can close over, not just
    // the innermost: a callback built in a nested helper still reads the hook's.
    const hookScope = new Set();
    for (const host of hosts) {
      if (!(host.bodyOpen < m.index && m.index < host.bodyClose)) continue;
      for (const name of parameterBindings(host.params, true))
        hookScope.add(name);
      const outside =
        text.slice(host.bodyOpen, m.index) +
        text.slice(callback.end, host.bodyClose);
      for (const { names } of declarations(outside))
        for (const name of names) hookScope.add(name);
    }
    const body = text.slice(callback.start, callback.end);
    const own = parameterBindings(callback.params);
    const tainted = new Set();
    const readsHookScope = (expr) =>
      bareReferences(expr).some((name) => {
        if (tainted.has(name)) return true;
        if (own.has(name)) return false;
        return IDENTITY_NAMES.has(name) || hookScope.has(name);
      });
    // Taint is sticky: a binding that ever held hook scope stays suspect, since the
    // scan is not flow-sensitive and a later clean assignment can follow the write.
    const bindings = [...declarations(body), ...assignments(body)].sort(
      (a, b) => a.at - b.at,
    );
    for (const { names, init } of bindings) {
      const fromHookScope = readsHookScope(init);
      for (const name of names) {
        if (fromHookScope) tainted.add(name);
        else own.add(name);
      }
    }
    for (const write of body.matchAll(CACHE_WRITE_RE)) {
      const at = callback.start + write.index + write[0].length;
      const open = paramListOpen(text, at);
      if (open < 0) continue;
      const key = text.slice(open + 1, expressionEnd(text, open + 1));
      if (readsHookScope(key))
        hits.add(lineAt(starts, callback.start + write.index));
    }
  }
  return [...hits];
};

// The raw-mutation family. Every mutation is built through src/lib/started-mutation.ts,
// whose `useMutation` runs each mutation's mutationFn and callbacks from the options
// in effect when it started (the observer's at the `mutate` call); a VALUE binding
// of react-query's own constructors anywhere else is a construction that skips it.
// Threat model: these scans target accidental use, not deliberate evasion.
const STARTED_MUTATION = "src/lib/started-mutation.ts";
/** react-query's ways to make a mutation without the helper, by exported name:
 *  the hook and its observer, the cache and mutation classes (`new
 *  MutationCache().build(…)`), and hydration, which rebuilds dehydrated
 *  mutations from the client's defaults rather than any render's options. */
const RAW_MUTATION_NAMES = new Set([
  "useMutation",
  "MutationObserver",
  "MutationCache",
  "Mutation",
  "hydrate",
  "HydrationBoundary",
]);
/** One escape at a sticky position: `\x` + 2 hex, `\u{…}`, `\u` + 4 hex, a line
 *  continuation (in the joined view, a backslash before a space), or any other
 *  escaped character. */
const ESCAPE_STICKY =
  /\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|( )|([\s\S]))/y;
const SIMPLE_ESCAPES = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  v: "\v",
  0: "\0",
};
/** A character an identifier can hold past its first. */
const ID_CHAR_RE = /^[\p{ID_Continue}$\p{Join_Control}]$/u;

/** The value one escape at `i` spells, or null when it spells nothing readable
 *  (an out-of-range code point); `length` is how much source it covers. */
function escapeAt(text, i) {
  ESCAPE_STICKY.lastIndex = i;
  const m = ESCAPE_STICKY.exec(text);
  if (!m) return null;
  const hex = m[1] ?? m[2] ?? m[3];
  if (hex !== undefined) {
    const code = Number.parseInt(hex, 16);
    return code <= 0x10ffff
      ? { value: String.fromCodePoint(code), length: m[0].length, hex: true }
      : null;
  }
  if (m[4] !== undefined) return { value: "", length: 2, hex: false };
  return {
    value: SIMPLE_ESCAPES[m[5]] ?? m[5],
    length: 2,
    hex: false,
  };
}

/** The value a string literal's raw body spells, cooked as JS reads it: every
 *  escape decoded, a backslash before any other character dropped, and a line
 *  continuation dropped with its backslash. */
export function cookStringBody(body) {
  let out = "";
  for (let i = 0; i < body.length; ) {
    const e = body[i] === "\\" ? escapeAt(body, i) : null;
    if (e) {
      out += e.value;
      i += e.length;
    } else {
      out += body[i];
      i++;
    }
  }
  return out;
}

/** `text` with escapes cooked in place wherever that keeps its lexical shape:
 *  inside a string or template literal every escape, unless it spells a quote
 *  or a backslash (which would re-lex the literal); outside one only an escape
 *  spelling a name character. So an escaped name or quoted member reads as
 *  written, and string and bracket tracking over the result still reads what
 *  the source reads. `at[i]` is the source offset decoded index `i` came from. */
export function cookSource(text) {
  let out = "";
  const at = [];
  let quote = null;
  for (let i = 0; i < text.length; ) {
    if (text[i] === "\\") {
      const e = escapeAt(text, i);
      const length = e ? e.length : 1;
      const decode =
        e !== null &&
        (quote === null
          ? e.hex && ID_CHAR_RE.test(e.value)
          : !/["'`\\]/.test(e.value));
      const piece = decode ? e.value : text.slice(i, i + length);
      for (let k = 0; k < piece.length; k++) {
        out += piece[k];
        at.push(decode ? i : i + k);
      }
      i += length;
      continue;
    }
    const c = text[i];
    if (quote === null) {
      if (c === '"' || c === "'" || c === "`") quote = c;
    } else if (c === quote) quote = null;
    out += c;
    at.push(i);
    i++;
  }
  return { text: out, at };
}

/** Whether a string literal's raw body names react-query or the core it
 *  re-exports, at any subpath: cooked, with backslashes read as separators and
 *  case folded (both resolve on Windows), normalized, then matched as a path
 *  segment anywhere, so a route through `node_modules` counts too. */
const reachesReactQuery = (body) =>
  /(?:^|\/)@tanstack\/(?:react-query|query-core)(?:\/|$)/.test(
    normalizeSpecifier(
      cookStringBody(body).replaceAll("\\", "/").toLowerCase(),
    ),
  );
/** A string or template literal, its quote in group 1 and raw body in group 2. */
const STRING_LITERAL_RE = /(["'`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g;
/** An import statement's clause plus its specifier, with or without whitespace
 *  around the clause (`import{x}from"y"`). `import(` and `import.meta` are other
 *  arms'. */
const IMPORT_FROM_RE =
  /\bimport\b(?!\s*[(.])\s*([^;]*?)\s*\bfrom\s*(["'`])((?:\\[\s\S]|(?!\2)[^\\])*)\2/g;
/** An export statement's clause plus its specifier, bounded like
 *  REEXPORT_SPECIFIER_RE so a semicolon-less declaration can't pair with a later
 *  statement's `from`. */
const EXPORT_FROM_RE =
  /\bexport\b((?:(?!\b(?:import|export)\b)[^;])*?)\bfrom\s*(["'`])((?:\\[\s\S]|(?!\2)[^\\])*)\2/g;
/** A call whose argument names a module: `import(…)`, `require(…)` (TS
 *  `import x = require(…)` included), and Vite's `import.meta.glob(…)` with its
 *  optional type argument. No space before the paren, as the formatter writes a
 *  call and Vite's own glob pattern reads one, so prose ("will require (…)")
 *  never matches. */
const MODULE_CALL_RE =
  /(?<![\w$.])(import|require|import\.meta\.glob(?:Eager)?(?:<\w+>)?)\(/g;
/** A template's static head that stays inside the app: `./` or the `@/` alias. */
const LOCAL_TEMPLATE_HEAD_RE = /^(?:\.\/|@\/)/;
/** `import type …` / `export type { … }`: erased, so it binds no value. A bare
 *  `type` default binding (`import type from`, `import type, {`) is not one. */
const TYPE_ONLY_CLAUSE_RE = /^type(?:\s*[{*]|\s+[\p{ID_Start}$_])/u;
/** A default binding leading a clause (`rq` in `import rq, { … }`). */
const DEFAULT_BINDING_RE =
  /^[\p{ID_Start}$_][\p{ID_Continue}$\p{Join_Control}]*\s*(?:,|$)/u;

/** The top-level comma-separated pieces of `text`, trimmed; commas inside
 *  strings and brackets don't split. Null when a bracket or string never closes. */
function topLevelPieces(text) {
  const pieces = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") i = stringEnd(text, i);
    else if (c === "{" || c === "(" || c === "[") i = literalEnd(text, i);
    else if (c === ",") {
      pieces.push(text.slice(start, i).trim());
      start = i + 1;
    }
    if (i === -1) return null;
  }
  pieces.push(text.slice(start).trim());
  return pieces;
}

/** Whether a `{ … }` clause reads a raw constructor, or the module's default, as
 *  a VALUE: an inline `type` entry is erased, the name before `as` is the export
 *  read, and a string-named one (`"useMutation" as x`) is cooked first. A
 *  `default` entry is a default import or re-export, and a CommonJS build's
 *  default is the whole module. */
function bindsRawConstructor(braces) {
  return braces.split(",").some((raw) => {
    const entry = raw.trim();
    if (!entry || /^type\s/.test(entry)) return false;
    // `as` needs whitespace before it, or a string name's closing quote.
    const name = entry.split(/(?<=["'`]|\s)as\s+/)[0].trim();
    const quoted = /^(["'`])([\s\S]*)\1$/.exec(name);
    const exported = quoted ? cookStringBody(quoted[2]) : name;
    return exported === "default" || RAW_MUTATION_NAMES.has(exported);
  });
}

/** Whether a module call's argument text reaches react-query. A single plain
 *  string literal (parentheses unwrapped) is read for its exact package. Any
 *  other argument fails when it mentions `tanstack`, and otherwise when the file
 *  holds a react-query string outside its import and export specifiers, unless
 *  it is a template whose static head is local (`./`, `@/`): a concatenation, a
 *  `${}` or a variable can assemble the specifier unseen. A glob fails on any
 *  pattern that reaches the package or mentions `node_modules` or `tanstack`,
 *  literal or not, since a wildcard can stand for the package segment. */
function moduleCallReaches(kind, args, fileReaches) {
  if (/glob/.test(kind)) {
    for (const m of args.matchAll(STRING_LITERAL_RE))
      if (
        reachesReactQuery(m[2]) ||
        /node_modules|tanstack/i.test(cookStringBody(m[2]))
      )
        return true;
    return false;
  }
  const pieces = topLevelPieces(args);
  if (pieces === null) return true;
  let first = pieces[0];
  while (first.startsWith("(") && literalEnd(first, 0) === first.length - 1)
    first = first.slice(1, -1).trim();
  const literal = /^(["'`])((?:\\[\s\S]|(?!\1)[^\\])*)\1$/.exec(first);
  // A plain literal is judged by its exact package alone, so another TanStack
  // package (react-virtual, react-form) or a local path naming it passes.
  if (literal && !(literal[1] === "`" && literal[2].includes("${")))
    return reachesReactQuery(literal[2]);
  if (/tanstack/i.test(cookStringBody(first))) return true;
  if (
    literal &&
    LOCAL_TEMPLATE_HEAD_RE.test(
      cookStringBody(literal[2].slice(0, literal[2].indexOf("${"))),
    )
  )
    return false;
  return fileReaches();
}

/** What may precede a method definition's name: a member's start (`{` `;` `,`
 *  `}`), a generator star, or a modifier. */
const METHOD_HEAD_RE =
  /(?:^|[{;,}*]|(?<![\w$])(?:async|static|public|private|protected|override|get|set))\s*$/;

/** Whether a module-call match is a method named `import`/`require` instead: its
 *  parameter list is followed by a body, or by a return type with the name at a
 *  member's start. A call in a ternary (`? import(…) :`) is not one. */
function isMethodDefinition(text, match, close) {
  const next = /^\s*([{:])/.exec(text.slice(close + 1, close + 40));
  if (!next) return false;
  return (
    next[1] === "{" ||
    METHOD_HEAD_RE.test(text.slice(Math.max(0, match.index - 40), match.index))
  );
}

/** Scanner: react-query's mutation constructors bound as a value — imported named
 *  or aliased, re-exported (`export *` included), or reached through a module
 *  call (`import()`, `require()`, `import.meta.glob()`). A namespace or default
 *  import of either package fails whatever it is used for (a `{ default }`
 *  entry included): a namespace can be spread, destructured or passed on, so no
 *  use of one can be proven safe. Type-only imports bind no value and pass. */
const rawReactQueryMutation = (fileView) => {
  const { text, at } = cookSource(fileView.text);
  const hit = (index) => lineAt(fileView.starts, at[index]);
  const hits = new Set();
  // Where each import and export specifier's opening quote sits: those strings
  // are judged by their own arms, so they don't make a file "hold" a reach.
  const specifierAt = new Set();
  for (const re of [IMPORT_FROM_RE, EXPORT_FROM_RE])
    for (const m of text.matchAll(re))
      specifierAt.add(m.index + m[0].length - m[3].length - 2);
  let reaches;
  const fileReaches = () => {
    reaches ??= [...text.matchAll(STRING_LITERAL_RE)].some(
      (m) => !specifierAt.has(m.index) && reachesReactQuery(m[2]),
    );
    return reaches;
  };
  for (const m of text.matchAll(IMPORT_FROM_RE)) {
    if (!reachesReactQuery(m[3])) continue;
    const clause = m[1].trim();
    if (TYPE_ONLY_CLAUSE_RE.test(clause)) continue;
    const braces = /\{([^}]*)\}/.exec(clause);
    if (
      /\*\s*as\b/.test(clause) ||
      DEFAULT_BINDING_RE.test(clause) ||
      (braces && bindsRawConstructor(braces[1]))
    )
      hits.add(hit(m.index));
  }
  for (const m of text.matchAll(EXPORT_FROM_RE)) {
    if (!reachesReactQuery(m[3])) continue;
    const clause = m[1].trim();
    if (TYPE_ONLY_CLAUSE_RE.test(clause)) continue;
    const braces = /\{([^}]*)\}/.exec(clause);
    if (clause.startsWith("*") || (braces && bindsRawConstructor(braces[1])))
      hits.add(hit(m.index));
  }
  for (const m of text.matchAll(MODULE_CALL_RE)) {
    const open = m.index + m[0].length - 1;
    const close = literalEnd(text, open);
    if (
      close !== -1 &&
      !/glob/.test(m[1]) &&
      isMethodDefinition(text, m, close)
    )
      continue;
    if (
      close === -1 ||
      moduleCallReaches(m[1], text.slice(open + 1, close), fileReaches)
    )
      hits.add(hit(m.index));
  }
  return [...hits];
};

// The client's mutation cache, reached only to read it: a held, quoted, bound or
// otherwise indirect reach can hand `build(…)` a mutation the helper never saw.
const MUTATION_CACHE_RE =
  /(?<![\p{ID_Continue}$])getMutationCache(?![\p{ID_Continue}$])/gu;
/** What may follow a `getMutationCache` mention: its call, then a public read
 *  member's call, type arguments allowed (`find<TData, …>(…)`). `clear` empties
 *  the cache without making a mutation; `remove` and `resumePausedMutations` are
 *  query-core internals and stay out. */
const MUTATION_CACHE_READ_RE =
  /^\s*\(\s*\)\s*\??\.\s*(?:getAll|find|findAll|subscribe|clear|hasListeners)\s*(?:<[^()]*>)?\s*\(/;
/** The one held reference the app needs: `useMutationCacheSnapshot` keeps the
 *  cache to subscribe to it and hand it to its callers' read-only selects. The
 *  exemption is this exact statement, once, in this file; any other mention
 *  there still fails, so a new reach can't hide behind the old one. */
const CACHE_HOLDER = {
  file: "src/lib/git/queries/internal.ts",
  lead: "const cache = useQueryClient().",
  statement: "const cache = useQueryClient().getMutationCache();",
};

/** Scanner: every `getMutationCache` mention not proven a read, but for
 *  CACHE_HOLDER's statement in its own file. */
const mutationCacheAccess = (fileView, file) => {
  const { text, at } = cookSource(fileView.text);
  const hits = new Set();
  let held = false;
  for (const m of text.matchAll(MUTATION_CACHE_RE)) {
    const after = m.index + m[0].length;
    if (MUTATION_CACHE_READ_RE.test(text.slice(after, after + 120))) continue;
    const start = m.index - CACHE_HOLDER.lead.length;
    if (
      file === CACHE_HOLDER.file &&
      !held &&
      text.slice(start, start + CACHE_HOLDER.statement.length) ===
        CACHE_HOLDER.statement
    ) {
      held = true;
      continue;
    }
    hits.add(lineAt(fileView.starts, at[m.index]));
  }
  return [...hits];
};

/** Script extensions the walk never reads (it reads lowercase `.ts`/`.tsx`
 *  alone), so a file under src/ ending in one escapes every check here: any
 *  script extension in any case, and `.ts`/`.tsx` spelled in another case. */
const UNSCANNED_SCRIPT_RE = /\.(?:[cm]?js|jsx|[cm]ts)$/i;
const MIXED_CASE_TS_RE = /\.tsx?$/i;
/** Justified exceptions, each a src/ path with its reason in a comment. */
const UNSCANNED_SCRIPT_ALLOWLIST = [];

/** The paths in `paths` a check here would never read, minus `allowlist`. */
export function unscannedScripts(
  paths,
  allowlist = UNSCANNED_SCRIPT_ALLOWLIST,
) {
  return paths.filter(
    (p) =>
      (UNSCANNED_SCRIPT_RE.test(p) ||
        (MIXED_CASE_TS_RE.test(p) && !/\.tsx?$/.test(p))) &&
      !allowlist.includes(p),
  );
}

// Mutation defaults. started-mutation installs its trampolines on every
// construction, and react-query spreads a construction's own options over the
// client's defaults, so a default mutationFn or callback would be shadowed. The
// check is an allowlist of shapes, not a list of bad spellings: what it cannot
// prove harmless fails.
/** The client methods that read or write mutation defaults, hand out the live
 *  defaults object, or merge them into a construction (`defaultMutationOptions`,
 *  which a subclass or patch could override outright): any mention fails. */
const CLIENT_DEFAULTS_API_RE =
  /(?<![\w$])(?:(?:set|get)(?:DefaultOptions|MutationDefaults)|defaultMutationOptions)(?![\w$])/g;
/** Every `defaultOptions` mention, quoted or not. */
const DEFAULT_OPTIONS_TOKEN_RE = /(?<![\w$])defaultOptions(?![\w$])/g;
/** Member modifiers that may sit before a key without making it a value. */
const MEMBER_MODIFIER_RE =
  /(?<![\w$])(?:readonly|declare|public|private|protected|static|override|abstract|accessor)\s*$/;

/** Index of the bracket closing the one opened at `open` (`{`, `(`, `[` or `<`
 *  for a type argument list), skipping string and template literals and nested
 *  brackets of every kind; -1 when it never closes. `=>` is not a closer. */
function literalEnd(text, open) {
  const closer = { "{": "}", "(": ")", "[": "]", "<": ">" };
  const stack = [closer[text[open]]];
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      i = stringEnd(text, i);
      if (i === -1) return -1;
    } else if (c === "{" || c === "(" || c === "[") {
      stack.push(closer[c]);
    } else if (c === stack.at(-1) && !(c === ">" && text[i - 1] === "=")) {
      stack.pop();
      if (stack.length === 0) return i;
    } else if (c === "}" || c === ")" || c === "]") {
      return -1;
    }
  }
  return -1;
}

/** Index of the quote closing the string or template literal opened at `open`,
 *  honoring backslash escapes; -1 when it never closes. */
function stringEnd(text, open) {
  const quote = text[open];
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === quote) return i;
  }
  return -1;
}

/** The top-level entries of the object literal opened at `open`, trimmed, or
 *  null when it never closes. Commas inside strings and brackets don't split. */
function topLevelEntries(text, open) {
  const end = literalEnd(text, open);
  if (end === -1) return null;
  const pieces = topLevelPieces(text.slice(open + 1, end));
  return pieces === null ? null : pieces.filter((e) => e !== "");
}

/** Where a type annotation starting at `from` ends: the index of the first
 *  top-level `;`, `,`, `)`, `}` or assignment `=`, with nested brackets, type
 *  arguments and strings skipped; -1 when nothing ends it. */
function annotationEnd(text, from) {
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") i = stringEnd(text, i);
    else if (c === "{" || c === "(" || c === "[" || c === "<")
      i = literalEnd(text, i);
    else if (c === "=" && text[i + 1] !== ">" && text[i + 1] !== "=") return i;
    else if (c === ";" || c === "," || c === ")" || c === "}") return i;
    if (i === -1) return -1;
  }
  return -1;
}

/** Whether the annotation starting at `from` holds no value: it ends at one of
 *  `enders` with no assignment `=` first, and holds no `/`, which only a value
 *  (a regex literal or a division) could, since a regex's `)` or `;` would read
 *  as the annotation's end. */
function typeOnlyAnnotation(text, from, enders) {
  const end = annotationEnd(text, from);
  return (
    end !== -1 &&
    enders.includes(text[end]) &&
    !text.slice(from, end).includes("/")
  );
}

/** Whether a defaults literal ending just before `from` closes its entry: the
 *  next token, past any `as T` / `satisfies T`, is `,` `}` `;` or `)`. Anything
 *  else reads the literal (`.constructor(…)`, `['queries']`) or assigns after it. */
function literalEndsEntry(text, from) {
  let i = from;
  for (;;) {
    while (/\s/.test(text[i] ?? "")) i++;
    const cast = /^(?:as|satisfies)(?![\w$])/.exec(text.slice(i, i + 10));
    if (!cast) break;
    const end = annotationEnd(text, i + cast[0].length);
    if (end === -1 || text[end] === "=") return false;
    i = end;
  }
  return [",", "}", ";", ")"].includes(text[i]);
}

/** Whether the `defaultOptions` mention at `index` is provably harmless: a type
 *  member or parameter annotation with no value (`defaultOptions?: T` ending at
 *  `;` `,` `)` or `}`, or `defaultOptions: T` ending a member with `;` or a
 *  parameter list with `)`), or an object-entry key (bare, quoted, or a quoted
 *  computed key) whose value is a literal holding only a bare `queries` entry
 *  and closing its entry. Member modifiers before the key are skipped. */
function harmlessDefaultOptions(text, index) {
  let after = index + "defaultOptions".length;
  let keyStart = index;
  const quote = text[index - 1];
  const quoted = quote === '"' || quote === "'" || quote === "`";
  if (quoted) {
    if (text[after] !== quote) return false;
    after++;
    keyStart = index - 1;
    if (text[index - 2] === "[") {
      if (text[after] !== "]") return false;
      after++;
      keyStart = index - 2;
    }
  }
  // A key opens a member, a parameter or an object entry.
  let head = text.slice(0, keyStart).trimEnd();
  for (
    let m = MEMBER_MODIFIER_RE.exec(head);
    m;
    m = MEMBER_MODIFIER_RE.exec(head)
  )
    head = head.slice(0, m.index).trimEnd();
  if (!["{", ";", "(", ","].includes(head.at(-1))) return false;
  const rest = text.slice(after);
  const optional = !quoted && /^\s*\?\s*:/.exec(rest);
  if (optional)
    return typeOnlyAnnotation(text, after + optional[0].length, [
      ";",
      ",",
      ")",
      "}",
    ]);
  const colon = /^\s*:\s*/.exec(rest);
  if (!colon) return false;
  const valueAt = after + colon[0].length;
  if (text[valueAt] === "{") {
    const entries = topLevelEntries(text, valueAt);
    return (
      entries !== null &&
      entries.every((e) => /^queries(?:\s*:|$)/.test(e)) &&
      literalEndsEntry(text, literalEnd(text, valueAt) + 1)
    );
  }
  if (quoted) return false;
  return typeOnlyAnnotation(text, valueAt, [";", ")"]);
}

/** Scanner: any mention of the client's defaults API, and any `defaultOptions`
 *  mention not proven harmless (see harmlessDefaultOptions). So a shorthand, a
 *  binding, an assignment, a member read or write, a getter or method, a
 *  parameter default, a class field initializer, a defaults literal with any
 *  entry but `queries` (`mutations`, a spread, a quoted or computed key) or read
 *  after it closes, and a value that is not a literal all fail. A parameter
 *  annotation followed by another parameter can't be told from an object entry,
 *  so it fails too. */
const mutationDefaults = (fileView) => {
  const { text, at } = cookSource(fileView.text);
  const hit = (index) => lineAt(fileView.starts, at[index]);
  const hits = new Set();
  for (const m of text.matchAll(CLIENT_DEFAULTS_API_RE)) hits.add(hit(m.index));
  for (const m of text.matchAll(DEFAULT_OPTIONS_TOKEN_RE)) {
    if (!harmlessDefaultOptions(text, m.index)) hits.add(hit(m.index));
  }
  return [...hits];
};

// MCP keychain writes. Target model, holding for all three pinned files since
// no file is allowlisted: a keychain write reaches Rust only through mcp.ts's
// two pinned definitions; those are called only from the flush module's two
// pinned functions; that module is reachable only through SettingsScreen's one
// pinned import; and its functions run only as the two pinned statements,
// directly inside the Save handler's body. Every token is matched on RAW source,
// comments and strings included, and a pinned Save statement holding a comment
// is never accepted, so no lexing gap can hide one.

/** The API pair and the flush module's two functions, by name. */
const MCP_KEYCHAIN_NAME_RE =
  /\b(?:setMcpSecret|deleteMcpSecret|flushMcpSecretSets|flushMcpSecretDeletes)\b/g;
/** Any mcp_secret-family word, whatever surrounds it: matched word by word, so
 *  Tauri command names and every other spelling of the family alike. */
const MCP_SECRET_COMMAND_RE = /\b[a-z0-9_]*mcp_secrets?[a-z0-9_]*\b/g;
/** Words of that family that only read. A new read-only command goes here and
 *  in its test pin. */
export const MCP_SECRET_READ_ONLY = new Set(["mcp_secret_exists"]);
/** The flush module's file stem: naming it in any form reaches the module. */
const MCP_FLUSH_MODULE_TOKEN = "flush-mcp-secrets";

/** mcp.ts's two keychain definitions, each pinned as its whole statement. Any
 *  other token mention in that file fails: a wrapper, a second invoke, a
 *  command constant, a re-export under another name. */
export const MCP_SECRET_API = {
  file: "src/lib/git/api/mcp.ts",
  definitions: [
    'export const setMcpSecret = (serverId: string, key: string, value: string) => COLD_START ? Promise.resolve(coldStartSetSecret(mcpRef(serverId, key), value)) : invoke<void>("set_mcp_secret", { serverId, key, value });',
    'export const deleteMcpSecret = (serverId: string, key: string) => COLD_START ? Promise.resolve(coldStartDeleteSecret(mcpRef(serverId, key))) : invoke<void>("delete_mcp_secret", { serverId, key });',
  ],
};

/** The flush module's code, each piece pinned as its whole statement: the API
 *  import, the queue binding (a passthrough or wrapped queue would let a delete
 *  land after a later set) and the two exported functions. Any other token
 *  mention in that file fails (module-scope side effects included), and so does
 *  any edit to a pinned statement, a deferred retry or a comment alike:
 *  re-point the pins in the same change. */
export const MCP_FLUSH_MODULE = {
  file: "src/features/settings/mcp/flush-mcp-secrets.ts",
  statements: [
    'import { deleteMcpSecret, setMcpSecret } from "@/lib/git/api";',
    "const inOrder = createCallQueue();",
    "export async function flushMcpSecretSets( sets: readonly McpStagedSecret[], ): Promise<McpSetFailure[]> { const failed: McpSetFailure[] = []; for (const entry of sets) { try { await inOrder(() => setMcpSecret(entry.serverId, entry.key, entry.value)); } catch (error) { failed.push({ entry, error }); } } return failed; }",
    "export function flushMcpSecretDeletes( deletes: readonly McpSecretDelete[], ): void { for (const { serverId, key } of deletes) void inOrder(() => deleteMcpSecret(serverId, key)).catch(() => undefined); }",
  ],
};

/** The settings Save's own uses of the flush module. `imports` matches once,
 *  anywhere in the file at a code position. `onSubmit` statements match on the
 *  masked source, once each, only directly inside the Save body (the
 *  `onSubmit: async (…) => {` entry of the file's one `useAppForm({…})` call):
 *  after `;`, `{` or `}`, with every enclosing brace in the body a block
 *  (try, finally, else, do, catch, if/for/while/switch/catch heads, or a bare
 *  block), never a closure, method, object literal, case or label, and holding
 *  nothing but code (a comment inside voids the match). */
export const MCP_FLUSH_CALLER = {
  file: "src/features/settings/SettingsScreen.tsx",
  imports: [
    'import { flushMcpSecretDeletes, flushMcpSecretSets, } from "./mcp/flush-mcp-secrets";',
  ],
  onSubmit: [
    "const failed = await flushMcpSecretSets(plan.flush);",
    "flushMcpSecretDeletes(deletes);",
  ],
};

/** A pin as a global regex: tokens and punctuation exact, each run of spaces in
 *  the pin `\s*` (`\s+` between two name characters), and no name character
 *  just before it. */
function mcpPinPattern(pin) {
  const parts = pin.split(/(\s+)/);
  let re = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (/^\s+$/.test(part)) {
      const joinsNames =
        /[\w$]$/.test(parts[i - 1] ?? "") && /^[\w$]/.test(parts[i + 1] ?? "");
      re += joinsNames ? "\\s+" : "\\s*";
    } else re += escapeRe(part);
  }
  return new RegExp(`(?<![\\w$])${re}`, "g");
}

const isNameChar = (c) => c !== undefined && /[\w$]/.test(c);
const skipSpace = (masked, i) => {
  while (i < masked.length && /\s/.test(masked[i])) i++;
  return i;
};
const prevCodeIndex = (masked, i) => {
  let j = i - 1;
  while (j >= 0 && /\s/.test(masked[j])) j--;
  return j;
};
/** The name ending at `end` (inclusive), or "". */
const wordEndingAt = (masked, end) => {
  let s = end;
  while (s >= 0 && isNameChar(masked[s])) s--;
  return masked.slice(s + 1, end + 1);
};

/** Index just past the `>` closing the type arguments opened at `open`, or -1.
 *  An arrow's `=>` inside them is not a closer. */
function skipTypeArgs(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === "<") depth++;
    else if (c === ">" && masked[i - 1] !== "=" && --depth === 0) return i + 1;
    else if (c === ";") return -1;
  }
  return -1;
}

/** One depth-1 entry of an object literal, classified by its key. */
function classifyFormEntry(masked, source, s, e) {
  const text = masked.slice(s, e);
  if (text.startsWith("...")) return { kind: "spread" };
  if (text.startsWith("[")) return { kind: "computed" };
  let i = s;
  let method = false;
  const modifier = /^(?:async|get|set)\s+(?=[\w$"'[*])/.exec(text);
  if (modifier) {
    method = true;
    i += modifier[0].length;
  }
  if (masked[i] === "*") {
    method = true;
    i = skipSpace(masked, i + 1);
  }
  if (masked[i] === "[") return { kind: "computed" };
  let name;
  let kind;
  let after;
  if (source[i] === '"' || source[i] === "'") {
    const close = masked.indexOf(source[i], i + 1);
    if (close === -1 || close >= e) return { kind: "unknown" };
    name = cookStringBody(source.slice(i + 1, close));
    kind = "quoted";
    after = close + 1;
  } else {
    const word = /^(?:[A-Za-z_$][\w$]*|\d[\w.]*)/.exec(masked.slice(i, e));
    if (!word) return { kind: "unknown" };
    name = word[0];
    kind = "identifier";
    after = i + word[0].length;
  }
  if (method) return { kind: "method", name };
  const next = skipSpace(masked, after);
  if (next >= e)
    return kind === "identifier"
      ? { kind: "shorthand", name }
      : { kind: "unknown", name };
  if (masked[next] === ":") return { kind, name, value: next + 1 };
  if (masked[next] === "(" || masked[next] === "<")
    return { kind: "method", name };
  return { kind: "unknown", name };
}

/** The Save handler's body braces in the masked source: the `onSubmit` entry of
 *  the file's one `useAppForm(…)` call, whose first argument must be an object
 *  literal with no computed key, no spread after `onSubmit`, and exactly one
 *  entry named `onSubmit` in any spelling, written as
 *  `onSubmit: async (…)[: T] => {…}`. Null when any of that fails to hold, or a
 *  `useAppForm<…>` type-argument list can't be read, so nothing is exempted and
 *  the caller fails line 1. */
function mcpSaveBody(masked, source) {
  const calls = [];
  for (const m of masked.matchAll(/(?<![\w$])useAppForm(?![\w$])/g)) {
    let j = skipSpace(masked, m.index + m[0].length);
    if (masked[j] === "<") {
      j = skipTypeArgs(masked, j);
      if (j === -1) return null;
      j = skipSpace(masked, j);
    }
    if (masked[j] === "(") calls.push(j);
  }
  if (calls.length !== 1) return null;
  const open = skipSpace(masked, calls[0] + 1);
  if (masked[open] !== "{") return null;
  const close = matchBrace(masked, open);
  if (close === -1) return null;
  const entries = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i <= close; i++) {
    const c = masked[i];
    if (i === close || (c === "," && depth === 0)) {
      const s = skipSpace(masked, start);
      let e = i;
      while (e > s && /\s/.test(masked[e - 1])) e--;
      if (e > s) entries.push(classifyFormEntry(masked, source, s, e));
      start = i + 1;
    } else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
  }
  const saves = entries.filter((x) => x.name === "onSubmit");
  if (saves.length !== 1) return null;
  const at = entries.indexOf(saves[0]);
  if (entries.some((x) => x.kind === "computed" || x.kind === "unknown"))
    return null;
  if (entries.slice(at + 1).some((x) => x.kind === "spread")) return null;
  const save = saves[0];
  if (save.kind !== "identifier") return null;
  let j = skipSpace(masked, save.value);
  if (!/^async(?![\w$])/.test(masked.slice(j, j + 6))) return null;
  j = skipSpace(masked, j + 5);
  if (masked[j] !== "(") return null;
  const params = matchBrace(masked, j);
  if (params === -1) return null;
  j = skipSpace(masked, params + 1);
  if (masked[j] === ":") {
    let typeDepth = 0;
    for (j = j + 1; j < close; j++) {
      const c = masked[j];
      if (c === "=" && masked[j + 1] === ">") {
        if (typeDepth === 0) break;
        j++;
      } else if (c === "(" || c === "[" || c === "{" || c === "<") typeDepth++;
      else if (c === ")" || c === "]" || c === "}" || c === ">") typeDepth--;
    }
  }
  if (masked[j] !== "=" || masked[j + 1] !== ">") return null;
  const bodyOpen = skipSpace(masked, j + 2);
  if (masked[bodyOpen] !== "{") return null;
  const bodyClose = matchBrace(masked, bodyOpen);
  if (bodyClose === -1) return null;
  // The arrow must be the entry's whole value.
  const tail = masked.slice(bodyClose + 1, close);
  const entryEnd = tail.search(/[,}]/);
  if (!/^\s*$/.test(entryEnd === -1 ? tail : tail.slice(0, entryEnd)))
    return null;
  return { open: bodyOpen, close: bodyClose };
}

/** Whether every brace between the Save body's `{` (at `open`) and `at` is a
 *  statement block: try, finally, else, do, catch, an if/for/while/switch/catch
 *  head, or a bare block (see mcpBraceIsBlock). A closure, method, object
 *  literal, type, case or label brace, or an open paren or bracket, makes it
 *  false. */
function mcpInBlocksOnly(masked, open, at) {
  const stack = [];
  const parenOpenFor = new Map();
  const closedBlock = new Map();
  for (let i = open + 1; i < at; i++) {
    const c = masked[i];
    if (c === "(" || c === "[") stack.push({ c, i });
    else if (c === ")" || c === "]") {
      const top = stack.pop();
      if (!top || top.c === "{") return false;
      parenOpenFor.set(i, top.i);
    } else if (c === "{") {
      stack.push({
        c,
        block: mcpBraceIsBlock(masked, open, i, parenOpenFor, closedBlock),
      });
    } else if (c === "}") {
      const top = stack.pop();
      if (!top || top.c !== "{") return false;
      closedBlock.set(i, top.block);
    }
  }
  return stack.every((x) => x.c === "{" && x.block);
}

const BLOCK_HEAD_KEYWORDS = new Set(["if", "for", "while", "switch", "catch"]);
const BLOCK_KEYWORDS = new Set(["try", "finally", "else", "do", "catch"]);

/** Whether the `{` at `i` opens a statement block. After `;` or `{` it is a
 *  bare block; after `}` only when that `}` closed a block itself (so a
 *  function's object-type return annotation, `(): { ok: true } {`, never makes
 *  its body one); after `)` only behind an if/for/while/switch/catch head (or
 *  `for await`); after a name only behind try, finally, else, do or a
 *  binding-free catch. Anything else (`=>`, `:`, `=`, a function or method
 *  name) is not a block. */
function mcpBraceIsBlock(masked, open, i, parenOpenFor, closedBlock) {
  const j = prevCodeIndex(masked, i);
  if (j < open) return false;
  const c = masked[j];
  if (c === ";" || c === "{") return true;
  if (c === "}") return closedBlock.get(j) === true;
  if (c === ")") {
    const paren = parenOpenFor.get(j);
    if (paren === undefined) return false;
    const k = prevCodeIndex(masked, paren);
    const word = wordEndingAt(masked, k);
    if (BLOCK_HEAD_KEYWORDS.has(word)) return true;
    // `for await (…) {`
    if (word === "await")
      return (
        wordEndingAt(masked, prevCodeIndex(masked, k - word.length + 1)) ===
        "for"
      );
    return false;
  }
  if (isNameChar(c)) return BLOCK_KEYWORDS.has(wordEndingAt(masked, j));
  return false;
}

/** Scanner: every MCP keychain token on the raw source (API and flush names,
 *  mcp_secret-family words but the read-only ones, the flush module's stem),
 *  but those inside an accepted pin in its own file, plus line 1 there when a
 *  pin has no accepted match, a Save statement is accepted more than once, the
 *  Save body can't be found, or ts-mask can't lex the file. */
const mcpKeychainSites = ({ source }, file) => {
  const hits = new Set();
  const exempt = [];
  const pinned =
    file === MCP_SECRET_API.file ||
    file === MCP_FLUSH_MODULE.file ||
    file === MCP_FLUSH_CALLER.file;
  if (pinned) {
    let masked = null;
    try {
      masked = maskNonCode(source, file.endsWith(".tsx"));
    } catch (e) {
      if (!(e instanceof ScanError)) throw e;
      hits.add(1);
    }
    if (masked !== null) {
      // A pin matched on the source, accepted once at a code position.
      const anywhere = (pin) => {
        for (const m of source.matchAll(mcpPinPattern(pin))) {
          if (masked[m.index] !== source[m.index]) continue;
          exempt.push([m.index, m.index + m[0].length]);
          return;
        }
        hits.add(1);
      };
      if (file === MCP_SECRET_API.file)
        for (const pin of MCP_SECRET_API.definitions) anywhere(pin);
      else if (file === MCP_FLUSH_MODULE.file)
        for (const pin of MCP_FLUSH_MODULE.statements) anywhere(pin);
      else {
        for (const pin of MCP_FLUSH_CALLER.imports) anywhere(pin);
        const body = mcpSaveBody(masked, source);
        if (!body) hits.add(1);
        for (const pin of MCP_FLUSH_CALLER.onSubmit) {
          const accepted = body
            ? [...masked.matchAll(mcpPinPattern(pin))].filter(
                (m) =>
                  m.index > body.open &&
                  m.index + m[0].length < body.close &&
                  source.slice(m.index, m.index + m[0].length) === m[0] &&
                  ";{}".includes(masked[prevCodeIndex(masked, m.index)]) &&
                  mcpInBlocksOnly(masked, body.open, m.index),
              )
            : [];
          if (accepted.length === 1)
            exempt.push([
              accepted[0].index,
              accepted[0].index + accepted[0][0].length,
            ]);
          else hits.add(1);
        }
      }
    }
  }
  const tokens = [];
  for (const m of source.matchAll(MCP_KEYCHAIN_NAME_RE)) tokens.push(m.index);
  for (const m of source.matchAll(MCP_SECRET_COMMAND_RE))
    if (!MCP_SECRET_READ_ONLY.has(m[0])) tokens.push(m.index);
  for (
    let at = source.indexOf(MCP_FLUSH_MODULE_TOKEN);
    at !== -1;
    at = source.indexOf(MCP_FLUSH_MODULE_TOKEN, at + 1)
  )
    tokens.push(at);
  for (const at of tokens) {
    if (exempt.some(([from, to]) => at >= from && at < to)) continue;
    hits.add(lineOf(source, at));
  }
  return [...hits];
};

/**
 * A path-pinned check goes inert the moment its path moves: it scans nothing and
 * prints OK, which is the silent fail-open this file exists to prevent. Returns a
 * failure message when the scanned count leaves the pinned range, else null.
 */
export function scopePinFailure(check, scannedCount) {
  const pin = check.expectScanned;
  if (!pin) return null;
  if (pin.exactly !== undefined && scannedCount !== pin.exactly) {
    return `${check.name}: SCOPE PIN FAILED — expected to scan exactly ${pin.exactly} file(s) matching ${pin.hint}, scanned ${scannedCount}; the path moved or was renamed, so this check is inert — re-point its appliesTo`;
  }
  if (pin.atLeast !== undefined && scannedCount < pin.atLeast) {
    return `${check.name}: SCOPE PIN FAILED — expected to scan at least ${pin.atLeast} file(s) matching ${pin.hint}, scanned ${scannedCount}; the path moved or was renamed, so this check is inert — re-point its appliesTo`;
  }
  return null;
}

export const CHECKS = [
  {
    name: "hover-reveal",
    appliesTo: notVendoredUi,
    scan: anyPair(HOVER_REVEAL_PAIRS),
    allowlist: [
      // Documented product decision: the file row's inline actions.
      "src/features/repository/FileRow.tsx",
      // Pairs the hover reveal with group-focus-visible, so keyboard reaches it.
      "src/features/actions/RunDetailView.tsx",
    ],
    message:
      "hover-revealed actions are banned (gd-conventions) — keep actions always-visible, or add an allowlist entry with rationale",
  },
  {
    name: "hand-rolled-mod-key",
    // The hotkeys layer IS the platform-modifier helper, so it reads the raw
    // event flags by definition.
    appliesTo: (file) =>
      !file.startsWith("src/lib/hotkeys/") && notVendoredUi(file),
    // Each flag independently: a lone `e.metaKey` is the class in its worst
    // form (a hardcoded platform modifier), and a wrapped pair must not read as
    // clean either.
    scan: perLine(/\b(?:ctrlKey|metaKey)\b/),
    // FROZEN: the mod+Enter submit policy files (PR #202), the three MULTI-SELECT
    // modifier readers (the file row, HistoryPanel's commit list, and the
    // Projects selection module shared by the board and table layouts — each
    // answers "did the pointer hold mod or Shift", which is a property of the
    // event rather than a binding the registry could own), and DiffViewer's
    // additive-drag capture listener (the vendored selection manager's callbacks
    // carry no event, so it reads the raw flags; the modifier itself stays
    // isMac-derived). The gate blocks NEW hand-rolled sites; it is not a to-do
    // list for these.
    allowlist: [
      "src/components/markdown-editor.tsx",
      // The notification row's ArrowRight/Left disclosure accelerators fire
      // only on an unmodified press — every modifier excluded symmetrically,
      // not a platform-modifier read the registry could own.
      "src/features/activity/ActivityDock.tsx",
      "src/features/conversations/CommentComposer.tsx",
      "src/features/conversations/CommentEditor.tsx",
      "src/features/conversations/EditTitleBodyDialog.tsx",
      "src/features/diff/DiffViewer.tsx",
      "src/features/discussions/DiscussionView.tsx",
      "src/features/history/HistoryPanel.tsx",
      "src/features/plan/PlanView.tsx",
      "src/features/projects/BoardAddDialogs.tsx",
      "src/features/projects/BoardBulkFieldsDialog.tsx",
      "src/features/projects/BoardDraftEditDialog.tsx",
      "src/features/projects/board-selection.ts",
      "src/features/pulls/CommitComments.tsx",
      "src/features/pulls/CreateLocalPrDialog.tsx",
      "src/features/pulls/CreatePrDialog.tsx",
      "src/features/pulls/ReviewComposer.tsx",
      "src/features/pulls/ReviewThreads.tsx",
      "src/features/repository/FileRow.tsx",
      "src/features/research/ResearchView.tsx",
      // tabAdvances excludes every modified Tab symmetrically — not a
      // platform-modifier read, so isMac derivation would be wrong here.
      "src/lib/list-keyboard-nav.ts",
      // The disabled-button activation predicate asks "is this a bare
      // Enter/Space press?" — every modifier excluded symmetrically, not a
      // platform-modifier read the registry could own.
      "src/lib/use-disabled-reason.ts",
    ],
    message:
      "derive the platform modifier via the hotkeys helpers (formatBinding/isMac) — new hand-rolled ctrl/meta checks need an allowlist entry with rationale",
  },
  {
    name: "inline-clip-title",
    // The helper file IS the idiom; everything else routes through it.
    appliesTo: (file) =>
      file !== "src/lib/clip-title.ts" && notVendoredUi(file),
    scan: perFile(INLINE_CLIP_TITLE_RE),
    allowlist: [
      // PathText measures its two inner spans and titles the outer one, which
      // never overflows itself — clipTitle can't serve that shape. It keeps
      // the helper's remove-don't-blank contract.
      "src/components/path-text.tsx",
    ],
    message:
      "clip-measured tooltips route through clipTitle/clipTitleFromText (src/lib/clip-title.ts) — an inline rewrite re-opens the blank-title ancestor-suppression class; if the pairing is a false positive, add an allowlist entry with rationale",
  },
  {
    name: "select-item-clip-title",
    appliesTo: notVendoredUi,
    scan: anyOf([
      perFile(SELECT_ITEM_CLIP_TITLE_RE),
      perFile(SELECT_ITEM_BLOCK_TRUNCATE_RE),
      perFile(SELECT_ITEM_FLEX_TRUNCATE_RE),
    ]),
    allowlist: [
      // SelectControl's rich rows trip two arms, both false positives: the
      // item-level first-child override lets the ItemText wrapper (a div under
      // Base UI 1.7.0) shrink, which is what keeps the label's truncate live,
      // and the clipTitle handler rides that same non-self-bounding label span —
      // pairings the patterns cannot see.
      "src/components/form/fields.tsx",
    ],
    message:
      "Select popup rows route their clip affordance through SelectClipText (src/components/select-clip-text.tsx) — an item-level clipTitle handler is dead once the row span self-bounds, and a bare `block truncate` or `min-w-0 flex-1 truncate` child never engages under the shrink-refusing ItemText; if the pairing is a false positive (a self-bounded clip span inside a rich row, or a row whose item overrides ItemText's shrink refusal), add an allowlist entry with rationale",
  },
  {
    name: "setQueryData-noop",
    // Not a UI idiom — it applies wherever the cache is written, vendored or not.
    appliesTo: () => true,
    scan: perFile(SET_QUERY_DATA_RE),
    allowlist: [],
    message:
      "setQueryData(key, undefined) is a silent no-op in TanStack v5 — snapshot and restore the previous value instead",
  },
  {
    name: "async-settings-rollback",
    // Not a UI idiom — it applies wherever the settings cache is patched.
    appliesTo: () => true,
    scan: onlyWhen(
      OPTIMISTIC_SETTINGS_PATCH_RE,
      perFile(SETTINGS_ROLLBACK_REFETCH_RE),
    ),
    allowlist: [],
    message:
      "an optimistically patched settings write rolls back SYNCHRONOUSLY — snapshot the previous value and setQueryData it back under a latest-write guard (useApplyTheme, src/lib/settings/queries.ts), never invalidateQueries: the refetch restores a commit or more later, so a collapse toggle's focus hand-off has nothing to ride and focus drops to <body>",
  },
  {
    name: "bare-mutate",
    // Repo-wide: react-query drops per-call callbacks whenever their observer
    // loses its listeners, and every surface here can lose them mid-flight — a
    // dialog close, a Settings rail switch or close, an <Activity> tab hide, a
    // keyed remount. A repo switch keeps RepositoryView mounted instead, so an
    // awaited continuation that closes, clears, or deselects re-checks the live
    // repo first. The vendored primitives are out (never edited, and none
    // mutates).
    appliesTo: notVendoredUi,
    scan: anyOf([perLine(MUTATE_CALL_RE), perFile(DESTRUCTURED_MUTATE_RE)]),
    // Floor near the real count (702): an appliesTo typo that left the scan
    // nearly inert would otherwise still print OK.
    expectScanned: {
      atLeast: 500,
      hint: "every .ts/.tsx under src/ outside the vendored ui/ primitives",
    },
    // Every entry is a call carrying NO per-call callbacks object, so there is
    // nothing an unmount can drop; the token match is the ratchet, and an
    // exemption is an entry here rather than a hole in the pattern.
    allowlist: [
      // The label edit, single-arg; its hook toasts failures itself.
      "src/features/conversations/LabelsPopover.tsx",
      // The project link edit, single-arg; its hook rolls back and toasts.
      "src/features/conversations/ProjectsPopover.tsx",
      // A section's collapsed state, single-arg: a cosmetic preference.
      "src/features/conversations/useCollapsedSections.ts",
      // The list-filter prefs write, single-arg; its hook patches the cache and
      // toasts failures itself.
      "src/features/conversations/useRemoteListFilter.ts",
      // Eight single-arg picker/field writes; their hooks report failures at the
      // mutation level.
      "src/features/issues/RemoteIssueViewParts.tsx",
      // A card move and a reorder, both single-arg; their hooks restore and
      // toast on failure.
      "src/features/projects/ProjectsBoardPanel.tsx",
      // GitLab time tracking's set-estimate and add-spent, both single-arg.
      "src/features/pulls/RemotePrViewParts.tsx",
      // Reconciles merged/deleted heads from an effect: the destructured
      // `mutate` is called single-arg on both arms.
      "src/features/pulls/useReconcileLocalPrs.ts",
      // Recording the last-seen version, single-arg: a failure only shows the
      // notes again next launch.
      "src/features/updates/WhatsNew.tsx",
      // Dismissing the guide nudge, single-arg: a cosmetic preference.
      "src/features/welcome/WelcomeScreen.tsx",
    ],
    message:
      "react-query gates per-call mutation callbacks on the observer still having listeners, so a dialog close, a Settings rail switch, an <Activity> tab hide, or a keyed pane remount mid-flight drops the toast, teardown, and navigation that lived in them — await mutateAsync and put the outcome in the continuation (re-checking the live repo before closing, clearing, or deselecting anything: RepositoryView survives a repo switch), so a bare .mutate( (or a `const { mutate }` destructure that reaches one) needs an allowlist entry with rationale",
  },
  {
    name: "context-menu-suppression",
    appliesTo: notVendoredUi,
    scan: perFile(CONTEXT_MENU_SUPPRESS_RE),
    allowlist: [],
    message:
      "a shared ContextMenu's non-target right-click path routes through suppressContextMenu (src/lib/context-menu.ts) — preventDefault alone leaves Base UI's trigger handler to open the menu as an empty, click-swallowing popup",
  },
  {
    name: "seed-effect-on-open",
    // The hook itself opens with the very guard it exists to replace.
    appliesTo: (file) => file !== "src/lib/use-seed-on-open.ts",
    scan: perFile(SEED_ON_OPEN_RE),
    // Three kinds of entry, none of them an open-transition reset:
    // DATA-ARRIVAL seeds (the trigger is the value landing, which the hook's
    // once-per-open latch would fire before), effects that already carry their
    // own ref latch keyed on something the hook doesn't know (a scope, a task
    // id, the previous `open`), and effects that merely tear down or register
    // on `open` and are idempotent by construction. Every one of them is safe
    // to repeat — the property the open-transition resets lack.
    allowlist: [
      // Seeds the category once the async list arrives; `if (!categoryId)`.
      "src/features/discussions/CreateDiscussionDialog.tsx",
      // Defaults the workflow once `dispatchable` arrives; the caller's
      // preselect rides a consume-once ref, the fallback keeps `!workflow`.
      "src/features/actions/RunWorkflowDialog.tsx",
      // Workspace seed is empty-field only; the owner seed also re-seeds when
      // the held owner is no longer in the fetched list (account switch), so
      // it never fights a pick that's still valid.
      "src/features/repository/PublishDialog.tsx",
      // Seeds the URL field once the current remote URL query resolves.
      "src/features/repository/RemoteUrlDialog.tsx",
      // Base reconciler: re-seeds only when the current base isn't a valid
      // option for the active target, so it never fights the user's edit.
      "src/features/pulls/CreatePrDialog.tsx",
      // Re-seeds when the caller re-requests a mode while already open (the
      // add action fired from the palette over an open list), and is a layout
      // effect so a reopen never paints one frame of the mode it closed on.
      "src/features/repository/SubmodulesDialog.tsx",
      // Seeds the draft once `automations.data` arrives, behind its own latch.
      "src/features/automations/RepoAutomationsDialog.tsx",
      // Same, latched per SCOPE — switching scope re-seeds deliberately.
      "src/features/branch-rules/BranchRulesDialog.tsx",
      // Seeds the applied set once memberships settle, behind `seededSettled`.
      "src/features/conversations/ProjectsPopover.tsx",
      // Latched per task id, and the close arm aborts in-flight AI streams
      // whose callbacks would otherwise resolve into the NEXT task opened.
      "src/features/scripts/TaskDialog.tsx",
      // Close-side only: clears the selection, a no-op while open.
      "src/features/history/FileHistoryDialog.tsx",
      // A scroll listener with a cleanup, plus a close-side key-set clear —
      // re-registering on a re-show is the correct behavior, not a reset.
      "src/components/mention-autocomplete.tsx",
      // Prefetch loop; `prefetchQuery` honors staleTime, so a repeat is free.
      "src/features/repository/BranchSwitcher.tsx",
      // Registers the open dialog with the native-menu gate; add/remove pair.
      "src/lib/hotkeys/modal-gate.ts",
      // Scroll/resize-close listeners for the open hovercard; add/remove pair,
      // and re-subscribing after an Activity re-show is the wanted behavior.
      "src/features/repository/insights/DependenciesCard.tsx",
      // Same class: the blame gutter's scroll-close listener for its open
      // hovercard — add/remove pair, idempotent to re-subscribe.
      "src/features/history/BlameDialog.tsx",
    ],
    message:
      "an open-transition reset must ride useSeedOnOpen (src/lib/use-seed-on-open.ts) — a hidden <Activity> tab re-mounts its effects on show, so a bare `useEffect(() => { if (open) seed(); }, [open])` re-fires and wipes the user's draft; a data-arrival or otherwise idempotent seed needs an allowlist entry with rationale",
  },
  {
    name: "generator-dialog-finish-and-surface",
    appliesTo: (file) => file.endsWith(".tsx") && notVendoredUi(file),
    scan: unlessAllPresent(
      [FINISH_AND_SURFACE_RE],
      onlyWhen(USE_SEED_ON_OPEN_CALL_RE, perLine(GENERATOR_HOOK_RE)),
    ),
    allowlist: [],
    message:
      "closing a dialog must never discard a paid AI generation — a mounted generator dialog rides useFinishAndSurface (src/features/conversations/useAiStream.ts): a run that settles while the dialog is closed latches skip-seed so the reopen shows the draft, and toasts it with a View reopen; a surface that genuinely aborts its run on close needs an allowlist entry with rationale",
  },
  {
    name: "generate-held-while-submitting",
    appliesTo: (file) => file.endsWith(".tsx") && notVendoredUi(file),
    scan: onlyWhen(FORM_HOST_RE, chordIgnoresSubmit),
    allowlist: [
      // The shared title+description EDIT dialog: an edit re-saves the same
      // entity rather than creating a second one, so by owner decision its
      // Generate (in each host's `bodyActions`, mirrored by the chord through
      // `generateDisabled`) stays live during the save.
      "src/features/conversations/EditTitleBodyDialog.tsx",
    ],
    message:
      "a dialog's generate chord holds while its own form submits — add `!isSubmitting` (read via `useSelector(form.store, (s) => s.isSubmitting)`) as an `&&` conjunct of the chord's `enabled` and hold the visible Generate with a reason (DisabledReasonButton): the draft has already been sent, and its settle closes the dialog holding it; a surface whose submit can't strand a revision needs an allowlist entry with rationale",
  },
  {
    name: "hand-rolled-diff-stat",
    // The component IS the idiom; everything else routes through it.
    appliesTo: (file) =>
      file !== "src/components/diff-stat.tsx" && notVendoredUi(file),
    scan: perFile(DIFF_STAT_PAIR_RE),
    allowlist: [],
    message:
      "`+added -deleted` counts render through DiffStat (src/components/diff-stat.tsx) — a hand-rolled pair drifts from the canonical spacing, minus glyph, and tabular digits one site at a time; a site the component genuinely can't express needs an allowlist entry with rationale",
  },
  {
    name: "list-row-diff-stat-slot",
    appliesTo: (file) =>
      file.startsWith("src/features/") && file.endsWith(".tsx"),
    scan: conditionalDiffStat,
    allowlist: [
      // The PR header's total +N −M, hidden on purpose while totals are unknown
      // (the Files notice explains the gap) — not a file-list row.
      "src/features/pulls/RemotePrView.tsx",
    ],
    message:
      "a conditionally rendered DiffStat in a JSX expression (`{x && <DiffStat …/>}`, `{x ? <DiffStat …/> : null}`, `||`/`??`, either ternary branch) — a file row whose counts can arrive after the row renders them through DiffStatSlot (src/components/diff-stat.tsx) on every row, so the cell keeps its width while counts load (and on rows that never get them) and a late stat doesn't reflow the file names; a row whose counts ship with the row itself renders DiffStat unconditionally, and a non-row total hidden on purpose needs an allowlist entry with rationale",
  },
  {
    name: "raw-copy-icon-button",
    // The component IS the idiom; everything else routes through it.
    appliesTo: (file) =>
      file !== "src/components/CopyIconButton.tsx" && notVendoredUi(file),
    scan: perFile(RAW_COPY_ICON_BUTTON_RE),
    allowlist: [],
    message:
      "icon-only copy buttons use CopyIconButton (src/components/CopyIconButton.tsx) — it carries the vendored focus ring, sets aria-label and title to the same string, and stops click propagation so a copy never also activates its row; a hand-rolled button drifts on all three one site at a time (a copy control with visible text is not this idiom), and a site the component genuinely can't express needs an allowlist entry with rationale",
  },
  {
    name: "kind-badge-single-source",
    // The shared module IS the table; everything else imports it.
    appliesTo: (file) => file !== "src/lib/git/change-kind-badge.ts",
    scan: perLine(KIND_BADGE_DEF_RE),
    allowlist: [],
    message:
      "the change-kind letter, screen-reader label, and colour token come from KIND_BADGE in src/lib/git/change-kind-badge.ts — a second definition drifts one surface at a time, so the Changes list and the commit dialog's staged summary stop agreeing on the same file; import it rather than re-spelling the table",
  },
  {
    name: "binary-marker-single-source",
    // The helper module IS the idiom; everything else imports sectionIsBinary.
    appliesTo: (file) => file !== "src/lib/git/diff-split.ts",
    scan: perLine(BINARY_MARKER_RE),
    allowlist: [
      // stripBinarySections already matches the line-anchored
      // "\nBinary files " literal.
      "src/lib/ai/prompt.ts",
    ],
    message:
      'the git binary-marker check lives in sectionIsBinary (src/lib/git/diff-split.ts) — a re-spelled "Binary files" literal or regex re-mints the loose-match class (a text diff whose CONTENT mentions binary files read as binary) or drifts from the line-anchored form one site at a time; import the helper',
  },
  {
    name: "lone-activity-boundary",
    // Both directions ride the allowlist: a hit anywhere else is a violation,
    // and TabPanel losing its own `<Activity>` reads as a stale entry. Residual:
    // a SECOND `<Activity` added inside RepositoryView.tsx is not caught, since
    // the allowlist works per file rather than per occurrence.
    appliesTo: () => true,
    scan: perLine(ACTIVITY_JSX_RE),
    allowlist: ["src/features/repository/RepositoryView.tsx"],
    message:
      "a tab panel's <Activity> must be paired with PanelPortalBoundary and PanelActivityBoundary, or its dialogs and popups strand over the wrong tab — render TabPanel (RepositoryView.tsx) rather than a second <Activity>, or extend the allowlist deliberately for a non-tab Activity",
  },
  {
    name: "null-suspense-fallback",
    appliesTo: notVendoredUi,
    scan: perFile(NULL_FALLBACK_RE),
    allowlist: [],
    message:
      "`fallback={null}` blanks the region while the boundary is active, with no aria-busy and nothing announced to assistive tech — lazy panels use LazyPanelFallback (src/components/lazy-panel-fallback.tsx), or, at a boot-path boundary over a panel with a settled resting state, that state itself (DiffRestingFallback, src/features/diff/DiffRestingFallback.tsx); any other fallback-taking host, or a boundary whose absence is genuinely invisible, needs an allowlist entry with rationale",
  },
  {
    name: "preparing-slot-hide",
    // Every non-vendored source file: any host can adopt the two-slot pattern.
    appliesTo: notVendoredUi,
    scan: preparingSlotHide,
    allowlist: [],
    expectScanned: { atLeast: 500, hint: "every .ts/.tsx under src/" },
    message:
      "a two-slot host's preparing slot hides only by a full clip (`[clip-path:inset(50%)]`) plus `inert`, set as the `preparing` entry of the host's role-keyed class map (gd-conventions, 'The preparing-slot rule'). A visibility hide (`invisible`, `collapse`, `[visibility:hidden]`, `[visibility:collapse]`) makes every vendored Button inside paint a frame late when the slot shows, since its `transition-all` transitions the inherited visibility; an opacity below full (`opacity-<n>` under 100, `opacity-[v]` or `[opacity:v]` under 1 or 100%, and any opacity the scan cannot read, such as `opacity-[var(…)]` or Tailwind v4's `opacity-(--x)`) fades the slot in instead of showing it at once; and `hidden`, `[display:none]`, `[content-visibility:hidden]` or `sr-only` (a 1px box) skips the full-size layout the slot prepares. A `[visibility:…]` or `[display:…]` value that is not a plain keyword (`var(…)`, `calc(…)`) is unreadable and counts as a hide. Each counts after its variant prefixes, its `!` marker and an arbitrary value's `!important`, descendant variants included (`[&_svg]:invisible`, `*:hidden`): they hide the slot's content the same way. Scope: only slot context is analysed, meaning a slot-host file (its code names `EntitySlotRole`, `EntityHoldSlot`, `SlotPhase` or `entityHoldSlots`) or, anywhere, a slot-shaped object literal or class body (a `preparing` key beside a `held` or `shown` member whose value is a class value: a string or template, a combiner call, or a conditional or array of those) with everything nested in it; outside it nothing is reported, since \"preparing\" is also a merge status and `isPreparing` a common loading flag. Sites: (S1) an object or class entry keyed by the preparing role (bare, quoted, computed or `as const` keys, methods and getters; interface, type-alias and annotation literals are types and are skipped); (S2) a class arm of `&&`, `||` or `?:`, or a clsx-object key in a cn/clsx/cx/classNames/twMerge call, whose condition reads a role atom (a `==`/`===`/`!=`/`!==` comparison with a role literal, read cooked, on either side, a `preparing`/`isPreparing` flag read through a name, member or literal element access, or a const holding such a condition) and can apply to the preparing slot, worked out over the held, preparing and shown roles through `!`, `&&`, `||` and every enclosing role guard, entry or branch (an arm is class code in a className or combiner argument, or when it holds a literal, JSX, an array or a combiner call); a guard naming a role-condition const the scan cannot resolve, because another binding shares its name, fails closed; (S3) a `switch` clause labelled `\"preparing\"` (`default` when no clause names it), a `switch (true)` clause whose condition can be true for the slot (`default` when every case condition can be false for it, wherever `default` sits), or an `if`/`else` arm that applies to the slot, where every literal counts; a clause's roles carry into the next clause unless its last statement ends it (`return`, `throw`, a `break` or `continue` that is unlabelled or names a label outside the clause, a block whose last statement ends it, or an `if`/`else` whose two arms both do; a `try` never ends a clause); (S4) inside slot context, any class token whose variant names the role, in any letter case (`data-[role=preparing]:invisible`); and (S5) a host shape rule: in a slot-host file a slot map is any object literal or class body with a `preparing`-role key (a spread of a same-file const object counts as its keys) beside a `held` or `shown` key (whatever its value), any spread, or a computed key the scan cannot read whose value is a class string; or, without one, two computed keys the scan cannot read whose values are class strings, or one beside a role key. Its keys read cooked, and a same-file const key resolves. A spread of a same-file const object holding a `preparing` key is held to the entry rule below. Every slot map's `preparing` entry must be a plain class string (a string literal, a template literal with no interpolation, a `+` chain of those, or a same-file const of one) with no spread after the key; its text, cooked as JS reads it (escapes decoded, line continuations dropped) and split on ASCII whitespace, must hold exactly one clip-path token (an arbitrary `[clip-path:…]` or `[-webkit-clip-path:…]` property, `sr-only`, `not-sr-only`, or an `[all:…]` reset, with the property name read case-insensitively since Tailwind emits `[cLIP-PATH:none]`), and that token must be the bare `[clip-path:inset(50%)]` (no variant of any kind, descendant variants included; the `!` marker at one end at most, an arbitrary value's `!important` stripped); a computed key in a slot map that does not resolve to a literal fails as a key the scan cannot read; the remedy is to write the preparing entry as a plain class string. Beyond the maps, in a slot-host file: no arbitrary clip-path or `[all:…]` token may sit anywhere but a slot map's `preparing` entry or the const it resolves to (`sr-only` and `not-sr-only` excluded); and no write may set a member that may be the preparing entry: an assignment or update (`++`, `--`, compound forms) of `X.preparing` or `X[P]` (with `P` a same-file const), a destructuring assignment target, `Object.assign` with a source carrying a `preparing` key (directly, through a same-file const, or through a spread in it), `Object.defineProperties` with such a descriptors argument, `Object.defineProperty`, `Reflect.set` or `Reflect.defineProperty` naming it; a key or source the scan cannot read fails when the target is a slot map. A JSX attribute string takes no backslash escapes but decodes numeric and the five XML character references before it is read; in a `className` or `class` attribute in slot context any other named reference (`&nbsp;`) fails (\"write the class without character references\"). A map that is not a slot map is exempt, and a slot-host file that renders classes (`className`, `cn(`, `clsx(`) with no slot map fails on its first vocabulary line. Hides are read from every literal's cooked text. Inside an S1 or S2 class expression, class code the scan cannot read fails: only literals, `undefined`/`null`/booleans, conditionals, arrays, concatenation, `||` and `??`, combiner calls and identifiers naming a readable same-file `const` are read, so an import, a `let`, a parameter, a member read, a spread of any of those, or any other call fails; in a slot-host file, a read of a slot map's entry is readable when keyed by the preparing role (`D.preparing`, `D[\"preparing\"]`, or a same-file const of it) or by the role variable (an identifier the scan cannot resolve, `D[r]`; a member chain of `.name` reads, `D[slot.role]`; or a same-file const of either), and not when keyed by another role (`D.held`) or any other expression (`D[flag ? \"held\" : \"shown\"]`, `D[pick(role)]`, `D[roles[i]]`, or a const of one). The left operand of `||` and `??` is a class value too, unless it is boolean by syntax (a comparison, a `!`, a boolean literal, `&&`/`||` of those, or a const holding one); a flag-named read there is a value like any other. A const is readable only when nothing else in the file binds its name (an import, a destructured or catch binding, a function or class name, a parameter, a `let`/`var` or a second const). A role condition anywhere in the arguments of a helper call in class code (`className={slotClass({ hide: role === \"preparing\" })}`) fails: the scan cannot read the helper. Any other `\"preparing\"` literal, or a flag read inside a condition the guard grammar did not read (`Boolean(isPreparing)`, `isPreparing(slot)`), fails when a hide sits in a literal of the expression it climbs to, stopping at an entry value, a JSX attribute, a statement or a combiner argument. A file ts-mask cannot lex fails with \"cannot lex\", and one the reader cannot read (a nesting deep enough to exhaust the stack) with \"cannot read\"; an allowlist entry does not rescue either, since the scan runs before the allowlist is consulted, so rewrite the shape ts-mask refuses (its documented ambiguities: a postfix `x++ / y`, a `<const T,>` arrow, a generic function type in .tsx) or extend ts-mask. Not handled (ordinary code the scan does not read yet): a preparing entry outside a slot-host file that is not in a role-keyed map; slot code outside a slot-host file that is not a role-keyed map (for example a frame component branching on a `preparing` prop); outside a slot-host file, a slot map whose sibling values are not class literals (`{ shown: SHOWN_CLS, preparing: HIDE }`); a class variant naming the role, outside slot context; a helper's result hoisted out of the class position (`const cls = slotClass(role === \"preparing\")`, then `className={cls}`); cva `compoundVariants` keyed `role: \"preparing\"`; JSX props named for the role (`role=\"preparing\"`, `preparing=…`, `preparingClassName=…`); enum or member roles in a comparison (`SlotRole.Preparing`; a same-file const key does resolve); a render-site arm that replaces the map entry for the preparing slot without a hide (`r === \"preparing\" ? \"absolute inset-0\" : D[r]`), a statement-level branch that renders the slot without a className, and an inline `style={{ clipPath: \"none\" }}`; `sr-only` set on the preparing slot from a statement-level branch or an element an arm renders, where it reads as screen-reader text; control-flow narrowing (an early `return` under `role !== \"preparing\"`); an `inert:` variant; style objects (`style={{ visibility: \"hidden\" }}`); collapsed-size hides (`size-0`, `h-0`/`w-0` with an overflow clip, `scale-0`, `max-h-0`), left out because they are common layout idioms; a flag tested only in a loop condition; a `delete` of a preparing member; a map-entry key the scan cannot pin to one value, which is taken as the role in force (a parameter, including one with a default or one the guard does not test, as in `role === \"preparing\" && D[prev]`; a destructured binding; a `let`; an import; a name bound more than once; a member chain of `.name` reads, whose root is never resolved, as in `const x = { role: \"held\" }; D[x.role]`); a key spelled with an identifier escape (a bare `\\u0070reparing` key, where the identifier lexer stops at the backslash); outside a slot-host file, a file whose only `preparing` spelling is escaped (the parse prefilter reads raw source); a spread the scan cannot read after a spread of a slot map (`{ ...D, ...makeOverride() }`); and stylesheets (selectors and `@apply`, which the guard never reads). Fails closed (false positives): a label or prose string reading a hide utility inside a site; a map that is not a slot but keys `preparing` beside a class-valued `held` or `shown`; a role-literal comparison on a value that is not a slot role in a slot-host file (`plan.kind === \"held\"`); an unrelated hide in the extent a role mention climbs to (`isRole(r, \"preparing\")` beside `\"hidden\"` in one statement); a JSX spread in a preparing class arm; a map-entry read in a preparing class arm or entry keyed by a const of a call (`const role = useRole();` with `role === \"preparing\" && D[role]`), which the scan cannot read (read the role from a prop or a destructured binding instead); `Object.assign` copying a slot map into another object (`Object.assign({}, D)`); a const whose name is bound anywhere else in the file; in a slot-host file, any role-keyed map or state object (text, counts, icons, reducer state, such as `{ held: \"Previous file\", shown: \"Current file\", preparing: \"Loading\" }`), which is a slot map there (use keys other than the slot roles, or keep it outside the host file); in a slot-host file, a clip-path animation on an element that is not the slot, and a clipped render-site arm (move the element out of the host file, or put the clip in the map entry); and a slot-host file's merge-status class map keyed `preparing` (`{ preparing: \"opacity-60 animate-pulse\", clean: \"…\" }`), read as a preparing entry. Remedy: a non-host file may take an allowlist entry with rationale; a host writes the slot's classes as the plain clipped `preparing` entry of a slot map and reads that entry wherever it renders the slot",
  },
  {
    name: "bare-group-label",
    appliesTo: notVendoredUi,
    scan: perFile(UNASSOCIATED_LABEL_RE),
    // Keyed per FILE, not per site: a coarser key means an unrelated edit to one
    // of these files can't turn the entry stale mid-flight.
    allowlist: [
      // WRAPPING labels around a `<Checkbox>`, associated at RUNTIME: Base UI's
      // Root renders a `<span role="checkbox">` and routes a caller `id` to its
      // aria-hidden proxy input, so an `htmlFor` could not reach the interactive
      // element — instead `useAriaLabelledBy` walks from that input to the
      // wrapping `<label>` and points the span's `aria-labelledby` at it. Correct
      // as written; a static pattern simply cannot see it.
      // "Protected" / "Masked in job logs" on the variable form.
      "src/features/repo-settings/GitLabVariablesSection.tsx",
      // "Secured" on the variable form and its repository-variable twin.
      "src/features/repo-settings/BitbucketVariablesSection.tsx",
      // One wrapping label per trigger-event checkbox, mapped over the event
      // list — the same shape, split across lines by the formatter.
      "src/features/repo-settings/BitbucketWebhooksSection.tsx",
      "src/features/repo-settings/GitLabWebhooksSection.tsx",
    ],
    message:
      'a `<Label>` with no htmlFor and no id names nothing for assistive tech, however it is styled — whatever sits under it reads as anonymous; caption a GROUP with LabeledGroup (src/components/form/labeled-group.tsx), which pairs the label\'s id with role="group" + aria-labelledby, or point a single-control label at its control with htmlFor; a label that WRAPS its control is associated at runtime and a genuinely decorative one names nothing on purpose — either needs an allowlist entry with rationale',
  },
  {
    name: "unguarded-binding-dispatcher",
    appliesTo: notVendoredUi,
    scan: unlessAllPresent(
      [EDITABLE_GUARD_RE, TYPEAHEAD_GUARD_RE, TYPEAHEAD_KEY_RE],
      onlyWhen(PREVENT_DEFAULT_RE, perLine(EVENT_TO_BINDING_RE)),
    ),
    // No entry here dispatches a REBINDABLE binding, which is what the guards
    // protect; each is keyed per file, like every other entry here.
    allowlist: [
      // The shortcut RECORDER: capturing and swallowing every key, guards
      // included, is precisely its contract — a guard would make keys
      // unbindable.
      "src/features/settings/KeyboardSection.tsx",
      // Its `eventToBinding` call tests a HARDCODED mod+enter submit chord, not
      // a user binding, so there is no rebindable dispatch to guard.
      "src/components/mention-autocomplete.tsx",
      // Same shape: a HARDCODED mod+enter submit chord on the status-update
      // dialog, not a user binding.
      "src/features/projects/ProjectStatusStrip.tsx",
      // Same shape again: the project and view dialogs' mod+enter submit chord.
      "src/features/projects/ProjectLifecycleDialogs.tsx",
      // Its two `eventToBinding` calls (the board's handler and the
      // table/roadmap grid's) test fixed tables, never a user binding: the
      // hardcoded Alt chords (four reorder, four date-shift) and the grid's own
      // cursor and Enter/Space keys. Each handler's DOM containment check
      // already pins focus to a board card or a grid cell — none of which hold
      // editable or typeahead targets for the guards to protect.
      "src/features/projects/ProjectsBoardPanel.tsx",
      // Same shape as the board entry above: its `eventToBinding` call
      // tests a hardcoded set (the four Alt move chords plus unmodified
      // Enter/Space and Home/End), never a user binding, and acts only when
      // the event target is a [data-row] commit row, never an editable or
      // typeahead surface. A rebindable binding dispatched here would need
      // the three predicates, or this entry must go.
      "src/features/history/EditHistoryDialog.tsx",
    ],
    message:
      "a path that matches eventToBinding(e) against a user binding and preventDefaults it must apply the same clause the global listener does — isEditableTarget, isTypeaheadTarget, and isTypeaheadKey (src/lib/hotkeys/binding.ts) — or a single-key binding steals keystrokes from text fields or typeahead lists, and named keys stop reaching the surfaces that should still get them; any subset leaves the case the missing predicate covers, and a file that dispatches no rebindable binding needs an allowlist entry with rationale",
  },
  {
    name: "titled-disabled-trigger",
    appliesTo: notVendoredUi,
    scan: perFile(TITLED_TRIGGER_DISABLED_RE),
    // Every residual site of the class the pickers were converted out of has
    // now converted too — the allowlist is empty on purpose, not pruned away:
    // a fresh violation here is a NEW instance of the class, not a returning
    // one. The regex's own blind spot still stands, though: a disabled branch
    // that swaps out the whole trigger for a plain non-`*Trigger` element (the
    // shape `PrMergeabilityBanner`'s update-branch caret used to take) carries
    // no `*Trigger` tag for the pattern to anchor on.
    allowlist: [],
    message:
      "a menu/popover trigger that carries its disabled reason on a titled wrapper is hover-only — a natively disabled trigger leaves the tab order, so keyboard and screen-reader users reach neither the control nor the reason; compose `<Trigger render={<DisabledReasonButton disabled reason/>}>` instead (src/components/disabled-reason-button.tsx), which holds the reason on a focusable aria-disabled button whose own useButton swallows activation; a site that genuinely cannot take the primitive needs an allowlist entry with rationale",
  },
  {
    name: "titled-badge",
    appliesTo: notVendoredUi,
    scan: perFile(TITLED_BADGE_RE),
    // Empty on purpose: every titled badge converted to StatusDetailChip, so a
    // hit is a new instance of the class.
    allowlist: [],
    message:
      "a Badge that explains itself through `title` is mouse-only — keyboard, touch, and screen-reader users never reach the detail; render StatusDetailChip (src/components/status-detail-chip.tsx) with the text as `detail`, which opens it in a click popover and falls back to the plain Badge when there is none; a title that only repeats the badge's visible text carries nothing, so drop it; a site that genuinely cannot take the chip needs an allowlist entry with rationale",
  },
  {
    name: "ungated-notification-producer",
    // emit.ts IS the gate, so it holds both imports by definition.
    appliesTo: (file) => file !== "src/lib/notifications/emit.ts",
    scan: anyOf([
      perFile(PUSH_NOTIFICATION_IMPORT_RE),
      perFile(NOTIFICATIONS_NAMESPACE_IMPORT_RE),
      perFile(NOTIFY_MODULE_IMPORT_RE),
    ]),
    // Empty by construction: every producer routes through emit, and the one
    // exception is excluded by appliesTo rather than listed here. The inbox
    // module itself needs no entry either — it cannot import itself, so an
    // entry naming it would read stale on the first run.
    allowlist: [],
    message:
      "notifications are delivered by emitNotification (src/lib/notifications/emit.ts) alone — it resolves each source's channels against the global prefs AND the repo's override, mutes the OS ping for AI kinds while AI is hidden, and dedupes both channels together; a producer reaching pushNotification or @/lib/notify directly ships a surface the user cannot turn off (the sessions, plan, and research producers were ungated exactly that way), so route it through emit or add an allowlist entry with rationale",
  },
  {
    name: "hand-rolled-store-open",
    // The helper IS the opener, so it holds the import and the call by definition.
    appliesTo: (file) => file !== "src/lib/plugin-store.ts",
    scan: anyOf([
      perFile(PLUGIN_STORE_LOAD_IMPORT_RE),
      perFile(LOAD_STORE_NAME_CALL_RE),
    ]),
    allowlist: [
      // The relocate migration deliberately re-opens every per-repo store BY NAME
      // from a table, with the same options, to mutate the instances the feature
      // modules cached — a memoized per-file opener is the wrong shape for it, and
      // it holds no long-lived memo to poison.
      "src/lib/repo-data-migration.ts",
      // Opens `analytics.json` per call rather than memoizing, so it has no
      // rejected-memo to pin; converting it is a follow-up, not an exception to
      // the rule.
      "src/lib/analytics/posthog.ts",
    ],
    message:
      "app-data stores open through memoizedStoreLoader (src/lib/plugin-store.ts) — a hand-rolled `storePromise ??= load(...)` memoizes a REJECTED load just as readily as a resolved one, so a single unreadable file leaves that store dead until the app restarts; route it through the helper or add an allowlist entry with rationale",
  },
  {
    name: "raw-store-reload",
    // The helper IS the reload, so it holds the only raw call.
    appliesTo: (file) => file !== "src/lib/plugin-store.ts",
    scan: perFile(RAW_STORE_RELOAD_RE),
    allowlist: [
      // Re-homing runs outside the feature modules' write queues and writes back
      // unconditionally, so a tolerate-vs-rethrow decision it does not make is not
      // the guard it needs (its own comment records the orphan-on-throw residual).
      "src/lib/repo-data-migration.ts",
    ],
    message:
      "re-read a store through reloadToleratingEmptyStore (src/lib/plugin-store.ts) — a bare `store.reload()` wrapped in a catch-everything treats an unreadable file exactly like an absent one, so the read-modify-write proceeds and saves this process's cache over whatever was on disk; a caller that genuinely must swallow every failure (a POST-write cache refresh, which has no pending write to protect — see review-notes' writeBranch) wraps the helper in its own try/catch rather than calling reload directly, and a non-store `.reload()` this pattern cannot tell apart takes an allowlist entry with rationale",
  },
  {
    name: "inline-repo-identity-query",
    // The factory IS the key, so it holds the only literal by definition.
    appliesTo: (file) => file !== "src/lib/git/repo-identity-query.ts",
    scan: perFile(INLINE_REPO_IDENTITY_KEY_RE),
    allowlist: [],
    message:
      "every observer of the repo-identity query spreads repoIdentityQueryOptions (src/lib/git/repo-identity-query.ts) — the shared fetch takes its options from whichever observer starts it, so an inline copy splits networkMode and the retry ladder across observers of one key, and a queryFn that swallows the IPC failure caches the raw-path fallback under an infinite staleTime, mis-scoping repo-scoped servers and per-repo app-data for the whole session; import the factory, or add an allowlist entry with rationale",
  },
  {
    name: "queries-internal-import",
    // The package's own modules ARE the sanctioned consumers of its internals.
    appliesTo: (file) => !file.startsWith(QUERIES_DIR),
    scan: queriesInternalSpecifiers,
    allowlist: [],
    message:
      "src/lib/git/queries/internal.ts is private to the queries package — it is deliberately the one module the barrel does not re-export, so importing it from outside widens the public @/lib/git/queries surface by a back door and pins callers to helpers whose signatures the package expects to change freely; import the public symbol from @/lib/git/queries instead, or promote the helper into a barrel-re-exported module (which makes the widening a reviewable decision rather than an import-path accident)",
  },
  {
    name: "queries-internal-present",
    // Pure existence pin, no pattern of its own. Every other rule in this family is
    // written around internal.ts BY NAME, so renaming the file makes all of them
    // vacuously pass — queries-internal-reexport would simply start scanning the
    // renamed module as an ordinary one, and its floor would still be met.
    appliesTo: (file) => file === QUERIES_INTERNAL,
    scan: () => [],
    allowlist: [],
    expectScanned: { exactly: 1, hint: QUERIES_INTERNAL },
    message:
      "src/lib/git/queries/internal.ts is the module the queries boundary is defined around — if it moved or was renamed, re-point QUERIES_INTERNAL and the reaches-internal predicate together, because the other checks in this family go vacuously green without it",
  },
  {
    name: "queries-internal-reexport",
    // Package-wide, because `export *` chains republish: an `export * from
    // "./internal"` in ANY module rides the barrel's `export * from "./<module>"`
    // and lands every internal helper on the public surface. internal.ts is exempt
    // — it IS the module. A plain `import` stays legal everywhere in the package.
    appliesTo: (file) =>
      file.startsWith(QUERIES_DIR) && file !== QUERIES_INTERNAL,
    scan: reexportsInternalSpecifiers,
    allowlist: [],
    // Floor set near the real module count (29): a low floor would let a typo in
    // QUERIES_DIR leave the scan almost entirely inert and still pass.
    expectScanned: {
      atLeast: 20,
      hint: `${QUERIES_DIR}*.ts (minus internal.ts)`,
    },
    message:
      'no module in the queries package may RE-EXPORT ./internal — `export *` chains republish, so `export * from "./internal";` in any domain module reaches the barrel through its own `export * from "./<module>";` and publishes every shared helper as part of @/lib/git/queries, with nothing else failing (tsc and biome both accept it); importing internal helpers is still fine — it is re-exporting them that widens the surface, so promote a helper into a domain module if it should be public, which makes the widening reviewable',
  },
  {
    name: "queries-barrel-internal-reference",
    // The barrel is stricter than the rest of the package: it is a pure export
    // list, so ANY mention of internal there — import or re-export — is a
    // re-export or one edit away from becoming one.
    appliesTo: (file) => file === QUERIES_BARREL,
    scan: barrelInternalSpecifiers,
    allowlist: [],
    expectScanned: { exactly: 1, hint: QUERIES_BARREL },
    message:
      "the queries barrel must never name ./internal at all — internal.ts is the one module deliberately left out of index.ts, and index.ts holds nothing but re-exports, so even an import of it there is a re-export waiting to happen; promote a helper into a domain module if it should be public",
  },
  {
    name: "mutation-identity-pinning",
    // Deliberately narrower than its convention. Every mutation already runs the
    // mutationFn and callbacks in effect when it started (raw-react-query-mutation
    // below), so a pin's remaining job is hold scoping: a pinned mutation
    // detaches at a switch, so the new repo's controls don't read the old repo's
    // pending write as busy. This ratchets the creates and cache seeds; the rest
    // stay a review concern. The unpinned `Add…`/`Fork…` creates
    // (useAddRemote, useForkRepo and their siblings) stay
    // outside BY DECISION: a pin idles the `isPending` their callers read as a
    // re-entry guard, so the cache-reader migration comes first.
    appliesTo: (file) => isMutationModule(file),
    scan: unpinnedMutationIdentity,
    allowlist: [],
    expectScanned: MUTATION_MODULES_SCANNED,
    message:
      "a repo-scoped create or cache-seeding mutation must pin its identity (gd-conventions, 'Mutation identity pinning') — every mutation already runs the mutationFn and callbacks in effect when it started (@/lib/started-mutation), so the pin's job is hold scoping: a changed mutation key detaches the pending write at a repo switch, so the newly-live repo's controls don't read the old repo's write as busy; pass `identity: [\"<op>\", repo, …]` on useRepoMutation or `mutationKey: [\"<op>\", repo, …]` on a plain useMutation, naming exactly the hook-scope values the call closes over, and make sure every caller takes its continuation from `await mutateAsync` (a detached mutation's observer goes idle, so `isPending`/`data`/`error` reads stop tracking it) — or add an allowlist entry with rationale. This scan does NOT see seven shapes inside its own boundary, so review them by hand: a create whose NAME lacks 'Create' (the `Add…`/`Submit…`/`Fork…` spellings — useAddRemote, useForkRepo and their unpinned siblings are live by decision while their callers guard re-entry on `isPending`; useSubmitReview, useAddIssueSpentTime and useForkRepoByName are pinned), a mutation built through a wrapper in another MODULE, one built through a helper not named `use…`, a cache-seeding wrapper reached only from non-create hooks, a conditionally-keyed wrapper whose delegating call DOES pass the identity argument but passes something undefined or keyless in it (the call-site check counts arguments, it cannot evaluate them), a hook declared as `export const useX = (repo) => …` (the declaration anchor requires the `function` keyword), and one whose return type is an inline object literal (`): { … } {` — the body scan would take the return type as the body). The last three are zero-instance in the scanned modules today (both local-entity wrappers key unconditionally), so adding any of them means teaching this scanner first",
  },
  {
    name: "settle-cache-write-identity",
    // Same modules as mutation-identity-pinning, every hook regardless of name: a
    // settle callback's cache WRITE keyed from the onMutate context rides the
    // mutation's own state, so it names the entity the write fired under even for
    // a mutation resumed without its execution context (defense in depth: nothing
    // resumes one today). A stale seed is stamped fresh and nothing refetches it
    // away; settle-time invalidations refetch their way back, so they stay out of
    // scope.
    // This rule is separate from the pin rule: an EXPORTED repo-scoped hook whose
    // onSuccess seeds the cache still needs its mutation key there, however its
    // seed is keyed.
    appliesTo: (file) => isMutationModule(file),
    scan: settleCacheWriteFromHookScope,
    allowlist: [],
    expectScanned: MUTATION_MODULES_SCANNED,
    message:
      "a setQueryData/setQueriesData inside an onSuccess/onError/onSettled callback (property or method) must take its KEY from the callback's own parameters (`ctx.key`, `context.repo`, `args.number`), never from hook scope (a bare `repo`/`lens`/`link`, a value parameter of any enclosing function, a name declared in its body, or a callback local that was ever declared, assigned or looped from those) — @/lib/started-mutation already runs the settle callbacks in effect when the write started, so this is defense in depth: a key returned from `onMutate` rides the mutation's own state, which would still name the right entity if a settle ever ran through other callbacks than the ones `onMutate` ran with (no path does: react-query re-executes a mutation outside its original execution only after hydration, building it from mutation defaults rather than a render's options, and nothing here hydrates); build the key there, return it in the context, and read it back in the settle callback (useSetRepoStar is the reference). Context-keying is what THIS check asks for; it does not replace mutation-identity-pinning, which still requires a mutation key on an exported repo-scoped hook whose onSuccess seeds the cache. This scan does NOT see six shapes, so review them by hand: a cache write through a helper the callback calls (the Jira `landRealStatus` shape — pass it context values, not hook scope; `useCreateIssue`'s `insertCreatedIssue` is the exception, a pinned `useRepoMutation` seed with no `onMutate` to key from), a callback defined outside the options object and passed by name (`onSuccess,`) or spread in, `useOptimisticCacheMutation`'s `reconcile` argument (it runs from internal.ts's onSettled, another module), a key reaching the write through a compound assignment or a mutation of a local (`key.push(repo)`, `key += …`), a hook declared neither as `function use…` nor as `const use… =` (only the bare `repo`/`lens`/`link` names are seen there), and a parameter whose own annotation is a function type (skipped as a key BUILDER, so a function-typed value used as a key reads clean). It also over-reads one shape: per-call `.mutate(v, { onSuccess })` and `.mutateAsync(v, { onSuccess })` callbacks are fixed at mutate time and would flag although correct — moot here, since no scanned mutation module calls either",
  },
  {
    name: "raw-react-query-mutation",
    // Repo-wide but for the helper, which IS the one construction: RepositoryView
    // is one instance across repo switches, so any mutation host can outlive the
    // repo, PR, lens or link its write started on.
    appliesTo: (file) => file !== STARTED_MUTATION,
    scan: rawReactQueryMutation,
    allowlist: [],
    // Floor near the real count (753): an appliesTo typo that left the scan
    // nearly inert would otherwise still print OK.
    expectScanned: {
      atLeast: 500,
      hint: `every .ts/.tsx under src/ except ${STARTED_MUTATION}`,
    },
    message:
      "construct every mutation with `useMutation` from @/lib/started-mutation (gd-conventions, 'Mutation identity pinning') — react-query's own constructor lets a mounted observer re-rendered with new options replace its PENDING mutation's options, so after a repo, PR, lens or link switch the write runs the new render's mutationFn and callbacks: a write parked offline lands on whichever repo is open at reconnect, and its refresh and cache patches follow it; the helper runs each mutation's mutationFn and callbacks from the options in effect when it started (the observer's at the `mutate` call). This flags, outside the helper: react-query's `useMutation`, `MutationObserver`, `MutationCache`, `Mutation`, `hydrate` or `HydrationBoundary` (from @tanstack/react-query or @tanstack/query-core, through any path or subpath; specifiers are cooked as JS strings, case-folded and read with `\\` as `/`) bound as a value, whether imported named or aliased (escaped names decoded first), re-exported (`export *` included), or reached through `import()`, `require()` (TS `import x = require()` too) or `import.meta.glob()` (written with no space before the paren, as the formatter writes a call; a method named `import` or `require` is not one); ANY namespace or default import of either package, a `{ default }` entry included, since a namespace can be spread, destructured or passed on with no member name to see; a plain string literal module argument naming either package exactly (another TanStack package passes); any other module argument that mentions `tanstack`, or, unless it is a template with a local `./` or `@/` head, whose file holds a react-query string outside its import and export specifiers; and a glob pattern that mentions `node_modules` or `tanstack`. The client's mutation cache is mutation-cache-access's. Type-only imports, `useMutationState`, `useIsMutating` and the DOM's `MutationObserver` stay legal. Threat model: these scans target accidental use, not deliberate evasion, so spellings only an evader would write are named under Not seen rather than chased. Not seen: an import or re-export alias spelled as a reserved word or a string holding `;`, `,` or `}` (`export { useMutation as import }`); a semicolon-less import chain (the formatter adds the semicolons CI checks); `setOptions` on a mutation reached from the cache or `useMutationState`, which replaces rather than constructs; a construction inside another package; a package name split mid-word (`\"@tan\" + \"stack/…\"`, `.join(\"/\")`) in a file holding no other react-query string; indirect require (`createRequire(import.meta.url)`, `module.require`, `globalThis.require`, `require?.(…)`), which the Tauri webview doesn't provide anyway; a `./` template head that climbs out through its substitution; and the shared comment stripper's lexing gaps (a `/*` inside a multi-line template literal, a regex literal, a backslash-continued string or JSX text blanks the scan up to the next `*/`, and a `//` in JSX text, a regex or a template tail blanks the rest of its line). Fails closed (false positives): `typeof import(\"@tanstack/react-query\")` and an inline `import(\"@tanstack/react-query\").Type` in a type position, a type-only `import type rq = require(…)`, and a non-literal module call in a file that also holds a react-query string outside its specifiers",
  },
  {
    name: "started-mutation-present",
    // Pure existence pin, no pattern of its own: raw-react-query-mutation exempts
    // the helper BY PATH, so a rename must re-point STARTED_MUTATION in the same
    // change rather than leave the exemption naming a file that isn't there.
    appliesTo: (file) => file === STARTED_MUTATION,
    scan: () => [],
    allowlist: [],
    expectScanned: { exactly: 1, hint: STARTED_MUTATION },
    message:
      "src/lib/started-mutation.ts is the one module allowed to construct a mutation from react-query directly — if it moved or was renamed, re-point STARTED_MUTATION (and the networkmode guard's EXEMPT row) together, because raw-react-query-mutation exempts it by path",
  },
  {
    name: "mutation-cache-access",
    // Repo-wide: any module can reach the client's cache. The one held
    // reference the app needs is CACHE_HOLDER's exact statement, exempted in
    // the scan itself rather than by a file-level row, which would mask any
    // second reach in that file.
    appliesTo: () => true,
    scan: mutationCacheAccess,
    allowlist: [],
    expectScanned: { atLeast: 500, hint: "every .ts/.tsx under src/" },
    message:
      "the client's mutation cache is reached only to read it (gd-conventions, 'Mutation identity pinning') — `MutationCache.build(…)` makes a mutation @/lib/started-mutation never saw, so every `getMutationCache` mention must be its call followed directly by a `.getAll`, `.find`, `.findAll`, `.subscribe` or `.clear` call (`?.` and type arguments too, `find<TData, …>(…)`; `hasListeners` reads as well, while query-core's internal `remove` and `resumePausedMutations` don't). A held reference, or `getMutationCache` itself reached quoted, optionally (`?.()`), asserted, generically (`<…>()`), bound, parenthesized or through the prototype, fails, and so does anything else. The app's one held reference, `useMutationCacheSnapshot`'s statement in src/lib/git/queries/internal.ts (CACHE_HOLDER), is exempted as that exact statement, once, so any other mention in that file still fails. Threat model: these scans target accidental use, not deliberate evasion, so spellings only an evader would write are named under Not seen rather than chased. Not seen: a cache reference handed in from elsewhere (a select callback's parameter), a member assembled at runtime (`qc[\"getMutation\" + \"Cache\"]()`), and the shared comment stripper's lexing gaps (a `/*` inside a multi-line template literal, a regex literal, a backslash-continued string or JSX text blanks the scan up to the next `*/`, and a `//` in JSX text, a regex or a template tail blanks the rest of its line). Fails closed (false positives): a mention that isn't a call, such as `ReturnType<QueryClient[\"getMutationCache\"]>`, `typeof queryClient.getMutationCache`, or a string or JSX naming it",
  },
  {
    name: "mutation-defaults",
    // Repo-wide: a client can be configured, or reconfigured, from any module.
    appliesTo: () => true,
    scan: mutationDefaults,
    allowlist: [],
    expectScanned: { atLeast: 500, hint: "every .ts/.tsx under src/" },
    message:
      "react-query mutation defaults are banned (gd-conventions, 'Mutation identity pinning') — @/lib/started-mutation installs mutationFn/onMutate/onSuccess/onError/onSettled trampolines on every construction, and react-query spreads a construction's own options over the client's defaults, so a default mutationFn or callback would be shadowed without a sound. The check passes only what it can prove harmless. Any mention of `setDefaultOptions`, `getDefaultOptions`, `setMutationDefaults`, `getMutationDefaults` or `defaultMutationOptions` fails, quoted, optional, escaped or bound alike (`getDefaultOptions()` hands out the live defaults object, and `defaultMutationOptions` is query-core's merge point, which a subclass or patch could override). Every `defaultOptions` mention fails unless it is a type position with no value (`defaultOptions?: T` ending at `;` `,` `)` or `}`, or `defaultOptions: T` ending a member with `;` or a parameter list with `)`, member modifiers skipped, with no `=` and no `/` in the annotation) or an object-entry key whose value is a literal holding only a bare `queries` entry and closing its entry (`,` `}` `;` or `)` next, past any `as T` / `satisfies T`). So shorthands, bindings, assignments, member reads and writes, getters, methods, parameter defaults, class-field initializers, non-literal values, a literal read after it closes (`.constructor(…)`, `['queries']`) and any other entry (`mutations`, a spread, a quoted or computed key) fail. Put the behavior in the construction, or teach the helper to merge the defaults first. Threat model: these scans target accidental use, not deliberate evasion, so spellings only an evader would write are named under Not seen rather than chased. Not seen: keys or members assembled at runtime (`qc[\"set\" + name]`), reach through `Object.values` / `Object.entries`, prototype pollution, and the shared comment stripper's lexing gaps (a `/*` inside a multi-line template literal, a regex literal, a backslash-continued string or JSX text blanks the scan up to the next `*/`, and a `//` in JSX text, a regex or a template tail blanks the rest of its line). Fails closed (false positives, an allowlist entry with rationale is the remedy): an annotated parameter followed by another parameter, which can't be told from an object entry; an interface member ending without `;`; JSX `defaultOptions={…}`; type-level references (`QueryClientConfig['defaultOptions']`, a `Pick`/`Omit` of it); a nested `defaultOptions` key inside `queries`; a `/` inside a string within an annotation (`Foo<\"a/b\">`); and a getter, method or quoted `queries` entry",
  },
  {
    name: "mcp-secret-keychain-sites",
    // Repo-wide: a keychain write fired from any draft surface would bypass
    // Save/Discard. The target model and the pin rules sit on MCP_SECRET_API,
    // MCP_FLUSH_MODULE and MCP_FLUSH_CALLER. No file is allowlisted: a row
    // skips a whole file, so all three pinned files pin their code instead.
    appliesTo: () => true,
    scan: mcpKeychainSites,
    allowlist: [],
    expectScanned: { atLeast: 500, hint: "every .ts/.tsx under src/" },
    message:
      "MCP keychain writes stay behind the settings Save, so a Discard can take back every MCP server edit, secrets included. Target model, holding for all three files since none is allowlisted: a keychain write reaches Rust only through src/lib/git/api/mcp.ts's two pinned definitions (MCP_SECRET_API: setMcpSecret and deleteMcpSecret, each its whole statement); those are called only from src/features/settings/mcp/flush-mcp-secrets.ts's two pinned functions (MCP_FLUSH_MODULE: the API import, the queue binding and the two exported functions, each its whole statement); that module is reachable only through SettingsScreen's one pinned import; and its functions (flushMcpSecretSets, flushMcpSecretDeletes) run only as the two pinned statements, directly inside the Save handler's body (MCP_FLUSH_CALLER: the `onSubmit: async (…) => {…}` entry of SettingsScreen's one `useAppForm({…})` call). A draft surface stages its values in the settings screen's buffer instead. Every token is matched on raw source, comments and strings included: the four names, any mcp_secret-family word (word-level, so command names and every other spelling alike) but the read-only ones (MCP_SECRET_READ_ONLY), and the module stem `flush-mcp-secrets` in any form (an import, `export * from`, `import()`, `require`). A pin's tokens and punctuation are exact; where the pin has a space the source may have any whitespace, line breaks included, or none (at least one between two name characters). Each pin is accepted once: the definitions, the flush module's code and the import at a code position anywhere in their file (a comment inside breaks the match), each Save statement on the masked source holding nothing but code, after `;` `{` or `}`, with only block braces (try, finally, else, do, catch, if/for/while/switch/catch heads, bare blocks after `;` `{` or a block's `}`) between it and the Save body's own brace. Line 1 fails when a pin has no accepted match (or a Save statement more than one), when the Save body can't be found (not exactly one `useAppForm(` call with an object-literal first argument, a `useAppForm<…>` type-argument list the walk can't read, any computed key, a spread after onSubmit, not exactly one entry named onSubmit in any spelling, a duplicate onSubmit key included, or that entry not `onSubmit: async (…)[: T] => {…}`), or when ts-mask can't lex a pinned file: re-point the pins in the same change. Threat model: these scans target accidental use, not deliberate evasion, so spellings only an evader would write are named under Not seen rather than chased. Not seen: names or commands assembled at runtime through the @/lib/git/api barrel (`api[\"set\" + name]`, a template-built command, `Object.values(api)`); unicode- or hex-escaped spellings of a name or command; what fires onSubmit (`form.handleSubmit()` from a non-Save path: the guard pins where the flush sits, not what triggers it); the exempt statements' reachability and argument provenance (after `return`, under `if (false)`); an import whose specifier is computed rather than a literal naming the flush module (a glob, a concatenated stem, or the module importing itself through `import.meta.url`); the cold-start store helpers (`coldStartSetSecret(\"mcp-server/…\")`, test mode only: an `mcp-server/` token would false-close src/lib/settings/mcp.ts and src/lib/settings/api.ts); `createCallQueue`'s own body in src/features/settings/mcp/secret-ops.ts, which names no guarded token (its tests cover its ordering), and the module the flush file imports it from; a keychain-writing Rust command whose name lacks mcp_secret; and eval, `new Function` and prototype pollution. Fails closed (false positives; re-point the pins in the same change): a comment naming a token; a comment inside any pinned statement; any other mention of a token, a same-named local (a useState setter named setMcpSecret), a string or a type position included (the remedy is a rename); any edit to the flush module's pinned code (re-point MCP_FLUSH_MODULE); a Save written any other way (a method, a concise body, extracted to a const, wrapped in useCallback); a computed key or a later spread in the form options, or an entry there the classifier can't read (an escaped key, a depth-1 comma inside type arguments); a reworded pinned statement, or one the formatter rewraps with added punctuation (a trailing comma, parentheses); and a flush statement nested in a closure, in a case or label block, or behind a prefix (`void`, `=>`, a brace-less `if`)",
  },
];

/**
 * The one-line "OK" a clean check prints, or null when it has nothing to claim.
 * A scope-pin failure suppresses it: a check whose path moved scans nothing and
 * would otherwise print a pass, which is the exact silent fail-open this file
 * exists to prevent. Extracted so that suppression is assertable.
 */
export function okReportLine(check, result, pinFailure) {
  if (pinFailure) return null;
  if (result.violations.length > 0 || result.stale.length > 0) return null;
  return `${check.name}: OK (${result.scanned.length} files scanned)\n`;
}

/** Every .ts/.tsx file under `dir`, as repo-relative POSIX paths. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      out.push(relative(ROOT, full).split("\\").join("/"));
    }
  }
  return out;
}

/** Every file under `dir`, as repo-relative POSIX paths, whatever its extension. */
function walkAll(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkAll(full, out);
    else out.push(relative(ROOT, full).split("\\").join("/"));
  }
  return out;
}

// src-script-extensions' own stale condition: an allowlist row naming no file.
const STALE_SCRIPT_FIX =
  "stale allowlist entry — no such file under src/ any more; remove the entry " +
  "(an exception left behind pre-authorizes whatever lands at that path next)";

const STALE_FIX =
  "stale allowlist entry — nothing in this file trips the check any more " +
  "(fixed, renamed, deleted, or excluded by appliesTo); remove the entry " +
  "(an exception left behind pre-authorizes whatever the file grows next)";

/** One check over `files`: violations from files NOT on the allowlist, plus the
 *  allowlist entries that produced no hit at all. Allowlisted files are SCANNED
 *  rather than skipped — a ratchet that can only loosen is not a ratchet, so an
 *  entry whose site is gone is itself a finding. An entry naming a file the
 *  check doesn't apply to, or that no longer exists, reads stale for the same
 *  reason: nothing justifies it any more. */
export function runCheck(check, files, views) {
  const scanned = files.filter((f) => check.appliesTo(f));
  const violations = [];
  const seen = new Set();
  for (const file of scanned) {
    // The path rides along for a scan that pins an exemption to one file.
    const lines = check.scan(views.get(file), file).sort((a, b) => a - b);
    if (lines.length === 0) continue;
    if (check.allowlist.includes(file)) {
      seen.add(file);
      continue;
    }
    for (const line of lines) violations.push(`${file}:${line}`);
  }
  return {
    scanned,
    violations,
    stale: check.allowlist.filter((f) => !seen.has(f)),
  };
}

function main() {
  const files = walk(SRC);
  const views = new Map(
    files.map((f) => [f, view(readFileSync(join(ROOT, f), "utf8"))]),
  );
  let failed = false;

  for (const check of CHECKS) {
    const { scanned, violations, stale } = runCheck(check, files, views);
    const pinFailure = scopePinFailure(check, scanned.length);
    if (pinFailure) {
      failed = true;
      process.stderr.write(`${pinFailure}\n`);
    }
    const okLine = okReportLine(
      check,
      { scanned, violations, stale },
      pinFailure,
    );
    if (okLine) {
      process.stdout.write(okLine);
      continue;
    }
    failed = true;
    if (violations.length > 0) {
      process.stderr.write(
        `${check.name}: ${violations.length} violation(s)\n`,
      );
      for (const v of violations) process.stderr.write(`  ${v}\n`);
      process.stderr.write(`  → ${check.message}\n`);
    }
    if (stale.length > 0) {
      process.stderr.write(
        `${check.name}: ${stale.length} stale allowlist entry(s)\n`,
      );
      for (const f of stale) process.stderr.write(`  ${f}\n`);
      process.stderr.write(`  → ${STALE_FIX}\n`);
    }
  }

  // EXTENSIONS stays complete: a script under src/ the walk above can't read
  // escapes every check here, so its presence fails, and so does an allowlist
  // row naming no such file.
  const everything = walkAll(SRC);
  const unscanned = unscannedScripts(everything);
  const staleScripts = UNSCANNED_SCRIPT_ALLOWLIST.filter(
    (p) => !everything.includes(p),
  );
  if (unscanned.length > 0 || staleScripts.length > 0) {
    failed = true;
    for (const f of unscanned)
      process.stderr.write(
        `src-script-extensions: ${f} is never scanned (the checks read .ts/.tsx only) — convert it to TypeScript, or add it to UNSCANNED_SCRIPT_ALLOWLIST with rationale\n`,
      );
    for (const f of staleScripts)
      process.stderr.write(
        `src-script-extensions: ${f}\n  → ${STALE_SCRIPT_FIX}\n`,
      );
  } else {
    process.stdout.write(
      `src-script-extensions: OK (${everything.length} files checked)\n`,
    );
  }

  // Not `process.exit`: it can truncate a pending pipe write, losing the very
  // violation list the failure is about on a CI runner.
  process.exitCode = failed ? 1 : 0;
}

// Main-module detection by PATH comparison, not `import.meta.main`: this form
// works on any node, while `import.meta.main` only exists from 24.2 — a cliff
// the documented floor should not have to track, and one that fails SILENTLY
// (the gate reads `if (undefined)` and the script exits 0 having scanned
// nothing — the fail-open this whole file exists to prevent).
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
