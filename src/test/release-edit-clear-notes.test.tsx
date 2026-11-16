import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TagDetailView } from "@/features/tags/TagDetailView";
import {
  forgeReleaseEdit,
  forgeReleaseList,
  forgeReleaseSyncUpdaterNotes,
  forgeReleaseView,
  forgeStatus,
} from "@/lib/git/api";
import type { ForgeStatus, ReleaseDetails } from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
// The view's side reads never answer; the release read and its edit are driven.
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitListTags: vi.fn(() => new Promise(() => undefined)),
  gitStatus: vi.fn(() => new Promise(() => undefined)),
  gitBranches: vi.fn(() => new Promise(() => undefined)),
  forgeRepoWriteAccess: vi.fn(() => new Promise(() => undefined)),
  forgeStatus: vi.fn(),
  forgeReleaseView: vi.fn(),
  forgeReleaseList: vi.fn(),
  forgeReleaseEdit: vi.fn(),
  forgeReleaseSyncUpdaterNotes: vi.fn(),
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

const REPO = "C:/repo";
const TAG = "v1.0.0";

const github = {
  provider: "github",
  installed: true,
  authenticated: true,
  repo: "o/r",
  host: "github.com",
  login: "me",
  capabilities: {},
  implemented: { releases: true, releaseEdit: true, releaseCreate: true },
} as unknown as ForgeStatus;

const release = (over: Partial<ReleaseDetails> = {}): ReleaseDetails => ({
  tagName: TAG,
  name: "First",
  body: "Old notes",
  author: "me",
  publishedAt: "2026-11-01T00:00:00Z",
  isDraft: false,
  isPrerelease: false,
  targetCommitish: "main",
  url: `https://github.com/o/r/releases/tag/${TAG}`,
  assets: [],
  ...over,
});

function mount(rel: ReleaseDetails) {
  vi.mocked(forgeReleaseView).mockResolvedValue(rel);
  vi.mocked(forgeReleaseList).mockResolvedValue([
    {
      tagName: TAG,
      name: rel.name,
      isDraft: rel.isDraft,
      isPrerelease: rel.isPrerelease,
      isLatest: !rel.isDraft,
      publishedAt: rel.publishedAt,
    },
  ]);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TagDetailView repoPath={REPO} tag={TAG} />
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(forgeStatus).mockResolvedValue(github);
  vi.mocked(forgeReleaseEdit).mockReset();
  vi.mocked(forgeReleaseEdit).mockResolvedValue(undefined);
  vi.mocked(forgeReleaseSyncUpdaterNotes).mockReset();
  useUiStore.setState({ repoPath: REPO, selectedTag: { tag: TAG } });
});

afterAll(() => {
  expect(unmockedCommands).toEqual([]);
});

// react-query notifies observers on a zero-delay timer.
const tick = () => act(() => new Promise((r) => setTimeout(r, 20)));

async function openEdit() {
  const edit = await screen.findByRole("button", { name: "Edit" });
  await waitFor(() =>
    expect(edit).not.toHaveAttribute("aria-disabled", "true"),
  );
  fireEvent.click(edit);
  return screen.findByRole("dialog");
}

async function saveWithNotes(notes: string | null) {
  const dialog = await openEdit();
  const field = within(dialog).getByRole("textbox", { name: "Release notes" });
  if (notes !== null) fireEvent.change(field, { target: { value: notes } });
  const save = within(dialog).getByRole("button", { name: /^Save$/ });
  await waitFor(() =>
    expect(save).not.toHaveAttribute("aria-disabled", "true"),
  );
  fireEvent.click(save);
  await waitFor(() => expect(forgeReleaseEdit).toHaveBeenCalledTimes(1));
  await tick();
}

/** The edit's (notes, clearNotes) arguments, past repo, tag, title,
 *  prerelease, draft and latest. */
const sent = () => {
  const args = vi.mocked(forgeReleaseEdit).mock.calls[0];
  return { notes: args[3], clearNotes: args[7] };
};

describe("Edit release notes", () => {
  it("clears the notes of a release that had some when the field is emptied", async () => {
    mount(release());
    await saveWithNotes("");
    expect(sent()).toEqual({ notes: "", clearNotes: true });
  });

  it("counts whitespace-only notes as emptied", async () => {
    mount(release());
    await saveWithNotes("  \n ");
    expect(sent().clearNotes).toBe(true);
  });

  it("leaves the updater manifest alone on a clear", async () => {
    const manifest = {
      name: "latest.json",
      size: 1,
      downloadCount: 0,
      url: "",
    };
    mount(release({ assets: [manifest] }));
    await saveWithNotes("");
    expect(sent().clearNotes).toBe(true);
    expect(forgeReleaseSyncUpdaterNotes).not.toHaveBeenCalled();
  });

  it("sends the notes unchanged and clears nothing when the field is untouched", async () => {
    mount(release());
    await saveWithNotes(null);
    expect(sent()).toEqual({ notes: "Old notes", clearNotes: false });
  });

  it("sends changed notes without a clear", async () => {
    mount(release());
    await saveWithNotes("New notes");
    expect(sent()).toEqual({ notes: "New notes", clearNotes: false });
  });

  it("clears nothing for a release that had no notes", async () => {
    mount(release({ body: "" }));
    await saveWithNotes(null);
    expect(sent()).toEqual({ notes: "", clearNotes: false });
  });

  it("keeps notes added elsewhere after the dialog opened", async () => {
    const client = mount(release({ body: "" }));
    const dialog = await openEdit();
    const reads = vi.mocked(forgeReleaseView).mock.calls.length;
    vi.mocked(forgeReleaseView).mockResolvedValue(release({ body: "X" }));
    // Not awaited: the view's never-answering side reads would hold it open.
    act(() => void client.invalidateQueries());
    await waitFor(() =>
      expect(vi.mocked(forgeReleaseView).mock.calls.length).toBeGreaterThan(
        reads,
      ),
    );
    await tick();
    const save = within(dialog).getByRole("button", { name: /^Save$/ });
    await waitFor(() =>
      expect(save).not.toHaveAttribute("aria-disabled", "true"),
    );
    fireEvent.click(save);
    await waitFor(() => expect(forgeReleaseEdit).toHaveBeenCalledTimes(1));
    await tick();
    expect(sent()).toEqual({ notes: "", clearNotes: false });
  });

  it("publishes a draft without a clear", async () => {
    mount(release({ isDraft: true }));
    const publish = await screen.findByRole("button", { name: "Publish" });
    await waitFor(() =>
      expect(publish).not.toHaveAttribute("aria-disabled", "true"),
    );
    fireEvent.click(publish);
    await waitFor(() => expect(forgeReleaseEdit).toHaveBeenCalledTimes(1));
    await tick();
    expect(sent()).toEqual({ notes: "", clearNotes: false });
  });
});
