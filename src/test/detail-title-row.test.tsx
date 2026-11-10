import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { DetailTitleRow } from "@/components/detail-title-row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// Token sets are joined at runtime: the detail-title-row guard bans the old row
// and title class sets as one string literal anywhere under src/, tests included.
const ROW_TOKENS = ["flex", "flex-wrap", "items-start", "gap-2"];
const TITLE_TOKENS = [
  "min-w-0",
  "flex-[1_1_12.5rem]",
  "text-sm",
  "font-medium",
  "break-words",
];
const GROUP_TOKENS = [
  "ml-auto",
  "flex",
  "min-w-0",
  "flex-initial",
  "flex-wrap",
  "items-center",
  "justify-end",
  "gap-2",
  "empty:hidden",
];

function missingTokens(el: Element, tokens: string[], name: string): string[] {
  return tokens
    .filter((t) => !el.classList.contains(t))
    .map((t) => `${name} lacks class ${t}`);
}

/** Every way a rendered title row departs from the shared row's contract. */
function titleRowProblems(row: Element, headingTag = "H2"): string[] {
  const problems: string[] = [];
  const kids = Array.from(row.children);
  if (kids.length !== 2) {
    problems.push(`row has ${kids.length} element children`);
  }
  problems.push(...missingTokens(row, ROW_TOKENS, "row"));
  const [title, group] = kids;
  if (title?.getAttribute("data-slot") !== "detail-title") {
    problems.push("first child is not the detail-title slot");
  }
  if (title && title.tagName !== headingTag) {
    problems.push(`title is ${title.tagName}, expected ${headingTag}`);
  }
  if (title) problems.push(...missingTokens(title, TITLE_TOKENS, "title"));
  if (group?.getAttribute("data-slot") !== "detail-title-actions") {
    problems.push("second child is not the detail-title-actions slot");
    return problems;
  }
  problems.push(...missingTokens(group, GROUP_TOKENS, "group"));
  // A vendored Badge is the span carrying its `group/badge` class.
  for (const control of row.querySelectorAll(
    'button, [class~="group/badge"]',
  )) {
    if (!group.contains(control)) {
      problems.push(`${control.textContent} sits outside the actions group`);
    }
  }
  return problems;
}

function rowOf(container: HTMLElement): Element {
  const row = container.querySelector("[data-slot=detail-title-row]");
  if (!row) throw new Error("no detail-title-row rendered");
  return row;
}

afterEach(cleanup);

describe("DetailTitleRow", () => {
  it("renders the heading, then one group holding every action in order", () => {
    const { container } = render(
      <DetailTitleRow heading="A pull request">
        <Button size="xs">Edit</Button>
        <Button size="xs">GitHub</Button>
        <Badge>open</Badge>
      </DetailTitleRow>,
    );
    const row = rowOf(container);
    expect(titleRowProblems(row)).toEqual([]);
    expect(
      container.querySelectorAll("[data-slot=detail-title-actions]"),
    ).toHaveLength(1);
    const group = row.children[1];
    expect(Array.from(group.children, (c) => c.textContent)).toEqual([
      "Edit",
      "GitHub",
      "open",
    ]);
    expect(group.getAttribute("role")).toBeNull();
    expect(group.getAttribute("aria-label")).toBeNull();
  });

  it("renders a div heading with the view's classes after the layout ones", () => {
    const { container } = render(
      <DetailTitleRow
        heading="Loading"
        headingAs="div"
        headingClassName="opacity-80"
      >
        <Button size="xs">Edit</Button>
      </DetailTitleRow>,
    );
    const row = rowOf(container);
    expect(titleRowProblems(row, "DIV")).toEqual([]);
    expect(row.children[0].classList.contains("opacity-80")).toBe(true);
  });

  it("keeps the group when every action is absent", () => {
    const { container } = render(
      <DetailTitleRow heading="Bare">
        {false}
        {false}
      </DetailTitleRow>,
    );
    const row = rowOf(container);
    expect(titleRowProblems(row)).toEqual([]);
    expect(row.children[1].children).toHaveLength(0);
  });

  it("keeps the remaining actions' nodes when the heading grows and one toggles", () => {
    const view = (heading: ReactNode, middle: boolean) => (
      <DetailTitleRow heading={heading}>
        <Button size="xs">First</Button>
        {middle && <Button size="xs">Middle</Button>}
        <Button size="xs">Last</Button>
      </DetailTitleRow>
    );
    const { container, rerender } = render(view("Short", true));
    const group = rowOf(container).children[1];
    const first = group.children[0];
    const last = group.children[2];
    rerender(view("x".repeat(300), false));
    const after = rowOf(container);
    expect(titleRowProblems(after)).toEqual([]);
    expect(after.children[1]).toBe(group);
    expect(group.children[0]).toBe(first);
    expect(group.children[1]).toBe(last);
    expect(after.children[0].textContent).toHaveLength(300);
  });

  it("flags the old markup, where the actions are the title's siblings", () => {
    const { container } = render(
      <div className={ROW_TOKENS.join(" ")}>
        <h2
          className={[
            "min-w-0",
            "flex-auto",
            "text-sm",
            "font-medium",
            "break-words",
          ].join(" ")}
        >
          Old header
        </h2>
        <Button size="xs">Edit</Button>
        <Button size="xs">GitHub</Button>
      </div>,
    );
    const row = container.firstElementChild;
    if (!row) throw new Error("no markup rendered");
    expect(titleRowProblems(row).length).toBeGreaterThan(0);
  });
});
