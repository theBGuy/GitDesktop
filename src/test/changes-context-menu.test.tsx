import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { toast } from "sonner";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MENU_HELD_ROW_CLASS } from "@/components/menu-held-row";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  ChangesContextMenuItems,
  type ChangesMenuActions,
  type FolderMenuCounts,
} from "@/features/repository/ChangesContextMenu";
import { deletedNothingToOpen } from "@/features/repository/open-changed-file";
import { copyText } from "@/lib/clipboard";
import {
  getSecret,
  openWithDefault,
  openWithProgram,
  pathKind,
  revealInExplorer,
} from "@/lib/git/api";
import { conflictSides } from "@/lib/git/conflict";
import type { FileEntry } from "@/lib/git/types";
import { isWindows } from "@/lib/hotkeys/binding";
import { type AppSettings, loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { unmockedCommands } from "./setup";

// The reserved-name gates read `navigator.platform` once, when binding.ts
// evaluates, so the pose must land before the static imports do.
vi.hoisted(() => {
  Object.defineProperty(navigator, "platform", {
    value: "Win32",
    configurable: true,
  });
});

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  getSecret: vi.fn(),
  revealInExplorer: vi.fn(async () => undefined),
  openWithProgram: vi.fn(async () => undefined),
  openWithDefault: vi.fn(async () => undefined),
  pathKind: vi.fn(async () => "dir"),
}));
vi.mock("@/lib/git/conflict", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/conflict")>()),
  conflictSides: vi.fn(),
}));
// The ui store's repo starts null, which a real refusal reads as closed.
vi.mock("@/lib/stores/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stores/notifications")>()),
  refuseIfSwitched: vi.fn(() => false),
}));
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => undefined) }));

const SECRET = "sk-test-review-key-0000";

type MenuProps = ComponentProps<typeof ChangesContextMenuItems>;
type Case = Partial<Omit<MenuProps, "actions">> & {
  settings?: Partial<AppSettings>;
  /** The review provider's stored key; null leaves the review model unset. */
  secret?: string | null;
};

const ACTION_KEYS: (keyof ChangesMenuActions)[] = [
  "discardAll",
  "stashAll",
  "stageFolder",
  "unstageFolder",
  "discardFolder",
  "stashFolder",
  "stageSelected",
  "unstageSelected",
  "discardSelected",
  "stashSelected",
  "ignoreSelected",
  "untrackSelected",
  "toggle",
  "resolveWithAi",
  "discardFile",
  "stashFile",
  "viewHistory",
  "blame",
  "ignore",
  "untrack",
  "aiExclude",
  "aiExcludeSelected",
  "openSubmodule",
];

let actions: ChangesMenuActions;

beforeEach(() => {
  actions = Object.fromEntries(
    ACTION_KEYS.map((key) => [key, vi.fn()]),
  ) as unknown as ChangesMenuActions;
});

afterAll(() => {
  expect(unmockedCommands).toEqual([]);
});

const row = (entry: FileEntry, staged = false) =>
  ({ kind: "row", entry, staged }) as const;

/** Renders the items inside a real context-menu root, the panel's host shape,
 *  and opens it with a right-click. */
async function openMenu({ settings, secret = SECRET, ...props }: Case) {
  const stored: AppSettings = {
    ...structuredClone(DEFAULT_SETTINGS),
    ...settings,
  };
  const provider = stored.reviewAi.provider;
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(stored),
  );
  // The secret query refetches on mount, so the mock answers like the seed.
  vi.mocked(getSecret).mockImplementation(async () => secret);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, stored);
  client.setQueryData(
    settingsKeys.secret(provider),
    secret === null ? null : { length: secret.length, masked: "sk-tes…0000" },
  );
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={client}>
      <ContextMenu>
        <ContextMenuTrigger>
          <div data-testid="zone">changes</div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ChangesContextMenuItems
            target={null}
            repoPath={"C:\\repo"}
            inSelection={false}
            rowCount={1}
            stagedRowCount={0}
            unstagedRowCount={1}
            stageableCount={1}
            pathCount={1}
            stashablePathCount={1}
            untrackedPaths={new Set()}
            trackedPathCount={1}
            discardableCount={1}
            anyConflicted={false}
            folderCounts={null}
            actions={actions}
            {...props}
            noneStageableLabel={
              props.noneStageableLabel ?? "Stage files (Windows-reserved names)"
            }
          />
        </ContextMenuContent>
      </ContextMenu>
    </QueryClientProvider>,
  );
  await user.pointer({
    keys: "[MouseRight]",
    target: screen.getByTestId("zone"),
  });
  const menu = await screen.findByRole("menu");
  return { user, menu };
}

/** Every item's visible text, in menu order. */
function labels(menu: HTMLElement): string[] {
  return within(menu)
    .getAllByRole("menuitem")
    .map((el) => el.textContent ?? "");
}

function item(menu: HTMLElement, name: string): HTMLElement {
  return within(menu).getByRole("menuitem", { name });
}

function expectDisabled(el: HTMLElement, disabled: boolean) {
  if (disabled) expect(el).toHaveAttribute("aria-disabled", "true");
  else expect(el).not.toHaveAttribute("aria-disabled", "true");
}

type User = ReturnType<typeof userEvent.setup>;

/** Disabled for real: marked aria-disabled, and a click reaches no action. */
async function expectBlocked(user: User, el: HTMLElement) {
  expect(el).toHaveAttribute("aria-disabled", "true");
  await user.click(el);
  expectNoAction();
}

/** Exactly `key` fired, once; every other action stayed silent. */
function expectOnly(key: keyof ChangesMenuActions) {
  for (const k of ACTION_KEYS)
    expect(vi.mocked(actions[k]), k).toHaveBeenCalledTimes(k === key ? 1 : 0);
}

/** Forgets every action call, for a case that clicks more than once. */
function clearActions() {
  for (const k of ACTION_KEYS) vi.mocked(actions[k]).mockClear();
}

/** No menu action fired. */
function expectNoAction() {
  for (const k of ACTION_KEYS)
    expect(vi.mocked(actions[k]), k).not.toHaveBeenCalled();
}

function expectHeld(el: HTMLElement) {
  for (const token of MENU_HELD_ROW_CLASS.split(/\s+/))
    expect(el).toHaveClass(token);
}

const modified: FileEntry = {
  path: "src/lib/path-tree.ts",
  staged: null,
  unstaged: "modified",
};

it("poses as Windows before the reserved-name gates load", () => {
  expect(isWindows).toBe(true);
});

describe("single-file menu", () => {
  it("F1: an unstaged modified file offers the full file menu", async () => {
    const { menu } = await openMenu({ target: row(modified) });
    expect(labels(menu)).toEqual([
      "Stage file",
      "Discard changes…",
      "Stash change…",
      "View file history…",
      "Blame…",
      "Ignore file (add to .gitignore)",
      "Ignore folder (add to .gitignore)",
      "Ignore all .ts files (add to .gitignore)",
      "Untrack file (keep on disk)",
      "Untrack folder (keep on disk)",
      "Untrack all .ts files (keep on disk)",
      "Exclude from AI (add to .gitdesktop/aiignore)",
      "Exclude folder from AI (add to .gitdesktop/aiignore)",
      "Exclude all .ts files from AI (add to .gitdesktop/aiignore)",
      "Copy file path",
      "Copy relative file path",
      "Show in Explorer",
      "Open with default programDouble-click",
    ]);
    expectDisabled(item(menu, "Stage file"), false);
    expectDisabled(item(menu, "Stash change…"), false);
  });

  it("F2: a staged row unstages and offers no Discard", async () => {
    const { menu } = await openMenu({
      target: row({ path: "app.ts", staged: "modified", unstaged: null }, true),
    });
    expect(item(menu, "Unstage file")).toBeInTheDocument();
    expect(labels(menu)).not.toContain("Stage file");
    expect(labels(menu)).not.toContain("Discard changes…");
  });

  it("F3: a reserved file name blocks Stage and Stash, the reserved reason first", async () => {
    const reserved: FileEntry = {
      path: "docs/aux.txt",
      staged: null,
      unstaged: "untracked",
    };
    for (const anyConflicted of [false, true]) {
      const { user, menu } = await openMenu({
        target: row(reserved),
        anyConflicted,
      });
      await expectBlocked(
        user,
        item(menu, "Stage file (Windows-reserved name)"),
      );
      await expectBlocked(
        user,
        item(menu, "Stash change… (Windows-reserved name)"),
      );
      cleanup();
    }
  });

  it("F4: a reserved directory blocks Stash but not Stage", async () => {
    for (const path of ["aux/readme.md", "con/x.txt"]) {
      const { user, menu } = await openMenu({
        target: row({ path, staged: null, unstaged: "untracked" }),
      });
      expectDisabled(item(menu, "Stage file"), false);
      await expectBlocked(
        user,
        item(menu, "Stash change… (Windows-reserved name)"),
      );
      cleanup();
    }
  });

  it("F9: a tracked file under a reserved directory still stashes", async () => {
    const tracked: FileEntry = {
      path: "con/x.txt",
      staged: null,
      unstaged: "modified",
    };
    const { user, menu } = await openMenu({ target: row(tracked) });
    const stash = item(menu, "Stash change…");
    expectDisabled(stash, false);
    await user.click(stash);
    expectOnly("stashFile");
    expect(actions.stashFile).toHaveBeenCalledWith(tracked, false);
  });

  it("F5: Resolve with AI follows either conflicted side and the AI gates", async () => {
    const stagedSide: FileEntry = {
      path: "src/a.ts",
      staged: "conflicted",
      unstaged: null,
    };
    const unstagedSide: FileEntry = {
      path: "src/a.ts",
      staged: null,
      unstaged: "conflicted",
    };
    for (const entry of [stagedSide, unstagedSide]) {
      const { user, menu } = await openMenu({ target: row(entry) });
      expect(labels(menu)[0]).toBe("Resolve with AI…");
      clearActions();
      await user.click(item(menu, "Resolve with AI…"));
      expectOnly("resolveWithAi");
      expect(actions.resolveWithAi).toHaveBeenCalledWith("src/a.ts");
      cleanup();
    }
    const unconfigured = await openMenu({
      target: row(stagedSide),
      secret: null,
    });
    expect(labels(unconfigured.menu)).not.toContain("Resolve with AI…");
    cleanup();
    const hidden = await openMenu({
      target: row(stagedSide),
      settings: { hideAi: true },
    });
    expect(labels(hidden.menu)).not.toContain("Resolve with AI…");
    expect(labels(hidden.menu)).not.toContain(
      "Exclude from AI (add to .gitdesktop/aiignore)",
    );
  });

  it("F6: a staged deletion keeps history but can't be untracked; a staged add has neither", async () => {
    const deletion = await openMenu({
      target: row(
        { path: "old-notes.md", staged: "deleted", unstaged: null },
        true,
      ),
    });
    expect(labels(deletion.menu)).toContain("View file history…");
    expect(labels(deletion.menu)).toContain("Blame…");
    expect(labels(deletion.menu)).not.toContain("Untrack file (keep on disk)");
    cleanup();
    const add = await openMenu({
      target: row({ path: "fresh.ts", staged: "added", unstaged: null }, true),
    });
    expect(labels(add.menu)).not.toContain("Untrack file (keep on disk)");
    expect(labels(add.menu)).not.toContain("View file history…");
  });

  it("F7: an ordinary file's Stash waits while anything is conflicted", async () => {
    const { user, menu } = await openMenu({
      target: row(modified),
      anyConflicted: true,
    });
    const stash = item(menu, "Stash change… (resolve conflicts first)");
    expectHeld(stash);
    expectDisabled(item(menu, "Stage file"), false);
    await expectBlocked(user, stash);
  });

  it("F8: Open in the configured editor appears only when one is set", async () => {
    const set = await openMenu({
      target: row(modified),
      settings: {
        externalEditor: "C:\\code.exe",
        externalEditorName: "VS Code",
      },
    });
    expect(item(set.menu, "Open in VS Code")).toBeInTheDocument();
    cleanup();
    const unset = await openMenu({ target: row(modified) });
    expect(labels(unset.menu).some((l) => l.startsWith("Open in "))).toBe(
      false,
    );
  });
});

// Pairwise-distinct counts, so a label reading the wrong one fails; they keep
// the props' relations (rows = staged + unstaged, each subset within its set).
const BULK: Case = {
  inSelection: true,
  rowCount: 9,
  stagedRowCount: 3,
  unstagedRowCount: 6,
  stageableCount: 4,
  pathCount: 8,
  stashablePathCount: 1,
  trackedPathCount: 5,
  discardableCount: 2,
};

describe("multi-select menu", () => {
  it("B1: the clicked side's verb leads", async () => {
    const staged = await openMenu({ ...BULK, target: row(modified, true) });
    expect(labels(staged.menu).slice(0, 2)).toEqual([
      "Unstage 3 files",
      "Stage 4 of 6 files",
    ]);
    cleanup();
    const unstaged = await openMenu({ ...BULK, target: row(modified) });
    expect(labels(unstaged.menu).slice(0, 2)).toEqual([
      "Stage 4 of 6 files",
      "Unstage 3 files",
    ]);
  });

  it("B2: Stage counts the reachable rows and disables at none", async () => {
    const all = await openMenu({
      ...BULK,
      stageableCount: 6,
      target: row(modified),
    });
    expectDisabled(item(all.menu, "Stage 6 files"), false);
    cleanup();
    const none = await openMenu({
      ...BULK,
      stageableCount: 0,
      target: row(modified),
    });
    const stage = item(none.menu, "Stage files (Windows-reserved names)");
    expectHeld(stage);
    await expectBlocked(none.user, stage);
  });

  it("B3: Discard counts what it sends and hides at zero", async () => {
    const some = await openMenu({ ...BULK, target: row(modified) });
    expect(labels(some.menu)).toContain("Discard 2 of 6 changes…");
    cleanup();
    const all = await openMenu({
      ...BULK,
      discardableCount: 6,
      target: row(modified),
    });
    expect(labels(all.menu)).toContain("Discard 6 changes…");
    cleanup();
    const one = await openMenu({
      ...BULK,
      rowCount: 4,
      unstagedRowCount: 1,
      stageableCount: 1,
      pathCount: 4,
      trackedPathCount: 3,
      discardableCount: 1,
      target: row(modified),
    });
    expect(labels(one.menu)).toContain("Discard 1 change…");
    cleanup();
    const none = await openMenu({
      ...BULK,
      discardableCount: 0,
      target: row(modified),
    });
    expect(labels(none.menu).some((l) => l.startsWith("Discard"))).toBe(false);
  });

  it("B4: Stash counts the files it takes, says why at none, waits on conflicts", async () => {
    const some = await openMenu({ ...BULK, target: row(modified) });
    expectHeld(item(some.menu, "Stash 1 of 8 changes…"));
    cleanup();
    const all = await openMenu({
      ...BULK,
      stashablePathCount: 8,
      target: row(modified),
    });
    expectDisabled(item(all.menu, "Stash 8 changes…"), false);
    cleanup();
    const none = await openMenu({
      ...BULK,
      stashablePathCount: 0,
      target: row(modified),
    });
    await expectBlocked(
      none.user,
      item(
        none.menu,
        "Nothing to stash (submodules, embedded repositories and reserved names stay out of a stash)",
      ),
    );
    cleanup();
    const conflicted = await openMenu({
      ...BULK,
      stashablePathCount: 8,
      anyConflicted: true,
      target: row(modified),
    });
    const stash = item(
      conflicted.menu,
      "Stash 8 changes… (resolve conflicts first)",
    );
    expectHeld(stash);
    await expectBlocked(conflicted.user, stash);
  });

  it("B5: Ignore counts every file, Untrack the tracked ones and hides at none", async () => {
    const { menu } = await openMenu({ ...BULK, target: row(modified) });
    expect(labels(menu)).toContain("Ignore 8 files (add to .gitignore)");
    expect(labels(menu)).toContain("Untrack 5 files (keep on disk)");
    cleanup();
    const none = await openMenu({
      ...BULK,
      trackedPathCount: 0,
      target: row(modified),
    });
    expect(labels(none.menu).some((l) => l.startsWith("Untrack"))).toBe(false);
  });

  it("B6: Exclude from AI shows only while AI is on", async () => {
    const on = await openMenu({ ...BULK, target: row(modified) });
    expect(labels(on.menu)).toContain(
      "Exclude 8 files from AI (add to .gitdesktop/aiignore)",
    );
    cleanup();
    const off = await openMenu({
      ...BULK,
      target: row(modified),
      settings: { hideAi: true },
    });
    expect(labels(off.menu).some((l) => l.startsWith("Exclude"))).toBe(false);
  });

  it("B7: the bulk menu gates on rows, so an MM twin pair still opens it", async () => {
    const { menu } = await openMenu({
      inSelection: true,
      rowCount: 2,
      stagedRowCount: 1,
      unstagedRowCount: 1,
      stageableCount: 1,
      pathCount: 1,
      stashablePathCount: 1,
      trackedPathCount: 1,
      discardableCount: 1,
      target: row({
        path: "src/lib/path-tree.ts",
        staged: "modified",
        unstaged: "modified",
      }),
    });
    expect(labels(menu)).toContain("Ignore 1 file (add to .gitignore)");
    expect(labels(menu)).toContain("Stash 1 change…");
    expect(labels(menu)).not.toContain("Stage file");
  });

  it("B8: an enabled item fires exactly its own action", async () => {
    const discard = await openMenu({ ...BULK, target: row(modified) });
    await discard.user.click(item(discard.menu, "Discard 2 of 6 changes…"));
    expectOnly("discardSelected");
    cleanup();
    clearActions();
    const stash = await openMenu({ ...BULK, target: row(modified) });
    await stash.user.click(item(stash.menu, "Stash 1 of 8 changes…"));
    expectOnly("stashSelected");
  });
});

describe("whole-tree menu", () => {
  it("S1: offers Discard all and Stash all only", async () => {
    const { menu } = await openMenu({ target: { kind: "global" } });
    expect(labels(menu)).toEqual([
      "Discard all changes…",
      "Stash all changes…",
    ]);
    expectDisabled(item(menu, "Stash all changes…"), false);
  });

  it("S2: Stash all waits while anything is conflicted", async () => {
    const { user, menu } = await openMenu({
      target: { kind: "global" },
      anyConflicted: true,
    });
    const stash = item(menu, "Stash all changes… (resolve conflicts first)");
    expectHeld(stash);
    await expectBlocked(user, stash);
  });
});

const FOLDER_PATH = 'a "b"/c:d';
const folder = (section: "staged" | "unstaged" = "unstaged") =>
  ({ kind: "folder", section, path: FOLDER_PATH, repo: "C:\\repo" }) as const;
const counts = (over: Partial<FolderMenuCounts> = {}): FolderMenuCounts => ({
  fileCount: 3,
  stageableCount: 3,
  noneStageableLabel: "Stage files (Windows-reserved names)",
  hiddenCount: 0,
  conflictedCount: 0,
  discardBlockedCount: 0,
  stashableCount: 3,
  ...over,
});

/** The folder group's own items: the Stage/Discard/Stash run. */
function folderItems(menu: HTMLElement): HTMLElement[] {
  return within(
    within(menu).getByRole("group", { name: FOLDER_PATH }),
  ).getAllByRole("menuitem");
}

describe("folder menu", () => {
  it("FL1: the folder path names its group, with no whole-tree items", async () => {
    const { menu } = await openMenu({
      target: folder(),
      folderCounts: counts(),
    });
    expect(folderItems(menu).map((el) => el.textContent)).toEqual([
      "Stage 3 files",
      "Discard 3 changes…",
      "Stash 3 changes…",
    ]);
    expect(labels(menu)).not.toContain("Discard all changes…");
    expect(labels(menu)).not.toContain("Stash all changes…");
  });

  it("FL2: the Stage/Unstage label names what it reaches", async () => {
    const cases: [
      ReturnType<typeof folder>,
      Partial<FolderMenuCounts>,
      string,
      boolean,
    ][] = [
      [folder("staged"), {}, "Unstage 3 files", false],
      [folder("staged"), { fileCount: 1 }, "Unstage 1 file", false],
      [folder(), {}, "Stage 3 files", false],
      [
        folder(),
        { fileCount: 1, stageableCount: 1, stashableCount: 1 },
        "Stage 1 file",
        false,
      ],
      [folder(), { stageableCount: 2 }, "Stage 2 of 3 files", false],
      [
        folder(),
        { stageableCount: 0 },
        "Stage files (Windows-reserved names)",
        true,
      ],
      [
        folder(),
        { fileCount: 0, stageableCount: 0, stashableCount: 0 },
        "Nothing to stage in this folder",
        true,
      ],
      [
        folder("staged"),
        { fileCount: 0, stageableCount: 0, stashableCount: 0 },
        "Nothing to unstage in this folder",
        true,
      ],
      [
        folder(),
        { fileCount: 0, stageableCount: 0, stashableCount: 0, hiddenCount: 2 },
        "No visible files to stage",
        true,
      ],
    ];
    for (const [target, over, label, disabled] of cases) {
      const { user, menu } = await openMenu({
        target,
        folderCounts: counts(over),
      });
      const stage = item(menu, label);
      expectHeld(stage);
      if (disabled) await expectBlocked(user, stage);
      else expectDisabled(stage, false);
      cleanup();
    }
  });

  it("FD1: Discard hides when it would send nothing, and never disables", async () => {
    for (const [target, over] of [
      [folder(), { conflictedCount: 3 }],
      [folder("staged"), {}],
    ] as const) {
      const { menu } = await openMenu({ target, folderCounts: counts(over) });
      expect(labels(menu).some((l) => l.startsWith("Discard"))).toBe(false);
      cleanup();
    }
    const { menu } = await openMenu({
      target: folder(),
      folderCounts: counts(),
      anyConflicted: true,
    });
    expectDisabled(item(menu, "Discard 3 changes…"), false);
  });

  it("FD2: Discard says N of M when conflicted files stay", async () => {
    for (const [over, label] of [
      [{ conflictedCount: 1 }, "Discard 2 of 3 changes…"],
      [{}, "Discard 3 changes…"],
      [
        { fileCount: 1, stageableCount: 1, stashableCount: 1 },
        "Discard 1 change…",
      ],
    ] as const) {
      const { user, menu } = await openMenu({
        target: folder(),
        folderCounts: counts(over),
      });
      await user.click(item(menu, label));
      expectOnly("discardFolder");
      clearActions();
      cleanup();
    }
  });

  it("FD3: Stash counts the files it takes, says why at none, waits on conflicts", async () => {
    const some = await openMenu({
      target: folder(),
      folderCounts: counts({ stashableCount: 2 }),
    });
    expectHeld(item(some.menu, "Stash 2 of 3 changes…"));
    cleanup();
    const none = await openMenu({
      target: folder(),
      folderCounts: counts({ stashableCount: 0 }),
    });
    expect(labels(none.menu).some((l) => l.startsWith("Stash"))).toBe(false);
    await expectBlocked(
      none.user,
      item(
        none.menu,
        "Nothing to stash (submodules, embedded repositories and reserved names stay out of a stash)",
      ),
    );
    cleanup();
    const conflicted = await openMenu({
      target: folder(),
      folderCounts: counts(),
      anyConflicted: true,
    });
    const stash = item(
      conflicted.menu,
      "Stash 3 changes… (resolve conflicts first)",
    );
    expectHeld(stash);
    await expectBlocked(conflicted.user, stash);
  });

  it("FS1: Stage, Discard and Stash lead, the footnote follows them", async () => {
    const { menu } = await openMenu({
      target: folder(),
      folderCounts: counts({ hiddenCount: 2 }),
    });
    const [stage, discard, stash] = folderItems(menu);
    expect(stage).toHaveTextContent("Stage 3 files");
    expect(discard).toHaveTextContent("Discard 3 changes…");
    expect(stash).toHaveTextContent("Stash 3 changes…");
    const note = within(menu).getByText(
      "2 more are hidden by the filter and are left alone.",
    );
    expect(
      stash.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("FS2: the hidden-files footnote describes every folder action", async () => {
    for (const [over, text] of [
      [{ hiddenCount: 1 }, "1 more is hidden by the filter and is left alone."],
      [
        { hiddenCount: 2 },
        "2 more are hidden by the filter and are left alone.",
      ],
    ] as const) {
      const { menu } = await openMenu({
        target: folder(),
        folderCounts: counts(over),
      });
      const actionsShown = folderItems(menu);
      expect(actionsShown).toHaveLength(3);
      for (const el of actionsShown)
        expect(el).toHaveAccessibleDescription(text);
      cleanup();
    }
    for (const [hiddenCount, text] of [
      [1, "1 file here is hidden by the filter."],
      [2, "2 files here are hidden by the filter."],
    ] as const) {
      const { menu } = await openMenu({
        target: folder(),
        folderCounts: counts({
          fileCount: 0,
          stageableCount: 0,
          stashableCount: 0,
          hiddenCount,
        }),
      });
      expect(
        item(menu, "No visible files to stage"),
      ).toHaveAccessibleDescription(text);
      cleanup();
    }
    const { menu } = await openMenu({
      target: folder(),
      folderCounts: counts(),
    });
    for (const el of folderItems(menu))
      expect(el).not.toHaveAttribute("aria-describedby");
    expect(within(menu).queryByText(/hidden by the filter/)).toBeNull();
  });

  it("FS3: the folder menu copies and reveals the folder", async () => {
    const { menu } = await openMenu({
      target: folder(),
      folderCounts: counts(),
    });
    expect(labels(menu).slice(3)).toEqual([
      "Copy folder path",
      "Copy relative folder path",
      "Show in Explorer",
    ]);
  });
});

describe("bulk gate and callback routing", () => {
  it("B9: a multi-row count outside the selection opens the file menu", async () => {
    const { menu } = await openMenu({
      ...BULK,
      inSelection: false,
      target: row(modified),
    });
    expect(labels(menu)[0]).toBe("Stage file");
    expect(labels(menu)).not.toContain("Ignore 8 files (add to .gitignore)");
  });

  it("B10: a one-row selection opens the file menu", async () => {
    const { menu } = await openMenu({
      inSelection: true,
      rowCount: 1,
      stagedRowCount: 0,
      unstagedRowCount: 1,
      stageableCount: 1,
      pathCount: 1,
      stashablePathCount: 1,
      trackedPathCount: 1,
      discardableCount: 1,
      target: row(modified),
    });
    expect(labels(menu)[0]).toBe("Stage file");
    expect(labels(menu)).not.toContain("Ignore 1 file (add to .gitignore)");
  });

  it("C1: the folder Stage item stages the folder", async () => {
    const { user, menu } = await openMenu({
      target: folder(),
      folderCounts: counts(),
    });
    await user.click(item(menu, "Stage 3 files"));
    expectOnly("stageFolder");
  });

  it("C2: the staged folder item unstages the folder", async () => {
    const { user, menu } = await openMenu({
      target: folder("staged"),
      folderCounts: counts(),
    });
    await user.click(item(menu, "Unstage 3 files"));
    expectOnly("unstageFolder");
  });

  it("C3: the folder Stash item stashes the folder", async () => {
    const { user, menu } = await openMenu({
      target: folder(),
      folderCounts: counts(),
    });
    await user.click(item(menu, "Stash 3 changes…"));
    expectOnly("stashFolder");
  });

  it("C4: Stash all stashes the whole tree", async () => {
    const { user, menu } = await openMenu({ target: { kind: "global" } });
    await user.click(item(menu, "Stash all changes…"));
    expectOnly("stashAll");
  });

  it("C5: the file Stash item stashes its entry on its side", async () => {
    const { user, menu } = await openMenu({ target: row(modified) });
    await user.click(item(menu, "Stash change…"));
    expectOnly("stashFile");
    expect(actions.stashFile).toHaveBeenCalledWith(modified, false);
  });

  it("C6: a staged row's file Stash stashes its staged side", async () => {
    const staged: FileEntry = {
      path: "app.ts",
      staged: "modified",
      unstaged: null,
    };
    const { user, menu } = await openMenu({ target: row(staged, true) });
    const stash = item(menu, "Stash change…");
    expectDisabled(stash, false);
    await user.click(stash);
    expectOnly("stashFile");
    expect(actions.stashFile).toHaveBeenCalledWith(staged, true);
  });
});

describe("folder menu: enabled states and helpers", () => {
  it("FD4: a partial or filtered folder Stash stays enabled", async () => {
    const partial = await openMenu({
      target: folder(),
      folderCounts: counts({ stashableCount: 2 }),
    });
    await partial.user.click(item(partial.menu, "Stash 2 of 3 changes…"));
    expectOnly("stashFolder");
    cleanup();
    clearActions();
    const filtered = await openMenu({
      target: folder(),
      folderCounts: counts({ hiddenCount: 2 }),
    });
    await filtered.user.click(item(filtered.menu, "Stash 3 changes…"));
    expectOnly("stashFolder");
  });

  it("FD5: folder Discard stays enabled with nothing stageable or files hidden", async () => {
    for (const over of [{ stageableCount: 0 }, { hiddenCount: 2 }]) {
      const { user, menu } = await openMenu({
        target: folder(),
        folderCounts: counts(over),
      });
      await user.click(item(menu, "Discard 3 changes…"));
      expectOnly("discardFolder");
      clearActions();
      cleanup();
    }
  });

  it("FL3: an all-hidden staged folder names the unstage verb", async () => {
    const { user, menu } = await openMenu({
      target: folder("staged"),
      folderCounts: counts({
        fileCount: 0,
        stageableCount: 0,
        stashableCount: 0,
        hiddenCount: 2,
      }),
    });
    await expectBlocked(user, item(menu, "No visible files to unstage"));
  });

  it("FS4: the folder copy and reveal items reach their helpers, no action", async () => {
    const absolute = `C:\\repo\\a "b"\\c:d`;
    for (const [label, check] of [
      [
        "Copy folder path",
        () => expect(copyText).toHaveBeenCalledWith(absolute, "Path copied"),
      ],
      [
        "Copy relative folder path",
        () =>
          expect(copyText).toHaveBeenCalledWith(
            FOLDER_PATH,
            "Relative path copied",
          ),
      ],
      [
        "Show in Explorer",
        () => expect(revealInExplorer).toHaveBeenCalledWith(absolute),
      ],
    ] as const) {
      const { user, menu } = await openMenu({
        target: folder(),
        folderCounts: counts(),
      });
      await user.click(item(menu, label));
      check();
      expectNoAction();
      vi.mocked(copyText).mockClear();
      vi.mocked(revealInExplorer).mockClear();
      cleanup();
    }
  });
});

const EDITOR_SET: Partial<AppSettings> = {
  externalEditor: "C:\\code.exe",
  externalEditorName: "VS Code",
};
const OPEN_ITEM = /^Open (in |with default program)/;

// Worktree deletions, by row: `.D`, both rows of `MD`, `AD`, `RD`.
const STATIC_REFUSE_ROWS = [
  row({ path: "gone.ts", staged: null, unstaged: "deleted" }),
  row({ path: "gone.ts", staged: "modified", unstaged: "deleted" }),
  row({ path: "gone.ts", staged: "modified", unstaged: "deleted" }, true),
  row({ path: "gone.ts", staged: "added", unstaged: "deleted" }, true),
  row(
    {
      path: "gone.ts",
      origPath: "was.ts",
      staged: "renamed",
      unstaged: "deleted",
    },
    true,
  ),
];
// The working file may or may not exist: a staged deletion, a conflict.
const PROBE_ROWS = [
  row({ path: "old-notes.md", staged: "deleted", unstaged: null }, true),
  row({ path: "src/merge.ts", staged: null, unstaged: "conflicted" }),
];

/** The hint inside `el`, asserted hidden from assistive tech. */
function expectHint(el: HTMLElement) {
  expect(within(el).getByText("Double-click")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
}

describe("file menu: double-click hint", () => {
  it("H1: the editor item carries the hint when an editor is set", async () => {
    const { menu } = await openMenu({
      target: row(modified),
      settings: EDITOR_SET,
    });
    expectHint(item(menu, "Open in VS Code"));
    expect(
      within(item(menu, "Open with default program")).queryByText(
        "Double-click",
      ),
    ).toBeNull();
    expect(within(menu).getAllByText("Double-click")).toHaveLength(1);
  });

  it("H2: the default-program item carries it with no editor, or a blank one", async () => {
    for (const settings of [{}, { externalEditor: "   " }]) {
      const { menu } = await openMenu({ target: row(modified), settings });
      expect(labels(menu).some((l) => l.startsWith("Open in "))).toBe(false);
      expectHint(item(menu, "Open with default program"));
      expect(within(menu).getAllByText("Double-click")).toHaveLength(1);
      cleanup();
    }
  });

  it("H3: a worktree deletion shows no hint; a probe-class row shows one", async () => {
    for (const target of STATIC_REFUSE_ROWS) {
      const { menu } = await openMenu({ target, settings: EDITOR_SET });
      expect(within(menu).queryByText("Double-click")).toBeNull();
      cleanup();
    }
    for (const target of PROBE_ROWS) {
      const { menu } = await openMenu({ target, settings: EDITOR_SET });
      expect(within(menu).getAllByText("Double-click")).toHaveLength(1);
      expectHint(item(menu, "Open in VS Code"));
      cleanup();
    }
  });

  it("H4: the bulk, folder and whole-tree menus show no hint", async () => {
    for (const props of [
      { ...BULK, target: row(modified) },
      { target: folder(), folderCounts: counts() },
      { target: { kind: "global" } as const },
    ] satisfies Case[]) {
      const { menu } = await openMenu({ ...props, settings: EDITOR_SET });
      expect(within(menu).queryByText("Double-click")).toBeNull();
      cleanup();
    }
  });
});

describe("file menu: Open items gate on the open decision", () => {
  beforeEach(() => {
    vi.mocked(conflictSides).mockReset();
    vi.mocked(openWithProgram).mockClear();
    vi.mocked(openWithDefault).mockClear();
  });

  it("G1: a worktree deletion offers no Open item, but still Show in Explorer", async () => {
    for (const target of STATIC_REFUSE_ROWS)
      for (const settings of [EDITOR_SET, {}]) {
        const { menu } = await openMenu({ target, settings });
        expect(labels(menu).filter((l) => OPEN_ITEM.test(l))).toEqual([]);
        expect(item(menu, "Show in Explorer")).toBeInTheDocument();
        cleanup();
      }
  });

  it("G2: a probe-class row offers both Open items and probes before either launches", async () => {
    const info = vi.spyOn(toast, "info");
    for (const target of PROBE_ROWS) {
      const path = target.entry.path;
      const abs = `C:\\repo\\${path.replaceAll("/", "\\")}`;
      for (const [label, launched] of [
        [
          "Open in VS Code",
          () =>
            expect(openWithProgram).toHaveBeenCalledExactlyOnceWith(
              "C:\\code.exe",
              abs,
            ),
        ],
        [
          "Open with default program",
          () => expect(openWithDefault).toHaveBeenCalledExactlyOnceWith(abs),
        ],
      ] as const)
        for (const workingExists of [false, true]) {
          vi.mocked(pathKind).mockClear();
          vi.mocked(pathKind).mockResolvedValueOnce(
            workingExists ? "file" : "missing",
          );
          vi.mocked(openWithProgram).mockClear();
          vi.mocked(openWithDefault).mockClear();
          info.mockClear();
          const { user, menu } = await openMenu({
            target,
            settings: EDITOR_SET,
          });
          expect(labels(menu).filter((l) => OPEN_ITEM.test(l))).toHaveLength(2);
          await user.click(item(menu, label));
          await vi.waitFor(() =>
            expect(pathKind).toHaveBeenCalledExactlyOnceWith("C:\\repo", path),
          );
          expect(conflictSides).not.toHaveBeenCalled();
          if (workingExists) await vi.waitFor(launched);
          else {
            await vi.waitFor(() =>
              expect(info).toHaveBeenCalledWith(deletedNothingToOpen(path)),
            );
            expect(openWithProgram).not.toHaveBeenCalled();
            expect(openWithDefault).not.toHaveBeenCalled();
          }
          cleanup();
        }
    }
    info.mockRestore();
  });

  it("G3: an ordinary row's Open items launch at once, with no probe", async () => {
    const { user, menu } = await openMenu({
      target: row(modified),
      settings: EDITOR_SET,
    });
    await user.click(item(menu, "Open in VS Code"));
    await vi.waitFor(() =>
      expect(openWithProgram).toHaveBeenCalledExactlyOnceWith(
        "C:\\code.exe",
        "C:\\repo\\src\\lib\\path-tree.ts",
      ),
    );
    expect(conflictSides).not.toHaveBeenCalled();
  });
});

/** An unstaged `.M` submodule record of the given kind (all token flags off
 *  but `untracked`, the #634 shape). Its worktree is a gitlink only while it
 *  is modified: a typechange here is a file on disk, a deletion nothing. */
const subRow = (
  unstaged: FileEntry["unstaged"],
  commitChanged = false,
  worktreeIsGitlink = unstaged === "modified",
) =>
  row({
    path: "vendor/sub",
    staged: null,
    unstaged,
    submodule: {
      commitChanged,
      trackedModified: false,
      untracked: true,
      worktreeIsGitlink,
    },
  });

const INSIDE_STASH_HINT = "Stash change… (open the submodule to stash)";
const COMMIT_STASH_HINT =
  "Stash change… (a submodule's commit can't be stashed)";

describe("file menu: submodule rows", () => {
  beforeEach(() => {
    vi.mocked(conflictSides).mockReset();
    vi.mocked(openWithProgram).mockClear();
    vi.mocked(openWithDefault).mockClear();
  });

  it("SM1: the hint sits on Open submodule, which opens the row's path; no file opens", async () => {
    for (const settings of [EDITOR_SET, {}]) {
      const { user, menu } = await openMenu({
        target: subRow("modified"),
        settings,
      });
      const open = item(menu, "Open submodule");
      expectHint(open);
      expect(within(menu).getAllByText("Double-click")).toHaveLength(1);
      const tail = labels(menu).slice(
        labels(menu).indexOf(open.textContent ?? ""),
      );
      expect(tail[1]).toBe("Show in Explorer");
      // A folder row never launches an editor, configured or not.
      expect(labels(menu).filter((l) => OPEN_ITEM.test(l))).toEqual([]);
      expect(within(menu).queryByText("Open in VS Code")).toBeNull();
      expect(within(menu).queryByText("Open with default program")).toBeNull();
      await user.click(open);
      // The folder is probed first (mocked "dir"), then opened as a submodule.
      await vi.waitFor(() =>
        expect(actions.openSubmodule).toHaveBeenCalledExactlyOnceWith(
          "vendor/sub",
        ),
      );
      expect(conflictSides).not.toHaveBeenCalled();
      expect(openWithProgram).not.toHaveBeenCalled();
      expect(openWithDefault).not.toHaveBeenCalled();
      clearActions();
      cleanup();
    }
  });

  it("SM2: a removed submodule folder offers no open item, but Show in Explorer", async () => {
    const { menu } = await openMenu({
      target: subRow("deleted"),
      settings: EDITOR_SET,
    });
    expect(
      labels(menu).filter(
        (l) => OPEN_ITEM.test(l) || l.startsWith("Open submodule"),
      ),
    ).toEqual([]);
    expect(within(menu).queryByText("Double-click")).toBeNull();
    expect(item(menu, "Show in Explorer")).toBeInTheDocument();
  });

  it("L7: an untracked folder (? sub/) offers only Show in Explorer, which reveals the folder", async () => {
    for (const settings of [EDITOR_SET, {}]) {
      vi.mocked(revealInExplorer).mockClear();
      const { menu, user } = await openMenu({
        target: row({ path: "sub/", staged: null, unstaged: "untracked" }),
        settings,
      });
      expect(
        labels(menu).filter(
          (l) => OPEN_ITEM.test(l) || l.startsWith("Open submodule"),
        ),
      ).toEqual([]);
      expect(within(menu).queryByText("Double-click")).toBeNull();
      await user.click(item(menu, "Show in Explorer"));
      expect(revealInExplorer).toHaveBeenCalledExactlyOnceWith("C:\\repo\\sub");
      cleanup();
    }
  });

  it("SM3: a dirty-only row can't stage; a moved pointer can", async () => {
    const blocked = await openMenu({ target: subRow("modified") });
    await expectBlocked(
      blocked.user,
      item(blocked.menu, "Stage file (commit inside the submodule first)"),
    );
    cleanup();
    const moved = await openMenu({ target: subRow("modified", true) });
    await moved.user.click(item(moved.menu, "Stage file"));
    expectOnly("toggle");
  });

  it("SM4: Discard says why it is off on modified and typechange rows, and stays on a removed folder", async () => {
    for (const [unstaged, label] of [
      ["modified", "Discard changes… (open the submodule to discard)"],
      [
        "typechange",
        "Discard changes… (not available when a submodule and a file swap places)",
      ],
    ] as const) {
      const { user, menu } = await openMenu({ target: subRow(unstaged) });
      await expectBlocked(user, item(menu, label));
      cleanup();
    }
    const { user, menu } = await openMenu({ target: subRow("deleted") });
    await user.click(item(menu, "Discard changes…"));
    expectOnly("discardFile");
  });

  it("SM5: a bulk or folder target with nothing stageable shows the panel's label, disabled", async () => {
    for (const label of [
      "Stage files (commit inside the submodule first)",
      "Stage files (none can be staged)",
    ]) {
      const bulk = await openMenu({
        ...BULK,
        stageableCount: 0,
        noneStageableLabel: label,
        target: row(modified),
      });
      await expectBlocked(bulk.user, item(bulk.menu, label));
      cleanup();
      const dir = await openMenu({
        target: folder(),
        folderCounts: counts({ stageableCount: 0, noneStageableLabel: label }),
      });
      await expectBlocked(dir.user, item(dir.menu, label));
      cleanup();
    }
  });

  it("SM7: Stash is off with its reason on every submodule row, conflicts or not", async () => {
    const stagedPointer = row(
      {
        path: "vendor/sub",
        staged: "modified",
        unstaged: null,
        submodule: {
          commitChanged: true,
          trackedModified: false,
          untracked: false,
          worktreeIsGitlink: true,
        },
      },
      true,
    );
    const movedWithEdits = row({
      path: "vendor/sub",
      staged: null,
      unstaged: "modified",
      submodule: {
        commitChanged: true,
        trackedModified: true,
        untracked: false,
        worktreeIsGitlink: true,
      },
    });
    const pointerOnly = row({
      path: "vendor/sub",
      staged: null,
      unstaged: "modified",
      submodule: {
        commitChanged: true,
        trackedModified: false,
        untracked: false,
        worktreeIsGitlink: true,
      },
    });
    // A repository that replaced a file: git reports no inner flags on a
    // typechange record, unstaged (`.T SC..`) or staged (`T. S...`).
    const replaced = (staged: boolean) =>
      row(
        {
          path: "vendor/sub",
          staged: staged ? "typechange" : null,
          unstaged: staged ? null : "typechange",
          submodule: {
            commitChanged: !staged,
            trackedModified: false,
            untracked: false,
            worktreeIsGitlink: true,
          },
        },
        staged,
      );
    // Changes inside a submodule stash from within it, whether or not its
    // commit moved, and so do a replacing repository's; a pointer move alone
    // or a deletion can't be stashed at all.
    for (const [target, label] of [
      [subRow("modified"), INSIDE_STASH_HINT],
      [subRow("modified", true), INSIDE_STASH_HINT],
      [movedWithEdits, INSIDE_STASH_HINT],
      [pointerOnly, COMMIT_STASH_HINT],
      [subRow("deleted"), COMMIT_STASH_HINT],
      [subRow("typechange", false, true), INSIDE_STASH_HINT],
      [replaced(false), INSIDE_STASH_HINT],
      [replaced(true), INSIDE_STASH_HINT],
      [stagedPointer, COMMIT_STASH_HINT],
    ] as const)
      for (const anyConflicted of [false, true]) {
        const { user, menu } = await openMenu({ target, anyConflicted });
        await expectBlocked(user, item(menu, label));
        cleanup();
      }
  });

  it("SM10: a file that became a submodule keeps Open submodule and no file opens", async () => {
    for (const settings of [EDITOR_SET, {}]) {
      const { menu } = await openMenu({
        target: subRow("typechange", false, true),
        settings,
      });
      expectHint(item(menu, "Open submodule"));
      expect(labels(menu).filter((l) => OPEN_ITEM.test(l))).toEqual([]);
      expect(within(menu).queryByText("Open in VS Code")).toBeNull();
      expect(within(menu).queryByText("Open with default program")).toBeNull();
      cleanup();
    }
  });

  it("SM11: an embedded repository's row stays out of Stash with its reason", async () => {
    const embedded = row({
      path: "vendor/inner/",
      staged: null,
      unstaged: "untracked",
    });
    const { user, menu } = await openMenu({ target: embedded });
    await expectBlocked(
      user,
      item(menu, "Stash change… (an embedded repository can't be stashed)"),
    );
  });

  it("SM8: a submodule swapped for a file offers the file opens and Stash, never Open submodule", async () => {
    for (const settings of [EDITOR_SET, {}]) {
      const { user, menu } = await openMenu({
        target: subRow("typechange"),
        settings,
      });
      expect(labels(menu).some((l) => l.startsWith("Open submodule"))).toBe(
        false,
      );
      const byDefault = item(menu, "Open with default program");
      if (settings === EDITOR_SET) expectHint(item(menu, "Open in VS Code"));
      else expectHint(byDefault);
      expect(within(menu).getAllByText("Double-click")).toHaveLength(1);
      const stash = item(menu, "Stash change…");
      expectDisabled(stash, false);
      await user.click(stash);
      expectOnly("stashFile");
      clearActions();
      cleanup();
    }
  });

  it("SM9: a staged submodule deletion stashes when a file took its path, and stays out alone", async () => {
    const deletion = row(
      {
        path: "vendor/sub",
        staged: "deleted",
        unstaged: null,
        submodule: {
          commitChanged: false,
          trackedModified: false,
          untracked: false,
          worktreeIsGitlink: false,
        },
      },
      true,
    );
    const paired = await openMenu({
      target: deletion,
      untrackedPaths: new Set(["vendor/sub"]),
    });
    const stash = item(paired.menu, "Stash change…");
    expectDisabled(stash, false);
    await paired.user.click(stash);
    expectOnly("stashFile");
    clearActions();
    cleanup();
    const alone = await openMenu({
      target: deletion,
      untrackedPaths: new Set(["vendor/other"]),
    });
    await expectBlocked(alone.user, item(alone.menu, COMMIT_STASH_HINT));
  });

  it("SM6: Discard leaves the withheld submodule rows out of its count", async () => {
    const dir = await openMenu({
      target: folder(),
      folderCounts: counts({ conflictedCount: 0, discardBlockedCount: 1 }),
    });
    await dir.user.click(item(dir.menu, "Discard 2 of 3 changes…"));
    expectOnly("discardFolder");
    clearActions();
    cleanup();
    const bulk = await openMenu({
      ...BULK,
      unstagedRowCount: 3,
      discardableCount: 2,
      target: row(modified),
    });
    await bulk.user.click(item(bulk.menu, "Discard 2 of 3 changes…"));
    expectOnly("discardSelected");
  });
});
