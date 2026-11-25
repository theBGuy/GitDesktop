import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommitDetailView } from "@/features/history/CommitDetailView";
import { TabPanel } from "@/features/repository/TabPanel";
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
import type { ForgeStatus, RepoStatus } from "@/lib/git/types";
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
// The header is under test, not the diff pane.
vi.mock("@/features/diff/DiffSurfaceLazy", () => ({
  DiffSurface: () => null,
  DiffContent: () => null,
}));

const REPO = "/repo";
/** Non-zero hex, so the oid-width guard never reads a zero run. */
const HASH = "abcdef0123".repeat(4);
const ALL_ON = new Proxy({}, { get: () => true });
/** git's %s joins a first paragraph with no blank line into one subject. */
const LONG_SUBJECT = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
const never = <T,>() => new Promise<T>(() => undefined);
const classes = (el: Element | null | undefined) =>
  (el?.getAttribute("class") ?? "").split(/\s+/);

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
  vi.mocked(gitCommitDetails).mockResolvedValue({
    hash: HASH,
    subject: LONG_SUBJECT,
    body: "",
    author: "Ada",
    authorEmail: "ada@example.com",
    date: "2026-01-01T10:00:00Z",
    committerDate: "2026-01-01T10:00:00Z",
  });
  vi.mocked(gitCommitFiles).mockResolvedValue([
    { path: "a.txt", added: 1, deleted: 0, isBinary: false, binaryKind: null },
  ]);
  vi.mocked(gitCommitFileDiff).mockImplementation(never);
});

afterEach(() => {
  cleanup();
  expect(unmockedCommands).toEqual([]);
});

describe("History's commit subject", () => {
  it("caps a long subject at two lines that scroll, the whole subject kept and keyboard-reachable", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <CommitDetailView repoPath={REPO} hash={HASH} />
      </QueryClientProvider>,
    );
    const heading = await screen.findByRole("heading", { level: 2 });
    expect(heading).toHaveTextContent(LONG_SUBJECT);
    // Two text-sm lines, then it scrolls, so the header above the files and
    // diff row stays bounded however long the subject runs.
    expect(classes(heading)).toEqual(
      expect.arrayContaining([
        "max-h-10",
        "overflow-y-auto",
        "text-sm",
        "break-words",
      ]),
    );
    expect(heading).toHaveAttribute("tabindex", "0");
    expect(heading.closest("header")).not.toBeNull();
    // The diff region mounts beside the header, never around it.
    await waitFor(() => expect(document.querySelector("main")).not.toBeNull());
    expect(heading.closest("main")).toBeNull();
    client.clear();
  }, 30_000);

  it("opens the next commit's subject and body scrolled to the top", async () => {
    const HASH_B = "bcdef01234".repeat(4);
    const SUBJECT_B = `next ${LONG_SUBJECT}`;
    const body = (hash: string) => `Body of ${hash.slice(0, 7)}\n`.repeat(20);
    vi.mocked(gitCommitDetails).mockImplementation(async (_r, hash) => ({
      hash,
      subject: hash === HASH ? LONG_SUBJECT : SUBJECT_B,
      body: body(hash),
      author: "Ada",
      authorEmail: "ada@example.com",
      date: "2026-01-01T10:00:00Z",
      committerDate: "2026-01-01T10:00:00Z",
    }));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // Inside a repository tab's panel, which a tab switch hides and shows.
    const ui = (hash: string, active = true) => (
      <QueryClientProvider client={client}>
        <TabPanel active={active}>
          <CommitDetailView repoPath={REPO} hash={hash} />
        </TabPanel>
      </QueryClientProvider>
    );
    const view = render(ui(HASH));
    const scrollers = () => {
      const heading = screen.getByRole("heading", { level: 2 });
      const message = heading.parentElement?.querySelector("p");
      expect(message?.textContent).toContain("Body of");
      return [heading, message as HTMLElement];
    };
    await screen.findByRole("heading", { level: 2, name: LONG_SUBJECT });
    // A keyboard user reading the subject: focus stays on it across the switch.
    const [subject] = scrollers();
    act(() => subject.focus());
    expect(document.activeElement).toBe(subject);
    for (const el of scrollers()) el.scrollTop = 30;
    expect(scrollers().map((el) => el.scrollTop)).toEqual([30, 30]);
    view.rerender(ui(HASH_B));
    await screen.findByRole("heading", { level: 2, name: SUBJECT_B });
    expect(scrollers()[1].textContent).toContain(body(HASH_B).trim());
    expect(scrollers().map((el) => el.scrollTop)).toEqual([0, 0]);
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 2 }),
    );
    // Back to the same commit after a tab switch: the scroll it was left at.
    const shownB = scrollers();
    for (const el of shownB) el.scrollTop = 30;
    view.rerender(ui(HASH_B, false));
    await act(async () => undefined);
    view.rerender(ui(HASH_B, true));
    await act(async () => undefined);
    expect(scrollers()).toEqual(shownB);
    expect(shownB.map((el) => el.scrollTop)).toEqual([30, 30]);
    client.clear();
  }, 30_000);
});
