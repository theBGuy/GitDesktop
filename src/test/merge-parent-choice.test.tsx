import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  MergeParentDialog,
  type MergePickTarget,
} from "@/features/history/HistoryDialogs";
import { gitCommitParents } from "@/lib/git/api";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitCommitParents: vi.fn(),
}));

const REPO_A = "C:/repo-a";
const REPO_B = "C:/repo-b";
/** Non-zero hex, so the oid-width guard never reads a zero run. */
const MERGE = "abcdef0123".repeat(4);
const TARGET: MergePickTarget = { hash: MERGE, op: "revert" };

beforeEach(() => {
  unmockedCommands.length = 0;
  vi.mocked(gitCommitParents).mockImplementation(async (_repo, hash) => [
    { hash: `1${hash.slice(1)}`, subject: "first parent" },
    { hash: `2${hash.slice(1)}`, subject: "second parent" },
  ]);
});

afterEach(() => {
  expect(unmockedCommands).toEqual([]);
});

const parent = (n: number) =>
  screen.getByRole("radio", { name: new RegExp(`^Parent ${n} `) });

it("a host's switch guard never carries the chosen parent into another repository", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const dialog = (repo: string, target: MergePickTarget | null) => (
    <QueryClientProvider client={client}>
      <MergeParentDialog
        repoPath={repo}
        target={target}
        openedIn={target ? repo : null}
        onClose={() => undefined}
      />
    </QueryClientProvider>
  );
  const user = userEvent.setup();
  const { rerender } = render(dialog(REPO_A, TARGET));
  await screen.findByText("second parent");
  expect(parent(1).getAttribute("aria-checked")).toBe("true");
  await user.click(parent(2));
  expect(parent(2).getAttribute("aria-checked")).toBe("true");

  // The host's repository-switch guard clears the target without a close.
  rerender(dialog(REPO_A, null));
  rerender(dialog(REPO_B, TARGET));
  await screen.findByText("second parent");
  expect(vi.mocked(gitCommitParents)).toHaveBeenCalledWith(REPO_B, MERGE);
  expect(parent(1).getAttribute("aria-checked")).toBe("true");
  expect(parent(2).getAttribute("aria-checked")).toBe("false");
});
