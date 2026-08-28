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
// Known false positive left open: a legal SELF-BOUNDED clip span inside an
// item (TaskDialog's `max-w-64 truncate` interpreter-path sub-span — its own
// width bound keeps the handler live) sits ~2× outside the window today; a
// compacted row would fire loudly, with the allowlist as remedy. Accepted
// evasions: an aliased or wrapped handler, a reordered/interleaved class
// string, a wrapper component around SelectItem — and a bare text child with
// no affordance at all, the shape most converted sites had, which no arm can
// see.
const SELECT_ITEM_CLIP_TITLE_RE = new RegExp(
  `<SelectItem\\b(?:(?!</SelectItem\\b)[\\s\\S]){0,${PAIR_GAP}}?\\bclipTitle`,
  "g",
);
const SELECT_ITEM_BLOCK_TRUNCATE_RE = new RegExp(
  `<SelectItem\\b(?:(?!</SelectItem\\b)[\\s\\S]){0,${PAIR_GAP}}?\\bblock truncate\\b`,
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
      "src/features/pulls/CommitComments.tsx",
      "src/features/pulls/CreateLocalPrDialog.tsx",
      "src/features/pulls/CreatePrDialog.tsx",
      "src/features/pulls/ReviewComposer.tsx",
      "src/features/pulls/ReviewThreads.tsx",
      "src/features/repository/FileRow.tsx",
      "src/features/research/ResearchView.tsx",
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
    allowlist: [],
    message:
      "clip-measured tooltips route through clipTitle/clipTitleFromText (src/lib/clip-title.ts) — an inline rewrite re-opens the blank-title ancestor-suppression class; if the pairing is a false positive, add an allowlist entry with rationale",
  },
  {
    name: "select-item-clip-title",
    appliesTo: notVendoredUi,
    scan: anyOf([
      perFile(SELECT_ITEM_CLIP_TITLE_RE),
      perFile(SELECT_ITEM_BLOCK_TRUNCATE_RE),
    ]),
    allowlist: [],
    message:
      "Select popup rows route their clip affordance through SelectClipText (src/components/select-clip-text.tsx) — an item-level clipTitle handler is dead once the row span self-bounds, and a bare `block truncate` child never engages under the shrink-refusing ItemText; if the pairing is a false positive (a self-bounded clip span inside a rich row — its own max-w keeps the handler live), add an allowlist entry with rationale",
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
    name: "bare-mutate-in-converted-trees",
    // Scoped to the trees that are fully converted, so the check can only ever
    // see a NEW site: the settings dialog's own sections (which unmount on BOTH
    // dialog close and every rail section switch — the keyed crossfade), Explore,
    // whose detail pane is keyed per repo, and Actions, whose run detail is keyed
    // per run and whose dispatch dialog unmounts with the repo view. The wider app
    // is a separate tier: pulls/ and repository/ still carry per-call callback
    // sites in bulk, so scanning them would report a backlog rather than a
    // regression. Each tree joins this check on the change that converts it.
    appliesTo: (file) =>
      file.startsWith("src/features/repo-settings/") ||
      file.startsWith("src/features/explore/") ||
      file.startsWith("src/features/actions/"),
    scan: anyOf([perLine(MUTATE_CALL_RE), perFile(DESTRUCTURED_MUTATE_RE)]),
    allowlist: [],
    message:
      "react-query gates per-call mutation callbacks on the observer still having listeners, so a dialog close, a rail section switch, or a keyed pane remount mid-flight drops the toast, teardown, and navigation that lived in them — every mutation here awaits mutateAsync and puts its outcome in the continuation, so a bare .mutate( (or a `const { mutate }` destructure that reaches one) needs an allowlist entry with rationale",
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
      // Seeds the Bitbucket workspace once workspaces load; empty-field only.
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
    ],
    message:
      "an open-transition reset must ride useSeedOnOpen (src/lib/use-seed-on-open.ts) — a hidden <Activity> tab re-mounts its effects on show, so a bare `useEffect(() => { if (open) seed(); }, [open])` re-fires and wipes the user's draft; a data-arrival or otherwise idempotent seed needs an allowlist entry with rationale",
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
];

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
    if (violations.length === 0 && stale.length === 0) {
      process.stdout.write(
        `${check.name}: OK (${scanned.length} files scanned)\n`,
      );
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
