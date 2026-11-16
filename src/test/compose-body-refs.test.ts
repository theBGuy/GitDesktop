import { describe, expect, it } from "vitest";
import type {
  JiraMentionChip,
  LinkedIssueChip,
} from "@/features/pulls/LinkedIssuesField";
import {
  composeBodyWithJiraRefs,
  composeBodyWithRefs,
  splitBodyRefBlock,
} from "@/features/pulls/useLinkedIssueChips";

const chip = (
  number: number,
  keyword: LinkedIssueChip["keyword"] = "closes",
): LinkedIssueChip => ({
  number,
  title: `Issue ${number}`,
  state: "OPEN",
  keyword,
  source: "manual",
  aiSuggestedClose: false,
});

const jira = (key: string): JiraMentionChip => ({
  key,
  summary: key,
  statusCategory: "new",
  source: "manual",
});

describe("composeBodyWithRefs", () => {
  it("returns the text untouched when there are no chips", () => {
    for (const text of [
      "Words  \n\n",
      "Words\n\nCloses #5\nCloses #5\n",
      "\n  ",
      "",
    ]) {
      expect(composeBodyWithRefs(text, [])).toBe(text);
      expect(composeBodyWithJiraRefs(text, [])).toBe(text);
    }
  });

  it("writes a typed reference that is also a chip once", () => {
    expect(composeBodyWithRefs("Words edited\n\nCloses #5", [chip(5)])).toBe(
      "Words edited\n\nCloses #5",
    );
  });

  it("gives a typed reference the chip's keyword", () => {
    expect(composeBodyWithRefs("Words\n\nRelates to #5", [chip(5)])).toBe(
      "Words\n\nCloses #5",
    );
  });

  it("keeps typed references ahead of chip-only ones", () => {
    expect(
      composeBodyWithRefs("Words\n\nCloses #5", [chip(7, "relates")]),
    ).toBe("Words\n\nCloses #5\nRelates to #7");
  });

  it("keeps a typed Jira line under the native cluster once", () => {
    const text = "Words\n\nCloses #5\nRelates to PROJ-1";
    expect(composeBodyWithRefs(text, [chip(5)])).toBe(text);
    const out = composeBodyWithRefs(text, [chip(7)]);
    expect(out).toBe("Words\n\nRelates to PROJ-1\n\nCloses #5\nCloses #7");
    expect(out.match(/PROJ-1/g)).toHaveLength(1);
  });

  it("is idempotent and matches what a reopen re-splits to", () => {
    const chips = [chip(5), chip(7, "relates")];
    for (const text of [
      "Words edited\n\nCloses #5",
      "Words\n\nRelates to #5\nRelates to PROJ-1\n\n",
      "Closes #9",
      "Just prose",
    ]) {
      const once = composeBodyWithRefs(text, chips);
      expect(composeBodyWithRefs(once, chips)).toBe(once);
      const split = splitBodyRefBlock(once, "native");
      const reopened = split.refs.map((r) => chip(r.number, r.keyword));
      expect(composeBodyWithRefs(split.text, reopened)).toBe(once);
    }
  });
});

describe("composeBodyWithJiraRefs", () => {
  it("writes a typed key that is also a chip once", () => {
    expect(
      composeBodyWithJiraRefs("Words edited\n\nRelates to PROJ-5", [
        jira("PROJ-5"),
      ]),
    ).toBe("Words edited\n\nRelates to PROJ-5");
  });

  it("keeps a typed native line under the Jira cluster once", () => {
    const out = composeBodyWithJiraRefs(
      "Words\n\nCloses #5\nRelates to PROJ-1",
      [jira("PROJ-1"), jira("PROJ-2")],
    );
    expect(out).toBe(
      "Words\n\nCloses #5\n\nRelates to PROJ-1\nRelates to PROJ-2",
    );
    expect(composeBodyWithJiraRefs(out, [jira("PROJ-1"), jira("PROJ-2")])).toBe(
      out,
    );
  });
});

describe("a reference the text already writes on its own line", () => {
  const CLOSING = [
    "close",
    "closes",
    "closed",
    "fix",
    "fixes",
    "fixed",
    "resolve",
    "resolves",
    "resolved",
  ];

  it("writes no Closes chip line under a closing-keyword line", () => {
    for (const keyword of CLOSING) {
      const text = `Intro\n\n${keyword} #12\n\nMore text`;
      expect(composeBodyWithRefs(text, [chip(12)])).toBe(text);
    }
    for (const line of [
      "Closes #12",
      "- fixes #12",
      "* Resolved #12",
      "+ close #12",
      "  1. Fixes #12  ",
      "2) fixed #12",
    ]) {
      const text = `Intro\n\n${line}\n\nMore text`;
      expect(composeBodyWithRefs(text, [chip(12)])).toBe(text);
    }
  });

  it("writes no Relates chip line under a closing or relates line", () => {
    for (const line of ["Fixes #12", "Relates to #12", "  - relates to #12"]) {
      const text = `Intro\n\n${line}\n\nMore text`;
      expect(composeBodyWithRefs(text, [chip(12, "relates")])).toBe(text);
    }
  });

  it("still writes a Closes chip line under a Relates to line", () => {
    expect(
      composeBodyWithRefs("Intro\n\nRelates to #12\n\nMore text", [chip(12)]),
    ).toBe("Intro\n\nRelates to #12\n\nMore text\n\nCloses #12");
  });

  it("reads a line's strongest keyword when the text writes both", () => {
    const text = "Relates to #12\n\nResolves #12\n\nMore text";
    expect(composeBodyWithRefs(text, [chip(12)])).toBe(text);
  });

  it("writes the chip line beside anything that isn't a whole reference line", () => {
    for (const text of [
      "See #12 for context",
      "Closes #12.",
      "> Closes #12",
      "- [ ] Closes #12",
      "Closes #12, #13",
      "Closes #12 and fixes #13",
      "- Fixes #120",
      "Intro\n\nCLOSES #12\n\nMore text",
    ])
      expect(composeBodyWithRefs(text, [chip(12)])).toBe(
        `${text}\n\nCloses #12`,
      );
  });

  it("counts a line with a CRLF line end", () => {
    const text = "Intro\r\n\r\nCloses #12\r\n\r\nMore text";
    expect(composeBodyWithRefs(text, [chip(12)])).toBe(text);
  });

  it("doesn't count a line a forge reads as code or a comment", () => {
    for (const text of [
      "```\nCloses #12\n```",
      "~~~\nCloses #12\n~~~",
      "````md\n```\nCloses #12\n````",
      "Intro\n\n    Closes #12",
      "Intro\n\n\tCloses #12",
      "<!--\nCloses #12\n-->",
      "Intro <!-- a note\nCloses #12\nends here -->",
    ])
      expect(composeBodyWithRefs(text, [chip(12)])).toBe(
        `${text}\n\nCloses #12`,
      );
  });

  it("counts a line after a closed fence or comment", () => {
    for (const text of [
      "```\ncode\n```\n\nCloses #12\n\nMore text",
      "~~~\ncode\n~~~\nCloses #12\n\nMore text",
      "<!--\nnote\n-->\nCloses #12\n\nMore text",
      "<!-- one line -->\nCloses #12\n\nMore text",
    ])
      expect(composeBodyWithRefs(text, [chip(12)])).toBe(text);
  });

  it("keeps a trailing close a fenced copy can't stand in for on reopen", () => {
    const body = "Notes\n\n```\nCloses #12\n```\n\nCloses #12";
    const { text, refs } = splitBodyRefBlock(body, "native");
    const reopened = refs.map((r) => chip(r.number, r.keyword));
    expect(composeBodyWithRefs(text, reopened)).toBe(body);
  });

  it("writes only the chips the text doesn't reference", () => {
    expect(
      composeBodyWithRefs("Intro\n\nCloses #12\n\nMore text", [
        chip(12),
        chip(7),
      ]),
    ).toBe("Intro\n\nCloses #12\n\nMore text\n\nCloses #7");
  });

  it("writes no Jira chip line under any reference line for its key", () => {
    for (const line of [
      "Relates to PROJ-4",
      "Fixes PROJ-4",
      "- closes PROJ-4",
    ]) {
      const text = `Intro\n\n${line}\n\nMore text`;
      expect(composeBodyWithJiraRefs(text, [jira("PROJ-4")])).toBe(text);
    }
    // A key not in capitals is no key a forge links.
    for (const text of [
      "Relates to PROJ-4 and PROJ-5",
      "See PROJ-4 first",
      "Intro\n\nRelates to proj-4\n\nMore text",
      "Intro\n\n- closes Proj-4\n\nMore text",
    ])
      expect(composeBodyWithJiraRefs(text, [jira("PROJ-4")])).toBe(
        `${text}\n\nRelates to PROJ-4`,
      );
  });
});

describe("a closing line in the trailing block", () => {
  it("is kept as typed under a Relates chip", () => {
    for (const text of ["Body\n\nCloses #12", "Body\n\nFixes #12"])
      expect(composeBodyWithRefs(text, [chip(12, "relates")])).toBe(text);
  });

  it("covers a Closes chip when the prose closes the issue too", () => {
    const text = "Closes #12\n\nbody\n\nRelates to #12";
    expect(composeBodyWithRefs(text, [chip(12)])).toBe(text);
  });

  it("is upgraded only, never downgraded, by a chip", () => {
    expect(composeBodyWithRefs("Body\n\nRelates to #12", [chip(12)])).toBe(
      "Body\n\nCloses #12",
    );
    const relates = "Body\n\nRelates to #12";
    expect(composeBodyWithRefs(relates, [chip(12, "relates")])).toBe(relates);
  });

  it("merges a mixed block by each issue's strongest keyword", () => {
    expect(
      composeBodyWithRefs("Body\n\nCloses #12\nRelates to #13", [
        chip(12, "relates"),
        chip(13),
        chip(14, "relates"),
      ]),
    ).toBe("Body\n\nCloses #12\nCloses #13\nRelates to #14");
    expect(
      composeBodyWithRefs("Body\n\nCloses #12\nRelates to #12", [chip(7)]),
    ).toBe("Body\n\nCloses #12\nCloses #7");
  });
});

describe("a number the trailing block names under both keywords", () => {
  it("splits to one Closes ref whatever the line order", () => {
    for (const body of [
      "Body\n\nCloses #12\nRelates to #12",
      "Body\n\nRelates to #12\nCloses #12",
    ]) {
      const split = splitBodyRefBlock(body, "native");
      expect(split.refs).toEqual([{ number: 12, keyword: "closes" }]);
      expect(split.text).toBe("Body");
    }
  });

  it("keeps the repeated number at its first line's position", () => {
    const split = splitBodyRefBlock(
      "Body\n\nRelates to #12\nCloses #7\nCloses #12",
      "native",
    );
    expect(split.refs).toEqual([
      { number: 12, keyword: "closes" },
      { number: 7, keyword: "closes" },
    ]);
  });

  it("leaves the Jira split's native lines as they were, one per line", () => {
    for (const [body, lines] of [
      ["Body\n\nCloses #12\nRelates to #12", "Closes #12\nRelates to #12"],
      ["Body\n\nRelates to #12\nCloses #12", "Relates to #12\nCloses #12"],
    ]) {
      const split = splitBodyRefBlock(body, "jira");
      expect(split.text).toBe(`Body\n\n${lines}`);
      expect(split.refs).toEqual([]);
      expect(split.jiraRefs).toEqual([]);
    }
  });

  it("round-trips a stored close and relates pair without weakening it", () => {
    const { text, refs } = splitBodyRefBlock(
      "Body\n\nCloses #12\n\nRelates to #12",
      "native",
    );
    const chips = refs.map((r) => chip(r.number, r.keyword));
    expect(composeBodyWithRefs(text, chips)).toBe("Body\n\nCloses #12");
  });
});

describe("which typed reference lines count as already written", () => {
  // The rows are the oracle: each expectation is a forge's reading of the
  // body, never what `marked` lexes. A red row after a `marked` upgrade is a
  // lexing change to judge, not an expectation to update.
  const same = (body: string) => body;
  const withLine = (body: string) => `${body}\n\nCloses #12`;
  // A body of exactly `length` characters ending in `tail`.
  const sized = (length: number, tail: string) =>
    "a".repeat(length - tail.length) + tail;
  // A row's third column, when present, spells the composed body itself: a
  // trailing reference line merges with the chip's in the splitter.
  type Row = [string, string, string?];

  // A forge renders the typed line as code or hides it.
  const mustNotCount: Row[] = [
    ["A1", "```md\n    ```\nCloses #12\n```"],
    ["A2", "```md\n\t```\nCloses #12\n```"],
    ["A3", "```\n``` js\nCloses #12\n```"],
    ["A4", "```\n~~~\nCloses #12\n~~~\n```"],
    ["A5", "~~~\n```\nCloses #12\n```\n~~~"],
    ["A6", "````\n```\nCloses #12\n```\n````"],
    ["A7", "```md\r\n    ```\r\nCloses #12\r\n```\r\n\r\nMore"],
    ["A8", "x\r```\n\nCloses #12\n```"],
    ["A9", "Intro\n\n  \tCloses #12"],
    ["A10", "-     Closes #12"],
    ["A11", "- item\n\n      Closes #12"],
    ["A12", "- item\n\n\t\tCloses #12"],
    ["A13", "- ```\n  Closes #12\n  ```"],
    ["A14", "- item\n  ```\n  code\n```\nCloses #12\n```"],
    ["A15", "- a\n\n    ```\n\n  Closes #12\n\n    ```"],
    ["A16", "1. a\n\n    ```\n\n   Closes #12\n\n    ```"],
    ["A17", "- a\n  > ```\n  > Closes #12\n  > ```"],
    ["A18", "```x``` is inline\n\n```\nCloses #12\n```"],
    ["A19", "text `\nCloses #12\n` more"],
    ["A20", '[foo]: /url "\nCloses #12\n"\n\n[foo]'],
    ["A21", "![\nCloses #12\n](x.png)"],
    ["A22", 'text <img alt="\nCloses #12\n">'],
    ["A23", "$$\nCloses #12\n$$"],
    ["A24", "<!-- a\n--> <!-- b\nCloses #12\n-->"],
    ["A25", "<!-- first\n--><!-- second\nCloses #12\n-->\n\nAfter"],
    ["A26", "<pre>\nCloses #12\n</pre>"],
    ["A27", "<pre>\n\nCloses #12\n\n</pre>"],
    ["A28", "text <pre>\nCloses #12\n</pre>"],
    ["A29", "<pre>\n</pre> <pre>\nCloses #12\n</pre>"],
    ["A30", "<pre>\n</pre x\nCloses #12\n</pre>"],
    ["A31", "<pre/>\n\n\nCloses #12\n\n</pre>"],
    ["A32", "<pre>\n<!--\n</pre>\n\nCloses #12\n\n-->"],
    ["A33", "Intro\n<code>\nx\n</code> `\nCloses #12\n`"],
    ["A34", "text ` <!--\n-->\nCloses #12\n`"],
    ["A35", "text <!--\n--> `\nCloses #12\n`"],
    ["A36", "x <!-- a --> ` <!-- b -->\nCloses #12\n`"],
    ["A37", "<span>note</span> see:\n```\n\nCloses #12\n```"],
    ["A38", "<?\n\nCloses #12\n?>"],
    ["A39", "    <!--\n```\n-->\nCloses #12\n```"],
    ["A40", "> <!--\n\nCloses #12\n\n<!-- x -->\n\nMore"],
    ["A41", "- [ ] a\n\n  <!--\n\nCloses #12\n\n<!-- x -->\n\nMore"],
    ["A42", "[a]:\n```\nCloses #12\n```"],
    ["A43", "[a]:\n~~~\nCloses #12\n~~~\n\nMore"],
    ["A44", "[a]:\n<pre>\n\nCloses #12\n\n</pre>"],
    ["A45", "- a\n\n  [b]:\n  ```\n  Closes #12\n  ```"],
    ["A46", "$$\n\nCloses #12\n\n$$"],
    ["A47", "a `b\nCloses #12\nc` d\n\nMore"],
    ["A48", "[a](u '\nCloses #12\n')\n\nMore"],
    ["A49", "$$\n---\n\nCloses #12\n\n$$\n\nMore"],
    ["A50", "- <!--\n  x\n-->\n\nCloses #12\n\nMore"],
    ["A51", "- a\n\n  <!--\n  x\n-->\n\nCloses #12\n\nMore"],
    ["A52", "* <!--\n  a\n--> b\n\nCloses #12\n\nMore"],
    ["A53", "[^1]: note\nCloses #12", "[^1]: note\n\nCloses #12"],
    ["A54", "[^note]: see below\nCloses #12\n\nMore"],
    ["A55", "[^1]:\n    Closes #12"],
    [
      "A74",
      "Intro\n[^1]: note\nCloses #12\n\nMore",
      "Intro\n[^1]: note\nCloses #12\n\nMore\n\nCloses #12",
    ],
    [
      "A75",
      "- a\n  [^1]: n\n  Closes #12",
      "- a\n  [^1]: n\n  Closes #12\n\nCloses #12",
    ],
    ["A56", sized(100_001, "\n\nCloses #12"), sized(100_001, "\n\nCloses #12")],
    ["A57", sized(100_001, "\n\nFixes #12")],
    ["A58", "<div hidden>\n\nCloses #12\n\n</div>"],
    ["A59", 'x <span style="display:none">\nCloses #12\n</span>'],
    ["A60", "<PRE>\n\nCloses #12\n\n</PRE>"],
    ["A61", "<SCRIPT>\n\nCloses #12\n\n</SCRIPT>"],
    ["A62", "<textarea>\n\nCloses #12\n\n</textarea>"],
    ["A63", "- [ ] a\n  <!--\n  x\n-->\n\nCloses #12\n\nMore"],
    // Wider than GitLab's closing pattern: the splitter then rewrites the
    // typed line into the chip's.
    ["A64", "CLOSES #12", "Closes #12"],
    ["A65", "Intro\nCLOSES #12", "Intro\n\nCloses #12"],
    ["A66", "Closes\t#12", "Closes #12"],
    ["A67", "Intro\nCloses\t#12", "Intro\n\nCloses #12"],
    ["A68", "Closes\u00a0#12", "Closes #12"],
    ["A69", "Intro\nCloses\u00a0#12", "Intro\n\nCloses #12"],
    ["A70", "cLoses #12", "Closes #12"],
    ["A71", "Intro\ncLoses #12", "Intro\n\nCloses #12"],
  ];

  // A forge shows the typed line as text.
  const counts: Row[] = [
    ["B1", "Intro\n\nCloses #12\n\nMore"],
    ["B2", "Intro\r\n\r\nCloses #12\r\n\r\nMore text"],
    ["B3", "Summary line\nFixes #12\n\nMore"],
    ["B4", "Relates to #3\nCloses #12\n\nMore"],
    ["B5", "Summary  \nFixes #12\n\nMore"],
    ["B6", "- Closes #12\n- other\n\nMore"],
    ["B7", "1. Fixes #12\n\nMore"],
    ["B8", "- a\n  - Closes #12\n\nMore"],
    ["B9", "- a\n\n  Closes #12\n\nMore"],
    ["B10", "- item\n    Closes #12\n\nMore"],
    ["B11", "- item\n\n    Fixes #12\n\nMore"],
    ["B12", "10. item\n\n    Closes #12\n\nMore"],
    ["B13", "- item\n\n\tCloses #12\n\nMore"],
    ["B14", "```\ncode\n```\n\nFixes #12\n\nMore"],
    ["B15", "~~~\ncode\n~~~\nCloses #12\n\nMore text"],
    ["B16", "`````\n```\ncode\n`````\n\nFixes #12\n\nMore"],
    ["B17", "- step\n  ```sh\n  cmd\n  ```\n\nFixes #12\n\nMore"],
    ["B18", "Run `a`:\n```sh\ncmd\n```\n\nFixes #12\n\nMore"],
    ["B19", "  ```\ncode\n```\n\nFixes #12\n\nMore"],
    ["B20", "```\n ```\nCloses #12\n```"],
    ["B21", "```x``` is the syntax\n\nFixes #12\n\nMore"],
    ["B22", "Use `x` here.\n\nFixes #12\n\nMore"],
    ["B23", "Use `\n \nCloses #12\n`"],
    ["B24", "<!-- describe your change -->\n\nCloses #12\n\nMore"],
    ["B25", "<!-- one line -->\nCloses #12\n\nMore text"],
    ["B26", "<!--\nnote\n-->\nCloses #12\n\nMore text"],
    ["B27", "<!--\n```\n-->\n\nFixes #12\n\nMore"],
    ["B28", '<img width="10" src="x.png">\n\nCloses #12\n\nMore'],
    ["B29", "<details>\n<summary>Notes</summary>\n\nCloses #12\n\n</details>"],
    ["B30", "> quote\n\nCloses #12\n\nMore"],
    ["B31", "> <!-- a\n> b -->\n\nFixes #12\n\nMore"],
    ["B32", "Closes #12\n\n<pre>\nx\n</pre>"],
    ["B33", "Closes #12\n[a]:\n```\ncode\n```"],
    ["B34", "```html\n<pre>x</pre>\n```\n\nFixes #12\n\nMore"],
    ["B35", "See `x`\nFixes #12\n\nMore"],
    ["B36", "Fixes the **bug**\nCloses #12\n\nMore"],
    ["B37", "See https://example.com\nFixes #12\n\nMore"],
    ["B38", "Closes #12\nSee [docs](https://x.y) too\n\nMore"],
    ["B39", "Hi <b>x</b>\nCloses #12\n\nMore"],
    ["B40", "Closes #12  \nmore\n\nMore"],
    ["B41", "Closes #12\\\nmore\n\nMore"],
    ["B42", "x <b>\nCloses #12\n</b>\n\nMore"],
    ["B43", "- item `x`\n  Closes #12\n\nMore"],
    ["B44", "Use `\nCloses #12\n\nMore"],
    ["B45", sized(100_000, "\n\nFixes #12")],
    ["B46", '<div align="center">\n\nCloses #12\n\n</div>'],
    ["B47", '<div title="x hidden">\n\nCloses #12\n\n</div>'],
    ["B48", "<pre-x>\n\nCloses #12\n\nMore"],
    ["B49", "<!-- <pre> -->\n\nCloses #12\n\nMore"],
    ["B50", "[a]: /u\n\nCloses #12\n\nMore"],
    ["B51", "Intro\n\ncloses   #12\n\nMore"],
  ];

  // Accepted duplicates: a forge shows the line, but the scanner can't tell,
  // so the chip writes a second one.
  const acceptedDuplicates: Row[] = [
    ["C1", "<pre>\ncode\n</pre>\n\nFixes #12\n\nMore"],
    ["C2", "Press <kbd>x</kbd>\n\nCloses #12\n\nMore"],
    ["C3", "Wrap it in `<pre>` tags.\n\nFixes #12\n\nMore"],
    ["C4", "`<!--` starts a comment\n\nFixes #12\n\nMore"],
    ["C5", "text <!-- open\n\nCloses #12\n\nMore"],
    ["C6", "<div>\nFixes #12\n</div>\n\nMore"],
    ["C10", "Costs $5 today\nFixes #12\n\nMore"],
    ["C11", "> Closes #12"],
    ["C12", "- > Closes #12"],
    ["C13", "- [ ] Closes #12"],
    ["C14", "# Closes #12\n\nMore"],
    ["C15", "Closes #12\n---\n\nMore"],
    ["C16", "| a |\n|---|\n| Closes #12 |"],
    ["C17", "[a]:\n---\n\nCloses #12\n\nMore"],
    ["C18", "> use <pre> here\n\nFixes #12\n\nMore"],
    ["C19", "Press <kbd>x</kbd>\nCloses #12\n\nMore"],
    ["C20", "*a\nCloses #12\nb*\n\nMore"],
    ["C21", "Pay $$ now\n\nFixes #12\n\nMore"],
    ["C22", "1. <!-- x\n   y\n   -->\n\nCloses #12\n\nMore"],
  ];

  const rows = [
    ...mustNotCount.map(([id, body, exp]) => [id, body, exp ?? withLine(body)]),
    ...counts.map(([id, body, exp]) => [id, body, exp ?? same(body)]),
    ...acceptedDuplicates.map(([id, body, exp]) => [
      id,
      body,
      exp ?? withLine(body),
    ]),
  ];
  for (const [id, body, expected] of rows) {
    it(`row ${id}`, () => {
      expect(composeBodyWithRefs(body, [chip(12)])).toBe(expected);
    });
  }

  // Must not count, under a Relates chip.
  const relatesRows: [string, string, string][] = [
    ["A72", "RELATES TO #12", "Relates to #12"],
    ["A73", "Intro\nRELATES TO #12", "Intro\n\nRelates to #12"],
  ];
  for (const [id, body, expected] of relatesRows) {
    it(`row ${id}`, () => {
      expect(composeBodyWithRefs(body, [chip(12, "relates")])).toBe(expected);
    });
  }

  it("applies the same rule to a Jira reference line", () => {
    expect(
      composeBodyWithJiraRefs("Intro\n\nRelates to ENG-7\n\nMore", [
        jira("ENG-7"),
      ]),
    ).toBe("Intro\n\nRelates to ENG-7\n\nMore");
    const fenced = "Intro\n\n```\nRelates to ENG-7\n```\n\nMore";
    expect(composeBodyWithJiraRefs(fenced, [jira("ENG-7")])).toBe(
      `${fenced}\n\nRelates to ENG-7`,
    );
    // A typed lowercase key is no key a forge links, so it never counts.
    const lower = "Intro\n\nRelates to abc-12\n\nMore";
    expect(composeBodyWithJiraRefs(lower, [jira("ABC-12")])).toBe(
      `${lower}\n\nRelates to ABC-12`,
    );
    expect(composeBodyWithJiraRefs("Relates to abc-12", [jira("ABC-12")])).toBe(
      "Relates to ABC-12",
    );
  });
});
