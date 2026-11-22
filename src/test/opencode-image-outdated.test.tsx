import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSandboxField } from "@/features/settings/AgentSandboxField";
import {
  type ContainerStatus,
  detectContainerSandbox,
  OPENCODE_IMAGE_OUTDATED_DETAIL,
} from "@/lib/ai/sandbox";
import { IMAGE_AGENT_IDS, NODE_VERSIONS } from "@/lib/settings/api";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/ai/sandbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/sandbox")>()),
  detectContainerSandbox: vi.fn(),
}));

type AgentId = (typeof IMAGE_AGENT_IDS)[number];

const GENERIC = /doesn't match this Node version \/ agent selection/;

const status = (extra: Partial<ContainerStatus>): ContainerStatus => ({
  runtime: "docker",
  ready: true,
  imagePresent: true,
  imageMatches: true,
  opencodeOutdated: false,
  ...extra,
});

function mount(providers: AgentId[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AgentSandboxField
        value="container"
        onChange={() => undefined}
        nodeVersion={NODE_VERSIONS[0]}
        onNodeVersion={() => undefined}
        providers={providers}
        onProviders={() => undefined}
        repoPath={null}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.mocked(detectContainerSandbox).mockReset());
afterAll(() => expect(unmockedCommands).toEqual([]));

describe("Settings > AI, the agent image row", () => {
  it("names the older opencode, with a Rebuild, when opencode is selected", async () => {
    vi.mocked(detectContainerSandbox).mockResolvedValue(
      status({ imageMatches: false, opencodeOutdated: true }),
    );
    mount(["claude", "opencode"]);
    const row = await screen.findByText(OPENCODE_IMAGE_OUTDATED_DETAIL);
    expect(row.textContent).toContain("about 1 GB");
    expect(row.closest("p")?.querySelector("button")?.textContent?.trim()).toBe(
      "Rebuild",
    );
    expect(screen.queryByText(GENERIC)).toBeNull();
  });

  it("keeps the generic row when opencode isn't among the image agents", async () => {
    vi.mocked(detectContainerSandbox).mockResolvedValue(
      status({ imageMatches: false, opencodeOutdated: true }),
    );
    mount(["claude"]);
    expect(await screen.findByText(GENERIC)).toBeInTheDocument();
    expect(screen.queryByText(OPENCODE_IMAGE_OUTDATED_DETAIL)).toBeNull();
  });

  it("keeps the generic row when only the selection changed", async () => {
    vi.mocked(detectContainerSandbox).mockResolvedValue(
      status({ imageMatches: false, opencodeOutdated: false }),
    );
    mount(["claude", "opencode"]);
    expect(await screen.findByText(GENERIC)).toBeInTheDocument();
    expect(screen.queryByText(OPENCODE_IMAGE_OUTDATED_DETAIL)).toBeNull();
  });
});
