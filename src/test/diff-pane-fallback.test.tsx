import type { UseQueryResult } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { use } from "react";
import { describe, expect, it, vi } from "vitest";
import { DIFF_PANE_ROOT_CLASS } from "@/features/diff/DiffPathRow";
import type { FileDiff } from "@/lib/git/types";

// The real chunk would resolve; a module whose components never stop
// suspending holds every wrapper on its Suspense fallback.
vi.mock("@/features/diff/DiffSurface", () => {
  const never = new Promise<never>(() => undefined);
  const Pending = () => use(never);
  return { DiffSurface: Pending, DiffContent: Pending, GitDiffView: Pending };
});

// Imported dynamically: the slot-roster scan (scripts/diff-pane-hold.test.mjs)
// closes the wrapper's static importers to the app's diff hosts.
const { DiffContent, DiffSurface, GitDiffView } = await import(
  "@/features/diff/DiffSurfaceLazy"
);

const PATH = "src/features/deep/nested/module/file-name.ts";

/** The fallback's announcement, its busy body, and the pane root. */
function fallbackParts(container: HTMLElement) {
  const status = screen.getByRole("status");
  const busy = container.querySelector('[aria-busy="true"]');
  return { status, busy, root: container.firstElementChild };
}

describe("lazy diff wrappers' Suspense fallback", () => {
  it.each([
    [
      "DiffSurface",
      () => (
        <DiffSurface filePath={PATH} diff={{} as UseQueryResult<FileDiff>} />
      ),
    ],
    [
      "DiffContent",
      () => (
        <DiffContent
          filePath={PATH}
          data={undefined}
          isPending
          isError={false}
        />
      ),
    ],
  ])("%s paints the path row over a busy blank body", (_name, ui) => {
    const { container } = render(ui());
    const { status, busy, root } = fallbackParts(container);

    // The row names the whole path (PathText splits it into two spans).
    expect(root?.textContent).toContain(PATH);
    expect(root?.className).toBe(DIFF_PANE_ROOT_CLASS);
    expect(root?.classList.contains("ph-no-capture")).toBe(true);
    expect(status.textContent).toBe("Loading the diff…");
    expect(busy).not.toBeNull();
    // The status is the busy region's sibling, never inside it.
    expect(busy?.contains(status)).toBe(false);
    expect(status.parentElement).toBe(busy?.parentElement);
    // The row's controls landing is in place, with nothing in it yet.
    expect(root?.querySelector('span[tabindex="-1"]')?.childElementCount).toBe(
      0,
    );
  });

  it("GitDiffView keeps its blank fallback (its hosts draw their own headers)", () => {
    const { container } = render(<GitDiffView filePath={PATH} text="" />);
    expect(container.textContent).not.toContain("file-name.ts");
    expect(screen.queryByRole("button", { name: /Diff options/ })).toBeNull();
    expect(container.querySelector(".ph-no-capture")).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });
});
