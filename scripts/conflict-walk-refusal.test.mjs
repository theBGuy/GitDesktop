// Pins how the AI conflict walk treats a backend path-gate refusal
// (src/features/repository/ConflictResolveView.tsx): the classifier in
// conflict-banner-state.ts, its strings' congruence with the backend's refusal
// sentence (src-tauri/src/git/conflict.rs) and the conflict editor's own
// declarations (ConflictFileView.tsx), and the walk routing a refusal to its
// blocked screen instead of the retry arm. Also pins the not-conflicted
// refusal the side checkout returns to the editor's not-conflicted line.
//
// Not testable here: the rendered blocked screen and its focus rescue. Those
// need the live app.
//
// The import reaches straight into `src/` under Node's type stripping, so
// conflict-banner-state.ts must stay free of runtime imports. Every lookup
// that finds nothing fails, so a moved or unreadable source can't pass.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CONFLICT_LINKED_LEAF_TAIL,
  CONFLICT_PATH_REFUSAL_PREFIX,
  conflictPathRefusal,
} from "../src/features/repository/conflict-banner-state.ts";
import { maskNonCode, matchBrace } from "./lib/ts-mask.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUST = "src-tauri/src/git/conflict.rs";
const VIEW = "src/features/repository/ConflictFileView.tsx";
const RESOLVE = "src/features/repository/ConflictResolveView.tsx";
const read = (file) => readFileSync(join(REPO_ROOT, file), "utf8");

const RUST_SENTENCE =
  /AppError::InvalidArgument\(format!\(\s*"([^"{]*) \{shown\}([^"{]*)\{why\}([^"{]*)"/;
const RUST_LEAF = /^const CONFLICT_LINKED_LEAF: &str = "([^"\\]*)";\r?$/m;
const VIEW_PREFIX = /^const PATH_REFUSAL_PREFIX = "([^"\\]*)";\r?$/m;
const VIEW_LEAF = /^const LINKED_LEAF_REASON = "([^"\\]*)";\r?$/m;
const VIEW_TAIL =
  /^const LINKED_LEAF_TAIL = `([^`$]*)\$\{LINKED_LEAF_REASON\}([^`$]*)`;\r?$/m;

/** The prefix and leaf tail as the backend and the conflict editor spell
 *  them; throws when a declaration is missing or any side disagrees. */
function pinStrings(rust, view, prefix, tail) {
  const sentence = RUST_SENTENCE.exec(rust);
  assert.ok(sentence, "conflict.rs must keep conflict_path_refusal's sentence");
  const rustLeaf = RUST_LEAF.exec(rust);
  assert.ok(rustLeaf, "conflict.rs must declare CONFLICT_LINKED_LEAF");
  const viewPrefix = VIEW_PREFIX.exec(view);
  assert.ok(viewPrefix, "ConflictFileView must declare PATH_REFUSAL_PREFIX");
  const viewLeaf = VIEW_LEAF.exec(view);
  assert.ok(viewLeaf, "ConflictFileView must declare LINKED_LEAF_REASON");
  const viewTail = VIEW_TAIL.exec(view);
  assert.ok(viewTail, "ConflictFileView must declare LINKED_LEAF_TAIL");
  const [, rustPrefix, sep, close] = sentence;
  assert.equal(prefix, rustPrefix, "the prefix differs from conflict.rs");
  assert.equal(
    prefix,
    viewPrefix[1],
    "the prefix differs from ConflictFileView",
  );
  assert.equal(
    tail,
    `${sep}${rustLeaf[1]}${close}`,
    "the leaf tail differs from conflict.rs",
  );
  assert.equal(
    tail,
    `${viewTail[1]}${viewLeaf[1]}${viewTail[2]}`,
    "the leaf tail differs from ConflictFileView",
  );
}

const RUST_NOT_CONFLICTED =
  /^pub\(crate\) const NOT_CONFLICTED_REFUSAL: &str = "([^"\\]*)";\r?$/m;
const VIEW_NOT_CONFLICTED = /^const NOT_CONFLICTED_COPY = "([^"\\]*)";\r?$/m;

function pinNotConflicted(rust, view) {
  const r = RUST_NOT_CONFLICTED.exec(rust);
  assert.ok(r, "conflict.rs must declare NOT_CONFLICTED_REFUSAL");
  const v = VIEW_NOT_CONFLICTED.exec(view);
  assert.ok(v, "ConflictFileView must declare NOT_CONFLICTED_COPY");
  assert.equal(
    v[1],
    r[1],
    "the not-conflicted copy differs between Rust and TSX",
  );
}

/** Where the walk's blocked screen points for Accept all: it has none of its
 *  own, so it names the conflict editor that does. */
const EDITOR_SITE = "current or incoming in the conflict editor ";

/** The editor's two refusal guidance sentences, which the walk's blocked
 *  screen repeats word for word (the leaf one naming the editor). */
function pinGuidance(view, res) {
  const leaf = /case linkedLeaf:\s*return `\$\{pathRefusal\} ([^`$]*)`;/.exec(
    view,
  );
  const other =
    /case pathRefusal !== null:\s*return `\$\{pathRefusal\} ([^`$]*)`;/.exec(
      view,
    );
  assert.ok(leaf && other, "ConflictFileView's refusal bodies moved");
  const table =
    /const PATH_REFUSAL_GUIDANCE = \{\s*leaf: "([^"\\]*)",\s*other: "([^"\\]*)",\s*\} as const;/.exec(
      res,
    );
  assert.ok(table, "ConflictResolveView must declare PATH_REFUSAL_GUIDANCE");
  const editorLeaf = leaf[1].replace("current or incoming ", EDITOR_SITE);
  assert.notEqual(editorLeaf, leaf[1], "the editor's leaf sentence moved");
  assert.equal(
    table[1],
    editorLeaf,
    "the leaf guidance differs from the editor's",
  );
  assert.equal(
    table[2],
    other[1],
    "the ancestor guidance differs from the editor's",
  );
}

/** start()'s catch routes a classified refusal to "blocked" and keeps the
 *  toast + idle arm for everything else; the blocked body reads the refusal
 *  before the ignore-pattern copy could. */
function pinRouting(res) {
  const masked = maskNonCode(res, true);
  const fn = /\basync\s+function\s+start\s*\(\s*\)\s*\{/.exec(masked);
  assert.ok(fn, "ConflictResolveView must declare start()");
  const open = fn.index + fn[0].length - 1;
  const close = matchBrace(masked, open);
  const body = masked.slice(open, close);
  const katch = /\bcatch\s*\(\s*e\s*\)\s*\{/.exec(body);
  assert.ok(katch, "start() must keep its catch (e) block");
  const catchOpen = open + katch.index + katch[0].length - 1;
  const source = res.slice(catchOpen, matchBrace(masked, catchOpen));
  const classify = source.search(
    /\bconflictPathRefusal\(\s*e\.kind\s*,\s*presentError\(e\)\.summary\s*\)/,
  );
  assert.notEqual(
    classify,
    -1,
    "start()'s catch must classify via conflictPathRefusal",
  );
  const blocked = source.search(/setPhase\("blocked"\)/);
  assert.ok(
    blocked > classify,
    'a classified refusal must set phase "blocked"',
  );
  assert.ok(
    source.search(/setPathRefusal\(refusal\)/) > classify,
    "the blocked screen needs the refusal stored",
  );
  const toast = source.search(/\btoastError\(e\)/);
  assert.ok(toast > blocked, "the toast belongs to the retry arm only");
  assert.ok(
    source.slice(toast).search(/setPhase\("idle"\)/) !== -1,
    'every other failure keeps phase "idle" and Try again',
  );
  const startBody = res.slice(open, close);
  assert.match(
    startBody,
    /setSides\(null\);\s*setPathRefusal\(null\);/,
    "every start() must clear the last refusal beside the sides",
  );
  assert.match(
    res,
    /\{pathRefusal !== null\s*\?[\s\S]{0,200}?:\s*BLOCKED_COPY\[blockedReason\(sides\)\]/,
    "a path refusal must never reach blockedReason's ignore-pattern copy",
  );
}

test("the classifier's strings match the backend and the conflict editor", () => {
  pinStrings(
    read(RUST),
    read(VIEW),
    CONFLICT_PATH_REFUSAL_PREFIX,
    CONFLICT_LINKED_LEAF_TAIL,
  );
});

test("the side checkout's not-conflicted refusal is the editor's line", () => {
  pinNotConflicted(read(RUST), read(VIEW));
});

test("the walk's blocked guidance repeats the editor's sentences", () => {
  pinGuidance(read(VIEW), read(RESOLVE));
});

test("conflictPathRefusal classifies only invalidArgument path refusals", () => {
  const ancestor = `${CONFLICT_PATH_REFUSAL_PREFIX} a/b.txt — a folder on its path is a link. Nothing was changed.`;
  const leaf = `${CONFLICT_PATH_REFUSAL_PREFIX} a/b.txt${CONFLICT_LINKED_LEAF_TAIL}`;
  assert.deepEqual(conflictPathRefusal("invalidArgument", leaf), {
    summary: leaf,
    linkedLeaf: true,
  });
  assert.deepEqual(conflictPathRefusal("invalidArgument", ancestor), {
    summary: ancestor,
    linkedLeaf: false,
  });
  assert.equal(
    conflictPathRefusal("invalidArgument", "This looks like a binary file."),
    null,
  );
  assert.equal(conflictPathRefusal("io", leaf), null);
  // A tail that only contains the leaf reason mid-sentence is not a leaf.
  const embedded = `${leaf.slice(0, -1)}, so try again.`;
  assert.equal(
    conflictPathRefusal("invalidArgument", embedded)?.linkedLeaf,
    false,
  );
});

test("the walk routes a path refusal to its blocked screen", () => {
  pinRouting(read(RESOLVE));
});

/** Returns `source` with `from` replaced, asserting the fixture exists. */
function mutate(source, from, to) {
  const out = source.replace(from, to);
  assert.notEqual(out, source, `the fixture \`${from}\` moved`);
  return out;
}

test("the pins fail on a reworded or rerouted side", () => {
  const rust = read(RUST);
  const view = read(VIEW);
  const res = read(RESOLVE);
  const P = CONFLICT_PATH_REFUSAL_PREFIX;
  const T = CONFLICT_LINKED_LEAF_TAIL;
  // Built outside assert.throws, so a moved fixture fails here instead of
  // passing as an expected throw.
  const badRustPrefix = mutate(
    rust,
    "\"Can't resolve the conflict in {shown}",
    "\"Can't resolve conflict in {shown}",
  );
  const badRustLeaf = mutate(
    rust,
    /(const CONFLICT_LINKED_LEAF: &str = "it's a symbolic )link/,
    "$1Link",
  );
  const badViewPrefix = mutate(
    view,
    /(const PATH_REFUSAL_PREFIX = "Can't resolve the conflict )in/,
    "$1at",
  );
  const badViewTail = mutate(
    view,
    /(const LINKED_LEAF_TAIL = `[^`$]*\$\{LINKED_LEAF_REASON\}\.) Nothing/,
    "$1 nothing",
  );
  const badNotConflicted = mutate(
    view,
    /(const NOT_CONFLICTED_COPY = "This file is no longer conflicted)\./,
    "$1!",
  );
  const badGuidance = mutate(
    res,
    /(leaf: "Accept all current or incoming) in the conflict editor/,
    "$1",
  );
  const noBlocked = mutate(res, /setPhase\("blocked"\);(\s*\} else \{)/, "$1");
  const noClassify = mutate(
    res,
    /conflictPathRefusal\(e\.kind, presentError\(e\)\.summary\)/,
    "null",
  );
  const noClear = mutate(
    res,
    /(setSides\(null\);)\s*setPathRefusal\(null\);/,
    "$1",
  );
  const cases = [
    [
      () => pinStrings(badRustPrefix, view, P, T),
      /prefix differs from conflict\.rs/,
    ],
    [
      () => pinStrings(badRustLeaf, view, P, T),
      /leaf tail differs from conflict\.rs/,
    ],
    [
      () => pinStrings(rust, badViewPrefix, P, T),
      /prefix differs from ConflictFileView/,
    ],
    [
      () => pinStrings(rust, badViewTail, P, T),
      /leaf tail differs from ConflictFileView/,
    ],
    [() => pinStrings(rust, view, `${P} `, T), /prefix differs/],
    [
      () => pinStrings(rust, view, P, T.replace(" — ", " - ")),
      /leaf tail differs/,
    ],
    [
      () => pinNotConflicted(rust, badNotConflicted),
      /not-conflicted copy differs/,
    ],
    [() => pinGuidance(view, badGuidance), /leaf guidance differs/],
    [() => pinRouting(noBlocked), /phase "blocked"/],
    [() => pinRouting(noClassify), /classify via conflictPathRefusal/],
    [() => pinRouting(noClear), /clear the last refusal/],
  ];
  for (const [run, message] of cases) assert.throws(run, message);
});
