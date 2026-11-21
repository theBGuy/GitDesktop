import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AboutSection } from "@/features/settings/AboutSection";
import { CliProviderConfig } from "@/features/settings/AiProviderSection";
import { type AgentInfo, detectAgentCli } from "@/lib/ai/agent";
import { createCliClient } from "@/lib/ai/cli-client";
import type { AiSettings } from "@/lib/ai/types";
import type { SystemHealth } from "@/lib/system/health";
import { invoke } from "@/lib/tauri/invoke";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/ai/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/agent")>()),
  detectAgentCli: vi.fn(),
}));
// health.ts reads system_health through this seam.
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
  getCurrentWindow: () => ({
    outerPosition: () => new Promise(() => undefined),
    outerSize: () => new Promise(() => undefined),
    onMoved: () => Promise.resolve(() => undefined),
    onResized: () => Promise.resolve(() => undefined),
  }),
  currentMonitor: () => new Promise(() => undefined),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

/** Ends with the clause the backend drops, to prove nothing is stripped here. */
const SENTENCE =
  "This opencode (3.0.0) is newer than GitDesktop supports. Update GitDesktop, then try again.";

const OPENCODE: AiSettings = {
  provider: "opencode-cli",
  model: "opencode/big-pickle",
  ollamaBaseUrl: "",
  openaiCompatibleBaseUrl: "",
};

function mount(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

function detects(info: Partial<AgentInfo>) {
  vi.mocked(detectAgentCli).mockResolvedValue({
    found: true,
    path: "/usr/bin/opencode",
    version: "3.0.0",
    authed: "authed",
    ...info,
  });
}

beforeEach(() => {
  vi.mocked(detectAgentCli).mockReset();
  vi.mocked(invoke).mockReset();
});
afterAll(() => expect(unmockedCommands).toEqual([]));

describe("Settings > AI, the detected CLI", () => {
  const renderConfig = () =>
    mount(
      <CliProviderConfig
        idPrefix="t"
        value={OPENCODE}
        onChange={() => undefined}
        description="Footer copy."
      />,
    );

  it("shows the backend's sentence verbatim under the Found line", async () => {
    detects({ unsupported: SENTENCE });
    const { container } = renderConfig();
    const found = await screen.findByText(/Found \(3\.0\.0\)/);
    const row = screen.getByText(SENTENCE).closest("p");
    expect(row?.textContent).toBe(SENTENCE);
    // Directly under the detection line, above the description.
    const order = [...container.querySelectorAll("p, div.text-xs")];
    const foundAt = order.findIndex((el) => el.contains(found));
    expect(order[foundAt + 1]).toBe(row);
    expect(order[foundAt + 2]).toHaveTextContent("Footer copy.");
  });

  it.each([
    ["null", { unsupported: null }],
    ["missing", {}],
    ["blank", { unsupported: "   " }],
    ["not found", { found: false, unsupported: SENTENCE }],
  ])("adds no row when the note is %s", async (_name, info) => {
    detects(info);
    const { container } = renderConfig();
    await screen.findByText(/Found|Not found/);
    expect(screen.queryByText(SENTENCE)).toBeNull();
    // Structural: no row at all, so a blank note can't leave an icon-only one.
    expect(container.querySelectorAll("p")).toHaveLength(1);
    const footer = screen.getByText("Footer copy.");
    expect(footer.previousElementSibling?.tagName).toBe("DIV");
  });

  // The detection line is the one child of the first `text-xs` div.
  const detectionLine = (container: HTMLElement) =>
    container.querySelector("div.text-xs")?.firstElementChild;

  it.each([
    ["authed", "authed"],
    ["not signed in", "notAuthed"],
    ["unknown auth", "unknown"],
  ] as const)(
    "reads a plain muted Found line for an unsupported binary (%s)",
    async (_name, authed) => {
      detects({ unsupported: SENTENCE, authed });
      const { container } = renderConfig();
      await screen.findByText(SENTENCE);
      const line = detectionLine(container);
      expect(line?.textContent).toBe("Found (3.0.0)");
      expect(line).toHaveClass("text-muted-foreground");
      expect(line).not.toHaveClass("text-success");
      expect(line).not.toHaveClass("text-warning");
      expect(line?.querySelector("svg")).toBeNull();
      expect(container.textContent).not.toMatch(/signed in/);
      expect(screen.queryByText("opencode auth login")).toBeNull();
    },
  );

  it("keeps the supported states as they were", async () => {
    detects({ authed: "authed" });
    const authed = renderConfig();
    await screen.findByText(/Found \(3\.0\.0\)/);
    const ok = detectionLine(authed.container);
    expect(ok?.textContent).toMatch(/^Found \(3\.0\.0\) . signed in$/);
    expect(ok).toHaveClass("text-success");
    expect(ok?.querySelector("svg")).not.toBeNull();
    authed.unmount();

    detects({ authed: "notAuthed" });
    const notAuthed = renderConfig();
    await screen.findByText("opencode auth login");
    const warn = detectionLine(notAuthed.container);
    expect(warn).toHaveClass("text-warning");
    expect(warn?.textContent).toMatch(/^Found \(3\.0\.0\) but not signed in/);
    expect(warn?.querySelector("svg")).not.toBeNull();
  });
});

describe("About, the tool rows", () => {
  const health: SystemHealth = {
    system: { os: "windows", osVersion: "10", arch: "x86_64" },
    tools: [
      {
        id: "git",
        found: true,
        path: "git",
        version: "git version 2.51.1",
        authed: "unknown",
      },
      {
        id: "opencode",
        found: true,
        path: "/usr/bin/opencode",
        version: "3.0.0",
        authed: "authed",
        unsupported: SENTENCE,
      },
    ],
  };

  it("says Not supported with the sentence, and offers no download", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) =>
      cmd === "system_health" ? health : undefined,
    );
    mount(<AboutSection />);
    const sentence = await screen.findByText(SENTENCE);
    expect(sentence.textContent).toBe(SENTENCE);
    const row = sentence.closest("li");
    if (!row) throw new Error("no opencode row");
    expect(within(row).getByText("Not supported")).toBeInTheDocument();
    expect(within(row).getByText("3.0.0")).toBeInTheDocument();
    expect(within(row).queryByRole("button")).toBeNull();
    const git = screen.getByText("Git").closest("li");
    if (!git) throw new Error("no git row");
    expect(within(git).getByText("Installed")).toBeInTheDocument();
  });

  it.each([
    ["blank", "   "],
    ["whitespace", " \t "],
  ])("a %s note is an installed row with no warning line", async (_n, note) => {
    const [git, opencode] = health.tools;
    const blank: SystemHealth = {
      ...health,
      tools: [git, { ...opencode, unsupported: note }],
    };
    vi.mocked(invoke).mockImplementation(async (cmd) =>
      cmd === "system_health" ? blank : undefined,
    );
    mount(<AboutSection />);
    const row = (await screen.findByText("3.0.0")).closest("li");
    if (!row) throw new Error("no opencode row");
    expect(within(row).getByText("Installed")).toBeInTheDocument();
    expect(within(row).queryByText("Not supported")).toBeNull();
    // The name line and the version line, no third (warning) paragraph.
    expect(row.querySelectorAll("p")).toHaveLength(2);
  });
});

describe("Settings > AI, Test connection", () => {
  const test = () => createCliClient(OPENCODE).testConnection();

  it("fails with the sentence as sent, ahead of the sign-in hint", async () => {
    detects({ authed: "notAuthed", unsupported: SENTENCE });
    expect(await test()).toStrictEqual({ ok: false, message: SENTENCE });
  });

  it.each([
    ["null", { unsupported: null }],
    ["missing", {}],
    ["whitespace", { unsupported: " \t " }],
  ])("connects when the note is %s", async (_name, info) => {
    detects(info);
    expect(await test()).toStrictEqual({ ok: true });
  });

  it("keeps the not-found message for a missing binary", async () => {
    detects({ found: false, unsupported: SENTENCE });
    const result = await test();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/CLI not found/);
    expect(result.message).not.toContain(SENTENCE);
  });
});
