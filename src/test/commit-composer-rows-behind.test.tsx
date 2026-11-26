import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DIFF_LINE_CAP } from "@/features/diff/cap-diff";
import type { DiffLineAnchor } from "@/features/diff/DiffSurface";
import { CommitDetailView } from "@/features/history/CommitDetailView";
import { COMMIT_LOADING_REASON } from "@/features/pulls/CommitComments";
import { PrCommitDetail } from "@/features/pulls/PrCommitDetail";
import {
  commitOnRemote,
  forgeCommitComments,
  forgeCommitDiff,
  forgeCommitFirstParent,
  forgePrCommitDiff,
  forgeStatus,
  ghCommitAuthorAvatars,
  gitCommitDetails,
  gitCommitFileDiff,
  gitCommitFiles,
  gitFileBase64,
  gitLog,
  gitObjectsPresent,
  gitStatus,
  readRepoBranchRules,
} from "@/lib/git/api";
import { repoKeys } from "@/lib/git/queries";
import type { ForgeStatus, PrCommitOut, RepoStatus } from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { stubCanvas } from "./canvas-stub";

/** A render-time suspension only the drill-in's deferred render reaches: the
 *  anchors built while armed suspend, and the committed rows keep the anchors
 *  built before. */
const gate = vi.hoisted(() => ({
  armed: false,
  promise: null as Promise<void> | null,
  release: (): void => undefined,
  /** Settles once a render first reaches the armed gate. */
  entered: Promise.resolve(),
  enter: (): void => undefined,
}));

const writes = vi.hoisted(() => ({
  commit: vi.fn(async (_vars: unknown) => undefined),
}));

// Each anchor list the real hook builds gets one extra anchor on new line 1,
// fixed when the list is first seen: quiet before `arm()`, suspending after.
vi.mock("@/features/pulls/CommitComments", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/pulls/CommitComments")>();
  const seen = new WeakMap<DiffLineAnchor[], DiffLineAnchor[]>();
  return {
    ...actual,
    useCommitLineAnchors: (
      ...args: Parameters<typeof actual.useCommitLineAnchors>
    ) => {
      const real = actual.useCommitLineAnchors(...args);
      let anchors = seen.get(real.anchors);
      if (anchors === undefined) {
        anchors = [
          ...real.anchors,
          {
            side: "new" as const,
            line: 1,
            items: [gate.armed ? "gate:suspend" : "gate:quiet"],
          },
        ];
        seen.set(real.anchors, anchors);
      }
      return {
        anchors,
        renderAnchor: (a: DiffLineAnchor) => {
          if (a.items[0] === "gate:suspend") return <SuspendWhileArmed />;
          if (a.items[0] === "gate:quiet") return null;
          return real.renderAnchor(a);
        },
      };
    },
  };
});

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  commitOnRemote: vi.fn(),
  forgeCommitComments: vi.fn(),
  forgeCommitDiff: vi.fn(),
  forgeCommitFirstParent: vi.fn(),
  forgePrCommitDiff: vi.fn(),
  forgeStatus: vi.fn(),
  ghCommitAuthorAvatars: vi.fn(),
  gitCommitDetails: vi.fn(),
  gitCommitFileDiff: vi.fn(),
  gitCommitFiles: vi.fn(),
  gitFileBase64: vi.fn(),
  gitLog: vi.fn(),
  gitObjectsPresent: vi.fn(),
  gitStatus: vi.fn(),
  readRepoBranchRules: vi.fn(),
}));
vi.mock("@/lib/git/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/queries")>()),
  useCreateCommitComment: () => ({
    mutateAsync: writes.commit,
    isPending: false,
  }),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/use-container-width", () => ({
  useContainerWidth: () => [() => undefined, null],
}));

Element.prototype.scrollIntoView = vi.fn();

function arm() {
  gate.entered = new Promise<void>((resolve) => {
    gate.enter = resolve;
  });
  gate.promise = new Promise<void>((resolve) => {
    gate.release = () => {
      gate.armed = false;
      resolve();
    };
  });
  gate.armed = true;
}

function SuspendWhileArmed(): null {
  if (gate.armed && gate.promise) {
    gate.enter();
    throw gate.promise;
  }
  return null;
}

beforeAll(stubCanvas);
beforeEach(() => {
  gate.armed = false;
  gate.promise = null;
  writes.commit.mockClear();
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
});
afterEach(() => {
  gate.release();
  cleanup();
  vi.clearAllMocks();
});

/** Non-zero hex, so the oid-width guard never reads a zero run. */
const COMMIT = "abcdef0123".repeat(4);
const ALL_ON = new Proxy({}, { get: () => true });
const PATH = "src/keep.txt";
const HEAD = `diff --git a/${PATH} b/${PATH}\n--- a/${PATH}\n+++ b/${PATH}\n`;
/** Lines 1-6 of the file, line 2 edited. */
const SMALL = `${HEAD}@@ -1,6 +1,6 @@\n keep 1\n-old 2\n+new 2\n keep 3\n keep 4\n keep 5\n keep 6\n`;
/** SMALL with its line 5 edited: lines 1-4 read as before. */
const FIVE_EDITED = `${HEAD}@@ -1,6 +1,6 @@\n keep 1\n-old 2\n+new 2\n keep 3\n keep 4\n-keep 5\n+five\n keep 6\n`;
const OVER_COUNT = DIFF_LINE_CAP + 20;
/** SMALL with enough lines added inside its one hunk to pass the pane's line
 *  cap, so the capped rows still draw line 150. */
const OVER = `${HEAD}@@ -1,6 +1,${6 + OVER_COUNT} @@\n keep 1\n-old 2\n+new 2\n keep 3\n keep 4\n keep 5\n keep 6\n${Array.from(
  { length: OVER_COUNT },
  (_, i) => `+add ${i}`,
).join("\n")}\n`;

const COMMIT_BOX = /^Comment on Line 2 · /;
const commitBox = () =>
  screen.queryByRole<HTMLTextAreaElement>("textbox", { name: COMMIT_BOX });
/** The line composer's own Comment button (History's pane has another). */
const commentButton = () =>
  within(
    commitBox()?.closest<HTMLElement>("[data-diff-line-widget]") ??
      document.body,
  ).getByRole("button", { name: "Comment" });
const newLine = (n: number) =>
  document.querySelector(`span[data-line-new-num="${n}"]`);

/** Opens the line composer from the unified gutter's "+" on new `line`. */
async function openComposer(line: number) {
  const num = await waitFor(
    () => {
      const cell = newLine(line)?.closest(".diff-line-num");
      expect(cell).toBeTruthy();
      return cell as HTMLElement;
    },
    { timeout: 10_000 },
  );
  fireEvent.mouseOver(num);
  fireEvent.mouseDown(
    num.closest("tr")?.querySelector(".diff-add-widget") as HTMLElement,
  );
  return waitFor(() => {
    const box = commitBox();
    expect(box).toBeTruthy();
    return box as HTMLTextAreaElement;
  });
}

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });

function forge(provider: "github" | "gitlab"): ForgeStatus {
  return {
    provider,
    installed: true,
    authenticated: true,
    repo: "octo/repo",
    host: `${provider}.com`,
    login: "octo",
    capabilities: ALL_ON,
    implemented: ALL_ON,
  } as unknown as ForgeStatus;
}

function renderIn(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return client;
}

/** Comment and Mod+Enter both write nothing while the composer is held, and
 *  the text stays. */
async function expectHeld(user: ReturnType<typeof userEvent.setup>) {
  const held = commentButton();
  expect(held).toHaveAccessibleDescription(COMMIT_LOADING_REASON);
  await user.click(held);
  const box = commitBox() as HTMLTextAreaElement;
  box.focus();
  await user.keyboard("{Control>}{Enter}{/Control}");
  await settle();
  expect(writes.commit).not.toHaveBeenCalled();
  expect(commitBox()).toHaveValue("kept");
}

/** After the paint, Comment carries no reason and one click posts once. */
async function expectPostsOnce(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(commitBox()).toHaveValue("kept"));
  const post = commentButton();
  expect(post).not.toHaveAccessibleDescription(COMMIT_LOADING_REASON);
  await user.click(post);
  expect(writes.commit).toHaveBeenCalledTimes(1);
  expect(writes.commit).toHaveBeenCalledWith(
    expect.objectContaining({ body: "kept", line: 2, path: PATH }),
  );
}

describe("the PR commit drill-in's composer while its slot paints a deferred view", () => {
  it("holds Comment and Mod+Enter with the loading reason until the new rows paint", async () => {
    vi.mocked(forgeStatus).mockResolvedValue(forge("github"));
    vi.mocked(gitObjectsPresent).mockRejectedValue(new Error("offline"));
    vi.mocked(forgeCommitFirstParent).mockResolvedValue(null);
    vi.mocked(forgePrCommitDiff).mockResolvedValue(OVER);
    vi.mocked(forgeCommitComments).mockResolvedValue([]);
    const commit: PrCommitOut = {
      oid: COMMIT,
      headline: "Edit a file",
      date: "2026-11-01T10:00:00Z",
      author: "Ada",
      messageBody: "",
    };
    const client = renderIn(
      <PrCommitDetail
        repoPath="/repo"
        number={7}
        commit={commit}
        onBack={() => undefined}
        canCommentCommits
        remoteLabel="GitHub"
        lens="origin"
      />,
    );
    const user = userEvent.setup();
    const box = await openComposer(2);
    await user.type(box, "kept");
    await waitFor(() => expect(newLine(150)).not.toBeNull());

    arm();
    act(() => {
      client.setQueryData(
        ["repo", "/repo", "pr", "origin", 7, "commit-diff", COMMIT],
        SMALL,
      );
    });
    await gate.entered;
    await settle();
    // The deferred render is suspended: the rows are still the over-cap ones.
    expect(newLine(150)).not.toBeNull();
    await expectHeld(user);

    await act(async () => gate.release());
    await waitFor(() => expect(newLine(150)).toBeNull());
    await expectPostsOnce(user);
    client.clear();
  }, 30_000);
});

describe("History's commit composer while the diff's own rows are behind", () => {
  it("holds Comment and Mod+Enter with the loading reason until the rows catch up", async () => {
    let text = OVER;
    vi.mocked(forgeStatus).mockResolvedValue(forge("gitlab"));
    vi.mocked(commitOnRemote).mockResolvedValue(true);
    vi.mocked(forgeCommitDiff).mockResolvedValue("");
    vi.mocked(readRepoBranchRules).mockResolvedValue(null);
    vi.mocked(ghCommitAuthorAvatars).mockResolvedValue([]);
    vi.mocked(gitLog).mockResolvedValue([]);
    vi.mocked(gitStatus).mockResolvedValue({
      branch: null,
      entries: [],
    } as unknown as RepoStatus);
    vi.mocked(gitCommitDetails).mockResolvedValue({
      hash: COMMIT,
      subject: "Edit a file",
      body: "",
      author: "Ada",
      authorEmail: "ada@example.com",
      date: "2026-11-01T10:00:00Z",
      committerDate: "2026-11-01T10:00:00Z",
    });
    vi.mocked(gitCommitFiles).mockResolvedValue([
      { path: PATH, added: 1, deleted: 1, isBinary: false, binaryKind: null },
    ]);
    vi.mocked(gitCommitFileDiff).mockImplementation(async (_r, _h, path) => ({
      filePath: path,
      isBinary: false,
      isTruncated: false,
      text,
    }));
    vi.mocked(forgeCommitComments).mockResolvedValue([]);
    // Content mode reads both sides once the diff fits; held until landed.
    const OLD_FILE = "keep 1\nold 2\nkeep 3\nkeep 4\nkeep 5\nkeep 6\n";
    const NEW_FILE = "keep 1\nnew 2\nkeep 3\nkeep 4\nfive\nkeep 6\n";
    const waiting = new Map<string, () => void>();
    vi.mocked(gitFileBase64).mockImplementation(
      (_repo, rev) =>
        new Promise((resolve) => {
          const body = rev === COMMIT ? NEW_FILE : OLD_FILE;
          waiting.set(rev ?? "", () =>
            resolve({
              base64: Buffer.from(body).toString("base64"),
              mime: null,
              tooLarge: false,
              size: body.length,
            }),
          );
        }),
    );
    const client = renderIn(
      <CommitDetailView repoPath="/repo" hash={COMMIT} />,
    );
    const user = userEvent.setup();
    const box = await openComposer(2);
    await user.type(box, "kept");
    expect(gitFileBase64).not.toHaveBeenCalled();

    text = FIVE_EDITED;
    await act(async () => {
      await client.invalidateQueries({
        queryKey: repoKeys.commitFileDiff("/repo", COMMIT, PATH),
      });
    });
    // The content reads start after the rebuild settles, past waitFor's 1 s
    // default on a loaded runner.
    await waitFor(() => expect(waiting.size).toBe(2), { timeout: 10_000 });
    await settle();
    expect(document.body.textContent).not.toContain("five");
    await expectHeld(user);

    await act(async () => {
      for (const land of waiting.values()) land();
    });
    await waitFor(() => expect(document.body.textContent).toContain("five"));
    await expectPostsOnce(user);
    client.clear();
  }, 30_000);
});
