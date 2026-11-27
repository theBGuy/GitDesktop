import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Branch, BranchHead } from "@/lib/git/types";
import {
  type CrossNameRouting,
  PUSH_MENU_REMEDY,
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
const LEAD =
  "Push blocked — new tracks origin/old, which has a different name.";
const ROW_LINE = `${LEAD} Choose where to push it from new's menu in the branch list.`;
const TERMINAL_LINE = `${LEAD} Publish it under its own name first, for example with git push -u origin refs/heads/new:refs/heads/new in a terminal.`;

/** The renamed copy's row: tracks origin/old, a named push lands back on it. */
const row = (over: Partial<Branch> = {}): Branch =>
  ({
    name: "new",
    isCurrent: false,
    upstream: "origin/old",
    lastCommitDate: "",
    archived: false,
    upstreamAhead: 0,
    upstreamBehind: 0,
    upstreamGone: false,
    upstreamRemote: "origin",
    upstreamRemoteRef: "refs/heads/old",
    keepLocal: false,
    upstreamIsRemoteDefault: false,
    namedPushRemote: "origin",
    namedPushBranch: "old",
    namedPushRefused: false,
    ...over,
  }) as Branch;

const head = (over: Partial<BranchHead> = {}): BranchHead => ({
  name: "new",
  detached: false,
  oid: "a".repeat(40),
  upstream: "origin/old",
  ahead: 0,
  behind: 0,
  upstreamGone: false,
  upstreamRemote: "origin",
  upstreamBranch: "old",
  pushNameMismatch: true,
  upstreamIsRemoteDefault: false,
  pushRemote: null,
  pushBranch: null,
  ...over,
});

const routing = (over: Partial<CrossNameRouting> = {}): CrossNameRouting => ({
  head: undefined,
  branches: [row()],
  remoteNames: ["origin"],
  ...over,
});

const guided = (r: CrossNameRouting) =>
  (withCrossNameGuidance(MISMATCH, r) as { message: string }).message;

describe("withCrossNameGuidance", () => {
  it("the backend's line still ends with the remedy it swaps out", () => {
    const source = readFileSync("src-tauri/src/error.rs", "utf8");
    const literal = source.match(
      /#\[error\("((?:[^"\\]|\\.)*)"\)\]\s*PushUpstreamNameMismatch \{/,
    )?.[1];
    expect(literal).toBeDefined();
    expect(literal?.endsWith(` ${PUSH_MENU_REMEDY}`)).toBe(true);
  });

  it("keeps the backend line for a checked-out head whose sync bar shows the Push menu", () => {
    expect(
      withCrossNameGuidance(
        MISMATCH,
        routing({ head: head(), branches: [row({ isCurrent: true })] }),
      ),
    ).toBe(MISMATCH);
  });

  it("points a head with the row's publish item at its row menu", () => {
    // Checked out, but git would not refuse a bare push: no Push menu.
    expect(
      guided(
        routing({
          head: head({ pushNameMismatch: false }),
          branches: [row({ isCurrent: true })],
        }),
      ),
    ).toBe(ROW_LINE);
    // Not checked out: HEAD's flag says nothing about this branch.
    expect(guided(routing({ head: head({ name: "main" }) }))).toBe(ROW_LINE);
    // Routing unknown or refused: the row still offers the item.
    expect(
      guided(
        routing({
          branches: [row({ namedPushRemote: null, namedPushBranch: null })],
        }),
      ),
    ).toBe(ROW_LINE);
    expect(
      guided(routing({ branches: [row({ namedPushRefused: true })] })),
    ).toBe(ROW_LINE);
  });

  it("names the terminal when neither menu offers a destination", () => {
    // The row's push routes to another remote, so the row has no publish item.
    expect(
      guided(
        routing({
          branches: [row({ namedPushRemote: "fork", namedPushBranch: "new" })],
        }),
      ),
    ).toBe(TERMINAL_LINE);
    // Routed to origin under its own name: still off the upstream.
    expect(
      guided(
        routing({
          branches: [
            row({ namedPushRemote: "origin", namedPushBranch: "new" }),
          ],
        }),
      ),
    ).toBe(TERMINAL_LINE);
    // Nothing read yet, no listed row, or an unconfigured remote.
    expect(
      guided({ head: undefined, branches: undefined, remoteNames: undefined }),
    ).toBe(TERMINAL_LINE);
    expect(guided(routing({ branches: [] }))).toBe(TERMINAL_LINE);
    expect(guided(routing({ remoteNames: [] }))).toBe(TERMINAL_LINE);
    // A head flag over a gone upstream draws no menu either.
    expect(
      guided(
        routing({
          head: head({ upstreamGone: true }),
          branches: [row({ name: "other" })],
        }),
      ),
    ).toBe(TERMINAL_LINE);
  });

  it("a session branch's row is filtered from the list, so it gets the terminal", () => {
    const name = "gd/session/x";
    const out = withCrossNameGuidance(
      {
        ...MISMATCH,
        branch: name,
        message: `Push blocked — ${name} tracks origin/old, which has a different name. ${PUSH_MENU_REMEDY}`,
      },
      routing({ branches: [row({ name })] }),
    ) as { message: string };
    expect(out.message).toBe(
      `Push blocked — ${name} tracks origin/old, which has a different name. Publish it under its own name first, for example with git push -u origin refs/heads/${name}:refs/heads/${name} in a terminal.`,
    );
  });

  it.each(["+new", "new name", "new$x"])(
    "a name a shell would read otherwise (%s) gets the terminal remedy without a command",
    (name) => {
      const out = withCrossNameGuidance(
        {
          ...MISMATCH,
          branch: name,
          message: `Push blocked — ${name} tracks origin/old, which has a different name. ${PUSH_MENU_REMEDY}`,
        },
        routing({ branches: [] }),
      ) as { message: string };
      expect(out.message).toBe(
        `Push blocked — ${name} tracks origin/old, which has a different name. Publish it under its own name first, by pushing it to origin from a terminal.`,
      );
    },
  );

  it("returns anything else as it is", () => {
    const other = { kind: "git", message: "boom" };
    expect(withCrossNameGuidance(other, routing())).toBe(other);
    const partial = { ...MISMATCH, branch: undefined };
    expect(withCrossNameGuidance(partial, routing())).toBe(partial);
    const reworded = { ...MISMATCH, message: `${LEAD} Push it elsewhere.` };
    expect(withCrossNameGuidance(reworded, routing())).toBe(reworded);
    expect(withCrossNameGuidance("text", routing())).toBe("text");
    expect(withCrossNameGuidance(null, routing())).toBe(null);
  });
});
