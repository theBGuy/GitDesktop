import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DiffContent, GitDiffView } from "@/features/diff/DiffSurface";
import { DiffPaneHold } from "@/features/diff/diff-pane-hold";
import { gitFileBase64 } from "@/lib/git/api";
import { splitUnifiedDiff } from "@/lib/git/diff-split";
import type { FileDiff } from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitFileBase64: vi.fn(),
}));

const PATH = "docs/notes/deep/readme.txt";
const OTHER = "docs/notes/other.txt";

/** A unified diff of `hunks` hunks, each `pairs` removed/added line pairs. */
function diffText(path: string, hunks: number, pairs: number, tag = "") {
  let out = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`;
  for (let h = 0; h < hunks; h++) {
    const start = 1 + h * (pairs + 20);
    out += `@@ -${start},${pairs} +${start},${pairs} @@\n`;
    for (let i = 0; i < pairs; i++)
      out += `-old ${h}.${i}\n+new${tag} ${h}.${i}\n`;
  }
  return out;
}

// Over DIFF_LINE_CAP (200), so the footer offers Show full diff.
const CAPPED = diffText(PATH, 3, 40);
const SHORT = diffText(PATH, 1, 20);

function fileDiff(filePath: string, text: string): FileDiff {
  return { filePath, text, isBinary: false, isTruncated: false };
}

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

let client: QueryClient;
beforeEach(() => {
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
});

function wrap(node: ReactNode, interactive = true) {
  return (
    <QueryClientProvider client={client}>
      <DiffPaneHold.Provider
        value={{
          interactive,
          phase: interactive ? "shown" : "held",
          reportSettled: () => () => undefined,
        }}
      >
        <button type="button">elsewhere</button>
        {node}
      </DiffPaneHold.Provider>
    </QueryClientProvider>
  );
}

function content(filePath: string, text: string, interactive = true) {
  return wrap(
    <DiffContent
      filePath={filePath}
      data={fileDiff(filePath, text)}
      isPending={false}
      isError={false}
    />,
    interactive,
  );
}

const showFull = () => screen.findByRole("button", { name: "Show full diff" });
/** The diff's own landing: a group named for the diff it holds. */
const diffGroup = (path = PATH) =>
  screen.getByRole("group", { name: `Diff of ${path}` });

describe("Show full diff focus landing", () => {
  it("pressing it lands on the diff's named group, without scrolling", async () => {
    const user = userEvent.setup();
    render(content(PATH, CAPPED));
    const button = await showFull();
    const landing = diffGroup();
    const focus = vi.spyOn(landing, "focus");

    await user.click(button);

    expect(document.activeElement).toBe(landing);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    // The diff expanded: the footer and its button are gone.
    expect(screen.queryByRole("button", { name: "Show full diff" })).toBeNull();
  });

  it("a same-file refresh that uncaps the diff lands the same way", async () => {
    const { rerender } = render(content(PATH, CAPPED));
    (await showFull()).focus();
    await act(async () => rerender(content(PATH, SHORT)));

    expect(screen.queryByRole("button", { name: "Show full diff" })).toBeNull();
    expect(document.activeElement).toBe(diffGroup());
  });

  it("a file switch that takes the button away does not land", async () => {
    const { rerender } = render(content(PATH, CAPPED));
    (await showFull()).focus();
    await act(async () => rerender(content(OTHER, diffText(OTHER, 1, 20))));

    expect(screen.queryByRole("button", { name: "Show full diff" })).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it("focus elsewhere at the unmount never moves", async () => {
    render(content(PATH, CAPPED));
    const button = await showFull();
    const elsewhere = screen.getByRole("button", { name: "elsewhere" });
    elsewhere.focus();
    const focus = vi.spyOn(diffGroup(), "focus");

    act(() => {
      fireEvent.click(button);
    });

    expect(document.activeElement).toBe(elsewhere);
    expect(focus).not.toHaveBeenCalled();
  });

  it("focus on <body> at the unmount stays there", async () => {
    render(content(PATH, CAPPED));
    const button = await showFull();
    const focus = vi.spyOn(diffGroup(), "focus");

    act(() => {
      fireEvent.click(button);
    });

    expect(document.activeElement).toBe(document.body);
    expect(focus).not.toHaveBeenCalled();
  });

  it("a re-render that keeps the button mounted and focused never moves it", async () => {
    const { rerender } = render(content(PATH, CAPPED));
    const button = await showFull();
    button.focus();
    // Still over the cap: the same footer button stays up.
    await act(async () => rerender(content(PATH, diffText(PATH, 3, 41, "x"))));

    expect(button.isConnected).toBe(true);
    expect(document.activeElement).toBe(button);
  });

  it("a held or preparing slot never takes focus", async () => {
    render(content(PATH, CAPPED, false));
    const button = await showFull();
    const focus = vi.spyOn(diffGroup(), "focus");
    button.focus();

    act(() => {
      fireEvent.click(button);
    });

    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });

  it("a bare GitDiffView lands on the diff's group too, with its sink rendered beside the diff", async () => {
    const user = userEvent.setup();
    const { container } = render(
      wrap(<GitDiffView filePath={PATH} text={CAPPED} />),
    );
    await user.click(await showFull());

    const sink = container.querySelector('span.sr-only[tabindex="-1"]');
    expect(sink).not.toBeNull();
    expect(diffGroup().contains(sink)).toBe(false);
    expect(document.activeElement).toBe(diffGroup());
  });

  it("the diff's group outranks the host's landing", async () => {
    const user = userEvent.setup();
    const host = document.createElement("button");
    document.body.append(host);
    const hostFocus = vi.spyOn(host, "focus");
    try {
      render(
        wrap(
          <GitDiffView
            filePath={PATH}
            text={CAPPED}
            revealLanding={{ current: host }}
          />,
        ),
      );
      await user.click(await showFull());

      expect(
        screen.queryByRole("button", { name: "Show full diff" }),
      ).toBeNull();
      expect(document.activeElement).toBe(diffGroup());
      expect(hostFocus).not.toHaveBeenCalled();
    } finally {
      host.remove();
    }
  });

  it("a refresh that leaves no diff to show lands on the bare view's sink", async () => {
    const { container, rerender } = render(
      wrap(<GitDiffView filePath={PATH} text={CAPPED} />),
    );
    (await showFull()).focus();
    await act(async () =>
      rerender(wrap(<GitDiffView filePath={PATH} text="" />)),
    );

    expect(screen.getByText("No changes to show")).toBeTruthy();
    expect(screen.queryByRole("group", { name: `Diff of ${PATH}` })).toBeNull();
    const sink = container.querySelector('span.sr-only[tabindex="-1"]');
    expect(sink).not.toBeNull();
    expect(document.activeElement).toBe(sink);
  });

  it("a refresh whose whole-file reads go pending lands on the host's path-row controls", async () => {
    // Never settles: content mode holds the paint while its reads are out.
    vi.mocked(gitFileBase64).mockReturnValue(new Promise(() => undefined));
    const host = (text: string) =>
      wrap(
        <DiffContent
          filePath={PATH}
          data={fileDiff(PATH, text)}
          isPending={false}
          isError={false}
          repoPath="/repo"
          contentRevs={{ oldRev: "HEAD", newRev: null }}
        />,
      );
    const { container, rerender } = render(host(CAPPED));
    (await showFull()).focus();
    await act(async () => rerender(host(SHORT)));

    expect(gitFileBase64).toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: `Diff of ${PATH}` })).toBeNull();
    const controls = container.querySelector('span.min-h-7[tabindex="-1"]');
    expect(controls).not.toBeNull();
    expect(document.activeElement).toBe(controls);
  });
});

describe("a forge patch's text typechange", () => {
  it("renders its creation section after the split, never an empty diff", async () => {
    const patch =
      "diff --git a/x b/x\ndeleted file mode 100644\nindex 1111aaa..0000000\n" +
      "--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-hello\n" +
      "diff --git a/x b/x\nnew file mode 120000\nindex 0000000..2222bbb\n" +
      "--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+target\n";
    render(content("x", splitUnifiedDiff(patch).get("x") ?? ""));

    expect(await screen.findByText("target")).toBeTruthy();
    expect(screen.queryByText("No changes to show")).toBeNull();
  });
});

describe("Show full diff keeps the reading position", () => {
  const ROW_PX = 20;

  /** Lays each diff row out ROW_PX tall in document order under a scroller
   *  whose scrollTop the test owns: jsdom has no layout of its own. */
  function layOut(scroller: HTMLElement) {
    const pane = { top: 0 };
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => pane.top,
      set: (v: number) => {
        pane.top = v;
      },
    });
    const rows = () => Array.from(scroller.querySelectorAll("tr[data-line]"));
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const i = this.matches("tr[data-line]") ? rows().indexOf(this) : -1;
        const y = i < 0 ? 0 : i * ROW_PX - pane.top;
        return { top: y, bottom: i < 0 ? 0 : y + ROW_PX } as DOMRect;
      });
    /** The line numbers on the row at the scroller's top edge. */
    const topLine = () => {
      const row = rows()[Math.floor(pane.top / ROW_PX)];
      return [...row.querySelectorAll("span")]
        .map((span) =>
          ["data-line-old-num", "data-line-new-num"]
            .map((attr) => span.getAttribute(attr) ?? "")
            .join("/"),
        )
        .filter((pair) => pair !== "/")
        .join(" ");
    };
    return { pane, topLine, restore: () => rect.mockRestore() };
  }

  async function capped() {
    const { container } = render(content(PATH, CAPPED));
    const button = await showFull();
    const scroller = container.querySelector<HTMLElement>("div.overflow-auto");
    if (scroller === null) throw new Error("the diff scroller");
    return { button, scroller, ...layOut(scroller) };
  }

  /** The browser's own scroll after the expand's commit (a clamp or a
   *  re-anchor the app never asked for): no input precedes it. */
  const browserScroll = (scroller: HTMLElement) =>
    scroller.dispatchEvent(new Event("scroll"));

  it("restores the line the press read, through the browser's scroll after the commit", async () => {
    const { button, scroller, pane, topLine, restore } = await capped();
    try {
      pane.top = 40 * ROW_PX;
      const before = topLine();
      act(() => {
        fireEvent.click(button);
      });
      expect(
        screen.queryByRole("button", { name: "Show full diff" }),
      ).toBeNull();
      pane.top = 0;
      browserScroll(scroller);

      expect(pane.top).toBe(40 * ROW_PX);
      expect(topLine()).toBe(before);
    } finally {
      restore();
    }
  });

  it("an input after the expand hands the position back to the user", async () => {
    const { button, scroller, pane, restore } = await capped();
    try {
      pane.top = 40 * ROW_PX;
      act(() => {
        fireEvent.click(button);
      });
      scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
      pane.top = 0;
      browserScroll(scroller);

      expect(pane.top).toBe(0);
    } finally {
      restore();
    }
  });
});
