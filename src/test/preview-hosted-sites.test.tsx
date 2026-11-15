import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarkdownRefs } from "@/components/markdown/markdown-refs";
import { CreateDiscussionDialog } from "@/features/discussions/CreateDiscussionDialog";
import {
  CommitComments,
  CommitLineComposer,
  useCommitLineAnchors,
} from "@/features/pulls/CommitComments";
import { DraftCommentCard } from "@/features/pulls/PendingReviewBar";
import { ReviewerNotesField } from "@/features/pulls/ReviewerNotesField";
import { useAppForm } from "@/lib/form";
import {
  forgeCommitComments,
  forgeStatus,
  ghDiscussionCategories,
} from "@/lib/git/api";
import { splitUnifiedDiff } from "@/lib/git/diff-split";
import type { CommitCommentOut, ForgeStatus } from "@/lib/git/types";
import { ghHostedImage } from "@/lib/hosted-images/api";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(),
  forgeCommitComments: vi.fn(),
  ghDiscussionCategories: vi.fn(),
  // The scope hint's read never answers.
  ghTokenScopes: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("@/lib/hosted-images/api", () => ({ ghHostedImage: vi.fn() }));

// jsdom implements no scrollIntoView; an autofocused editor calls it on mount.
Element.prototype.scrollIntoView ??= () => undefined;

const REPO = "C:/repos/demo";
/** A repo other than the open one, as a fork's upstream lens can be. */
const OTHER = "C:/repos/upstream";
const URL1 =
  "https://github.com/user-attachments/assets/c162f463-c831-4173-8a80-4197acc4a8ac";
const URL2 =
  "https://github.com/user-attachments/assets/0f9d6b52-7d0e-4c7a-9a43-6a1e2b3c4d5e";
const MD = `![shot](${URL1})`;
const MD2 = `![shot2](${URL2})`;
const DATA_SRC = "data:image/png;base64,AAAA";

/** A one-file text patch: new-side line 1 is the patch's second line, so
 *  `position: 2` resolves to it. */
const PATCH =
  "diff --git a/x b/x\nindex 1111aaa..2222bbb 100644\n--- a/x\n+++ b/x\n" +
  "@@ -1 +1,2 @@\n-old\n+new1\n+new2\n";

function setForge(provider: "github" | "gitlab") {
  vi.mocked(forgeStatus).mockResolvedValue({
    provider,
    authenticated: true,
  } as unknown as ForgeStatus);
}

/** Each repo's forge status answers with its own provider. */
function setForgeByRepo(providers: Record<string, "github" | "gitlab">) {
  vi.mocked(forgeStatus).mockImplementation(
    async (repoPath) =>
      ({
        provider: providers[repoPath],
        authenticated: true,
      }) as unknown as ForgeStatus,
  );
}

beforeEach(() => {
  unmockedCommands.length = 0;
  useUiStore.setState({ repoPath: REPO });
  setForge("github");
  vi.mocked(forgeCommitComments).mockReset();
  vi.mocked(forgeCommitComments).mockResolvedValue([]);
  vi.mocked(ghDiscussionCategories).mockResolvedValue({
    repoId: "R_1",
    hasDiscussionsEnabled: true,
    categories: [
      { id: "C_1", name: "General", emoji: "", isAnswerable: false },
    ],
  });
  vi.mocked(ghHostedImage).mockReset();
  vi.mocked(ghHostedImage).mockResolvedValue({
    bytes: { base64: "AAAA", mime: "image/png", tooLarge: false, size: 3 },
    unavailable: null,
  });
});

afterEach(() => {
  expect(unmockedCommands).toEqual([]);
});

function wrap(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

async function expectLoaded(url: string, name: string) {
  await waitFor(() =>
    expect(ghHostedImage).toHaveBeenCalledWith(REPO, url, expect.anything()),
  );
  await waitFor(() =>
    expect(screen.getByRole("img", { name }).getAttribute("src")).toBe(
      DATA_SRC,
    ),
  );
}

/** Forge status answered and the walk it re-runs settled. */
async function settle() {
  await waitFor(() => expect(forgeStatus).toHaveBeenCalled());
  await act(async () => undefined);
  await act(async () => undefined);
}

function renderCommitComments() {
  render(
    wrap(
      <CommitComments
        repoPath={REPO}
        sha={"a".repeat(40)}
        canComment
        remoteLabel="origin"
        diffSections={splitUnifiedDiff(PATCH)}
        selectedPath="x"
        selectedBinary={false}
        lens="origin"
      />,
    ),
  );
}

describe("composer Previews load hosted images", () => {
  it("the commit composer (CommentComposer)", async () => {
    renderCommitComments();
    fireEvent.change(
      screen.getByRole("textbox", { name: "Comment on this commit" }),
      { target: { value: MD } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await expectLoaded(URL1, "shot");
  });

  it("the commit composer off GitHub makes no loader call", async () => {
    setForge("gitlab");
    renderCommitComments();
    fireEvent.change(
      screen.getByRole("textbox", { name: "Comment on this commit" }),
      { target: { value: MD } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByRole("img", { name: "shot" })).toBeTruthy();
    await settle();
    expect(ghHostedImage).not.toHaveBeenCalled();
  });

  it("the line composer (MarkdownEditor)", async () => {
    render(
      wrap(
        <CommitLineComposer
          repoPath={REPO}
          sha={"a".repeat(40)}
          path="x"
          side="new"
          line={1}
          provider="github"
          fileSection={splitUnifiedDiff(PATCH).get("x")}
          onClose={vi.fn()}
          lens="origin"
        />,
      ),
    );
    fireEvent.change(screen.getByRole("textbox", { name: /^Comment on / }), {
      target: { value: MD },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await expectLoaded(URL1, "shot");
  });

  it("the pending comment's Edit editor (CommentEditor)", async () => {
    render(wrap(<Card />));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = screen.getByRole("textbox", {
      name: "Edit pending comment",
    });
    // Edit seeds the editor from the saved body; a URL the resting render
    // never showed pins the editor's own source.
    expect((editor as HTMLTextAreaElement).value).toBe(MD);
    await editorFocused(editor);
    fireEvent.change(editor, { target: { value: MD2 } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await expectLoaded(URL2, "shot2");
  });

  it("New discussion's Body (field.MarkdownField)", async () => {
    render(
      wrap(
        <CreateDiscussionDialog repoPath={REPO} open onOpenChange={vi.fn()} />,
      ),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Body" }), {
      target: { value: MD },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await expectLoaded(URL1, "shot");
  });

  it("Notes for reviewers (the ReviewerNotesField forwarder)", async () => {
    render(wrap(<NotesHost />));
    fireEvent.click(
      screen.getByRole("button", { name: "Notes for reviewers" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await expectLoaded(URL1, "shot");
  });
});

function NotesHost() {
  const form = useAppForm({ defaultValues: { notes: MD } });
  return (
    <form.AppField name="notes">
      {(field) => (
        <ReviewerNotesField
          repoPath={REPO}
          head={null}
          field={field}
          hostedImages={{ repoPath: REPO, host: "github.com" }}
        />
      )}
    </form.AppField>
  );
}

/** CommentEditor focuses its textarea a frame after mounting, and a focus
 *  switches the editor back to Write, so Preview is pressed only after it. */
async function editorFocused(editor: HTMLElement) {
  await waitFor(() => expect(document.activeElement).toBe(editor));
}

function Card() {
  return (
    <DraftCommentCard
      repoPath={REPO}
      lens="origin"
      number={1}
      draft={{
        id: "d1",
        path: "x",
        line: 1,
        side: "new",
        body: MD,
        createdAt: "2026-01-01T00:00:00Z",
      }}
    />
  );
}

function comment(id: string, body: string, line: number | null, position = 0) {
  return {
    id,
    author: "octo",
    body,
    createdAt: "2026-01-01T00:00:00Z",
    viewerDidAuthor: false,
    path: "x",
    line,
    startLine: null,
    position,
  } satisfies CommitCommentOut;
}

function Anchors({
  comments,
  refs,
}: {
  comments: CommitCommentOut[];
  refs?: MarkdownRefs;
}) {
  const anchors = useCommitLineAnchors(
    comments,
    splitUnifiedDiff(PATCH),
    "x",
    refs,
  );
  return (
    <div>
      <p>{`${anchors.length} anchors`}</p>
      {anchors.map((a) => (
        <div key={a.line}>{a.render()}</div>
      ))}
    </div>
  );
}

const GH_REFS: MarkdownRefs = {
  provider: "github",
  repoPath: REPO,
  lens: "origin",
};

describe("posted renders load hosted images", () => {
  it("a placed line comment's anchor", async () => {
    render(wrap(<Anchors comments={[comment("1", MD, 1)]} refs={GH_REFS} />));
    await expectLoaded(URL1, "shot");
  });

  it("two comments on one line stack into one anchor and both load", async () => {
    render(
      wrap(
        <Anchors
          comments={[comment("1", MD, 1), comment("2", MD2, 1)]}
          refs={GH_REFS}
        />,
      ),
    );
    expect(screen.getByText("1 anchors")).toBeTruthy();
    await expectLoaded(URL1, "shot");
    await expectLoaded(URL2, "shot2");
  });

  it("a comment placed from its position loads", async () => {
    render(
      wrap(<Anchors comments={[comment("1", MD, null, 2)]} refs={GH_REFS} />),
    );
    expect(screen.getByText("1 anchors")).toBeTruthy();
    await expectLoaded(URL1, "shot");
  });

  it("an anchor off GitHub makes no loader call", async () => {
    setForge("gitlab");
    render(
      wrap(
        <Anchors
          comments={[comment("1", MD, 1)]}
          refs={{ ...GH_REFS, provider: "gitlab" }}
        />,
      ),
    );
    expect(await screen.findByRole("img", { name: "shot" })).toBeTruthy();
    await settle();
    expect(ghHostedImage).not.toHaveBeenCalled();
  });

  it("an anchor without refs makes no loader call", async () => {
    render(wrap(<Anchors comments={[comment("1", MD, 1)]} />));
    expect(await screen.findByRole("img", { name: "shot" })).toBeTruthy();
    await settle();
    expect(ghHostedImage).not.toHaveBeenCalled();
    // Without refs the hook reads the open repo's status, never an empty path.
    expect(forgeStatus).not.toHaveBeenCalledWith("");
  });

  it("an anchor on another repo loads through that repo", async () => {
    setForgeByRepo({ [REPO]: "gitlab", [OTHER]: "github" });
    render(
      wrap(
        <Anchors
          comments={[comment("1", MD, 1)]}
          refs={{ ...GH_REFS, repoPath: OTHER }}
        />,
      ),
    );
    await waitFor(() =>
      expect(ghHostedImage).toHaveBeenCalledWith(
        OTHER,
        URL1,
        expect.anything(),
      ),
    );
    expect(ghHostedImage).not.toHaveBeenCalledWith(
      REPO,
      expect.anything(),
      expect.anything(),
    );
  });

  it("an anchor on another repo takes that repo's gate", async () => {
    setForgeByRepo({ [REPO]: "github", [OTHER]: "gitlab" });
    render(
      wrap(
        <Anchors
          comments={[comment("1", MD, 1)]}
          refs={{ ...GH_REFS, provider: "gitlab", repoPath: OTHER }}
        />,
      ),
    );
    expect(await screen.findByRole("img", { name: "shot" })).toBeTruthy();
    await settle();
    expect(forgeStatus).toHaveBeenCalledWith(OTHER);
    expect(ghHostedImage).not.toHaveBeenCalled();
  });

  it("a pending comment's resting card", async () => {
    render(wrap(<Card />));
    await expectLoaded(URL1, "shot");
  });

  it("a pending comment's card after Edit, Preview and Cancel", async () => {
    render(wrap(<Card />));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await editorFocused(
      screen.getByRole("textbox", { name: "Edit pending comment" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await expectLoaded(URL1, "shot");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("textbox", { name: "Edit pending comment" }),
    ).toBeNull();
    await waitFor(() =>
      expect(
        screen.getByRole("img", { name: "shot" }).getAttribute("src"),
      ).toBe(DATA_SRC),
    );
  });
});
