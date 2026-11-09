import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssuePicker } from "@/features/issues/IssueRelations";
import { JiraIssuePicker } from "@/features/pulls/JiraIssuePicker";
import { forgeIssueList } from "@/lib/git/api";
import type { IssueInfo } from "@/lib/git/types";
import { jiraIssueList } from "@/lib/jira/api";
import type { JiraLink } from "@/lib/jira/store";
import type { JiraIssueInfo } from "@/lib/jira/types";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeIssueList: vi.fn(),
}));
vi.mock("@/lib/jira/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jira/api")>()),
  jiraIssueList: vi.fn(),
}));

const REPO = "C:/repo";
const LOADING = "Loading…";
const EMPTY = "No matching issues.";
const FAILED = "Couldn't load issues.";
const PARTIAL = "Some issues couldn't load";
const OFFLINE = "You're offline — issues will load once you're back online.";
const never = () => new Promise<never>(() => undefined);
// A deterministic refusal, so the issue list's retry policy doesn't retry it.
const refusal = { kind: "invalidArgument", message: "no" };

const issue = (number: number, title: string) =>
  ({ number, title, state: "OPEN" }) as unknown as IssueInfo;
const jira = (key: string, summary: string) =>
  ({ key, summary, statusCategory: "new" }) as unknown as JiraIssueInfo;
const LINK = { siteHost: "x.atlassian.net", projectKey: "PROJ" } as JiraLink;

let client: QueryClient;
function wrap(ui: ReactNode) {
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

const issueList = vi.mocked(forgeIssueList);
const jiraList = vi.mocked(jiraIssueList);

/** The picker's own announcer; Base UI's empty slot is a status region too. */
const announcers = () =>
  screen.queryAllByRole("status").filter((el) => el.tagName === "SPAN");
const announcer = () => {
  const [only, ...rest] = announcers();
  expect(rest).toHaveLength(0);
  return only as HTMLElement;
};

/** Each state's read answers with its own outcome. */
function issueReads(open: () => Promise<IssueInfo[]>, closed: typeof open) {
  issueList.mockImplementation((_repo, state) =>
    state === "open" ? open() : closed(),
  );
}

/** Renders the IssuePicker closed; `openIssuePicker` also opens it. */
function renderIssuePicker() {
  const user = userEvent.setup();
  wrap(
    <IssuePicker
      repoPath={REPO}
      exclude={new Set()}
      pending={false}
      onPick={() => undefined}
      lens="origin"
    />,
  );
  return user;
}

async function openIssuePicker() {
  const user = renderIssuePicker();
  await user.click(screen.getByRole("combobox"));
  return user;
}

async function openJiraPicker() {
  const user = userEvent.setup();
  wrap(
    <JiraIssuePicker
      repoPath={REPO}
      link={LINK}
      exclude={new Set()}
      pending={false}
      onPick={() => undefined}
    />,
  );
  await user.click(screen.getByRole("combobox"));
  return user;
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  issueList.mockReset();
  jiraList.mockReset();
});

afterEach(() => {
  onlineManager.setOnline(true);
  client.clear();
});

describe("IssuePicker status", () => {
  it("pending reads say Loading…, never No matching issues.", async () => {
    issueReads(never, never);
    await openIssuePicker();
    expect(await screen.findByText(LOADING)).toBeInTheDocument();
    expect(screen.queryByText(EMPTY)).toBeNull();
  });

  it("an answered read with a pending sibling still says Loading…", async () => {
    issueReads(async () => [], never);
    await openIssuePicker();
    await waitFor(() => expect(issueList).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(LOADING)).toBeInTheDocument();
    expect(screen.queryByText(EMPTY)).toBeNull();
  });

  it("rows from the answered read show while the other loads", async () => {
    issueReads(async () => [issue(1, "Fix the thing")], never);
    await openIssuePicker();
    expect(
      await screen.findByRole("option", { name: /Fix the thing/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText(EMPTY)).toBeNull();
  });

  it("both answered and nothing matches says No matching issues.", async () => {
    issueReads(
      async () => [issue(1, "Alpha")],
      async () => [issue(2, "Beta")],
    );
    const user = await openIssuePicker();
    await screen.findByRole("option", { name: /Alpha/ });
    await user.type(screen.getByRole("combobox"), "zzz");
    expect(await screen.findByText(EMPTY)).toBeInTheDocument();
  });

  it("one failed read over rows shows the rows and the partial line", async () => {
    issueReads(
      () => Promise.reject(refusal),
      async () => [issue(2, "Closed one")],
    );
    await openIssuePicker();
    expect(
      await screen.findByRole("option", { name: /Closed one/ }),
    ).toBeInTheDocument();
    const status = announcer();
    await waitFor(() => expect(status).toHaveTextContent(PARTIAL));
    // The visible line is hidden from AT: the status region announces it.
    const visible = screen
      .getAllByText(PARTIAL)
      .find((el) => el !== status) as HTMLElement;
    expect(visible).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByText(FAILED)).toBeNull();
  });

  it("one failed read with an empty sibling says none, plus the partial line", async () => {
    issueReads(
      () => Promise.reject(refusal),
      async () => [],
    );
    await openIssuePicker();
    expect(await screen.findByText(EMPTY)).toBeInTheDocument();
    expect(announcer()).toHaveTextContent(PARTIAL);
  });

  it("both reads failed says Couldn't load issues. with no partial line", async () => {
    issueReads(
      () => Promise.reject(refusal),
      () => Promise.reject(refusal),
    );
    await openIssuePicker();
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    expect(screen.queryByText(EMPTY)).toBeNull();
    expect(announcer()).toHaveTextContent("");
  });

  it("reads parked offline say offline, never No matching issues.", async () => {
    onlineManager.setOnline(false);
    issueReads(
      async () => [],
      async () => [],
    );
    await openIssuePicker();
    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
    expect(screen.queryByText(EMPTY)).toBeNull();
    expect(issueList).not.toHaveBeenCalled();
  });

  it("every read failed over cached rows says Couldn't load issues., never Some", async () => {
    issueReads(
      async () => [issue(1, "Open one")],
      async () => [issue(2, "Closed one")],
    );
    await openIssuePicker();
    await screen.findByRole("option", { name: /Closed one/ });
    issueReads(
      () => Promise.reject(refusal),
      () => Promise.reject(refusal),
    );
    await act(() => client.refetchQueries());
    const status = announcer();
    await waitFor(() => expect(status).toHaveTextContent(FAILED));
    const visible = screen
      .getAllByText(FAILED)
      .find((el) => el !== status) as HTMLElement;
    expect(visible).toHaveAttribute("aria-hidden", "true");
    expect(
      screen.getByRole("option", { name: /Open one/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText(PARTIAL)).toBeNull();
  });

  it("the status region exists before the popup opens, outside the listbox", async () => {
    issueReads(never, never);
    const user = renderIssuePicker();
    const status = announcer();
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("");
    await user.click(screen.getByRole("combobox"));
    expect(await screen.findByText(LOADING)).toBeInTheDocument();
    expect(announcer()).toBe(status);
    expect(screen.getByRole("listbox").contains(status)).toBe(false);
  });

  it("a failure already cached at mount reaches the region after it mounts", async () => {
    issueReads(
      () => Promise.reject(refusal),
      async () => [issue(2, "Closed one")],
    );
    const first = wrap(
      <IssuePicker
        repoPath={REPO}
        exclude={new Set()}
        pending={false}
        onPick={() => undefined}
        lens="origin"
      />,
    );
    await waitFor(() => expect(announcer()).toHaveTextContent(PARTIAL));
    first.unmount();
    // Keeps the cached failure unretried on mount, so the remount's first
    // render already carries the partial status.
    client.setQueryDefaults([], { retryOnMount: false });
    const calls = issueList.mock.calls.length;
    const records = await recordMutations(() => renderIssuePicker());
    expect(issueList).toHaveBeenCalledTimes(calls);
    const status = announcer();
    expect(status).toHaveTextContent(PARTIAL);
    expect(textArrivals(records, status)).toContain(PARTIAL);
  });

  it("the arrival probe reports nothing for a region inserted with its text", async () => {
    const records = await recordMutations(() =>
      render(
        <span role="status" aria-live="polite">
          {PARTIAL}
        </span>,
      ),
    );
    expect(textArrivals(records, announcer())).toEqual([]);
  });
});

/** Every DOM mutation `run` causes, its effects flushed. */
async function recordMutations(run: () => unknown) {
  const records: MutationRecord[] = [];
  const observer = new MutationObserver((batch) => records.push(...batch));
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  await act(async () => {
    run();
  });
  records.push(...observer.takeRecords());
  observer.disconnect();
  return records;
}

/** Text that reached `el` after it was in the document: a live region
 *  inserted together with its text (which AT doesn't announce) yields none. */
function textArrivals(records: MutationRecord[], el: Element) {
  return records
    .flatMap((r) => {
      if (r.type === "characterData" && r.target.parentNode === el)
        return [r.target.textContent ?? ""];
      if (r.target === el)
        return [...r.addedNodes].map((n) => n.textContent ?? "");
      return [];
    })
    .filter((text) => text !== "");
}

describe("JiraIssuePicker status", () => {
  it("a pending read says Loading…", async () => {
    jiraList.mockImplementation(never);
    await openJiraPicker();
    expect(await screen.findByText(LOADING)).toBeInTheDocument();
    expect(screen.queryByText(EMPTY)).toBeNull();
  });

  it("a rejected read says Couldn't load issues.", async () => {
    jiraList.mockRejectedValue(refusal);
    await openJiraPicker();
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    expect(screen.queryByText(EMPTY)).toBeNull();
  });

  it("an answered empty read says No matching issues.", async () => {
    jiraList.mockResolvedValue([]);
    await openJiraPicker();
    expect(await screen.findByText(EMPTY)).toBeInTheDocument();
  });

  it("an answered read shows its rows and no status region", async () => {
    jiraList.mockResolvedValue([jira("PROJ-1", "Ship it")]);
    await openJiraPicker();
    expect(
      await screen.findByRole("option", { name: /Ship it/ }),
    ).toBeInTheDocument();
    expect(announcers()).toHaveLength(0);
  });

  it("a failed refetch over loaded rows shows the rows alone", async () => {
    jiraList.mockResolvedValue([jira("PROJ-1", "Ship it")]);
    await openJiraPicker();
    await screen.findByRole("option", { name: /Ship it/ });
    jiraList.mockRejectedValue(refusal);
    await act(() => client.refetchQueries());
    await waitFor(() =>
      expect(client.getQueryCache().getAll()[0]?.state.status).toBe("error"),
    );
    expect(screen.getByRole("option", { name: /Ship it/ })).toBeInTheDocument();
    expect(screen.queryByText(PARTIAL)).toBeNull();
    expect(screen.queryByText(FAILED)).toBeNull();
  });
});
