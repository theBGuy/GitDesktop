import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  type LocalMergeStripArm,
  LocalPrMergeStrip,
  type LocalStripResolve,
  type PrMergeabilityArm,
  PrMergeabilityBanner,
  type PromotionKind,
} from "@/features/pulls/PrMergeabilityBanner";
import { getSecret } from "@/lib/git/api";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { unmockedCommands } from "./setup";

// The remote banner's only hooks read settings and the review provider's stored
// key; the local strip reads nothing.
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  getSecret: vi.fn(),
}));

afterAll(() => expect(unmockedCommands).toEqual([]));

type StripProps = ComponentProps<typeof LocalPrMergeStrip>;

function stripProps(over: Partial<StripProps> = {}): StripProps {
  return {
    arm: "clean",
    base: "main",
    head: "feature",
    promotionKind: null,
    behindBy: 0,
    conflictFiles: [],
    approved: false,
    offerUpdate: false,
    offerResolve: false,
    updateHeldReason: undefined,
    promotionSettlingReason: undefined,
    onUpdateBranch: vi.fn(),
    onRetry: vi.fn(),
    retryBusy: false,
    resolve: null,
    ...over,
  };
}

function resolveSlot(over: Partial<LocalStripResolve> = {}): LocalStripResolve {
  return {
    unfinished: false,
    preparing: false,
    heldReason: undefined,
    onResolve: vi.fn(),
    onDiscard: vi.fn(),
    ...over,
  };
}

function renderStrip(over: Partial<StripProps> = {}) {
  const props = stripProps(over);
  const view = render(<LocalPrMergeStrip {...props} />);
  return {
    ...view,
    props,
    rerenderStrip: (next: Partial<StripProps>) =>
      view.rerender(
        <LocalPrMergeStrip {...stripProps({ ...over, ...next })} />,
      ),
  };
}

/** The strip's root, its line span, the line's icon and its sentence span. */
function parts(container: HTMLElement) {
  const root = container.firstElementChild as HTMLElement;
  const line = root.firstElementChild as HTMLElement;
  return {
    root,
    line,
    icon: line.firstElementChild as Element,
    sentence: line.lastElementChild as HTMLElement,
  };
}

const ACTIONS = [
  "Retry",
  "Update branch",
  "Resolve conflicts",
  "Continue resolving",
  "Discard",
] as const;

function expectActions(present: readonly string[]) {
  for (const name of ACTIONS) {
    if (present.includes(name))
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    else expect(screen.queryByRole("button", { name })).toBeNull();
  }
}

const PROMOTION_SENTENCE =
  "main has 3 commits that feature doesn't. feature is the repository's default branch, so this gap is expected and doesn't need closing. Updating the branch would merge main back into feature.";

describe("LocalPrMergeStrip states", () => {
  // One row per state of the strip's table: [name, props, sentence, actions].
  const rows: [string, Partial<StripProps>, string, string[]][] = [
    ["checking", { arm: "checking" }, "Checking for conflicts…", []],
    ["clean", { arm: "clean" }, "No conflicts with main.", []],
    [
      "behind, singular",
      { arm: "behind", behindBy: 1, offerUpdate: true },
      "This branch is 1 commit behind main.",
      ["Update branch"],
    ],
    [
      "behind, plural",
      { arm: "behind", behindBy: 3, offerUpdate: true },
      "This branch is 3 commits behind main.",
      ["Update branch"],
    ],
    [
      "promotion gap",
      { arm: "promotion-gap", behindBy: 3, promotionKind: "default" },
      PROMOTION_SENTENCE,
      [],
    ],
    [
      "conflicted, resolve offered",
      {
        arm: "conflicted",
        offerResolve: true,
        resolve: resolveSlot(),
        conflictFiles: ["a.ts"],
      },
      "Merging into main will conflict.",
      ["Resolve conflicts"],
    ],
    [
      "conflicted, resolve not offered",
      { arm: "conflicted", conflictFiles: ["a.ts"] },
      "Merging into main will conflict. Approve, then Merge to resolve the conflicts.",
      [],
    ],
    [
      "resume",
      { arm: "resume", resolve: resolveSlot({ unfinished: true }) },
      "An unfinished conflict resolution exists for this PR.",
      ["Discard", "Continue resolving"],
    ],
    [
      "updating",
      {
        arm: "updating",
        behindBy: 3,
        offerUpdate: true,
        updateHeldReason: "Updating this branch…",
      },
      "Updating feature from main…",
      ["Update branch"],
    ],
    [
      "failed",
      { arm: "failed" },
      "Conflicts with main can't be checked right now.",
      ["Retry"],
    ],
    [
      "failed, behind",
      { arm: "failed", behindBy: 2, offerUpdate: true },
      "Conflicts with main can't be checked right now. This branch is 2 commits behind main.",
      ["Retry", "Update branch"],
    ],
    [
      "unchecked",
      { arm: "unchecked" },
      "Conflicts with main can't be checked.",
      [],
    ],
    [
      "unchecked, behind",
      { arm: "unchecked", behindBy: 1, offerUpdate: true },
      "Conflicts with main can't be checked. This branch is 1 commit behind main.",
      ["Update branch"],
    ],
    [
      "unchecked, no base",
      { arm: "unchecked", base: "" },
      "Conflicts can't be checked.",
      [],
    ],
    [
      "failed, no base",
      { arm: "failed", base: "" },
      "Conflicts can't be checked right now.",
      ["Retry"],
    ],
  ];

  it.each(rows)("%s", (_name, over, sentence, actions) => {
    const { container } = renderStrip(over);
    const { root, sentence: span } = parts(container);
    expect(span.textContent).toBe(sentence);
    expect(root).toHaveTextContent(sentence);
    expectActions(actions);
  });

  // The long lines wrap so "Approve, then Merge…" is never clipped and a "can't
  // be checked" line never clips to a conflict; every other line truncates.
  const WRAPPING = new Set([
    "promotion gap",
    "conflicted, resolve not offered",
    "failed",
    "failed, behind",
    "failed, no base",
    "unchecked",
    "unchecked, behind",
    "unchecked, no base",
  ]);

  it.each(rows)("%s wraps or truncates as its row says", (name, over) => {
    const { container } = renderStrip(over);
    const { line, sentence } = parts(container);
    if (WRAPPING.has(name)) {
      expect(sentence).not.toHaveClass("truncate");
      expect(line).toHaveClass("items-start");
      expect(line).not.toHaveClass("items-center");
    } else {
      expect(sentence).toHaveClass("truncate");
      expect(line).toHaveClass("items-center");
      expect(line).not.toHaveClass("items-start");
    }
  });

  it("both layouts are covered", () => {
    const names = rows.map(([name]) => name);
    for (const name of WRAPPING) expect(names).toContain(name);
    expect(names.length).toBeGreaterThan(WRAPPING.size);
  });

  it.each([
    ["clean", { arm: "clean" }, "No conflicts with main."],
    [
      "conflicted",
      { arm: "conflicted", conflictFiles: ["a.ts"] },
      "Merging into main will conflict. Approve, then Merge to resolve the conflicts.",
    ],
  ] as [string, Partial<StripProps>, string][])(
    "the root is a group named by its %s sentence without focus",
    (_name, over, sentence) => {
      const { container } = renderStrip(over);
      const { root, sentence: span } = parts(container);
      expect(root).toHaveAttribute("role", "group");
      expect(root.getAttribute("aria-labelledby")).toBe(span.id);
      expect(document.activeElement).not.toBe(root);
      expect(screen.getByRole("group")).toBe(root);
      expect(root).toHaveAccessibleName(sentence);
    },
  );

  it("an unchecked line never says right now and offers no Retry", () => {
    const { container } = renderStrip({
      arm: "unchecked",
      behindBy: 2,
      offerUpdate: true,
    });
    expect(parts(container).sentence.textContent).not.toContain("right now");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("an arm that offers no update draws none, whatever offerUpdate says", () => {
    renderStrip({ arm: "conflicted", behindBy: 3, offerUpdate: true });
    expect(screen.queryByRole("button", { name: "Update branch" })).toBeNull();
  });
});

describe("LocalPrMergeStrip tone", () => {
  const arms: [Exclude<LocalMergeStripArm, null>, Partial<StripProps>][] = [
    ["checking", {}],
    ["clean", {}],
    ["behind", { behindBy: 2, offerUpdate: true }],
    ["promotion-gap", { behindBy: 2, promotionKind: "configured" }],
    ["resume", { resolve: resolveSlot({ unfinished: true }) }],
    ["updating", {}],
    ["failed", {}],
    ["unchecked", {}],
  ];

  it.each(arms)("%s reads muted with a hidden icon", (arm, over) => {
    const { container } = renderStrip({ arm, ...over });
    const { line, icon } = parts(container);
    expect(line).toHaveClass("text-muted-foreground");
    expect(line).not.toHaveClass("text-warning");
    expect(icon).toHaveAttribute("aria-hidden", "true");
  });

  it.each([
    ["offered", { offerResolve: true, resolve: resolveSlot() }],
    ["not offered", {}],
  ] as [string, Partial<StripProps>][])(
    "conflicted (%s) reads in the warning tone with a hidden icon",
    (_name, over) => {
      const { container } = renderStrip({ arm: "conflicted", ...over });
      const { line, icon } = parts(container);
      expect(line).toHaveClass("text-warning");
      expect(line).not.toHaveClass("text-muted-foreground");
      expect(icon).toHaveAttribute("aria-hidden", "true");
    },
  );
});

describe("LocalPrMergeStrip clip tooltip", () => {
  /** Makes `el` read as clipped, then hovers it so `clipTitleFromText` titles it. */
  function hoverClipped(el: HTMLElement) {
    Object.defineProperty(el, "scrollWidth", {
      value: 400,
      configurable: true,
    });
    Object.defineProperty(el, "clientWidth", {
      value: 100,
      configurable: true,
    });
    fireEvent.mouseEnter(el);
  }

  it("a clipped single line's tooltip never carries into a wrapping line", () => {
    const { container, rerenderStrip } = renderStrip({
      arm: "behind",
      behindBy: 3,
      offerUpdate: true,
    });
    const before = parts(container).sentence;
    hoverClipped(before);
    expect(before).toHaveAttribute(
      "title",
      "This branch is 3 commits behind main.",
    );

    rerenderStrip({ arm: "conflicted", conflictFiles: ["a.ts"] });
    const after = parts(container).sentence;
    expect(after.textContent).toContain("Approve, then Merge");
    expect(after).not.toBe(before);
    expect(after).not.toHaveAttribute("title");
  });

  it("negative control: a same-slot span swap without keys keeps the stale title", () => {
    // Hand-built twin of the strip's line slot, minus the keys.
    function Slot({ wraps, text }: { wraps: boolean; text: string }) {
      return (
        <div>
          {wraps ? (
            <span className="min-w-0">{text}</span>
          ) : (
            <span className="min-w-0 truncate">{text}</span>
          )}
        </div>
      );
    }
    const { container, rerender } = render(
      <Slot wraps={false} text="short line" />,
    );
    const before = container.querySelector("span") as HTMLElement;
    before.title = "short line";
    rerender(<Slot wraps text="long line" />);
    const after = container.querySelector("span") as HTMLElement;
    expect(after).toBe(before);
    expect(after).toHaveAttribute("title", "short line");
  });
});

describe("LocalPrMergeStrip conflict files", () => {
  const paths = (n: number) =>
    Array.from({ length: n }, (_, i) => `src/file-${i}.ts`);

  it("draws no list without paths", () => {
    renderStrip({ arm: "conflicted", conflictFiles: [] });
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("draws a row per path up to five", () => {
    renderStrip({ arm: "conflicted", conflictFiles: paths(5) });
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.queryByText(/more$/)).toBeNull();
  });

  it("collapses the rest into a titled count", () => {
    const files = paths(7);
    renderStrip({
      arm: "conflicted",
      offerResolve: true,
      resolve: resolveSlot(),
      conflictFiles: files,
    });
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(6);
    const more = items[5];
    expect(more).toHaveTextContent("and 2 more");
    expect(more).toHaveAttribute("title", files.join("\n"));
  });

  it("names the count row by its text, not its tooltip", () => {
    const files = paths(7);
    renderStrip({ arm: "conflicted", conflictFiles: files });
    const more = screen.getAllByRole("listitem")[5];
    expect(more).toHaveAccessibleName("and 2 more");
    // Control: the same row without the label is named by its path list.
    const bare = render(
      <ul>
        <li title={files.join("\n")}>and 2 more</li>
      </ul>,
    );
    const bareItem = within(bare.container).getByRole("listitem");
    expect(bareItem).toHaveAccessibleName(/file-6\.ts/);
  });
});

describe("LocalPrMergeStrip without an offered resolve", () => {
  it("names the Approve-then-Merge route and renders no action", () => {
    const { container } = renderStrip({ arm: "conflicted", resolve: null });
    expect(parts(container).sentence.textContent).toBe(
      "Merging into main will conflict. Approve, then Merge to resolve the conflicts.",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("drops the Approve step once the PR is approved", () => {
    const { container } = renderStrip({ arm: "conflicted", approved: true });
    expect(parts(container).sentence.textContent).toBe(
      "Merging into main will conflict. Merge to resolve the conflicts.",
    );
  });

  it("never promises an editor the state can't reach", () => {
    const states: Partial<StripProps>[] = [
      { arm: "checking" },
      { arm: "clean" },
      { arm: "behind", behindBy: 2, offerUpdate: true },
      { arm: "promotion-gap", behindBy: 2, promotionKind: "default" },
      { arm: "conflicted" },
      { arm: "conflicted", approved: true },
      { arm: "conflicted", offerResolve: true, resolve: resolveSlot() },
      { arm: "resume", resolve: resolveSlot({ unfinished: true }) },
      { arm: "updating" },
      { arm: "failed", behindBy: 2, offerUpdate: true },
      { arm: "unchecked", behindBy: 2, offerUpdate: true },
    ];
    for (const state of states) {
      const { container, unmount } = renderStrip(state);
      expect(container.textContent).not.toContain(
        "resolve the conflicts in an editor",
      );
      unmount();
    }
  });
});

describe("LocalPrMergeStrip resolve seam", () => {
  it("Resolve conflicts starts a resolve", async () => {
    const user = userEvent.setup();
    const resolve = resolveSlot();
    renderStrip({ arm: "conflicted", offerResolve: true, resolve });
    await user.click(screen.getByRole("button", { name: "Resolve conflicts" }));
    expect(resolve.onResolve).toHaveBeenCalledTimes(1);
  });

  it("a preparing resolve reads Preparing… and holds", async () => {
    const user = userEvent.setup();
    const resolve = resolveSlot({ preparing: true });
    renderStrip({ arm: "conflicted", offerResolve: true, resolve });
    const button = screen.getByRole("button", { name: "Preparing…" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription("Preparing…");
    await user.click(button);
    expect(resolve.onResolve).not.toHaveBeenCalled();
  });

  it("a held resolve says why", () => {
    renderStrip({
      arm: "conflicted",
      offerResolve: true,
      resolve: resolveSlot({ heldReason: "Another git operation is running." }),
    });
    const button = screen.getByRole("button", { name: "Resolve conflicts" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription(
      "Another git operation is running.",
    );
  });

  it("the promotion inputs still loading hold a start", () => {
    renderStrip({
      arm: "conflicted",
      offerResolve: true,
      resolve: resolveSlot(),
      promotionSettlingReason: "Checking which branch is the default…",
    });
    const button = screen.getByRole("button", { name: "Resolve conflicts" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription(
      "Checking which branch is the default…",
    );
  });

  it("resume offers Discard and Continue resolving", async () => {
    const user = userEvent.setup();
    const resolve = resolveSlot({ unfinished: true });
    renderStrip({ arm: "resume", resolve });
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(resolve.onDiscard).toHaveBeenCalledTimes(1);
    await user.click(
      screen.getByRole("button", { name: "Continue resolving" }),
    );
    expect(resolve.onResolve).toHaveBeenCalledTimes(1);
  });

  it("one held reason holds both resume actions", async () => {
    const user = userEvent.setup();
    const resolve = resolveSlot({
      unfinished: true,
      heldReason: "Finishing the resolve…",
    });
    renderStrip({ arm: "resume", resolve });
    for (const name of ["Discard", "Continue resolving"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).toHaveAccessibleDescription("Finishing the resolve…");
      await user.click(button);
    }
    expect(resolve.onDiscard).not.toHaveBeenCalled();
    expect(resolve.onResolve).not.toHaveBeenCalled();
  });
});

describe("LocalPrMergeStrip Update branch", () => {
  it("an enabled press updates the branch", async () => {
    const user = userEvent.setup();
    const { props } = renderStrip({
      arm: "behind",
      behindBy: 2,
      offerUpdate: true,
    });
    const button = screen.getByRole("button", { name: "Update branch" });
    expect(button).toHaveAttribute("title", "Merges main into feature");
    await user.click(button);
    expect(props.onUpdateBranch).toHaveBeenCalledTimes(1);
  });

  it("a held update stays focusable, says why and does nothing", async () => {
    const user = userEvent.setup();
    const { props } = renderStrip({
      arm: "behind",
      behindBy: 2,
      offerUpdate: true,
      updateHeldReason: "Another git operation is running.",
    });
    const button = screen.getByRole("button", { name: "Update branch" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(button).toHaveAccessibleDescription(
      "Another git operation is running.",
    );
    await user.click(button);
    expect(props.onUpdateBranch).not.toHaveBeenCalled();
  });

  it("the updating arm keeps the button mounted", () => {
    renderStrip({
      arm: "updating",
      behindBy: 2,
      offerUpdate: true,
      updateHeldReason: "Updating this branch…",
    });
    expect(
      screen.getByRole("button", { name: "Update branch" }),
    ).toHaveAccessibleDescription("Updating this branch…");
  });

  it("has no options caret in any state", () => {
    const arms: Exclude<LocalMergeStripArm, null>[] = [
      "checking",
      "clean",
      "behind",
      "promotion-gap",
      "conflicted",
      "resume",
      "updating",
      "failed",
      "unchecked",
    ];
    for (const arm of arms) {
      const { unmount } = renderStrip({
        arm,
        behindBy: 2,
        offerUpdate: true,
        resolve: resolveSlot({ unfinished: arm === "resume" }),
      });
      expect(
        screen.queryByRole("button", { name: "Update branch options" }),
      ).toBeNull();
      unmount();
    }
  });
});

describe("LocalPrMergeStrip Retry", () => {
  it("a failed check retries", async () => {
    const user = userEvent.setup();
    const { props } = renderStrip({ arm: "failed" });
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  it("a running retry holds with the checking line", () => {
    renderStrip({ arm: "failed", retryBusy: true });
    const button = screen.getByRole("button", { name: "Retry" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription("Checking for conflicts…");
  });

  it("an unchecked line has no Retry at all", () => {
    renderStrip({ arm: "unchecked", retryBusy: true });
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

describe("LocalPrMergeStrip focus", () => {
  it("Retry leaving under focus lands on the strip root", () => {
    const { container, rerenderStrip } = renderStrip({ arm: "failed" });
    screen.getByRole("button", { name: "Retry" }).focus();
    rerenderStrip({ arm: "checking" });
    expect(document.activeElement).toBe(parts(container).root);
  });

  it("Update branch leaving under focus lands on the strip root", () => {
    const { container, rerenderStrip } = renderStrip({
      arm: "updating",
      behindBy: 2,
      offerUpdate: true,
      updateHeldReason: "Updating this branch…",
    });
    screen.getByRole("button", { name: "Update branch" }).focus();
    rerenderStrip({ arm: "clean", behindBy: 0, offerUpdate: false });
    expect(document.activeElement).toBe(parts(container).root);
  });

  it.each([
    ["behind", "updating"],
    ["failed", "updating"],
    ["unchecked", "updating"],
    ["failed", "behind"],
  ] as [LocalMergeStripArm, LocalMergeStripArm][])(
    "Update branch keeps its node and focus from %s to %s",
    (from, to) => {
      const { rerenderStrip } = renderStrip({
        arm: from,
        behindBy: 2,
        offerUpdate: true,
      });
      const button = screen.getByRole("button", { name: "Update branch" });
      button.focus();
      rerenderStrip({
        arm: to,
        updateHeldReason:
          to === "updating" ? "Updating this branch…" : undefined,
      });
      expect(screen.getByRole("button", { name: "Update branch" })).toBe(
        button,
      );
      expect(document.activeElement).toBe(button);
    },
  );

  // Negative control: the same swap with no rescue hook drops focus to <body>,
  // so the assertions above can only pass because the strip rescues.
  it("negative control: a box with no rescue drops focus to body", () => {
    function Unrescued({ shown }: { shown: boolean }) {
      return (
        <div tabIndex={-1}>{shown && <button type="button">Go</button>}</div>
      );
    }
    const { rerender } = render(<Unrescued shown />);
    screen.getByRole("button", { name: "Go" }).focus();
    rerender(<Unrescued shown={false} />);
    expect(document.activeElement).toBe(document.body);
  });
});

describe("LocalPrMergeStrip null arm", () => {
  it("renders nothing", () => {
    const { container } = renderStrip({ arm: null });
    expect(container).toBeEmptyDOMElement();
  });
});

describe("PrMergeabilityBanner keeps its output", () => {
  beforeEach(() => {
    vi.mocked(loadSettings).mockImplementation(async () => DEFAULT_SETTINGS);
    vi.mocked(getSecret).mockImplementation(async () => null);
  });

  // The hooks' settings and key reads land after the first paint.
  afterEach(async () => {
    await waitFor(() => {
      expect(loadSettings).toHaveBeenCalled();
      expect(getSecret).toHaveBeenCalled();
    });
    vi.clearAllMocks();
  });

  const ROOT_CLASS =
    "flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-3 py-1.5 text-xs";

  function renderBanner(
    arm: PrMergeabilityArm,
    over: {
      behindBy?: number;
      promotionKind?: PromotionKind;
      conflictFiles?: string[];
    } = {},
  ) {
    const noop = vi.fn();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <QueryClientProvider client={client}>
        <PrMergeabilityBanner
          arm={arm}
          base="main"
          head="feature"
          promotionKind={over.promotionKind ?? null}
          provider="github"
          forkBlocked={false}
          hasResolveWorktree={false}
          busy={false}
          resolveHeldReason={undefined}
          conflictFiles={over.conflictFiles ?? []}
          predictedClean={false}
          forgeUnreachable={false}
          behindBy={over.behindBy ?? 0}
          blockedRequirements={[]}
          blockedApprovals={null}
          blockedReason={null}
          pendingOffline={false}
          updateBlockedReason={undefined}
          updateHeldReason={undefined}
          updateBusy={false}
          updateAwaitingDefault={false}
          updateAwaitingRules={false}
          updateSubmitting={false}
          onResolve={noop}
          onResolveWithAi={noop}
          onDiscard={noop}
          onRetry={noop}
          onUpdateBranch={noop}
          onUpdateWithRebase={noop}
          retryBusy={false}
        />
      </QueryClientProvider>,
    );
  }

  it.each([
    ["pending", "pending", {}, "Checking for conflicts…"],
    ["clean", "clean", {}, "No conflicts with main."],
    [
      "behind",
      "behind",
      { behindBy: 3 },
      "This branch is 3 commits behind main.",
    ],
    [
      "behind on a promotion",
      "behind",
      { behindBy: 3, promotionKind: "default" },
      PROMOTION_SENTENCE,
    ],
    [
      "predicted",
      "predicted",
      { conflictFiles: Array.from({ length: 7 }, (_, i) => `f${i}.ts`) },
      "Merging into main is predicted to conflict (checked locally from your last fetch).",
    ],
  ] as [
    string,
    PrMergeabilityArm,
    Parameters<typeof renderBanner>[1],
    string,
  ][])("%s", (_name, arm, over, sentence) => {
    const { container } = renderBanner(arm, over);
    const { root, sentence: span } = parts(container);
    expect(root.className).toBe(ROOT_CLASS);
    expect(span.textContent).toBe(sentence);
    if (arm === "predicted") {
      const items = screen.getAllByRole("listitem");
      expect(items).toHaveLength(6);
      expect(items[5]).toHaveTextContent("and 2 more");
    }
  });
});
