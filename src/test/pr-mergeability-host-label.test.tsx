import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  type PrMergeabilityArm,
  PrMergeabilityBanner,
} from "@/features/pulls/PrMergeabilityBanner";
import { getSecret } from "@/lib/git/api";
import { type ForgeProvider, shownProvider } from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { unmockedCommands } from "./setup";

// The api modules are the seam: the banner's only hooks read settings and the
// review provider's stored key.
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  getSecret: vi.fn(),
}));

const noop = vi.fn();

function renderBanner(
  arm: PrMergeabilityArm,
  provider: ForgeProvider | null | undefined,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PrMergeabilityBanner
        arm={arm}
        base="main"
        head="feature"
        promotionKind={null}
        provider={provider}
        forkBlocked={false}
        hasResolveWorktree={false}
        busy={false}
        resolveHeldReason={undefined}
        conflictFiles={[]}
        predictedClean={false}
        forgeUnreachable={true}
        behindBy={0}
        blockedRequirements={[]}
        blockedApprovals={null}
        blockedReason={null}
        pendingOffline={false}
        updateBlockedReason={undefined}
        updateHeldReason={undefined}
        updateBusy={false}
        updateAwaitingDefault={false}
        updateAwaitingRules={false}
        updateSubmitting={false}
        onResolve={noop}
        onResolveWithAi={noop}
        onDiscard={noop}
        onRetry={noop}
        onUpdateBranch={noop}
        onUpdateWithRebase={noop}
        retryBusy={false}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(loadSettings).mockImplementation(async () => DEFAULT_SETTINGS);
  vi.mocked(getSecret).mockImplementation(async () => null);
});

// The hooks' settings and key reads land after the first paint.
afterEach(async () => {
  await waitFor(() => {
    expect(loadSettings).toHaveBeenCalled();
    expect(getSecret).toHaveBeenCalled();
  });
  vi.clearAllMocks();
});

afterAll(() => expect(unmockedCommands).toEqual([]));

describe("PrMergeabilityBanner host naming", () => {
  it.each([
    ["pending, saved GitLab", shownProvider(undefined, "gitlab"), "GitLab"],
    ["pending, nothing saved", shownProvider(undefined, undefined), "the host"],
    [
      "settled GitLab",
      shownProvider({ provider: "gitlab" }, undefined),
      "GitLab",
    ],
    // Settled null is the gh-routed default, whatever was saved.
    ["settled null", shownProvider({ provider: null }, "gitlab"), "GitHub"],
  ])("unreachable names the host (%s)", (_case, provider, host) => {
    renderBanner("unreachable", provider);
    expect(
      screen.getByText(`Couldn't reach ${host} to check mergeability.`, {
        exact: false,
      }),
    ).toBeInTheDocument();
  });

  it("updating leads with the host when nothing names it", () => {
    renderBanner("updating", shownProvider(undefined, undefined));
    expect(
      screen.getByText("The host is updating this branch from", {
        exact: false,
      }),
    ).toBeInTheDocument();
  });

  it("updating keeps the settled provider's name", () => {
    renderBanner("updating", shownProvider({ provider: "github" }, "gitlab"));
    expect(
      screen.getByText("GitHub is updating this branch from", { exact: false }),
    ).toBeInTheDocument();
  });
});
