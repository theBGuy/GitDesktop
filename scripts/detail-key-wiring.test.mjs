// Pins how the detail pane's item key reaches the pull request and issue
// lists: RepositoryView renders `<PullRequestsPanel` with
// `detailKey={detailKeyOf(deferredPr)}` and `<IssuesPanel` with
// `detailKey={detailKeyOf(deferredIssue)}`, once each; both panels forward
// `detailKey={detailKey}` to their one `<ConversationListPanel`; and
// RepositoryView derives `deferredPr` and `deferredIssue` through
// `useDeferredValue`, so the lists key on the selection the panes show rather
// than the live one. RepositoryView can't render under jsdom with its whole
// shell, so the wiring is read from source; what the list does with the key is
// pinned in src/test/list-landing-focus.test.tsx.
//
// Each check fails closed on a file it can't read or a tag it can't find, and
// each has an in-memory mutant that must turn it red with its own message.
// Files are read with CRLF folded to LF and comments stripped, so a Windows
// checkout and the CI's LF checkout give the same verdicts, and a shape left
// only in a comment does not count.
//
// CONTRACT. These are source-shape pins. Green means each pinned attribute
// sits in the named opening tag exactly once as a top-level attribute (text
// inside a `{…}` expression, such as a JSX-valued prop, is not the tag's own),
// no JSX spread follows it in that tag, and each pinned declaration is present
// once, spelled as written. A spread BEFORE the key is harmless (the explicit
// key wins), and a spread's own contents are not evaluated; braces inside
// string or template literals still count toward the depth the tag is read at.
// A quoted attribute value at the tag's own level is skipped when finding the
// tag's end, so `aria-label="a > b"` does not end it early. An unbraced JSX
// attribute value (`remoteNote=<span />`) ends the tag scan early, so
// attributes after it go unseen: the pin parses no TypeScript.
// No component code is run, so they cannot
// see that the panes render from the same deferred values the lists key on
// (RepositoryView's `deferredPr` / `deferredIssue` reads in the pulls and issues
// TabPanels; behavioural, covered by list-landing-focus's replica), a later
// reassignment or shadowing of a pinned name, a tag rendered under a condition,
// or what ConversationListPanel does with the prop. Stripped code still holds
// string literals, so a copy of a pinned shape inside a string counts. An
// equivalent rewrite turns a pin red by design: re-point the pin.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { stripComments } from "./check-banned-patterns.mjs";

const ROOT = new URL("../", import.meta.url);
const VIEW = "src/features/repository/RepositoryView.tsx";
const PANELS = {
  PullRequestsPanel: "src/features/pulls/PullRequestsPanel.tsx",
  IssuesPanel: "src/features/issues/IssuesPanel.tsx",
};

/** What RepositoryView hands each panel, and the deferral it reads from. */
const VIEW_WIRING = {
  PullRequestsPanel: {
    value: "detailKeyOf(deferredPr)",
    deferral: "const deferredPr = useDeferredValue(selectedPr) ?? selectedPr;",
  },
  IssuesPanel: {
    value: "detailKeyOf(deferredIssue)",
    deferral:
      "const deferredIssue = useDeferredValue(selectedIssue) ?? selectedIssue;",
  },
};

function read(rel) {
  const text = readFileSync(new URL(rel, ROOT), "utf8").replace(/\r\n/g, "\n");
  if (text.trim() === "") throw new Error(`${rel} is empty`);
  return text;
}

/** Source with comments removed, so a pinned shape left only in a comment fails. */
const uncommented = (text) => stripComments(text.split("\n")).join("\n");

const count = (text, needle) => text.split(needle).length - 1;

/** The text from `open` (an index of an opening bracket) to its matching close,
 *  or null when the brackets never balance. */
function balanced(text, open) {
  const pairs = { "(": ")", "{": "}" };
  const close = pairs[text[open]];
  if (close === undefined) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === text[open]) depth += 1;
    else if (text[i] === close && --depth === 0) return text.slice(open, i + 1);
  }
  return null;
}

/** Every JSX opening tag of `name`: from `<name` to the first `>` outside
 *  braces and outside a quoted attribute value, or null for a tag that never
 *  closes. Only the tag-end search skips quotes; `depths()` does not. */
function openingTags(text, name) {
  const out = [];
  for (const m of text.matchAll(new RegExp(`<${name}\\b`, "g"))) {
    let depth = 0;
    let end = -1;
    for (let i = m.index; i < text.length; i++) {
      const c = text[i];
      if ((c === '"' || c === "'") && depth === 0) {
        const close = text.indexOf(c, i + 1);
        if (close === -1) break;
        i = close;
      } else if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      else if (c === ">" && depth === 0) {
        end = i;
        break;
      }
    }
    out.push(end === -1 ? null : text.slice(m.index, end + 1));
  }
  return out;
}

/** Brace depth before each UTF-16 unit of `tag`; 0 is the tag's own level.
 *  Indexed by unit, not code point, so regex `index` values line up with it. */
function depths(tag) {
  const out = [];
  let depth = 0;
  for (let i = 0; i < tag.length; i++) {
    out.push(depth);
    if (tag[i] === "{") depth += 1;
    else if (tag[i] === "}") depth -= 1;
  }
  return out;
}

/** The expressions a tag hands `detailKey={…}` as its own attribute, matched
 *  at an attribute boundary (so `data-detailKey` doesn't count). `nested`
 *  counts the ones inside an expression, and `lateSpread` is a top-level
 *  `{...…}` after the first own key, which could override it. */
function detailKeyValues(tag) {
  const at = depths(tag);
  const own = [];
  let nested = 0;
  for (const m of tag.matchAll(/(?<![\w$-])detailKey=\{/g)) {
    if (at[m.index] !== 0) {
      nested += 1;
      continue;
    }
    const value = balanced(tag, m.index + m[0].length - 1);
    own.push({
      index: m.index,
      value: value === null ? null : value.slice(1, -1).trim(),
    });
  }
  const spreads = [...tag.matchAll(/\{\s*\.\.\./g)]
    .filter((m) => at[m.index] === 0)
    .map((m) => m.index);
  return {
    values: own.map((k) => k.value),
    nested,
    lateSpread: own.length > 0 && spreads.some((i) => i > own[0].index),
  };
}

/** The shape error a pinned tag's keys show, or null when they are readable. */
function keyShapeError(keys, where) {
  if (keys.values.length === 0 && keys.nested > 0)
    return `${where} has detailKey only inside a nested expression`;
  if (keys.lateSpread)
    return `${where} spreads attributes after its detailKey, which can override it`;
  return null;
}

/** The one readable opening tag of `name` in `text`, or an error string. */
function oneTag(text, name, where) {
  const tags = openingTags(text, name);
  if (tags.length !== 1 || tags[0] === null)
    return {
      error: `${where}: want one readable <${name} tag, found ${tags.length}`,
    };
  return { tag: tags[0] };
}

/** D1 + D3: RepositoryView hands each panel the deferred selection's key, and
 *  derives that selection through useDeferredValue. */
function checkView(view) {
  const errors = [];
  for (const [panel, { value, deferral }] of Object.entries(VIEW_WIRING)) {
    const { tag, error } = oneTag(view, panel, "RepositoryView");
    if (error) errors.push(error);
    else {
      const keys = detailKeyValues(tag);
      const { values } = keys;
      const shape = keyShapeError(keys, `RepositoryView's <${panel}>`);
      if (shape) errors.push(shape);
      else if (values.length === 0)
        errors.push(`RepositoryView's <${panel}> passes no detailKey`);
      else if (values.length !== 1 || values[0] !== value)
        errors.push(
          `RepositoryView's <${panel}> hands detailKey ${JSON.stringify(values)}, want [${JSON.stringify(value)}]`,
        );
    }
    const decls = count(view, deferral);
    if (decls !== 1)
      errors.push(
        `RepositoryView declares \`${deferral}\` ${decls} times, want 1`,
      );
  }
  return errors;
}

/** D2: each panel forwards its prop to its one ConversationListPanel. */
function checkPanel(name, text) {
  const { tag, error } = oneTag(text, "ConversationListPanel", name);
  if (error) return [error];
  const keys = detailKeyValues(tag);
  const { values } = keys;
  const shape = keyShapeError(keys, `${name}'s <ConversationListPanel>`);
  if (shape) return [shape];
  if (values.length !== 1 || values[0] !== "detailKey")
    return [
      `${name}'s <ConversationListPanel> forwards detailKey ${JSON.stringify(values)}, want ["detailKey"]`,
    ];
  return [];
}

function mutate(text, from, to) {
  assert.equal(count(text, from), 1, `mutant literal not found once: ${from}`);
  return text.replace(from, () => to);
}

const view = uncommented(read(VIEW));
const panels = Object.fromEntries(
  Object.entries(PANELS).map(([name, rel]) => [name, uncommented(read(rel))]),
);

/** Asserts `errors` holds exactly one message, matching `pattern`. */
function redWith(errors, pattern) {
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], pattern);
}

test("D1/D3: RepositoryView hands each list the deferred selection's key", () => {
  assert.deepEqual(checkView(view), []);
  const drop = (v) => mutate(view, `\n                detailKey={${v}}`, "");
  redWith(
    checkView(drop("detailKeyOf(deferredPr)")),
    /<PullRequestsPanel> passes no detailKey/,
  );
  redWith(
    checkView(drop("detailKeyOf(deferredIssue)")),
    /<IssuesPanel> passes no detailKey/,
  );
  redWith(
    checkView(
      mutate(view, "detailKeyOf(deferredPr)", "detailKeyOf(selectedPr)"),
    ),
    /<PullRequestsPanel> hands detailKey \["detailKeyOf\(selectedPr\)"\]/,
  );
  redWith(
    checkView(
      mutate(view, "detailKeyOf(deferredIssue)", "detailKeyOf(selectedIssue)"),
    ),
    /<IssuesPanel> hands detailKey \["detailKeyOf\(selectedIssue\)"\]/,
  );
  redWith(
    checkView(
      mutate(
        view,
        VIEW_WIRING.PullRequestsPanel.deferral,
        "const deferredPr = selectedPr;",
      ),
    ),
    /declares `const deferredPr = useDeferredValue/,
  );
  redWith(
    checkView(
      mutate(
        view,
        VIEW_WIRING.IssuesPanel.deferral,
        "const deferredIssue = selectedIssue;",
      ),
    ),
    /declares `const deferredIssue = useDeferredValue/,
  );
  for (const [panel, { value }] of Object.entries(VIEW_WIRING)) {
    const real = `\n                detailKey={${value}}`;
    redWith(
      checkView(
        mutate(
          view,
          real,
          `\n                note={<KeyBadge detailKey={${value}} />}`,
        ),
      ),
      new RegExp(`<${panel}> has detailKey only inside a nested expression`),
    );
    redWith(
      checkView(
        mutate(
          view,
          real,
          `${real}\n                {...(a ? { detailKey: undefined } : {})}`,
        ),
      ),
      new RegExp(`<${panel}> spreads attributes after its detailKey`),
    );
  }
});

test("D2: each panel forwards detailKey to its ConversationListPanel", () => {
  for (const [name, text] of Object.entries(panels)) {
    assert.deepEqual(checkPanel(name, text), [], name);
    redWith(
      checkPanel(name, mutate(text, "\n        detailKey={detailKey}", "")),
      new RegExp(
        `^${name}'s <ConversationListPanel> forwards detailKey \\[\\]`,
      ),
    );
    const real = "\n        detailKey={detailKey}";
    redWith(
      checkPanel(
        name,
        mutate(
          text,
          real,
          "\n        remoteNote={<KeyBadge detailKey={detailKey} />}",
        ),
      ),
      new RegExp(
        `^${name}'s <ConversationListPanel> has detailKey only inside a nested expression`,
      ),
    );
    redWith(
      checkPanel(
        name,
        mutate(
          text,
          real,
          `${real}\n        {...(remoteCollapsed ? { detailKey: undefined } : {})}`,
        ),
      ),
      new RegExp(
        `^${name}'s <ConversationListPanel> spreads attributes after its detailKey`,
      ),
    );
    // A spread before the key is harmless: the explicit key wins.
    assert.deepEqual(
      checkPanel(name, mutate(text, real, `\n        {...rest}${real}`)),
      [],
      name,
    );
  }
});

test("D2: a non-BMP attribute keeps the depth table aligned", () => {
  const pin = String.fromCodePoint(0x1f4cc);
  const real = "\n        detailKey={detailKey}";
  const text = panels.IssuesPanel;
  redWith(
    checkPanel(
      "IssuesPanel",
      mutate(
        text,
        real,
        `${real}\n        title="${pin}"\n        {...(a ? { detailKey: undefined } : {})}`,
      ),
    ),
    /^IssuesPanel's <ConversationListPanel> spreads attributes after its detailKey/,
  );
  assert.deepEqual(
    checkPanel(
      "IssuesPanel",
      mutate(text, real, `\n        title="${pin}"${real}`),
    ),
    [],
  );
});

test("D2: a quoted `>` in an attribute value does not end the tag", () => {
  const real = "\n        detailKey={detailKey}";
  const label = '\n        aria-label="a > b"';
  const text = panels.IssuesPanel;
  redWith(
    checkPanel(
      "IssuesPanel",
      mutate(
        text,
        real,
        `${real}${label}\n        {...(a ? { detailKey: undefined } : {})}`,
      ),
    ),
    /^IssuesPanel's <ConversationListPanel> spreads attributes after its detailKey/,
  );
  assert.deepEqual(
    checkPanel("IssuesPanel", mutate(text, real, `${label}${real}`)),
    [],
  );
});

test("each check fails closed on a file whose tag it can't find", () => {
  redWith(
    checkPanel("PullRequestsPanel", ""),
    /want one readable <ConversationListPanel tag, found 0/,
  );
  const errors = checkView("");
  assert.equal(errors.length, 4, JSON.stringify(errors));
  assert.match(errors[0], /want one readable <PullRequestsPanel tag, found 0/);
});
