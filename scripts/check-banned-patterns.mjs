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
// reaches the call: inline literal, hoisted variable (`.mutate(v, opts)` — the
// shape 5 of the settings sections used, and still live elsewhere under src/),
// spread, shorthand keys. The token has no such surface, and it costs nothing
// here because the directories this check applies to have no `.mutate(` calls
// left at all — every mutation there is awaited. `.mutateAsync(` does not match:
// the `(` must follow `mutate` directly.
const MUTATE_CALL_RE = /\.mutate\s*\(/;

// The dot-less route to the same call: `const { mutate } = useX()` (a live idiom
// elsewhere in src/) reaches `.mutate` off a destructured binding, so the token
// above never sees it. The `\b` after `mutate` is what keeps `{ mutateAsync }`
// clean, while a renamed `{ mutate: save }` still hits. Run over the whole-file
// view, not per line: a destructure long enough to wrap is a shape this codebase
// already produces (15 wrapped hook destructures under src/, none binding
// `mutate` today), and `[^}]*` can't cross the destructure's own closing brace,
// so the joined view adds no reach.
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

// The two halves of an async settings rollback. The gate: an OPTIMISTIC patch of
// the settings cache — the file flips the preference itself so the UI can commit
// before the store write resolves. The hit: that file's mutation `onError`
// restoring by REFETCH rather than by writing the snapshot back, which lands the
// restore a commit or more later — too late for a focus hand-off armed on the
// flip, so focus drops to <body> on a refused write.
// Co-presence is the class, and the gate is FORWARD-looking: nothing trips the
// onError half today — every settings invalidate under src/ is success-path, and
// settings/queries.ts's lone `onError` sits 467 normalized chars from the next
// one, well past PAIR_GAP (measured while sizing this check). What the gate buys
// is that a file which legitimately refetches settings from an `onError` with
// nothing optimistic to roll back (DangerZone, RepoList, useRepoVisibilityProbe
// are each one edit from that shape) can never read as a violation.
// The cost of file-scoping, accepted: one file that patches the settings cache
// for its own feature AND refetches settings from an unrelated mutation's
// onError pairs them anyway — a loud false positive, allowlist as remedy. It
// buys the reverse, which matters more: the patch and the mutation it guards may
// sit in different functions of the same hook file, and a proximity pair would
// miss that. The reported line is the `onError`, which is the site to rewrite.
// The optional type-argument group uses the same `<[^(]*?>` class as
// SET_QUERY_DATA_RE above, for the same reason: a `<[^>]*>` group stops at the
// INNER `>` of a nested generic (`setQueryData<Record<string, Foo>>`), and the
// lazy run bounded by the call's own paren resolves it. Missing a typed spelling
// here would turn this file's whole gate off, not just skip one line.
const OPTIMISTIC_SETTINGS_PATCH_RE =
  /setQueryData\s*(?:<[^(]*?>)?\s*\(\s*settingsKeys\.settings\b/;
const ONERROR_SETTINGS_REFETCH_RE = new RegExp(
  `\\bonError\\b[\\s\\S]{0,${PAIR_GAP}}?invalidateQueries\\s*\\(\\s*\\{\\s*` +
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

// The mutation-identity family. Anchors are deliberately structural rather than
// textual: react-query re-pushes a hook's options onto its PENDING mutation on
// every render, so the defect is a repo-scoped call carrying no mutation key —
// a shape, not a spelling.
/** Any `function use…` declaration, exported or not. The generic list is matched
 *  separately (see `paramListOpen`): `function useRepoMutation<TArgs, TData>(` puts
 *  a `<` where a `(` would be, and an anchor demanding the paren swallows the whole
 *  hook silently. */
const HOOK_DECL_RE = /\b(export\s+)?function\s+(use[A-Za-z0-9_$]*)\s*(?=[<(])/g;
const MUTATION_CALL_RE = /\buse(?:Repo)?Mutation\s*\(/g;
/** `identity:` is useRepoMutation's spelling of `mutationKey:`; either pins. */
const MUTATION_KEYED_RE = /\b(?:identity|mutationKey)\s*:/;
/** A `repo` parameter in the hook's own signature — the closure that a mid-flight
 *  switch redirects. A hook taking repo through its VARIABLES instead is the other
 *  valid remedy (see useMoveBoardCard) and correctly never matches. */
const REPO_PARAM_RE = /(?:^|[,{(\s])repo\s*[:,)]/;
const CREATE_HOOK_RE = /Create/;
/** Widest gap (normalized chars) still read as one callback for the seed arm.
 *  Past it the seed is not seen and the site reads CLEAN — the bound fails toward
 *  under-matching, so a long `onSuccess` body can hide its own `setQueryData`.
 *  (Within the window an unrelated pair can also over-match, which is merely a
 *  named file and line with the allowlist as its remedy.) */
const SEED_WINDOW = 400;
/** The GAP-5 shape: a response seeded into a hook-scope key on success, which a
 *  retarget writes into the newly-live repo's cache with nothing to roll it back. */
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

/** A parameter or argument list split on its TOP-LEVEL commas. `<`/`>` are not
 *  counted as brackets — `=> Promise<T>` would otherwise drive the depth negative
 *  and misplace every later comma. The residual is a comma inside a generic
 *  (`Promise<Record<string, unknown>>`), which over-counts in BOTH directions: an
 *  over-counted ARGUMENT list can hide a missing key, and an over-counted PARAMETER
 *  list raises the required index so a call that does pass the key trips the check.
 *  Zero-instance in the scanned modules today; a real generic parser is the fix. */
function splitTopLevel(list) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
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
 * The index of the wrapper parameter its mutation key is CONDITIONAL on — the
 * spread the local PR/issue wrappers use — or -1 when the key is unconditional.
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
      params: splitTopLevel(text.slice(paramOpen + 1, paramClose)),
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
    // FROZEN: the mod+Enter submit policy files (PR #202), the file-row
    // multi-select modifier, and DiffViewer's additive-drag capture listener
    // (the vendored selection manager's callbacks carry no event, so it reads
    // the raw flags; the modifier itself stays isMac-derived). The gate blocks
    // NEW hand-rolled sites; it is not a to-do list for these.
    allowlist: [
      "src/components/markdown-editor.tsx",
      "src/features/conversations/CommentComposer.tsx",
      "src/features/conversations/CommentEditor.tsx",
      "src/features/conversations/EditTitleBodyDialog.tsx",
      "src/features/diff/DiffViewer.tsx",
      "src/features/discussions/DiscussionView.tsx",
      "src/features/history/HistoryPanel.tsx",
      "src/features/plan/PlanView.tsx",
      "src/features/projects/BoardAddDialogs.tsx",
      "src/features/projects/BoardDraftEditDialog.tsx",
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
      perFile(ONERROR_SETTINGS_REFETCH_RE),
    ),
    allowlist: [],
    message:
      "an optimistically patched settings write rolls back SYNCHRONOUSLY — snapshot the previous value and setQueryData it back under a latest-write guard (useApplyTheme, src/lib/settings/queries.ts), never invalidateQueries: the refetch restores a commit or more later, so a collapse toggle's focus hand-off has nothing to ride and focus drops to <body>",
  },
  {
    name: "bare-mutate-in-converted-trees",
    // Scoped to the trees that are fully converted, so the check can only ever
    // see a NEW site: the repo-settings dialog's own sections (which unmount on
    // BOTH dialog close and every rail section switch — the keyed crossfade), Explore,
    // whose detail pane is keyed per repo, Actions, whose run detail is keyed per
    // run and whose dispatch dialog unmounts with the repo view, the repository
    // and commit trees, whose panels ride <Activity>-hidden tabs and whose
    // dialogs close mid-flight, and pulls / issues / history / discussions /
    // tags, whose surfaces go through an `<Activity>` tab hide on every repo-tab
    // switch. What is left is scattered singles (diff, compare, app settings,
    // welcome, automations, conversations, scripts, hooks, branch-rules,
    // updates, App.tsx, the detail rail), each joining on its own conversion —
    // plus src/lib/settings/queries.ts's theme write, which STAYS: its onError
    // is the synchronous rollback the async-settings-rollback check pins.
    appliesTo: (file) =>
      file.startsWith("src/features/repo-settings/") ||
      file.startsWith("src/features/explore/") ||
      file.startsWith("src/features/actions/") ||
      file.startsWith("src/features/pulls/") ||
      file.startsWith("src/features/repository/") ||
      file.startsWith("src/features/commit/") ||
      file.startsWith("src/features/issues/") ||
      file.startsWith("src/features/history/") ||
      file.startsWith("src/features/discussions/") ||
      file.startsWith("src/features/tags/"),
    scan: anyOf([perLine(MUTATE_CALL_RE), perFile(DESTRUCTURED_MUTATE_RE)]),
    // Every entry is a call carrying NO per-call callbacks object, so there is
    // nothing an unmount can drop; the token match is the ratchet, and an
    // exemption is an entry here rather than a hole in the pattern.
    allowlist: [
      // The local-conversation write-through and the archive/unarchive toggles,
      // all single-arg `update.mutate(vars)` — the deselect the archive pairs
      // with is synchronous.
      "src/features/issues/LocalIssueView.tsx",
      // Eight single-arg picker/field writes; their hooks report failures at the
      // mutation level.
      "src/features/issues/RemoteIssueViewParts.tsx",
      // Archive/unarchive, single-arg `update.mutate(vars)` — the deselect it
      // pairs with is synchronous.
      "src/features/pulls/LocalPrContextMenu.tsx",
      // The local-conversation write-through and the approve toggle, both
      // single-arg `update.mutate(vars)`.
      "src/features/pulls/LocalPrView.tsx",
      // The palette's archive action, single-arg `updateLocalPr.mutate(vars)`.
      "src/features/pulls/PullRequestsPanel.tsx",
      // GitLab time tracking's set-estimate and add-spent, both single-arg.
      "src/features/pulls/RemotePrViewParts.tsx",
      // Deleting one stored review, single-arg `del.mutate(id)`.
      "src/features/pulls/ReviewHistory.tsx",
      // Reconciles merged/deleted heads from an effect: the destructured
      // `mutate` is called single-arg on both arms.
      "src/features/pulls/useReconcileLocalPrs.ts",
    ],
    message:
      "react-query gates per-call mutation callbacks on the observer still having listeners, so a dialog close, a rail section switch, an <Activity> tab hide, or a keyed pane remount mid-flight drops the toast, teardown, and navigation that lived in them — every mutation here awaits mutateAsync and puts its outcome in the continuation, so a bare .mutate( (or a `const { mutate }` destructure that reaches one) needs an allowlist entry with rationale",
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
      // Its `eventToBinding` call tests four hardcoded Alt reorder chords
      // against a fixed table, not a user binding, and the handler's DOM
      // containment check already pins focus to a board card — the board
      // holds no editable or typeahead targets for the guards to protect.
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
    // The modules that declare repo-scoped mutation hooks: the git queries
    // package, the Jira queries, and the two local-entity modules. The check is
    // deliberately NARROWER than the convention it serves: the convention governs
    // every mutation whose callbacks close over repo/lens, which is ~200 sites here,
    // while this ratchet covers the two where a retarget is not self-healing — a
    // create landing in the wrong repo, and a response seeded into the wrong repo's
    // cache. The rest stay a review concern, not an exempted one.
    // Within that boundary the scan still has named gaps (message lists them): it
    // recognizes a create by NAME, so the `Add…`/`Submit…`/`Publish…`/`Fork…`
    // spellings of one are invisible; and it follows delegation only to a `use…`
    // wrapper in the SAME file, and only from a create hook. Widening the name
    // heuristic makes each newly-seen site a pin-or-allowlist decision, so it is a
    // deliberate follow-up — widen here rather than allowlisting the consequences.
    // The local-entity wrappers keep their key OPTIONAL on purpose: making it
    // mandatory would pin their update/delete hooks too, and those callers read
    // `isPending` as a re-entry guard that a detach silently opens. That migration
    // (isPending → a local submitting flag) is the recorded follow-up; until it
    // lands, the delegating-call check above is what holds the create half.
    appliesTo: (file) =>
      (file.startsWith(QUERIES_DIR) && file.endsWith(".ts")) ||
      file === JIRA_QUERIES ||
      LOCAL_QUERIES.includes(file),
    scan: unpinnedMutationIdentity,
    allowlist: [
      // useStackCreate renders a failed write inline off the mutation's OWN `error`
      // and clears it with `reset()` (RemotePrView), so a detach would swallow the
      // failure its catch deliberately stays silent for. Pinning needs that error
      // path moved onto the awaited promise first. Covers the whole file, so a new
      // create hook added HERE is masked — split the entry if that changes.
      `${QUERIES_DIR}pr-write.ts`,
    ],
    // Floor near the real module count (33): a low floor would let a typo in
    // QUERIES_DIR leave the scan almost entirely inert and still pass.
    expectScanned: {
      atLeast: 27,
      hint: `${QUERIES_DIR}*.ts + ${JIRA_QUERIES} + ${LOCAL_QUERIES.join(" + ")}`,
    },
    message:
      "a repo-scoped create or cache-seeding mutation must pin its identity (gd-conventions, 'Mutation identity pinning') — react-query re-pushes a hook's options onto its PENDING mutation on every render, so without a mutation key a repo switch mid-flight retargets the call, its callbacks and its cache writes to the newly-live repo; pass `identity: [\"<op>\", repo, …]` on useRepoMutation or `mutationKey: [\"<op>\", repo, …]` on a plain useMutation, naming exactly the hook-scope values the call closes over, and make sure every caller takes its continuation from `await mutateAsync` (a detached mutation's observer goes idle, so `isPending`/`data`/`error` reads stop tracking it) — or add an allowlist entry with rationale. This scan does NOT see seven shapes inside its own boundary, so review them by hand: a create whose NAME lacks 'Create' (the `Add…`/`Submit…`/`Publish…`/`Fork…` spellings — useAddRemote, useSubmitReview, useForkRepo and their siblings are all live), a mutation built through a wrapper in another MODULE, one built through a helper not named `use…`, a cache-seeding wrapper reached only from non-create hooks, a conditionally-keyed wrapper whose delegating call DOES pass the identity argument but passes something undefined or keyless in it (the call-site check counts arguments, it cannot evaluate them — src/lib/pulls/queries.ts and src/lib/issues/queries.ts are the live pair), a hook declared as `export const useX = (repo) => …` (the declaration anchor requires the `function` keyword), and one whose return type is an inline object literal (`): { … } {` — the body scan would take the return type as the body). The last two are zero-instance in the scanned modules today, so adding either shape means teaching this scanner first",
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
    const lines = check.scan(views.get(file)).sort((a, b) => a - b);
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
