import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BinaryFileSummary } from "@/features/diff/BinaryFileSummary";
import { DiffContent } from "@/features/diff/DiffSurface";
import { DiffPaneHold } from "@/features/diff/diff-pane-hold";
import {
  gitBlobSizes,
  githubBlobSizes,
  openNearestFolder,
  openWithDefault,
  revealInExplorer,
} from "@/lib/git/api";
import { splitUnifiedDiff } from "@/lib/git/diff-split";
import type { BlobSizes, FileDiff } from "@/lib/git/types";
import { isWindows } from "@/lib/hotkeys/binding";
import { useRepoLens } from "@/lib/repo-lens/queries";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { toastError } from "@/lib/toast";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitBlobSizes: vi.fn(),
  githubBlobSizes: vi.fn(),
  gitFileBase64: vi.fn(() => new Promise(() => undefined)),
  openWithDefault: vi.fn(),
  revealInExplorer: vi.fn(),
  openNearestFolder: vi.fn(),
}));

vi.mock("@/lib/repo-lens/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/repo-lens/queries")>()),
  useRepoLens: vi.fn(),
}));

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));

vi.mock("@/lib/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/toast")>()),
  toastError: vi.fn(),
}));

const local = vi.mocked(gitBlobSizes);
const github = vi.mocked(githubBlobSizes);
const lens = vi.mocked(useRepoLens);

/** Non-zero hex of any length, so the oid-width guard never reads a zero run. */
const hex = (n: number) => "abcdef0123".repeat(7).slice(0, n);
const ANCHOR = hex(40);

const bin = (path: string, ...lines: string[]) =>
  `diff --git a/${path} b/${path}\n${lines.map((l) => `${l}\n`).join("")}` +
  `Binary files a/${path} and b/${path} differ\n`;
const MODIFIED = bin("x.bin", "index 0123abc..89defab 100644");
const ADDED = bin("x.bin", "new file mode 100644", "index 0000000..abc1234");
const DELETED = bin(
  "x.bin",
  "deleted file mode 100644",
  "index abc1234..0000000",
);
const NO_INDEX = bin("x.bin");

const linkGone = (p: string) =>
  `diff --git a/${p} b/${p}\ndeleted file mode 120000\nindex 3333ccc..0000000\n` +
  `--- a/${p}\n+++ /dev/null\n@@ -1 +0,0 @@\n-target\n`;
const linkMade = (p: string) =>
  `diff --git a/${p} b/${p}\nnew file mode 120000\nindex 0000000..6666fff\n` +
  `--- /dev/null\n+++ b/${p}\n@@ -0,0 +1 @@\n+target\n`;
const binMade = (p: string) =>
  `diff --git a/${p} b/${p}\nnew file mode 100644\nindex 0000000..4444ddd\n` +
  `Binary files /dev/null and b/${p} differ\n`;
const binGone = (p: string) =>
  `diff --git a/${p} b/${p}\ndeleted file mode 100644\nindex 5555eee..0000000\n` +
  `Binary files a/${p} and /dev/null differ\n`;
/** Symlink → binary: the text half first. */
const LINK_TO_BINARY = linkGone("x") + binMade("x");
/** Binary → symlink: the binary half first. */
const BINARY_TO_LINK = binGone("x") + linkMade("x");

const ACTION_NAMES = ["Open with default program", "Show in Explorer"];

/** Lets a mount's effects and any dispatched lookup run. */
const tick = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  lens.mockReturnValue("origin");
  local.mockResolvedValue({ oldSize: 48230, newSize: 51918 });
  github.mockResolvedValue({ oldSize: null, newSize: null });
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  for (const fn of [openWithDefault, revealInExplorer, openNearestFolder])
    vi.mocked(fn).mockResolvedValue(undefined);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
});

const wrap = (node: ReactNode) => (
  <QueryClientProvider client={client}>{node}</QueryClientProvider>
);

type Props = ComponentProps<typeof BinaryFileSummary>;

function renderSummary(props: Partial<Props> = {}) {
  const all: Props = {
    repoPath: "/repo",
    filePath: "x.bin",
    text: MODIFIED,
    worktreeNewSide: false,
    ...props,
  };
  const view = render(wrap(<BinaryFileSummary {...all} />));
  const at = (next: Partial<Props>) =>
    view.rerender(wrap(<BinaryFileSummary {...all} {...next} />));
  return { ...view, at };
}

const keyHeads = () =>
  client
    .getQueryCache()
    .getAll()
    .map((q) => q.queryKey[0]);

/** The GitHub reads that name a side (the idle null-args key excluded). */
const githubReads = () =>
  client
    .getQueryCache()
    .getAll()
    .filter(
      (q) =>
        q.queryKey[0] === "github-blob-sizes" &&
        (q.queryKey[3] !== null || q.queryKey[4] !== null),
    );

function actionButtons() {
  return screen
    .queryAllByRole("button")
    .map((b) => b.textContent)
    .filter((name) => ACTION_NAMES.includes(name ?? ""));
}

describe("the GitHub size fallback", () => {
  it("asks GitHub for only the side the local store couldn't size", async () => {
    local.mockResolvedValue({ oldSize: null, newSize: 51918 });
    github.mockResolvedValue({ oldSize: 48230, newSize: null });
    renderSummary({ anchorCommit: ANCHOR });
    expect(await screen.findByText("47.1 KB → 50.7 KB")).toBeTruthy();
    expect(github).toHaveBeenCalledTimes(1);
    expect(github).toHaveBeenCalledWith("/repo", "0123abc", null, "origin");
  });

  it("keeps the local answer where both have one", async () => {
    local.mockResolvedValue({ oldSize: null, newSize: 51918 });
    github.mockResolvedValue({ oldSize: 48230, newSize: 999999 });
    renderSummary({ anchorCommit: ANCHOR });
    expect(await screen.findByText("47.1 KB → 50.7 KB")).toBeTruthy();
  });

  it("asks for both sides when a shallow clone sized neither", async () => {
    local.mockResolvedValue({ oldSize: null, newSize: null });
    github.mockResolvedValue({ oldSize: 5001, newSize: 5000 });
    renderSummary({ anchorCommit: ANCHOR });
    // Same rounded size: the exact-bytes form still renders.
    expect(
      await screen.findByText(
        `${(5001).toLocaleString()} → ${(5000).toLocaleString()} bytes`,
      ),
    ).toBeTruthy();
    expect(github).toHaveBeenCalledWith(
      "/repo",
      "0123abc",
      "89defab",
      "origin",
    );
  });

  it("reads under the upstream lens, one cache entry per lens", async () => {
    local.mockResolvedValue({ oldSize: null, newSize: 51918 });
    const view = renderSummary({ anchorCommit: ANCHOR });
    await waitFor(() => expect(github).toHaveBeenCalledTimes(1));
    lens.mockReturnValue("upstream");
    view.at({});
    await waitFor(() => expect(github).toHaveBeenCalledTimes(2));
    expect(github).toHaveBeenLastCalledWith(
      "/repo",
      "0123abc",
      null,
      "upstream",
    );
    expect(githubReads().map((q) => q.queryKey[2])).toEqual([
      "origin",
      "upstream",
    ]);
  });

  it("never asks GitHub when the local store sized every side", async () => {
    renderSummary({ anchorCommit: ANCHOR });
    expect(await screen.findByText("47.1 KB → 50.7 KB")).toBeTruthy();
    await tick();
    expect(github).not.toHaveBeenCalled();
  });

  it("keeps a side GitHub couldn't size blank", async () => {
    local.mockResolvedValue({ oldSize: null, newSize: 51918 });
    const { container } = renderSummary({ anchorCommit: ANCHOR });
    await waitFor(() => expect(github).toHaveBeenCalledTimes(1));
    await tick();
    expect(container.textContent).toBe("");
    expect(container.querySelector(".sr-only")).toBeNull();
  });

  it("keeps the local answer on a failed read, retried once, with no error copy", async () => {
    local.mockResolvedValue({ oldSize: null, newSize: 51918 });
    github.mockRejectedValue({ kind: "git", message: "network down" });
    const { container } = renderSummary({ anchorCommit: ANCHOR });
    // shouldRetryQuery's one retry waits out react-query's 1 s default delay.
    await waitFor(() => expect(githubReads()[0]?.state.status).toBe("error"), {
      timeout: 4000,
    });
    expect(github).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("");
    expect(container.querySelector('[role="status"], [role="alert"]')).toBe(
      null,
    );
  });

  it("parks offline with a blank box, and reads on reconnect", async () => {
    local.mockResolvedValue({ oldSize: null, newSize: 51918 });
    github.mockResolvedValue({ oldSize: 48230, newSize: null });
    onlineManager.setOnline(false);
    try {
      const { container } = renderSummary({ anchorCommit: ANCHOR });
      await waitFor(() => expect(local).toHaveBeenCalledTimes(1));
      await tick();
      expect(github).not.toHaveBeenCalled();
      expect(container.textContent).toBe("");
      act(() => onlineManager.setOnline(true));
      expect(await screen.findByText("47.1 KB → 50.7 KB")).toBeTruthy();
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it("a local surface mounts neither the lens nor the GitHub read", async () => {
    local.mockResolvedValue({ oldSize: null, newSize: 51918 });
    renderSummary();
    await waitFor(() => expect(local).toHaveBeenCalledTimes(1));
    await tick();
    expect(github).not.toHaveBeenCalled();
    expect(lens).not.toHaveBeenCalled();
    expect(keyHeads()).not.toContain("github-blob-sizes");
    expect(keyHeads()).not.toContain("repo-lens");
  });

  it("a held anchored pane sends neither lookup", async () => {
    renderSummary({ anchorCommit: ANCHOR, held: true });
    await tick();
    expect(local).not.toHaveBeenCalled();
    expect(github).not.toHaveBeenCalled();
  });

  it("settles on the local read while GitHub's is still in flight", async () => {
    local.mockResolvedValue({ oldSize: null, newSize: 51918 });
    github.mockReturnValue(new Promise<BlobSizes>(() => undefined));
    const reports: boolean[] = [];
    render(
      wrap(
        <DiffPaneHold.Provider
          value={{
            interactive: true,
            phase: "shown",
            reportSettled: (s) => {
              reports.push(s);
              return () => undefined;
            },
          }}
        >
          <BinaryFileSummary
            repoPath="/repo"
            filePath="x.bin"
            text={MODIFIED}
            worktreeNewSide={false}
            anchorCommit={ANCHOR}
          />
        </DiffPaneHold.Provider>,
      ),
    );
    await waitFor(() => expect(github).toHaveBeenCalledTimes(1));
    expect(reports[0]).toBe(false);
    expect(reports.at(-1)).toBe(true);
  });
});

describe("the binary pane's actions", () => {
  const sep = isWindows ? "\\" : "/";
  const absolute = (path: string) => `/repo${sep}${path.replaceAll("/", sep)}`;
  const nested = (text: string) => text.replaceAll("x.bin", "a/b/x.bin");

  it.each([
    ["a modified working-tree file", MODIFIED],
    ["an untracked file", ADDED],
  ])("offers both on %s, with the absolute path", async (_, text) => {
    const user = userEvent.setup();
    renderSummary({
      text: nested(text),
      filePath: "a/b/x.bin",
      worktreeNewSide: true,
    });
    expect(actionButtons()).toEqual(ACTION_NAMES);
    await user.click(
      screen.getByRole("button", { name: "Open with default program" }),
    );
    expect(openWithDefault).toHaveBeenCalledWith(absolute("a/b/x.bin"));
    await user.click(screen.getByRole("button", { name: "Show in Explorer" }));
    expect(revealInExplorer).toHaveBeenCalledWith(absolute("a/b/x.bin"));
    expect(openNearestFolder).not.toHaveBeenCalled();
  });

  it("shows only the nearest folder for a deleted working-tree file", async () => {
    const user = userEvent.setup();
    renderSummary({
      text: nested(DELETED),
      filePath: "a/b/x.bin",
      worktreeNewSide: true,
    });
    expect(actionButtons()).toEqual(["Show in Explorer"]);
    await user.click(screen.getByRole("button", { name: "Show in Explorer" }));
    expect(openNearestFolder).toHaveBeenCalledWith("/repo", "a/b/x.bin");
    expect(revealInExplorer).not.toHaveBeenCalled();
  });

  it("hands Open's focus to Show in Explorer when the file reads as deleted", () => {
    const { at } = renderSummary({ worktreeNewSide: true });
    screen.getByRole("button", { name: "Open with default program" }).focus();
    at({ text: DELETED });
    expect(actionButtons()).toEqual(["Show in Explorer"]);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Show in Explorer" }),
    );
  });

  // Negative control: rescuing on every `deleted` flip, held or not, fails this
  // test (focus resting on <body> jumps to Show in Explorer).
  it("leaves focus resting on <body> when the file's deleted state flips", () => {
    const { at } = renderSummary({ worktreeNewSide: true });
    expect(document.activeElement).toBe(document.body);
    at({ text: DELETED });
    expect(actionButtons()).toEqual(["Show in Explorer"]);
    expect(document.activeElement).toBe(document.body);
    at({ text: MODIFIED });
    expect(actionButtons()).toEqual(ACTION_NAMES);
    expect(document.activeElement).toBe(document.body);
  });

  // Focus resting outside the actions is never captured, so nothing is rescued;
  // the <body> test above covers the held-focus gate.
  it("never pulls focus off a control outside the actions", () => {
    const outside = document.createElement("button");
    outside.textContent = "Elsewhere";
    document.body.append(outside);
    try {
      const { at } = renderSummary({ worktreeNewSide: true });
      outside.focus();
      at({ text: DELETED });
      expect(actionButtons()).toEqual(["Show in Explorer"]);
      expect(document.activeElement).toBe(outside);
    } finally {
      outside.remove();
    }
  });

  it("follows the size and mode lines in tab order", () => {
    const { container } = renderSummary({
      text: bin(
        "x.bin",
        "old mode 100644",
        "new mode 100755",
        "index 0123abc..89defab",
      ),
      worktreeNewSide: true,
    });
    const wrapper = container.firstElementChild;
    const buttons = wrapper?.lastElementChild;
    expect(buttons?.querySelectorAll("button")).toHaveLength(2);
    expect(wrapper?.firstElementChild?.querySelector("button")).toBeNull();
  });

  it("toasts a failure and keeps the pane", async () => {
    const user = userEvent.setup();
    const error = { kind: "io", message: "gone" };
    vi.mocked(openWithDefault).mockRejectedValue(error);
    renderSummary({ worktreeNewSide: true });
    await user.click(
      screen.getByRole("button", { name: "Open with default program" }),
    );
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(error));
    expect(actionButtons()).toEqual(ACTION_NAMES);
  });

  it.each([
    ["a staged file", { worktreeNewSide: false }],
    ["a PR pane", { worktreeNewSide: false, anchorCommit: ANCHOR }],
    ["a held pane", { worktreeNewSide: true, held: true }],
    ["a section with no index line", { worktreeNewSide: true, text: NO_INDEX }],
    [
      "a typechange the stacked arm rejects",
      {
        worktreeNewSide: true,
        text: binGone("x") + binMade("x"),
        filePath: "x",
      },
    ],
  ] as const)("offers none on %s", (_, props) => {
    const { container } = renderSummary(props);
    expect(container.querySelector("button, a, [tabindex]")).toBeNull();
  });

  it.each([
    ["symlink to binary", LINK_TO_BINARY],
    ["binary to symlink", BINARY_TO_LINK],
  ])("never offers any in a %s band", async (_, text) => {
    const { container } = renderSummary({
      text,
      filePath: "x",
      worktreeNewSide: true,
      variant: "band",
    });
    await tick();
    expect(container.querySelector("button, a, [tabindex]")).toBeNull();
  });
});

describe("the stacked typechange arm", () => {
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

  function renderPane(
    filePath: string,
    text: string,
    props: Partial<ComponentProps<typeof DiffContent>> = {},
  ) {
    const data: FileDiff = {
      filePath,
      text,
      isBinary: true,
      isTruncated: false,
    };
    return render(
      wrap(
        <DiffContent
          filePath={filePath}
          data={data}
          isPending={false}
          isError={false}
          repoPath="/repo"
          // An unstaged working-tree pane: its new side is the file on disk.
          imageRevs={{ old: ":0", new: null }}
          stagingSide="unstaged"
          {...props}
        />,
      ),
    );
  }

  /** The band's own subtree: icon, label and size line, nothing focusable. */
  function band(label: string) {
    const el = screen.getByText(label).parentElement as HTMLElement;
    expect(el.querySelector("button, a, [tabindex]")).toBeNull();
    expect(el.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    return el;
  }

  const follows = (a: Node, b: Node) =>
    Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  it("stacks symlink to binary: the removed text, then the added band", async () => {
    local.mockResolvedValue({ oldSize: null, newSize: 716800 });
    const { container } = renderPane("x", LINK_TO_BINARY);
    const removed = await screen.findByText("target");
    const added = band("Binary file added");
    expect(follows(removed, added)).toBe(true);
    expect(await screen.findByText("700 KB")).toBeTruthy();
    expect(container.textContent).not.toMatch(/New file|Deleted file/);
    expect(
      screen.queryByText("Binary file — no text diff available"),
    ).toBeNull();
    // The band's new side is the working-tree file, sized from disk.
    expect(local).toHaveBeenCalledWith("/repo", null, "4444ddd", "x", null);
  });

  it("stacks binary to symlink: the removed band, then the added text", async () => {
    local.mockResolvedValue({ oldSize: 921600, newSize: null });
    renderPane("x", BINARY_TO_LINK);
    const removed = band("Binary file removed");
    const added = await screen.findByText("target");
    expect(follows(removed, added)).toBe(true);
    expect(await screen.findByText("900 KB")).toBeTruthy();
    expect(screen.queryByText("Deleted file")).toBeNull();
  });

  it.each([
    ["symlink to binary", LINK_TO_BINARY],
    ["binary to symlink", BINARY_TO_LINK],
  ])("renders no action, stage or discard control (%s)", async (_, text) => {
    renderPane("x", text);
    await screen.findByText("target");
    await tick();
    const names = screen.queryAllByRole("button").map((b) => b.textContent);
    for (const name of names) {
      expect(name).not.toMatch(/Stage|Discard|Unstage/);
      expect(ACTION_NAMES).not.toContain(name);
    }
  });

  it("keys a C-quoted path the PR split decoded", async () => {
    const q = "caf\\303\\251.bin";
    const patch =
      `diff --git "a/${q}" "b/${q}"\ndeleted file mode 120000\n` +
      `index 3333ccc..0000000\n--- "a/${q}"\n+++ /dev/null\n@@ -1 +0,0 @@\n-target\n` +
      `diff --git "a/${q}" "b/${q}"\nnew file mode 100644\n` +
      `index 0000000..4444ddd\nBinary files /dev/null and "b/${q}" differ\n`;
    const [[path, text]] = [...splitUnifiedDiff(patch)];
    renderPane(path, text, { imageRevs: undefined, stagingSide: undefined });
    expect(await screen.findByText("target")).toBeTruthy();
    band("Binary file added");
  });

  it.each([
    ["a plain binary file", MODIFIED, "x.bin"],
    ["a pair of binary halves", binGone("x") + binMade("x"), "x"],
  ])("keeps the whole-file placeholder for %s", async (_, text, path) => {
    renderPane(path, text);
    expect(
      await screen.findByText("Binary file — no text diff available"),
    ).toBeTruthy();
    expect(screen.queryByText(/^Binary file (added|removed)$/)).toBeNull();
  });

  it("an image typechange still takes the image arm", async () => {
    renderPane("x.png", linkGone("x.png") + binMade("x.png"));
    await tick();
    expect(screen.queryByText("Binary file added")).toBeNull();
    expect(screen.queryByText("target")).toBeNull();
  });
});
