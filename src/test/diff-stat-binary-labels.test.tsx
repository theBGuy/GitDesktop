import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DiffStat, DiffStatSlot } from "@/components/diff-stat";
import type { BinaryKind } from "@/lib/git/types";

/** The visible word and the screen-reader sentence of one rendered cell. */
function cell(container: HTMLElement) {
  const root = container.firstElementChild;
  const visible = root?.querySelector("[aria-hidden]")?.textContent;
  const sr = root?.querySelector(".sr-only")?.textContent;
  return { visible, sr };
}

const KINDS: [BinaryKind | null | undefined, string, string][] = [
  ["mode", "mode", "Binary file, mode changed"],
  ["renamed", "renamed", "Binary file, renamed"],
  ["renamedMode", "renamed", "Binary file, renamed and mode changed"],
  [null, "bin", "Binary file"],
  [undefined, "bin", "Binary file"],
];

describe("DiffStat binary labels", () => {
  it.each(KINDS)("binaryKind %s reads %s / %s", (kind, visible, sr) => {
    const { container } = render(
      <DiffStat added={0} deleted={0} isBinary binaryKind={kind} />,
    );
    expect(cell(container)).toEqual({ visible, sr });
  });

  it("forwards the kind through DiffStatSlot", () => {
    const { container } = render(
      <DiffStatSlot
        stat={{ added: 0, deleted: 0, isBinary: true, binaryKind: "mode" }}
      />,
    );
    expect(cell(container)).toEqual({
      visible: "mode",
      sr: "Binary file, mode changed",
    });
  });

  it("never relabels a counts row", () => {
    const { container } = render(
      <DiffStat added={3} deleted={1} binaryKind="renamed" />,
    );
    expect(container.textContent).not.toContain("renamed");
    expect(container.textContent).toContain("+3");
    expect(container.textContent).toContain("3 lines added, 1 line deleted");
  });
});
