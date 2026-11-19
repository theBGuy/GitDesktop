import {
  hashKey,
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { AboutSection } from "@/features/settings/AboutSection";
import { ATTACHMENT_GATE_COPY } from "@/lib/attachments/support-gate";
import { useAttachmentSupport } from "@/lib/attachments/use-attachment-support";
import {
  holdLens,
  releaseLens,
  shiftChasedLenses,
} from "@/lib/git/queries/board-writes";
import type { ForgeStatus } from "@/lib/git/types/forge";
import { useResolvedInterpreter } from "@/lib/scripts/interpreters";
import {
  recheckSystemHealth,
  type SystemHealth,
  useSystemHealth,
} from "@/lib/system/health";
import { invoke } from "@/lib/tauri/invoke";
import { unmockedCommands } from "./setup";

// health.ts calls this seam itself, so About's reads and the attachment gate's
// meet at the same mock.
vi.mock("@/lib/tauri/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri/invoke")>()),
  invoke: vi.fn(),
}));

// AboutSection imports these Tauri modules directly, past the test transport.
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(() => Promise.resolve("0.0.0")),
  getTauriVersion: vi.fn(() => Promise.resolve("2.0.0")),
}));
vi.mock("@tauri-apps/api/window", () => ({
  // Geometry never answers: the window rows stay "…", which these tests ignore.
  getCurrentWindow: () => ({
    outerPosition: () => new Promise(() => undefined),
    outerSize: () => new Promise(() => undefined),
    onMoved: () => Promise.resolve(() => undefined),
    onResized: () => Promise.resolve(() => undefined),
  }),
  currentMonitor: () => new Promise(() => undefined),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const forge = { provider: "github", host: "github.com" } as ForgeStatus;
const health = (found: boolean): SystemHealth => ({
  system: { os: "windows", osVersion: "10", arch: "x86_64" },
  tools: [
    {
      id: "gh",
      found,
      path: found ? "gh" : null,
      version: found ? "gh version 2.103.3 (2026-10-26)" : null,
      authed: "unknown",
    },
  ],
});

// A read left pending is answered after its test, so no fetch outlives it.
let settlePending: (() => void) | null = null;

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});
afterEach(() => {
  settlePending?.();
  settlePending = null;
});
afterAll(() => expect(unmockedCommands).toEqual([]));

let healthData: SystemHealth | undefined;
function HealthReader() {
  healthData = useSystemHealth().data;
  return null;
}

// The gate's own verdict: its reason while closed, "open" once attaching is allowed.
function Gate() {
  const reason = useAttachmentSupport({ forge, access: null, enabled: true });
  return <p data-testid="attachment-gate">{reason ?? "open"}</p>;
}
const gateVerdict = () => screen.getByTestId("attachment-gate").textContent;

function mount(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return client;
}

const calls = () => vi.mocked(invoke).mock.calls;
const recheckButton = () => screen.getByRole("button", { name: /Re-check/ });

describe("About > Re-check", () => {
  it("loads plainly, and only the Re-check asks for a fresh probe", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(health(false));
    const client = mount(<AboutSection />);
    expect(await screen.findByText("Not found")).toBeInTheDocument();
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toStrictEqual(["system_health"]);

    let answer: (value: unknown) => void = () => undefined;
    vi.mocked(invoke).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    settlePending = () => answer(health(true));
    await userEvent.setup().click(recheckButton());
    expect(calls()).toHaveLength(2);
    expect(calls()[1]).toStrictEqual(["system_health", { fresh: true }]);
    await vi.waitFor(() => expect(recheckButton()).toBeDisabled());

    answer(health(true));
    expect(await screen.findByText("Installed")).toBeInTheDocument();
    await vi.waitFor(() => expect(recheckButton()).toBeEnabled());

    // One-shot: the next refetch of the same entry is plain again.
    vi.mocked(invoke).mockResolvedValueOnce(health(true));
    await client.refetchQueries({ queryKey: ["system-health"] });
    expect(calls()).toHaveLength(3);
    expect(calls()[2]).toStrictEqual(["system_health"]);
  });

  it("refreshes the entry the attachment gate shares, with one call", async () => {
    vi.mocked(invoke).mockResolvedValue(health(false));
    const client = mount(
      <>
        <AboutSection />
        <Gate />
        <HealthReader />
      </>,
    );
    expect(await screen.findByText("Not found")).toBeInTheDocument();
    expect(calls()).toHaveLength(1);
    // A missing gh has no version, so the gate reads it as unreadable.
    await vi.waitFor(() =>
      expect(gateVerdict()).toBe(ATTACHMENT_GATE_COPY.ghUnreadable),
    );

    vi.mocked(invoke).mockResolvedValue(health(true));
    await userEvent.setup().click(recheckButton());
    expect(await screen.findByText("Installed")).toBeInTheDocument();
    expect(calls()).toHaveLength(2);
    expect(calls()[1]).toStrictEqual(["system_health", { fresh: true }]);
    await vi.waitFor(() => expect(healthData?.tools[0]?.found).toBe(true));
    expect(client.getQueryData(["system-health"])).toBe(healthData);
    await vi.waitFor(() => expect(gateVerdict()).toBe("open"));
  });

  it("leaves no flag behind when the refetch starts no fetch", async () => {
    const refetch = vi.fn();
    recheckSystemHealth({ refetch });
    expect(refetch).toHaveBeenCalledTimes(1);

    vi.mocked(invoke).mockResolvedValue(health(false));
    mount(<HealthReader />);
    await vi.waitFor(() => expect(calls()).toHaveLength(1));
    expect(calls()[0]).toStrictEqual(["system_health"]);
  });

  it("leaves no flag behind when the refetch throws", async () => {
    const refetch = vi.fn(() => {
      throw new Error("refetch failed");
    });
    expect(() => recheckSystemHealth({ refetch })).toThrow("refetch failed");

    vi.mocked(invoke).mockResolvedValue(health(false));
    mount(<HealthReader />);
    await vi.waitFor(() => expect(calls()).toHaveLength(1));
    expect(calls()[0]).toStrictEqual(["system_health"]);
  });
});

const NODE_PATH = "/usr/local/bin/node";

// A 5-minute read elsewhere in the app: only an invalidation refetches it here.
function InterpreterReader() {
  const { data } = useResolvedInterpreter("node", true);
  return <p data-testid="interpreter">{data ?? "none"}</p>;
}
const interpreterShown = () => screen.getByTestId("interpreter").textContent;
const callsOf = (cmd: string) => calls().filter(([c]) => c === cmd).length;

/** Routes `invoke` by command: plain health loads answer "missing", the fresh
 *  one waits for the returned settle, and the interpreter resolves null first
 *  and a path afterwards. */
function routeInvoke() {
  let settleFresh: { resolve: () => void; reject: () => void } | null = null;
  vi.mocked(invoke).mockImplementation((cmd, args) => {
    if (cmd === "system_health" && args?.fresh) {
      return new Promise((resolve, reject) => {
        settleFresh = {
          resolve: () => resolve(health(true)),
          reject: () => reject(new Error("probe failed")),
        };
        settlePending = settleFresh.resolve;
      });
    }
    if (cmd === "system_health") return Promise.resolve(health(false));
    if (cmd === "resolve_task_interpreter") {
      return Promise.resolve(
        callsOf("resolve_task_interpreter") === 1 ? null : NODE_PATH,
      );
    }
    return Promise.reject(new Error(`unrouted command ${cmd}`));
  });
  return {
    fresh: () => {
      if (!settleFresh) throw new Error("no fresh call is pending");
      return settleFresh;
    },
  };
}

async function mountWithInterpreter() {
  const client = mount(
    <>
      <AboutSection />
      <InterpreterReader />
    </>,
  );
  expect(await screen.findByText("Not found")).toBeInTheDocument();
  await vi.waitFor(() => expect(interpreterShown()).toBe("none"));
  expect(callsOf("resolve_task_interpreter")).toBe(1);
  return client;
}

describe("About > Re-check refreshes the rest of the app", () => {
  it("refetches other queries once the fresh check answered, not itself", async () => {
    const route = routeInvoke();
    await mountWithInterpreter();

    await userEvent.setup().click(recheckButton());
    await vi.waitFor(() => expect(recheckButton()).toBeDisabled());
    // The backend hasn't answered, so it may still hold its misses.
    expect(callsOf("resolve_task_interpreter")).toBe(1);

    route.fresh().resolve();
    await vi.waitFor(() => expect(callsOf("resolve_task_interpreter")).toBe(2));
    await vi.waitFor(() => expect(interpreterShown()).toBe(NODE_PATH));

    await vi.waitFor(() => expect(recheckButton()).toBeEnabled());
    expect(callsOf("system_health")).toBe(2);
    expect(screen.getByText("Installed")).toBeInTheDocument();
  });

  it("refreshes nothing else on a plain health refetch", async () => {
    routeInvoke();
    const client = await mountWithInterpreter();

    await client.refetchQueries({ queryKey: ["system-health"] });
    expect(callsOf("system_health")).toBe(2);
    expect(calls().at(-1)).toStrictEqual(["system_health"]);
    expect(callsOf("resolve_task_interpreter")).toBe(1);
    // Nor marks it stale, which would cost a lookup on its next mount.
    expect(
      client.getQueryState(["resolve-interpreter", "node"])?.isInvalidated,
    ).toBe(false);
  });

  it("still refreshes after a fresh check that fails, keeping the list", async () => {
    const route = routeInvoke();
    await mountWithInterpreter();

    await userEvent.setup().click(recheckButton());
    await vi.waitFor(() => expect(recheckButton()).toBeDisabled());
    route.fresh().reject();

    await vi.waitFor(() => expect(callsOf("resolve_task_interpreter")).toBe(2));
    await vi.waitFor(() => expect(recheckButton()).toBeEnabled());
    expect(screen.getByText("Not found")).toBeInTheDocument();
    expect(callsOf("system_health")).toBe(2);
  });

  it("skips a board lens a date-shift chase holds, reading the hold live", async () => {
    const LENS_KEY = ["held-lens-probe"] as const;
    const lensHash = hashKey(LENS_KEY);
    const readLens = vi.fn(() => Promise.resolve("lens"));
    function LensReader() {
      useQuery({
        queryKey: LENS_KEY,
        queryFn: readLens,
        staleTime: Number.POSITIVE_INFINITY,
        networkMode: "always",
      });
      return null;
    }

    const route = routeInvoke();
    const client = mount(
      <>
        <AboutSection />
        <InterpreterReader />
        <LensReader />
      </>,
    );
    expect(await screen.findByText("Not found")).toBeInTheDocument();
    await vi.waitFor(() => expect(interpreterShown()).toBe("none"));
    await vi.waitFor(() => expect(readLens).toHaveBeenCalledTimes(1));

    // Each half changes the hold while the fresh call is pending: the hold that
    // counts is the one in place when the invalidation runs, not at the click.
    let held = false;
    try {
      const user = userEvent.setup();
      await user.click(recheckButton());
      await vi.waitFor(() => expect(recheckButton()).toBeDisabled());
      holdLens(shiftChasedLenses, lensHash);
      held = true;
      route.fresh().resolve();
      await vi.waitFor(() =>
        expect(callsOf("resolve_task_interpreter")).toBe(2),
      );
      await vi.waitFor(() => expect(recheckButton()).toBeEnabled());
      expect(readLens).toHaveBeenCalledTimes(1);
      expect(client.getQueryState(LENS_KEY)?.isInvalidated).toBe(false);

      await user.click(recheckButton());
      await vi.waitFor(() => expect(recheckButton()).toBeDisabled());
      releaseLens(shiftChasedLenses, lensHash);
      held = false;
      route.fresh().resolve();
      await vi.waitFor(() => expect(readLens).toHaveBeenCalledTimes(2));
      await vi.waitFor(() =>
        expect(callsOf("resolve_task_interpreter")).toBe(3),
      );
    } finally {
      if (held) releaseLens(shiftChasedLenses, lensHash);
    }
    expect(shiftChasedLenses.size).toBe(0);
  });
});
