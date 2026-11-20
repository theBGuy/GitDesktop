import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BranchRulesDialog } from "@/features/branch-rules/BranchRulesDialog";
import {
  loadBranchRules,
  loadSharedBranchRules,
  saveBranchRules,
} from "@/lib/branch-rules/store";
import {
  type BranchRulesConfig,
  EMPTY_BRANCH_RULES,
} from "@/lib/branch-rules/types";
import { forgeStatus, writeRepoBranchRules } from "@/lib/git/api";
import type { ForgeStatus } from "@/lib/git/types/forge";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}));

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(),
  writeRepoBranchRules: vi.fn(),
}));

// The shared save stays real, so its committed JSON reaches the api mock.
vi.mock("@/lib/branch-rules/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/branch-rules/store")>()),
  loadBranchRules: vi.fn(),
  loadSharedBranchRules: vi.fn(),
  saveBranchRules: vi.fn(),
}));

const REPO = "C:/repo";
let savedPersonal: BranchRulesConfig;

beforeEach(() => {
  savedPersonal = EMPTY_BRANCH_RULES;
  vi.mocked(loadBranchRules).mockReset();
  vi.mocked(loadBranchRules).mockImplementation(async () => savedPersonal);
  vi.mocked(loadSharedBranchRules)
    .mockReset()
    .mockResolvedValue(EMPTY_BRANCH_RULES);
  vi.mocked(saveBranchRules).mockReset();
  vi.mocked(saveBranchRules).mockImplementation(async (_repo, config) => {
    savedPersonal = config;
  });
  vi.mocked(writeRepoBranchRules).mockReset().mockResolvedValue(undefined);
  vi.mocked(forgeStatus)
    .mockReset()
    .mockResolvedValue({ provider: "github" } as ForgeStatus);
});

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Reopen
      </button>
      <BranchRulesDialog repoPath={REPO} open={open} onOpenChange={setOpen} />
    </>
  );
}

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}

const SETTING = /Start the merge dialog with "Delete branch on the remote/;

async function findSetting() {
  return screen.findByRole("checkbox", { name: SETTING });
}

function saveDisabled() {
  const save = screen.getByRole("button", { name: "Save changes" });
  return (
    save.hasAttribute("disabled") ||
    save.getAttribute("aria-disabled") === "true"
  );
}

function headings() {
  return within(screen.getByRole("dialog"))
    .getAllByRole("heading", { level: 3 })
    .map((h) => h.textContent);
}

describe("Branch rules: After merging", () => {
  it("is the last section on the Personal tab and absent on the Shared tab", async () => {
    const user = userEvent.setup();
    mount();
    await findSetting();
    expect(headings()).toEqual([
      "New branch names",
      "Protected branches",
      "Promotion branches",
      "After merging",
    ]);
    expect(
      screen.getByText(
        /Local guardrails and merge defaults for this repository\./,
      ),
    ).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Shared with repository" }),
    );
    await screen.findByRole("button", { name: "Save to repository" });
    expect(headings()).not.toContain("After merging");
    expect(screen.queryByRole("checkbox", { name: SETTING })).toBeNull();
    expect(screen.queryByText(/delete choice/)).toBeNull();
  });

  it("names the forge and its per-request choice in the hint", async () => {
    vi.mocked(forgeStatus).mockResolvedValue({
      provider: "gitlab",
    } as ForgeStatus);
    mount();
    const box = await findSetting();
    const hintId = box.getAttribute("aria-describedby");
    expect(hintId).toBeTruthy();
    const hint = document.getElementById(hintId as string);
    await waitFor(() =>
      expect(hint?.textContent).toBe(
        "You can still untick it for any merge. The setting doesn't tick it " +
          "for a merge request from a fork, the default branch, a promotion " +
          "branch, or a branch a rule blocks from deletion. When the setting " +
          "doesn't tick it, a merge request starts from its own delete choice " +
          "on GitLab.",
      ),
    );
  });

  it("keeps the GitHub hint to the setting's own exceptions", async () => {
    mount();
    const box = await findSetting();
    const hint = document.getElementById(
      box.getAttribute("aria-describedby") as string,
    );
    // The pending hint reads the same, so the forge status must have answered
    // (and rendered) before the provider sentence's absence means anything.
    await waitFor(() => expect(forgeStatus).toHaveBeenCalled());
    await act(async () => {
      await vi.mocked(forgeStatus).mock.results[0].value;
    });
    expect(hint?.textContent).toBe(
      "You can still untick it for any merge. The setting doesn't tick it " +
        "for a pull request from a fork, the default branch, a promotion " +
        "branch, or a branch a rule blocks from deletion.",
    );
  });

  it("rides Save/Discard: Cancel writes nothing, Save writes the setting, reopen shows it", async () => {
    const user = userEvent.setup();
    mount();
    const box = await findSetting();
    expect(box.getAttribute("aria-checked")).toBe("false");
    expect(saveDisabled()).toBe(true);

    await user.click(box);
    expect(box.getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(saveDisabled()).toBe(false));

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(saveBranchRules).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Reopen" }));
    const reopened = await findSetting();
    expect(reopened.getAttribute("aria-checked")).toBe("false");
    await user.click(reopened);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(saveBranchRules).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveBranchRules).mock.calls[0]).toEqual([
      REPO,
      { ...EMPTY_BRANCH_RULES, deleteHeadAfterMerge: true },
    ]);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Reopen" }));
    expect((await findSetting()).getAttribute("aria-checked")).toBe("true");
  });

  it("never carries the personal setting into the shared file", async () => {
    savedPersonal = { ...EMPTY_BRANCH_RULES, deleteHeadAfterMerge: true };
    const user = userEvent.setup();
    mount();
    expect((await findSetting()).getAttribute("aria-checked")).toBe("true");

    await user.click(
      screen.getByRole("button", { name: "Shared with repository" }),
    );
    await screen.findByRole("button", { name: "Save to repository" });
    // The first Add is Protected branches'.
    await user.click(screen.getAllByRole("button", { name: "Add" })[0]);
    await user.click(
      screen.getByRole("button", { name: "Save to repository" }),
    );
    await waitFor(() => expect(writeRepoBranchRules).toHaveBeenCalledTimes(1));
    const [repo, json] = vi.mocked(writeRepoBranchRules).mock.calls[0];
    expect(repo).toBe(REPO);
    expect(json).not.toContain("deleteHeadAfterMerge");
    expect(JSON.parse(json).protections).toHaveLength(1);
  });
});
