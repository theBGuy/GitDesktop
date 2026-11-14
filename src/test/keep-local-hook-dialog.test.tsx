import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeepLocalHookDialog } from "@/features/repository/KeepLocalHookDialog";
import { copyText } from "@/lib/clipboard";
import {
  gitHookDelete,
  gitHookSetEnabled,
  gitHooksList,
  gitHookWrite,
  gitInstallHookManager,
  gitKeepLocalHookInstall,
  gitKeepLocalHookRemove,
  gitKeepLocalHookStatus,
} from "@/lib/git/api";
import {
  useDeleteHook,
  useHooks,
  useInstallHookManager,
  useKeepLocalHookStatus,
  useSetHookEnabled,
  useWriteHook,
} from "@/lib/git/queries";
import type { HooksInfo, KeepLocalHookStatus } from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitHooksList: vi.fn(),
  gitHookWrite: vi.fn(),
  gitHookSetEnabled: vi.fn(),
  gitHookDelete: vi.fn(),
  gitInstallHookManager: vi.fn(),
  gitKeepLocalHookStatus: vi.fn(),
  gitKeepLocalHookInstall: vi.fn(),
  gitKeepLocalHookRemove: vi.fn(),
}));
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => undefined) }));
/** Identities the session learned, by checkout; a path missing here peeks as the
 *  real (empty) memo answers it. */
const IDENTITIES = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/git/repo-identity", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/git/repo-identity")>();
  return {
    ...actual,
    peekRepoIdentity: (path: string) =>
      IDENTITIES.get(path) ?? actual.peekRepoIdentity(path),
  };
});

const REPO = "C:/repos/keep";
const HOOKS = "C:/repos/keep/.git/hooks";
const SNIPPET = 'branch=$(git symbolic-ref -q HEAD)\necho "stop"';
const J_BODY =
  "GitDesktop and its MCP server already refuse to push a branch marked Keep local. A pre-push hook makes git push stop as well, in a terminal or in an agent's own shell.";
const J_BODY_NO_AI =
  "GitDesktop already refuses to push a branch marked Keep local. A pre-push hook makes git push stop as well when it runs in a terminal.";
const L_BODY =
  "A pre-push hook in this clone stops git push for branches marked Keep local. It covers this clone only, and git push --no-verify skips it.";

const hookStatus = (
  state: KeepLocalHookStatus["state"],
  blocked: KeepLocalHookStatus["blocked"] = null,
  manager: KeepLocalHookStatus["manager"] = null,
  managedHookPresent = state === "installed",
  hooksDirRedirected = false,
): KeepLocalHookStatus => ({
  state,
  blocked,
  manager,
  managedHookPresent,
  hooksDirRedirected,
  hooksPath: HOOKS,
  snippet: SNIPPET,
});

/** What the mocked backend reports; a write mock edits it like the real one. */
let backend: KeepLocalHookStatus;
let success: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
  backend = hookStatus("absent");
  vi.mocked(gitKeepLocalHookStatus).mockImplementation(async () => backend);
  vi.mocked(gitKeepLocalHookInstall).mockImplementation(async () => {
    backend = hookStatus("installed");
    return backend;
  });
  vi.mocked(gitKeepLocalHookRemove).mockImplementation(async () => {
    backend = hookStatus("absent");
    return backend;
  });
  success = vi.spyOn(toast, "success");
  info = vi.spyOn(toast, "info");
  error = vi.spyOn(toast, "error");
  useUiStore.setState({ repoPath: REPO });
});
afterEach(() => {
  success.mockRestore();
  info.mockRestore();
  error.mockRestore();
});

const OTHER_REPO = "C:/repos/other";

/** A write mock that answers only when the test lands it. */
function deferredWrite(write: typeof gitKeepLocalHookInstall) {
  const ctl: {
    land: (s: KeepLocalHookStatus) => void;
    fail: (e: unknown) => void;
  } = { land: () => undefined, fail: () => undefined };
  vi.mocked(write).mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        ctl.land = (st) => {
          backend = st;
          resolve(st);
        };
        ctl.fail = reject;
      }),
  );
  return ctl;
}

/** Hosts the dialog the way BranchSwitcher does: a session token per open, the
 *  live one readable through a ref, a close that drops it. */
function Host() {
  const [session, setSession] = useState<object | null>(() => ({}));
  // A new instance, as after a repo switch drops the dialog and a return reopens it.
  const [instance, setInstance] = useState(0);
  const live = useRef(session);
  useEffect(() => {
    live.current = session;
  }, [session]);
  return (
    <>
      <button type="button" onClick={() => setSession({})}>
        Reopen
      </button>
      <button
        type="button"
        onClick={() => {
          setInstance((n) => n + 1);
          setSession({});
        }}
      >
        Reopen as a new instance
      </button>
      <KeepLocalHookDialog
        key={instance}
        repoPath={REPO}
        open={session !== null}
        session={session}
        isLiveSession={(s) => live.current === s}
        onOpenChange={(o) => {
          if (!o) setSession(null);
        }}
      />
    </>
  );
}

function renderDialog(beside?: ReactNode) {
  const user = userEvent.setup();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <Host />
      {beside}
    </QueryClientProvider>,
  );
  return { user, queryClient };
}

const HOOK_KEY = ["repo", REPO, "keep-local-hook"];

/** Every later status read hangs, so only the write's own answer can move the view. */
const holdStatusReads = () =>
  vi
    .mocked(gitKeepLocalHookStatus)
    .mockImplementation(() => new Promise(() => undefined));

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
const dialog = () => screen.findByRole("dialog");
/** A footer button: the corner X is also named "Close". */
const button = (name: string) => {
  const footer = document.querySelector<HTMLElement>(
    '[data-slot="dialog-footer"]',
  );
  if (!footer) throw new Error("no dialog footer");
  return within(footer).getByRole("button", { name });
};
const expectFocusOn = (name: string) =>
  waitFor(() => {
    expect(document.activeElement).not.toBe(document.body);
    expect(button(name)).toHaveFocus();
  });

describe("the not-installed state", () => {
  it("offers the hook with its path and focuses Cancel", async () => {
    renderDialog();
    const d = await dialog();
    await within(d).findByText("Block terminal pushes too?");
    expect(within(d).getByText(J_BODY)).toBeInTheDocument();
    const items = within(d).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      `It lives in this clone only (${HOOKS}/pre-push). Other clones don't get it.`,
      "git push --no-verify skips it.",
    ]);
    expect(button("Install hook")).toBeInTheDocument();
    await expectFocusOn("Cancel");
  });

  it("Hide AI features drops the MCP server from the body", async () => {
    vi.mocked(loadSettings).mockImplementation(async () => ({
      ...structuredClone(DEFAULT_SETTINGS),
      hideAi: true,
    }));
    renderDialog();
    const d = await dialog();
    await within(d).findByText(J_BODY_NO_AI);
    expect(within(d).queryByText(J_BODY)).toBe(null);
  });

  it("moves focus to Cancel when the status lands after the open", async () => {
    let answer: (s: KeepLocalHookStatus) => void = () => undefined;
    vi.mocked(gitKeepLocalHookStatus).mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    renderDialog();
    const d = await dialog();
    expect(within(d).getByText("Checking this clone's hooks…")).toBeVisible();
    await expectFocusOn("Close");
    await act(async () => answer(hookStatus("absent")));
    await within(d).findByText("Block terminal pushes too?");
    await expectFocusOn("Cancel");
  });

  it("Install writes once, re-reads the status, toasts and closes", async () => {
    const { user } = renderDialog();
    await screen.findByText("Block terminal pushes too?");
    await expectFocusOn("Cancel");
    const readsBefore = vi.mocked(gitKeepLocalHookStatus).mock.calls.length;
    await user.click(button("Install hook"));
    expect(gitKeepLocalHookInstall).toHaveBeenCalledTimes(1);
    expect(gitKeepLocalHookInstall).toHaveBeenCalledWith(REPO);
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("Terminal push guard installed"),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));
    // The write's git-only invalidation re-read the hook status unprompted.
    await waitFor(() =>
      expect(
        vi.mocked(gitKeepLocalHookStatus).mock.calls.length,
      ).toBeGreaterThan(readsBefore),
    );
  });

  it("Install answering blocked swaps to the check with no further read, focused on Close", async () => {
    const blocked = hookStatus("blocked", "foreignHook");
    vi.mocked(gitKeepLocalHookInstall).mockResolvedValue(blocked);
    const { user, queryClient } = renderDialog();
    await screen.findByText("Block terminal pushes too?");
    await expectFocusOn("Cancel");
    const readsBefore = vi.mocked(gitKeepLocalHookStatus).mock.calls.length;
    holdStatusReads();
    await user.click(button("Install hook"));
    const d = await dialog();
    await within(d).findByText(
      /This clone already has a pre-push hook, so GitDesktop won't replace it\./,
    );
    await expectFocusOn("Close");
    expect(success).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(queryClient.getQueryData(HOOK_KEY)).toEqual(blocked);
    // The invalidation's re-read started and never answered: the write did it.
    expect(vi.mocked(gitKeepLocalHookStatus).mock.calls.length).toBeGreaterThan(
      readsBefore,
    );
  });
});

describe("a write that doesn't take while its open is shown", () => {
  it("Install answering absent says so inline and stays open", async () => {
    vi.mocked(gitKeepLocalHookInstall).mockResolvedValue(hookStatus("absent"));
    const { user } = renderDialog();
    await screen.findByText("Block terminal pushes too?");
    await expectFocusOn("Cancel");
    await user.click(button("Install hook"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Terminal push guard not installed. This clone has no pre-push hook file.",
    );
    expect(screen.getByText("Block terminal pushes too?")).toBeInTheDocument();
    expect(success).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("Remove answering installed says so inline and stays open", async () => {
    backend = hookStatus("installed");
    vi.mocked(gitKeepLocalHookRemove).mockResolvedValue(
      hookStatus("installed"),
    );
    const { user } = renderDialog();
    await screen.findByText(L_BODY);
    await expectFocusOn("Close");
    await user.click(button("Remove hook"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Terminal push guard not removed. The hook is still in this clone.",
    );
    expect(screen.getByText(L_BODY)).toBeInTheDocument();
    expect(success).not.toHaveBeenCalled();
  });

  it("Remove answering blocked with GitDesktop's file gone toasts removed and closes", async () => {
    backend = hookStatus("installed");
    vi.mocked(gitKeepLocalHookRemove).mockImplementation(async () => {
      backend = hookStatus("blocked", "hookManager", "lefthook", false);
      return backend;
    });
    const { user } = renderDialog();
    await screen.findByText(L_BODY);
    await expectFocusOn("Close");
    await user.click(button("Remove hook"));
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("Terminal push guard removed"),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));
    expect(screen.queryByRole("alert")).toBe(null);
    expect(info).not.toHaveBeenCalled();
  });

  it("Remove answering blocked with GitDesktop's file still there says it wasn't removed", async () => {
    backend = hookStatus("installed");
    vi.mocked(gitKeepLocalHookRemove).mockImplementation(async () => {
      backend = hookStatus("blocked", "customHooksPath", null, true);
      return backend;
    });
    const { user } = renderDialog();
    await screen.findByText(L_BODY);
    await expectFocusOn("Close");
    await user.click(button("Remove hook"));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Terminal push guard not removed.",
    );
    expect(
      await screen.findByText(
        /This repository keeps its hooks in a custom folder, so GitDesktop won't add a pre-push hook there/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(success).not.toHaveBeenCalled();
  });

  it("Remove answering blocked through a linked hooks folder says it wasn't removed", async () => {
    backend = hookStatus("installed");
    vi.mocked(gitKeepLocalHookRemove).mockImplementation(async () => {
      backend = hookStatus("blocked", "customHooksPath", null, false, true);
      return backend;
    });
    const { user } = renderDialog();
    await screen.findByText(L_BODY);
    await expectFocusOn("Close");
    await user.click(button("Remove hook"));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Terminal push guard not removed.",
    );
    expect(
      await screen.findByText(
        /This repository keeps its hooks in a custom folder, so GitDesktop won't add a pre-push hook there/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(success).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("a rejected Install stays open with the error", async () => {
    vi.mocked(gitKeepLocalHookInstall).mockRejectedValue({
      kind: "io",
      message: "Couldn't write the hook file",
    });
    const { user } = renderDialog();
    await screen.findByText("Block terminal pushes too?");
    await expectFocusOn("Cancel");
    await user.click(button("Install hook"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't write the hook file",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(error).not.toHaveBeenCalled();
  });

  it("holds Install but never Cancel while the status re-reads", async () => {
    const { user, queryClient } = renderDialog();
    await screen.findByText("Block terminal pushes too?");
    await expectFocusOn("Cancel");
    holdStatusReads();
    await act(async () => {
      void queryClient.invalidateQueries({ queryKey: HOOK_KEY });
    });
    await waitFor(() =>
      expect(button("Install hook")).toHaveAttribute("aria-disabled", "true"),
    );
    expect(button("Cancel")).not.toHaveAttribute("aria-disabled");
    await user.click(button("Cancel"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));
  });

  it("leaves focus alone when it sits outside the dialog at a state change", async () => {
    let answer: (s: KeepLocalHookStatus) => void = () => undefined;
    vi.mocked(gitKeepLocalHookStatus).mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    renderDialog();
    await dialog();
    await expectFocusOn("Close");
    const outside = screen.getByRole("button", {
      name: "Reopen",
      hidden: true,
    });
    act(() => outside.focus());
    expect(outside).toHaveFocus();
    await act(async () => answer(hookStatus("absent")));
    await screen.findByText("Block terminal pushes too?");
    await settle();
    expect(outside).toHaveFocus();
  });
});

describe("a settle after its open is gone", () => {
  it("an Install that doesn't take toasts the outcome with its repository", async () => {
    const write = deferredWrite(gitKeepLocalHookInstall);
    const { user } = renderDialog();
    await screen.findByText("Block terminal pushes too?");
    await expectFocusOn("Cancel");
    await user.click(button("Install hook"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));
    act(() => useUiStore.setState({ repoPath: OTHER_REPO }));
    await act(async () => write.land(hookStatus("blocked", "foreignHook")));
    await waitFor(() => expect(info).toHaveBeenCalledTimes(1));
    expect(info).toHaveBeenCalledWith(
      "Terminal push guard not installed in keep",
      {
        description:
          "This clone already has a pre-push hook, so GitDesktop won't replace it.",
      },
    );
    expect(success).not.toHaveBeenCalled();
  });

  it("a Remove that doesn't take toasts the outcome after a close", async () => {
    backend = hookStatus("installed");
    const write = deferredWrite(gitKeepLocalHookRemove);
    const { user } = renderDialog();
    await screen.findByText(L_BODY);
    await expectFocusOn("Close");
    await user.click(button("Remove hook"));
    await user.click(button("Close"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));
    await act(async () => write.land(hookStatus("installed")));
    await waitFor(() =>
      expect(info).toHaveBeenCalledWith("Terminal push guard not removed", {
        description: "The hook is still in this clone.",
      }),
    );
  });

  it("a Remove through a linked hooks folder that settles after a close toasts not removed", async () => {
    backend = hookStatus("installed");
    const write = deferredWrite(gitKeepLocalHookRemove);
    const { user } = renderDialog();
    await screen.findByText(L_BODY);
    await expectFocusOn("Close");
    await user.click(button("Remove hook"));
    await user.click(button("Close"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));
    await act(async () =>
      write.land(hookStatus("blocked", "customHooksPath", null, false, true)),
    );
    await waitFor(() =>
      expect(info).toHaveBeenCalledWith("Terminal push guard not removed", {
        description:
          "This repository keeps its hooks in a custom folder, so GitDesktop won't add a pre-push hook there.",
      }),
    );
    expect(success).not.toHaveBeenCalled();
  });

  it("a failed Install toasts the error naming its repository", async () => {
    const write = deferredWrite(gitKeepLocalHookInstall);
    const { user } = renderDialog();
    await screen.findByText("Block terminal pushes too?");
    await expectFocusOn("Cancel");
    await user.click(button("Install hook"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));
    act(() => useUiStore.setState({ repoPath: OTHER_REPO }));
    await act(async () =>
      write.fail({ kind: "io", message: "Couldn't write the hook file" }),
    );
    await waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(error.mock.calls[0][1]).toMatchObject({ description: "In keep" });
  });

  it("a dialog reopened as a new instance during an earlier Install holds Install, not Cancel", async () => {
    deferredWrite(gitKeepLocalHookInstall);
    const { user, queryClient } = renderDialog();
    await screen.findByText("Block terminal pushes too?");
    await expectFocusOn("Cancel");
    await user.click(button("Install hook"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));
    await user.click(
      screen.getByRole("button", { name: "Reopen as a new instance" }),
    );
    await screen.findByText("Block terminal pushes too?");
    // The reopen's own status read holds it too; only the write is left after.
    await waitFor(() =>
      expect(queryClient.isFetching({ queryKey: HOOK_KEY })).toBe(0),
    );
    await settle();
    expect(button("Install hook")).toHaveAttribute("aria-disabled", "true");
    await user.click(button("Install hook"));
    expect(gitKeepLocalHookInstall).toHaveBeenCalledTimes(1);
    expect(button("Cancel")).not.toHaveAttribute("aria-disabled");
  });
});

describe("a settle from an earlier open", () => {
  it("toasts but leaves a reopened dialog alone", async () => {
    let land: (s: KeepLocalHookStatus) => void = () => undefined;
    vi.mocked(gitKeepLocalHookInstall).mockImplementation(
      () =>
        new Promise((resolve) => {
          land = (s) => {
            backend = s;
            resolve(s);
          };
        }),
    );
    const { user } = renderDialog();
    await screen.findByText("Block terminal pushes too?");
    await expectFocusOn("Cancel");
    await user.click(button("Install hook"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));
    await user.click(screen.getByRole("button", { name: "Reopen" }));
    await dialog();
    await act(async () => land(hookStatus("installed")));
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("Terminal push guard installed"),
    );
    await settle();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("the installed state", () => {
  beforeEach(() => {
    backend = hookStatus("installed");
  });

  it("explains the hook, offers Remove and focuses Close", async () => {
    renderDialog();
    const d = await dialog();
    await within(d).findByText(L_BODY);
    expect(within(d).getByText("Terminal push guard")).toBeInTheDocument();
    expect(button("Remove hook")).toBeInTheDocument();
    await expectFocusOn("Close");
  });

  it("Remove toasts and closes", async () => {
    const { user } = renderDialog();
    await screen.findByText(L_BODY);
    await expectFocusOn("Close");
    await user.click(button("Remove hook"));
    expect(gitKeepLocalHookRemove).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("Terminal push guard removed"),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));
  });

  it("Remove answering absent seeds the status the menu item reads", async () => {
    const { user, queryClient } = renderDialog();
    await screen.findByText(L_BODY);
    await expectFocusOn("Close");
    holdStatusReads();
    await user.click(button("Remove hook"));
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("Terminal push guard removed"),
    );
    expect(queryClient.getQueryData(HOOK_KEY)).toEqual(hookStatus("absent"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));
  });

  it("a rejected Remove stays open with the error", async () => {
    vi.mocked(gitKeepLocalHookRemove).mockRejectedValue({
      kind: "io",
      message: "Couldn't delete the hook file",
    });
    const { user } = renderDialog();
    await screen.findByText(L_BODY);
    await expectFocusOn("Close");
    await user.click(button("Remove hook"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't delete the hook file",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(success).not.toHaveBeenCalled();
  });
});

describe("the can't-install state", () => {
  const reasons: [KeepLocalHookStatus, string][] = [
    [
      hookStatus("blocked", "foreignHook"),
      "This clone already has a pre-push hook, so GitDesktop won't replace it.",
    ],
    [
      hookStatus("blocked", "customHooksPath"),
      "This repository keeps its hooks in a custom folder, so GitDesktop won't add a pre-push hook there.",
    ],
    ...(["husky", "pre-commit", "lefthook"] as const).map(
      (m): [KeepLocalHookStatus, string] => [
        hookStatus("blocked", "hookManager", m),
        `This repository's hooks are managed by ${m}, so GitDesktop won't add a pre-push hook of its own.`,
      ],
    ),
  ];
  for (const [status, reason] of reasons) {
    it(`names the reason: ${status.blocked} ${status.manager ?? ""}`, async () => {
      backend = status;
      const { user } = renderDialog();
      const d = await dialog();
      const description = await within(d).findByText(
        new RegExp(`^${reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      );
      expect(description).toHaveTextContent(
        `${reason} Add this check to your pre-push hook, above anything else that reads the pushed refs, to get the same guard:`,
      );
      expect(within(d).getByText("Terminal push guard")).toBeInTheDocument();
      const pre = d.querySelector("pre");
      expect(pre?.textContent).toBe(SNIPPET);
      expect(pre).toHaveAttribute("tabindex", "0");
      expect(pre).toHaveAccessibleName("Check to add to your pre-push hook");
      expect(screen.queryByRole("button", { name: "Install hook" })).toBe(null);
      await expectFocusOn("Close");
      await user.click(button("Copy check"));
      expect(copyText).toHaveBeenCalledWith(SNIPPET, "Check copied");
    });
  }

  const INERT =
    "A GitDesktop hook from an earlier install is still in this clone, but it no longer runs because the hooks folder changed.";

  it("offers neither the leftover line nor Remove when GitDesktop's file isn't there", async () => {
    backend = hookStatus("blocked", "customHooksPath", null, false);
    renderDialog();
    const d = await dialog();
    await within(d).findByText(/keeps its hooks in a custom folder/);
    await expectFocusOn("Close");
    expect(within(d).queryByText(INERT)).toBe(null);
    expect(within(d).queryByRole("button", { name: "Remove hook" })).toBe(null);
  });

  it("the can't-install view through a linked hooks folder offers no Remove", async () => {
    backend = hookStatus("blocked", "customHooksPath", null, false, true);
    renderDialog();
    const d = await dialog();
    await within(d).findByText(/keeps its hooks in a custom folder/);
    await expectFocusOn("Close");
    expect(within(d).queryByText(INERT)).toBe(null);
    expect(within(d).queryByRole("button", { name: "Remove hook" })).toBe(null);
  });

  it("offers Remove for a leftover GitDesktop file, which removes it and closes", async () => {
    backend = hookStatus("blocked", "customHooksPath", null, true);
    vi.mocked(gitKeepLocalHookRemove).mockImplementation(async () => {
      backend = hookStatus("blocked", "customHooksPath", null, false);
      return backend;
    });
    const { user } = renderDialog();
    const d = await dialog();
    await within(d).findByText(INERT);
    await expectFocusOn("Close");
    await user.click(button("Remove hook"));
    expect(gitKeepLocalHookRemove).toHaveBeenCalledTimes(1);
    expect(gitKeepLocalHookRemove).toHaveBeenCalledWith(REPO);
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("Terminal push guard removed"),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));
  });

  it("holds the leftover's Remove, never Close, while the status re-reads", async () => {
    backend = hookStatus("blocked", "customHooksPath", null, true);
    const { queryClient } = renderDialog();
    await screen.findByText(INERT);
    await expectFocusOn("Close");
    holdStatusReads();
    await act(async () => {
      void queryClient.invalidateQueries({ queryKey: HOOK_KEY });
    });
    await waitFor(() =>
      expect(button("Remove hook")).toHaveAttribute("aria-disabled", "true"),
    );
    expect(button("Close")).not.toHaveAttribute("aria-disabled");
  });
});

describe("a failed status read", () => {
  it("says so with Retry, and Retry lands focus on the next state's safe button", async () => {
    vi.mocked(gitKeepLocalHookStatus).mockRejectedValueOnce({
      kind: "io",
      message: "boom",
    });
    const { user } = renderDialog();
    const d = await dialog();
    await within(d).findByText("Couldn't check this clone's hooks.");
    expect(within(d).getByText("Terminal push guard")).toBeInTheDocument();
    // Never claims "not installed" from a failed read.
    expect(within(d).queryByText("Block terminal pushes too?")).toBe(null);
    await expectFocusOn("Close");
    await user.click(button("Retry"));
    await within(d).findByText("Block terminal pushes too?");
    await expectFocusOn("Cancel");
  });

  it("Retry swaps to the busy check at once, so it can't be pressed twice", async () => {
    vi.mocked(gitKeepLocalHookStatus).mockRejectedValueOnce({
      kind: "io",
      message: "boom",
    });
    const { user } = renderDialog();
    const d = await dialog();
    await within(d).findByText("Couldn't check this clone's hooks.");
    await expectFocusOn("Close");
    holdStatusReads();
    await user.click(button("Retry"));
    await within(d).findByText("Checking this clone's hooks…");
    expect(within(d).queryByRole("button", { name: "Retry" })).toBe(null);
    await expectFocusOn("Close");
  });
});

describe("the other checkouts of the repository", () => {
  const SIBLING = "C:/repos/keep-wt";
  const UNRELATED = "C:/repos/unrelated";
  const UNKNOWN = "C:/repos/unknown";
  const statusKey = (path: string) => ["repo", path, "keep-local-hook"];
  const listKey = (path: string) => ["repo", path, "hooks"];
  const contentKey = (path: string) => ["repo", path, "hook", "pre-push"];
  const hooksInfo = (count: number): HooksInfo => ({
    hooksPath: `${SIBLING}/.git/hooks`,
    customHooksPath: false,
    manager: null,
    managerConfig: null,
    entries: Array.from({ length: count }, (_, i) => ({
      name: `hook-${i}`,
      description: "",
      state: "active" as const,
      hasSample: false,
      managed: false,
    })),
  });

  const WRITES = [
    {
      name: "Install",
      write: gitKeepLocalHookInstall,
      start: "absent",
      prompt: "Block terminal pushes too?",
      press: "Install hook",
      toast: "Terminal push guard installed",
      after: "installed",
    },
    {
      name: "Remove",
      write: gitKeepLocalHookRemove,
      start: "installed",
      prompt: L_BODY,
      press: "Remove hook",
      toast: "Terminal push guard removed",
      after: "absent",
    },
  ] as const;

  /** What SIBLING's reads answer, and a gate that holds them while set. */
  let siblingStatus: KeepLocalHookStatus;
  let siblingHooks: number;
  let gate: Promise<void> | null;

  beforeEach(() => {
    IDENTITIES.set(REPO, "C:/repos/keep/.git");
    IDENTITIES.set(SIBLING, "C:/repos/keep/.git");
    IDENTITIES.set(UNRELATED, "C:/repos/unrelated/.git");
    siblingStatus = hookStatus("absent");
    siblingHooks = 1;
    gate = null;
    vi.mocked(gitKeepLocalHookStatus).mockImplementation(async (path) => {
      if (path !== SIBLING) return backend;
      if (gate) await gate;
      return siblingStatus;
    });
    vi.mocked(gitHooksList).mockImplementation(async () => {
      if (gate) await gate;
      return hooksInfo(siblingHooks);
    });
  });
  afterEach(() => IDENTITIES.clear());

  function seed(queryClient: QueryClient) {
    queryClient.setQueryData(statusKey(SIBLING), hookStatus("absent"));
    queryClient.setQueryData(listKey(SIBLING), hooksInfo(1));
    queryClient.setQueryData(contentKey(SIBLING), "echo old");
    queryClient.setQueryData(statusKey(UNRELATED), hookStatus("absent"));
    queryClient.setQueryData(statusKey(UNKNOWN), hookStatus("absent"));
  }

  /** SIBLING open in another view under the same client; `seen` logs each
   *  committed text, so a blank frame between two answers can't hide. */
  function SiblingObserver({ seen }: { seen: string[] }) {
    const status = useKeepLocalHookStatus(SIBLING, true);
    const list = useHooks(SIBLING);
    const text = `${status.data?.state ?? "no status"} / ${
      list.data ? `${list.data.entries.length} hooks` : "no hooks"
    }`;
    useEffect(() => {
      seen.push(text);
    }, [seen, text]);
    return <p data-testid="sibling">{text}</p>;
  }

  for (const w of WRITES) {
    it(`${w.name} clears an unobserved sibling's status and hook list, nothing else`, async () => {
      backend = hookStatus(w.start);
      const { user, queryClient } = renderDialog();
      await screen.findByText(w.prompt);
      seed(queryClient);
      await user.click(button(w.press));
      await waitFor(() => expect(success).toHaveBeenCalledWith(w.toast));
      expect(queryClient.getQueryData(statusKey(SIBLING))).toBeUndefined();
      expect(queryClient.getQueryData(listKey(SIBLING))).toBeUndefined();
      expect(queryClient.getQueryData(contentKey(SIBLING))).toBe("echo old");
      expect(queryClient.getQueryData(statusKey(UNRELATED))).toEqual(
        hookStatus("absent"),
      );
      // An identity this session never learned counts as a sibling.
      expect(queryClient.getQueryData(statusKey(UNKNOWN))).toBeUndefined();
      expect(queryClient.getQueryData(statusKey(REPO))).toEqual(
        hookStatus(w.after),
      );
      // A cleared entry nobody observes is not re-read.
      expect(gitHooksList).not.toHaveBeenCalled();
      expect(gitKeepLocalHookStatus).not.toHaveBeenCalledWith(SIBLING);
    });

    it(`${w.name} re-reads an observed sibling in place, never blanking it`, async () => {
      backend = hookStatus(w.start);
      const seen: string[] = [];
      const { user } = renderDialog(<SiblingObserver seen={seen} />);
      await screen.findByText(w.prompt);
      const sibling = await screen.findByTestId("sibling");
      await waitFor(() =>
        expect(sibling).toHaveTextContent("absent / 1 hooks"),
      );
      const readsBefore = vi
        .mocked(gitKeepLocalHookStatus)
        .mock.calls.filter(([p]) => p === SIBLING).length;
      const shownBefore = seen.length;
      let release: () => void = () => undefined;
      gate = new Promise((r) => {
        release = r;
      });
      siblingStatus = hookStatus("installed");
      siblingHooks = 2;
      await user.click(button(w.press));
      await waitFor(() => expect(success).toHaveBeenCalledWith(w.toast));
      await settle();
      // The re-read is in flight and the observer still shows its data.
      expect(sibling).toHaveTextContent("absent / 1 hooks");
      expect(
        vi
          .mocked(gitKeepLocalHookStatus)
          .mock.calls.filter(([p]) => p === SIBLING).length,
      ).toBeGreaterThan(readsBefore);
      await act(async () => release());
      await waitFor(() =>
        expect(sibling).toHaveTextContent("installed / 2 hooks"),
      );
      expect(seen.slice(shownBefore).filter((t) => t.includes("no "))).toEqual(
        [],
      );
    });
  }

  /** The Hooks dialog's four hooks-folder writers, each run once from REPO. */
  const HOOK_WRITERS = [
    { name: "Save", api: gitHookWrite },
    { name: "Disable", api: gitHookSetEnabled },
    { name: "Delete", api: gitHookDelete },
    { name: "Install hooks", api: gitInstallHookManager },
  ] as const;
  let runWriter: (() => Promise<unknown>) | null = null;
  function Writer({ which }: { which: (typeof HOOK_WRITERS)[number]["name"] }) {
    const write = useWriteHook(REPO);
    const setEnabled = useSetHookEnabled(REPO);
    const del = useDeleteHook(REPO);
    const install = useInstallHookManager(REPO);
    const runs = {
      Save: () =>
        write.mutateAsync({ name: "pre-push", content: "#!/bin/sh\n" }),
      Disable: () =>
        setEnabled.mutateAsync({ name: "pre-push", enabled: false }),
      Delete: () => del.mutateAsync("pre-push"),
      "Install hooks": () => install.mutateAsync("lefthook"),
    };
    runWriter = runs[which];
    return null;
  }
  function renderWriter(
    which: (typeof HOOK_WRITERS)[number]["name"],
    beside?: ReactNode,
  ) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <Writer which={which} />
        {beside}
      </QueryClientProvider>,
    );
    return queryClient;
  }

  for (const w of HOOK_WRITERS) {
    it(`the Hooks dialog's ${w.name} clears an unobserved sibling's status and hook list, nothing else`, async () => {
      vi.mocked(w.api).mockResolvedValue(undefined as never);
      const queryClient = renderWriter(w.name);
      seed(queryClient);
      queryClient.setQueryData(listKey(UNRELATED), hooksInfo(1));
      await act(async () => {
        await runWriter?.();
      });
      expect(w.api).toHaveBeenCalledTimes(1);
      expect(queryClient.getQueryData(statusKey(SIBLING))).toBeUndefined();
      expect(queryClient.getQueryData(listKey(SIBLING))).toBeUndefined();
      expect(queryClient.getQueryData(contentKey(SIBLING))).toBe("echo old");
      expect(queryClient.getQueryData(statusKey(UNRELATED))).toEqual(
        hookStatus("absent"),
      );
      expect(queryClient.getQueryData(listKey(UNRELATED))).toEqual(
        hooksInfo(1),
      );
      expect(queryClient.getQueryData(statusKey(UNKNOWN))).toBeUndefined();
    });

    it(`the Hooks dialog's ${w.name} from a checkout of unknown identity clears every other checkout's reads`, async () => {
      // The writer's own identity was never learned: any other checkout may
      // share its hooks folder, so even UNRELATED's reads count as a sibling's.
      IDENTITIES.delete(REPO);
      vi.mocked(w.api).mockResolvedValue(undefined as never);
      const queryClient = renderWriter(w.name);
      seed(queryClient);
      queryClient.setQueryData(listKey(UNRELATED), hooksInfo(1));
      await act(async () => {
        await runWriter?.();
      });
      expect(w.api).toHaveBeenCalledTimes(1);
      expect(queryClient.getQueryData(statusKey(SIBLING))).toBeUndefined();
      expect(queryClient.getQueryData(listKey(SIBLING))).toBeUndefined();
      expect(queryClient.getQueryData(statusKey(UNRELATED))).toBeUndefined();
      expect(queryClient.getQueryData(listKey(UNRELATED))).toBeUndefined();
      expect(queryClient.getQueryData(contentKey(SIBLING))).toBe("echo old");
    });

    it(`the Hooks dialog's ${w.name} re-reads an observed sibling in place`, async () => {
      vi.mocked(w.api).mockResolvedValue(undefined as never);
      renderWriter(w.name, <SiblingObserver seen={[]} />);
      const sibling = await screen.findByTestId("sibling");
      await waitFor(() =>
        expect(sibling).toHaveTextContent("absent / 1 hooks"),
      );
      siblingStatus = hookStatus("installed");
      siblingHooks = 2;
      await act(async () => {
        await runWriter?.();
      });
      await waitFor(() =>
        expect(sibling).toHaveTextContent("installed / 2 hooks"),
      );
    });
  }

  it("a rejected Install touches no sibling", async () => {
    vi.mocked(gitKeepLocalHookInstall).mockRejectedValue({
      kind: "io",
      message: "Couldn't write the hook file",
    });
    const { user, queryClient } = renderDialog();
    await screen.findByText("Block terminal pushes too?");
    seed(queryClient);
    await user.click(button("Install hook"));
    await screen.findByRole("alert");
    expect(queryClient.getQueryData(statusKey(SIBLING))).toEqual(
      hookStatus("absent"),
    );
    expect(queryClient.getQueryData(listKey(SIBLING))).toEqual(hooksInfo(1));
    expect(queryClient.getQueryData(statusKey(UNKNOWN))).toEqual(
      hookStatus("absent"),
    );
  });
});
