import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { toast } from "sonner";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { GUIDE_SECTIONS } from "@/features/help/content";
import { validateRepo } from "@/lib/git/api";
import { remotesOptions } from "@/lib/git/queries";
import type { RemoteLens, RepoInfo } from "@/lib/git/types";
import {
  useAvailableActions,
  useEffectiveBindings,
  useHotkeyAction,
  useHotkeysListener,
} from "@/lib/hotkeys/hotkeys";
import { useNavHistoryActions } from "@/lib/hotkeys/nav-history-actions";
import { ACTIONS } from "@/lib/hotkeys/registry";
import {
  navigateBySideButton,
  useSideButtonNavigation,
  vetoSideButtonNavigation,
} from "@/lib/hotkeys/side-buttons";
import { cachedLensGone, lensKey } from "@/lib/repo-lens/queries";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import {
  __resetNavHistoryForTests,
  readNavLens,
} from "@/lib/stores/nav-history";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

// The shipped registrations and side-button listener, mounted the way App mounts
// them, behind the real window keydown listener. The settings read is the seam;
// jsdom is not macOS, so the defaults are alt+left / alt+right.
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
// The cross-repository restore's validation seam.
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  validateRepo: vi.fn(),
}));

const REPO = "C:/repos/alpha";
const OTHER = "C:/repos/beta";
const st = () => useUiStore.getState();

const showBranches = vi.fn();

function Host({
  dialogOpen = false,
  withShowBranches = false,
}: {
  dialogOpen?: boolean;
  withShowBranches?: boolean;
}) {
  useHotkeysListener();
  useNavHistoryActions(dialogOpen);
  useSideButtonNavigation();
  const available = useAvailableActions();
  const navRows = (["go-back", "go-forward"] as const).filter((id) =>
    available.has(id),
  );
  const goBackKey = useEffectiveBindings().get("go-back");
  return (
    <>
      <input aria-label="field" />
      <output>{goBackKey === null ? "unbound" : goBackKey}</output>
      <span data-testid="palette">{navRows.join(",")}</span>
      {withShowBranches ? <ShowBranches /> : null}
    </>
  );
}

function ShowBranches() {
  useHotkeyAction("show-branches", showBranches);
  return null;
}

/** A Base UI-shaped open modal holding a focusable button. */
function OpenModal() {
  return (
    <div data-slot="dialog-content" data-open="">
      <button type="button">inside</button>
    </div>
  );
}

function renderHost(
  props: { dialogOpen?: boolean; withShowBranches?: boolean } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = (p: typeof props) => (
    <QueryClientProvider client={client}>
      <Host {...p} />
    </QueryClientProvider>
  );
  const result = render(ui(props));
  return {
    ...result,
    rerenderHost: (p: typeof props) => result.rerender(ui(p)),
  };
}

/** Repo open on Changes, then History: one step back, none forward. */
function enterRepoWithBack() {
  act(() => {
    st().openRepo({ root: REPO, name: "alpha" });
    st().setRepoTab("history");
  });
  expect(st().repoTab).toBe("history");
}

function press(
  key: "ArrowLeft" | "ArrowRight",
  target: EventTarget = window,
  init: KeyboardEventInit = {},
) {
  const event = new KeyboardEvent("keydown", {
    key,
    code: key,
    altKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function mouse(
  type: "mousedown" | "mouseup",
  button: number,
  target: EventTarget = document.body,
) {
  const event = new MouseEvent(type, {
    button,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

/** A full side-button press; both edges returned. */
function click(button: number, target: EventTarget = document.body) {
  return [mouse("mousedown", button, target), mouse("mouseup", button, target)];
}

const extraListeners: [string, EventListener, boolean][] = [];
function addWindowListener(type: string, fn: EventListener, capture = false) {
  extraListeners.push([type, fn, capture]);
  window.addEventListener(type, fn, capture);
}

function resetStore() {
  useUiStore.setState(useUiStore.getInitialState(), true);
  __resetNavHistoryForTests();
}

beforeEach(() => {
  resetStore();
  showBranches.mockReset();
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
});

afterEach(() => {
  for (const [type, fn, capture] of extraListeners.splice(0))
    window.removeEventListener(type, fn, capture);
  // Runs before RTL's cleanup unmounts the host, which re-renders on the reset.
  act(resetStore);
});

afterAll(() => expect(unmockedCommands).toEqual([]));

describe("Go back / Go forward keys", () => {
  it("Alt+Left steps back and Alt+Right steps forward again", async () => {
    const { findByText } = renderHost();
    await findByText("alt+left");
    enterRepoWithBack();
    const back = press("ArrowLeft");
    expect(back.defaultPrevented).toBe(true);
    expect(st().repoTab).toBe("changes");
    const fwd = press("ArrowRight");
    expect(fwd.defaultPrevented).toBe(true);
    expect(st().repoTab).toBe("history");
  });

  it("an empty direction is consumed and changes nothing", async () => {
    const { findByText } = renderHost();
    await findByText("alt+left");
    act(() => st().openRepo({ root: REPO, name: "alpha" }));
    const before = st();
    const back = press("ArrowLeft");
    const fwd = press("ArrowRight");
    expect(back.defaultPrevented).toBe(true);
    expect(fwd.defaultPrevented).toBe(true);
    expect(st().repoTab).toBe(before.repoTab);
    expect(st().interactionEpoch).toBe(before.interactionEpoch);
    expect(st().navHistory).toBe(before.navHistory);
  });

  it("outside the repo view the chord is consumed and nothing runs", async () => {
    const { findByText } = renderHost();
    await findByText("alt+left");
    expect(st().view).not.toBe("repo");
    const before = st();
    expect(press("ArrowLeft").defaultPrevented).toBe(true);
    expect(st()).toBe(before);
  });

  it("an open App dialog consumes the chord without stepping", async () => {
    const { findByText } = renderHost({ dialogOpen: true });
    await findByText("alt+left");
    enterRepoWithBack();
    expect(press("ArrowLeft").defaultPrevented).toBe(true);
    expect(st().repoTab).toBe("history");
  });

  it("focus inside an open modal stands both directions down", async () => {
    const { findByText, getByTestId } = renderHost();
    await findByText("alt+left");
    enterRepoWithBack();
    act(() => st().setRepoTab("compare"));
    act(() => st().goBack());
    // Both directions can run now; only focus decides.
    expect(getByTestId("palette")).toHaveTextContent("go-back,go-forward");
    const modal = render(<OpenModal />);
    const inside = modal.getByRole("button", { name: "inside" });
    inside.focus();
    expect(press("ArrowLeft", inside).defaultPrevented).toBe(true);
    expect(st().repoTab).toBe("history");
    expect(press("ArrowRight", inside).defaultPrevented).toBe(true);
    expect(st().repoTab).toBe("history");
    modal.unmount();
    press("ArrowLeft");
    expect(st().repoTab).toBe("changes");
  });

  it("the palette lists each direction only while it can run", async () => {
    const { findByText, getByTestId, rerenderHost } = renderHost();
    await findByText("alt+left");
    const palette = () => getByTestId("palette").textContent;
    expect(palette()).toBe("");
    enterRepoWithBack();
    expect(palette()).toBe("go-back");
    act(() => st().goBack());
    expect(palette()).toBe("go-forward");
    rerenderHost({ dialogOpen: true });
    expect(palette()).toBe("");
  });
});

describe("text fields and repeats", () => {
  it("Alt+Left fires from a focused text field", async () => {
    const { findByText, getByLabelText } = renderHost();
    await findByText("alt+left");
    enterRepoWithBack();
    const field = getByLabelText("field");
    field.focus();
    expect(press("ArrowLeft", field).defaultPrevented).toBe(true);
    expect(st().repoTab).toBe("changes");
  });

  it("a held key steps once: repeats are neither dispatched nor consumed", async () => {
    const { findByText } = renderHost();
    await findByText("alt+left");
    enterRepoWithBack();
    act(() => st().setRepoTab("compare"));
    press("ArrowLeft");
    expect(st().repoTab).toBe("history");
    const repeat = press("ArrowLeft", window, { repeat: true });
    expect(repeat.defaultPrevented).toBe(false);
    expect(st().repoTab).toBe("history");
  });
});

describe("another action's override on the chord, at the listener", () => {
  it("Alt+Left runs the override's action and never Go back", async () => {
    vi.mocked(loadSettings).mockImplementation(async () => ({
      ...structuredClone(DEFAULT_SETTINGS),
      hotkeys: { "show-branches": "alt+left" },
    }));
    const { findByText } = renderHost({ withShowBranches: true });
    await findByText("unbound");
    enterRepoWithBack();
    expect(press("ArrowLeft").defaultPrevented).toBe(true);
    expect(showBranches).toHaveBeenCalledTimes(1);
    expect(st().repoTab).toBe("history");
  });
});

describe("mouse side buttons", () => {
  it("button 3 steps back on release and button 4 steps forward", async () => {
    const { findByText } = renderHost();
    await findByText("alt+left");
    enterRepoWithBack();
    mouse("mousedown", 3);
    expect(st().repoTab).toBe("history");
    mouse("mouseup", 3);
    expect(st().repoTab).toBe("changes");
    click(4);
    expect(st().repoTab).toBe("history");
  });

  it("both edges are prevented even with an empty history outside the repo view", async () => {
    const { findByText } = renderHost();
    await findByText("alt+left");
    expect(st().view).not.toBe("repo");
    for (const button of [3, 4]) {
      const [down, up] = click(button);
      expect(down.defaultPrevented).toBe(true);
      expect(up.defaultPrevented).toBe(true);
    }
    act(() => st().openRepo({ root: REPO, name: "alpha" }));
    const before = st();
    for (const button of [3, 4]) {
      const [down, up] = click(button);
      expect(down.defaultPrevented).toBe(true);
      expect(up.defaultPrevented).toBe(true);
    }
    expect(st().interactionEpoch).toBe(before.interactionEpoch);
    expect(st().navHistory).toBe(before.navHistory);
  });

  it("buttons 0 to 2 are left alone", async () => {
    const { findByText } = renderHost();
    await findByText("alt+left");
    enterRepoWithBack();
    for (const button of [0, 1, 2]) {
      const [down, up] = click(button);
      expect(down.defaultPrevented).toBe(false);
      expect(up.defaultPrevented).toBe(false);
    }
    expect(st().repoTab).toBe("history");
  });

  it("a release with no press before it still navigates", async () => {
    const { findByText } = renderHost();
    await findByText("alt+left");
    enterRepoWithBack();
    expect(mouse("mouseup", 3).defaultPrevented).toBe(true);
    expect(st().repoTab).toBe("changes");
  });

  it("an App dialog and a focused modal stand the buttons down", async () => {
    const { findByText, rerenderHost } = renderHost({ dialogOpen: true });
    await findByText("alt+left");
    enterRepoWithBack();
    click(3);
    expect(st().repoTab).toBe("history");
    rerenderHost({ dialogOpen: false });
    const modal = render(<OpenModal />);
    const inside = modal.getByRole("button", { name: "inside" });
    inside.focus();
    const [down, up] = click(3, inside);
    expect(down.defaultPrevented).toBe(true);
    expect(up.defaultPrevented).toBe(true);
    expect(st().repoTab).toBe("history");
    modal.unmount();
    click(3);
    expect(st().repoTab).toBe("changes");
  });

  it("navigateBySideButton runs the same dispatch and ignores other buttons", async () => {
    const { findByText } = renderHost();
    await findByText("alt+left");
    enterRepoWithBack();
    let ran = false;
    act(() => {
      ran = navigateBySideButton(1);
    });
    expect(ran).toBe(false);
    act(() => {
      ran = navigateBySideButton(3);
    });
    expect(ran).toBe(true);
    expect(st().repoTab).toBe("changes");
    act(() => {
      ran = navigateBySideButton(3);
    });
    expect(ran).toBe(false);
  });
});

describe("vetoed side-button presses", () => {
  it("a press a surface vetoes after the window listener does not navigate; the next one does", async () => {
    const { findByText } = renderHost();
    await findByText("alt+left");
    enterRepoWithBack();
    const surface = document.createElement("div");
    document.body.append(surface);
    const veto = (e: Event) => vetoSideButtonNavigation(e as MouseEvent);
    surface.addEventListener("mousedown", veto);
    try {
      const [down, up] = click(3, surface);
      expect(down.defaultPrevented).toBe(true);
      expect(up.defaultPrevented).toBe(true);
      expect(st().repoTab).toBe("history");
      surface.removeEventListener("mousedown", veto);
      click(3, surface);
      expect(st().repoTab).toBe("changes");
    } finally {
      surface.remove();
    }
  });

  it("a veto from a capture listener that runs first holds as well", async () => {
    let vetoNext = true;
    addWindowListener(
      "mousedown",
      (e) => {
        if (vetoNext) vetoSideButtonNavigation(e as MouseEvent);
      },
      true,
    );
    const { findByText } = renderHost();
    await findByText("alt+left");
    enterRepoWithBack();
    click(3);
    expect(st().repoTab).toBe("history");
    vetoNext = false;
    click(3);
    expect(st().repoTab).toBe("changes");
  });

  it("a vetoed press whose release never came does not poison the next press", async () => {
    const { findByText } = renderHost();
    await findByText("alt+left");
    enterRepoWithBack();
    addWindowListener(
      "mousedown",
      (e) => vetoSideButtonNavigation(e as MouseEvent),
      false,
    );
    mouse("mousedown", 3);
    for (const [type, fn, capture] of extraListeners.splice(0))
      window.removeEventListener(type, fn, capture);
    click(3);
    expect(st().repoTab).toBe("changes");
  });

  it("a primary-button press is not prevented and vetoes no side-button release", async () => {
    const { findByText } = renderHost();
    await findByText("alt+left");
    enterRepoWithBack();
    addWindowListener(
      "mousedown",
      (e) => vetoSideButtonNavigation(e as MouseEvent),
      false,
    );
    const [down] = click(0);
    expect(down.defaultPrevented).toBe(false);
    for (const [type, fn, capture] of extraListeners.splice(0))
      window.removeEventListener(type, fn, capture);
    mouse("mouseup", 3);
    expect(st().repoTab).toBe("changes");
  });
});

describe("the help guide's shortcut tokens", () => {
  it("names a current action in every kbd token", () => {
    const actionIds = new Set<string>(ACTIONS.map((a) => a.id));
    const used = new Set<string>();
    for (const section of GUIDE_SECTIONS)
      for (const [, id] of section.body.matchAll(/\{\{kbd:([^}]*)\}\}/g))
        used.add(id);
    expect(used.has("go-back")).toBe(true);
    expect(used.has("go-forward")).toBe(true);
    expect([...used].filter((id) => !actionIds.has(id))).toEqual([]);
  });
});

describe("the history's lens reader", () => {
  it("is registered on mount over the cached lens, and removed on unmount", () => {
    const client = new QueryClient();
    expect(readNavLens(REPO)).toBeNull();
    const host = render(
      <QueryClientProvider client={client}>
        <Host />
      </QueryClientProvider>,
    );
    // Inputs still unanswered: the provisional lens is no verdict.
    expect(readNavLens(REPO)).toBeNull();
    // One input at a time: the raw lens alone, then with only some of the gate's
    // inputs, is still no verdict.
    client.setQueryData(lensKey(REPO), "upstream");
    expect(readNavLens(REPO)).toBeNull();
    client.setQueryData(remotesOptions(REPO).queryKey, ["origin"]);
    expect(readNavLens(REPO)).toBeNull();
    // Complete, the GATED lens answers: no upstream remote, so "origin" over a
    // raw "upstream".
    client.setQueryData(["repo", REPO, "forge-status"], {
      provider: "github",
      authenticated: true,
    });
    expect(readNavLens(REPO)).toBe("origin");
    client.setQueryData(remotesOptions(REPO).queryKey, ["origin", "upstream"]);
    expect(readNavLens(REPO)).toBe("upstream");
    client.setQueryData(["repo", REPO, "forge-status"], {
      provider: "github",
      authenticated: false,
    });
    expect(readNavLens(REPO)).toBe("origin");
    client.setQueryData(["repo", REPO, "forge-status"], {
      provider: "github",
      authenticated: true,
    });
    client.setQueryData(lensKey(REPO), "origin");
    expect(readNavLens(REPO)).toBe("origin");
    // The reverse order: the gate's inputs first, then the lens.
    client.setQueryData(["repo", OTHER, "forge-status"], {
      provider: "github",
      authenticated: true,
    });
    client.setQueryData(remotesOptions(OTHER).queryKey, ["origin", "upstream"]);
    expect(readNavLens(OTHER)).toBeNull();
    client.setQueryData(lensKey(OTHER), "upstream");
    expect(readNavLens(OTHER)).toBe("upstream");
    host.unmount();
    expect(readNavLens(REPO)).toBeNull();
  });
});

describe("Go back and Go forward across repositories", () => {
  const answers = (root: string) =>
    vi.mocked(validateRepo).mockResolvedValue({ root, name: "x" } as RepoInfo);
  const settle = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  const carry = (repoPath: string, number: number) =>
    st().openIssue({
      repoPath,
      repoName: repoPath === REPO ? "alpha" : "beta",
      number,
      carryHistory: true,
    });

  /** Alpha on History, then a carried landing in beta: Back crosses into alpha. */
  async function hostAcross() {
    const host = renderHost();
    await host.findByText("alt+left");
    act(() => {
      st().openRepo({ root: REPO, name: "alpha" });
      st().setRepoTab("history");
      carry(OTHER, 2);
    });
    expect(st().repoPath).toBe(OTHER);
    return host;
  }

  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.mocked(validateRepo).mockReset();
    error = vi.spyOn(toast, "error").mockImplementation(() => "");
  });
  afterEach(() => error.mockRestore());

  it("Alt+Left lands when validateRepo answers the same root, under its path normalization", async () => {
    await hostAcross();
    answers("c:\\Repos\\Alpha");
    press("ArrowLeft");
    expect(validateRepo).toHaveBeenCalledExactlyOnceWith(REPO);
    expect(st().repoPath).toBe(OTHER);
    await settle();
    expect(st()).toMatchObject({ repoPath: REPO, repoTab: "history" });
    expect(error).not.toHaveBeenCalled();
  });

  const rejects = (e: unknown) => () =>
    vi.mocked(validateRepo).mockRejectedValue(e);
  const GONE = (name: string) =>
    `Can't go back to ${name}. Its folder is missing or is no longer a Git repository.`;
  const REFUSED = (name: string) =>
    `Can't go back to ${name}. Git can't open its folder.`;
  const UNCHECKED = (name: string) => `Couldn't check ${name}. Try again.`;

  it.each([
    ["answers an enclosing repository", answers.bind(null, "C:/repos"), GONE],
    [
      "rejects as not a repository",
      rejects({ kind: "notARepo", message: "x" }),
      GONE,
    ],
    [
      "rejects with git's fatal exit",
      rejects({ kind: "git", message: "x", code: 128, stderr: "fatal: x" }),
      REFUSED,
    ],
    [
      "rejects with a missing core.worktree",
      rejects({ kind: "command", message: "x" }),
      REFUSED,
    ],
  ])(
    "when validateRepo %s, one toast and every stop there goes",
    async (_n, arrange, copy) => {
      await hostAcross();
      act(() => {
        carry(REPO, 3);
        carry(OTHER, 4);
      });
      arrange();
      press("ArrowLeft");
      await settle();
      expect(error).toHaveBeenCalledExactlyOnceWith(copy("alpha"));
      expect(st().repoPath).toBe(OTHER);
      expect(st().navHistory.segments.map((s) => s.repoPath)).toEqual([OTHER]);
      // The stops are gone, so the next press stays in beta and says nothing.
      press("ArrowLeft");
      await settle();
      expect(error).toHaveBeenCalledTimes(1);
      expect(validateRepo).toHaveBeenCalledTimes(1);
      expect(st().repoPath).toBe(OTHER);
    },
  );

  it.each([
    ["a timeout", { kind: "timeout", message: "x" }],
    ["an io failure", { kind: "io", message: "x" }],
    ["git missing", { kind: "gitNotFound", message: "x" }],
    ["a killed git", { kind: "git", message: "x", code: -1, stderr: "" }],
    ["a git failure with no exit code", { kind: "git", message: "x" }],
    ["a plain Error", new Error("ipc")],
    ["null", null],
  ])(
    "when validateRepo rejects with %s, it couldn't check: one toast, every stop kept, then a press that lands",
    async (_n, rejection) => {
      await hostAcross();
      vi.mocked(validateRepo).mockRejectedValueOnce(rejection);
      press("ArrowLeft");
      await settle();
      expect(error).toHaveBeenCalledExactlyOnceWith(UNCHECKED("alpha"));
      expect(st().repoPath).toBe(OTHER);
      expect(st().navHistory.segments.map((s) => s.repoPath)).toEqual([
        REPO,
        OTHER,
      ]);
      answers(REPO);
      press("ArrowLeft");
      await settle();
      expect(validateRepo).toHaveBeenCalledTimes(2);
      expect(st()).toMatchObject({ repoPath: REPO, repoTab: "history" });
      expect(error).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [
      "gone",
      { kind: "notARepo", message: "x" },
      "Its folder is missing or is no longer a Git repository.",
    ],
    [
      "refused",
      { kind: "git", message: "x", code: 128, stderr: "fatal: x" },
      "Git can't open its folder.",
    ],
  ])(
    "Forward's %s toast names the direction; button 3 runs the same route",
    async (_n, rejection, reason) => {
      await hostAcross();
      answers(REPO);
      click(3);
      await settle();
      expect(st().repoPath).toBe(REPO);
      vi.mocked(validateRepo).mockRejectedValue(rejection);
      press("ArrowRight");
      await settle();
      expect(error).toHaveBeenCalledExactlyOnceWith(
        `Can't go forward to beta. ${reason}`,
      );
      expect(st().repoPath).toBe(REPO);
    },
  );

  it("Forward's couldn't-check toast is the same as Back's", async () => {
    await hostAcross();
    answers(REPO);
    press("ArrowLeft");
    await settle();
    expect(st().repoPath).toBe(REPO);
    vi.mocked(validateRepo).mockRejectedValue({ kind: "io", message: "x" });
    press("ArrowRight");
    await settle();
    expect(error).toHaveBeenCalledExactlyOnceWith(UNCHECKED("beta"));
    expect(st().repoPath).toBe(REPO);
  });

  it.each(
    (
      [
        ["gone", { kind: "notARepo", message: "x" }, GONE],
        ["refused", { kind: "command", message: "x" }, REFUSED],
        ["unknown", { kind: "timeout", message: "x" }, UNCHECKED],
      ] as const
    ).flatMap(([answer, rejection, copy]) => [
      [answer, "Alpha Prime", rejection, copy("Alpha Prime")] as const,
      [answer, null, rejection, copy("alpha")] as const,
    ]),
  )(
    "the %s toast names the segment's repository name %s, else its folder",
    async (_n, repoName, rejection, expected) => {
      await hostAcross();
      act(() => {
        const h = st().navHistory;
        useUiStore.setState({
          navHistory: {
            ...h,
            segments: h.segments.map((s, i) =>
              i === 0 ? { ...s, repoName } : s,
            ),
          },
        });
      });
      vi.mocked(validateRepo).mockRejectedValue(rejection);
      press("ArrowLeft");
      await settle();
      expect(error).toHaveBeenCalledExactlyOnceWith(expected);
    },
  );

  describe("the folder check's limit", () => {
    /** A `validateRepo` answered by hand; every case settles it before it ends, since
     *  the hotkey layer shares an in-flight check per folder. */
    function deferredRepo() {
      const hands: {
        resolve: (info: RepoInfo) => void;
        reject: (e: unknown) => void;
      }[] = [];
      vi.mocked(validateRepo).mockImplementation(
        () =>
          new Promise<RepoInfo>((resolve, reject) => {
            hands.push({ resolve, reject });
          }),
      );
      return {
        resolve: (root: string) => {
          for (const h of hands) h.resolve({ root, name: "x" } as RepoInfo);
        },
        reject: (e: unknown) => {
          for (const h of hands) h.reject(e);
        },
      };
    }
    // Fake timers only after `hostAcross`, whose findByText polls on real ones; no
    // findBy*, waitFor or settle() while they are on.
    const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
    afterEach(() => {
      vi.useRealTimers();
    });

    it("a check slower than 10 s says it couldn't check at the limit, and its late answer reaches nothing", async () => {
      await hostAcross();
      const check = deferredRepo();
      vi.useFakeTimers();
      try {
        press("ArrowLeft");
        const pressed = st();
        await advance(9_999);
        expect(error).not.toHaveBeenCalled();
        await advance(1);
        expect(error).toHaveBeenCalledExactlyOnceWith(UNCHECKED("alpha"));
        expect(st()).toBe(pressed);
        await act(async () => {
          check.reject({ kind: "notARepo", message: "x" });
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(error).toHaveBeenCalledTimes(1);
        expect(st()).toBe(pressed);
        expect(st().navHistory.segments).toHaveLength(2);
      } finally {
        check.reject({ kind: "io", message: "cleanup" });
        await advance(0);
      }
    });

    it("a second press while the check is in flight shares it under its own limit, and a settled check is asked anew", async () => {
      await hostAcross();
      const check = deferredRepo();
      vi.useFakeTimers();
      try {
        press("ArrowLeft");
        await advance(10_000);
        expect(error).toHaveBeenCalledTimes(1);
        await advance(2_000);
        press("ArrowLeft");
        expect(validateRepo).toHaveBeenCalledTimes(1);
        await advance(9_999);
        expect(error).toHaveBeenCalledTimes(1);
        await advance(1);
        expect(error).toHaveBeenCalledTimes(2);
        expect(error).toHaveBeenLastCalledWith(UNCHECKED("alpha"));
        expect(st().repoPath).toBe(OTHER);
        await act(async () => {
          check.resolve(REPO);
          await vi.advanceTimersByTimeAsync(0);
        });
        answers(REPO);
        press("ArrowLeft");
        expect(validateRepo).toHaveBeenCalledTimes(2);
        await advance(0);
        expect(st()).toMatchObject({ repoPath: REPO, repoTab: "history" });
        expect(error).toHaveBeenCalledTimes(2);
      } finally {
        check.resolve(REPO);
        await advance(0);
      }
    });

    it("a second press inside the first press's window shares its check and replaces it", async () => {
      await hostAcross();
      const check = deferredRepo();
      vi.useFakeTimers();
      try {
        press("ArrowLeft");
        await advance(3_000);
        press("ArrowLeft");
        expect(validateRepo).toHaveBeenCalledTimes(1);
        // The first press's limit passes: it was replaced, so it says nothing.
        await advance(7_000);
        expect(error).not.toHaveBeenCalled();
        expect(st().repoPath).toBe(OTHER);
        const epoch = st().interactionEpoch;
        await act(async () => {
          check.resolve(REPO);
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(st()).toMatchObject({ repoPath: REPO, repoTab: "history" });
        expect(st().navHistory).toMatchObject({ segment: 0 });
        expect(st().navHistory.segments.map((s) => s.repoPath)).toEqual([
          REPO,
          OTHER,
        ]);
        expect(st().interactionEpoch).toBe(epoch);
        await advance(10_000);
        expect(error).not.toHaveBeenCalled();
        expect(validateRepo).toHaveBeenCalledTimes(1);
      } finally {
        check.resolve(REPO);
        await advance(0);
      }
    });

    it("folders whose paths differ only by letter case get a check each", async () => {
      const ALPHA_UPPER = "C:/repos/ALPHA";
      await hostAcross();
      act(() => carry(ALPHA_UPPER, 5));
      answers(OTHER);
      press("ArrowLeft");
      await settle();
      expect(st().repoPath).toBe(OTHER);
      expect(st().navHistory.segments.map((s) => s.repoPath)).toEqual([
        REPO,
        OTHER,
        ALPHA_UPPER,
      ]);
      vi.mocked(validateRepo).mockClear();
      const check = deferredRepo();
      vi.useFakeTimers();
      try {
        press("ArrowLeft");
        press("ArrowRight");
        expect(vi.mocked(validateRepo).mock.calls).toEqual([
          [REPO],
          [ALPHA_UPPER],
        ]);
      } finally {
        check.resolve(REPO);
        await advance(0);
      }
    });

    it("a shared check that answers open inside the second press's window lands it", async () => {
      await hostAcross();
      const check = deferredRepo();
      vi.useFakeTimers();
      try {
        press("ArrowLeft");
        await advance(12_000);
        expect(error).toHaveBeenCalledTimes(1);
        press("ArrowLeft");
        await advance(3_000);
        await act(async () => {
          check.resolve(REPO);
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(validateRepo).toHaveBeenCalledTimes(1);
        expect(st()).toMatchObject({ repoPath: REPO, repoTab: "history" });
        await advance(10_000);
        expect(error).toHaveBeenCalledTimes(1);
      } finally {
        check.resolve(REPO);
        await advance(0);
      }
    });

    it("a check that answers inside the limit lands and leaves no timer behind", async () => {
      await hostAcross();
      const check = deferredRepo();
      vi.useFakeTimers();
      try {
        const timers = vi.getTimerCount();
        press("ArrowLeft");
        await advance(9_999);
        expect(st().repoPath).toBe(OTHER);
        await act(async () => {
          check.resolve(REPO);
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(st()).toMatchObject({ repoPath: REPO, repoTab: "history" });
        expect(vi.getTimerCount()).toBe(timers);
        expect(error).not.toHaveBeenCalled();
      } finally {
        check.resolve(REPO);
        await advance(0);
      }
    });
  });

  it("re-applies the segment's lens through the lens cache", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    for (const [repo, l] of [
      [REPO, "upstream"],
      [OTHER, "origin"],
    ] as const) {
      client.setQueryData(["repo", repo, "forge-status"], {
        provider: "github",
        authenticated: true,
      });
      client.setQueryData(remotesOptions(repo).queryKey, [
        "origin",
        "upstream",
      ]);
      client.setQueryData(lensKey(repo), l);
    }
    const host = render(
      <QueryClientProvider client={client}>
        <Host />
      </QueryClientProvider>,
    );
    await host.findByText("alt+left");
    act(() => {
      st().openRepo({ root: REPO, name: "alpha" });
      carry(OTHER, 2);
    });
    expect(st().navHistory.segments.map((s) => s.lens)).toEqual([
      "upstream",
      "origin",
    ]);
    act(() => client.setQueryData(lensKey(REPO), "origin"));
    answers(REPO);
    press("ArrowLeft");
    await settle();
    expect(st().repoPath).toBe(REPO);
    expect(client.getQueryData(lensKey(REPO))).toBe("upstream");
  });

  describe("a stop recorded on Upstream", () => {
    const ISSUE = { kind: "remote", id: "7" } as const;
    const FORGE = ["repo", REPO, "forge-status"] as const;

    /** Alpha's Issues stop with a remote issue, recorded under `recorded` while every
     *  lens cache is complete and the gate is open, then a carried landing in beta.
     *  Each case changes the caches only after the stamp was read. */
    async function hostRecordedStop(recorded: RemoteLens) {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      client.setQueryData(FORGE, { provider: "github", authenticated: true });
      client.setQueryData(remotesOptions(REPO).queryKey, [
        "origin",
        "upstream",
      ]);
      client.setQueryData(lensKey(REPO), recorded);
      const host = render(
        <QueryClientProvider client={client}>
          <Host />
        </QueryClientProvider>,
      );
      await host.findByText("alt+left");
      act(() => {
        st().openRepo({ root: REPO, name: "alpha" });
        st().setRepoTab("issues");
        st().selectIssue(ISSUE);
        carry(OTHER, 2);
      });
      expect(st().navHistory.segments.map((s) => s.lens)).toEqual([
        recorded,
        null,
      ]);
      answers(REPO);
      return client;
    }

    /** Presses Back with the lens cache seeded at `seeded`, written at a known time so
     *  a same-value write shows in `dataUpdatedAt`. */
    async function back(client: QueryClient, seeded: RemoteLens) {
      act(() => client.setQueryData(lensKey(REPO), seeded, { updatedAt: 1 }));
      press("ArrowLeft");
      await settle();
      expect(st()).toMatchObject({ repoPath: REPO, repoTab: "issues" });
      expect(error).not.toHaveBeenCalled();
    }

    it("lands on Upstream with the issue while the remotes still hold upstream", async () => {
      const client = await hostRecordedStop("upstream");
      await back(client, "origin");
      expect(st().selectedIssue).toEqual(ISSUE);
      expect(client.getQueryData(lensKey(REPO))).toBe("upstream");
    });

    it.each([
      ["with the forge status cached", (_: QueryClient) => undefined],
      [
        "with no forge status cached",
        (c: QueryClient) => c.removeQueries({ queryKey: FORGE, exact: true }),
      ],
    ])(
      "drops the issue and writes no lens once upstream is removed, %s",
      async (_, change) => {
        const client = await hostRecordedStop("upstream");
        act(() => {
          client.setQueryData(remotesOptions(REPO).queryKey, ["origin"]);
          change(client);
        });
        await back(client, "origin");
        expect(st().selectedIssue).toBeNull();
        expect(client.getQueryData(lensKey(REPO))).toBe("origin");
        expect(client.getQueryState(lensKey(REPO))?.dataUpdatedAt).toBe(1);
      },
    );

    it.each([
      [
        "no remotes cache",
        (c: QueryClient) =>
          c.removeQueries({
            queryKey: remotesOptions(REPO).queryKey,
            exact: true,
          }),
      ],
      [
        "remotes holding upstream, signed out",
        (c: QueryClient) =>
          c.setQueryData(FORGE, { provider: "github", authenticated: false }),
      ],
    ])(
      "with %s, applies the lens and restores the issue as before",
      async (_, change) => {
        const client = await hostRecordedStop("upstream");
        act(() => change(client));
        await back(client, "origin");
        expect(st().selectedIssue).toEqual(ISSUE);
        expect(client.getQueryData(lensKey(REPO))).toBe("upstream");
      },
    );

    it("cachedLensGone answers from the remotes list alone", () => {
      const forges = [
        { provider: "github", authenticated: true },
        { provider: "github", authenticated: false },
        undefined,
      ];
      const remoteLists = [["origin", "upstream"], ["origin"], [], undefined];
      for (const forge of forges)
        for (const remotes of remoteLists)
          for (const raw of ["origin", "upstream", undefined] as const)
            for (const recorded of ["origin", "upstream"] as const) {
              const client = new QueryClient();
              if (forge) client.setQueryData(FORGE, forge);
              if (remotes)
                client.setQueryData(remotesOptions(REPO).queryKey, remotes);
              if (raw) client.setQueryData(lensKey(REPO), raw);
              expect(
                cachedLensGone(client, REPO, recorded),
                JSON.stringify({ forge, remotes, raw, recorded }),
              ).toBe(
                recorded === "upstream" &&
                  remotes !== undefined &&
                  !remotes.includes("upstream"),
              );
            }
    });

    it("a stop recorded on the fork applies its lens and restores the issue with upstream removed", async () => {
      const client = await hostRecordedStop("origin");
      act(() => client.setQueryData(remotesOptions(REPO).queryKey, ["origin"]));
      await back(client, "upstream");
      expect(st().selectedIssue).toEqual(ISSUE);
      expect(client.getQueryData(lensKey(REPO))).toBe("origin");
    });
  });
});
