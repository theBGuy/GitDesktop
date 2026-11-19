import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BaseBranchCombobox } from "@/features/repository/BaseBranchCombobox";
import { gitBranches, gitRemoteBranches } from "@/lib/git/api";
import type { Branch, RemoteBranch } from "@/lib/git/types";
import { listUserWorktrees, type UserWorktree } from "@/lib/git/worktree";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitBranches: vi.fn(),
  gitRemoteBranches: vi.fn(),
}));
vi.mock("@/lib/git/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/worktree")>()),
  listUserWorktrees: vi.fn(),
}));

const REPO = "C:/repo";

const day = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString();

const branch = (name: string, date: string, isCurrent = false) =>
  ({ name, isCurrent, archived: false, lastCommitDate: date }) as Branch;

const remote = (r: string, name: string, date: string): RemoteBranch => ({
  remote: r,
  name,
  lastCommitDate: date,
});

function renderPicker(defaultName = "main") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      {/* The create-branch dialog names the trigger the same way. */}
      <label htmlFor="base-trigger">Base</label>
      <BaseBranchCombobox
        repoPath={REPO}
        open
        currentName="feat"
        defaultName={defaultName}
        value="feat"
        onValueChange={() => undefined}
        triggerId="base-trigger"
      />
    </QueryClientProvider>,
  );
}

async function openPicker(defaultName?: string) {
  const user = userEvent.setup();
  renderPicker(defaultName);
  await user.click(screen.getByRole("combobox", { name: "Base" }));
  return screen.findByRole("listbox", { name: "Base branches" });
}

/** A row's visible chips (hidden from AT) and hidden copies with this text. */
function chipParts(option: HTMLElement, chip: string) {
  return {
    chips: [...option.querySelectorAll('[aria-hidden="true"]')].filter(
      (el) => el.textContent === chip,
    ),
    copies: [...option.querySelectorAll(".sr-only")].filter(
      (el) => el.textContent === `, ${chip}`,
    ),
  };
}

/** One visible chip inside the name span, one copy straight on the row. */
function expectChip(option: HTMLElement, chip: string) {
  const { chips, copies } = chipParts(option, chip);
  expect(chips).toHaveLength(1);
  expect(chips[0].parentElement).toBe(option.firstElementChild);
  expect(copies).toHaveLength(1);
  expect(copies[0].parentElement).toBe(option);
  return copies[0];
}

/** The row's own relative time: the fixtures' dates drift against the clock. */
function timeOf(option: HTMLElement): string {
  const text = option.querySelector("time")?.textContent ?? "";
  expect(text).not.toBe("");
  return text;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(gitBranches).mockResolvedValue([
    branch("feat", day(9), true),
    branch("main", day(8)),
    branch("held", day(7)),
    branch("bad-date", "not-a-date"),
  ]);
  vi.mocked(gitRemoteBranches).mockResolvedValue([
    remote("origin", "topic", day(6)),
  ]);
  vi.mocked(listUserWorktrees).mockResolvedValue([
    {
      path: "C:/wt/held",
      branch: "held",
      head: "c".repeat(40),
      isMain: false,
      isDetached: false,
      isLocked: false,
      lockReason: "",
    } as UserWorktree,
  ]);
});

describe("Base branch picker row names", () => {
  it("names the list", async () => {
    expect(await openPicker()).toBeInTheDocument();
  });

  it("names the current row", async () => {
    const list = await openPicker();
    const row = await within(list).findByRole("option", { name: /^feat/ });
    expect(row).toHaveAccessibleName(`feat, (current), ${timeOf(row)}`);
  });

  it("names the default row", async () => {
    const list = await openPicker();
    const row = await within(list).findByRole("option", { name: /^main/ });
    expect(row).toHaveAccessibleName(`main, default, ${timeOf(row)}`);
  });

  it("keeps each visible chip in the name span and its copy on the row", async () => {
    const list = await openPicker();
    const current = await within(list).findByRole("option", { name: /^feat/ });
    const currentCopy = expectChip(current, "(current)");
    expect(current.firstElementChild?.nextElementSibling).toBe(currentCopy);
    expect(chipParts(current, "default").chips).toHaveLength(0);
    expect(chipParts(current, "default").copies).toHaveLength(0);

    const main = within(list).getByRole("option", { name: /^main/ });
    const defaultCopy = expectChip(main, "default");
    expect(main.firstElementChild?.nextElementSibling).toBe(defaultCopy);
    expect(chipParts(main, "(current)").chips).toHaveLength(0);
    expect(chipParts(main, "(current)").copies).toHaveLength(0);

    const plain = within(list).getByRole("option", { name: /^held/ });
    for (const chip of ["(current)", "default"]) {
      expect(chipParts(plain, chip).chips).toHaveLength(0);
      expect(chipParts(plain, chip).copies).toHaveLength(0);
    }
  });

  it("orders the copies current then default on a row that is both", async () => {
    const list = await openPicker("feat");
    const row = await within(list).findByRole("option", { name: /^feat/ });
    const currentCopy = expectChip(row, "(current)");
    const defaultCopy = expectChip(row, "default");
    expect(row.firstElementChild?.nextElementSibling).toBe(currentCopy);
    expect(currentCopy.nextElementSibling).toBe(defaultCopy);
    expect(row).toHaveAccessibleName(
      `feat, (current), default, ${timeOf(row)}`,
    );
  });

  it("names a row held in another worktree", async () => {
    const list = await openPicker();
    const row = await within(list).findByRole("option", { name: /^held/ });
    await waitFor(() =>
      expect(row).toHaveAccessibleName(`held, worktree, ${timeOf(row)}`),
    );
  });

  it("names a remote row", async () => {
    const list = await openPicker();
    const row = await within(list).findByRole("option", {
      name: /^origin\/topic/,
    });
    expect(row).toHaveAccessibleName(`origin/topic, ${timeOf(row)}`);
  });

  it("leaves no separator behind an unparseable date", async () => {
    const list = await openPicker();
    expect(
      await within(list).findByRole("option", { name: "bad-date" }),
    ).toBeInTheDocument();
  });
});
