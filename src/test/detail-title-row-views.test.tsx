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

const BEFORE_HOST = /^(Plan|Solve|Edit)/;

/** Every way a header's title row departs from the shared row: one actions
 *  group, the h2 first, every button inside the group, and today's order
 *  (Plan / Solve / Edit, then the host button, then More actions). */
function headerProblems(header: Element, host: string): string[] {
  const problems: string[] = [];
  const groups = header.querySelectorAll("[data-slot=detail-title-actions]");
  if (groups.length !== 1) problems.push(`${groups.length} actions groups`);
  const group = groups[0];
  const row = group?.parentElement ?? header.firstElementChild;
  if (!row) return [...problems, "header has no title row"];
  if (row.firstElementChild?.tagName !== "H2") {
    problems.push("the h2 is not the row's first element child");
  }
  const buttons = Array.from(row.querySelectorAll("button"));
  for (const b of buttons) {
    if (!group?.contains(b)) {
      problems.push(`${b.textContent} is outside the group`);
    }
  }
  const hostAt = buttons.findIndex((b) => b.textContent?.includes(host));
  if (hostAt < 0) return [...problems, `no ${host} button`];
  buttons.forEach((b, i) => {
    const before = BEFORE_HOST.test(b.textContent ?? "");
    const after = b.getAttribute("aria-label") === "More actions";
    if (before && i > hostAt) {
      problems.push(`${b.textContent} follows the host`);
    }
    if (after && i < hostAt) problems.push("More actions precedes the host");
  });
  return problems;
}

afterEach(cleanup);

describe("RemoteIssueView title row", () => {
  it("puts every header action in one group after the heading, in order", async () => {
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
    const { container } = render(
      <QueryClientProvider client={client}>
        <RemoteIssueView repoPath="C:/repo" number={7} />
      </QueryClientProvider>,
    );
    await screen.findAllByTitle("Open this issue on GitLab");
    const heading = screen.getByRole("heading", { name: /Pending host issue/ });
    const header = heading.closest("header");
    if (!header) throw new Error("no header rendered");
    expect(headerProblems(header, "GitLab")).toEqual([]);
    expect(container.querySelectorAll("header")).toHaveLength(1);
  });

  it("flags the old markup, where the buttons are the title's siblings", () => {
    const { container } = render(
      <header>
        <div
          className={["flex", "flex-wrap", "items-start", "gap-2"].join(" ")}
        >
          <h2 className={["min-w-0", "flex-auto", "break-words"].join(" ")}>
            Old header
          </h2>
          <button type="button">Edit</button>
          <button type="button">GitLab</button>
        </div>
      </header>,
    );
    const header = container.querySelector("header");
    if (!header) throw new Error("no markup rendered");
    expect(headerProblems(header, "GitLab").length).toBeGreaterThan(0);
  });

  it("flags a grouped row whose host button comes before Plan", () => {
    const { container } = render(
      <header>
        <div>
          <h2>Reordered header</h2>
          <div data-slot="detail-title-actions">
            <button type="button">GitLab</button>
            <button type="button">Plan</button>
          </div>
        </div>
      </header>,
    );
    const header = container.querySelector("header");
    if (!header) throw new Error("no markup rendered");
    expect(headerProblems(header, "GitLab")).toEqual(["Plan follows the host"]);
  });
});
