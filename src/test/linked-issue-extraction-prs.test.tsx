import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useJiraMentionChips,
  useLinkedIssueChips,
} from "@/features/pulls/useLinkedIssueChips";
import { forgeIssueList, forgeIssueView } from "@/lib/git/api";
import type { IssueDetails, IssueInfo } from "@/lib/git/types";
import { jiraIssueList, jiraIssueView } from "@/lib/jira/api";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeIssueList: vi.fn(),
  forgeIssueView: vi.fn(),
}));

vi.mock("@/lib/jira/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jira/api")>()),
  jiraIssueList: vi.fn(),
  jiraIssueView: vi.fn(),
}));

const OPEN_FIVE: IssueInfo = {
  number: 5,
  url: "https://github.com/o/r/issues/5",
  title: "A thing",
  state: "OPEN",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  author: null,
  labels: [],
};

/** What gh's `issue view` answers for #85, under the given web URL. */
const probed = (url: string) =>
  ({
    number: 85,
    title: "f9drive: own PR probe",
    state: "MERGED",
    url,
  }) as IssueDetails;

function renderChips() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    ({ enabled }: { enabled: boolean }) =>
      useLinkedIssueChips({
        repoPath: "C:/r/app",
        lens: "origin",
        enabled,
        headBranch: "f26a-pushfail",
        commitSubjects: ["Merge pull request #85 from o/x", "fix: thing (#5)"],
      }),
    { wrapper, initialProps: { enabled: true } },
  );
}

describe("linked-issue extraction", () => {
  beforeEach(() => {
    vi.mocked(forgeIssueList).mockReset().mockResolvedValue([OPEN_FIVE]);
    vi.mocked(forgeIssueView).mockReset();
  });

  it("adds no chip for a probed number that is a pull request", async () => {
    vi.mocked(forgeIssueView).mockResolvedValue(
      probed("https://github.com/o/r/pull/85"),
    );
    const { result } = renderChips();
    await waitFor(() => expect(forgeIssueView).toHaveBeenCalledTimes(1));
    expect(vi.mocked(forgeIssueView).mock.calls[0][1]).toBe(85);
    // Let the probe's answer and its `.then` settle before reading the chips.
    await act(async () => {
      await vi.mocked(forgeIssueView).mock.results[0].value;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.chips.map((c) => c.number)).toEqual([5]);
  });

  it("adds a probed number that is an issue", async () => {
    vi.mocked(forgeIssueView).mockResolvedValue(
      probed("https://github.com/o/r/issues/85"),
    );
    const { result } = renderChips();
    await waitFor(() =>
      expect(result.current.chips.map((c) => c.number)).toEqual([5, 85]),
    );
  });

  it("adds no chip from a probe that lands while disabled, and probes again once enabled", async () => {
    let answer: (issue: IssueDetails) => void = () => undefined;
    vi.mocked(forgeIssueView).mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve)),
    );
    vi.mocked(forgeIssueView).mockResolvedValue(
      probed("https://github.com/o/r/issues/85"),
    );
    const { result, rerender } = renderChips();
    await waitFor(() => expect(forgeIssueView).toHaveBeenCalledTimes(1));
    rerender({ enabled: false });
    await act(async () => {
      answer(probed("https://github.com/o/r/issues/85"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.chips.map((c) => c.number)).toEqual([5]);
    rerender({ enabled: true });
    await waitFor(() =>
      expect(result.current.chips.map((c) => c.number)).toEqual([5, 85]),
    );
  });
});

type JiraView = Awaited<ReturnType<typeof jiraIssueView>>;

/** What `jira_issue_view` answers for PROJ-7. */
const jiraProbed = {
  key: "PROJ-7",
  summary: "Fix the thing",
  statusCategory: "indeterminate",
} as JiraView;

function renderJiraChips() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    ({ enabled }: { enabled: boolean }) =>
      useJiraMentionChips({
        repoPath: "C:/r/app",
        enabled,
        headBranch: "proj-7-fix",
        commitSubjects: [],
        link: {
          siteHost: "acme.atlassian.net",
          projectKey: "PROJ",
          projectName: "Project",
        },
      }),
    { wrapper, initialProps: { enabled: true } },
  );
}

describe("Jira mention extraction", () => {
  beforeEach(() => {
    // An empty open page, so the extracted key is probed.
    vi.mocked(jiraIssueList).mockReset().mockResolvedValue([]);
    vi.mocked(jiraIssueView).mockReset();
  });

  it("adds no chip from a probe that lands while inactive, and probes again once active", async () => {
    let answer: (issue: JiraView) => void = () => undefined;
    vi.mocked(jiraIssueView).mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve)),
    );
    vi.mocked(jiraIssueView).mockResolvedValue(jiraProbed);
    const { result, rerender } = renderJiraChips();
    await waitFor(() => expect(jiraIssueView).toHaveBeenCalledTimes(1));
    expect(vi.mocked(jiraIssueView).mock.calls[0][1]).toBe("PROJ-7");
    rerender({ enabled: false });
    await act(async () => {
      answer(jiraProbed);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.chips.map((c) => c.key)).toEqual([]);
    rerender({ enabled: true });
    await waitFor(() =>
      expect(result.current.chips.map((c) => c.key)).toEqual(["PROJ-7"]),
    );
    expect(jiraIssueView).toHaveBeenCalledTimes(2);
  });
});
