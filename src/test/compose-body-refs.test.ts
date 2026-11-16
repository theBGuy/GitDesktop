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
      "CLOSES #12",
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
      "Relates to proj-4",
      "Fixes PROJ-4",
      "- closes Proj-4",
    ]) {
      const text = `Intro\n\n${line}\n\nMore text`;
      expect(composeBodyWithJiraRefs(text, [jira("PROJ-4")])).toBe(text);
    }
    for (const text of ["Relates to PROJ-4 and PROJ-5", "See PROJ-4 first"])
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
