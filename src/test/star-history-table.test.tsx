import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataTable } from "@/features/repository/insights/charts";
import { ChartFigure } from "@/features/repository/insights/primitives";

// The Star history card's table and figure primitives, outside the board.
describe("Star history: table and figure", () => {
  it("rows older pages prepend keep their elements", () => {
    const headers = ["Week", "New stars", "Total"];
    const newer = [
      ["Week of Oct 25", "1", "2"],
      ["Week of Nov 1", "1", "3"],
    ];
    const view = render(<DataTable headers={headers} rows={newer} />);
    const before = screen.getAllByRole("row").slice(1);
    view.rerender(
      <DataTable
        headers={headers}
        rows={[["Week of Oct 18", "1", "1"], ...newer]}
      />,
    );
    const after = screen.getAllByRole("row").slice(1);
    expect(after).toHaveLength(3);
    expect(after[1]).toBe(before[0]);
    expect(after[2]).toBe(before[1]);
  });

  it("a figure outside a card is named by its caption, described by nothing", () => {
    render(
      <ChartFigure caption="Weekly totals.">
        <div />
      </ChartFigure>,
    );
    const figure = screen.getByRole("figure", { name: "Weekly totals." });
    expect(figure.hasAttribute("aria-describedby")).toBe(false);
  });
});
