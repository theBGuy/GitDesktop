import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  PrActivityFeed,
  usePrThreadClaims,
} from "@/features/pulls/PrActivityFeed";
import type { PrDetails, PrThreadOut } from "@/lib/git/types";
import { unmockedCommands } from "./setup";

// The rows' host lookup; it never answers here.
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(() => new Promise(() => undefined)),
}));

afterAll(() => expect(unmockedCommands).toEqual([]));

const row = (over: Partial<PrThreadOut>): PrThreadOut => ({
  author: "someone",
  authorAvatarUrl: "",
  state: "",
  body: "",
  date: "2026-01-01T00:00:00Z",
  id: "",
  url: "",
  viewerDidAuthor: false,
  isMinimized: false,
  minimizedReason: "",
  reviewId: "",
  ...over,
});

const PR = {
  number: 3,
  comments: [
    row({ id: "C_1", body: "hosted words" }),
    row({
      id: "optimistic:1",
      body: "![shot](image-1.png)",
      date: "2026-01-02T00:00:00Z",
      postToken: "0".repeat(32),
    }),
  ],
  reviews: [],
  commits: [],
  commitsUnknown: false,
} as unknown as PrDetails;

function Feed({ onQuote }: { onQuote: (body: string) => void }) {
  const claims = usePrThreadClaims(PR, []);
  return (
    <PrActivityFeed
      pr={PR}
      timeline={{
        data: [],
        isError: false,
        isPaused: false,
        isFetching: false,
        refetch: vi.fn(),
      }}
      stale={false}
      reactions={undefined}
      claims={claims}
      providerKey="github"
      suggestionApply={{} as never}
      fileDiffLookup={() => undefined}
      disabledReason={undefined}
      revealThreadId={null}
      setRevealThreadId={() => undefined}
      setSection={() => undefined}
      onSelectCommit={() => undefined}
      canWrite
      canThreadReply={false}
      canThreadResolve={false}
      canEditOwnThreadComments={false}
      canEditOwnComments={false}
      canReact={false}
      onQuote={onQuote}
      onThreadReply={async () => undefined}
      onThreadResolve={async () => undefined}
      onHideComment={() => undefined}
      onUnhideComment={() => undefined}
      onToggleReaction={() => undefined}
    />
  );
}

describe("the PR feed offers no Quote reply on a just-posted row", () => {
  it("withholds Quote on the row carrying a post token, keeps it on a hosted row", async () => {
    const onQuote = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Feed onQuote={onQuote} />
      </QueryClientProvider>,
    );
    const menus = screen.getAllByRole("button", { name: "Comment actions" });
    expect(menus).toHaveLength(2);
    const [hosted, optimistic] = menus;
    fireEvent.click(optimistic);
    expect(
      await screen.findByRole("menuitem", { name: "Copy markdown" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Quote reply" })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("menuitem", { name: "Copy markdown" }),
      ).toBeNull(),
    );
    fireEvent.click(hosted);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Quote reply" }),
    );
    expect(onQuote).toHaveBeenCalledWith("hosted words");
  });
});
