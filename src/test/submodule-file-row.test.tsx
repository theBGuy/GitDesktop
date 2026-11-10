import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { toast } from "sonner";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FileRow } from "@/features/repository/FileRow";
import { SUBMODULE_NOTHING_TO_STAGE } from "@/features/repository/submodule-row";
import type { FileEntry, SubmoduleChange } from "@/lib/git/types";
import { unmockedCommands } from "./setup";

// Reserved device names apply only on Windows, read once at import.
vi.mock("@/lib/hotkeys/binding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hotkeys/binding")>()),
  isWindows: true,
}));

vi.mock("sonner", () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

afterAll(() => {
  expect(unmockedCommands).toEqual([]);
});

beforeEach(() => {
  vi.clearAllMocks();
});

/** The flags of porcelain v2's `S<c><m><u>` token. */
function token(t: string): SubmoduleChange {
  return {
    commitChanged: t[1] === "C",
    trackedModified: t[2] === "M",
    untracked: t[3] === "U",
    worktreeIsGitlink: true,
  };
}

/** An unstaged `.M` submodule record with the given token. */
const dotM = (t: string): FileEntry => ({
  path: "vendor/sub",
  staged: null,
  unstaged: "modified",
  submodule: token(t),
});

type RowProps = ComponentProps<typeof FileRow>;

function renderRow(over: Partial<RowProps> & { entry: FileEntry }) {
  const props: RowProps = {
    kind: "modified",
    staged: false,
    selected: false,
    active: false,
    disabled: false,
    checking: false,
    tabStop: true,
    onSelect: vi.fn(),
    onToggle: vi.fn(),
    onOpen: vi.fn(),
    stat: { path: "vendor/sub", added: 3, deleted: 1, isBinary: false },
    ...over,
  };
  render(
    <div role="listbox" aria-label="Changes">
      <FileRow {...props} />
    </div>,
  );
  return { props, row: screen.getByRole("option"), user: userEvent.setup() };
}

describe("a submodule row in Changes", () => {
  it("6: tags the row and says what changed, per token", () => {
    for (const [t, words] of [
      ["S..U", "untracked files"],
      ["S.M.", "modified files"],
      ["SC..", "commit changed"],
      ["SCMU", "commit changed, modified files, untracked files"],
    ] as const) {
      const { row } = renderRow({ entry: dotM(t) });
      expect(row, t).toHaveTextContent("Submodule");
      expect(row, t).toHaveTextContent(words);
      expect(row.textContent, t).not.toMatch(/new commits/);
      cleanup();
    }
  });

  it("6: the option's name reads the path, the tag and the words as separate phrases", () => {
    const { row } = renderRow({ entry: dotM("SCMU") });
    expect(row).toHaveAccessibleName(
      "Modified vendor/sub, Submodule, commit changed, modified files, untracked files",
    );
    cleanup();
    const { row: bare } = renderRow({
      entry: { ...dotM("S..."), unstaged: "typechange" },
      kind: "typechange",
    });
    expect(bare).toHaveAccessibleName("Type changed vendor/sub, Submodule");
    cleanup();
    // An ordinary row keeps its content-derived name.
    const { row: plain } = renderRow({
      entry: { path: "a.ts", staged: null, unstaged: "modified" },
    });
    expect(plain).not.toHaveAttribute("aria-label");
  });

  it("6: the staged side says commit changed and nothing more", () => {
    const entry: FileEntry = {
      path: "vendor/sub",
      staged: "modified",
      unstaged: "modified",
      submodule: token("SC.U"),
    };
    const { row } = renderRow({ entry, staged: true });
    expect(row).toHaveTextContent("Submodulecommit changed");
    expect(row).not.toHaveTextContent("untracked files");
  });

  it("6: a repository over a staged file edit (MT SC..) tags only its unstaged row", () => {
    const entry: FileEntry = {
      path: "vendor/sub",
      staged: "modified",
      unstaged: "typechange",
      submodule: token("SC.."),
    };
    // The index holds a plain file: an ordinary row with its line counts.
    const { row } = renderRow({ entry, staged: true });
    expect(row).not.toHaveTextContent("Submodule");
    expect(row).not.toHaveAttribute("aria-label");
    expect(row).toHaveTextContent("+3");
    cleanup();
    const { row: unstaged } = renderRow({
      entry,
      kind: "typechange",
      staged: false,
    });
    expect(unstaged).toHaveTextContent("Submodule");
    expect(unstaged).toHaveAccessibleName("Type changed vendor/sub, Submodule");
  });

  it("6: kinds other than modified carry the tag and no words", () => {
    for (const [entry, kind] of [
      [
        {
          path: "s",
          staged: null,
          unstaged: "deleted",
          submodule: token("S..."),
        },
        "deleted",
      ],
      [
        {
          path: "s",
          staged: null,
          unstaged: "typechange",
          submodule: token("SC.."),
        },
        "typechange",
      ],
    ] as const) {
      const { row } = renderRow({ entry, kind });
      expect(row.textContent?.endsWith("Submodule"), kind).toBe(true);
      cleanup();
    }
  });

  it("6: a submodule row renders no line counts; an ordinary row does", () => {
    const { row } = renderRow({ entry: dotM("SC..") });
    expect(row).not.toHaveTextContent("+3");
    cleanup();
    const plain = renderRow({
      entry: { path: "a.ts", staged: null, unstaged: "modified" },
    });
    expect(plain.row).toHaveTextContent("+3");
    expect(plain.row).not.toHaveTextContent("Submodule");
  });

  it("6: tree mode keeps the tag and the words", () => {
    const { row } = renderRow({ entry: dotM("S.MU"), treeDisplay: true });
    expect(row).toHaveTextContent(
      "subSubmodulemodified files, untracked files",
    );
  });

  it("7: a dirty-only row's + is disabled with the reason and does nothing", async () => {
    for (const t of ["S..U", "S.M.", "S.MU"]) {
      const { props, user } = renderRow({ entry: dotM(t) });
      const plus = screen.getByRole("button", { name: "Stage vendor/sub" });
      expect(plus, t).toHaveAccessibleDescription(SUBMODULE_NOTHING_TO_STAGE);
      await user.click(plus);
      expect(props.onToggle, t).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("7: Space on a dirty-only row toasts the reason and does not toggle", async () => {
    const { props, row, user } = renderRow({ entry: dotM("S..U") });
    row.focus();
    await user.keyboard(" ");
    expect(toast.info).toHaveBeenCalledExactlyOnceWith(
      SUBMODULE_NOTHING_TO_STAGE,
    );
    expect(props.onToggle).not.toHaveBeenCalled();
  });

  it("7: a row whose commit changed stages by button and by Space", async () => {
    const { props, row, user } = renderRow({ entry: dotM("SCMU") });
    const plus = screen.getByRole("button", { name: "Stage vendor/sub" });
    expect(plus).not.toHaveAccessibleDescription(SUBMODULE_NOTHING_TO_STAGE);
    await user.click(plus);
    row.focus();
    await user.keyboard(" ");
    expect(props.onToggle).toHaveBeenCalledTimes(2);
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("7: the staged row's − is never blocked", async () => {
    const entry: FileEntry = {
      path: "vendor/sub",
      staged: "modified",
      unstaged: null,
      submodule: token("S..."),
    };
    const { props, user } = renderRow({ entry, staged: true });
    await user.click(
      screen.getByRole("button", { name: "Unstage vendor/sub" }),
    );
    expect(props.onToggle).toHaveBeenCalledExactlyOnceWith(entry, true);
  });

  it("7: a Windows-reserved name outranks the submodule reason", async () => {
    const entry: FileEntry = { ...dotM("S..U"), path: "con" };
    const { row, user } = renderRow({ entry });
    row.focus();
    await user.keyboard(" ");
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.info).not.toHaveBeenCalledWith(SUBMODULE_NOTHING_TO_STAGE);
  });
});
