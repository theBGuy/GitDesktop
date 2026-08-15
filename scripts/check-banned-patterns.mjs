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

/** Scanner: the union of several `nearPair`s — one check, one allowlist, every
 *  Tailwind spelling of the same idiom. */
const anyPair = (pairs) => {
  const scans = pairs.map(([a, b]) => nearPair(a, b));
  return (v) => [...new Set(scans.flatMap((scan) => scan(v)))];
};

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

// Vendored shadcn/Base UI primitives are off-limits to edit (CLAUDE.md), so a
// hit inside them could only ever be silenced by an allowlist entry, never
// fixed. Their CALL SITES — the app code that composes them — stay scanned.
const notVendoredUi = (file) => !file.startsWith("src/components/ui/");

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
    // FROZEN: these 14 files are the app-wide mod+Enter submit policy (PR #202)
    // and the file-row multi-select modifier. The gate blocks NEW hand-rolled
    // sites; it is not a to-do list for these.
    allowlist: [
      "src/components/markdown-editor.tsx",
      "src/features/conversations/CommentComposer.tsx",
      "src/features/conversations/CommentEditor.tsx",
      "src/features/conversations/EditTitleBodyDialog.tsx",
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
    name: "setQueryData-noop",
    // Not a UI idiom — it applies wherever the cache is written, vendored or not.
    appliesTo: () => true,
    scan: perFile(SET_QUERY_DATA_RE),
    allowlist: [],
    message:
      "setQueryData(key, undefined) is a silent no-op in TanStack v5 — snapshot and restore the previous value instead",
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
