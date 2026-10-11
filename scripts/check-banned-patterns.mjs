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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const EXTENSIONS = [".ts", ".tsx"];

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
 *  wrapped expression still reports a real line number. */
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
  return { lines, text: parts.join(" "), starts };
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
      "`fallback={null}` blanks the region while the boundary is active, with no aria-busy and nothing announced to assistive tech — lazy panels use LazyPanelFallback (src/components/lazy-panel-fallback.tsx); any other fallback-taking host, or a boundary whose absence is genuinely invisible, needs an allowlist entry with rationale",
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
