import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { BinaryFileSummary } from "@/features/diff/BinaryFileSummary";
import { DiffContent } from "@/features/diff/DiffSurface";
import {
  DiffPaneHold,
  type DiffPaneHoldValue,
} from "@/features/diff/diff-pane-hold";
import { gitBlobSizes } from "@/lib/git/api";
import {
  MODE_CHANGE,
  sectionIsBinary,
  splitUnifiedDiff,
} from "@/lib/git/diff-split";
import type { BlobSizes } from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitBlobSizes: vi.fn(),
}));

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));

const blobSizes = vi.mocked(gitBlobSizes);

/** Non-zero hex of any length, so the oid-width guard never reads a zero run. */
const hex = (n: number) => "abcdef0123".repeat(7).slice(0, n);
const L = (n: number) => n.toLocaleString();

const MARKER = "Binary files a/x.png and b/x.png differ\n";
const section = (...lines: string[]) =>
  `diff --git a/x.png b/x.png\n${lines.map((l) => `${l}\n`).join("")}${MARKER}`;
const MODIFIED = section("index 0123abc..89defab 100644");
const ADDED = section("new file mode 100644", "index 0000000..abc1234");
const DELETED = section("deleted file mode 100644", "index abc1234..0000000");
const NO_INDEX = section();

/** A symlink at x.png replaced by a binary file: two sections of one path. */
const TYPECHANGE =
  "diff --git a/x.png b/x.png\ndeleted file mode 120000\nindex 3333ccc..0000000\n--- a/x.png\n+++ /dev/null\n@@ -1 +0,0 @@\n-target\ndiff --git a/x.png b/x.png\nnew file mode 100644\nindex 0000000..4444ddd\nBinary files /dev/null and b/x.png differ\n";

/** Lets a mount's effects and any dispatched lookup run. */
const tick = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

type Props = ComponentProps<typeof BinaryFileSummary>;

function renderSummary(props: Partial<Props> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const all: Props = {
    repoPath: "/repo",
    filePath: "x.png",
    text: MODIFIED,
    worktreeNewSide: false,
    ...props,
  };
  const view = render(
    <QueryClientProvider client={client}>
      <BinaryFileSummary {...all} />
    </QueryClientProvider>,
  );
  return { ...view, client, all };
}

const settled = (client: QueryClient) =>
  waitFor(() =>
    expect(
      client
        .getQueryCache()
        .getAll()
        .every((q) => q.state.status !== "pending"),
    ).toBe(true),
  );

/** The size line's box, pinned per width band: one line, two where the pair
 *  and end forms stack. Every state renders inside it. */
const SIZE_BOX =
  "flex h-4 w-full items-center justify-center @max-[31rem]/diff-pane:h-8";

/** The reserved box: present in every mounted state, with its pinned classes. */
function sizeBox(container: HTMLElement) {
  // The one-line band's arithmetic assumes the wrapper's max-w-lg cap.
  expect(container.firstElementChild?.className).toContain(" max-w-lg ");
  const box = container.firstElementChild?.firstElementChild;
  expect(box?.className).toBe(SIZE_BOX);
  return box as HTMLElement;
}

function expectNoFocusables(container: HTMLElement) {
  expect(container.querySelector("button, a, [tabindex]")).toBeNull();
}

beforeEach(() => {
  blobSizes.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("BinaryFileSummary states", () => {
  it("reserves a blank line with no sentence while sizes load", () => {
    blobSizes.mockReturnValue(new Promise<BlobSizes>(() => undefined));
    const { container } = renderSummary();
    expect(sizeBox(container).childElementCount).toBe(0);
    expect(container.querySelectorAll("p")).toHaveLength(0);
    expect(container.textContent).toBe("");
    expect(container.querySelector(".sr-only")).toBeNull();
    expectNoFocusables(container);
  });

  it("shows a size change with an exact-bytes sentence", async () => {
    blobSizes.mockResolvedValue({ oldSize: 48230, newSize: 51918 });
    const { container } = renderSummary();
    const sizes = await screen.findByText("47.1 KB → 50.7 KB");
    expect(screen.getByText("3.6 KB larger (+8%)")).toBeTruthy();
    const line = sizes.closest("p");
    expect(line?.getAttribute("aria-hidden")).toBe("true");
    const separator = screen.getByText("·");
    expect(separator.className).toBe("@max-[31rem]/diff-pane:hidden");
    expect(separator.closest("p")).toBe(line);
    // Stacks below the band instead of wrapping, so no "·" dangles.
    expect(line?.className).toBe(
      "flex items-center gap-x-1.5 @max-[31rem]/diff-pane:flex-col",
    );
    expect(line?.parentElement).toBe(sizeBox(container));
    expect(container.querySelector(".sr-only")?.textContent).toBe(
      `Size changed from ${L(48230)} bytes to ${L(51918)} bytes, ${L(3688)} bytes larger, 8 percent larger.`,
    );
    expectNoFocusables(container);
  });

  it("names a deleted and a new file", async () => {
    blobSizes.mockResolvedValue({ oldSize: 921600, newSize: null });
    const deleted = renderSummary({ text: DELETED });
    expect(await screen.findByText("Deleted file")).toBeTruthy();
    expect(screen.getByText("900 KB")).toBeTruthy();
    expect(deleted.container.querySelector(".sr-only")?.textContent).toBe(
      `Deleted file, ${L(921600)} bytes.`,
    );
    expectNoFocusables(deleted.container);
    cleanup();

    blobSizes.mockResolvedValue({ oldSize: null, newSize: 700 });
    const added = renderSummary({ text: ADDED });
    expect(await screen.findByText("New file")).toBeTruthy();
    expect(screen.getByText("700 B")).toBeTruthy();
    expect(added.container.querySelector(".sr-only")?.textContent).toBe(
      `New file, ${L(700)} bytes.`,
    );
  });

  it("says same size, different contents", async () => {
    blobSizes.mockResolvedValue({ oldSize: 5021, newSize: 5021 });
    const { container } = renderSummary();
    const text = await screen.findByText(
      "Same size (4.9 KB), different contents",
    );
    expect(text.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".sr-only")?.textContent).toBe(
      `Same size, ${L(5021)} bytes, different contents.`,
    );
    expectNoFocusables(container);
  });

  it("keeps the line blank when a present side is unsized", async () => {
    blobSizes.mockResolvedValue({ oldSize: null, newSize: null });
    const { container, client } = renderSummary({ text: ADDED });
    await settled(client);
    expect(blobSizes).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("New file")).toBeNull();
    expect(container.textContent).toBe("");
    expect(sizeBox(container).childElementCount).toBe(0);
    cleanup();

    blobSizes.mockResolvedValue({ oldSize: null, newSize: 700 });
    const partial = renderSummary();
    await settled(partial.client);
    expect(partial.container.textContent).toBe("");
    expect(partial.container.querySelector(".sr-only")).toBeNull();
  });

  it("keeps the line blank on a failed read, with no notice", async () => {
    blobSizes.mockRejectedValue({
      kind: "invalidArgument",
      message: "refused",
    });
    const { container, client } = renderSummary();
    await settled(client);
    expect(client.getQueryCache().getAll()[0]?.state.status).toBe("error");
    expect(container.textContent).toBe("");
    expect(sizeBox(container).childElementCount).toBe(0);
    expect(container.querySelector('[role="status"], [role="alert"]')).toBe(
      null,
    );
  });

  it("shows a mode change beside the sizes, and alone while they load", async () => {
    const flip = section(
      "old mode 100644",
      "new mode 100755",
      "index 0123abc..89defab",
    );
    const sentence = MODE_CHANGE["to-exec"]("100644", "100755");
    blobSizes.mockReturnValue(new Promise<BlobSizes>(() => undefined));
    const pending = renderSummary({ text: flip });
    expect(screen.getByText(sentence).getAttribute("aria-hidden")).toBeNull();
    expect(sizeBox(pending.container).textContent).toBe("");
    cleanup();

    blobSizes.mockResolvedValue({ oldSize: 48230, newSize: 51918 });
    const { container } = renderSummary({ text: flip });
    expect(await screen.findByText("47.1 KB → 50.7 KB")).toBeTruthy();
    expect(screen.getByText(sentence)).toBeTruthy();
    expectNoFocusables(container);
  });
});

describe("BinaryFileSummary gating", () => {
  beforeEach(() => {
    blobSizes.mockResolvedValue({ oldSize: 1, newSize: 2 });
  });

  it("looks up a local surface ungated", async () => {
    const { client } = renderSummary();
    await settled(client);
    expect(blobSizes).toHaveBeenCalledWith(
      "/repo",
      "0123abc",
      "89defab",
      null,
      null,
    );
  });

  it.each([
    ["40-hex", hex(40)],
    ["64-hex", hex(64)],
  ])("passes a full %s anchor lowercased", async (_, anchor) => {
    const { client } = renderSummary({ anchorCommit: anchor.toUpperCase() });
    await settled(client);
    expect(blobSizes).toHaveBeenCalledWith(
      "/repo",
      "0123abc",
      "89defab",
      null,
      anchor,
    );
  });

  it.each([
    ["null", null],
    ["7-hex", "abc1234"],
    ["39-hex", hex(39)],
    ["non-hex", "not-a-commit-id-not-a-commit-id-not-a-co"],
  ])("suppresses a PR surface with a %s anchor", (_, anchor) => {
    const { container } = renderSummary({ anchorCommit: anchor });
    expect(container.innerHTML).toBe("");
    expect(blobSizes).not.toHaveBeenCalled();
  });

  it("renders nothing for a section with no index line", () => {
    const { container } = renderSummary({ text: NO_INDEX });
    expect(container.innerHTML).toBe("");
    expect(blobSizes).not.toHaveBeenCalled();
  });

  it.each([
    ["a modified working-tree file", MODIFIED, true, "x.png"],
    ["an untracked file", ADDED, true, "x.png"],
    ["a deleted working-tree file", DELETED, true, null],
    ["a staged file", MODIFIED, false, null],
  ] as const)(
    "stats %s only when its new side is on disk",
    async (_, text, worktreeNewSide, worktreeFile) => {
      const { client } = renderSummary({ text, worktreeNewSide });
      await settled(client);
      expect(blobSizes).toHaveBeenCalledTimes(1);
      expect(blobSizes.mock.calls[0][3]).toBe(worktreeFile);
    },
  );
});

describe("BinaryFileSummary caching", () => {
  it("re-renders of the same diff reuse one lookup; new ids read again", async () => {
    blobSizes.mockResolvedValue({ oldSize: 48230, newSize: 51918 });
    const { client, rerender, all } = renderSummary();
    await screen.findByText("47.1 KB → 50.7 KB");
    rerender(
      <QueryClientProvider client={client}>
        <BinaryFileSummary {...all} text={`${MODIFIED}`} />
      </QueryClientProvider>,
    );
    await settled(client);
    expect(blobSizes).toHaveBeenCalledTimes(1);

    rerender(
      <QueryClientProvider client={client}>
        <BinaryFileSummary
          {...all}
          text={section("index 0123abc..fedcba9 100644")}
        />
      </QueryClientProvider>,
    );
    await settled(client);
    expect(blobSizes).toHaveBeenCalledTimes(2);
    expect(blobSizes.mock.calls[1][2]).toBe("fedcba9");
  });

  it("the same ids under another anchor read again, never the first anchor's sizes", async () => {
    const first = "1".repeat(40);
    const second = "2".repeat(40);
    blobSizes.mockResolvedValueOnce({ oldSize: 48230, newSize: 51918 });
    const { container, client, rerender, all } = renderSummary({
      anchorCommit: first,
    });
    await screen.findByText("47.1 KB → 50.7 KB");

    // The second anchor's store doesn't hold these blobs.
    blobSizes.mockResolvedValueOnce({ oldSize: null, newSize: null });
    rerender(
      <QueryClientProvider client={client}>
        <BinaryFileSummary {...all} anchorCommit={second} />
      </QueryClientProvider>,
    );
    await settled(client);
    expect(blobSizes).toHaveBeenCalledTimes(2);
    expect(blobSizes.mock.calls[1][4]).toBe(second);
    expect(screen.queryByText("47.1 KB → 50.7 KB")).toBeNull();
    expect(sizeBox(container).childElementCount).toBe(0);
  });
});

describe("BinaryFileSummary layout", () => {
  it.each([
    ["end", DELETED, { oldSize: 921600, newSize: null }, "Deleted file"],
    [
      "same",
      MODIFIED,
      { oldSize: 5021, newSize: 5021 },
      "Same size (4.9 KB), different contents",
    ],
  ] as const)(
    "renders the %s form inside the reserved box",
    async (_, text, sizes, shown) => {
      blobSizes.mockResolvedValue(sizes);
      const { container } = renderSummary({ text });
      const el = await screen.findByText(shown);
      expect(sizeBox(container).contains(el)).toBe(true);
    },
  );

  it("sizes a typechange's lone side without a new or deleted claim", async () => {
    blobSizes.mockResolvedValue({ oldSize: null, newSize: 716800 });
    const { container } = renderSummary({ text: TYPECHANGE });
    expect(await screen.findByText("700 KB")).toBeTruthy();
    expect(container.textContent).not.toMatch(/New file|Deleted file/);
    expect(container.querySelector(".sr-only")?.textContent).toBe(
      `${L(716800)} bytes.`,
    );
  });

  it("a PR patch's typechange, once split, still sizes without a new-file claim", async () => {
    blobSizes.mockResolvedValue({ oldSize: null, newSize: 716800 });
    const text = splitUnifiedDiff(
      `${MODIFIED.replace(/x\.png/g, "y.png")}${TYPECHANGE}`,
    ).get("x.png");
    const { container } = renderSummary({ text, anchorCommit: hex(40) });
    expect(await screen.findByText("700 KB")).toBeTruthy();
    expect(container.textContent).not.toMatch(/New file|Deleted file/);
  });

  it("DiffContent renders a split typechange through the binary arm", async () => {
    blobSizes.mockResolvedValue({ oldSize: null, newSize: 716800 });
    const text = splitUnifiedDiff(TYPECHANGE).get("x.png") ?? "";
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = render(
      <QueryClientProvider client={client}>
        <DiffContent
          filePath="x.png"
          data={{
            filePath: "x.png",
            text,
            isBinary: sectionIsBinary(text),
            isTruncated: false,
          }}
          isPending={false}
          isError={false}
          repoPath="/repo"
          anchorCommit={hex(40)}
        />
      </QueryClientProvider>,
    );
    expect(
      await screen.findByText("Binary file — no text diff available"),
    ).toBeTruthy();
    expect(await screen.findByText("700 KB")).toBeTruthy();
    expect(container.textContent).not.toMatch(/New file|Deleted file/);
  });
});

describe("a split binary-to-symlink typechange", () => {
  // @git-diff-view measures text on a 2D canvas, which jsdom leaves null.
  beforeAll(() => {
    const measure = {
      font: "",
      measureText: (t: string) => ({ width: t.length }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => measure as unknown as CanvasRenderingContext2D,
    );
  });

  it("DiffContent renders the symlink text, never the binary placeholder", async () => {
    vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
    const patch =
      "diff --git a/x b/x\ndeleted file mode 100644\nindex 5555eee..0000000\n" +
      "Binary files a/x and /dev/null differ\n" +
      "diff --git a/x b/x\nnew file mode 120000\nindex 0000000..6666fff\n" +
      "--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+target\n";
    const text = splitUnifiedDiff(patch).get("x") ?? "";
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <DiffContent
          filePath="x"
          data={{
            filePath: "x",
            text,
            isBinary: sectionIsBinary(text),
            isTruncated: false,
          }}
          isPending={false}
          isError={false}
          repoPath="/repo"
          anchorCommit={hex(40)}
        />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("target")).toBeTruthy();
    expect(
      screen.queryByText("Binary file — no text diff available"),
    ).toBeNull();
    expect(blobSizes).not.toHaveBeenCalled();
  });
});

describe("BinaryFileSummary placeholder hold", () => {
  it("keeps the box and mode line while held, with no lookup; looks up once released", async () => {
    blobSizes.mockResolvedValue({ oldSize: 48230, newSize: 51918 });
    const flip = section(
      "old mode 100644",
      "new mode 100755",
      "index 0123abc..89defab",
    );
    const { container, client, rerender, all } = renderSummary({
      text: flip,
      held: true,
    });
    await tick();
    expect(blobSizes).not.toHaveBeenCalled();
    expect(sizeBox(container).childElementCount).toBe(0);
    expect(
      screen.getByText(MODE_CHANGE["to-exec"]("100644", "100755")),
    ).toBeTruthy();

    rerender(
      <QueryClientProvider client={client}>
        <BinaryFileSummary {...all} held={false} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("47.1 KB → 50.7 KB")).toBeTruthy();
    expect(blobSizes).toHaveBeenCalledTimes(1);
  });

  it("keeps the line last shown while held, blanks for the next patch's lookup, then shows it", async () => {
    blobSizes.mockResolvedValueOnce({ oldSize: 48230, newSize: 51918 });
    const { container, client, rerender, all } = renderSummary();
    expect(await screen.findByText("47.1 KB → 50.7 KB")).toBeTruthy();
    const at = (props: Partial<Props>) =>
      rerender(
        <QueryClientProvider client={client}>
          <BinaryFileSummary {...all} {...props} />
        </QueryClientProvider>,
      );

    // The placeholder is the patch just shown, under the next anchor.
    at({ held: true, anchorCommit: undefined });
    await tick();
    expect(screen.getByText("47.1 KB → 50.7 KB")).toBeTruthy();
    expect(container.querySelector(".sr-only")?.textContent).toMatch(
      /^Size changed from /,
    );
    expect(blobSizes).toHaveBeenCalledTimes(1);

    let resolve: (sizes: BlobSizes) => void = () => undefined;
    blobSizes.mockReturnValueOnce(
      new Promise<BlobSizes>((r) => {
        resolve = r;
      }),
    );
    at({ held: false, text: ADDED });
    expect(sizeBox(container).childElementCount).toBe(0);
    expect(container.querySelector(".sr-only")).toBeNull();
    await tick();
    expect(blobSizes).toHaveBeenCalledTimes(2);

    resolve({ oldSize: null, newSize: 716800 });
    expect(await screen.findByText("New file")).toBeTruthy();
    expect(screen.getByText("700 KB")).toBeTruthy();
  });

  it("holds a blank when the last line shown was blank, never an older answer", async () => {
    blobSizes.mockResolvedValueOnce({ oldSize: 48230, newSize: 51918 });
    const { container, client, rerender, all } = renderSummary();
    await screen.findByText("47.1 KB → 50.7 KB");
    blobSizes.mockReturnValue(new Promise<BlobSizes>(() => undefined));
    const at = (props: Partial<Props>) =>
      rerender(
        <QueryClientProvider client={client}>
          <BinaryFileSummary {...all} {...props} />
        </QueryClientProvider>,
      );
    at({ text: ADDED });
    expect(sizeBox(container).childElementCount).toBe(0);
    at({ text: ADDED, held: true });
    await tick();
    expect(sizeBox(container).childElementCount).toBe(0);
    expect(container.textContent).toBe("");
  });

  it("sends no lookup for two absent ids, keeping the box", async () => {
    const { container } = renderSummary({
      text: section("index 0000000..0000000"),
    });
    await tick();
    expect(blobSizes).not.toHaveBeenCalled();
    expect(sizeBox(container).childElementCount).toBe(0);
  });
});

describe("BinaryFileSummary remount", () => {
  it("a remount on the same client reuses the cached lookup", async () => {
    blobSizes.mockResolvedValue({ oldSize: 48230, newSize: 51918 });
    const { client, unmount, all } = renderSummary();
    await screen.findByText("47.1 KB → 50.7 KB");
    unmount();
    render(
      <QueryClientProvider client={client}>
        <BinaryFileSummary {...all} />
      </QueryClientProvider>,
    );
    expect(screen.getByText("47.1 KB → 50.7 KB")).toBeTruthy();
    await tick();
    expect(blobSizes).toHaveBeenCalledTimes(1);
  });
});

describe("BinaryFileSummary settle gate", () => {
  /** Renders under a stub slot recording every settle report. */
  function renderInSlot(props: Partial<Props>) {
    const reports: boolean[] = [];
    const value: DiffPaneHoldValue = {
      interactive: true,
      phase: "shown",
      reportSettled: (s) => {
        reports.push(s);
        return () => undefined;
      },
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <DiffPaneHold.Provider value={value}>
          <BinaryFileSummary
            repoPath="/repo"
            filePath="x.png"
            text={MODIFIED}
            worktreeNewSide={false}
            {...props}
          />
        </DiffPaneHold.Provider>
      </QueryClientProvider>,
    );
    return reports;
  }

  it("reports unsettled while sizes load, settled once they land", async () => {
    let resolve: (sizes: BlobSizes) => void = () => undefined;
    blobSizes.mockReturnValue(
      new Promise<BlobSizes>((r) => {
        resolve = r;
      }),
    );
    const reports = renderInSlot({});
    expect(reports).toEqual([false]);
    resolve({ oldSize: 1, newSize: 2 });
    await waitFor(() => expect(reports.at(-1)).toBe(true));
  });

  it.each([
    ["a suppressed PR anchor", { anchorCommit: null }],
    ["no index line", { text: NO_INDEX }],
    ["a placeholder patch", { held: true }],
  ] as const)("reports settled at once for %s", (_, props) => {
    const reports = renderInSlot(props);
    expect(reports).toEqual([true]);
    expect(blobSizes).not.toHaveBeenCalled();
  });
});
