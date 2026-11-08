import { render, screen } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DataTable, TrafficChart } from "@/features/repository/insights/charts";
import { LinkOutsSkeleton } from "@/features/repository/insights/LinkOutsCard";
import { PunchCardSkeleton } from "@/features/repository/insights/PunchCard";
import { unmockedCommands } from "./setup";

afterAll(() => expect(unmockedCommands).toEqual([]));

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  consoleError.mockRestore();
});

/** Every console.error call's arguments joined, so React's format-string
 *  warnings match on their substituted text too. */
const errorTexts = (): string[] =>
  consoleError.mock.calls.map((args: unknown[]) => args.map(String).join(" "));

describe("Insights renders without React console errors", () => {
  it("the traffic data table keys its two Unique columns apart", () => {
    render(
      <TrafficChart
        views={[
          { timestamp: "2026-11-01T00:00:00Z", count: 12, uniques: 4 },
          { timestamp: "2026-11-02T00:00:00Z", count: 9, uniques: 3 },
        ]}
        clones={[
          { timestamp: "2026-11-01T00:00:00Z", count: 5, uniques: 2 },
          { timestamp: "2026-11-02T00:00:00Z", count: 7, uniques: 1 },
        ]}
      />,
    );
    // The table sits in a closed <details>, so the query includes hidden nodes.
    const headers = screen.getAllByRole("columnheader", { hidden: true });
    expect(headers.map((h) => h.textContent)).toEqual([
      "Day",
      "Views",
      "Unique",
      "Clones",
      "Unique",
    ]);
    expect(errorTexts().filter((t) => /same key/.test(t))).toEqual([]);
  });

  it("a data table keys rows apart when their first cells repeat", () => {
    // Two workflows can share run numbers, so a label column repeats.
    render(
      <DataTable
        headers={["Run", "Duration"]}
        rows={[
          ["#1", "2m"],
          ["#2", "3m"],
          ["#1", "4m"],
          ["#2", "5m"],
        ]}
      />,
    );
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      "#12m",
      "#23m",
      "#14m",
      "#25m",
    ]);
    expect(errorTexts().filter((t) => /same key/.test(t))).toEqual([]);
  });

  it("the punch card skeleton nests no block inside a paragraph", () => {
    const { container } = render(<PunchCardSkeleton />);
    expect(container.querySelector("p div")).toBeNull();
    expect(
      errorTexts().filter((t) =>
        /cannot be a descendant|validateDOMNesting/.test(t),
      ),
    ).toEqual([]);
  });

  it("the link-outs skeleton nests no block inside a paragraph", () => {
    const { container } = render(<LinkOutsSkeleton />);
    expect(container.querySelector("p div")).toBeNull();
    expect(
      errorTexts().filter((t) =>
        /cannot be a descendant|validateDOMNesting/.test(t),
      ),
    ).toEqual([]);
  });
});
