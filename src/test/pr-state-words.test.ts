import { describe, expect, it } from "vitest";
import { prPill, prStateWord } from "@/lib/pulls/pr-state";

describe("pull request state words", () => {
  it("words MERGING as being merged, for both nouns and either draft flag", () => {
    expect(prPill("MERGING", false, "merge request").word).toBe(
      "Merge request being merged",
    );
    expect(prPill("MERGING", false, "pull request").word).toBe(
      "Pull request being merged",
    );
    expect(prPill("MERGING", true, "merge request").word).toBe(
      "Merge request being merged",
    );
  });

  it("keeps the OPEN, MERGED and CLOSED words", () => {
    for (const noun of ["pull request", "merge request"] as const)
      for (const [state, label] of [
        ["OPEN", "Open"],
        ["MERGED", "Merged"],
        ["CLOSED", "Closed"],
      ])
        expect(prPill(state, false, noun).word).toBe(`${label} ${noun}`);
  });

  it("gives each state its badge word, and an unknown state its own", () => {
    expect(["OPEN", "MERGED", "CLOSED", "MERGING"].map(prStateWord)).toEqual([
      "open",
      "merged",
      "closed",
      "merging",
    ]);
    expect(prStateWord("WEIRD")).toBe("weird");
  });
});
