import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRANCH_PUSHED_DISCLOSURE,
  BRANCH_PUSHED_FAILED_LEAD,
  presentError,
} from "@/lib/error-summary";
import { emitNotification } from "@/lib/notifications/emit";
import { notifyPrCreateFailed } from "@/lib/notifications/pr-create-failed";

vi.mock("@/lib/notifications/emit", () => ({ emitNotification: vi.fn() }));

const emit = vi.mocked(emitNotification);

const NOUNS = ["pull request", "merge request"] as const;

/** The forge whose CLI creates each noun, so a merge request never names GitHub. */
const NOUN_HOSTS: Record<(typeof NOUNS)[number], string> = {
  "pull request": "GitHub",
  "merge request": "GitLab",
};

/** A New pull request / merge request create that timed out, as Rust's
 *  `write_timed_out` words it. */
const landed = (noun: (typeof NOUNS)[number]) => {
  const host = NOUN_HOSTS[noun];
  return {
    kind: "timeout",
    message: `${host} didn't answer in time. The branch was pushed, and the ${noun} may still have been created. Check for it before trying again.\n${host} CLI timed out after 150s.`,
  };
};

/** A create the forge accepted whose reply couldn't be read, as Rust's
 *  `created_reply_unreadable` words it after a branch push. */
const unreadReply = (kind: string, host: string, noun: string) => ({
  kind,
  message: `The branch was pushed. ${host} accepted the request but its reply couldn't be read, so the ${noun} may already exist. Check before creating it again.`,
});

const UNREAD_ROWS = [
  {
    error: unreadReply("glab", "GitLab", "merge request"),
    noun: "merge request",
  },
  {
    error: unreadReply("bitbucket", "Bitbucket", "pull request"),
    noun: "pull request",
  },
];

/** The row title, OS title and subtitle of the one notification `error` emits. */
function emitted(noun: string, error: unknown) {
  emit.mockClear();
  notifyPrCreateFailed({
    repoPath: "C:/r/demo",
    head: "my-branch",
    noun,
    error,
  });
  expect(emit).toHaveBeenCalledTimes(1);
  const input = emit.mock.calls[0][0] as {
    row: { title: string; subtitle?: string };
    os?: { title: string };
  };
  return {
    title: input.row.title,
    osTitle: input.os?.title,
    subtitle: input.row.subtitle,
  };
}

describe("notifyPrCreateFailed", () => {
  beforeEach(() => emit.mockClear());

  it.each(NOUNS)("says a timed-out %s may have been created", (noun) => {
    const error = landed(noun);
    const got = emitted(noun, error);
    const title = `The ${noun} for my-branch may have been created`;
    expect(got).toEqual({
      title,
      osTitle: title,
      subtitle: presentError(error).summary,
    });
  });

  it.each(UNREAD_ROWS)(
    "says a $noun with an unreadable reply may have been created ($error.kind)",
    ({ error, noun }) => {
      const got = emitted(noun, error);
      const title = `The ${noun} for my-branch may have been created`;
      expect(got).toEqual({
        title,
        osTitle: title,
        subtitle: error.message,
      });
      expect(presentError(error).summary).toBe(error.message);
    },
  );

  it("denies the unreadable-reply rows once the title ignores mayHaveLanded", async () => {
    // Control: the same rows under a title rule that never hedges.
    vi.resetModules();
    vi.doMock("@/lib/error-summary", async (original) => ({
      ...(await original<typeof import("@/lib/error-summary")>()),
      mayHaveLanded: () => false,
    }));
    try {
      const { emitNotification: mockedEmit } = await import(
        "@/lib/notifications/emit"
      );
      const { notifyPrCreateFailed: ignoring } = await import(
        "@/lib/notifications/pr-create-failed"
      );
      const spy = vi.mocked(mockedEmit);
      for (const { error, noun } of UNREAD_ROWS) {
        spy.mockClear();
        ignoring({ repoPath: "C:/r/demo", head: "my-branch", noun, error });
        const input = spy.mock.calls[0][0] as { row: { title: string } };
        expect(input.row.title).toBe(
          `The ${noun} for my-branch wasn't created`,
        );
      }
    } finally {
      vi.doUnmock("@/lib/error-summary");
      vi.resetModules();
    }
  });

  it.each(NOUNS)("keeps wasn't created for any other %s failure", (noun) => {
    const errors = [
      { kind: "gh", message: "GraphQL: Head sha can't be blank" },
      { kind: "timeout", message: "git operation timed out after 120s" },
      {
        kind: "bitbucket",
        message:
          "The branch was pushed, but creating the pull request failed: Bitbucket API error (400): source branch not found",
      },
      new Error("boom"),
    ];
    for (const error of errors) {
      const got = emitted(noun, error);
      const title = `The ${noun} for my-branch wasn't created`;
      expect(got).toEqual({
        title,
        osTitle: title,
        subtitle: presentError(error).summary,
      });
    }
  });

  it.each(NOUNS)(
    "says pushing the branch failed for a git-kind %s failure",
    (noun) => {
      const error = PUSH_REJECTED;
      const got = emitted(noun, error);
      const title = `Pushing my-branch failed, so the ${noun} wasn't created`;
      expect(got).toEqual({
        title,
        osTitle: title,
        subtitle: presentError(error).summary,
      });
    },
  );

  it.each(NOUNS)(
    "keeps wasn't created for a %s failing after its push, a bare timeout, a missing CLI and each push refusal",
    (noun) => {
      for (const error of NOT_AT_PUSH(noun)) {
        const got = emitted(noun, error);
        expect(got.title).toBe(`The ${noun} for my-branch wasn't created`);
        expect(got.osTitle).toBe(got.title);
      }
    },
  );
});

/** A rejected push as `run_git_mutating_with_creds_for_branch` returns it. */
const PUSH_REJECTED = {
  kind: "git",
  code: 1,
  message: "git push failed",
  stderr:
    "To github.com:o/r.git\n ! [rejected]        my-branch -> my-branch (fetch first)\nerror: failed to push some refs to 'github.com:o/r.git'\nhint: Updates were rejected because the remote contains work that you do not",
};

/** Rejections that are not the push failing: the forge-kind leads every
 *  create route wraps an after-push failure in, a bare timeout, a missing
 *  GitHub CLI, and the push refusals, which carry kinds of their own. */
const NOT_AT_PUSH = (noun: string) => [
  {
    kind: "gh",
    message: `${BRANCH_PUSHED_DISCLOSURE}GitHub refused it: Head sha can't be blank`,
  },
  {
    kind: "glab",
    message: `${BRANCH_PUSHED_FAILED_LEAD}${noun} failed: 409 Conflict`,
  },
  {
    kind: "bitbucket",
    message: `${BRANCH_PUSHED_FAILED_LEAD}${noun} failed: Bitbucket API error (400): source branch not found`,
  },
  { kind: "timeout", message: "git operation timed out after 120s" },
  { kind: "ghNotFound", message: "GitHub CLI not found" },
  {
    kind: "branchKeptLocal",
    message: "my-branch is kept local",
    branch: "my-branch",
  },
  {
    kind: "branchIsAgentSession",
    message: "my-branch is an agent session branch",
    branch: "my-branch",
  },
  {
    kind: "pushRemoteIsMirror",
    message: "origin is a mirror",
    remote: "origin",
  },
];
