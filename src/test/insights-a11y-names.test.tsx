import { render, screen, within } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  ActionsDurationChart,
  CodeFrequencyChart,
  CommitActivityChart,
  DataTable,
  TrafficChart,
} from "@/features/repository/insights/charts";
import { InsightsPanel } from "@/features/repository/insights/InsightsPanel";
import { PunchCard } from "@/features/repository/insights/PunchCard";
import { InsightCard } from "@/features/repository/insights/primitives";
import { TrafficCard } from "@/features/repository/insights/TrafficCard";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/git/queries", async (importOriginal) => {
  const read = (data: unknown) => ({
    data,
    error: null,
    isPending: false,
    isError: false,
    isPaused: false,
    isFetching: false,
    isPlaceholderData: false,
    refetch: () => Promise.resolve(),
  });
  return {
    ...(await importOriginal<typeof import("@/lib/git/queries")>()),
    useRepoStats: () =>
      read({
        commitCount: 12,
        contributorCount: 2,
        topContributors: [{ name: "Ada", commits: 9 }],
        branchCount: 3,
        tagCount: 1,
        trackedFiles: 40,
        totalLines: 900,
        trackedBytes: 4096,
        gitDirBytes: 8192,
        firstCommitDate: null,
        lastCommitDate: null,
        languages: [{ name: "TypeScript", files: 40, lines: 900, bytes: 4096 }],
      }),
    useRepoStatus: () => read({ branch: { name: "feat/x" } }),
    useDefaultBranch: () => read("master"),
    useBranchStats: () =>
      read({
        commitCount: 2,
        contributorCount: 1,
        filesChanged: 3,
        additions: 10,
        deletions: 2,
        firstCommitDate: null,
        lastCommitDate: null,
      }),
  };
});

afterAll(() => expect(unmockedCommands).toEqual([]));

// jsdom lays nothing out, and Recharts draws no surface at a zero size.
const SIZE = { x: 0, y: 0, top: 0, left: 0, width: 320, height: 160 };
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    ...SIZE,
    right: SIZE.width,
    bottom: SIZE.height,
    toJSON: () => SIZE,
  });
});
afterEach(() => vi.restoreAllMocks());

const WEEKS = [
  { week: "2026-40", commits: 3 },
  { week: "2026-41", commits: 5 },
];

/** Each chart in its card: the card's group, its figure, its chart surface
 *  and its data table all carry the card's title. */
const CARDS = [
  ["Commit activity", <CommitActivityChart key="c" data={WEEKS} />],
  [
    "Code frequency",
    <CodeFrequencyChart
      key="f"
      data={[
        { week: "2026-40", additions: 9, deletions: 2 },
        { week: "2026-41", additions: 4, deletions: 1 },
      ]}
    />,
  ],
  [
    "Actions",
    <ActionsDurationChart
      key="a"
      data={[
        { run: "#1", minutes: 2, conclusion: "success" },
        { run: "#2", minutes: 3, conclusion: "failure" },
      ]}
    />,
  ],
  [
    "Traffic",
    <TrafficChart
      key="t"
      views={[{ timestamp: "2026-11-01T00:00:00Z", count: 12, uniques: 4 }]}
      clones={[{ timestamp: "2026-11-01T00:00:00Z", count: 5, uniques: 2 }]}
    />,
  ],
] as const;

describe("Insights accessible names", () => {
  it.each(CARDS)("names the %s chart and table by the card", (title, chart) => {
    render(<InsightCard title={title}>{chart}</InsightCard>);
    const region = screen.getByRole("group", { name: title });
    // A group, not a region: the board adds no landmarks.
    expect(screen.queryAllByRole("region")).toEqual([]);
    expect(within(region).getByRole("figure", { name: title })).toBeTruthy();
    expect(
      within(region).getByRole("application", { name: `${title} chart` }),
    ).toBeTruthy();
    // The table sits in a closed <details>, so the query includes hidden nodes.
    expect(
      within(region).getByRole("table", {
        name: `${title} data`,
        hidden: true,
      }),
    ).toBeTruthy();
  });

  it("names the punch card's figure by its card, apart from its grid", () => {
    const grid = Array.from({ length: 7 }, (_, d) =>
      Array.from({ length: 24 }, (_, h) => (d === 1 && h === 9 ? 4 : 0)),
    );
    render(
      <InsightCard title="Commits by day & hour">
        <PunchCard grid={grid} />
      </InsightCard>,
    );
    expect(
      screen.getByRole("figure", { name: "Commits by day & hour" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("grid", { name: "Commits by day of week and hour" }),
    ).toBeTruthy();
  });

  it("a table outside a card takes its own label, or none", () => {
    render(
      <>
        <DataTable headers={["A"]} rows={[["1"]]} label="Standalone" />
        <DataTable headers={["B"]} rows={[["2"]]} />
      </>,
    );
    const [named, bare] = screen.getAllByRole("table");
    expect(named.getAttribute("aria-label")).toBe("Standalone");
    expect(bare.hasAttribute("aria-label")).toBe(false);
  });

  it("names the sidebar's sections by their headings, each distinct", () => {
    render(<InsightsPanel repoPath="C:/repo" active />);
    expect(screen.queryAllByRole("region")).toEqual([]);
    const names = screen
      .getAllByRole("group")
      .map((r) => r.getAttribute("aria-labelledby"))
      .map((id) => (id ? document.getElementById(id)?.textContent : null));
    expect(names).toEqual([
      "Overview",
      "Code makeup",
      "Top contributors",
      "feat/x vs master",
    ]);
    for (const name of ["Overview", "Code makeup", "Top contributors"])
      expect(screen.getByRole("group", { name })).toBeTruthy();
    expect(
      screen.getByRole("group", { name: "feat/x vs master" }),
    ).toBeTruthy();
  });

  it("names the traffic card's lists by their headings, inside the card", () => {
    const item = (name: string) => ({
      name,
      title: name,
      count: 3,
      uniques: 1,
    });
    render(
      <InsightCard title="Traffic">
        <TrafficCard
          data={{
            available: true,
            viewsCount: 3,
            viewsUniques: 1,
            views: [],
            clonesCount: 0,
            clonesUniques: 0,
            clones: [],
            referrers: [item("github.com")],
            paths: [item("/owner/repo")],
          }}
        />
      </InsightCard>,
    );
    const card = screen.getByRole("group", { name: "Traffic" });
    for (const name of ["Top referrers", "Popular paths"])
      expect(within(card).getByRole("group", { name })).toBeTruthy();
    expect(screen.queryAllByRole("region")).toEqual([]);
  });
});
