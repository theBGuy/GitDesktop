import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GeneralSettingsSection } from "@/features/repo-settings/GeneralSettingsSection";
import { GitLabGeneralSection } from "@/features/repo-settings/GitLabGeneralSection";
import { settingsDirty } from "@/features/repo-settings/settings-dirty";
import {
  forgeGlRepoSettings,
  forgeGlRepoSettingsUpdate,
  ghRepoSettingsGet,
  ghRepoSettingsUpdate,
} from "@/lib/git/api";
import type { GitLabRepoSettings, RepoSettings } from "@/lib/git/types";
import { NO_CHANGES_REASON } from "@/lib/offline-writes";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
// The forms' side reads never answer; only the settings read and save are driven.
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(() => new Promise(() => undefined)),
  gitBranches: vi.fn(() => new Promise(() => undefined)),
  ghTokenScopes: vi.fn(() => new Promise(() => undefined)),
  getSecret: vi.fn(async () => null),
  forgeGlRepoSettings: vi.fn(),
  forgeGlRepoSettingsUpdate: vi.fn(),
  ghRepoSettingsGet: vi.fn(),
  ghRepoSettingsUpdate: vi.fn(),
}));
vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("sonner")>()),
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}));

const base = { description: "d", topics: ["alpha", "zeta"], wiki: true };

describe("settingsDirty", () => {
  it("reads topics the forge answered in another order as saved", () => {
    expect(settingsDirty({ ...base, topics: ["zeta", "alpha"] }, base)).toBe(
      false,
    );
    expect(settingsDirty(base, base)).toBe(false);
  });

  it("reads a topic that differs only in letter case, or a repeat, as saved", () => {
    for (const topics of [
      ["ALPHA", "zeta"],
      ["alpha", "zeta", "Alpha"],
      ["zeta", "alpha", "alpha"],
    ])
      expect(settingsDirty({ ...base, topics }, base)).toBe(false);
  });

  it("reads an added, removed or emptied topic as a change", () => {
    for (const topics of [["alpha", "zeta", "beta"], ["alpha"], []])
      expect(settingsDirty({ ...base, topics }, base)).toBe(true);
  });

  it("reads any other field as a change", () => {
    expect(settingsDirty({ ...base, description: "e" }, base)).toBe(true);
    expect(
      settingsDirty({ ...base, topics: ["zeta", "alpha"], wiki: false }, base),
    ).toBe(true);
  });

  it("leaves both drafts' topics in their own order", () => {
    const saved = { ...base, topics: ["zeta", "alpha"] };
    const form = { ...base, topics: ["mid", "beta", "alpha"] };
    settingsDirty(form, saved);
    expect(form.topics).toEqual(["mid", "beta", "alpha"]);
    expect(saved.topics).toEqual(["zeta", "alpha"]);
  });
});

const REPO = "C:/repo";

const glSettings = (topics: string[]): GitLabRepoSettings => ({
  description: "A project",
  topics,
  defaultBranch: "main",
  visibility: "private",
  webUrl: "https://gitlab.com/o/r",
  fullName: "o/r",
  path: "r",
  name: "r",
  archived: false,
  issuesAccessLevel: "enabled",
  mergeRequestsAccessLevel: "enabled",
  wikiAccessLevel: "enabled",
  snippetsAccessLevel: "enabled",
  forkingAccessLevel: "enabled",
  mergeMethod: "merge",
  squashOption: "default_off",
  removeSourceBranchAfterMerge: true,
  onlyAllowMergeIfPipelineSucceeds: false,
  onlyAllowMergeIfAllDiscussionsAreResolved: false,
});

const ghSettings = (topics: string[]): RepoSettings => ({
  description: "A repository",
  homepage: "",
  topics,
  defaultBranch: "main",
  hasIssues: true,
  hasProjects: true,
  hasWiki: true,
  hasDiscussions: false,
  allowSquashMerge: true,
  allowMergeCommit: true,
  allowRebaseMerge: true,
  allowUpdateBranch: false,
  deleteBranchOnMerge: false,
  allowAutoMerge: false,
  webCommitSignoffRequired: false,
  htmlUrl: "https://github.com/o/r",
  visibility: "public",
  fullName: "o/r",
  archived: false,
  isTemplate: false,
  allowForking: true,
  canChangeForking: false,
  isOrg: false,
  squashMergeCommitTitle: "COMMIT_OR_PR_TITLE",
  squashMergeCommitMessage: "COMMIT_MESSAGES",
  mergeCommitTitle: "MERGE_MESSAGE",
  mergeCommitMessage: "PR_TITLE",
});

function mount(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  useUiStore.setState({ repoPath: REPO });
  for (const fn of [
    forgeGlRepoSettings,
    forgeGlRepoSettingsUpdate,
    ghRepoSettingsGet,
    ghRepoSettingsUpdate,
  ])
    vi.mocked(fn).mockReset();
});

afterAll(() => {
  expect(unmockedCommands).toEqual([]);
});

const saveButton = () => screen.getByRole("button", { name: /Save changes$/ });
// react-query notifies observers on a zero-delay timer.
const tick = () => act(() => new Promise((r) => setTimeout(r, 20)));

function expectHeld() {
  expect(saveButton()).toHaveAttribute("aria-disabled", "true");
  expect(saveButton()).toHaveAccessibleDescription(
    new RegExp(NO_CHANGES_REASON),
  );
}

async function expectActionable() {
  await waitFor(() =>
    expect(saveButton()).not.toHaveAttribute("aria-disabled", "true"),
  );
}

async function addTopic(name: string) {
  const input = screen.getByRole("textbox", { name: "Topics" });
  fireEvent.change(input, { target: { value: name } });
  fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByRole("button", { name: `Remove topic ${name}` });
}

/** Adds `alpha` after `zeta`, saves, and has every later read answer the
 *  forge's sorted order; leaves the form with its topics in entry order. */
async function saveAddedTopic(update: ReturnType<typeof vi.fn>) {
  expectHeld();
  await addTopic("alpha");
  await expectActionable();
  fireEvent.click(saveButton());
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  expect(update.mock.calls[0][1].topics).toEqual(["zeta", "alpha"]);
  await tick();
  await tick();
}

describe("a topics save the forge answers in sorted order", () => {
  it("leaves the GitLab form saved, and a real change still offers Save", async () => {
    vi.mocked(forgeGlRepoSettings).mockResolvedValueOnce(glSettings(["zeta"]));
    vi.mocked(forgeGlRepoSettings).mockResolvedValue(
      glSettings(["alpha", "zeta"]),
    );
    vi.mocked(forgeGlRepoSettingsUpdate).mockResolvedValue(
      glSettings(["alpha", "zeta"]),
    );
    mount(<GitLabGeneralSection repoPath={REPO} open />);
    await screen.findByRole("button", { name: "Remove topic zeta" });

    await saveAddedTopic(vi.mocked(forgeGlRepoSettingsUpdate));
    await waitFor(() =>
      expect(vi.mocked(forgeGlRepoSettings).mock.calls.length).toBeGreaterThan(
        1,
      ),
    );
    await tick();
    expectHeld();
    fireEvent.click(saveButton());
    await tick();
    expect(forgeGlRepoSettingsUpdate).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Remove topic zeta" }));
    await expectActionable();
  });

  it("leaves the GitHub form saved, and a real change still offers Save", async () => {
    vi.mocked(ghRepoSettingsGet).mockResolvedValueOnce(ghSettings(["zeta"]));
    vi.mocked(ghRepoSettingsGet).mockResolvedValue(
      ghSettings(["alpha", "zeta"]),
    );
    vi.mocked(ghRepoSettingsUpdate).mockResolvedValue(
      ghSettings(["alpha", "zeta"]),
    );
    mount(<GeneralSettingsSection repoPath={REPO} open />);
    await screen.findByRole("button", { name: "Remove topic zeta" });

    await saveAddedTopic(vi.mocked(ghRepoSettingsUpdate));
    await waitFor(() =>
      expect(vi.mocked(ghRepoSettingsGet).mock.calls.length).toBeGreaterThan(1),
    );
    await tick();
    expectHeld();
    fireEvent.click(saveButton());
    await tick();
    expect(ghRepoSettingsUpdate).toHaveBeenCalledTimes(1);

    await addTopic("beta");
    await expectActionable();
  });
});
