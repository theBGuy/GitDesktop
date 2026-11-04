// Pins the Changes list's selection following a shown file the panel didn't
// write (the conflict walk's starts and moves): the pure decision in
// src/features/repository/shown-file-follow.ts, and the panel wiring that
// tells its own writes apart and runs the decision only on a shown-file change.
//
// The helper is import-free and loads under Node's type stripping; its mutants
// load from memory under the module's own URL plus a query. The wiring pins scan
// MASKED panel code (comments and string text blanked), so a commented-out line
// never satisfies one. Every pin carries an in-memory mutation control.
//
// Runs in CI's installless `guards` job, so node built-ins ONLY.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { maskNonCode } from "./lib/ts-mask.mjs";

const MODULE_URL = new URL(
  "../src/features/repository/shown-file-follow.ts",
  import.meta.url,
).href;

const mutants = new Map();
const loads = registerHooks({
  load(url, context, next) {
    const source = mutants.get(url);
    if (source === undefined) return next(url, context);
    return { format: "module-typescript", source, shortCircuit: true };
  },
});
after(() => loads.deregister());

const real = await import(MODULE_URL);

/** Imports the module with `from` replaced by `to`, from memory. */
async function importMutated(from, to) {
  const source = readFileSync(new URL(MODULE_URL), "utf8").replace(
    /\r\n/g,
    "\n",
  );
  assert.equal(source.split(from).length, 2, `mutation target: ${from}`);
  const url = `${MODULE_URL}?mutant=${mutants.size}`;
  mutants.set(
    url,
    source.replace(from, () => to),
  );
  return import(url);
}

const VISIBLE = ["staged:a", "unstaged:b", "unstaged:stale.txt"];

// [name, opts, expected]; expected null = the selection is left alone.
const ROWS = [
  [
    "an outside move to a listed file collapses onto its row",
    { prevKey: "unstaged:b", nextKey: "unstaged:stale.txt", panelWrote: false },
    { keys: ["unstaged:stale.txt"], anchor: "unstaged:stale.txt" },
  ],
  [
    "nothing shown before still follows",
    { prevKey: null, nextKey: "unstaged:b", panelWrote: false },
    { keys: ["unstaged:b"], anchor: "unstaged:b" },
  ],
  [
    "the other side of the same path is a move",
    { prevKey: "unstaged:a", nextKey: "staged:a", panelWrote: false },
    { keys: ["staged:a"], anchor: "staged:a" },
  ],
  [
    "the panel's own write sets its selection itself",
    { prevKey: "unstaged:b", nextKey: "staged:a", panelWrote: true },
    null,
  ],
  [
    "a cleared shown file has no row to follow",
    { prevKey: "unstaged:b", nextKey: null, panelWrote: false },
    null,
  ],
  [
    "a write that keeps the shown file keeps a multi-selection",
    { prevKey: "unstaged:b", nextKey: "unstaged:b", panelWrote: false },
    null,
  ],
  [
    "a hidden row is never added: the selection empties",
    { prevKey: "unstaged:b", nextKey: "unstaged:hidden", panelWrote: false },
    { keys: [], anchor: null },
  ],
];

/** Rows `mod` gets wrong (empty = all agree). */
function rowFailures(mod) {
  const failures = [];
  for (const [name, opts, expected] of ROWS) {
    const out = mod.selectionFollowingShownFile({
      ...opts,
      visibleKeys: VISIBLE,
    });
    const got =
      out === null ? null : { keys: [...out.keys], anchor: out.anchor };
    try {
      assert.deepEqual(got, expected);
    } catch {
      failures.push(name);
    }
  }
  return failures;
}

test("selectionFollowingShownFile: every row", () => {
  assert.deepEqual(rowFailures(real), []);
});

test("negative controls: a mutant of each rule fails a row", async () => {
  for (const [from, to] of [
    ["nextKey === null || panelWrote || ", "nextKey === null || "],
    [" || nextKey === prevKey", ""],
    ["if (nextKey === null || ", "if ("],
    [
      "  if (!visibleKeys.includes(nextKey)) return { keys: new Set(), anchor: null };\n",
      "",
    ],
    ["return { keys: new Set(), anchor: null };", "return null;"],
    [
      "return { keys: new Set([nextKey]), anchor: nextKey };",
      "return { keys: new Set([nextKey]), anchor: null };",
    ],
  ]) {
    const mutant = await importMutated(from, to);
    assert.notDeepEqual(rowFailures(mutant), [], `mutant survived: ${to}`);
  }
});

const PANEL = new URL(
  "../src/features/repository/ChangesPanel.tsx",
  import.meta.url,
);
const STORE = new URL("../src/lib/stores/conflict-resolve.ts", import.meta.url);

function read(url) {
  const text = readFileSync(url, "utf8").replace(/\r\n/g, "\n");
  assert.ok(text.trim().length > 0, `${url} is empty`);
  return text;
}

/** Whitespace-insensitive pattern over a literal snippet. */
function loose(snippet, flags = "") {
  const escaped = snippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped.replace(/\s+/g, String.raw`\s*`), flags);
}

/** Failures in the panel's follow wiring (empty = pinned). */
function panelFailures(source) {
  const code = maskNonCode(source, true);
  const failures = [];
  // Every panel write of a file records it, or the follow effect would treat
  // the panel's own click or advance as an outside move.
  const writes = code.match(/\b(?:selectFile|advanceSelectedFile)\(/g) ?? [];
  const noted =
    code.match(
      /\b(?:selectFile|advanceSelectedFile)\(\{[^{}]*\}\);\s*noteOwnShownWrite\(\);/g,
    ) ?? [];
  if (writes.length === 0) failures.push("the panel writes no shown file");
  if (noted.length !== writes.length)
    failures.push("a panel write of the shown file isn't recorded");
  if (
    !loose(
      "function noteOwnShownWrite() { ownShownWrite.current = useUiStore.getState().selectedFile; }",
    ).test(code)
  )
    failures.push("noteOwnShownWrite doesn't record the store's own object");
  if (code.match(/\bownShownWrite\.current = /g)?.length !== 1)
    failures.push("ownShownWrite is written outside noteOwnShownWrite");
  if (
    !loose(
      "useEffect(() => { const prev = shownSeen.current; shownSeen.current = selectedFile; followShownFile(prev, selectedFile); }, [selectedFile]);",
    ).test(code)
  )
    failures.push("the follow effect isn't keyed on the shown file alone");
  if (code.match(/\bshownSeen\.current = /g)?.length !== 1)
    failures.push("shownSeen is written outside the follow effect");
  const event = code.indexOf("const followShownFile = useEffectEvent(");
  if (event === -1) return [...failures, "no followShownFile effect event"];
  const body = code.slice(event, code.indexOf("\n  );\n", event));
  for (const [snippet, message] of [
    ["selectionFollowingShownFile({", "the follow skips the shared decision"],
    [
      "panelWrote: next === ownShownWrite.current,",
      "the panel's own write isn't told apart by identity",
    ],
    ["visibleKeys: navFileKeys,", "the follow doesn't read the listed rows"],
    ["if (follow === null) return;", "the follow writes on a no-op"],
    ["setSelectedKeys(follow.keys);", "the follow doesn't set the selection"],
    ["setAnchorKey(follow.anchor);", "the follow doesn't move the anchor"],
  ])
    if (!loose(snippet).test(body)) failures.push(message);
  return failures;
}

/** Failures in the store's repo guard on its one outside write. */
function storeFailures(source) {
  const code = maskNonCode(source, false);
  const at = code.indexOf("function selectConflicted(");
  if (at === -1) return ["no selectConflicted"];
  const body = code.slice(at, code.indexOf("\n}\n", at));
  return loose("if (scope !== ui.repoPath) return;").test(body)
    ? []
    : ["selectConflicted selects outside the open repo"];
}

const panelSrc = read(PANEL);
const storeSrc = read(STORE);

test("wiring: the panel follows only a shown file it didn't write", () => {
  assert.deepEqual(panelFailures(panelSrc), []);
});

test("wiring: the walk's selection stays inside the open repo", () => {
  assert.deepEqual(storeFailures(storeSrc), []);
});

test("negative controls: each wiring pin names its regression", () => {
  for (const [from, to, message] of [
    [
      "    });\n    noteOwnShownWrite();\n  }",
      "    });\n  }",
      "a panel write of the shown file isn't recorded",
    ],
    [
      "            });\n            noteOwnShownWrite();\n",
      "            });\n",
      "a panel write of the shown file isn't recorded",
    ],
    [
      "ownShownWrite.current = useUiStore.getState().selectedFile;",
      "ownShownWrite.current = selectedFile;",
      "noteOwnShownWrite doesn't record the store's own object",
    ],
    [
      "    setSelectedKeys(new Set([key]));\n    setAnchorKey(key);\n  }\n\n  /** Keeps",
      "    setSelectedKeys(new Set([key]));\n    setAnchorKey(key);\n    ownShownWrite.current = null;\n  }\n\n  /** Keeps",
      "ownShownWrite is written outside noteOwnShownWrite",
    ],
    [
      "followShownFile(prev, selectedFile);\n  }, [selectedFile]);",
      "followShownFile(prev, selectedFile);\n  }, [selectedFile, selectedKeys]);",
      "the follow effect isn't keyed on the shown file alone",
    ],
    [
      "    const prev = shownSeen.current;\n    shownSeen.current = selectedFile;\n",
      "    const prev = shownSeen.current;\n",
      "the follow effect isn't keyed on the shown file alone",
    ],
    [
      "    setSelectedKeys(new Set([key]));\n    setAnchorKey(key);\n  }\n\n  /** Keeps",
      "    setSelectedKeys(new Set([key]));\n    setAnchorKey(key);\n    shownSeen.current = null;\n  }\n\n  /** Keeps",
      "shownSeen is written outside the follow effect",
    ],
    [
      "const followShownFile = useEffectEvent(",
      "const followShownFile = useCallback(",
      "no followShownFile effect event",
    ],
    [
      "const follow = selectionFollowingShownFile({",
      "const follow = decideFollow({",
      "the follow skips the shared decision",
    ],
    [
      "panelWrote: next === ownShownWrite.current,",
      "panelWrote: false,",
      "the panel's own write isn't told apart by identity",
    ],
    [
      "visibleKeys: navFileKeys,",
      "visibleKeys: [...selectedKeys],",
      "the follow doesn't read the listed rows",
    ],
    [
      "      if (follow === null) return;\n",
      "",
      "the follow writes on a no-op",
    ],
    [
      "      setSelectedKeys(follow.keys);\n",
      "",
      "the follow doesn't set the selection",
    ],
    [
      "      setAnchorKey(follow.anchor);\n",
      "",
      "the follow doesn't move the anchor",
    ],
  ]) {
    assert.equal(panelSrc.split(from).length, 2, `mutation anchor: ${from}`);
    const failures = panelFailures(panelSrc.replace(from, () => to));
    assert.ok(
      failures.includes(message),
      `survived or misattributed: ${from} -> ${JSON.stringify(failures)}`,
    );
  }
  let renamed = 0;
  const unwritten = panelSrc.replace(
    /\b(selectFile|advanceSelectedFile)\(/g,
    (_, name) => {
      renamed += 1;
      return `${name}Gone(`;
    },
  );
  assert.equal(renamed, 2, "panel write mutation anchors");
  assert.ok(
    panelFailures(unwritten).includes("the panel writes no shown file"),
    "survived: every panel write of the shown file removed",
  );
  const unguarded = storeSrc.replace(
    "  if (scope !== ui.repoPath) return;\n",
    () => "",
  );
  assert.notEqual(unguarded, storeSrc, "store mutation anchor");
  assert.deepEqual(storeFailures(unguarded), [
    "selectConflicted selects outside the open repo",
  ]);
});
