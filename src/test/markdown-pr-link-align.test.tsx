import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "@/components/markdown/markdown";
import type { MarkdownRefs } from "@/components/markdown/markdown-refs";
import { forgeIssueView } from "@/lib/git/api";
import { remotesOptions, repoKeys } from "@/lib/git/queries";
import type { RemoteLens } from "@/lib/git/types";
import { lensKey } from "@/lib/repo-lens/queries";
import { useUiStore } from "@/lib/stores/ui";

// The uncached `#N` lookup's one IPC seam.
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeIssueView: vi.fn(),
}));

const REPO = "C:/repos/demo";

beforeEach(() => {
  useUiStore.setState({
    repoPath: REPO,
    selectedPr: null,
    selectedIssue: null,
    pendingPrAlign: false,
    repoTab: "issues",
  });
});

/** Seeds a GitHub fork whose effective lens follows the stored one. */
function seedFork(client: QueryClient, lens: RemoteLens) {
  client.setQueryData(["repo", REPO, "forge-status"], {
    provider: "github",
    authenticated: true,
  });
  client.setQueryData(remotesOptions(REPO).queryKey, ["origin", "upstream"]);
  client.setQueryData(lensKey(REPO), lens);
}

/** Renders a body under `refs` with the caches a click resolves from, then
 *  clicks its one reference. `seed` adds caches after the defaults. */
async function clickRef(
  refs: MarkdownRefs,
  body: string,
  seed?: (client: QueryClient) => void,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(lensKey(REPO), "origin");
  seed?.(client);
  // A merged list page holds the number, so `#N` resolves to a PR from cache.
  client.setQueryData(
    [...repoKeys.prList(REPO), "origin", "merged"],
    [{ number: 618 }],
  );
  const view = render(
    <QueryClientProvider client={client}>
      <Markdown refs={refs}>{body}</Markdown>
    </QueryClientProvider>,
  );
  const anchor = view.container.querySelector<HTMLAnchorElement>("a[data-ref]");
  if (!anchor) throw new Error("no reference rendered");
  await act(async () => {
    fireEvent.click(anchor);
  });
  return { client, unmount: view.unmount };
}

function expectAlignedPr(id: string) {
  const s = useUiStore.getState();
  expect(s.selectedPr).toEqual({ kind: "remote", id });
  expect(s.pendingPrAlign).toBe(true);
  expect(s.repoTab).toBe("pulls");
}

describe("a PR link in a markdown body", () => {
  it("opens a GitHub #N that resolves to a PR with the list's tab align armed", async () => {
    await clickRef(
      { provider: "github", repoPath: REPO, lens: "origin" },
      "Fixed by #618.",
    );
    expectAlignedPr("618");
  });

  it("opens a GitLab !N merge request with the list's tab align armed", async () => {
    await clickRef(
      { provider: "gitlab", repoPath: REPO, lens: "origin" },
      "Fixed by !42.",
    );
    expectAlignedPr("42");
  });
});

describe("an uncached #N in a markdown body", () => {
  /** Clicks an uncached `#700` under `lens` whose lookup settles when
   *  `resolve` runs. */
  async function clickDeferred(
    lens: RemoteLens = "origin",
    seed?: (client: QueryClient) => void,
  ) {
    let resolve!: () => void;
    vi.mocked(forgeIssueView).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = () =>
            done({
              url: "https://github.com/o/r/pull/700",
            } as Awaited<ReturnType<typeof forgeIssueView>>);
        }),
    );
    const { client, unmount } = await clickRef(
      { provider: "github", repoPath: REPO, lens },
      "See #700.",
      seed,
    );
    expect(forgeIssueView).toHaveBeenCalledWith(REPO, 700, lens);
    // The settle, carrying the client the click resolved through and the
    // body's unmount.
    return Object.assign(
      async () => {
        await act(async () => resolve());
      },
      { client, unmount },
    );
  }

  function expectUntouched() {
    const s = useUiStore.getState();
    expect(s.selectedPr).toBeNull();
    expect(s.selectedIssue).toBeNull();
    expect(s.pendingPrAlign).toBe(false);
    expect(s.repoTab).toBe("issues");
  }

  it("opens the PR it resolves to, with the tab align armed", async () => {
    const settle = await clickDeferred();
    await settle();
    expectAlignedPr("700");
  });

  it("navigates nowhere when a navigation landed during the lookup", async () => {
    const settle = await clickDeferred();
    useUiStore.setState((s) => ({ interactionEpoch: s.interactionEpoch + 1 }));
    await settle();
    expectUntouched();
  });

  it("navigates nowhere when the active lens changed during the lookup", async () => {
    const settle = await clickDeferred("origin", (c) => seedFork(c, "origin"));
    settle.client.setQueryData(lensKey(REPO), "upstream");
    await settle();
    expectUntouched();
  });

  it("navigates nowhere when the upstream remote went away during the lookup", async () => {
    const settle = await clickDeferred("upstream", (c) =>
      seedFork(c, "upstream"),
    );
    // The stored lens still reads "upstream"; only the gate closed.
    settle.client.setQueryData(remotesOptions(REPO).queryKey, ["origin"]);
    await settle();
    expectUntouched();
  });

  /** Clicks uncached `#700`, then `#701`; each lookup waits for its settle. */
  async function clickTwo() {
    const pending = new Map<number, () => void>();
    vi.mocked(forgeIssueView).mockImplementation(
      (_repo, number) =>
        new Promise((done) => {
          pending.set(number, () =>
            done({
              url: `https://github.com/o/r/pull/${number}`,
            } as Awaited<ReturnType<typeof forgeIssueView>>),
          );
        }),
    );
    const refs = {
      provider: "github",
      repoPath: REPO,
      lens: "origin",
    } as const;
    await clickRef(refs, "See #700.");
    await clickRef(refs, "See #701.");
    expect([...pending.keys()]).toEqual([700, 701]);
    return (n: number) => act(async () => pending.get(n)?.());
  }

  it("lands on the newer of two pending clicks when the older resolves first", async () => {
    const settle = await clickTwo();
    await settle(700);
    expectUntouched();
    await settle(701);
    expectAlignedPr("701");
  });

  it("ignores the older click's late settle after the newer one landed", async () => {
    const settle = await clickTwo();
    await settle(701);
    expectAlignedPr("701");
    await settle(700);
    expectAlignedPr("701");
  });

  it("navigates nowhere when the body unmounted during the lookup", async () => {
    const settle = await clickDeferred();
    // A commit drill-in's Back, say: no navigation, so the epoch stays put.
    settle.unmount();
    await settle();
    expectUntouched();
  });

  it("navigates nowhere when the repo changed during the lookup", async () => {
    const settle = await clickDeferred();
    useUiStore.setState({ repoPath: "C:/repos/other" });
    await settle();
    expectUntouched();
  });
});
