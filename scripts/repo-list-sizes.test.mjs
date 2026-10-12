// Pins the Welcome's reserved repo-column height to the Tailwind classes it
// mirrors. Every token of a mirrored constant is its one sized utility (whose px
// must equal the module's figure) or a listed non-sizing utility; anything else
// fails. Markup outside the six constants (the heading row's flex wrapper, the
// count badge, the vendored Input's own classes) is not modeled here and was
// measured live. The imports rely on Node's type stripping, which resolves no
// bundler aliases: both modules stay import-free apart from each other (same
// form as board-writes.test.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FILTER_INPUT_CLASS,
  FILTER_INPUT_HEIGHT_PX,
  FILTER_ROW_CLASS,
  FILTER_ROW_PADDING_PX,
  LIST_VIEWPORT_CLASS,
  LIST_VIEWPORT_MAX_HEIGHT_PX,
  REPO_LIST_MAX_HEIGHT_PX,
} from "../src/features/repository/repo-list-sizes.ts";
import {
  BOX_BORDER_PX,
  BOX_CLASS,
  COLUMN_CLASS,
  COLUMN_GAP_PX,
  HEADING_CLASS,
  HEADING_ROW_PX,
  RECENT_REPO_LIST_MAX_HEIGHT_CSS,
  RECENT_REPO_LIST_MAX_HEIGHT_PX,
} from "../src/features/welcome/recent-repo-list-sizes.ts";

// Tailwind v4 spacing is 0.25rem per step. The px figures are measured at a 16px
// root, where one step is 4px; the reservation itself scales with the root.
const spacing = (n) => n * 4;

// The sized utility each mirrored constant carries: a plain-integer form only,
// so an arbitrary value or an important modifier is unrecognized.
const SIZES = {
  p: { exact: /^p-(\d+)$/, px: spacing },
  h: { exact: /^h-(\d+)$/, px: spacing },
  "max-h": { exact: /^max-h-(\d+)$/, px: spacing },
  "space-y": { exact: /^space-y-(\d+)$/, px: spacing },
  "text-sm": { exact: /^text-sm$/, px: () => 20 },
  border: { exact: /^border$/, px: () => 1 },
};

// Per constant: its sized utility, the exact variant prefix that utility carries,
// and the exact tokens known not to change the height. A token in neither is a
// decision for whoever adds it.
const MIRRORS = {
  FILTER_ROW_CLASS: {
    value: FILTER_ROW_CLASS,
    kind: "p",
    sizedPrefix: "",
    allowed: ["shrink-0"],
  },
  FILTER_INPUT_CLASS: {
    value: FILTER_INPUT_CLASS,
    kind: "h",
    sizedPrefix: "",
    allowed: [],
  },
  LIST_VIEWPORT_CLASS: {
    value: LIST_VIEWPORT_CLASS,
    kind: "max-h",
    sizedPrefix: "**:data-[slot=scroll-area-viewport]:",
    allowed: ["min-h-0"],
  },
  COLUMN_CLASS: {
    value: COLUMN_CLASS,
    kind: "space-y",
    sizedPrefix: "",
    allowed: ["min-w-0"],
  },
  HEADING_CLASS: {
    value: HEADING_CLASS,
    kind: "text-sm",
    sizedPrefix: "",
    allowed: ["font-heading", "font-medium"],
  },
  BOX_CLASS: {
    value: BOX_CLASS,
    kind: "border",
    sizedPrefix: "",
    allowed: ["overflow-hidden", "rounded-none"],
  },
};

/** The utility a token applies: whatever follows its last `:` outside brackets. */
function utilityOf(token) {
  let depth = 0;
  let cut = 0;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === "[") depth++;
    else if (c === "]") depth--;
    else if (c === ":" && depth === 0) cut = i + 1;
  }
  if (depth !== 0) throw new Error(`unbalanced brackets in ${token}`);
  return token.slice(cut);
}

/**
 * The px size of constant `name`, read from an override class string when one
 * is passed (even `undefined`) and from the live constant otherwise. Throws on a
 * non-string, an unrecognized token, a sized utility under any variant but the
 * entry's `sizedPrefix`, or anything but exactly one sized utility. Allowed
 * tokens match whole, variants included.
 */
function sizeOf(name, ...override) {
  const mirror = MIRRORS[name];
  if (!mirror) throw new Error(`no mirror entry for ${name}`);
  const classString = override.length > 0 ? override[0] : mirror.value;
  const rule = SIZES[mirror.kind];
  if (typeof classString !== "string") {
    throw new Error(`${name} is ${typeof classString}, not a string`);
  }
  const sized = [];
  for (const token of classString.split(/\s+/).filter(Boolean)) {
    const utility = utilityOf(token);
    const m = rule.exact.exec(utility);
    if (m) {
      if (mirror.sizedPrefix && token === utility) {
        throw new Error(
          `${name}: "${token}" is missing its required "${mirror.sizedPrefix}" prefix`,
        );
      }
      if (token !== mirror.sizedPrefix + utility) {
        throw new Error(
          `${name}: "${token}" is a variant of the sized utility — the reservation has one figure for every width`,
        );
      }
      sized.push({ token, n: m[1] });
    } else if (!mirror.allowed.includes(token)) {
      throw new Error(
        `${name}: unrecognized utility "${token}" — decide whether it changes the height, then list it here or update the figure`,
      );
    }
  }
  if (sized.length === 0) {
    throw new Error(`${name}: ${mirror.kind} missing in "${classString}"`);
  }
  if (sized.length > 1) {
    throw new Error(
      `${name}: ${sized.length} sized utilities (${sized.map((x) => x.token).join(", ")})`,
    );
  }
  const { n } = sized[0];
  return rule.px(n === undefined ? undefined : Number(n));
}

const UNRECOGNIZED = /unrecognized utility/;
const VARIANT = /is a variant of the sized utility/;

test("RepoList's filter row padding mirrors its p- class", () => {
  assert.equal(sizeOf("FILTER_ROW_CLASS"), FILTER_ROW_PADDING_PX);
});

test("RepoList's filter input height mirrors its h- class", () => {
  assert.equal(sizeOf("FILTER_INPUT_CLASS"), FILTER_INPUT_HEIGHT_PX);
});

test("RepoList's viewport cap mirrors its variant max-h- class", () => {
  assert.equal(sizeOf("LIST_VIEWPORT_CLASS"), LIST_VIEWPORT_MAX_HEIGHT_PX);
});

test("REPO_LIST_MAX_HEIGHT_PX is 2 x padding + input + viewport cap", () => {
  const derived =
    2 * sizeOf("FILTER_ROW_CLASS") +
    sizeOf("FILTER_INPUT_CLASS") +
    sizeOf("LIST_VIEWPORT_CLASS");
  assert.equal(REPO_LIST_MAX_HEIGHT_PX, derived);
  assert.equal(REPO_LIST_MAX_HEIGHT_PX, 428);
});

test("the Welcome column's heading gap mirrors its space-y- class", () => {
  assert.equal(sizeOf("COLUMN_CLASS"), COLUMN_GAP_PX);
});

test("the Welcome heading row mirrors its text-sm line box", () => {
  assert.equal(sizeOf("HEADING_CLASS"), HEADING_ROW_PX);
});

test("the Welcome box border mirrors its border class", () => {
  assert.equal(sizeOf("BOX_CLASS"), BOX_BORDER_PX);
});

test("RECENT_REPO_LIST_MAX_HEIGHT_PX is heading + gap + 2 x border + RepoList", () => {
  const derived =
    sizeOf("HEADING_CLASS") +
    sizeOf("COLUMN_CLASS") +
    2 * sizeOf("BOX_CLASS") +
    REPO_LIST_MAX_HEIGHT_PX;
  assert.equal(RECENT_REPO_LIST_MAX_HEIGHT_PX, derived);
  assert.equal(RECENT_REPO_LIST_MAX_HEIGHT_PX, 458);
});

// The rem part times 16 plus the px part rebuilds the 16px-root figure; any other
// string shape fails the match.
const RESERVE_CSS = /^calc\((\d+(?:\.\d+)?)rem \+ (\d+)px\)$/;

test("RECENT_REPO_LIST_MAX_HEIGHT_CSS is the px maximum as rem plus border px", () => {
  assert.equal(RECENT_REPO_LIST_MAX_HEIGHT_CSS, "calc(28.5rem + 2px)");
  const m = RESERVE_CSS.exec(RECENT_REPO_LIST_MAX_HEIGHT_CSS);
  assert.ok(m, `unparseable reservation: ${RECENT_REPO_LIST_MAX_HEIGHT_CSS}`);
  assert.equal(
    Number(m[1]) * 16 + Number(m[2]),
    RECENT_REPO_LIST_MAX_HEIGHT_PX,
  );
  assert.equal(Number(m[2]), 2 * BOX_BORDER_PX);
});

test("negative control: the reservation parser rejects other shapes", () => {
  for (const shape of [
    "458px",
    "calc(28.5rem)",
    "calc(2px + 28.5rem)",
    "calc(28.5rem + 2px) ",
    "calc(28.5rem - 2px)",
    "calc(28.5em + 2px)",
  ]) {
    assert.equal(RESERVE_CSS.exec(shape), null, shape);
  }
});

test("positive control: reordered tokens still pass", () => {
  for (const name of Object.keys(MIRRORS)) {
    const reordered = MIRRORS[name].value.split(/\s+/).reverse().join(" ");
    assert.equal(sizeOf(name, reordered), sizeOf(name));
  }
  assert.equal(sizeOf("HEADING_CLASS", "font-medium text-sm font-heading"), 20);
});

test("negative control: h-7 mutated to h-8 disagrees with the figure", () => {
  const mutated = FILTER_INPUT_CLASS.replace("h-7", "h-8");
  assert.notEqual(mutated, FILTER_INPUT_CLASS);
  assert.notEqual(
    sizeOf("FILTER_INPUT_CLASS", mutated),
    FILTER_INPUT_HEIGHT_PX,
  );
});

test("negative control: max-h-96 mutated to max-h-[400px] fails closed", () => {
  const mutated = LIST_VIEWPORT_CLASS.replace("max-h-96", "max-h-[400px]");
  assert.notEqual(mutated, LIST_VIEWPORT_CLASS);
  assert.throws(() => sizeOf("LIST_VIEWPORT_CLASS", mutated), UNRECOGNIZED);
});

for (const [name, token, expected] of [
  [
    "HEADING_CLASS",
    "leading-6",
    /HEADING_CLASS: unrecognized utility "leading-6"/,
  ],
  [
    "FILTER_INPUT_CLASS",
    "min-h-8",
    /FILTER_INPUT_CLASS: unrecognized utility "min-h-8"/,
  ],
  ["FILTER_ROW_CLASS", "my-1", /FILTER_ROW_CLASS: unrecognized utility "my-1"/],
  ["HEADING_CLASS", "pt-1", /HEADING_CLASS: unrecognized utility "pt-1"/],
  [
    "FILTER_INPUT_CLASS",
    "md:h-9",
    /FILTER_INPUT_CLASS: "md:h-9" is a variant of the sized utility/,
  ],
]) {
  test(`negative control: ${token} added to ${name} fails closed`, () => {
    assert.throws(
      () => sizeOf(name, `${MIRRORS[name].value} ${token}`),
      expected,
    );
  });
}

test("negative control: md:p-4 replacing p-2 in FILTER_ROW_CLASS fails closed", () => {
  const mutated = FILTER_ROW_CLASS.replace("p-2", "md:p-4");
  assert.notEqual(mutated, FILTER_ROW_CLASS);
  assert.throws(
    () => sizeOf("FILTER_ROW_CLASS", mutated),
    /FILTER_ROW_CLASS: "md:p-4" is a variant of the sized utility/,
  );
});

test("negative control: LIST_VIEWPORT_CLASS under another bracket prefix fails closed", () => {
  assert.throws(
    () => sizeOf("LIST_VIEWPORT_CLASS", "min-h-0 **:data-[slot=a:b]:max-h-96"),
    /LIST_VIEWPORT_CLASS: "\*\*:data-\[slot=a:b\]:max-h-96" is a variant/,
  );
  assert.throws(
    () => sizeOf("LIST_VIEWPORT_CLASS", "min-h-0 max-h-96"),
    /LIST_VIEWPORT_CLASS: "max-h-96" is missing its required "\*\*:data-\[slot=scroll-area-viewport\]:" prefix/,
  );
});

test("negative control: a missing sized utility fails closed", () => {
  assert.throws(() => sizeOf("FILTER_ROW_CLASS", "shrink-0"), /p missing/);
  assert.throws(() => sizeOf("BOX_CLASS", ""), /border missing/);
  assert.throws(() => sizeOf("FILTER_INPUT_CLASS", undefined), /not a string/);
  assert.throws(() => sizeOf("FILTER_INPUT_CLASS", 28), /not a string/);
  assert.throws(() => sizeOf("NOT_A_CONSTANT"), /no mirror entry/);
});

test("negative control: a repeated or competing utility fails closed", () => {
  assert.throws(
    () => sizeOf("FILTER_ROW_CLASS", "p-2 p-2"),
    /FILTER_ROW_CLASS: 2 sized utilities \(p-2, p-2\)$/,
  );
  assert.throws(() => sizeOf("FILTER_ROW_CLASS", "p-2 py-3"), UNRECOGNIZED);
  assert.throws(() => sizeOf("FILTER_INPUT_CLASS", "h-7 md:h-9"), VARIANT);
  assert.throws(() => sizeOf("HEADING_CLASS", "text-sm text-xs"), UNRECOGNIZED);
  assert.throws(() => sizeOf("BOX_CLASS", "border border-2"), UNRECOGNIZED);
});

test("negative control: unsized values and modifiers fail closed", () => {
  assert.throws(() => sizeOf("FILTER_INPUT_CLASS", "h-[30px]"), UNRECOGNIZED);
  assert.throws(() => sizeOf("FILTER_INPUT_CLASS", "h-7!"), UNRECOGNIZED);
  assert.throws(
    () => sizeOf("FILTER_ROW_CLASS", "p-2 !shrink-0"),
    UNRECOGNIZED,
  );
  assert.throws(
    () => sizeOf("FILTER_ROW_CLASS", "p-2 md:shrink-0"),
    UNRECOGNIZED,
  );
  assert.throws(() => sizeOf("HEADING_CLASS", "text-sm/6"), UNRECOGNIZED);
  assert.throws(() => sizeOf("BOX_CLASS", "border-2"), UNRECOGNIZED);
  assert.throws(
    () => sizeOf("LIST_VIEWPORT_CLASS", "max-h-[a:b"),
    /unbalanced/,
  );
});

test("a colon inside a variant's brackets is not the utility boundary", () => {
  assert.equal(utilityOf("**:data-[slot=a:b]:max-h-96"), "max-h-96");
  assert.throws(
    () => sizeOf("LIST_VIEWPORT_CLASS", "**:data-[slot=a:b]:max-h-96"),
    VARIANT,
  );
  assert.equal(sizeOf("LIST_VIEWPORT_CLASS"), 384);
});
