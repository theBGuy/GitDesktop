import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PathText } from "@/components/path-text";

/** The head cap as specified, built independently of the component's constant
 *  so a drift in the advance or the floor goes red. */
const formula = (n: number) =>
  `max(calc(round(down, calc(100% - ${n} * 0.6em), 0.6em) + 0.05px), 1.2em)`;

/** jsdom normalizes a math function it keeps, so compare through a probe. */
function normalized(value: string): string {
  const probe = document.createElement("span");
  probe.style.maxWidth = value;
  return probe.style.maxWidth;
}

function outer(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement;
}

/** jsdom lays nothing out, so a clip is stubbed as a browser would measure it. */
function measure(el: Element, scrollWidth: number, clientWidth: number) {
  Object.defineProperty(el, "scrollWidth", {
    configurable: true,
    value: scrollWidth,
  });
  Object.defineProperty(el, "clientWidth", {
    configurable: true,
    value: clientWidth,
  });
}

const EMOJI = String.fromCodePoint(0x1f600);
const NO_DIRECTORY = ["README.md", "/abs", ""];

describe("PathText markup", () => {
  it("a path with a directory renders hidden visual spans and one full copy", () => {
    const { container } = render(
      <PathText path="src/components/detail-rail.tsx" />,
    );
    const root = outer(container);
    const [head, leaf, sr] = Array.from(root.children) as HTMLElement[];
    expect(root.children).toHaveLength(3);
    expect(head).toHaveAttribute("aria-hidden", "true");
    expect(leaf).toHaveAttribute("aria-hidden", "true");
    expect(sr).toHaveClass("sr-only", "select-none");
    expect(sr).not.toHaveAttribute("aria-hidden");
    expect(sr.textContent).toBe("src/components/detail-rail.tsx");
    expect(`${head.textContent}${leaf.textContent}`).toBe(
      "src/components/detail-rail.tsx",
    );
  });

  it.each(NO_DIRECTORY)("no directory (%j) keeps one span", (path) => {
    const { container } = render(<PathText path={path} />);
    const root = outer(container);
    expect(root.children).toHaveLength(1);
    const leaf = root.firstElementChild as HTMLElement;
    expect(leaf).not.toHaveAttribute("aria-hidden");
    expect(leaf).not.toHaveAttribute("style");
    expect(root.querySelector(".sr-only")).toBeNull();
    expect(root.querySelector("[style]")).toBeNull();
    expect(leaf.textContent).toBe(path);
  });

  it("trailing separators stay with the leaf", () => {
    const { container } = render(<PathText path="a/b/" />);
    const [head, leaf, sr] = Array.from(outer(container).children);
    expect(head.textContent).toBe("a");
    expect(leaf.textContent).toBe("/b/");
    expect(sr.textContent).toBe("a/b/");
  });

  it("a backslash path splits at its last separator", () => {
    const { container } = render(<PathText path={"C:\\x\\y.txt"} />);
    const [head, leaf, sr] = Array.from(outer(container).children);
    expect(head.textContent).toBe("C:\\x");
    expect(leaf.textContent).toBe("\\y.txt");
    expect(sr.textContent).toBe("C:\\x\\y.txt");
  });

  it("a line number rides the leaf and the full copy", () => {
    const { container } = render(<PathText path="a/b.ts" line={7} />);
    const [head, leaf, sr] = Array.from(outer(container).children);
    expect(head.textContent).toBe("a");
    expect(leaf.textContent).toBe("/b.ts:7");
    expect(sr.textContent).toBe("a/b.ts:7");
  });
});

describe("PathText accessible name", () => {
  it("names a host with the path once", () => {
    render(
      <button type="button">
        <PathText path="src/components/detail-rail.tsx" /> +12 -3
      </button>,
    );
    expect(screen.getByRole("button")).toHaveAccessibleName(
      "src/components/detail-rail.tsx +12 -3",
    );
  });

  it("names a host with the path and its line", () => {
    render(
      <button type="button">
        <PathText path="a/b.ts" line={42} />
      </button>,
    );
    expect(screen.getByRole("button")).toHaveAccessibleName("a/b.ts:42");
  });
});

describe("PathText head width", () => {
  it.each([
    ["src/components/detail-rail.tsx", undefined, 16],
    ["a/b.ts", 7, 7],
    ["a/b/", undefined, 3],
    ["C:\\Users\\x\\file.txt", undefined, 9],
    ["a b/c d.ts", undefined, 7],
    ["docs/my notes/read me.md", undefined, 11],
    // The line suffix ends the leaf, so the filename's trailing space is inner.
    ["src/notes.txt ", 3, 13],
  ])("%j (line %j) caps the head beside a %i-glyph leaf", (path, line, n) => {
    const { container } = render(<PathText path={path} line={line} />);
    const head = outer(container).firstElementChild as HTMLElement;
    const expected = normalized(formula(n));
    expect(expected).not.toBe("");
    expect(head.style.maxWidth).toBe(expected);
  });

  it.each([
    "docs/日本語/ファイル.md",
    "a/é.ts",
    "a/b\tc.ts",
    `a/${EMOJI}.ts`,
    "日本/b.ts",
  ])("a path outside printable ASCII (%j) leaves the head unstyled", (path) => {
    const { container } = render(<PathText path={path} />);
    const root = outer(container);
    expect(root.children).toHaveLength(3);
    expect(root.querySelector("[style]")).toBeNull();
  });

  it.each(["docs/a  b.md", "src/notes.txt ", " a/b "])(
    "a leaf nowrap collapses (%j) leaves the head unstyled",
    (path) => {
      const { container } = render(<PathText path={path} />);
      const head = outer(container).firstElementChild as HTMLElement;
      expect(head).toHaveAttribute("aria-hidden", "true");
      expect(head.style.maxWidth).toBe("");
      expect(head).not.toHaveAttribute("style");
    },
  );
});

describe("PathText tooltip", () => {
  it("a clipped head titles the outer span with the path", () => {
    const { container } = render(<PathText path="a/b/c.ts" />);
    const root = outer(container);
    measure(root.children[0], 500, 100);
    fireEvent.mouseEnter(root);
    expect(root).toHaveAttribute("title", "a/b/c.ts");
  });

  it("a clipped head titles with the title prop when given", () => {
    const { container } = render(
      <PathText path="b/c.ts" title="/repo/a/b/c.ts" />,
    );
    const root = outer(container);
    measure(root.children[0], 500, 100);
    fireEvent.mouseEnter(root);
    expect(root).toHaveAttribute("title", "/repo/a/b/c.ts");
  });

  it("an unclipped path sets no title", () => {
    const { container } = render(<PathText path="a/b/c.ts" />);
    const root = outer(container);
    fireEvent.mouseEnter(root);
    expect(root).not.toHaveAttribute("title");
  });

  it("the sr-only copy never counts as clipped", () => {
    const { container } = render(<PathText path="a/b/c.ts" />);
    const root = outer(container);
    const sr = root.querySelector(".sr-only") as HTMLElement;
    measure(sr, 500, 1);
    fireEvent.mouseEnter(root);
    expect(root).not.toHaveAttribute("title");
  });

  it("a clipped lone filename titles the outer span", () => {
    const { container } = render(<PathText path="README.md" />);
    const root = outer(container);
    measure(root.children[0], 500, 100);
    fireEvent.mouseEnter(root);
    expect(root).toHaveAttribute("title", "README.md");
  });

  it("keeps a path's own leading and trailing whitespace", () => {
    const { container } = render(<PathText path=" a/b " />);
    const root = outer(container);
    expect(root.querySelector(".sr-only")?.textContent).toBe(" a/b ");
    measure(root.children[0], 500, 100);
    fireEvent.mouseEnter(root);
    expect(root.getAttribute("title")).toBe(" a/b ");
  });

  it("a whitespace-only tip never sets a title", () => {
    const { container } = render(<PathText path="   " />);
    const root = outer(container);
    measure(root.children[0], 500, 100);
    fireEvent.mouseEnter(root);
    expect(root).not.toHaveAttribute("title");

    const titled = render(<PathText path="a/b.ts" title="  " />);
    const titledRoot = outer(titled.container);
    measure(titledRoot.children[0], 500, 100);
    fireEvent.mouseEnter(titledRoot);
    expect(titledRoot).not.toHaveAttribute("title");
  });

  it("a rerender with a new path drops the stale title", () => {
    const { container, rerender } = render(<PathText path="a/b/c.ts" />);
    const root = outer(container);
    measure(root.children[0], 500, 100);
    fireEvent.mouseEnter(root);
    expect(root).toHaveAttribute("title", "a/b/c.ts");
    rerender(<PathText path="x/y.ts" />);
    expect(outer(container)).toBe(root);
    expect(root).not.toHaveAttribute("title");
  });
});
