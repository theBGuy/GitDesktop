import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscussionView } from "@/features/discussions/DiscussionView";
import { RemoteIssueView } from "@/features/issues/RemoteIssueView";
import { TabPanel } from "@/features/repository/TabPanel";
import {
  forgeIssueView,
  ghDiscussionReactions,
  ghDiscussionView,
} from "@/lib/git/api";
import type { DiscussionDetails, IssueDetails } from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(() => new Promise(() => undefined)),
  forgeIssueView: vi.fn(),
  ghDiscussionView: vi.fn(),
  ghDiscussionReactions: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  // Never answers: every assertion below reads the commit that landed the view,
  // before any arm change could run the frame rescue.
  vi.mocked(forgeIssueView).mockImplementation(
    () => new Promise<IssueDetails>(() => undefined),
  );
  vi.mocked(ghDiscussionView).mockImplementation(
    () => new Promise<DiscussionDetails>(() => undefined),
  );
  vi.mocked(ghDiscussionReactions).mockImplementation(
    () => new Promise(() => undefined),
  );
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

/** The view's tabIndex -1 host: the root its wrapper renders. */
const host = () => screen.getByTestId("view").firstElementChild;

const issueView = () => <RemoteIssueView repoPath="C:/repo" number={7} />;
const discussionView = () => <DiscussionView repoPath="C:/repo" number={7} />;

/** A board card in one tab, the detail view in another, one tab shown. */
function Tabs({
  viewShown,
  qc,
  view = issueView,
}: {
  viewShown: boolean;
  qc: QueryClient;
  view?: () => ReactNode;
}) {
  return (
    <QueryClientProvider client={qc}>
      <TabPanel active={!viewShown}>
        <button type="button">card</button>
      </TabPanel>
      <TabPanel active={viewShown}>
        <div data-testid="view">{view()}</div>
      </TabPanel>
    </QueryClientProvider>
  );
}

function outsideInput() {
  const input = document.createElement("input");
  document.body.appendChild(input);
  input.focus();
  return input;
}

describe("RemoteIssueView landing focus", () => {
  it("takes focus a reveal leaves on the hidden tab's card", () => {
    const qc = client();
    const { rerender } = render(<Tabs viewShown={false} qc={qc} />);
    // The hidden tab rendered (its host exists) before it is shown.
    expect(host()).toHaveAttribute("tabindex", "-1");
    const card = screen.getByRole("button", { name: "card" });
    card.focus();
    rerender(<Tabs viewShown qc={qc} />);
    expect(document.activeElement).toBe(host());
  });

  it("takes it again on a second visit to the same instance", () => {
    const qc = client();
    const { rerender } = render(<Tabs viewShown qc={qc} />);
    expect(document.activeElement).toBe(host());
    rerender(<Tabs viewShown={false} qc={qc} />);
    const card = screen.getByRole("button", { name: "card" });
    card.focus();
    expect(document.activeElement).toBe(card);
    rerender(<Tabs viewShown qc={qc} />);
    expect(document.activeElement).toBe(host());
  });

  it("leaves focus on a visible element outside through a reveal", () => {
    const qc = client();
    const { rerender } = render(<Tabs viewShown={false} qc={qc} />);
    const input = outsideInput();
    rerender(<Tabs viewShown qc={qc} />);
    expect(document.activeElement).toBe(input);
  });

  it("takes focus on mount while focus is on <body>", () => {
    expect(document.activeElement).toBe(document.body);
    render(
      <QueryClientProvider client={client()}>
        <div data-testid="view">
          <RemoteIssueView repoPath="C:/repo" number={7} />
        </div>
      </QueryClientProvider>,
    );
    expect(document.activeElement).toBe(host());
  });

  it("leaves a focused visible input alone on mount", () => {
    const input = outsideInput();
    render(
      <QueryClientProvider client={client()}>
        <div data-testid="view">
          <RemoteIssueView repoPath="C:/repo" number={7} />
        </div>
      </QueryClientProvider>,
    );
    expect(document.activeElement).toBe(input);
  });
});

describe("DiscussionView landing focus", () => {
  it("takes focus a reveal leaves on the hidden tab's card", () => {
    const qc = client();
    const { rerender } = render(
      <Tabs viewShown={false} qc={qc} view={discussionView} />,
    );
    expect(host()).toHaveAttribute("tabindex", "-1");
    const card = screen.getByRole("button", { name: "card" });
    card.focus();
    rerender(<Tabs viewShown qc={qc} view={discussionView} />);
    expect(document.activeElement).toBe(host());
  });

  it("takes focus on mount while focus is on <body>", () => {
    expect(document.activeElement).toBe(document.body);
    render(
      <QueryClientProvider client={client()}>
        <div data-testid="view">{discussionView()}</div>
      </QueryClientProvider>,
    );
    expect(document.activeElement).toBe(host());
  });

  it("leaves a focused visible input alone on mount", () => {
    const input = outsideInput();
    render(
      <QueryClientProvider client={client()}>
        <div data-testid="view">{discussionView()}</div>
      </QueryClientProvider>,
    );
    expect(document.activeElement).toBe(input);
  });
});
