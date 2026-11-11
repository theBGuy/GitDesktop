import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { useAttachmentSupport } from "@/lib/attachments/use-attachment-support";
import type { ForgeStatus } from "@/lib/git/types/forge";
import { type SystemHealth, useSystemHealth } from "@/lib/system/health";
import { invoke } from "@/lib/tauri/invoke";
import { unmockedCommands } from "./setup";

// health.ts calls this seam itself, so the gate's observer and
// useSystemHealth() meet at the same mock.
vi.mock("@/lib/tauri/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri/invoke")>()),
  invoke: vi.fn(),
}));

const forge = { provider: "github", host: "github.com" } as ForgeStatus;
const health = (gh: string): SystemHealth => ({
  system: { os: "windows", osVersion: "10", arch: "x86_64" },
  tools: [
    { id: "gh", found: true, path: "gh", version: gh, authed: "unknown" },
  ],
});

// A read left pending is answered after its test, so no fetch outlives it.
let settlePending: (() => void) | null = null;

// A block body: a hook that returns a function gets it called as teardown.
beforeEach(() => {
  vi.mocked(invoke).mockReset();
});
afterEach(() => {
  settlePending?.();
  settlePending = null;
});
afterAll(() => expect(unmockedCommands).toEqual([]));

function Gate({ enabled, both }: { enabled: boolean; both?: boolean }) {
  const reason = useAttachmentSupport({ forge, access: null, enabled });
  return (
    <>
      <output data-testid="reason">{reason ?? "open"}</output>
      {both && <HealthReader />}
    </>
  );
}

let healthData: SystemHealth | undefined;
function HealthReader() {
  healthData = useSystemHealth().data;
  return null;
}

function mount(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return client;
}

describe("useAttachmentSupport (T19)", () => {
  it("issues no system_health call while disabled", () => {
    mount(<Gate enabled={false} />);
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.getByTestId("reason")).toHaveTextContent("open");
  });

  it("leaves the gate open while the health read is pending", async () => {
    let answer: (value: unknown) => void = () => undefined;
    vi.mocked(invoke).mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    settlePending = () => answer(health("gh version 2.98.9"));
    const client = mount(<Gate enabled />);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(client.getQueryState(["system-health"])?.status).toBe("pending");
    expect(screen.getByTestId("reason")).toHaveTextContent("open");
  });

  it("leaves the gate open when the health read fails", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("probe failed"));
    const client = mount(<Gate enabled />);
    await vi.waitFor(() =>
      expect(client.getQueryState(["system-health"])?.status).toBe("error"),
    );
    expect(screen.getByTestId("reason")).toHaveTextContent("open");
  });

  it("closes on a loaded version below the floor", async () => {
    vi.mocked(invoke).mockResolvedValue(
      health("gh version 2.98.9 (2026-01-01)"),
    );
    mount(<Gate enabled />);
    expect(await screen.findByText(/you have 2\.98\.9/)).toHaveTextContent(
      "Attaching images needs GitHub CLI 2.99 or newer (you have 2.98.9).",
    );
  });

  it("shares one call and one object with useSystemHealth()", async () => {
    const answer = health("gh version 2.103.3 (2026-10-26)");
    vi.mocked(invoke).mockResolvedValue(answer);
    const client = mount(<Gate enabled both />);
    await vi.waitFor(() => expect(healthData).toBeDefined());
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invoke).mock.calls[0][0]).toBe("system_health");
    expect(client.getQueryData(["system-health"])).toBe(healthData);
    expect(screen.getByTestId("reason")).toHaveTextContent("open");
  });
});
