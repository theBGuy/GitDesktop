import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteIssueView } from "@/features/issues/RemoteIssueView";
import { forgeIssueView } from "@/lib/git/api";
import type { IssueDetails } from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
// The forge probe never answers, so the view names its host from the saved row.
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(() => new Promise(() => undefined)),
  forgeIssueView: vi.fn(),
}));

const ISSUE: IssueDetails = {
  id: "I_1",
  number: 7,
  title: "Pending host issue",
  body: "",
  author: "someone",
  authorAvatarUrl: "",
  state: "OPEN",
  createdAt: "2026-01-01T00:00:00Z",
  url: "https://gitlab.com/owner/repo/-/issues/7",
  assignees: [],
  milestone: null,
  issueType: null,
  isPinned: false,
  locked: false,
  lockUnknown: false,
  activeLockReason: null,
  confidential: false,
  dueDate: null,
  comments: [],
  labels: [],
};

afterEach(cleanup);

describe("RemoteIssueView host label while the forge probe is pending", () => {
  it("names GitLab on the open-on-host button for a repo saved as GitLab", async () => {
    vi.mocked(loadSettings).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      recentRepos: [
        {
          path: "C:/repo",
          name: "repo",
          lastOpenedAt: "2026-01-01T00:00:00Z",
          provider: "gitlab",
        },
      ],
    });
    vi.mocked(forgeIssueView).mockResolvedValue(ISSUE);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <RemoteIssueView repoPath="C:/repo" number={7} />
      </QueryClientProvider>,
    );
    // The reason-carrying wrapper repeats the button's title, so pick the button.
    const titled = await screen.findAllByTitle("Open this issue on GitLab");
    const open = titled.find((el) => el.tagName === "BUTTON");
    expect(open).toHaveTextContent("GitLab");
    expect(screen.queryByText("Open in browser")).toBeNull();
  });
});
