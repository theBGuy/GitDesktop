import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { toast } from "sonner";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FileRow, MARKER_CHECK_PENDING } from "@/features/repository/FileRow";
import type { FileEntry } from "@/lib/git/types";
import { unmockedCommands } from "./setup";

vi.mock("sonner", () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  expect(unmockedCommands).toEqual([]);
});

const ENTRY: FileEntry = {
  path: "src/app.ts",
  staged: null,
  unstaged: "modified",
};

type RowProps = ComponentProps<typeof FileRow>;

function renderRow(over: Partial<RowProps> = {}) {
  const props: RowProps = {
    entry: ENTRY,
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
    ...over,
  };
  const shell = (p: RowProps) => (
    <div role="listbox" aria-label="Changes">
      <FileRow {...p} />
    </div>
  );
  const utils = render(shell(props));
  return {
    props,
    row: screen.getByRole("option"),
    user: userEvent.setup(),
    /** Re-renders the same row with `next` over its props (mocks kept). */
    rerender: (next: Partial<RowProps>) =>
      utils.rerender(shell({ ...props, ...next })),
  };
}

const PLAIN = { ctrlOrMeta: false, shift: false };

describe("FileRow double-click", () => {
  it("A5: a double-click opens the row once; its two clicks still select", async () => {
    const { props, row, user } = renderRow();
    await user.dblClick(row);
    expect(props.onOpen).toHaveBeenCalledExactlyOnceWith(ENTRY, false);
    expect(props.onSelect).toHaveBeenCalledTimes(2);
    expect(props.onSelect).toHaveBeenNthCalledWith(1, ENTRY, false, PLAIN);
    expect(props.onSelect).toHaveBeenNthCalledWith(2, ENTRY, false, PLAIN);
    expect(props.onToggle).not.toHaveBeenCalled();
  });

  it("A5: a staged row opens with its own side", async () => {
    const staged: FileEntry = { path: "a.ts", staged: "added", unstaged: null };
    const { props, row, user } = renderRow({
      entry: staged,
      kind: "added",
      staged: true,
    });
    await user.dblClick(row);
    expect(props.onOpen).toHaveBeenCalledExactlyOnceWith(staged, true);
  });

  it("A5: a Shift double-click opens too, both clicks carrying the modifier", async () => {
    const mods = { ctrlOrMeta: false, shift: true };
    const { props, row, user } = renderRow();
    await user.keyboard("{Shift>}");
    await user.dblClick(row);
    await user.keyboard("{/Shift}");
    expect(props.onOpen).toHaveBeenCalledExactlyOnceWith(ENTRY, false);
    expect(props.onSelect).toHaveBeenCalledTimes(2);
    expect(props.onSelect).toHaveBeenNthCalledWith(1, ENTRY, false, mods);
    expect(props.onSelect).toHaveBeenNthCalledWith(2, ENTRY, false, mods);
  });

  it("L3: a Control or Meta double-click selects as one modified click and opens", async () => {
    for (const key of ["Control", "Meta"]) {
      const { props, row, user } = renderRow();
      await user.keyboard(`{${key}>}`);
      await user.dblClick(row);
      await user.keyboard(`{/${key}}`);
      expect(props.onOpen, key).toHaveBeenCalledExactlyOnceWith(ENTRY, false);
      expect(props.onSelect, key).toHaveBeenCalledExactlyOnceWith(
        ENTRY,
        false,
        { ctrlOrMeta: true, shift: false },
      );
      cleanup();
    }
  });

  it("L4: a double-click whose first click staged the row never opens", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(10_000);
    const { props, row, rerender } = renderRow();
    const button = screen.getByRole("button", { name: "Stage src/app.ts" });
    fireEvent.click(button);
    expect(props.onToggle).toHaveBeenCalledOnce();
    // The staged row's button is natively disabled: the pair's rest lands on
    // the row.
    rerender({ disabled: true });
    expect(button).toBeDisabled();
    now.mockReturnValue(10_300);
    fireEvent.click(row, { detail: 2 });
    fireEvent.doubleClick(row);
    expect(props.onOpen).not.toHaveBeenCalled();
    now.mockReturnValue(11_000);
    fireEvent.doubleClick(row);
    expect(props.onOpen).toHaveBeenCalledExactlyOnceWith(ENTRY, false);
    now.mockRestore();
  });

  it("A5: a double-click on the stage button toggles twice and never opens", async () => {
    const { props, user } = renderRow();
    await user.dblClick(
      screen.getByRole("button", { name: "Stage src/app.ts" }),
    );
    expect(props.onOpen).not.toHaveBeenCalled();
    expect(props.onToggle).toHaveBeenCalledTimes(2);
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("A5: a disabled or checking row still opens", async () => {
    for (const over of [
      { disabled: true },
      { disabled: true, checking: true },
    ]) {
      const { props, row, user } = renderRow(over);
      await user.dblClick(row);
      expect(props.onOpen).toHaveBeenCalledExactlyOnceWith(ENTRY, false);
      cleanup();
    }
  });

  it("A5: a checking row that isn't disabled opens on double-click; Space toasts the pending reason", async () => {
    const { props, row, user } = renderRow({ checking: true, disabled: false });
    await user.dblClick(row);
    expect(props.onOpen).toHaveBeenCalledExactlyOnceWith(ENTRY, false);
    row.focus();
    await user.keyboard(" ");
    expect(toast.info).toHaveBeenCalledExactlyOnceWith(MARKER_CHECK_PENDING);
    expect(props.onToggle).not.toHaveBeenCalled();
  });

  it("A5: Enter selects and never opens", async () => {
    const { props, row, user } = renderRow();
    row.focus();
    await user.keyboard("{Enter}");
    expect(props.onSelect).toHaveBeenCalledExactlyOnceWith(ENTRY, false, PLAIN);
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it("A5: the row suppresses text selection", () => {
    const { row } = renderRow();
    expect(row).toHaveClass("select-none");
  });
});
