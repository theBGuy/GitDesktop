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
    const out = composeBodyWithRefs("Words\n\nCloses #5\nRelates to PROJ-1", [
      chip(5),
    ]);
    expect(out).toBe("Words\n\nRelates to PROJ-1\n\nCloses #5");
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
