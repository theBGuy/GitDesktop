import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { Markdown } from "@/components/markdown/markdown";
import type { MarkdownRefs } from "@/components/markdown/markdown-refs";
import { repoKeys } from "@/lib/git/queries";
import { lensKey } from "@/lib/repo-lens/queries";
import { useUiStore } from "@/lib/stores/ui";

const REPO = "C:/repos/demo";

beforeEach(() => {
  useUiStore.setState({
    selectedPr: null,
    pendingPrAlign: false,
    repoTab: "issues",
  });
});

/** Renders a body under `refs` with the caches a click resolves from, then
 *  clicks its one reference. */
async function clickRef(refs: MarkdownRefs, body: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(lensKey(REPO), "origin");
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
