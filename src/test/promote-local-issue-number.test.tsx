import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PromoteLocalIssueDialog } from "@/features/issues/PromoteLocalIssueDialog";
import {
  forgeIssueComment,
  forgeIssueCreate,
  forgeStatus,
} from "@/lib/git/api";
import { type LocalIssue, updateLocalIssue } from "@/lib/issues/local";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  // Never answered: the destination stays the forge and nothing gates on it.
  forgeStatus: vi.fn(() => new Promise(() => undefined)),
  forgeIssueCreate: vi.fn(),
  forgeIssueComment: vi.fn(async () => ({ failedAttachments: [] })),
}));
vi.mock("@/lib/issues/local", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/issues/local")>()),
  updateLocalIssue: vi.fn(),
}));
vi.mock("@/lib/jira/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jira/store")>()),
  getJiraLink: vi.fn(async () => null),
}));

const REPO = "C:/repo";

const ISSUE: LocalIssue = {
  id: "issue-1",
  title: "Bug",
  body: "",
  status: "open",
  labels: [],
  comments: [{ id: "c1", body: "Carry me", createdAt: "2026-11-01T00:00:00Z" }],
  createdAt: "2026-11-01T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({
    repoPath: REPO,
    selectedIssue: { kind: "local", id: ISSUE.id },
  });
  vi.mocked(forgeStatus).mockReturnValue(new Promise(() => undefined));
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  expect(unmockedCommands).toEqual([]);
});

describe("PromoteLocalIssueDialog over an issue whose number couldn't be read", () => {
  it.each([
    {
      variant: "with comments to carry",
      issue: ISSUE,
      title:
        "Opened issue, but its number couldn't be read. Its comments weren't carried over and the local issue isn't linked to it.",
    },
    {
      variant: "with no comments",
      issue: { ...ISSUE, comments: [] },
      title:
        "Opened issue, but its number couldn't be read. The local issue isn't linked to it.",
    },
  ])(
    "warns it opened $variant, and links, comments on and selects nothing",
    async ({ issue, title: expected }) => {
      const url = "https://github.com/me/project/issues/new";
      vi.mocked(updateLocalIssue).mockResolvedValue({
        ...issue,
        status: "closed",
      });
      vi.mocked(forgeIssueCreate).mockResolvedValue({
        number: 0,
        url,
      } as never);
      const success = vi.spyOn(toast, "success").mockImplementation(() => "");
      const warning = vi.spyOn(toast, "warning").mockImplementation(() => "");
      const onOpenChange = vi.fn();
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      render(
        <QueryClientProvider client={client}>
          <PromoteLocalIssueDialog
            repoPath={REPO}
            issue={issue}
            open
            onOpenChange={onOpenChange}
          />
        </QueryClientProvider>,
      );
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: /Publish to / }));
      await waitFor(() => expect(warning).toHaveBeenCalledTimes(1));
      expect(success).not.toHaveBeenCalled();
      const [title, options] = warning.mock.calls[0];
      expect(title).toBe(expected);
      expect(options).toMatchObject({
        description: url,
        action: { label: "View" },
      });
      // The local close is the only local write: no back-link follows it.
      expect(updateLocalIssue).toHaveBeenCalledTimes(1);
      expect(forgeIssueComment).not.toHaveBeenCalled();
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(useUiStore.getState().selectedIssue).toEqual({
        kind: "local",
        id: ISSUE.id,
      });
    },
  );
});
