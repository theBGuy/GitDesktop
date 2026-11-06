import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps, type ReactElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationListPanel } from "@/features/conversations/ConversationListPanel";
import { PullRequestsPanel } from "@/features/pulls/PullRequestsPanel";
import type { PrStateFilter } from "@/lib/git/api";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
// The forge probe never answers, so the panel stays in its pending window.
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(() => new Promise(() => undefined)),
}));

type Local = { id: string; title: string };
type Remote = { number: number; title: string };
type PanelProps = ComponentProps<
  typeof ConversationListPanel<Local, Remote, string>
>;

const PR_TABS: readonly PrStateFilter[] = ["open", "merged", "unmerged"];
const PR_LABELS: Record<PrStateFilter, string> = {
  open: "Open",
  merged: "Merged",
  unmerged: "Closed",
  closed: "Closed",
};

const noop = () => undefined;

/** A settled, ready, empty list: both sections draw their empty copy. The
 *  state props stay out, so each harness's S infers from its own state. */
function baseProps(): Omit<
  PanelProps,
  "stateFilter" | "onStateFilter" | "stateOptions"
> {
  return {
    repoPath: "C:/repo",
    feature: "pull requests",
    newMenu: {
      ghLabel: "Pull request…",
      ghDisabled: false,
      onGh: noop,
      localLabel: "Local pull request…",
      onLocal: noop,
    },
    filterSlot: null,
    filterRef: { current: null },
    filterText: "",
    onFilterText: noop,
    onListKeyDown: noop,
    stateLocal: [],
    visibleLocal: [],
    localKey: (l) => l.id,
    isLocalActive: () => false,
    onSelectLocal: noop,
    renderLocalRow: (l) => l.title,
    archivedLocalCount: 0,
    showArchived: false,
    onToggleArchived: noop,
    localCollapsed: false,
    remoteCollapsed: false,
    onToggleLocal: noop,
    onToggleRemote: noop,
    ghPending: false,
    ghProbeFailed: false,
    ghReady: true,
    listPending: false,
    stateRemote: [],
    visibleRemote: [],
    remoteKey: (r) => String(r.number),
    isRemoteActive: () => false,
    onSelectRemote: noop,
    onRemoteHover: noop,
    renderRemoteRow: (r) => r.title,
    remoteSkeletonRows: 2,
    remoteFetching: false,
    localNoun: "pull requests",
    remoteNoun: "pull requests",
  };
}

/** The PR panel's shape, with the tab held in real state so aria-pressed
 *  follows a click; `picks` records every onStateFilter call. */
function PrHarness({ picks }: { picks: PrStateFilter[] }) {
  const [state, setState] = useState<PrStateFilter>("open");
  return (
    <ConversationListPanel
      {...baseProps()}
      stateFilter={state}
      onStateFilter={(s) => {
        picks.push(s);
        setState(s);
      }}
      stateOptions={{
        values: PR_TABS,
        labels: PR_LABELS,
        groupLabel: "Pull request state",
      }}
    />
  );
}

function IssueHarness() {
  const [state, setState] = useState<"open" | "closed">("open");
  return (
    <ConversationListPanel
      {...baseProps()}
      feature="issues"
      localNoun="issues"
      remoteNoun="issues"
      stateFilter={state}
      onStateFilter={setState}
    />
  );
}

afterEach(cleanup);

/** Renders, then flushes the update Base UI's ScrollArea schedules after mount,
 *  so it lands inside act() rather than warning. */
async function renderSettled(ui: ReactElement) {
  const result = render(ui);
  await act(async () => undefined);
  return result;
}

describe("PR list state tabs", () => {
  it("renders Open | Merged | Closed in a named group, Open pressed", async () => {
    await renderSettled(<PrHarness picks={[]} />);
    const group = screen.getByRole("group", { name: "Pull request state" });
    const tabs = within(group).getAllByRole("button");
    expect(tabs.map((b) => b.textContent)).toEqual([
      "Open",
      "Merged",
      "Closed",
    ]);
    expect(tabs.map((b) => b.getAttribute("aria-pressed"))).toEqual([
      "true",
      "false",
      "false",
    ]);
  });

  it("sends the wire value on click and moves aria-pressed with the tab", async () => {
    const user = userEvent.setup();
    const picks: PrStateFilter[] = [];
    render(<PrHarness picks={picks} />);
    const group = screen.getByRole("group", { name: "Pull request state" });

    await user.click(within(group).getByRole("button", { name: "Merged" }));
    expect(picks).toEqual(["merged"]);
    expect(
      within(group).getByRole("button", { name: "Merged" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: "Open" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await user.click(within(group).getByRole("button", { name: "Closed" }));
    expect(picks).toEqual(["merged", "unmerged"]);
    expect(
      within(group).getByRole("button", { name: "Closed" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("names the tab's label in the empty copy, never the wire value", async () => {
    const user = userEvent.setup();
    render(<PrHarness picks={[]} />);
    const group = screen.getByRole("group", { name: "Pull request state" });
    expect(screen.getByText("No open pull requests.")).toBeInTheDocument();
    expect(
      screen.getByText("No open local pull requests."),
    ).toBeInTheDocument();

    await user.click(within(group).getByRole("button", { name: "Merged" }));
    expect(screen.getByText("No merged pull requests.")).toBeInTheDocument();
    expect(
      screen.getByText("No merged local pull requests."),
    ).toBeInTheDocument();

    await user.click(within(group).getByRole("button", { name: "Closed" }));
    expect(screen.getByText("No closed pull requests.")).toBeInTheDocument();
    expect(
      screen.getByText("No closed local pull requests."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/unmerged/i)).toBeNull();
  });

  it("compacts New on a narrow header, keeping its accessible name", async () => {
    const { container } = await renderSettled(<PrHarness picks={[]} />);
    const newButton = screen.getByRole("button", { name: "New" });
    expect(newButton).toHaveAttribute("aria-label", "New");
    expect(newButton).toHaveAttribute("title", "New");
    expect(newButton).toHaveClass(
      "@max-[277px]/gd-prhead:*:data-[slot=new-label]:hidden",
    );
    const label = newButton.querySelector('[data-slot="new-label"]');
    expect(label?.textContent).toBe("New");
    // The container query reads the header box, never the row it styles.
    expect(
      container.querySelector(".\\@container\\/gd-prhead"),
    ).toContainElement(newButton);
  });
});

describe("issue list state tabs (no stateOptions)", () => {
  it("keeps the Open | Closed pair in an Issue state group", async () => {
    await renderSettled(<IssueHarness />);
    const group = screen.getByRole("group", { name: "Issue state" });
    const tabs = within(group).getAllByRole("button");
    expect(tabs.map((b) => b.textContent)).toEqual(["Open", "Closed"]);
    expect(screen.getByText("No open issues.")).toBeInTheDocument();
    expect(screen.getByText("No open local issues.")).toBeInTheDocument();
  });

  it("renders New unchanged, with no compact markup", async () => {
    const { container } = await renderSettled(<IssueHarness />);
    const newButton = screen.getByRole("button", { name: "New" });
    expect(newButton).not.toHaveAttribute("aria-label");
    expect(newButton).not.toHaveAttribute("title");
    expect(newButton.querySelector("[data-slot=new-label]")).toBeNull();
    expect(newButton.className).not.toContain("gd-prhead");
    expect(container.querySelector(".\\@container\\/gd-prhead")).toBeNull();
  });

  it("switches to Closed and says so in the empty copy", async () => {
    const user = userEvent.setup();
    render(<IssueHarness />);
    const group = screen.getByRole("group", { name: "Issue state" });
    await user.click(within(group).getByRole("button", { name: "Closed" }));
    expect(
      within(group).getByRole("button", { name: "Closed" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("No closed issues.")).toBeInTheDocument();
  });
});

describe("PR panel noun while the forge probe is pending", () => {
  it("says merge requests for a repo saved as GitLab", async () => {
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
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <PullRequestsPanel repoPath="C:/repo" />
      </QueryClientProvider>,
    );
    expect(
      (await screen.findAllByText(/Loading merge requests/)).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/Loading pull requests/)).toBeNull();
  });
});
