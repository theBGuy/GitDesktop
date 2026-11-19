import {
  hashKey,
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useSwitchAccount } from "@/lib/git/queries";
import {
  holdLens,
  releaseLens,
  shiftChasedLenses,
} from "@/lib/git/queries/board-writes";
import { invoke } from "@/lib/tauri/invoke";
import { unmockedCommands } from "./setup";

// The gh api module calls this seam, so the switch's write meets the mock.
vi.mock("@/lib/tauri/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri/invoke")>()),
  invoke: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});
afterAll(() => expect(unmockedCommands).toEqual([]));

const HELD_KEY = ["held-lens-probe"] as const;
const OTHER_KEY = ["ordinary-probe"] as const;

function Reader({
  queryKey,
  read,
}: {
  queryKey: readonly string[];
  read: () => Promise<string>;
}) {
  useQuery({
    queryKey,
    queryFn: read,
    staleTime: Number.POSITIVE_INFINITY,
    networkMode: "always",
  });
  return null;
}

function SwitchButton() {
  const switchAccount = useSwitchAccount();
  return (
    <button
      type="button"
      onClick={() =>
        void switchAccount
          .mutateAsync({ host: "github.com", login: "octo" })
          .catch(() => undefined)
      }
    >
      Switch
    </button>
  );
}

describe("account switch invalidation", () => {
  it("skips a board lens a date-shift chase holds when the switch settles", async () => {
    let answer: () => void = () => undefined;
    vi.mocked(invoke).mockImplementation((cmd) => {
      if (cmd === "gh_switch_account") {
        return new Promise((resolve) => {
          answer = () => resolve(undefined);
        });
      }
      return Promise.reject(new Error(`unrouted command ${cmd}`));
    });
    const readHeld = vi.fn(() => Promise.resolve("held"));
    const readOther = vi.fn(() => Promise.resolve("other"));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <SwitchButton />
        <Reader queryKey={HELD_KEY} read={readHeld} />
        <Reader queryKey={OTHER_KEY} read={readOther} />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(readHeld).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(readOther).toHaveBeenCalledTimes(1));

    const heldHash = hashKey(HELD_KEY);
    let held = false;
    try {
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Switch" }));
      await vi.waitFor(() =>
        expect(vi.mocked(invoke)).toHaveBeenCalledWith("gh_switch_account", {
          host: "github.com",
          login: "octo",
        }),
      );
      // Taken while the switch is pending: the hold that counts is the one in
      // place when the switch settles.
      holdLens(shiftChasedLenses, heldHash);
      held = true;
      answer();

      await vi.waitFor(() => expect(readOther).toHaveBeenCalledTimes(2));
      expect(readHeld).toHaveBeenCalledTimes(1);
      expect(client.getQueryState(HELD_KEY)?.isInvalidated).toBe(false);
    } finally {
      if (held) releaseLens(shiftChasedLenses, heldHash);
    }
    expect(shiftChasedLenses.size).toBe(0);
  });
});
