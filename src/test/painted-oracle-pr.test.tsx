// Matrix A's oracle on the PR commit drill-in, over the real diff pane.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, expect, vi } from "vitest";
import { PrCommitDetail } from "@/features/pulls/PrCommitDetail";
import {
  type FileBytes,
  forgeCommitComments,
  forgeCommitFirstParent,
  forgeFileAtSha,
  forgePrCommitDiff,
  forgeStatus,
  gitDiffBytesIgnoringWhitespace,
  gitFileBase64,
  gitObjectsPresent,
} from "@/lib/git/api";
import type { ForgeStatus, PrCommitOut } from "@/lib/git/types";
import { settingsKeys } from "@/lib/settings/queries";
import { stubCanvas } from "./canvas-stub";
import {
  COMMIT,
  defineOracleSuite,
  type MountOpts,
  OLD_SHA,
  OracleFrame,
  type OracleHost,
  recordClient,
  settingsOnDisk,
} from "./painted-oracle";

// The diff chunk's load waits on this gate, so a test can hold the lazy
// pane's Suspense fallback up.
const chunk = vi.hoisted(() => ({ gate: Promise.resolve() }));
vi.mock("@/features/diff/DiffSurface", async (importOriginal) => {
  await chunk.gate;
  return importOriginal();
});
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeFileAtSha: vi.fn(),
  gitDiffBytesIgnoringWhitespace: vi.fn(),
  gitFileBase64: vi.fn(),
  forgeCommitComments: vi.fn(),
  forgeCommitFirstParent: vi.fn(),
  forgePrCommitDiff: vi.fn(),
  forgeStatus: vi.fn(),
  gitObjectsPresent: vi.fn(),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
  saveSettingsPatch: vi.fn(),
}));
vi.mock("@/lib/use-container-width", () => ({
  useContainerWidth: () => [() => undefined, null],
}));
vi.mock("@/features/diff/shiki-highlighter", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/diff/shiki-highlighter")>();
  return {
    ...actual,
    ensureBuiltinShikiLang: (id: string) =>
      (globalThis as { __paintedOracleGrammar?: Promise<boolean> })
        .__paintedOracleGrammar ?? actual.ensureBuiltinShikiLang(id),
  };
});
// A body the test names throws inside a diff pane slot only, so the pane's
// error fallback replaces the rows while the list still renders it.
vi.mock("@/components/markdown/markdown", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/markdown/markdown")>();
  const { useInDiffPaneSlot } = await import("@/features/diff/diff-pane-hold");
  function Markdown(props: Parameters<typeof actual.Markdown>[0]) {
    const inPane = useInDiffPaneSlot();
    const boom = (globalThis as { __paintedOracleBoom?: string | null })
      .__paintedOracleBoom;
    if (inPane && boom && props.children.includes(boom))
      throw new Error("renderer failed");
    return <actual.Markdown {...props} />;
  }
  return { ...actual, Markdown };
});

// jsdom has none; the commit composer's editor scrolls itself into view.
Element.prototype.scrollIntoView = vi.fn();

beforeAll(stubCanvas);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  document.body.replaceChildren();
});

const ALL_ON = new Proxy({}, { get: () => true });
const bytes = (text: string): FileBytes => ({
  base64: Buffer.from(text).toString("base64"),
  mime: null,
  tooLarge: false,
  size: text.length,
});
const commit: PrCommitOut = {
  oid: COMMIT,
  headline: "Re-indent f",
  date: "2026-11-01T10:00:00Z",
  author: "Ada",
  messageBody: "",
};
const never = <T,>() => new Promise<T>(() => undefined);

const host: OracleHost = {
  name: "PR commit drill-in",
  listsWithoutDiff: false,
  holdChunk() {
    let release = () => undefined as void;
    chunk.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  },
  async failPatchRefetch(client) {
    const key = ["repo", "/repo", "pr", "origin", 7, "commit-diff", COMMIT];
    vi.mocked(forgePrCommitDiff).mockRejectedValue(new Error("offline"));
    await act(() => client.refetchQueries({ queryKey: key }));
    const state = client.getQueryState(key);
    expect(state?.status).toBe("error");
    expect(state?.data).toBeTruthy();
  },
  mount(o: MountOpts) {
    // The drill-in lists its files from the patch read, so its pane's own
    // pending state is a -w view in flight: Hide whitespace on, the
    // whole-file reads unanswered.
    const settings = settingsOnDisk(o.hide || o.diff === "pending");
    vi.mocked(forgeStatus).mockResolvedValue({
      provider: "github",
      installed: true,
      authenticated: true,
      repo: "octo/repo",
      host: "github.com",
      login: "octo",
      capabilities: ALL_ON,
      implemented: ALL_ON,
    } as unknown as ForgeStatus);
    if (o.reads === "fail") {
      vi.mocked(gitObjectsPresent).mockRejectedValue(new Error("offline"));
      vi.mocked(forgeCommitFirstParent).mockResolvedValue(null);
    } else if (o.files.some((f) => f.path.endsWith(".md"))) {
      // Preview reads the head from this clone, so the commit is local.
      vi.mocked(gitObjectsPresent).mockResolvedValue(true);
      vi.mocked(forgeCommitFirstParent).mockResolvedValue(OLD_SHA);
    } else {
      vi.mocked(gitObjectsPresent).mockImplementation(async (_r, oids) =>
        oids.length > 0 ? false : true,
      );
      vi.mocked(forgeCommitFirstParent).mockResolvedValue(OLD_SHA);
    }
    const read = {
      ok: () => Promise.resolve(o.files.map((f) => f.patch).join("")),
      pending: () => Promise.resolve(o.files.map((f) => f.patch).join("")),
      error: () => Promise.reject(new Error("diff unavailable")),
    };
    vi.mocked(forgePrCommitDiff).mockImplementation(() =>
      read[o.diff ?? "ok"](),
    );
    const file = (path: string) => {
      const f = o.files.find((x) => x.path === path);
      if (!f) throw new Error(`no fixture for ${path}`);
      return f;
    };
    vi.mocked(forgeFileAtSha).mockImplementation((_r, sha, path) =>
      o.diff === "pending"
        ? never()
        : Promise.resolve(
            bytes(sha === OLD_SHA ? file(path).old : file(path).next),
          ),
    );
    vi.mocked(gitFileBase64).mockImplementation(async (_r, rev, path) =>
      bytes(rev?.endsWith("~1") ? file(path).old : file(path).next),
    );
    vi.mocked(gitDiffBytesIgnoringWhitespace).mockImplementation(
      async (_old, next) => {
        const text = Buffer.from(next ?? "", "base64").toString();
        const f = o.files.find((x) => x.next === text);
        return { hunks: f?.hunks ?? "", isBinary: false };
      },
    );
    vi.mocked(forgeCommitComments).mockResolvedValue(o.comments);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(settingsKeys.settings, settings);
    render(
      <QueryClientProvider client={client}>
        <OracleFrame>
          <PrCommitDetail
            repoPath="/repo"
            number={7}
            commit={commit}
            onBack={() => undefined}
            canCommentCommits={o.canComment ?? false}
            remoteLabel="GitHub"
            lens="origin"
          />
        </OracleFrame>
      </QueryClientProvider>,
    );
    return recordClient(host, client);
  },
};

defineOracleSuite(host);
