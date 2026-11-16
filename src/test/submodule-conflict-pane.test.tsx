import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, type ReactNode } from "react";
import { toast } from "sonner";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictFileView } from "@/features/repository/ConflictFileView";
import { ConflictResolveView } from "@/features/repository/ConflictResolveView";
import { aiExcludePatterns } from "@/lib/ai/ignore";
import {
  getSecret,
  gitAcceptSubmoduleConflictSide,
  gitStage,
  gitStatus,
  gitSubmoduleConflict,
  isSubmoduleConflictRefusal,
  readRepoInstructions,
  SUBMODULE_CONFLICT_REFUSAL,
} from "@/lib/git/api";
import { type ConflictSides, conflictSides } from "@/lib/git/conflict";
import { repoKeys } from "@/lib/git/queries";
import type {
  RepoStatus,
  SubmoduleAcceptOutcome,
  SubmoduleCheckoutPlan,
  SubmoduleConflict,
  SubmoduleConflictSide,
} from "@/lib/git/types";
import { ACT_PENDING_REASON } from "@/lib/offline-writes";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { useConfirm } from "@/lib/stores/confirm";
import { useConflictResolve } from "@/lib/stores/conflict-resolve";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  getSecret: vi.fn(),
  gitStage: vi.fn(),
  gitStatus: vi.fn(),
  readRepoInstructions: vi.fn(),
  gitSubmoduleConflict: vi.fn(),
  gitAcceptSubmoduleConflictSide: vi.fn(),
}));
vi.mock("@/lib/git/conflict", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/conflict")>()),
  conflictSides: vi.fn(),
}));
vi.mock("@/lib/ai/ignore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/ignore")>()),
  aiExcludePatterns: vi.fn(),
}));
const stream = vi.hoisted(() => ({
  run: vi.fn(),
  cancel: vi.fn(),
  reset: vi.fn(),
}));
vi.mock("@/lib/ai/stream", () => ({
  useAiTextStream: () => ({
    run: stream.run,
    cancel: stream.cancel,
    reset: stream.reset,
    generating: false,
    text: "",
    status: "",
  }),
}));
vi.mock("sonner", () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    dismiss: vi.fn(),
  },
}));

const REPO = "C:/repos/superproject";
const PATH = "libs/parser";
const NAME = "parser";
const READING = "Reading the conflict…";
const READ_ERROR =
  "Couldn't read this submodule conflict, so its commits can't be shown here. Resolve it in a terminal.";
const FALLBACK =
  "Couldn't read this file, so it can't be shown here. Resolve the conflict in your editor.";
const TERMINAL_REMOVED =
  "To take the removal instead, resolve this conflict in a terminal.";
const TERMINAL_FILE =
  "To keep the file instead, resolve this conflict in a terminal.";
const NOT_CONFLICTED = "This file is no longer conflicted.";

const BASE = "3f1c9a7e2b6d4058a1c3e9f7b2d4a6c8e0f13579";
const OURS = "a94b2e6c1d7f3058b2e4c6a8d0f2b4c6e8a0c2d4";
const THEIRS = "c27e5d9b3a1f6084c2e6a8b0d2f4c6e8a0b2d4f6";

const REFUSAL = {
  kind: "invalidArgument" as const,
  message: `invalid argument: ${SUBMODULE_CONFLICT_REFUSAL}`,
};
const IO = { kind: "io" as const, message: "locked" };
const NOT_CONFLICTED_REJECTION = {
  kind: "invalidArgument" as const,
  message: `invalid argument: ${NOT_CONFLICTED}`,
};
/** The submodule read's answer once the path's conflict holds no gitlink. */
const NOT_SUBMODULE = {
  kind: "invalidArgument" as const,
  message: "invalid argument: not a submodule conflict",
};

const MARKED: ConflictSides = {
  working: "<<<<<<< HEAD\nfn a() { 1 }\n=======\nfn a() { 2 }\n>>>>>>> topic\n",
  base: "fn a() {}\n",
  ours: "fn a() { 1 }\n",
  theirs: "fn a() { 2 }\n",
  aiIgnored: { ignored: false, unreadable: false },
  workingExists: true,
  workingUndecodable: false,
  undecodable: false,
  workingHash: "h1",
  workingMatchesSurvivor: null,
};

const RESOLVED_SIDES: ConflictSides = {
  working: "",
  base: null,
  ours: null,
  theirs: null,
  aiIgnored: { ignored: false, unreadable: false },
  workingExists: false,
  workingUndecodable: false,
  undecodable: false,
  workingHash: null,
  workingMatchesSurvivor: null,
};

const side = (
  sha: string,
  plan: SubmoduleCheckoutPlan,
  subject: string | null,
): SubmoduleConflictSide => ({
  sha,
  gitlink: true,
  commit:
    subject === null ? null : { subject, committedAt: "2026-11-10T09:30:00Z" },
  plan,
});

/** S1: incoming is a child of current, both fetched, HEAD on current. */
const DESCENDANT: SubmoduleConflict = {
  base: BASE,
  ours: side(OURS, "alreadyThere", "Pin the tokenizer to 2.4"),
  theirs: side(THEIRS, "checkOut", "Bump the tokenizer to 2.5"),
  relation: { kind: "theirsContainsOurs", ahead: 1 },
};

const RESOLVED: SubmoduleConflict = {
  base: null,
  ours: null,
  theirs: null,
  relation: { kind: "unknown" },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** What the next conflict-file and submodule reads answer: a rejection with
 *  the error, or the value. */
let fileDisk: ConflictSides | object;
let subDisk: SubmoduleConflict | object;

beforeEach(() => {
  fileDisk = REFUSAL;
  subDisk = DESCENDANT;
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
  vi.mocked(conflictSides).mockReset();
  vi.mocked(conflictSides).mockImplementation(async () => {
    if ("working" in fileDisk) return fileDisk as ConflictSides;
    throw fileDisk;
  });
  vi.mocked(gitSubmoduleConflict).mockReset();
  vi.mocked(gitSubmoduleConflict).mockImplementation(async () => {
    if ("relation" in subDisk) return subDisk as SubmoduleConflict;
    throw subDisk;
  });
  vi.mocked(gitAcceptSubmoduleConflictSide).mockReset();
  vi.mocked(getSecret).mockImplementation(async () => "sk-test-000000");
  vi.mocked(readRepoInstructions).mockImplementation(async () => null);
  vi.mocked(aiExcludePatterns).mockImplementation(async () => []);
  vi.mocked(gitStatus).mockImplementation(
    async (): Promise<RepoStatus> => ({
      branch: {} as RepoStatus["branch"],
      entries: [{ path: PATH, staged: "conflicted", unstaged: "conflicted" }],
    }),
  );
  vi.mocked(gitStage).mockImplementation(async () => undefined);
  stream.run.mockImplementation(async () => false);
  vi.mocked(toast.info).mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  useUiStore.setState(useUiStore.getInitialState(), true);
  useUiStore.setState({ repoPath: REPO });
  useConfirm.setState({ request: null, requestHold: null });
  useConflictResolve.setState(useConflictResolve.getInitialState(), true);
});

afterAll(() => expect(unmockedCommands).toEqual([]));

function newClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, structuredClone(DEFAULT_SETTINGS));
  client.setQueryData(settingsKeys.secret("anthropic"), {
    length: 14,
    masked: "sk-tes...0000",
  });
  return client;
}

const SUB_KEY = ["repo", REPO, "conflict-file", PATH, "submodule"];

function renderView(client = newClient()) {
  const sink = createRef<HTMLDivElement>();
  const tree = (path: string): ReactNode => (
    <QueryClientProvider client={client}>
      <div ref={sink} tabIndex={-1} />
      <ConflictFileView repoPath={REPO} path={path} focusSink={sink} />
    </QueryClientProvider>
  );
  const view = render(tree(PATH));
  return {
    client,
    container: view.container,
    rerender: (path: string) => view.rerender(tree(path)),
    /** The view's own landing spot. */
    viewSink: () =>
      view.container.querySelector<HTMLElement>('span.sr-only[tabindex="-1"]'),
    rereadSubmodule: () =>
      act(async () => {
        void client.refetchQueries({ queryKey: SUB_KEY });
        await new Promise((r) => setTimeout(r, 50));
      }),
  };
}

const acceptButton = (label: string | RegExp) =>
  screen.getByRole("button", { name: label });
const footer = (text: string) => screen.queryByText(text);

describe("ConflictFileView's submodule conflict pane", () => {
  it("U1-U3: the refusal swaps the header's actions for the pane", async () => {
    renderView();
    expect(
      await screen.findByRole("button", { name: "Accept incoming (newer)" }),
    ).toBeInTheDocument();
    expect(screen.getByText("· submodule conflict")).toBeInTheDocument();
    for (const name of [
      "Open in editor",
      "Accept all current",
      "Accept all incoming",
      "Resolve with AI",
      "Both",
      "Next conflict",
    ])
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    expect(screen.getByText("Current (ours)")).toBeInTheDocument();
    expect(screen.getByText("Incoming (theirs)")).toBeInTheDocument();
    expect(screen.getByText(OURS.slice(0, 7))).toBeInTheDocument();
    expect(screen.getByText(THEIRS.slice(0, 7))).toBeInTheDocument();
    expect(screen.getByText("Pin the tokenizer to 2.4")).toBeInTheDocument();
    expect(screen.getByText("Bump the tokenizer to 2.5")).toBeInTheDocument();
    expect(
      screen.getByText("Incoming includes current · 1 ahead"),
    ).toBeInTheDocument();
    expect(acceptButton("Accept current")).toBeInTheDocument();
    expect(screen.queryByText(FALLBACK)).not.toBeInTheDocument();
    expect(
      footer(`Picking a side stages that commit and checks it out in ${NAME}.`),
    ).toBeInTheDocument();
    expect(vi.mocked(gitSubmoduleConflict)).toHaveBeenCalledWith(REPO, PATH);
  });

  it.each([
    [
      "current contains incoming",
      { kind: "oursContainsTheirs", ahead: 3 } as const,
      "Current includes incoming · 3 ahead",
      ["Accept current (newer)", "Accept incoming"],
    ],
    [
      "diverged",
      { kind: "diverged" } as const,
      "These commits have diverged",
      ["Accept current", "Accept incoming"],
    ],
  ])("U3: %s", async (_, relation, line, labels) => {
    subDisk = { ...DESCENDANT, relation };
    renderView();
    expect(await screen.findByText(line)).toBeInTheDocument();
    for (const label of labels) expect(acceptButton(label)).toBeInTheDocument();
    expect(screen.queryAllByText(/\(newer\)/)).toHaveLength(
      labels.filter((l) => l.endsWith("(newer)")).length,
    );
  });

  it("U3: an unknown relation draws no line", async () => {
    subDisk = { ...DESCENDANT, relation: { kind: "unknown" } };
    renderView();
    await screen.findByRole("button", { name: "Accept incoming" });
    expect(screen.queryByText(/includes|diverged/)).not.toBeInTheDocument();
  });

  it("U4: a side not fetched keeps its Accept", async () => {
    subDisk = {
      ...DESCENDANT,
      theirs: side(THEIRS, "notFetched", null),
      relation: { kind: "unknown" },
    };
    renderView();
    expect(
      await screen.findByText("Not fetched in the submodule"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(acceptButton("Accept incoming")).not.toHaveAttribute(
        "aria-disabled",
      ),
    );
  });

  it("U4: a side the read never looked into names no fetch", async () => {
    subDisk = {
      ...DESCENDANT,
      ours: side(OURS, "notInitialized", null),
      theirs: side(THEIRS, "notInitialized", null),
      relation: { kind: "unknown" },
    };
    renderView();
    await screen.findByRole("button", { name: "Accept incoming" });
    expect(
      screen.queryByText("Not fetched in the submodule"),
    ).not.toBeInTheDocument();
  });

  it.each([
    ["removed", null, "Removed on this side", TERMINAL_REMOVED, TERMINAL_FILE],
    [
      "a file",
      { sha: THEIRS, gitlink: false, commit: null, plan: null },
      "A file on this side, not a submodule commit",
      TERMINAL_FILE,
      TERMINAL_REMOVED,
    ],
  ])(
    "U4: incoming %s offers no Accept and points to a terminal for it",
    async (_, theirs, line, hint, otherHint) => {
      subDisk = { ...DESCENDANT, theirs, relation: { kind: "unknown" } };
      renderView();
      expect(await screen.findByText(line)).toBeInTheDocument();
      expect(screen.getByText(hint)).toBeInTheDocument();
      expect(screen.queryByText(otherHint)).not.toBeInTheDocument();
      expect(acceptButton("Accept current")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /Accept incoming/ }),
      ).not.toBeInTheDocument();
    },
  );

  it.each([
    [
      "both check out",
      "checkOut",
      "checkOut",
      `Picking a side stages that commit and checks it out in ${NAME}.`,
    ],
    [
      "one side not fetched",
      "checkOut",
      "notFetched",
      `Picking a side stages that commit; a commit that isn't fetched in ${NAME} leaves its checkout as is.`,
    ],
    [
      "dirty beside already there",
      "alreadyThere",
      "dirty",
      `Picking a side stages that commit; ${NAME} has local changes, so its checkout stays as is.`,
    ],
    [
      "not initialized",
      "notInitialized",
      "notInitialized",
      `Picking a side stages that commit; ${NAME} isn't checked out here, so there is no checkout to move.`,
    ],
    [
      "unusable",
      "unusable",
      "unusable",
      `Picking a side stages that commit; ${NAME}'s folder can't be read as a submodule, so its checkout stays as is.`,
    ],
    [
      "detached elsewhere",
      "detachedElsewhere",
      "detachedElsewhere",
      `Picking a side stages that commit; ${NAME} is on a commit of its own, so its checkout stays as is.`,
    ],
  ] as const)(
    "U5: the footer says it up front (%s)",
    async (_, ours, theirs, text) => {
      subDisk = {
        ...DESCENDANT,
        ours: side(OURS, ours, "Pin the tokenizer to 2.4"),
        theirs: side(THEIRS, theirs, "Bump the tokenizer to 2.5"),
      };
      renderView();
      expect(await screen.findByText(text)).toBeInTheDocument();
      expect(screen.queryAllByText(/^Picking a side/)).toHaveLength(1);
    },
  );

  it("U5: no footer when no side offers an Accept", async () => {
    subDisk = {
      base: BASE,
      ours: null,
      theirs: { sha: THEIRS, gitlink: false, commit: null, plan: null },
      relation: { kind: "unknown" },
    };
    renderView();
    await screen.findByText("Removed on this side");
    expect(screen.queryByText(/^Picking a side/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Accept/ })).toBeNull();
  });

  it("R1: sides lacking an Accept for different causes each get their line, current first", async () => {
    subDisk = {
      base: BASE,
      ours: null,
      theirs: { sha: THEIRS, gitlink: false, commit: null, plan: null },
      relation: { kind: "unknown" },
    };
    renderView();
    await screen.findByText("Removed on this side");
    expect(
      screen
        .getAllByText(/resolve this conflict in a terminal.$/, {
          selector: "p",
        })
        .map((p) => p.textContent),
    ).toEqual([TERMINAL_REMOVED, TERMINAL_FILE]);
  });

  it("R1: two file sides share one line", async () => {
    subDisk = {
      base: BASE,
      ours: { sha: OURS, gitlink: false, commit: null, plan: null },
      theirs: { sha: THEIRS, gitlink: false, commit: null, plan: null },
      relation: { kind: "unknown" },
    };
    renderView();
    expect(await screen.findByText(TERMINAL_FILE)).toBeInTheDocument();
    expect(screen.queryByText(TERMINAL_REMOVED)).not.toBeInTheDocument();
    expect(
      screen.getAllByText(/resolve this conflict in a terminal.$/, {
        selector: "p",
      }),
    ).toHaveLength(1);
  });

  it("U7: a read error holds across re-reads, then heals", async () => {
    subDisk = IO;
    const view = renderView();
    expect(await screen.findByText(READ_ERROR)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Accept/ })).toBeNull();
    const held = deferred<SubmoduleConflict>();
    vi.mocked(gitSubmoduleConflict).mockImplementationOnce(() => held.promise);
    await view.rereadSubmodule();
    expect(screen.queryByText(READING)).not.toBeInTheDocument();
    expect(screen.getByText(READ_ERROR)).toBeInTheDocument();
    await act(async () => held.reject(IO));
    expect(screen.getByText(READ_ERROR)).toBeInTheDocument();
    subDisk = DESCENDANT;
    await view.rereadSubmodule();
    expect(
      await screen.findByRole("button", { name: "Accept incoming (newer)" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(READ_ERROR)).not.toBeInTheDocument();
  });

  it("U7: no stages left shows the not-conflicted line and nudges status", async () => {
    subDisk = RESOLVED;
    const client = newClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    renderView(client);
    expect(
      await screen.findByText(NOT_CONFLICTED, { selector: "p" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: repoKeys.status(REPO),
      }),
    );
  });

  it("U6: the show's re-read holds both Accepts with its reason", async () => {
    const client = newClient();
    client.setQueryData(SUB_KEY, DESCENDANT);
    const held = deferred<SubmoduleConflict>();
    vi.mocked(gitSubmoduleConflict).mockImplementation(() => held.promise);
    renderView(client);
    const current = await screen.findByRole("button", {
      name: "Accept current",
    });
    expect(current).toHaveAttribute("aria-disabled", "true");
    expect(current).toHaveAccessibleDescription(READING);
    await act(async () => held.resolve(DESCENDANT));
    await waitFor(() =>
      expect(acceptButton("Accept current")).not.toHaveAttribute(
        "aria-disabled",
      ),
    );
  });

  // The file read stays refused through both swaps, so `submoduleArm` never
  // moves: only the pane's own rescue can catch the focused Accept leaving.
  it.each([
    ["an outside resolve", RESOLVED, NOT_CONFLICTED],
    ["a failed re-read", IO, READ_ERROR],
  ] as const)(
    "C1: %s takes the Accepts away and focus lands on the view's sink",
    async (_, answer, line) => {
      const view = renderView();
      const accept = await screen.findByRole("button", {
        name: "Accept incoming (newer)",
      });
      accept.focus();
      expect(document.activeElement).toBe(accept);
      subDisk = answer;
      await view.rereadSubmodule();
      expect(
        await screen.findByText(line, { selector: "p" }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Accept/ })).toBeNull();
      expect(document.activeElement).toBe(view.viewSink());
    },
  );

  it("C3: a gitlink conflict turned file conflict re-reads the file and shows its text", async () => {
    const view = renderView();
    await screen.findByRole("button", { name: "Accept incoming (newer)" });
    const sink = view.viewSink();
    const fileReads = vi.mocked(conflictSides).mock.calls.length;
    subDisk = NOT_SUBMODULE;
    fileDisk = MARKED;
    await view.rereadSubmodule();
    expect(
      await screen.findByRole("button", { name: "Accept all current" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("· submodule conflict")).toBeNull();
    expect(vi.mocked(conflictSides).mock.calls.length).toBeGreaterThan(
      fileReads,
    );
    // The same view instance took the text arm over.
    expect(view.viewSink()).toBe(sink);
  });

  it("C3: a file read still refused re-reads once and asks the submodule nothing more", async () => {
    const view = renderView();
    await screen.findByRole("button", { name: "Accept incoming (newer)" });
    const fileReads = vi.mocked(conflictSides).mock.calls.length;
    const subReads = vi.mocked(gitSubmoduleConflict).mock.calls.length;
    subDisk = NOT_SUBMODULE;
    await view.rereadSubmodule();
    await act(() => new Promise((r) => setTimeout(r, 150)));
    expect(screen.getByText(READ_ERROR)).toBeInTheDocument();
    expect(vi.mocked(conflictSides).mock.calls.length).toBe(fileReads + 1);
    expect(vi.mocked(gitSubmoduleConflict).mock.calls.length).toBe(
      subReads + 1,
    );
  });
});

describe("Accepting a submodule side", () => {
  it.each([
    [
      { kind: "checkedOut" } as const,
      `Resolved ${NAME} — took incoming and checked it out in ${NAME}.`,
    ],
    [
      { kind: "alreadyThere" } as const,
      `Resolved ${NAME} — took incoming. ${NAME} was already on that commit.`,
    ],
    [
      { kind: "left", why: "dirty", reason: null } as const,
      `Resolved ${NAME} — took incoming. ${NAME} has local changes, so its checkout stays as is.`,
    ],
    [
      { kind: "left", why: "notInitialized", reason: null } as const,
      `Resolved ${NAME} — took incoming. ${NAME} isn't checked out here, so there was no checkout to move.`,
    ],
    [
      { kind: "left", why: "unusable", reason: null } as const,
      `Resolved ${NAME} — took incoming. ${NAME}'s folder couldn't be read as a submodule, so its checkout stays as is.`,
    ],
    [
      { kind: "left", why: "detachedElsewhere", reason: null } as const,
      `Resolved ${NAME} — took incoming. ${NAME} is on a commit of its own, so its checkout stays as is.`,
    ],
    [
      { kind: "left", why: "notFetched", reason: null } as const,
      `Resolved ${NAME} — took incoming. That commit isn't fetched in ${NAME} yet, so its checkout stays as is.`,
    ],
    [
      {
        kind: "left",
        why: "failed",
        reason: "untracked working tree files would be overwritten",
      } as const,
      `Resolved ${NAME} — took incoming. Couldn't check it out in ${NAME}, so its checkout stays as is: untracked working tree files would be overwritten`,
    ],
  ])("U8: staged %o toasts its outcome", async (checkout, text) => {
    vi.mocked(gitAcceptSubmoduleConflictSide).mockImplementation(async () => {
      fileDisk = RESOLVED_SIDES;
      subDisk = RESOLVED;
      return { kind: "staged", sha: THEIRS, checkout };
    });
    const user = userEvent.setup();
    renderView();
    const button = await screen.findByRole("button", {
      name: "Accept incoming (newer)",
    });
    await waitFor(() => expect(button).not.toHaveAttribute("aria-disabled"));
    await user.click(button);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(text));
  });

  it("U8: took current says current", async () => {
    vi.mocked(gitAcceptSubmoduleConflictSide).mockImplementation(
      async (): Promise<SubmoduleAcceptOutcome> => ({
        kind: "staged",
        sha: OURS,
        checkout: { kind: "alreadyThere" },
      }),
    );
    const user = userEvent.setup();
    renderView();
    const button = await screen.findByRole("button", {
      name: "Accept current",
    });
    await waitFor(() => expect(button).not.toHaveAttribute("aria-disabled"));
    await user.click(button);
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        `Resolved ${NAME} — took current. ${NAME} was already on that commit.`,
      ),
    );
  });

  it("U8/F6: the press forwards the read's stages, holds, and lands once it settles", async () => {
    const write = deferred<SubmoduleAcceptOutcome>();
    vi.mocked(gitAcceptSubmoduleConflictSide).mockImplementation(
      () => write.promise,
    );
    const user = userEvent.setup();
    const view = renderView();
    const incoming = await screen.findByRole("button", {
      name: "Accept incoming (newer)",
    });
    await waitFor(() => expect(incoming).not.toHaveAttribute("aria-disabled"));
    await user.click(incoming);
    expect(vi.mocked(gitAcceptSubmoduleConflictSide)).toHaveBeenCalledWith(
      REPO,
      PATH,
      "theirs",
      { base: BASE, ours: OURS, theirs: THEIRS },
      true,
    );
    await waitFor(() =>
      expect(incoming).toHaveAttribute("aria-disabled", "true"),
    );
    expect(incoming).toHaveAccessibleDescription(ACT_PENDING_REASON);
    const current = acceptButton("Accept current");
    expect(current).toHaveAttribute("aria-disabled", "true");
    expect(current).toHaveAccessibleDescription(ACT_PENDING_REASON);
    await user.click(incoming);
    await user.click(current);
    expect(vi.mocked(gitAcceptSubmoduleConflictSide)).toHaveBeenCalledTimes(1);

    fileDisk = RESOLVED_SIDES;
    subDisk = RESOLVED;
    await act(async () =>
      write.resolve({
        kind: "staged",
        sha: THEIRS,
        checkout: { kind: "checkedOut" },
      }),
    );
    expect(
      await screen.findByText(NOT_CONFLICTED, { selector: "p" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Accept (current|incoming)/ }),
    ).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(view.viewSink()));
  });

  it.each([
    ["checkOut", true],
    ["alreadyThere", false],
    ["dirty", false],
    ["notFetched", false],
    ["detachedElsewhere", false],
    ["notInitialized", false],
    ["unusable", false],
  ] as const)(
    "F6b: a %s read forwards expectCheckout %s",
    async (plan, promised) => {
      subDisk = { ...DESCENDANT, theirs: side(THEIRS, plan, "Bump") };
      vi.mocked(gitAcceptSubmoduleConflictSide).mockImplementation(
        async (): Promise<SubmoduleAcceptOutcome> => ({ kind: "changed" }),
      );
      const user = userEvent.setup();
      renderView();
      const button = await screen.findByRole("button", {
        name: /^Accept incoming/,
      });
      await waitFor(() => expect(button).not.toHaveAttribute("aria-disabled"));
      await user.click(button);
      await waitFor(() =>
        expect(vi.mocked(gitAcceptSubmoduleConflictSide)).toHaveBeenCalled(),
      );
      expect(vi.mocked(gitAcceptSubmoduleConflictSide).mock.calls[0][4]).toBe(
        promised,
      );
    },
  );

  it("F6b: a changed answer toasts and the re-read paints the new footer", async () => {
    vi.mocked(gitAcceptSubmoduleConflictSide).mockImplementation(async () => {
      subDisk = {
        ...DESCENDANT,
        ours: side(OURS, "dirty", "Pin the tokenizer to 2.4"),
        theirs: side(THEIRS, "dirty", "Bump the tokenizer to 2.5"),
      };
      return { kind: "changed" };
    });
    const user = userEvent.setup();
    renderView();
    const button = await screen.findByRole("button", {
      name: "Accept incoming (newer)",
    });
    await waitFor(() => expect(button).not.toHaveAttribute("aria-disabled"));
    await user.click(button);
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        `The submodule conflict in ${NAME}, or its checkout, changed after it was read — nothing was staged.`,
      ),
    );
    expect(
      await screen.findByText(
        `Picking a side stages that commit; ${NAME} has local changes, so its checkout stays as is.`,
      ),
    ).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it("U8: a not-conflicted refusal toasts the shared line", async () => {
    vi.mocked(gitAcceptSubmoduleConflictSide).mockImplementation(async () => {
      throw NOT_CONFLICTED_REJECTION;
    });
    const user = userEvent.setup();
    renderView();
    const button = await screen.findByRole("button", {
      name: "Accept incoming (newer)",
    });
    await waitFor(() => expect(button).not.toHaveAttribute("aria-disabled"));
    await user.click(button);
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        `${NAME} is no longer conflicted — nothing was changed.`,
      ),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("U8: any other rejection takes the error toast and re-reads", async () => {
    vi.mocked(gitAcceptSubmoduleConflictSide).mockImplementation(async () => {
      throw { kind: "busy", message: "a conflict resolution is running" };
    });
    const user = userEvent.setup();
    renderView();
    const button = await screen.findByRole("button", {
      name: "Accept incoming (newer)",
    });
    await waitFor(() => expect(button).not.toHaveAttribute("aria-disabled"));
    const reads = vi.mocked(gitSubmoduleConflict).mock.calls.length;
    await user.click(button);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await waitFor(() =>
      expect(vi.mocked(gitSubmoduleConflict).mock.calls.length).toBeGreaterThan(
        reads,
      ),
    );
    await waitFor(() => expect(button).not.toHaveAttribute("aria-disabled"));
  });

  it("F6: a settle after moving to another path takes no focus there", async () => {
    const write = deferred<SubmoduleAcceptOutcome>();
    vi.mocked(gitAcceptSubmoduleConflictSide).mockImplementation(
      () => write.promise,
    );
    const user = userEvent.setup();
    const view = renderView();
    const button = await screen.findByRole("button", {
      name: "Accept incoming (newer)",
    });
    await waitFor(() => expect(button).not.toHaveAttribute("aria-disabled"));
    await user.click(button);
    vi.mocked(conflictSides).mockImplementation(
      () => new Promise<ConflictSides>(() => undefined),
    );
    act(() => view.rerender("libs/other"));
    await screen.findByText(READING);
    const before = document.activeElement;
    await act(async () =>
      write.resolve({
        kind: "staged",
        sha: THEIRS,
        checkout: { kind: "checkedOut" },
      }),
    );
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(document.activeElement).toBe(before);
  });

  it("F7/U10: the Accepts tab in reading order and answer Enter and Space", async () => {
    vi.mocked(gitAcceptSubmoduleConflictSide).mockImplementation(
      async (): Promise<SubmoduleAcceptOutcome> => ({ kind: "changed" }),
    );
    const user = userEvent.setup();
    renderView();
    const incoming = await screen.findByRole("button", {
      name: "Accept incoming (newer)",
    });
    await waitFor(() => expect(incoming).not.toHaveAttribute("aria-disabled"));
    const current = acceptButton("Accept current");
    await user.tab();
    expect(document.activeElement).toBe(current);
    await user.tab();
    expect(document.activeElement).toBe(incoming);
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(vi.mocked(gitAcceptSubmoduleConflictSide)).toHaveBeenCalledTimes(
        1,
      ),
    );
    expect(vi.mocked(gitAcceptSubmoduleConflictSide).mock.calls[0][2]).toBe(
      "theirs",
    );
    await waitFor(() => expect(current).not.toHaveAttribute("aria-disabled"));
    current.focus();
    await user.keyboard(" ");
    await waitFor(() =>
      expect(vi.mocked(gitAcceptSubmoduleConflictSide)).toHaveBeenCalledTimes(
        2,
      ),
    );
    expect(vi.mocked(gitAcceptSubmoduleConflictSide).mock.calls[1][2]).toBe(
      "ours",
    );
  });

  it("U9: focus on the header's actions moves to the view's sink as the arm lands", async () => {
    const read = deferred<ConflictSides>();
    vi.mocked(conflictSides).mockImplementation(() => read.promise);
    const view = renderView();
    const acceptAll = await screen.findByRole("button", {
      name: "Open in editor",
    });
    acceptAll.focus();
    await act(async () => read.reject(REFUSAL));
    await screen.findByText("· submodule conflict");
    expect(document.activeElement).toBe(view.viewSink());
  });
});

describe("ConflictResolveView on a submodule conflict", () => {
  it("U11: a single-file start blocks with its own body, no toast, no Try again", async () => {
    render(
      <QueryClientProvider client={newClient()}>
        <ConflictResolveView repoPath={REPO} path={PATH} />
      </QueryClientProvider>,
    );
    expect(
      await screen.findByText(
        "This is a submodule conflict, so there's no text for a model to merge. Pick a commit in the conflict editor instead.",
      ),
    ).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: /Try again/ }),
    ).not.toBeInTheDocument();
    expect(conflictSides).toHaveBeenCalledTimes(1);
  });
});

describe("isSubmoduleConflictRefusal", () => {
  it("matches the wire refusal only", () => {
    expect(isSubmoduleConflictRefusal(REFUSAL)).toBe(true);
    expect(isSubmoduleConflictRefusal(IO)).toBe(false);
    expect(
      isSubmoduleConflictRefusal({
        kind: "io",
        message: SUBMODULE_CONFLICT_REFUSAL,
      }),
    ).toBe(false);
    expect(isSubmoduleConflictRefusal(NOT_CONFLICTED_REJECTION)).toBe(false);
  });
});
