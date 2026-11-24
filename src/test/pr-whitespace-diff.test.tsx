import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { DiffContent } from "@/features/diff/DiffSurface";
import {
  type ForgeWhitespaceRevs,
  useForgeWhitespaceDiff,
} from "@/features/diff/use-forge-whitespace-diff";
import { whitespaceComposerOpen } from "@/features/diff/whitespace-mode";
import { positionFromLine } from "@/features/pulls/CommitComments";
import { PrCommitDetail } from "@/features/pulls/PrCommitDetail";
import {
  type FileBytes,
  forgeCommitCommentCreate,
  forgeCommitComments,
  forgeCommitFirstParent,
  forgeFileAtSha,
  forgePrCommitDiff,
  forgeStatus,
  gitDiffBytesIgnoringWhitespace,
  gitObjectsPresent,
} from "@/lib/git/api";
import { prWhitespaceHunksOptions } from "@/lib/git/queries";
import type {
  CommitCommentOut,
  FileDiff,
  ForgeStatus,
  PrCommitOut,
} from "@/lib/git/types";
import {
  type AppSettings,
  loadSettings,
  saveSettingsPatch,
} from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { stubCanvas } from "./canvas-stub";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeFileAtSha: vi.fn(),
  gitDiffBytesIgnoringWhitespace: vi.fn(),
  forgeCommitComments: vi.fn(),
  forgeCommitCommentCreate: vi.fn(),
  forgeCommitFirstParent: vi.fn(),
  forgePrCommitDiff: vi.fn(),
  forgeStatus: vi.fn(),
  gitObjectsPresent: vi.fn(),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
  saveSettingsPatch: vi.fn(),
}));
vi.mock("@/lib/use-container-width", () => ({
  useContainerWidth: () => [() => undefined, null],
}));
// A test may hold a built-in grammar's load, which holds its diff's settle.
const grammar = vi.hoisted(() => ({
  hold: undefined as Promise<boolean> | undefined,
}));
vi.mock("@/features/diff/shiki-highlighter", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/diff/shiki-highlighter")>();
  return {
    ...actual,
    ensureBuiltinShikiLang: (id: string) =>
      grammar.hold ?? actual.ensureBuiltinShikiLang(id),
  };
});

// jsdom has none; the commit composer's editor scrolls itself into view.
Element.prototype.scrollIntoView = vi.fn();

beforeAll(stubCanvas);
afterEach(() => {
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("the whitespace probe (AC-H2)", () => {
  const editors = {
    composer: '<div data-diff-line-widget="whitespace"></div>',
    reply: "<div data-diff-editor></div>",
    draftEdit: "<div data-diff-editor></div>",
    commentEdit: "<div data-thread-editing></div>",
  };
  const host = (html: string) => {
    document.body.innerHTML = html;
  };

  it("counts an editor inside a whitespace anchor and the existing arms", () => {
    for (const inner of [
      editors.reply,
      editors.draftEdit,
      editors.commentEdit,
    ]) {
      host(`<div data-diff-anchor="whitespace"><div>${inner}</div></div>`);
      expect(whitespaceComposerOpen()).toBe(true);
    }
    host(editors.composer);
    expect(whitespaceComposerOpen()).toBe(true);
    host(`<li data-whitespace-row>${editors.commentEdit}</li>`);
    expect(whitespaceComposerOpen()).toBe(true);
  });

  it("ignores the same editors in a layout anchor or outside any anchor", () => {
    for (const inner of [editors.reply, editors.commentEdit]) {
      host(`<div data-diff-anchor="layout">${inner}</div>`);
      expect(whitespaceComposerOpen()).toBe(false);
      host(`<section>${inner}</section>`);
      expect(whitespaceComposerOpen()).toBe(false);
    }
    host('<div data-diff-line-widget="layout"></div>');
    expect(whitespaceComposerOpen()).toBe(false);
  });
});

const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);
// A re-indent of one block plus a content edit, and its real `git diff -w`
// hunk (git 2.51.1): one hunk over lines 11-17 of an 18-line file.
const OLD =
  "function f() {\n  line 1\n  line 2\n  line 3\n  line 4\n  line 5\n  line 6\n}\nfunction g() {\n  line 7\n  line 8\n  line 9\n  line 10\n  line 11\n  line 12\n  line 13\n  line 14\n}\n";
const NEW =
  "function f() {\n    line 1\n    line 2\n    line 3\n    line 4\n    line 5\n    line 6\n}\nfunction g() {\n  line 7\n  line 8\n  line 9\n  line 10\n  line ELEVEN\n  line 12\n  line 13\n  line 14\n}\n";
const WS_TEXT =
  "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n" +
  "@@ -11,7 +11,7 @@ function g() {\n   line 8\n   line 9\n   line 10\n-  line 11\n+  line ELEVEN\n   line 12\n   line 13\n   line 14\n";
const bytes = (text: string): FileBytes =>
  ({
    base64: Buffer.from(text).toString("base64"),
    mime: null,
    tooLarge: false,
    size: text.length,
  }) as FileBytes;

function mountWsDiff(whitespaceHidden: boolean) {
  vi.mocked(forgeFileAtSha).mockImplementation(async (_repo, sha) =>
    bytes(sha === OLD_SHA ? OLD : NEW),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  const data: FileDiff = {
    filePath: "f.txt",
    text: WS_TEXT,
    isBinary: false,
    isTruncated: false,
    whitespaceHidden,
  };
  const view = render(
    <QueryClientProvider client={client}>
      <DiffContent
        filePath="f.txt"
        data={data}
        isPending={false}
        isError={false}
        repoPath="/repo"
        contentRevs={{ oldRev: OLD_SHA, newRev: NEW_SHA }}
        forgePatch={{ source: { lens: "origin" } }}
      />
    </QueryClientProvider>,
  );
  const expands = () => view.container.querySelectorAll('[title^="Expand"]');
  return { expands };
}

describe("content mode over a -w diff (AC-G3)", () => {
  it("builds with expand rows when the diff carries its whitespaceHidden mark", async () => {
    const pane = mountWsDiff(true);
    await waitFor(() => expect(pane.expands().length).toBeGreaterThan(0));
  });

  it("stays hunk-only for the same text without the mark (exact guard)", async () => {
    const pane = mountWsDiff(false);
    await waitFor(() => expect(forgeFileAtSha).toHaveBeenCalledTimes(2));
    await act(async () => undefined);
    await act(async () => undefined);
    expect(pane.expands().length).toBe(0);
  });
});

describe("the -w read is outside the repo subtree (AC-N3)", () => {
  it("a repo-wide invalidation refetches no pr-whitespace-hunks read", async () => {
    vi.mocked(gitDiffBytesIgnoringWhitespace).mockResolvedValue({
      hunks: "",
      isBinary: false,
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const reads = {
      repo: "/repo",
      sourceKey: "forge:origin",
      oldRev: OLD_SHA,
      oldPath: "f.txt",
      newRev: NEW_SHA,
      path: "f.txt",
    };
    function Reader() {
      const q = useQuery(prWhitespaceHunksOptions(reads, { old: "", new: "" }));
      return q.data ? <span data-landed="" /> : null;
    }
    const view = render(
      <QueryClientProvider client={client}>
        <Reader />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(view.container.querySelector("[data-landed]")).not.toBeNull(),
    );
    await act(() => client.invalidateQueries({ queryKey: ["repo", "/repo"] }));
    expect(gitDiffBytesIgnoringWhitespace).toHaveBeenCalledTimes(1);
  });
});

describe("a slot without a repo under the mode (C10)", () => {
  it("keeps the forge view, never pending and with no note, whatever its revs", () => {
    const settings = { ...DEFAULT_SETTINGS, diffHideWhitespace: true };
    vi.mocked(loadSettings).mockResolvedValue(settings);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(settingsKeys.settings, settings);
    const plain: FileDiff = {
      filePath: "f.txt",
      text: WS_TEXT,
      isBinary: false,
      isTruncated: false,
    };
    const ready: ForgeWhitespaceRevs = {
      state: "ready",
      oldRev: OLD_SHA,
      newRev: NEW_SHA,
      source: { lens: "origin" },
    };
    const hook = renderHook(
      (p: { repo: string | undefined; revs: ForgeWhitespaceRevs }) =>
        useForgeWhitespaceDiff({
          plain,
          placeholder: false,
          repo: p.repo,
          entity: "origin\u0000 7",
          path: "f.txt",
          revs: p.revs,
          root: null,
        }),
      {
        initialProps: { repo: "/repo", revs: { state: "pending" } },
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    // With a repo the setting is on and the first open waits.
    expect(hook.result.current.pending).toBe(true);
    for (const revs of [
      { state: "pending" },
      { state: "paused" },
      ready,
    ] as ForgeWhitespaceRevs[]) {
      hook.rerender({ repo: undefined, revs });
      expect(hook.result.current.pending).toBe(false);
      expect(hook.result.current.data?.text).toBe(WS_TEXT);
      expect(hook.result.current.data?.whitespaceHidden).toBe(false);
      expect(hook.result.current.note).toBeUndefined();
    }
    expect(forgeFileAtSha).not.toHaveBeenCalled();
    expect(gitDiffBytesIgnoringWhitespace).not.toHaveBeenCalled();
    hook.unmount();
  });
});

describe("the PR commit view under the mode (a commit this clone lacks)", () => {
  /** Non-zero hex, so the oid-width guard never reads a zero run. */
  const COMMIT = "abcdef0123".repeat(4);
  // The forge's patch of OLD -> NEW, captured from `git diff` (git 2.51.1).
  const FORGE_TEXT =
    "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n" +
    "@@ -1,17 +1,17 @@\n function f() {\n" +
    "-  line 1\n-  line 2\n-  line 3\n-  line 4\n-  line 5\n-  line 6\n" +
    "+    line 1\n+    line 2\n+    line 3\n+    line 4\n+    line 5\n+    line 6\n" +
    " }\n function g() {\n   line 7\n   line 8\n   line 9\n   line 10\n" +
    "-  line 11\n+  line ELEVEN\n   line 12\n   line 13\n   line 14\n";
  const WS_HUNKS = WS_TEXT.slice(WS_TEXT.indexOf("@@ "));
  const ALL_ON = new Proxy({}, { get: () => true });
  const commit: PrCommitOut = {
    oid: COMMIT,
    headline: "Re-indent f",
    date: "2026-11-01T10:00:00Z",
    author: "Ada",
    messageBody: "",
  };
  const comment = (line: number, body: string): CommitCommentOut => ({
    id: `c${line}`,
    author: "Ada",
    body,
    createdAt: "2026-11-01T10:00:00Z",
    viewerDidAuthor: false,
    path: "f.txt",
    line,
    startLine: null,
    position: null,
  });
  /** A drawn new-side line number in the pane. */
  const newLine = (n: number) =>
    document.querySelector(`span[data-line-new-num="${n}"]`);

  let lastClient: QueryClient | undefined;
  /** The commit's forge section, its two versions and their `-w` hunks. */
  type Fixture = { forge: string; old: string; next: string; hunks: string };
  function mountCommit(opts: {
    hide: boolean;
    present?: Promise<boolean>;
    canComment?: boolean;
    fixture?: Fixture;
  }) {
    const fx = opts.fixture ?? {
      forge: FORGE_TEXT,
      old: OLD,
      next: NEW,
      hunks: WS_HUNKS,
    };
    const settings = { ...DEFAULT_SETTINGS, diffHideWhitespace: opts.hide };
    vi.mocked(loadSettings).mockResolvedValue(settings);
    vi.mocked(forgeStatus).mockResolvedValue({
      provider: "github",
      installed: true,
      authenticated: true,
      repo: "octo/repo",
      host: "github.com",
      login: "octo",
      capabilities: ALL_ON,
      implemented: ALL_ON,
    } as unknown as ForgeStatus);
    vi.mocked(gitObjectsPresent).mockImplementation(async (_r, oids) =>
      oids.length > 0 ? (opts.present ?? Promise.resolve(false)) : true,
    );
    vi.mocked(forgeCommitFirstParent).mockResolvedValue(OLD_SHA);
    vi.mocked(forgePrCommitDiff).mockResolvedValue(fx.forge);
    vi.mocked(forgeFileAtSha).mockImplementation(async (_repo, sha) =>
      bytes(sha === OLD_SHA ? fx.old : fx.next),
    );
    vi.mocked(gitDiffBytesIgnoringWhitespace).mockResolvedValue({
      hunks: fx.hunks,
      isBinary: false,
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(settingsKeys.settings, settings);
    lastClient = client;
    return render(
      <QueryClientProvider client={client}>
        <PrCommitDetail
          repoPath="/repo"
          number={7}
          commit={commit}
          onBack={() => undefined}
          canCommentCommits={opts.canComment ?? false}
          remoteLabel="GitHub"
          lens="origin"
        />
      </QueryClientProvider>,
    );
  }

  // Unmount before the file-level body wipe, which would strand portals.
  afterEach(() => {
    cleanup();
    onlineManager.setOnline(true);
  });

  it("draws the proven -w view, read by sha from the forge, with the gear's hidden name (AC-W2, AC-W3, AC-P1)", async () => {
    vi.mocked(forgeCommitComments).mockResolvedValue([]);
    mountCommit({ hide: true });
    await waitFor(() => expect(newLine(14)).not.toBeNull(), {
      timeout: 10_000,
    });
    expect(newLine(2)).toBeNull();
    expect(gitDiffBytesIgnoringWhitespace).toHaveBeenCalledTimes(1);
    expect(forgeFileAtSha).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole("button", {
        name: "Diff options, whitespace changes hidden",
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/Whitespace changes are shown/)).toBeNull();
  }, 20_000);

  it("draws the forge diff and reads nothing new with the setting off (AC-W6, AC-N1)", async () => {
    vi.mocked(forgeCommitComments).mockResolvedValue([]);
    mountCommit({ hide: false });
    await waitFor(() => expect(newLine(2)).not.toBeNull(), {
      timeout: 10_000,
    });
    await act(async () => undefined);
    expect(gitDiffBytesIgnoringWhitespace).not.toHaveBeenCalled();
  }, 20_000);

  it("lists a comment on a re-indented line as hidden by Hide whitespace (AC-C2)", async () => {
    vi.mocked(forgeCommitComments).mockResolvedValue([
      comment(4, "On a re-indented line"),
    ]);
    mountCommit({ hide: true });
    await waitFor(() => expect(newLine(14)).not.toBeNull(), {
      timeout: 10_000,
    });
    expect(
      await screen.findByText(/on a line hidden by Hide whitespace/),
    ).toBeTruthy();
    expect(screen.queryByText(/couldn.t place in this diff/)).toBeNull();
  }, 20_000);

  it("a first-parent read parked offline paints the forge diff under the offline note, then the -w view (AC-F1)", async () => {
    vi.mocked(forgeCommitComments).mockResolvedValue([]);
    let answerPresent: (v: boolean) => void = () => undefined;
    const present = new Promise<boolean>((resolve) => {
      answerPresent = resolve;
    });
    mountCommit({ hide: true, present });
    await waitFor(() => expect(forgePrCommitDiff).toHaveBeenCalled());
    await act(async () => undefined);
    onlineManager.setOnline(false);
    await act(async () => answerPresent(false));
    // The forge diff's first changed line is on screen.
    await waitFor(() => expect(newLine(2)).not.toBeNull(), {
      timeout: 10_000,
    });
    expect(
      screen.getByText(
        "Whitespace changes are shown in this file: you're offline.",
      ),
    ).toBeTruthy();
    expect(forgeCommitFirstParent).not.toHaveBeenCalled();
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(newLine(2)).toBeNull(), { timeout: 10_000 });
    expect(newLine(14)).not.toBeNull();
  }, 20_000);

  /** Opens the commit line composer on a drawn new-side line. */
  const openComposerAt = (n: number) => {
    const num = newLine(n)?.closest(".diff-line-num") as HTMLElement;
    fireEvent.mouseOver(num);
    fireEvent.mouseDown(
      num.closest("tr")?.querySelector(".diff-add-widget") as HTMLElement,
    );
  };
  const settle = async () => {
    for (let i = 0; i < 5; i++) await act(async () => undefined);
  };

  it("posts the position counted in the forge section from the -w view (AC-C4)", async () => {
    vi.mocked(forgeCommitComments).mockResolvedValue([]);
    vi.mocked(forgeCommitCommentCreate).mockResolvedValue(
      comment(14, "Posted") as never,
    );
    const user = userEvent.setup();
    mountCommit({ hide: true, canComment: true });
    await waitFor(() => expect(newLine(14)).not.toBeNull(), {
      timeout: 10_000,
    });
    expect(newLine(2)).toBeNull();
    openComposerAt(14);
    const editor = await screen.findByRole("textbox", {
      name: "Comment on Line 14 · f.txt",
    });
    await user.type(editor, "On the edit");
    await user.click(
      within(
        editor.closest("[data-diff-line-widget]") as HTMLElement,
      ).getByRole("button", { name: "Comment" }),
    );
    await waitFor(() => expect(forgeCommitCommentCreate).toHaveBeenCalled());
    const [, args] = vi.mocked(forgeCommitCommentCreate).mock.calls[0];
    const forgePosition = positionFromLine(FORGE_TEXT, 14);
    expect(forgePosition).not.toBeNull();
    expect((args as { position?: number }).position).toBe(forgePosition);
  }, 30_000);

  /**
   * Records every state still on screen when a task's microtasks have
   * drained: a browser paints only between tasks, so a state a later
   * microtask of the same task replaces is never seen.
   */
  const watchPainted = (check: () => string | null) => {
    const painted: string[] = [];
    const observer = new MutationObserver(() => {
      if (check() === null) return;
      let hops = 0;
      const atTaskEnd = () => {
        if (++hops < 2000) {
          queueMicrotask(atTaskEnd);
          return;
        }
        const bad = check();
        if (bad !== null) painted.push(bad);
      };
      queueMicrotask(atTaskEnd);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    return { painted, stop: () => observer.disconnect() };
  };
  const HIDDEN_NOTE = /on a line hidden by Hide whitespace/;
  /** A comment on line 4 shows exactly once: inline while line 4 is drawn,
   *  listed once it isn't. */
  const shownOnce = (body: string) => () => {
    const count = screen.queryAllByText(body).length;
    if (count !== 1) return `shown ${count} times`;
    const listed = screen.queryByText(HIDDEN_NOTE) !== null;
    return listed && newLine(4) !== null
      ? "listed while line 4 is drawn"
      : null;
  };

  it("keeps a comment inline while an editor holds the forge text, then lists it once the -w view lands (AC-C3, AC-C5)", async () => {
    const BODY = "On a re-indented line";
    vi.mocked(forgeCommitComments).mockResolvedValue([comment(4, BODY)]);
    mountCommit({ hide: false, canComment: true });
    await waitFor(() => expect(screen.queryByText(BODY)).not.toBeNull(), {
      timeout: 10_000,
    });
    await waitFor(() => expect(newLine(2)).not.toBeNull());
    // The list and the rows change in the same painted frame, never apart.
    const watch = watchPainted(shownOnce(BODY));
    openComposerAt(14);
    await screen.findByRole("textbox", {
      name: "Comment on Line 14 · f.txt",
    });
    // Written straight into the settings cache: no probe ran.
    act(() =>
      lastClient?.setQueryData(settingsKeys.settings, {
        ...DEFAULT_SETTINGS,
        diffHideWhitespace: true,
      }),
    );
    await waitFor(() =>
      expect(gitDiffBytesIgnoringWhitespace).toHaveBeenCalledTimes(1),
    );
    await settle();
    expect(newLine(2)).not.toBeNull();
    expect(screen.queryByText(/on a line hidden by Hide whitespace/)).toBe(
      null,
    );
    expect(screen.getAllByText(BODY)).toHaveLength(1);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(newLine(2)).toBeNull());
    expect(
      screen.getByText(/on a line hidden by Hide whitespace/),
    ).toBeTruthy();
    expect(screen.getAllByText(BODY)).toHaveLength(1);
    await settle();
    watch.stop();
    expect(watch.painted).toEqual([]);
  }, 30_000);

  // A block duplicated above itself and re-indented: the `-w` hunk draws new
  // line 24, which the forge hunk does not (`git diff` / `git diff -w`, git
  // 2.51.1; the fixture pr-files-whitespace.test.tsx draws on the Files tab).
  const rows = (a: number, b: number) =>
    Array.from({ length: b - a + 1 }, (_, i) => `row ${a + i}\n`).join("");
  const DUP: Fixture = {
    forge:
      "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n" +
      "@@ -11,11 +11,13 @@ row 10\n row 11\n row 12\n start\n" +
      "-if (a) {\n-  b();\n-  c();\n-  d();\n-  e();\n" +
      "+if (z) {\n+  if (a) {\n+    b();\n+    c();\n+    d();\n+    e();\n+  }\n" +
      " }\n end\n row 13\n",
    old: `${rows(1, 12)}start\nif (a) {\n  b();\n  c();\n  d();\n  e();\n}\nend\n${rows(13, 24)}`,
    next: `${rows(1, 12)}start\nif (z) {\n  if (a) {\n    b();\n    c();\n    d();\n    e();\n  }\n}\nend\n${rows(13, 24)}`,
    hunks:
      "@@ -11,12 +11,14 @@ row 10\n row 11\n row 12\n start\n+if (z) {\n" +
      "   if (a) {\n     b();\n     c();\n     d();\n     e();\n   }\n+}\n" +
      " end\n row 13\n row 14\n",
  };

  it("holds a -w view that would move a listed comment inline while its edit is open, then lands it (rule 7)", async () => {
    const BODY = "On a line the forge patch skips";
    vi.mocked(forgeCommitComments).mockResolvedValue([
      { ...comment(24, BODY), viewerDidAuthor: true },
    ]);
    const user = userEvent.setup();
    mountCommit({ hide: false, fixture: DUP });
    await waitFor(() => expect(newLine(23)).not.toBeNull(), {
      timeout: 10_000,
    });
    expect(newLine(24)).toBeNull();
    // Listed below the diff: open its edit and type into it.
    await user.click(
      await screen.findByRole("button", { name: "Comment actions" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const editor = await screen.findByRole("textbox", { name: "Edit comment" });
    await user.type(editor, " and more");
    expect(editor.closest("[data-whitespace-row]")).not.toBeNull();
    // Written straight into the settings cache: no probe ran.
    act(() =>
      lastClient?.setQueryData(settingsKeys.settings, {
        ...DEFAULT_SETTINGS,
        diffHideWhitespace: true,
      }),
    );
    await waitFor(() =>
      expect(gitDiffBytesIgnoringWhitespace).toHaveBeenCalledTimes(1),
    );
    await settle();
    // The -w view waits: line 24 stays undrawn and the edit keeps its text.
    expect(newLine(24)).toBeNull();
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: "Edit comment",
      }).value,
    ).toBe(`${BODY} and more`);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(newLine(24)).not.toBeNull());
    expect(screen.getAllByText(BODY)).toHaveLength(1);
    expect(screen.getByText(BODY).closest("[data-diff-anchor]")).not.toBeNull();
  }, 30_000);

  it("holds the commit composer on a line only the -w text draws, and posts a patch line's forge position (AC-C4)", async () => {
    vi.mocked(forgeCommitComments).mockResolvedValue([]);
    vi.mocked(forgeCommitCommentCreate).mockResolvedValue(
      comment(23, "Posted") as never,
    );
    const user = userEvent.setup();
    mountCommit({ hide: true, canComment: true, fixture: DUP });
    await waitFor(() => expect(newLine(24)).not.toBeNull(), {
      timeout: 10_000,
    });
    expect(screen.queryByText(/Whitespace changes are shown/)).toBeNull();
    const OFF_PATCH = "This line isn't in the commit's diff for this file.";
    openComposerAt(24);
    const offEditor = await screen.findByRole("textbox", {
      name: "Comment on Line 24 · f.txt",
    });
    await user.type(offEditor, "Off the patch");
    const held = within(
      offEditor.closest("[data-diff-line-widget]") as HTMLElement,
    ).getByRole("button", { name: "Comment" });
    expect(held).toHaveAccessibleDescription(OFF_PATCH);
    await user.click(held);
    expect(forgeCommitCommentCreate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    // Line 23 is in the forge hunk: it posts where the forge section has it.
    openComposerAt(23);
    const editor = await screen.findByRole("textbox", {
      name: "Comment on Line 23 · f.txt",
    });
    await user.type(editor, "On the patch");
    const post = within(
      editor.closest("[data-diff-line-widget]") as HTMLElement,
    ).getByRole("button", { name: "Comment" });
    expect(post).not.toHaveAccessibleDescription(OFF_PATCH);
    await user.click(post);
    await waitFor(() => expect(forgeCommitCommentCreate).toHaveBeenCalled());
    const [, args] = vi.mocked(forgeCommitCommentCreate).mock.calls[0];
    const forgePosition = positionFromLine(DUP.forge, 23);
    expect(forgePosition).not.toBeNull();
    expect(forgePosition).not.toBe(positionFromLine(DUP.hunks, 23));
    expect((args as { position?: number }).position).toBe(forgePosition);
  }, 30_000);

  it("judges a file's comments only once its own slot shows, never while it prepares behind the held one (AC-C5)", async () => {
    const BODY = "On a re-indented line of g";
    vi.mocked(forgeCommitComments).mockResolvedValue([
      { ...comment(4, BODY), path: "g.zig" },
    ]);
    const user = userEvent.setup();
    mountCommit({
      hide: true,
      fixture: {
        forge: FORGE_TEXT + FORGE_TEXT.replaceAll("f.txt", "g.zig"),
        old: OLD,
        next: NEW,
        hunks: WS_HUNKS,
      },
    });
    await waitFor(() => expect(newLine(14)).not.toBeNull(), {
      timeout: 10_000,
    });
    await settle();
    expect(gitDiffBytesIgnoringWhitespace).toHaveBeenCalledTimes(1);
    let release: (ok: boolean) => void = () => undefined;
    grammar.hold = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    onTestFinished(() => {
      grammar.hold = undefined;
    });
    await user.click(
      document.querySelector<HTMLElement>('[data-path="g.zig"]') as HTMLElement,
    );
    // g.zig's -w view has landed, but its rows wait for their grammar, so its
    // slot still prepares behind the held f.txt.
    await waitFor(() =>
      expect(gitDiffBytesIgnoringWhitespace).toHaveBeenCalledTimes(2),
    );
    await settle();
    expect(
      document.querySelector('[class*="clip-path:inset(50%)"]'),
    ).not.toBeNull();
    expect(screen.queryByText(HIDDEN_NOTE)).toBeNull();
    await act(async () => release(false));
    // Shown: the list judges g.zig by the view its slot paints.
    expect(await screen.findByText(HIDDEN_NOTE)).toBeTruthy();
    expect(screen.getAllByText(BODY)).toHaveLength(1);
    expect(document.querySelector('[class*="clip-path:inset(50%)"]')).toBe(
      null,
    );
  }, 30_000);

  // A whitespace-only commit: the forge section re-indents f's body, and its
  // `-w` diff has no hunk (git 2.51.1).
  const WS_ONLY: Fixture = {
    forge:
      "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n" +
      "@@ -1,10 +1,10 @@\n function f() {\n" +
      "-  line 1\n-  line 2\n-  line 3\n-  line 4\n-  line 5\n-  line 6\n" +
      "+    line 1\n+    line 2\n+    line 3\n+    line 4\n+    line 5\n+    line 6\n" +
      " }\n function g() {\n   line 7\n",
    old: OLD,
    next: NEW.replace("line ELEVEN", "line 11"),
    hunks: "",
  };

  it("leaves the whitespace-only arm straight for the forge rows, never painting a blank pane between them", async () => {
    const BODY = "On a re-indented line";
    const ARM = "Only whitespace changed in this file";
    vi.mocked(forgeCommitComments).mockResolvedValue([comment(4, BODY)]);
    vi.mocked(saveSettingsPatch).mockImplementation(
      async (patch) => ({ ...DEFAULT_SETTINGS, ...patch }) as AppSettings,
    );
    mountCommit({ hide: true, fixture: WS_ONLY });
    // The listed comment offers its own Show whitespace: press the arm's.
    const arm = await screen.findByText(ARM, undefined, { timeout: 10_000 });
    const show = within(
      arm.closest('[tabindex="-1"]') as HTMLElement,
    ).getByRole("button", { name: "Show whitespace" });
    expect(await screen.findByText(HIDDEN_NOTE)).toBeTruthy();
    await settle();
    // Neither the arm nor a drawn row is a blank pane (DiffContent's busy
    // landing); the comment still moves inline in the rows' own frame.
    const once = shownOnce(BODY);
    const watch = watchPainted(() =>
      screen.queryByText(ARM) === null && newLine(2) === null
        ? "blank pane"
        : once(),
    );
    // Disk holds what the press saves, for the settings re-read after it.
    vi.mocked(loadSettings).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      diffHideWhitespace: false,
    });
    await userEvent.setup().click(show);
    await waitFor(() => expect(newLine(2)).not.toBeNull(), {
      timeout: 10_000,
    });
    await settle();
    watch.stop();
    expect(watch.painted).toEqual([]);
    expect(screen.queryByText(ARM)).toBeNull();
    expect(screen.getByText(BODY).closest("[data-diff-anchor]")).not.toBeNull();
    expect(saveSettingsPatch).toHaveBeenCalledWith({
      diffHideWhitespace: false,
    });
  }, 30_000);
});
