import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { MyWorkScreen } from "@/features/mywork/MyWorkScreen";
import type { ForgeProvider, MyWorkItem } from "@/lib/git/types";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

const data = vi.hoisted(() => ({
  provider: "gitlab" as ForgeProvider,
  items: [] as MyWorkItem[],
}));

const answered = (items: MyWorkItem[] | undefined) => ({
  data: items === undefined ? undefined : { items, truncated: false },
  isPending: items === undefined,
  isSuccess: items !== undefined,
  isError: false,
  isPaused: false,
  isFetching: false,
  isPlaceholderData: false,
  error: null,
  refetch: vi.fn(),
});

vi.mock("@/lib/git/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/queries")>()),
  useMyWorkSources: () => ({
    data: {
      github: data.provider === "github",
      gitlab: data.provider === "gitlab",
      bitbucket: false,
    },
    isPending: false,
    isSuccess: true,
    isError: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  }),
  useForgeMyWork: (provider: string) =>
    answered(provider === data.provider ? data.items : undefined),
}));
vi.mock("@/lib/settings/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/queries")>()),
  useSettings: () => ({ data: { recentRepos: [] } }),
}));

const HOSTS: Record<ForgeProvider, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
};

const item = (
  provider: ForgeProvider,
  number: number,
  isPullRequest: boolean,
): MyWorkItem => ({
  number,
  title: `${isPullRequest ? "request" : "issue"} ${number}`,
  isPullRequest,
  isDraft: false,
  repoFullName: "acme/app",
  repoOwner: "acme",
  repoName: "app",
  host: HOSTS[provider],
  url: `https://${HOSTS[provider]}/acme/app/${isPullRequest ? "pr" : "issue"}/${number}`,
  updatedAt: `2026-01-0${number}T00:00:00Z`,
  provider,
});

/** The number cell of a row: the row's first tabular-nums span. */
const numberOf = (it: MyWorkItem) => {
  const row = document.querySelector(`[data-my-work-url="${it.url}"]`);
  if (!(row instanceof HTMLElement)) throw new Error(`no row for ${it.url}`);
  return row.querySelector(".tabular-nums")?.textContent;
};

afterEach(cleanup);
afterAll(() => expect(unmockedCommands).toEqual([]));

// jsdom lays nothing out, so the virtualized list paints no row without a
// client size to size its viewport from.
describe("My work numbers a request by its forge's sigil and an issue with #", () => {
  const CLIENT_SIZE = { clientWidth: 800, clientHeight: 600 } as const;
  beforeAll(() => {
    for (const [k, v] of Object.entries(CLIENT_SIZE)) {
      Object.defineProperty(HTMLElement.prototype, k, {
        configurable: true,
        get: () => v,
      });
    }
  });
  afterAll(() => {
    for (const k of Object.keys(CLIENT_SIZE)) {
      Reflect.deleteProperty(HTMLElement.prototype, k);
    }
  });

  it.each<[ForgeProvider, string]>([
    ["gitlab", "!2"],
    ["github", "#2"],
  ])("%s: the request reads %s, the issue #1", (provider, requestNumber) => {
    const issue = item(provider, 1, false);
    const request = item(provider, 2, true);
    data.provider = provider;
    data.items = [request, issue];
    useUiStore.setState({ view: "mywork" });
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MyWorkScreen />
      </QueryClientProvider>,
    );
    expect(numberOf(request)).toBe(requestNumber);
    expect(numberOf(issue)).toBe("#1");
  });
});
