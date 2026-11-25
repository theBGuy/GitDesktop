import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
import { CommitDetailView } from "@/features/history/CommitDetailView";
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
  gitLog,
  gitObjectsPresent,
  gitStatus,
  readRepoBranchRules,
} from "@/lib/git/api";
import type {
  CommitCommentOut,
  ForgeStatus,
  PrCommitOut,
  RepoStatus,
} from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { stubCanvas } from "./canvas-stub";
import { unmockedCommands } from "./setup";

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
  gitLog: vi.fn(),
  gitObjectsPresent: vi.fn(),
  gitStatus: vi.fn(),
  readRepoBranchRules: vi.fn(),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/use-container-width", () => ({
  useContainerWidth: () => [() => undefined, null],
}));

Element.prototype.scrollIntoView = vi.fn();

beforeAll(stubCanvas);
beforeEach(() => {
  unmockedCommands.length = 0;
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  expect(unmockedCommands).toEqual([]);
});

/** Non-zero hex, so the oid-width guard never reads a zero run. */
const COMMIT = "abcdef0123".repeat(4);
const ALL_ON = new Proxy({}, { get: () => true });
const BODY = "On a late line";
const HEADER =
  "diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n";
// A 300-line added file: past the pane's 200-line cap, so a hunk-only diff
// draws its first lines until Show full diff.
const LONG = `${HEADER}@@ -0,0 +1,300 @@\n${Array.from({ length: 300 }, (_, i) => `+l${i + 1}\n`).join("")}`;
// A 3-line file: a comment on line 50 has no row to draw on.
const SHORT = `${HEADER}@@ -0,0 +1,3 @@\n+a\n+b\n+c\n`;
// A minified-looking first line: the pane shows a placeholder, no rows.
const MEGA = `${HEADER}@@ -0,0 +1,2 @@\n+${"x".repeat(20_001)}\n+short\n`;

const commentOn = (line: number): CommitCommentOut => ({
  id: `c${line}`,
  author: "octo",
  body: BODY,
  createdAt: "2026-11-01T10:00:00Z",
  viewerDidAuthor: false,
  path: "n.txt",
  line,
  startLine: null,
  position: null,
});
const newLine = (n: number) =>
  document.querySelector(`span[data-line-new-num="${n}"]`);
/** Whether the comment renders inline in the diff rather than in the list. */
const inline = () => screen.getByText(BODY).closest("[data-diff-anchor]");

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

/** The PR commit drill-in over a forge patch, with no whole-file reads, so the
 *  diff stays hunk-only and the cap applies. */
function renderPrCommit(patch: string, line: number) {
  vi.mocked(forgeStatus).mockResolvedValue(forge("github"));
  vi.mocked(gitObjectsPresent).mockRejectedValue(new Error("offline"));
  vi.mocked(forgeCommitFirstParent).mockResolvedValue(null);
  vi.mocked(forgePrCommitDiff).mockResolvedValue(patch);
  vi.mocked(forgeCommitComments).mockResolvedValue([commentOn(line)]);
  const commit: PrCommitOut = {
    oid: COMMIT,
    headline: "Add a long file",
    date: "2026-11-01T10:00:00Z",
    author: "Ada",
    messageBody: "",
  };
  return renderIn(
    <PrCommitDetail
      repoPath="/repo"
      number={7}
      commit={commit}
      onBack={() => undefined}
      canCommentCommits={false}
      remoteLabel="GitHub"
      lens="origin"
    />,
  );
}

/** Lists the comment while its line is past the cap, then draws it inline,
 *  once, after Show full diff. */
async function expectListedThenDrawn(line: number) {
  await waitFor(() => expect(newLine(150)).not.toBeNull(), {
    timeout: 10_000,
  });
  expect(newLine(line)).toBeNull();
  await waitFor(() => expect(screen.queryByText(BODY)).not.toBeNull());
  expect(inline()).toBeNull();
  expect(screen.getByText("· inline after Show full diff")).toBeTruthy();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Show full diff" }));
  await waitFor(() => expect(newLine(line)).not.toBeNull());
  await waitFor(() => expect(inline()).not.toBeNull());
  expect(screen.getAllByText(BODY)).toHaveLength(1);
}

describe("a commit comment past the pane's line cap", () => {
  it("is listed on the PR commit view while capped, and drawn once shown in full", async () => {
    const client = renderPrCommit(LONG, 250);
    await expectListedThenDrawn(250);
    client.clear();
  }, 30_000);

  it("is listed in History while capped, and drawn once shown in full", async () => {
    // GitLab anchors by plain line, so no forge patch is read.
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
      subject: "Add a long file",
      body: "",
      author: "Ada",
      authorEmail: "ada@example.com",
      date: "2026-11-01T10:00:00Z",
      committerDate: "2026-11-01T10:00:00Z",
    });
    vi.mocked(gitCommitFiles).mockResolvedValue([
      {
        path: "n.txt",
        added: 300,
        deleted: 0,
        isBinary: false,
        binaryKind: null,
      },
    ]);
    vi.mocked(gitCommitFileDiff).mockImplementation(async (_r, _h, path) => ({
      filePath: path,
      isBinary: false,
      isTruncated: false,
      text: LONG,
    }));
    vi.mocked(forgeCommitComments).mockResolvedValue([commentOn(250)]);
    const client = renderIn(
      <CommitDetailView repoPath="/repo" hash={COMMIT} />,
    );
    await expectListedThenDrawn(250);
    client.clear();
  }, 30_000);

  it("is listed while a mega-line file shows its placeholder", async () => {
    const client = renderPrCommit(MEGA, 2);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Show diff anyway" }),
      ).not.toBeNull(),
    );
    await waitFor(() => expect(screen.queryByText(BODY)).not.toBeNull());
    expect(inline()).toBeNull();
    expect(screen.getByText("· inline after Show diff anyway")).toBeTruthy();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Show diff anyway" }));
    await waitFor(() => expect(inline()).not.toBeNull());
    expect(screen.getAllByText(BODY)).toHaveLength(1);
    client.clear();
  }, 30_000);
});

describe("a listed comment note keeps its leading space", () => {
  // A flex item drops leading white space, so the note span must preserve it.
  const noteSpan = (text: RegExp) =>
    screen.getByText(text, { selector: "span" });

  it("on a step note", async () => {
    const client = renderPrCommit(LONG, 250);
    await waitFor(() => expect(newLine(150)).not.toBeNull(), {
      timeout: 10_000,
    });
    const span = await waitFor(() => noteSpan(/inline after Show full diff/));
    expect(span.textContent).toBe(" · inline after Show full diff");
    expect(span.classList.contains("whitespace-pre")).toBe(true);
    client.clear();
  }, 30_000);

  it("on the couldn't place note", async () => {
    const client = renderPrCommit(SHORT, 50);
    const span = await waitFor(() => noteSpan(/couldn't place in this diff/), {
      timeout: 10_000,
    });
    expect(span.textContent).toBe(" · couldn't place in this diff");
    expect(span.classList.contains("whitespace-pre")).toBe(true);
    client.clear();
  }, 30_000);
});
