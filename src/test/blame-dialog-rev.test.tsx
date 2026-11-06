import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlameDialog } from "@/features/history/BlameDialog";
import { gitBlame } from "@/lib/git/api";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitBlame: vi.fn(),
}));

const blame = vi.mocked(gitBlame);

/** Non-zero hex of any length, so the oid-width guard never reads a zero run. */
const hex = (n: number) => "abcdef0123".repeat(7).slice(0, n);

function renderDialog(rev?: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <BlameDialog
        repoPath="/repo"
        path="src/a.txt"
        rev={rev}
        open
        onOpenChange={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  blame.mockReset();
});

describe("BlameDialog rev label", () => {
  it.each([
    ["40-hex", hex(40)],
    ["64-hex", hex(64)],
    ["uppercase 64-hex", hex(64).toUpperCase()],
  ])("shortens a full %s commit id to 7 chars", async (_, rev) => {
    blame.mockResolvedValue([]);
    renderDialog(rev);
    expect(await screen.findByText("Empty file.")).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        name: `Blame: a.txt @ ${rev.slice(0, 7)}`,
      }),
    ).toBeTruthy();
  });

  it.each([hex(39), hex(41), hex(63), hex(65), "main"])(
    "shows %s verbatim",
    async (rev) => {
      blame.mockResolvedValue([]);
      renderDialog(rev);
      expect(await screen.findByText("Empty file.")).toBeTruthy();
      expect(
        screen.getByRole("heading", { name: `Blame: a.txt @ ${rev}` }),
      ).toBeTruthy();
    },
  );

  it("titles the working-tree blame without a rev", async () => {
    blame.mockResolvedValue([]);
    renderDialog();
    expect(await screen.findByText("Empty file.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Blame: a.txt" })).toBeTruthy();
  });

  it.each([
    ["40-hex", hex(40)],
    ["64-hex", hex(64)],
  ])("shortens a %s rev in the unknown-revision lead", async (_, rev) => {
    blame.mockRejectedValue({
      kind: "invalidArgument",
      message: `invalid argument: unknown revision: ${rev}`,
    });
    renderDialog(rev);
    expect(
      await screen.findByText(
        `Couldn't blame this file at ${rev.slice(0, 7)} — that revision isn't available locally.`,
      ),
    ).toBeTruthy();
  });

  it("shortens a 64-hex rev in the generic failure lead", async () => {
    const rev = hex(64);
    blame.mockRejectedValue({
      kind: "git",
      message: "git blame failed",
      stderr: "fatal: bad object",
    });
    renderDialog(rev);
    expect(
      await screen.findByText(
        `Couldn't blame this file at ${rev.slice(0, 7)}.`,
      ),
    ).toBeTruthy();
  });
});
