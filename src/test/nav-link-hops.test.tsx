import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "@/components/markdown/markdown";
import { JiraRefRow } from "@/features/issues/JiraRefRow";
import { StackSection } from "@/features/pulls/StackSection";
import type { PrStackMember } from "@/lib/git/types";
import { useJiraIssues, useJiraLink } from "@/lib/jira/queries";
import { __resetNavHistoryForTests } from "@/lib/stores/nav-history";
import { useUiStore } from "@/lib/stores/ui";

// For the hop sites that mount alone: a marked select pushes a history entry
// where the same select made as a list pick replaces the current one in place.

vi.mock("@/lib/jira/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jira/queries")>()),
  useJiraLink: vi.fn(),
  useJiraIssues: vi.fn(),
}));

// jsdom implements no scrollIntoView; listKeyboardNav scrolls the row it focuses.
Element.prototype.scrollIntoView ??= () => undefined;

const REPO = "C:/repos/demo";

const st = () => useUiStore.getState();
const hist = () => st().navHistory;
const remoteIssue = (n: number) => ({ kind: "remote" as const, id: String(n) });
const jiraIssue = (key: string) => ({ kind: "jira" as const, id: key });

/** In the repo view on the Issues tab with `issue` selected. */
function onIssue(issue: ReturnType<typeof remoteIssue | typeof jiraIssue>) {
  st().openRepo({ root: REPO, name: "demo" });
  st().setRepoTab("issues");
  st().selectIssue(issue);
}

beforeEach(() => {
  useUiStore.setState(useUiStore.getInitialState(), true);
  __resetNavHistoryForTests();
});

afterEach(() => {
  useUiStore.setState(useUiStore.getInitialState(), true);
  __resetNavHistoryForTests();
});

describe("the list-pick baseline", () => {
  it("replaces the current entry in place for an unmarked select", () => {
    onIssue(remoteIssue(1));
    const before = hist().entries.length;
    st().selectIssue(remoteIssue(2));
    expect(hist().entries).toHaveLength(before);
    expect(hist().entries[hist().index].selection).toEqual({
      selectedIssue: remoteIssue(2),
    });
  });
});

describe("a reference in a markdown body", () => {
  function renderBody(body: string) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <Markdown refs={{ provider: "gitlab", repoPath: REPO, lens: "origin" }}>
          {body}
        </Markdown>
      </QueryClientProvider>,
    );
    const anchor =
      view.container.querySelector<HTMLAnchorElement>("a[data-ref]");
    if (!anchor) throw new Error("no reference rendered");
    return anchor;
  }

  it("pushes an entry when an issue link is followed on the Issues tab", async () => {
    onIssue(remoteIssue(1));
    const before = hist().entries.length;
    const anchor = renderBody("Blocked by #42.");
    await act(async () => {
      fireEvent.click(anchor);
    });
    expect(st().selectedIssue).toEqual(remoteIssue(42));
    expect(hist().entries).toHaveLength(before + 1);
    expect(hist().index).toBe(before);
    expect(hist().entries[before - 1].selection).toEqual({
      selectedIssue: remoteIssue(1),
    });
  });
});

describe("a Jira reference row", () => {
  beforeEach(() => {
    vi.mocked(useJiraLink).mockReturnValue({
      data: { projectKey: "PROJ" },
    } as ReturnType<typeof useJiraLink>);
    vi.mocked(useJiraIssues).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useJiraIssues>);
  });

  it("pushes an entry when a referenced issue is opened", () => {
    onIssue(jiraIssue("PROJ-1"));
    const before = hist().entries.length;
    render(
      <JiraRefRow
        repoPath={REPO}
        sources={[{ label: "title", text: "Fixes PROJ-2" }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /PROJ-2/ }));
    expect(st().selectedIssue).toEqual(jiraIssue("PROJ-2"));
    expect(st().repoTab).toBe("issues");
    expect(hist().entries).toHaveLength(before + 1);
    expect(hist().entries[before - 1].selection).toEqual({
      selectedIssue: jiraIssue("PROJ-1"),
    });
  });
});

describe("the PR stack section", () => {
  const member = (number: number, position: number): PrStackMember => ({
    number,
    title: `Member ${number}`,
    state: "open",
    position,
    headRefName: `b${number}`,
    baseRefName: `b${number - 1}`,
  });

  function renderStack(onSelect: (n: number, followed: boolean) => void) {
    render(
      <StackSection
        stack={{ id: "7", position: 1, size: 3 }}
        members={[member(10, 1), member(11, 2), member(12, 3)]}
        membersUnknown={false}
        detailsPaused={false}
        onRetryMembers={vi.fn()}
        currentNumber={10}
        onSelect={onSelect}
      />,
    );
  }

  it("reports a clicked member as followed", () => {
    const onSelect = vi.fn();
    renderStack(onSelect);
    fireEvent.click(screen.getByRole("button", { name: /#12/ }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(12, true);
  });

  it("reports a member reached by ArrowDown as browsed, not followed", () => {
    const onSelect = vi.fn();
    renderStack(onSelect);
    fireEvent.keyDown(screen.getByRole("button", { name: /#10/ }), {
      key: "ArrowDown",
    });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(11, false);
  });
});
