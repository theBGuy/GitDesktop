import { describe, expect, it } from "vitest";
import {
  crossNameCreateSentence,
  withCrossNameGuidance,
} from "@/lib/pulls/cross-name-create";
import { PR_SIGIL, prRef, prRefForNoun } from "@/lib/pulls/pr-state";

describe("prRef", () => {
  it("is # everywhere but GitLab, an unknown provider included", () => {
    expect(prRef("github", 12)).toBe("#12");
    expect(prRef("bitbucket", 12)).toBe("#12");
    expect(prRef(null, 12)).toBe("#12");
    expect(prRef(undefined, 12)).toBe("#12");
    expect(prRef("gitlab", 12)).toBe("!12");
  });

  it("prRefForNoun gives ! for merge request only", () => {
    expect(prRefForNoun("merge request", 3)).toBe("!3");
    expect(prRefForNoun("pull request", 3)).toBe("#3");
  });

  it("the sigil table is total", () => {
    expect(PR_SIGIL).toEqual({ github: "#", gitlab: "!", bitbucket: "#" });
  });
});

const MISMATCH = {
  kind: "pushUpstreamNameMismatch",
  message:
    "Push blocked — new tracks origin/old, which has a different name. Choose where to push from the Push menu.",
  branch: "new",
  remote: "origin",
  remoteBranch: "old",
};

describe("withCrossNameGuidance", () => {
  it("keeps the backend line for a checked-out head", () => {
    expect(withCrossNameGuidance(MISMATCH, true)).toBe(MISMATCH);
    expect(crossNameCreateSentence(MISMATCH, true)).toBe(MISMATCH.message);
  });

  it("points any other head at its row menu", () => {
    expect(withCrossNameGuidance(MISMATCH, false)).toEqual({
      ...MISMATCH,
      message:
        "Push blocked — new tracks origin/old, which has a different name. Choose where to push it from new's menu in the branch list.",
    });
  });

  it("returns anything else as it is", () => {
    const other = { kind: "git", message: "boom" };
    expect(withCrossNameGuidance(other, false)).toBe(other);
    const partial = { ...MISMATCH, remoteBranch: undefined };
    expect(withCrossNameGuidance(partial, false)).toBe(partial);
    expect(withCrossNameGuidance("text", false)).toBe("text");
    expect(withCrossNameGuidance(null, false)).toBe(null);
  });
});
