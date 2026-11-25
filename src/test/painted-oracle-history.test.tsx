// Matrix A's oracle on History's commit view, over the real diff pane.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useDeferredValue, useLayoutEffect, useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CommitDetailView } from "@/features/history/CommitDetailView";
import {
  commitOnRemote,
  type FileBytes,
  forgeCommitComments,
  forgeCommitDiff,
  forgeStatus,
  ghCommitAuthorAvatars,
  gitCommitDetails,
  gitCommitFileDiff,
  gitCommitFiles,
  gitFileBase64,
  gitLog,
  gitStatus,
  readRepoBranchRules,
} from "@/lib/git/api";
import { repoKeys } from "@/lib/git/queries";
import type { ForgeStatus, RepoStatus } from "@/lib/git/types";
import { settingsKeys } from "@/lib/settings/queries";
import { stubCanvas } from "./canvas-stub";
import {
  COMMIT,
  comment,
  defineOracleSuite,
  expectOnce,
  listNote,
  type MountOpts,
  mixed,
  newLine,
  OracleFrame,
  type OracleHost,
  placeOf,
  recordClient,
  settingsOnDisk,
  settle,
  watchPainted,
} from "./painted-oracle";

// The diff chunk's load waits on this gate, so a test can hold the lazy
// pane's Suspense fallback up.
const chunk = vi.hoisted(() => ({ gate: Promise.resolve() }));
vi.mock("@/features/diff/DiffSurface", async (importOriginal) => {
  await chunk.gate;
  return importOriginal();
});
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  commitOnRemote: vi.fn(),
  forgeCommitComments: vi.fn(),
  forgeCommitDiff: vi.fn(),
  forgeStatus: vi.fn(),
  ghCommitAuthorAvatars: vi.fn(),
  gitCommitDetails: vi.fn(),
  gitCommitFileDiff: vi.fn(),
  gitCommitFiles: vi.fn(),
  gitFileBase64: vi.fn(),
  gitLog: vi.fn(),
  gitStatus: vi.fn(),
  readRepoBranchRules: vi.fn(),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
  saveSettingsPatch: vi.fn(),
}));
vi.mock("@/lib/use-container-width", () => ({
  useContainerWidth: () => [() => undefined, null],
}));
vi.mock("@/features/diff/shiki-highlighter", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/diff/shiki-highlighter")>();
  return {
    ...actual,
    ensureBuiltinShikiLang: (id: string) =>
      (globalThis as { __paintedOracleGrammar?: Promise<boolean> })
        .__paintedOracleGrammar ?? actual.ensureBuiltinShikiLang(id),
  };
});
// A body the test names throws inside a diff pane slot only, so the pane's
// error fallback replaces the rows while the list still renders it.
vi.mock("@/components/markdown/markdown", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/markdown/markdown")>();
  const { useInDiffPaneSlot } = await import("@/features/diff/diff-pane-hold");
  function Markdown(props: Parameters<typeof actual.Markdown>[0]) {
    const inPane = useInDiffPaneSlot();
    const boom = (globalThis as { __paintedOracleBoom?: string | null })
      .__paintedOracleBoom;
    if (inPane && boom && props.children.includes(boom))
      throw new Error("renderer failed");
    return <actual.Markdown {...props} />;
  }
  return { ...actual, Markdown };
});

// jsdom has none; the commit composer's editor scrolls itself into view.
Element.prototype.scrollIntoView = vi.fn();

beforeAll(stubCanvas);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  document.body.replaceChildren();
});

const ALL_ON = new Proxy({}, { get: () => true });
const bytes = (text: string): FileBytes => ({
  base64: Buffer.from(text).toString("base64"),
  mime: null,
  tooLarge: false,
  size: text.length,
});
const never = <T,>() => new Promise<T>(() => undefined);
const LONG_WAIT = { timeout: 10_000 };

const host: OracleHost = {
  name: "History commit view",
  listsWithoutDiff: true,
  holdChunk() {
    let release = () => undefined as void;
    chunk.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  },
  async failPatchRefetch(client) {
    const key = ["repo", "/repo", "commit", COMMIT, "remote-diff"];
    vi.mocked(forgeCommitDiff).mockRejectedValue(new Error("offline"));
    await act(() => client.refetchQueries({ queryKey: key }));
    const state = client.getQueryState(key);
    expect(state?.status).toBe("error");
    expect(state?.data).toBeTruthy();
  },
  mount(o: MountOpts) {
    const client = prepare(o);
    render(
      <QueryClientProvider client={client}>
        <OracleFrame>
          <CommitDetailView repoPath="/repo" hash={COMMIT} />
        </OracleFrame>
      </QueryClientProvider>,
    );
    return recordClient(host, client);
  },
};

/** The mocks and client a mount runs over. */
function prepare(o: MountOpts): QueryClient {
  const settings = settingsOnDisk(o.hide);
  // GitLab anchors by plain line, so no forge patch is read; GitHub walks
  // a position against the commit's forge patch.
  const forge = o.forge ?? "gitlab";
  vi.mocked(forgeStatus).mockResolvedValue({
    provider: forge,
    installed: true,
    authenticated: true,
    repo: "octo/repo",
    host: `${forge}.com`,
    login: "octo",
    capabilities: ALL_ON,
    implemented: ALL_ON,
  } as unknown as ForgeStatus);
  vi.mocked(commitOnRemote).mockResolvedValue(true);
  vi.mocked(forgeCommitDiff).mockResolvedValue(
    o.files.map((f) => f.patch).join(""),
  );
  vi.mocked(readRepoBranchRules).mockResolvedValue(null);
  vi.mocked(ghCommitAuthorAvatars).mockResolvedValue([]);
  vi.mocked(gitLog).mockResolvedValue([]);
  vi.mocked(gitStatus).mockResolvedValue({
    branch: null,
    entries: [],
  } as unknown as RepoStatus);
  vi.mocked(gitCommitDetails).mockResolvedValue({
    hash: COMMIT,
    subject: "Re-indent f",
    body: "",
    author: "Ada",
    authorEmail: "ada@example.com",
    date: "2026-11-01T10:00:00Z",
    committerDate: "2026-11-01T10:00:00Z",
  });
  vi.mocked(gitCommitFiles).mockResolvedValue(
    o.files.map((f) => ({
      path: f.path,
      added: 1,
      deleted: 1,
      isBinary: false,
      binaryKind: null,
    })),
  );
  const file = (path: string) => {
    const f = o.files.find((x) => x.path === path);
    if (!f) throw new Error(`no fixture for ${path}`);
    return f;
  };
  vi.mocked(gitCommitFileDiff).mockImplementation((_r, _h, path, iw) => {
    if (o.diff === "pending") return never();
    if (o.diff === "error")
      return Promise.reject(new Error("diff unavailable"));
    const f = file(path);
    const head = f.patch.slice(0, f.patch.indexOf("@@ "));
    return Promise.resolve({
      filePath: path,
      isBinary: false,
      isTruncated: false,
      text: iw ? head + f.hunks : f.patch,
    });
  });
  vi.mocked(gitFileBase64).mockImplementation(async (_r, rev, path) => {
    if (o.reads === "fail") throw new Error("no objects");
    return bytes(rev?.endsWith("~1") ? file(path).old : file(path).next);
  });
  vi.mocked(forgeCommitComments).mockResolvedValue(o.comments);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, settings);
  return client;
}

defineOracleSuite(host);

const COMMIT_B = "bcdef01234".repeat(4);
const SUBJECT_B = "Move f's late line";
/** Commit B's f.txt: one change on line 30. */
const diffOfB = (path: string) => {
  const a = mixed(path).patch;
  return {
    filePath: path,
    isBinary: false,
    isTruncated: false,
    text: `${a.slice(0, a.indexOf("@@ "))}@@ -30 +30 @@\n-p\n+q\n`,
  };
};

describe("History commit view: a commit switch while the header lags", () => {
  it("keeps each comment once while the list stops judging the old commit's notes", async () => {
    const F = "On line 4 of f";
    const client = prepare({
      hide: false,
      files: [mixed("f.txt")],
      comments: [],
    });
    const details = await gitCommitDetails("/repo", COMMIT);
    // The selected commit's details never land; its file list is cached (a
    // hover prefetch), so the diff may already be that commit's, which lacks
    // the comment's line: judged against it, the comment would read unplaced.
    vi.mocked(gitCommitDetails).mockImplementation((_r, hash) =>
      hash === COMMIT ? Promise.resolve(details) : never(),
    );
    const readA = vi.mocked(gitCommitFileDiff).getMockImplementation();
    vi.mocked(gitCommitFileDiff).mockImplementation((r, hash, path, iw) =>
      hash === COMMIT_B
        ? Promise.resolve(diffOfB(path))
        : (readA as typeof gitCommitFileDiff)(r, hash, path, iw),
    );
    vi.mocked(forgeCommitComments).mockImplementation(async (_r, sha) =>
      sha === COMMIT ? [comment("f.txt", 4, F)] : [],
    );
    client.setQueryData(
      repoKeys.commitFiles("/repo", COMMIT_B),
      await gitCommitFiles("/repo", COMMIT_B),
    );
    let select: (hash: string) => void = () => undefined;
    // As RepositoryView feeds the view: through a deferred value.
    function History() {
      const [hash, setHash] = useState(COMMIT);
      useLayoutEffect(() => {
        select = setHash;
      });
      return (
        <CommitDetailView repoPath="/repo" hash={useDeferredValue(hash)} />
      );
    }
    render(
      <QueryClientProvider client={client}>
        <History />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(placeOf(F)).toBe("inline"), LONG_WAIT);
    await settle();
    const watch = watchPainted([F]);
    // A list press, outside act: each render lands in its own task.
    select(COMMIT_B);
    await waitFor(() => expect(placeOf(F)).toBe("listed"), LONG_WAIT);
    await settle();
    watch.stop();
    expect(watch.painted).toEqual([]);
    expectOnce("header lagging", [F]);
    // Listed as the painted file's row, with no note.
    expect(listNote("f.txt:4")).toBe("");
    // Once the paint is B's, its rows draw line 30, not the comment's line 4.
    await waitFor(() => expect(newLine(30)).not.toBeNull(), LONG_WAIT);
    await settle();
    expectOnce("B's rows, header lagging", [F]);
    expect(listNote("f.txt:4")).toBe("");
  }, 30_000);
});

describe("History commit view: a switch whose diff still serves the previous commit", () => {
  it("judges no comment of the new commit against the previous commit's paint", async () => {
    const LATE = "On line 30 of f";
    const client = prepare({
      hide: false,
      files: [mixed("f.txt")],
      comments: [],
    });
    // B's details, file list and comments land; B's diff never answers, so the
    // pane keeps A's same-path diff as B's placeholder.
    const details = await gitCommitDetails("/repo", COMMIT);
    vi.mocked(gitCommitDetails).mockImplementation(async (_r, hash) =>
      hash === COMMIT_B ? { ...details, hash, subject: SUBJECT_B } : details,
    );
    const readA = vi.mocked(gitCommitFileDiff).getMockImplementation();
    vi.mocked(gitCommitFileDiff).mockImplementation((r, hash, path, iw) =>
      hash === COMMIT_B
        ? never()
        : (readA as typeof gitCommitFileDiff)(r, hash, path, iw),
    );
    vi.mocked(forgeCommitComments).mockImplementation(async (_r, sha) =>
      sha === COMMIT_B ? [comment("f.txt", 30, LATE)] : [],
    );
    let select: (hash: string) => void = () => undefined;
    function History() {
      const [hash, setHash] = useState(COMMIT);
      useLayoutEffect(() => {
        select = setHash;
      });
      return <CommitDetailView repoPath="/repo" hash={hash} />;
    }
    render(
      <QueryClientProvider client={client}>
        <History />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(newLine(4)).not.toBeNull(), LONG_WAIT);
    await settle();
    act(() => select(COMMIT_B));
    await screen.findByText(LATE, undefined, LONG_WAIT);
    await settle();
    // B's details landed: the header shows B.
    expect(
      screen.getByRole("heading", { level: 2, name: SUBJECT_B }),
    ).toBeTruthy();
    // Still A's rows, which hold no line 30.
    expect(newLine(4)).not.toBeNull();
    expectOnce("B's comments over A's paint", [LATE]);
    expect(placeOf(LATE)).toBe("listed");
    expect(listNote("f.txt:30")).toBe("");
  }, 30_000);
});

describe("History commit view: a cached diff of the selected commit under the previous header", () => {
  it("anchors none of the shown commit's comments on the selected commit's rows", async () => {
    const F = "On line 4 of f";
    // Hunk-only rows, so each commit's line 4 shows its own patch text.
    const client = prepare({
      hide: false,
      reads: "fail",
      files: [mixed("f.txt")],
      comments: [],
    });
    const details = await gitCommitDetails("/repo", COMMIT);
    // B's details and file list never land, so A's header, file list and
    // comments stay; B's same-path diff is cached (a hover prefetch), so the
    // slot's read serves it though its fetch is disabled.
    vi.mocked(gitCommitDetails).mockImplementation((_r, hash) =>
      hash === COMMIT ? Promise.resolve(details) : never(),
    );
    vi.mocked(gitCommitFiles).mockImplementation((_r, hash) =>
      hash === COMMIT
        ? Promise.resolve([
            {
              path: "f.txt",
              added: 1,
              deleted: 1,
              isBinary: false,
              binaryKind: null,
            },
          ])
        : never(),
    );
    vi.mocked(forgeCommitComments).mockImplementation(async (_r, sha) =>
      sha === COMMIT ? [comment("f.txt", 4, F)] : [],
    );
    const a = mixed("f.txt").patch;
    client.setQueryData(
      [...repoKeys.commitFileDiff("/repo", COMMIT_B, "f.txt"), false],
      {
        filePath: "f.txt",
        isBinary: false,
        isTruncated: false,
        whitespaceHidden: false,
        whitespaceOnly: false,
        // B draws a line 4 of its own.
        text: `${a.slice(0, a.indexOf("@@ "))}@@ -4 +4 @@\n-old4\n+betafour\n`,
      },
    );
    let select: (hash: string) => void = () => undefined;
    function History() {
      const [hash, setHash] = useState(COMMIT);
      useLayoutEffect(() => {
        select = setHash;
      });
      return <CommitDetailView repoPath="/repo" hash={hash} />;
    }
    render(
      <QueryClientProvider client={client}>
        <History />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(placeOf(F)).toBe("inline"), LONG_WAIT);
    await settle();
    act(() => select(COMMIT_B));
    // B's cached rows paint under A's header and comments.
    await waitFor(
      () =>
        expect(newLine(4)?.closest("tr")?.textContent).toContain("betafour"),
      LONG_WAIT,
    );
    await settle();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "Re-indent f",
    );
    expectOnce("A's comments over B's cached rows", [F]);
    expect(placeOf(F)).toBe("listed");
    expect(listNote("f.txt:4")).toBe("");
  }, 30_000);
});
