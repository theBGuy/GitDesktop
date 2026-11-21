// Pins the app-level create entries and the repository switcher's tier. Two
// groups of actions have an app-level registrar beside the panels that own
// them: AppCreateHotkeys (`create-pr`, `create-local-pr`; the Compare and Pull
// requests panels) and RepositoryView (`create-issue`, `create-jira-issue`;
// the Issues panel). Dispatch runs the highest tier among enabled entries, so
// every app-level registration of those ids carries `tier: "fallback"` and no
// panel registration carries a tier: a panel's enabled entry then takes the
// action whatever the registration order. RepoList's two registrations carry
// `tier: "popup"`, so the open switcher keeps its chords over any surface
// entry that re-registers. A closure over every .ts/.tsx under src/ (src/test/
// excluded), counting `useHotkeyAction("<id>"` calls and `<HotkeyAction
// id="<id>"` elements, keeps a new registrar from joining without its own tier
// decision. RepositoryView mounts AppCreateHotkeys twice: on `{null}` as the
// no-repository return, and on `{repoPath}` outside every TabPanel and
// Activity element, whose hidden state tears its effects down and would drop
// both entries on other tabs. A source scan, since nothing mounts
// RepositoryView in jsdom. Scans run on `maskNonCode`'s output, so comments and
// string text never count; literals are read from the raw text at the masked
// offsets. Every lookup that finds nothing fails, a `tier` that is not a plain
// string literal fails, and a JSX spread in a mount's tag fails it. Not
// covered: a registration whose id is not a string literal, an aliased import
// of useHotkeyAction or HotkeyAction, and options passed through a variable.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  elementRanges,
  hasSpread,
  loadCorpus,
  maskNonCode,
  matchBrace,
  srcEntries,
  tagEnd,
} from "./lib/ts-mask.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOST = "src/features/repository/RepositoryView.tsx";
const MOUNT = "AppCreateHotkeys";
const APP_CREATE = "src/features/repository/AppCreateHotkeys.tsx";
const REPO_LIST = "src/features/repository/RepoList.tsx";

// Each group: its ids, every file registering one of them, and the one
// app-level registrar whose registrations are fallbacks.
const GROUPS = [
  {
    ids: ["create-pr", "create-local-pr"],
    registrars: [
      "src/features/compare/ComparePanel.tsx",
      "src/features/pulls/PullRequestsPanel.tsx",
      APP_CREATE,
    ],
    fallback: APP_CREATE,
  },
  {
    ids: ["create-issue", "create-jira-issue"],
    registrars: ["src/features/issues/IssuesPanel.tsx", HOST],
    fallback: HOST,
  },
];

// Files whose registrations of the listed ids all carry one tier.
const TIER_PINS = [
  { rel: REPO_LIST, ids: ["show-repositories", "focus-filter"], tier: "popup" },
];

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

/** The tier a [from, to) range names: null when it names none, the literal
 *  when exactly one `tier: "x"` (a call's options) or `tier="x"` (a JSX
 *  attribute) appears, and a throw when a tier is not a plain literal. */
function tierIn(rel, text, masked, from, to) {
  const hits = [
    ...masked.slice(from, to).matchAll(/(?<![\w$.])tier\s*[:=]\s*/g),
  ];
  if (hits.length === 0) return null;
  const values = hits.map((m) =>
    literalAt(text, masked, from + m.index + m[0].length),
  );
  if (values.length !== 1 || values[0] === null)
    throw new Error(`${rel}: a tier this scan cannot read`);
  return values[0];
}

/** Every registration in `text` whose id is a literal, as { id, tier }:
 *  `useHotkeyAction(` calls (the id may sit on a later line) and
 *  `<HotkeyAction>` elements carrying an `id="…"` attribute. */
function registrations(rel, text) {
  if (!text.includes("HotkeyAction")) return [];
  const masked = mask(rel, text);
  const out = [];
  for (const m of masked.matchAll(/(?<![\w$.])useHotkeyAction\s*\(\s*/g)) {
    const id = literalAt(text, masked, m.index + m[0].length);
    if (id === null) continue;
    const open = masked.indexOf("(", m.index);
    const close = matchBrace(masked, open);
    assert.ok(close > open, `${rel}: a useHotkeyAction call never closes`);
    out.push({ id, tier: tierIn(rel, text, masked, open, close) });
  }
  for (const m of masked.matchAll(/<HotkeyAction\b/g)) {
    const end = tagEnd(masked, m.index);
    assert.ok(end > m.index, `${rel}: a <HotkeyAction> tag never ends`);
    const attr = /\sid=/.exec(masked.slice(m.index, end));
    if (attr === null) continue;
    const id = literalAt(text, masked, m.index + attr.index + attr[0].length);
    if (id === null) continue;
    out.push({ id, tier: tierIn(rel, text, masked, m.index, end) });
  }
  return out;
}

/** The files registering any of `ids`, sorted. */
const registrars = (corpus, ids) =>
  [...corpus]
    .filter(([rel, text]) =>
      registrations(rel, text).some((r) => ids.includes(r.id)),
    )
    .map(([rel]) => rel)
    .sort();

function checkRegistrars(corpus) {
  for (const { ids, registrars: expected } of GROUPS)
    assert.deepEqual(
      registrars(corpus, ids),
      [...expected].sort(),
      `the registrar set of ${ids.join(", ")} moved`,
    );
}

/** The app-level registrar registers every id of its group as a fallback;
 *  no other registrar of a group id carries a tier. */
function checkTiers(corpus) {
  for (const { ids, registrars: files, fallback } of GROUPS)
    for (const rel of files) {
      const text = corpus.get(rel);
      assert.ok(text, `${rel} is not in the walk`);
      const own = registrations(rel, text).filter((r) => ids.includes(r.id));
      if (rel === fallback)
        assert.deepEqual(
          own.map((r) => r.id).sort(),
          [...ids].sort(),
          `${rel} does not register ${ids.join(", ")} once each`,
        );
      const want = rel === fallback ? "fallback" : null;
      for (const r of own)
        assert.equal(r.tier, want, `${rel}'s ${r.id} registration tier`);
    }
}

/** Each pinned file registers each listed id once, under its tier. */
function checkTierPins(corpus) {
  for (const { rel, ids, tier } of TIER_PINS) {
    const text = corpus.get(rel);
    assert.ok(text, `${rel} is not in the walk`);
    const own = registrations(rel, text).filter((r) => ids.includes(r.id));
    assert.deepEqual(
      own.map((r) => r.id).sort(),
      [...ids].sort(),
      `${rel} does not register ${ids.join(", ")} once each`,
    );
    for (const r of own)
      assert.equal(r.tier, tier, `${rel}'s ${r.id} registration tier`);
  }
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

/** No TabPanel or Activity element contains the `{repoPath}` mount, and the
 *  host holds at least one TabPanel. */
function checkOutsideTabs(text, masked = mask(HOST, text)) {
  const live = mounts(text, masked).filter((m) => m.repoPath === "repoPath");
  assert.equal(live.length, 1, `${live.length} {repoPath} mounts`);
  const panels = elementRanges(HOST, text, masked, "TabPanel");
  assert.ok(panels.length > 0, `${HOST} mounts no <TabPanel>`);
  for (const name of ["TabPanel", "Activity"])
    for (const [start, end] of elementRanges(HOST, text, masked, name))
      assert.ok(
        live[0].end <= start || live[0].from >= end,
        `the {repoPath} ${MOUNT} mount sits inside a <${name}>`,
      );
}

const fileText = (rel) => {
  const text = CORPUS.get(rel);
  assert.ok(text, `${rel} is not in the walk`);
  return text;
};
const hostText = () => fileText(HOST);

test("the walk reads every source file outside src/test", () => {
  assert.ok(CORPUS.size > 100, `the walk read ${CORPUS.size} files`);
  for (const rel of [
    ...GROUPS.flatMap((g) => g.registrars),
    ...TIER_PINS.map((p) => p.rel),
  ])
    assert.ok(CORPUS.has(rel), `${rel} is not in the walk`);
  assert.ok(![...CORPUS.keys()].some((rel) => rel.startsWith("src/test/")));
});

test("only the listed files register the create actions", () => {
  checkRegistrars(CORPUS);
});

test("the app-level create registrations are fallbacks and the panels' carry no tier", () => {
  checkTiers(CORPUS);
});

test("RepoList's two registrations carry the popup tier", () => {
  checkTierPins(CORPUS);
});

test("RepositoryView imports AppCreateHotkeys and mounts it on {null} and {repoPath}", () => {
  checkMounts(hostText());
});

test("the {null} mount is the no-repository return", () => {
  checkGuard(hostText());
});

test("the {repoPath} mount sits outside every TabPanel and Activity", () => {
  checkOutsideTabs(hostText());
});

// In-memory controls: each mutation fails the check that pins it.
const once = (text, from, to) => {
  assert.equal(text.split(from).length, 2, `expected one ${from}`);
  return text.replace(from, () => to);
};
/** `rel`'s text with one regex match replaced; the regex must match once. */
const onceRe = (rel, re, to) => {
  const text = fileText(rel);
  assert.equal([...text.matchAll(new RegExp(re, "g"))].length, 1, String(re));
  return text.replace(re, typeof to === "function" ? to : () => to);
};
const withFile = (rel, text) => new Map([...CORPUS, [rel, text]]);
const LIVE = `<${MOUNT} repoPath={repoPath} />`;
const GUARD = `return <${MOUNT} repoPath={null} />`;

test("control: a new registrar fails the closure, a multi-line CRLF call and a JSX element included", () => {
  for (const [id, body] of [
    [
      "create-local-pr",
      '  useHotkeyAction(\r\n    "create-local-pr",\r\n    () => undefined,\r\n  );\r\n  return null;\r\n',
    ],
    ["create-pr", '  return <HotkeyAction id="create-pr" run={run} />;\n'],
    [
      "create-jira-issue",
      "  return <HotkeyAction run={run} id='create-jira-issue' />;\n",
    ],
  ]) {
    const extra = loadCorpus([
      ["src/features/x/Other.tsx", `export function Other() {\n${body}}\n`],
    ]);
    assert.throws(
      () => checkRegistrars(new Map([...CORPUS, ...extra])),
      /registrar set of .* moved/,
      id,
    );
  }
});

test("control: a commented-out or string-only registration is not counted", () => {
  const rel = "src/features/x/Other.tsx";
  for (const text of [
    '// useHotkeyAction("create-pr", run);\n',
    '/* useHotkeyAction(\n  "create-pr", run); */\n',
    "const s = 'useHotkeyAction(\"create-pr\", run)';\n",
    'useHotkeyAction("create-prs", run);\n',
    '{/* <HotkeyAction id="create-pr" run={run} /> */}\n',
  ])
    assert.deepEqual(
      registrars(new Map([[rel, text]]), ["create-pr"]),
      [],
      text,
    );
  assert.deepEqual(registrations(rel, "useHotkeyAction(`create-pr`, run);\n"), [
    { id: "create-pr", tier: null },
  ]);
});

test("control: stripping the fallback tier from one app-level call fails", () => {
  const app = onceRe(
    APP_CREATE,
    /,\s*true,\s*\{\s*tier:\s*"fallback",?\s*\}/,
    "",
  );
  assert.throws(
    () => checkTiers(withFile(APP_CREATE, app)),
    /AppCreateHotkeys\.tsx's create-local-pr registration tier/,
  );
  const host = onceRe(
    HOST,
    /,\s*\{\s*tier:\s*"fallback"\s*\},?(\s*\);\s*useHotkeyAction\(\s*"create-discussion")/,
    (_, tail) => tail,
  );
  assert.throws(
    () => checkTiers(withFile(HOST, host)),
    /RepositoryView\.tsx's create-jira-issue registration tier/,
  );
});

test("control: a tier on a panel's call fails, and an unreadable tier throws", () => {
  const rel = "src/features/pulls/PullRequestsPanel.tsx";
  const tiered = once(
    fileText(rel),
    'useHotkeyAction("create-local-pr", () => openLocalPrCreate());',
    'useHotkeyAction("create-local-pr", () => openLocalPrCreate(), true, { tier: "fallback" });',
  );
  assert.throws(
    () => checkTiers(withFile(rel, tiered)),
    /PullRequestsPanel\.tsx's create-local-pr registration tier/,
  );
  const unreadable = once(
    fileText(rel),
    'useHotkeyAction("create-local-pr", () => openLocalPrCreate());',
    'useHotkeyAction("create-local-pr", () => openLocalPrCreate(), true, { tier: TIER });',
  );
  assert.throws(
    () => checkTiers(withFile(rel, unreadable)),
    /a tier this scan cannot read/,
  );
});

test("control: dropping the popup tier from RepoList's focus-filter fails", () => {
  const text = onceRe(
    REPO_LIST,
    /,\s*true,\s*\{\s*tier:\s*"popup",?\s*\}(\s*\);\s*\r?\n\s*\r?\n\s*const ownerByPath)/,
    (_, tail) => tail,
  );
  assert.throws(
    () => checkTierPins(withFile(REPO_LIST, text)),
    /RepoList\.tsx's focus-filter registration tier/,
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

test("control: a {repoPath} mount inside the first TabPanel fails, the live text passes", () => {
  checkOutsideTabs(hostText());
  const removed = once(hostText(), LIVE, "");
  const masked = mask(HOST, removed);
  const [[start]] = elementRanges(HOST, removed, masked, "TabPanel");
  const at = tagEnd(masked, start) + 1;
  const text = `${removed.slice(0, at)}\n${LIVE}${removed.slice(at)}`;
  checkMounts(text);
  assert.throws(() => checkOutsideTabs(text), /mount sits inside a <TabPanel>/);
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
