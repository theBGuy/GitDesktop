import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PullRequestsPanel } from "@/features/pulls/PullRequestsPanel";
import {
  forgeGlMrMergeState,
  forgePrListPage,
  forgePrView,
  forgeStatus,
  gitRemotes,
} from "@/lib/git/api";
import {
  glMrMergeStateOptions,
  prDetailsOptions,
  useGlMergingWatch,
} from "@/lib/git/queries";
import type {
  ForgeImplemented,
  ForgeStatus,
  GitLabMrMergeState,
  PrDetails,
} from "@/lib/git/types";
import { listLocalPrs } from "@/lib/pulls/local";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(),
  forgePrListPage: vi.fn(),
  forgePrView: vi.fn(),
  forgeGlMrMergeState: vi.fn(),
  gitRemotes: vi.fn(),
}));
vi.mock("@/lib/pulls/local", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pulls/local")>()),
  listLocalPrs: vi.fn(),
}));

const REPO = "C:/repo";
const POLL_MS = 2_000;

const READY_GITLAB: ForgeStatus = {
  provider: "gitlab",
  installed: true,
  authenticated: true,
  repo: "owner/repo",
  host: "gitlab.com",
  login: "me",
  capabilities: {
    pullRequests: true,
    draftPrs: true,
    issues: true,
    labels: true,
    milestones: true,
    reactions: true,
    discussions: true,
    stars: true,
    ci: true,
    webhooks: true,
    approvals: true,
    securityFindings: true,
  },
  implemented: { pullRequests: true } as ForgeImplemented,
};

const LOCKED: GitLabMrMergeState = {
  autoMergeEnabled: false,
  detailedMergeStatus: "",
  pipelineStatus: "",
  pipelineUrl: "",
  locked: true,
  state: "MERGING",
};

/** The detail view's own details read, mounted beside the panel. */
function DetailsWatcher() {
  useQuery(prDetailsOptions(REPO, 7, "origin"));
  return null;
}

/** The view's MERGING watch on the same client, gate held open. */
function Watch() {
  useGlMergingWatch(REPO, 7);
  return null;
}

beforeEach(() => {
  // Only intervals are faked (both polls ride them); React Query's timeouts
  // and the waits below run on real time.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  vi.clearAllMocks();
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(forgeStatus).mockResolvedValue(READY_GITLAB);
  vi.mocked(gitRemotes).mockResolvedValue(["origin"]);
  vi.mocked(forgePrListPage).mockResolvedValue({ rows: [], capped: false });
  vi.mocked(listLocalPrs).mockResolvedValue([]);
  vi.mocked(forgePrView).mockImplementation(
    async (_repo, n) => ({ number: n, state: "MERGING" }) as PrDetails,
  );
  vi.mocked(forgeGlMrMergeState).mockImplementation(async () => LOCKED);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useUiStore.setState({ selectedPr: null, pendingPrAlign: false });
});

async function ticks(n = 10) {
  for (let i = 0; i < n; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await ticks(1);
  }
  throw new Error(`timed out waiting for ${what}`);
}

type Run = {
  armReads: number[];
  disarmedAt: number;
  probeOffWhileArmed: boolean;
  watchReads: number;
};

/** Arms the align on #7 (details MERGING, probe locked) and walks the poll,
 *  recording the arm keys' reads per step and the step the align disarmed on.
 *  The watch mounts half a poll after the align's first read, so its reads land
 *  between the align's, where a prefix sweep would add an arm read. */
async function run(withWatch: boolean): Promise<Run> {
  useUiStore.setState({
    repoPath: REPO,
    repoTab: "pulls",
    selectedPr: { kind: "remote", id: "7" },
    pendingPrAlign: true,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  vi.mocked(forgeGlMrMergeState).mockClear();
  const viewKey = glMrMergeStateOptions(REPO, 7).queryKey;
  // Every probe call is the align's unless the watch's own entry started it: a
  // read cancelled and restarted under one fetch counts at the wire, not here.
  const counts = {
    get arm() {
      return vi.mocked(forgeGlMrMergeState).mock.calls.length - this.watch;
    },
    watch: 0,
  };
  let probeOffWhileArmed = false;
  const unsubscribe = client.getQueryCache().subscribe((e) => {
    if (e.type !== "updated" || e.action.type !== "fetch") return;
    if (e.query.queryHash === JSON.stringify(viewKey)) counts.watch += 1;
  });
  const armQueries = () =>
    client
      .getQueryCache()
      .findAll({ queryKey: viewKey })
      .filter((q) => q.queryKey.includes("align"));
  const ui = (watch: boolean) => (
    <QueryClientProvider client={client}>
      <PullRequestsPanel repoPath={REPO} />
      <DetailsWatcher />
      {watch ? <Watch /> : null}
    </QueryClientProvider>
  );
  const view = render(ui(false));
  await until(() => counts.arm === 1, "the first align read");
  await act(async () => {
    vi.advanceTimersByTime(POLL_MS / 2);
  });
  await ticks();
  if (withWatch) view.rerender(ui(true));
  await ticks();
  const armReads = [counts.arm];
  let disarmedAt = -1;
  for (let step = 1; step <= 8; step++) {
    await ticks();
    if (useUiStore.getState().pendingPrAlign) {
      if (!armQueries().some((q) => q.isActive())) probeOffWhileArmed = true;
    } else if (disarmedAt < 0) disarmedAt = step;
    for (let half = 0; half < 2; half++) {
      await act(async () => {
        vi.advanceTimersByTime(POLL_MS / 2);
      });
      await ticks();
    }
    armReads.push(counts.arm);
  }
  unsubscribe();
  const watchReads = counts.watch;
  cleanup();
  client.clear();
  return { armReads, disarmedAt, probeOffWhileArmed, watchReads };
}

describe("the MERGING watch beside an armed align (AC15)", () => {
  it("leaves the align's reads and disarm point as they are without it", async () => {
    const control = await run(false);
    const watched = await run(true);
    expect(control.armReads.at(-1)).toBe(6);
    expect(control.disarmedAt).toBeGreaterThan(0);
    expect(control.watchReads).toBe(0);
    expect(watched.watchReads).toBeGreaterThan(1);
    expect(watched.armReads).toEqual(control.armReads);
    expect(watched.disarmedAt).toBe(control.disarmedAt);
    expect(watched.probeOffWhileArmed).toBe(false);
    expect(control.probeOffWhileArmed).toBe(false);
  }, 30_000);
});
