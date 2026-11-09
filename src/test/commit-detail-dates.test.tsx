import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommitDetailView } from "@/features/history/CommitDetailView";
import {
  commitOnRemote,
  forgeCommitComments,
  forgeCommitDiff,
  forgeStatus,
  ghCommitAuthorAvatars,
  gitCommitDetails,
  gitCommitFileDiff,
  gitCommitFiles,
  gitLog,
  gitStatus,
  readRepoBranchRules,
} from "@/lib/git/api";
import type { CommitDetails, ForgeStatus, RepoStatus } from "@/lib/git/types";
import { unmockedCommands } from "./setup";

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
  gitLog: vi.fn(),
  gitStatus: vi.fn(),
  readRepoBranchRules: vi.fn(),
}));
// The meta row is under test, not the diff pane.
vi.mock("@/features/diff/DiffSurfaceLazy", () => ({
  DiffSurface: () => null,
  DiffContent: () => null,
}));

const REPO = "/repo";
/** Non-zero hex, so the oid-width guard never reads a zero run. */
const HASH = "abcdef0123".repeat(4);
/** Far enough back that the shared ticker's `now` never matters. */
const AUTHORED = "2026-01-01T10:00:00Z";

const ALL_ON = new Proxy({}, { get: () => true });

const never = <T,>() => new Promise<T>(() => undefined);

function serve(dates: Pick<CommitDetails, "date" | "committerDate">) {
  vi.mocked(gitCommitDetails).mockResolvedValue({
    hash: HASH,
    subject: "the subject",
    body: "",
    author: "Ada",
    authorEmail: "ada@example.com",
    ...dates,
  });
}

beforeEach(() => {
  unmockedCommands.length = 0;
  vi.mocked(forgeStatus).mockResolvedValue({
    provider: "github",
    installed: true,
    authenticated: true,
    repo: "octo/repo",
    host: "github.com",
    login: "octo",
    capabilities: ALL_ON,
    implemented: ALL_ON,
  } as unknown as ForgeStatus);
  vi.mocked(commitOnRemote).mockResolvedValue(true);
  vi.mocked(forgeCommitDiff).mockResolvedValue("");
  vi.mocked(forgeCommitComments).mockResolvedValue([]);
  vi.mocked(readRepoBranchRules).mockResolvedValue(null);
  vi.mocked(ghCommitAuthorAvatars).mockResolvedValue([]);
  vi.mocked(gitLog).mockResolvedValue([]);
  vi.mocked(gitStatus).mockResolvedValue({
    branch: null,
    entries: [],
  } as unknown as RepoStatus);
  vi.mocked(gitCommitFiles).mockResolvedValue([
    {
      path: "a.txt",
      added: 42,
      deleted: 7,
      isBinary: false,
      binaryKind: null,
    },
  ]);
  vi.mocked(gitCommitFileDiff).mockImplementation(never);
});

afterEach(() => {
  expect(unmockedCommands).toEqual([]);
});

/** Renders the view and returns the meta row's wrapping lane, found through
 *  the actions trigger it holds. */
async function metaLane() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <CommitDetailView repoPath={REPO} hash={HASH} />
    </QueryClientProvider>,
  );
  const actions = await screen.findByRole("button", {
    name: "Commit actions",
  });
  const lane = actions.closest<HTMLElement>(".flex-wrap");
  if (!lane) throw new Error("the actions trigger sits in no wrapping lane");
  return { lane, actions };
}

const times = (lane: HTMLElement) => [...lane.querySelectorAll("time")];
const separators = (lane: HTMLElement) =>
  [...lane.querySelectorAll("span")].filter((s) => s.textContent === "•");

/** Seconds after AUTHORED, as an ISO string. */
const after = (seconds: number) =>
  new Date(Date.parse(AUTHORED) + seconds * 1000).toISOString();

describe("CommitDetailView meta row dates", () => {
  it("shows the author date alone when the committer date is 59 s later", async () => {
    serve({ date: AUTHORED, committerDate: after(59) });
    const { lane } = await metaLane();
    expect(times(lane).map((t) => t.dateTime)).toEqual([AUTHORED]);
    expect(lane.textContent).not.toContain("authored");
    expect(lane.textContent).not.toContain("committed");
  });

  it("names both dates once they are 60 s apart", async () => {
    const committed = after(60);
    serve({ date: AUTHORED, committerDate: committed });
    const { lane } = await metaLane();
    const shown = times(lane);
    expect(shown.map((t) => t.dateTime)).toEqual([AUTHORED, committed]);
    for (const t of shown) expect(t.title).not.toBe("");
    expect(shown[0].parentElement?.textContent).toMatch(/^•authored /);
    expect(shown[1].parentElement?.textContent).toMatch(/^•committed /);
  });

  it("names both dates when the committer date is 60 s EARLIER", async () => {
    const committed = after(-60);
    serve({ date: AUTHORED, committerDate: committed });
    const { lane } = await metaLane();
    expect(times(lane).map((t) => t.dateTime)).toEqual([AUTHORED, committed]);
    expect(lane.textContent).toContain("authored");
  });

  it("reads one instant spelled in two offsets as one date", async () => {
    serve({
      date: "2026-11-01T12:00:00+02:00",
      committerDate: "2026-11-01T10:00:00Z",
    });
    const { lane } = await metaLane();
    expect(times(lane)).toHaveLength(1);
    expect(lane.textContent).not.toContain("authored");
  });

  it("shows the author date alone beside an unparseable committer date", async () => {
    serve({ date: AUTHORED, committerDate: "" });
    const { lane } = await metaLane();
    expect(times(lane).map((t) => t.dateTime)).toEqual([AUTHORED]);
    expect(lane.textContent).not.toContain("authored");
    expect(lane.textContent).not.toContain("committed");
  });

  it("drops the dates item, separator included, for an unparseable author date", async () => {
    serve({ date: "", committerDate: AUTHORED });
    const { lane } = await metaLane();
    expect(times(lane)).toHaveLength(0);
    for (const sep of separators(lane)) {
      const item = sep.parentElement;
      expect(item?.childNodes.length).toBeGreaterThan(1);
    }
  });
});

describe("CommitDetailView meta row structure", () => {
  it("wraps by item with hanging, hidden, leading separators", async () => {
    serve({ date: AUTHORED, committerDate: after(3600) });
    const { lane, actions } = await metaLane();
    expect(lane.className).toContain("flex-wrap");
    for (const child of lane.children) expect(child.textContent).not.toBe("•");
    const seps = separators(lane);
    // Author, dates (and both halves), hash.
    expect(seps.length).toBe(5);
    for (const sep of seps) {
      expect(sep.getAttribute("aria-hidden")).toBe("true");
      expect(sep.parentElement).not.toBe(lane);
      expect(sep.parentElement?.firstChild).toBe(sep);
    }
    const name = screen.getByText("Ada");
    expect(name.className).toContain("truncate");
    expect(name.className).toContain("min-w-0");
    expect(actions.parentElement?.className).toContain("shrink-0");
    expect(actions.parentElement?.parentElement).toBe(lane);
  });
});
