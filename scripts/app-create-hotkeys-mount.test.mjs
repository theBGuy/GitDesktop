// Pins where RepositoryView mounts AppCreateHotkeys, the app-level `create-pr`
// and `create-local-pr` entries. Dispatch runs the newest enabled entry and
// layout effects register in tree order, so the `{repoPath}` mount must sit
// after every ComparePanel and PullRequestsPanel element (the two panels that
// register the same actions); the `{null}` mount is the no-repository return,
// which keeps both chords registered without a repository. A closure over
// every .ts/.tsx under src/ (src/test/ excluded) keeps a fourth registrar from
// joining without its own order decision.
// A source scan, since nothing mounts RepositoryView in jsdom. Scans run on
// `maskNonCode`'s output, so comments and string text never count; literals
// are read from the raw text at the masked offsets. Every lookup that finds
// nothing fails, and a JSX spread in a mount's tag fails it (it could carry
// or override `repoPath`). Not covered: a registration whose first argument
// is not a string literal, and an aliased import of useHotkeyAction.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  elementRanges,
  loadCorpus,
  maskNonCode,
  matchBrace,
  srcEntries,
  tagEnd,
} from "./lib/ts-mask.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ACTIONS = ["create-pr", "create-local-pr"];
const REGISTRARS = [
  "src/features/compare/ComparePanel.tsx",
  "src/features/pulls/PullRequestsPanel.tsx",
  "src/features/repository/AppCreateHotkeys.tsx",
];
const HOST = "src/features/repository/RepositoryView.tsx";
const MOUNT = "AppCreateHotkeys";
const PANELS = ["ComparePanel", "PullRequestsPanel"];

const squash = (s) => s.replace(/\s+/g, "");
const mask = (rel, text) => maskNonCode(text, rel.endsWith(".tsx"));

const CORPUS = loadCorpus(
  srcEntries(ROOT, (rel) => !rel.startsWith("src/test/")),
);

/** The string literal opening at masked offset `at`, or null when none does
 *  or a template interpolates. */
function literalAt(text, masked, at) {
  const q = masked[at];
  if (q !== '"' && q !== "'" && q !== "`") return null;
  const value = text.slice(at + 1, masked.indexOf(q, at + 1));
  return q === "`" && value.includes("${") ? null : value;
}

/** Whether `text` holds a `useHotkeyAction(` call whose first argument is a
 *  literal naming one of ACTIONS; the argument may sit on a later line. */
function registersCreate(rel, text) {
  if (!text.includes("useHotkeyAction")) return false;
  const masked = mask(rel, text);
  for (const m of masked.matchAll(/(?<![\w$.])useHotkeyAction\s*\(\s*/g)) {
    const id = literalAt(text, masked, m.index + m[0].length);
    if (id !== null && ACTIONS.includes(id)) return true;
  }
  return false;
}

/** The files registering either action, sorted. */
const registrars = (corpus) =>
  [...corpus]
    .filter(([rel, text]) => registersCreate(rel, text))
    .map(([rel]) => rel)
    .sort();

function checkRegistrars(corpus) {
  assert.deepEqual(registrars(corpus), REGISTRARS, "the registrar set moved");
}

/** Whether the masked opening tag [from, end) holds a `{...x}` attribute: a
 *  brace at depth 0, so an object spread inside a value doesn't count. */
function hasSpread(masked, from, end) {
  let depth = 0;
  for (let i = from; i < end; i++) {
    if (masked[i] === "}") depth--;
    else if (masked[i] === "{") {
      if (depth === 0 && /^\{\s*\.\.\./.test(masked.slice(i, end))) return true;
      depth++;
    }
  }
  return false;
}

/** Every AppCreateHotkeys mount in source order, as { from, end, repoPath }:
 *  `repoPath` is the attribute's squashed expression, or null when the tag
 *  holds a spread or not exactly one `repoPath={…}`. */
function mounts(text, masked) {
  return elementRanges(HOST, text, masked, MOUNT).map(([from, end]) => {
    const close = tagEnd(masked, from);
    const attrs = [...masked.slice(from, close).matchAll(/\srepoPath=\{/g)];
    if (attrs.length !== 1 || hasSpread(masked, from, close))
      return { from, end, repoPath: null };
    const open = from + attrs[0].index + attrs[0][0].length - 1;
    const value = squash(masked.slice(open + 1, matchBrace(masked, open)));
    return { from, end, repoPath: value };
  });
}

/** RepositoryView imports AppCreateHotkeys by its own name, once, and mounts
 *  it twice: once on `{null}`, once on `{repoPath}`. */
function checkMounts(text, masked = mask(HOST, text)) {
  const imports = [
    ...masked.matchAll(/(?<![\w$.])import\s*\{([^}]*)\}\s*from\s*(["'])/g),
  ].filter((m) => {
    const open = m.index + m[0].length;
    const specifier = text.slice(open, masked.indexOf(m[2], open));
    return (
      specifier === `./${MOUNT}` && squash(m[1]).split(",").includes(MOUNT)
    );
  });
  assert.equal(
    imports.length,
    1,
    `${HOST} imports ${MOUNT} ${imports.length}x`,
  );
  assert.deepEqual(
    mounts(text, masked)
      .map((m) => m.repoPath)
      .sort(),
    ["null", "repoPath"],
    `${HOST}'s ${MOUNT} mounts`,
  );
}

/** The `{repoPath}` mount starts after the end of every panel mount, and
 *  each panel has one. */
function checkOrder(text, masked = mask(HOST, text)) {
  const live = mounts(text, masked).filter((m) => m.repoPath === "repoPath");
  assert.equal(live.length, 1, `${live.length} {repoPath} mounts`);
  for (const panel of PANELS) {
    const ranges = elementRanges(HOST, text, masked, panel);
    assert.ok(ranges.length > 0, `${HOST} mounts no <${panel}>`);
    for (const [, end] of ranges)
      assert.ok(
        live[0].from >= end,
        `the {repoPath} ${MOUNT} mount starts before a <${panel}> ends`,
      );
  }
}

/** The `{null}` mount is the no-repository guard's return value. */
function checkGuard(text, masked = mask(HOST, text)) {
  const guard = mounts(text, masked).filter((m) => m.repoPath === "null");
  assert.equal(guard.length, 1, `${guard.length} {null} mounts`);
  const lineStart = masked.lastIndexOf("\n", guard[0].from) + 1;
  assert.match(
    masked.slice(lineStart, guard[0].end),
    new RegExp(
      `^\\s*if\\s*\\(\\s*!\\s*repoPath\\s*\\)\\s*return\\s*<${MOUNT}\\b`,
    ),
    `the {null} ${MOUNT} mount is not the no-repository return`,
  );
}

const hostText = () => {
  const text = CORPUS.get(HOST);
  assert.ok(text, `${HOST} is not in the walk`);
  return text;
};

test("the walk reads every source file outside src/test", () => {
  assert.ok(CORPUS.size > 100, `the walk read ${CORPUS.size} files`);
  for (const rel of [...REGISTRARS, HOST])
    assert.ok(CORPUS.has(rel), `${rel} is not in the walk`);
  assert.ok(![...CORPUS.keys()].some((rel) => rel.startsWith("src/test/")));
});

test("only AppCreateHotkeys and the two panels register the create actions", () => {
  checkRegistrars(CORPUS);
});

test("RepositoryView imports AppCreateHotkeys and mounts it on {null} and {repoPath}", () => {
  checkMounts(hostText());
});

test("the {repoPath} mount comes after every ComparePanel and PullRequestsPanel", () => {
  checkOrder(hostText());
});

test("the {null} mount is the no-repository return", () => {
  checkGuard(hostText());
});

// In-memory controls: each mutation fails the check that pins it.
const once = (text, from, to) => {
  assert.equal(text.split(from).length, 2, `expected one ${from}`);
  return text.replace(from, () => to);
};
const LIVE = `<${MOUNT} repoPath={repoPath} />`;
const GUARD = `return <${MOUNT} repoPath={null} />`;

test("control: a fourth registrar fails the closure, a multi-line CRLF call included", () => {
  const extra = loadCorpus([
    [
      "src/features/x/Other.tsx",
      'export function Other() {\r\n  useHotkeyAction(\r\n    "create-local-pr",\r\n    () => undefined,\r\n  );\r\n  return null;\r\n}\r\n',
    ],
  ]);
  assert.throws(
    () => checkRegistrars(new Map([...CORPUS, ...extra])),
    /registrar set moved/,
  );
});

test("control: a commented-out or string-only registration is not counted", () => {
  const rel = "src/features/x/Other.tsx";
  for (const text of [
    '// useHotkeyAction("create-pr", run);\n',
    '/* useHotkeyAction(\n  "create-pr", run); */\n',
    "const s = 'useHotkeyAction(\"create-pr\", run)';\n",
    'useHotkeyAction("create-prs", run);\n',
  ])
    assert.equal(registersCreate(rel, text), false, text);
  assert.equal(
    registersCreate(rel, "useHotkeyAction(`create-pr`, run);\n"),
    true,
  );
});

test("control: deleting the {repoPath} mount with its import fails", () => {
  const text = once(
    once(hostText(), `import { ${MOUNT} } from "./${MOUNT}";\n`, ""),
    LIVE,
    "",
  );
  assert.throws(() => checkMounts(text), /imports AppCreateHotkeys 0x/);
});

test("control: a guard mount on {repoPath} fails", () => {
  const text = once(hostText(), GUARD, `return ${LIVE}`);
  assert.throws(() => checkMounts(text), /AppCreateHotkeys mounts/);
});

test("control: the {repoPath} mount moved above the sidebar fails the order", () => {
  const text = once(once(hostText(), LIVE, ""), "<aside", `${LIVE}\n<aside`);
  assert.throws(() => checkOrder(text), /starts before a <ComparePanel> ends/);
});

test("control: a changed no-repository condition fails the guard pin", () => {
  const text = once(
    hostText(),
    `if (!repoPath) ${GUARD}`,
    `if (!repoTab) ${GUARD}`,
  );
  assert.throws(() => checkGuard(text), /not the no-repository return/);
});

test("control: a JSX spread in either mount's tag fails", () => {
  for (const [from, to] of [
    [LIVE, `<${MOUNT} repoPath={repoPath} {...rest} />`],
    [LIVE, `<${MOUNT} { ...rest } repoPath={repoPath} />`],
    [GUARD, `return <${MOUNT} repoPath={null} {...rest} />`],
  ])
    assert.throws(
      () => checkMounts(once(hostText(), from, to)),
      /AppCreateHotkeys mounts/,
      to,
    );
  const nested = once(
    hostText(),
    LIVE,
    `<${MOUNT} repoPath={repoPath} style={{ ...s }} />`,
  );
  checkMounts(nested);
});
