import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import type { ForgeStatus } from "@/lib/git/types/forge";
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
