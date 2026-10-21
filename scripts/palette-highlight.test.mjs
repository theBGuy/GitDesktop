// Pins the cursor math every raw-index picker shares
// (src/features/shortcuts/palette-highlight.ts): one clamped index, -1 on an
// empty list, arrow steps from the CLAMPED cursor, and empty-list arrows that
// leave the stored value alone. Also pins, by source shape, that each picker in
// CALL_SITES reads that one clamped index for the marker, Enter and the scroll
// effect, and that each arrow arm steps the stored value via the helper.
//
// Not testable here: the live render and dispatch (which row the user sees marked,
// what Enter runs, scroll-into-view). Those need the running app; the shape pins
// cover the wiring's text, not its runtime.
//
// The import reaches straight into `src/` under Node's type stripping, which
// resolves no bundler aliases, so the module must stay free of runtime imports.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  clampHighlight,
  stepHighlight,
} from "../src/features/shortcuts/palette-highlight.ts";
import { escapeRe, maskNonCode } from "./lib/ts-mask.mjs";

test("clampHighlight: an empty list has no cursor", () => {
  assert.equal(clampHighlight(0, 0), -1);
  assert.equal(clampHighlight(5, 0), -1);
  assert.equal(clampHighlight(-1, 0), -1);
});

test("clampHighlight: in-range values pass through", () => {
  assert.equal(clampHighlight(0, 1), 0);
  assert.equal(clampHighlight(2, 5), 2);
  assert.equal(clampHighlight(4, 5), 4);
  assert.equal(clampHighlight(1, 2), 1);
});

test("clampHighlight: over-range clamps to the last row", () => {
  assert.equal(clampHighlight(8, 5), 4);
  assert.equal(clampHighlight(5, 5), 4);
  assert.equal(clampHighlight(3, 1), 0);
  assert.equal(clampHighlight(2, 2), 1);
});

test("clampHighlight: a negative stored value floors at row 0", () => {
  assert.equal(clampHighlight(-1, 3), 0);
  assert.equal(clampHighlight(-1, 1), 0);
});

test("stepHighlight: an empty list leaves the stored value unchanged", () => {
  assert.equal(stepHighlight(0, 0, 1), 0);
  assert.equal(stepHighlight(5, 0, -1), 5);
  assert.equal(stepHighlight(5, 0, 1), 5);
  assert.equal(stepHighlight(0, 0, -1), 0);
});

test("stepHighlight: steps clamp at both ends", () => {
  assert.equal(stepHighlight(4, 5, 1), 4);
  assert.equal(stepHighlight(0, 5, -1), 0);
  assert.equal(stepHighlight(0, 1, 1), 0);
  assert.equal(stepHighlight(0, 1, -1), 0);
});

test("stepHighlight: in-range steps move one row", () => {
  assert.equal(stepHighlight(2, 5, 1), 3);
  assert.equal(stepHighlight(2, 5, -1), 1);
  assert.equal(stepHighlight(0, 2, 1), 1);
});

test("stepHighlight: steps from the clamped cursor, not the stored value", () => {
  assert.equal(stepHighlight(8, 5, 1), 4);
  assert.equal(stepHighlight(8, 5, -1), 3);
  assert.equal(stepHighlight(-1, 3, 1), 1);
  assert.equal(stepHighlight(-1, 3, -1), 0);
});

test("stepHighlight: every non-empty result lands in [0, count-1]", () => {
  for (const count of [1, 2, 5]) {
    for (const stored of [-1, 0, 2, count - 1, count, count + 3]) {
      for (const delta of [1, -1]) {
        const next = stepHighlight(stored, count, delta);
        assert.ok(
          next >= 0 && next <= count - 1,
          `stepHighlight(${stored}, ${count}, ${delta}) = ${next}`,
        );
      }
    }
  }
});

// The uniform palette-shaped pickers (the rest sit in SITE_PINS below); every
// source-shape pin runs per file, so a failure names the picker that broke.
const CALL_SITES = [
  "src/features/shortcuts/CommandPalette.tsx",
  "src/features/scripts/RunTaskPicker.tsx",
];

// Comments are stripped first so a comment can neither satisfy a positive pin nor
// trip a negative one. Neither call site carries `//` inside a string literal.
const readStripped = (rel) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

function countMatches(source, re) {
  return (source.match(new RegExp(re.source, "g")) ?? []).length;
}

for (const file of CALL_SITES) {
  const source = readStripped(file);

  test(`${file}: no raw comparison against the stored index`, () => {
    assert.doesNotMatch(source, /[!=]==?\s*highlight\b|\bhighlight\s*[!=]==?/);
  });

  test(`${file}: no inline clamp at the Enter target`, () => {
    assert.doesNotMatch(source, /items\[\s*Math\.min\(/);
  });

  test(`${file}: marker and Enter read the one clamped index`, () => {
    assert.match(
      source,
      /const\s+active\s*=\s*clampHighlight\(\s*highlight\s*,\s*items\.length\s*\)/,
    );
    assert.match(source, /items\[\s*active\s*\]/);
    assert.ok(
      countMatches(source, /index\s*===\s*active/) >= 2,
      "both the data-highlighted attr and the accent class compare against active",
    );
  });

  test(`${file}: the scroll effect is keyed on the clamped index`, () => {
    assert.match(source, /\},\s*\[\s*active\s*\]\s*\);/);
  });

  test(`${file}: each arrow arm steps the stored index`, () => {
    const down = /stepHighlight\(\s*highlight\s*,\s*items\.length\s*,\s*1\s*\)/;
    const up = /stepHighlight\(\s*highlight\s*,\s*items\.length\s*,\s*-1\s*\)/;
    assert.equal(countMatches(source, down), 1, "ArrowDown steps +1");
    assert.equal(countMatches(source, up), 1, "ArrowUp steps -1");
    assert.equal(
      countMatches(source, /stepHighlight\(/),
      2,
      "no other step call",
    );
  });
}

// Pickers the uniform pins above can't read (a composite option count, a -1
// "no cursor" sentinel, wrap stepping, two cursors in one file) are pinned per
// site. Those reads mask comments and string text (maskNonCode), so a pinned
// token there can neither satisfy nor trip a pin; the two aria-id pins read the
// raw source, since masking also blanks a template's static text.
const readRaw = (rel) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const mask = (src) => maskNonCode(src, true);
const countLiteral = (source, needle) => source.split(needle).length - 1;

/** `code` as a regex that tolerates any formatting: whitespace must separate two
 *  words and may surround punctuation, and `\s` spans newlines, so the
 *  biome-wrapped form of a long expression still matches. An identifier at
 *  either end is word-bounded, so a longer name can't satisfy it. */
function flexRe(code) {
  const tokens = code.match(/\w+|\S/g);
  let out = escapeRe(tokens[0]);
  for (let i = 1; i < tokens.length; i++) {
    const words = /\w$/.test(tokens[i - 1]) && /^\w/.test(tokens[i]);
    out += (words ? String.raw`\s+` : String.raw`\s*`) + escapeRe(tokens[i]);
  }
  const lead = /^\w/.test(code) ? String.raw`(?<!\w)` : "";
  const trail = /\w$/.test(code) ? String.raw`(?!\w)` : "";
  return new RegExp(lead + out + trail);
}

test("flexRe matches an expression wrapped across indented lines", () => {
  const re = flexRe("!q && highlight < 0 ? -1 : clampHighlight(highlight, n)");
  assert.match(
    "const a =\r\n    !q && highlight < 0\n      ? -1\n      : clampHighlight(highlight, n);",
    re,
  );
  assert.doesNotMatch(
    "!q && highlight < 0 ? -1 : clampHighlight(highlightX, n)",
    re,
  );
  assert.doesNotMatch(
    "!qq && highlight < 0 ? -1 : clampHighlight(highlight, n)",
    re,
  );
  const ident = flexRe("visible.length");
  assert.match("f(visible.length)", ident);
  assert.doesNotMatch("visible.lengthy", ident);
  assert.doesNotMatch("invisible.length", ident);
});

const has = (re) => (source) => assert.match(source, re);
// Negative and count pins are tagged so the green controls can prove a planted
// token reaches each of them.
const hasNot = (re) =>
  Object.assign((source) => assert.doesNotMatch(source, re), {
    negative: true,
  });
const twoSteps = Object.assign(
  (source) =>
    assert.equal(
      countMatches(source, /stepHighlight\s*\(/),
      2,
      "exactly the two arrow steps",
    ),
  { negative: true },
);

const ADD_REVIEWER_STATE = "const [activeIndex, setActiveIndex] = useState";

/** The Bitbucket section's AddReviewerPopover (the file's last function), so its
 *  pins never read the rows list's same-named `activeIndex`. */
function addReviewerSlice(masked) {
  const start = masked.indexOf("function AddReviewerPopover");
  assert.ok(start >= 0, "AddReviewerPopover not found");
  const slice = masked.slice(start);
  assert.equal(
    countLiteral(slice, ADD_REVIEWER_STATE),
    1,
    "the slice holds the popover's own cursor state only",
  );
  return slice;
}

// Pins shared by the two popovers, which store `activeIndex` over a count.
// `ariaId` is the popover's aria-activedescendant template, as written.
const popoverPins = (enterPin, enterMutant, ariaId) => [
  {
    name: "the cursor is the one clamped index",
    check: has(
      flexRe("const active = clampHighlight(activeIndex, optionCount);"),
    ),
    mutant: [
      "const active = clampHighlight(activeIndex, optionCount);",
      "const active = optionCount > 0 ? Math.min(activeIndex, optionCount - 1) : 0;",
    ],
    extraMutants: [
      [
        "const active = clampHighlight(activeIndex, optionCount);",
        "const active = activeIndex; void clampHighlight(activeIndex, optionCount);",
      ],
    ],
  },
  {
    name: "no aria id from the stored value",
    check: hasNot(/\$\{\s*activeIndex\s*\}/),
    mutant: [ariaId, ariaId.replace("${active}", () => "${activeIndex}")],
  },
  {
    name: "ArrowDown steps the stored index",
    check: has(
      flexRe("setActiveIndex(stepHighlight(activeIndex, optionCount, 1))"),
    ),
    mutant: [
      "setActiveIndex(stepHighlight(activeIndex, optionCount, 1));",
      "setActiveIndex(Math.min(active + 1, optionCount - 1));",
    ],
  },
  {
    name: "ArrowUp steps the stored index",
    check: has(
      flexRe("setActiveIndex(stepHighlight(activeIndex, optionCount, -1))"),
    ),
    mutant: [
      "setActiveIndex(stepHighlight(activeIndex, optionCount, -1));",
      "setActiveIndex(Math.max(active - 1, 0));",
    ],
  },
  {
    name: "no other step call",
    check: twoSteps,
    mutant: [
      enterMutant[0],
      `stepHighlight(activeIndex, optionCount, 1); ${enterMutant[0]}`,
    ],
  },
  {
    name: "Enter reads the clamped index",
    check: enterPin,
    mutant: enterMutant,
  },
  {
    name: "no inline ceiling clamp",
    check: hasNot(/Math\s*\.\s*min\s*\(\s*activeIndex/),
    mutant: [
      "const active = clampHighlight(activeIndex, optionCount);",
      "const active = Math.min(activeIndex, optionCount - 1);",
    ],
  },
  {
    name: "no read indexed by the stored value",
    check: hasNot(/\[\s*activeIndex\s*\]/),
    mutant: [enterMutant[0], `void [0][activeIndex]; ${enterMutant[0]}`],
  },
  {
    name: "no comparison against the stored value",
    check: hasNot(/[=!]==\s*activeIndex|activeIndex\s*[=!]==/),
    mutant: [enterMutant[0], `void (activeIndex === 0); ${enterMutant[0]}`],
  },
];

const SITE_PINS = [
  {
    file: "src/features/commit/CoAuthorPicker.tsx",
    view: (masked) => masked,
    probeBefore: "const active = clampHighlight(activeIndex, optionCount);",
    pins: popoverPins(
      has(flexRe("addAt(active)")),
      ["addAt(active);", "addAt(activeIndex);"],
      "`coauthor-option-${active}`",
    ),
  },
  {
    file: "src/features/repo-settings/BitbucketDefaultReviewersSection.tsx",
    view: addReviewerSlice,
    probeBefore: "const active = clampHighlight(activeIndex, optionCount);",
    pins: popoverPins(
      has(flexRe("suggestions[active]")),
      [
        "const match = suggestions[active];",
        "const match = suggestions[activeIndex];",
      ],
      "`bb-reviewer-option-${active}`",
    ),
  },
  {
    file: "src/features/repository/RepoList.tsx",
    view: (masked) => masked,
    probeBefore: "const active =",
    pins: [
      {
        name: "the cursor keeps the -1 sentinel, else clamps",
        check: has(
          flexRe(
            "const active = !q && highlight < 0 ? -1 : clampHighlight(highlight, visible.length);",
          ),
        ),
        mutant: [
          "!q && highlight < 0 ? -1 : clampHighlight(highlight, visible.length);",
          "clampHighlight(highlight, visible.length);",
        ],
        extraMutants: [
          [
            "!q && highlight < 0 ? -1 : clampHighlight(highlight, visible.length);",
            "highlight; void (!q && highlight < 0 ? -1 : clampHighlight(highlight, visible.length));",
          ],
        ],
      },
      {
        name: "the marked row reads the clamped index",
        check: has(flexRe("visible[active]?.path ?? null")),
        mutant: [
          "visible[active]?.path ?? null",
          "visible[highlight]?.path ?? null",
        ],
      },
      {
        name: "Enter reads the clamped index, with no fallback",
        check: has(flexRe("const target = visible[active];")),
        mutant: [
          "const target = visible[active];",
          "const target = visible[highlight] ?? (q ? visible[0] : undefined);",
        ],
        extraMutants: [
          [
            "const target = visible[active];",
            "const target = visible[active] ?? visible[0];",
          ],
        ],
      },
      {
        name: "no read indexed by the stored value",
        check: hasNot(/visible\s*\[\s*highlight\s*\]/),
        mutant: [
          "visible[active]?.path ?? null",
          "visible[highlight]?.path ?? null",
        ],
      },
      {
        name: "the first-match Enter fallback stays dead",
        check: hasNot(/\?\?\s*\(\s*q\s*\?/),
        mutant: [
          "const target = visible[active];",
          "const target = visible[active] ?? (q ? visible[0] : undefined);",
        ],
      },
      {
        name: "the scroll effect is keyed on the clamped index",
        check: has(/\}\s*,\s*\[\s*active\s*\]\s*\)\s*;/),
        mutant: ["}, [active]);", "}, [highlight]);"],
      },
      {
        name: "ArrowDown steps from the cursor",
        check: has(
          flexRe(
            "active < 0 ? clampHighlight(0, visible.length) : stepHighlight(active, visible.length, 1)",
          ),
        ),
        mutant: [
          "stepHighlight(active, visible.length, 1)",
          "Math.min(active + 1, visible.length - 1)",
        ],
      },
      {
        name: "ArrowUp steps from the cursor",
        check: has(
          flexRe(
            "active < 0 ? clampHighlight(0, visible.length) : stepHighlight(active, visible.length, -1)",
          ),
        ),
        mutant: [
          "stepHighlight(active, visible.length, -1)",
          "Math.max(active - 1, 0)",
        ],
      },
      {
        name: "no other step call",
        check: twoSteps,
        mutant: [
          "const target = visible[active];",
          "const target = visible[stepHighlight(active, visible.length, 1)];",
        ],
      },
    ],
  },
  {
    file: "src/features/sessions/SessionComposer.tsx",
    view: (masked) => masked,
    probeBefore: "const mentionActive =",
    pins: [
      {
        name: "the @ cursor is the one clamped index",
        check: has(
          flexRe(
            "const mentionActive = clampHighlight(mentionIndex, matches.length);",
          ),
        ),
        mutant: [
          "clampHighlight(mentionIndex, matches.length)",
          "Math.min(mentionIndex, matches.length - 1)",
        ],
        extraMutants: [
          [
            "const mentionActive = clampHighlight(mentionIndex, matches.length);",
            "const mentionActive = mentionIndex; void clampHighlight(mentionIndex, matches.length);",
          ],
        ],
      },
      {
        name: "the / cursor is the one clamped index",
        check: has(
          flexRe(
            "const slashActive = clampHighlight(slashIndex, slashMatches.length);",
          ),
        ),
        mutant: [
          "clampHighlight(slashIndex, slashMatches.length)",
          "Math.min(slashIndex, slashMatches.length - 1)",
        ],
        extraMutants: [
          [
            "const slashActive = clampHighlight(slashIndex, slashMatches.length);",
            "const slashActive = slashIndex; void clampHighlight(slashIndex, slashMatches.length);",
          ],
        ],
      },
      {
        name: "@ Enter inserts the clamped row",
        check: has(flexRe("insertMention(matches[mentionActive])")),
        mutant: [
          "insertMention(matches[mentionActive])",
          "insertMention(matches[mentionIndex])",
        ],
      },
      {
        name: "/ Enter completes the clamped row",
        check: has(flexRe("selectSlash(slashMatches[slashActive])")),
        mutant: [
          "selectSlash(slashMatches[slashActive])",
          "selectSlash(slashMatches[slashIndex])",
        ],
      },
      {
        name: "/ ArrowDown wraps from the clamped cursor",
        check: has(
          flexRe("setSlashIndex((slashActive + 1) % slashMatches.length"),
        ),
        mutant: ["(slashActive + 1)", "(slashIndex + 1)"],
      },
      {
        name: "/ ArrowUp wraps from the clamped cursor",
        check: has(
          flexRe(
            "setSlashIndex((slashActive - 1 + slashMatches.length) % slashMatches.length",
          ),
        ),
        mutant: [
          "(slashActive - 1 + slashMatches.length)",
          "(slashIndex - 1 + slashMatches.length)",
        ],
      },
      {
        name: "@ ArrowDown wraps from the clamped cursor",
        check: has(
          flexRe("setMentionIndex((mentionActive + 1) % matches.length"),
        ),
        mutant: ["(mentionActive + 1)", "(mentionIndex + 1)"],
      },
      {
        name: "@ ArrowUp wraps from the clamped cursor",
        check: has(
          flexRe(
            "setMentionIndex((mentionActive - 1 + matches.length) % matches.length",
          ),
        ),
        mutant: [
          "(mentionActive - 1 + matches.length)",
          "(mentionIndex - 1 + matches.length)",
        ],
      },
      {
        name: "the @ marker reads the clamped index",
        check: has(/index=\{\s*mentionActive\s*\}/),
        mutant: ["index={mentionActive}", "index={mentionIndex}"],
      },
      {
        name: "the / marker reads the clamped index",
        check: has(/index=\{\s*slashActive\s*\}/),
        mutant: ["index={slashActive}", "index={slashIndex}"],
      },
      {
        name: "the @ aria id names the clamped row (raw source)",
        raw: true,
        check: (source) =>
          assert.ok(source.includes("session-mention-${mentionActive}")),
        mutant: [
          "session-mention-${mentionActive}",
          "session-mention-${mentionIndex}",
        ],
      },
      {
        name: "the / aria id names the clamped row (raw source)",
        raw: true,
        check: (source) =>
          assert.ok(source.includes("session-slash-${slashActive}")),
        mutant: ["session-slash-${slashActive}", "session-slash-${slashIndex}"],
      },
      {
        name: "no @ read indexed by the stored value",
        check: hasNot(/matches\s*\[\s*mentionIndex\s*\]/),
        mutant: [
          "insertMention(matches[mentionActive])",
          "insertMention(matches[mentionIndex])",
        ],
      },
      {
        name: "no / read indexed by the stored value",
        check: hasNot(/slashMatches\s*\[\s*slashIndex\s*\]/),
        mutant: [
          "selectSlash(slashMatches[slashActive])",
          "selectSlash(slashMatches[slashIndex])",
        ],
      },
      {
        name: "no @ aria id from the stored value",
        check: hasNot(/\$\{\s*mentionIndex\s*\}/),
        mutant: [
          "session-mention-${mentionActive}",
          "session-mention-${mentionIndex}",
        ],
      },
      {
        name: "no / aria id from the stored value",
        check: hasNot(/\$\{\s*slashIndex\s*\}/),
        mutant: ["session-slash-${slashActive}", "session-slash-${slashIndex}"],
      },
      {
        name: "no @ marker from the stored value",
        check: hasNot(/index=\{\s*mentionIndex\s*\}/),
        mutant: ["index={mentionActive}", "index={mentionIndex}"],
      },
      {
        name: "no / marker from the stored value",
        check: hasNot(/index=\{\s*slashIndex\s*\}/),
        mutant: ["index={slashActive}", "index={slashIndex}"],
      },
      {
        name: "no wrap from the raw stored value",
        check: hasNot(/\(\s*i\s*[+-]\s*1/),
        mutant: [
          "setSlashIndex((slashActive + 1) % slashMatches.length)",
          "setSlashIndex((i) => (i + 1) % slashMatches.length)",
        ],
      },
    ],
  },
];

// Planted before each site's cursor derivation by the green controls, once as a
// comment and once as a string: every pinned and banned spelling, plus a step
// call for the count pins. The mask blanks both, so every pin must stay green.
const PROBE_TOKENS = [
  "clampHighlight(highlight, visible.length)",
  "stepHighlight(activeIndex, optionCount, 1)",
  "[activeIndex] x === activeIndex Math.min(activeIndex, 1) `${activeIndex}`",
  "visible[highlight] ?? (q ? visible[0] : undefined)",
  "matches[mentionIndex] slashMatches[slashIndex] ${mentionIndex} ${slashIndex}",
  "index={mentionIndex} index={slashIndex} (i + 1) pin probe",
].join(" ");
const PROBES = {
  comment: `// ${PROBE_TOKENS}\n`,
  string: `const pinProbe = "${PROBE_TOKENS}";\n`,
};
const isNegative = (pin) => pin.check.negative === true;

// The source a pin reads: raw for the aria-id pins, else masked (and sliced).
const pinInput = (site, pin, raw) => (pin.raw ? raw : site.view(mask(raw)));
const runPin = (site, pin, raw) => pin.check(pinInput(site, pin, raw));

for (const site of SITE_PINS) {
  const raw = readRaw(site.file);

  for (const pin of site.pins) {
    test(`${site.file}: ${pin.name}`, () => {
      runPin(site, pin, raw);
    });

    const mutants = [pin.mutant, ...(pin.extraMutants ?? [])];
    mutants.forEach(([anchor, replacement], n) => {
      test(`${site.file}: ${pin.name} (red control ${n + 1})`, () => {
        assert.equal(countLiteral(raw, anchor), 1, `one anchor: ${anchor}`);
        const mutant = raw.replace(anchor, () => replacement);
        // Built outside the throws so only the pin itself can supply the failure.
        const input = pinInput(site, pin, mutant);
        assert.throws(() => pin.check(input), assert.AssertionError);
      });
    });
  }

  for (const [where, probe] of Object.entries(PROBES)) {
    test(`${site.file}: a planted ${where} neither satisfies nor trips a pin (green control)`, () => {
      assert.equal(countLiteral(raw, site.probeBefore), 1);
      const probed = raw.replace(site.probeBefore, (m) => probe + m);
      for (const pin of site.pins) {
        runPin(site, pin, probed);
        // Unmasked, the probe must trip every negative and count pin, so each
        // one above really had a banned token in front of it.
        if (isNegative(pin)) {
          const unmasked = site.view(probed);
          assert.throws(
            () => pin.check(unmasked),
            assert.AssertionError,
            `${where} probe plants nothing for: ${pin.name}`,
          );
        }
      }
    });
  }
}

test("AddReviewerPopover slice fails closed on a reshaped file (red controls)", () => {
  const raw = readRaw(
    "src/features/repo-settings/BitbucketDefaultReviewersSection.tsx",
  );
  assert.equal(countLiteral(raw, "function AddReviewerPopover"), 1);
  const renamed = raw.replace(
    "function AddReviewerPopover",
    () => "function AddMemberPopover",
  );
  const renamedMasked = mask(renamed);
  assert.throws(() => addReviewerSlice(renamedMasked), assert.AssertionError);
  // A second cursor declared inside the popover (the rows list's own one sits
  // above the slice, so the anchor is a popover-only statement).
  const anchor = "const candidates = useBbMemberCandidates(";
  assert.equal(countLiteral(raw, anchor), 1);
  const doubled = raw.replace(
    anchor,
    (m) => `${ADD_REVIEWER_STATE}(1);\n  ${m}`,
  );
  const doubledMasked = mask(doubled);
  assert.throws(() => addReviewerSlice(doubledMasked), assert.AssertionError);
});
