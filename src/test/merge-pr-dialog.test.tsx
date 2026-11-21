import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DeleteBranchBlock,
  MergePrDialog,
} from "@/features/pulls/MergePrDialog";
import {
  type MergeMessagePlan,
  mergeMessagePlan,
  mergeMessagesToSend,
  mergeMessageText,
  normalizeBody,
  normalizeTitle,
  useMergeMessageDraft,
} from "@/features/pulls/merge-message";
import {
  type MergeMessage,
  type MergeMessageCommit,
  type MergeMessageDefaults,
  type NoMergeMessageReason,
  UNKNOWN_HOST,
} from "@/lib/git/types";
import { eventToBinding, SUBMIT_HINT } from "@/lib/hotkeys/binding";
import { useHotkeyAction, useHotkeysListener } from "@/lib/hotkeys/hotkeys";
import { ACT_PENDING_REASON } from "@/lib/offline-writes";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";

// The app hotkey listener reads its bindings through the settings query; with
// no overrides every action keeps its registry default.
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));

const TITLE = "Add retry backoff to the sync queue (#128)";
const BODY =
  "* Add exponential backoff to SyncQueue\n\n* Cap retries at five attempts\n\n* Cover the jitter window in tests";
const HOLD = "Add a title, or reset to the default.";
const U1 =
  "Couldn't load GitHub's default message. Without it, GitHub writes its own default.";
const O1 = "You're offline, so GitHub's default message can't load.";

const ready = (
  commits: MergeMessageCommit[],
  reason: NoMergeMessageReason | null = null,
): MergeMessagePlan => ({ state: "ready", defaults: { commits, reason } });
const squash = (message: MergeMessage | null, exact = true) =>
  ready([{ kind: "squash", message, exact }]);
const ignore = () => undefined;

type HarnessProps = {
  plan: MergeMessagePlan;
  onConfirm: () => void;
  pending?: boolean;
  heldReason?: string;
  auto?: boolean;
  failure?: string;
  host?: string;
  local?: boolean;
  headIsDefault?: boolean;
  blocked?: DeleteBranchBlock;
  deleteChecked?: boolean;
  onDeleteChange?: (checked: boolean) => void;
  stackNotice?: string;
};

/** Reads the plan back from the draft, as both host views do. */
function Harness(p: HarnessProps) {
  const draft = useMergeMessageDraft(p.plan);
  return (
    <>
      <output data-testid="send">
        {JSON.stringify(mergeMessagesToSend(draft.rows, draft.plan))}
      </output>
      <output data-testid="rows">{JSON.stringify(draft.rows)}</output>
      <MergePrDialog
        open
        onClose={ignore}
        target={
          p.local
            ? { kind: "local" }
            : {
                kind: "remote",
                number: 42,
                host: p.host ?? "GitHub",
                prNoun: p.host === "GitLab" ? "merge request" : "pull request",
              }
        }
        headRefName="feat/sync"
        baseRefName="main"
        strategyLabel="Squash and merge"
        deleteBranch={
          p.local
            ? undefined
            : {
                checked: p.deleteChecked ?? false,
                onChange: p.onDeleteChange ?? ignore,
                headIsDefault: p.headIsDefault ?? false,
                blocked: p.blocked ?? null,
              }
        }
        pending={p.pending ?? false}
        heldReason={p.heldReason}
        onConfirm={p.onConfirm}
        auto={p.auto}
        draft={draft}
        failure={p.failure}
        stackNotice={p.stackNotice}
      />
    </>
  );
}

/** The app listener with a registered but disabled `commit` handler on
 *  mod+enter, as the Changes tab's commit box leaves it: the listener then
 *  prevents the chord's default without dispatching. */
function AppListener({ onCommit }: { onCommit: () => void }) {
  useHotkeysListener();
  useHotkeyAction("commit", onCommit, false);
  return null;
}

function setup(props: Omit<HarnessProps, "onConfirm">) {
  const onConfirm = vi.fn();
  const user = userEvent.setup();
  const utils = render(<Harness onConfirm={onConfirm} {...props} />);
  const rerender = (next: Omit<HarnessProps, "onConfirm">) =>
    utils.rerender(<Harness onConfirm={onConfirm} {...next} />);
  return { onConfirm, user, rerender, unmount: utils.unmount };
}

type User = ReturnType<typeof userEvent.setup>;

const sent = () => JSON.parse(screen.getByTestId("send").textContent ?? "{}");
const rows = () => JSON.parse(screen.getByTestId("rows").textContent ?? "{}");
const confirm = (name = "Squash and merge") =>
  screen.getByRole("button", { name });
const pressEdit = (user: User, name = "Edit commit message") =>
  user.click(screen.getByRole("button", { name }));
const resetBtn = (name = "Reset to default") =>
  screen.getByRole("button", { name });
const hasReset = (name = "Reset to default") =>
  screen.queryByRole("button", { name }) !== null;
/** The dialog's own status element, found by its role and told apart from the
 *  pending Spinner's. */
const statusEl = () => {
  const el = screen
    .getAllByRole("status")
    .find((e) => e.hasAttribute("data-merge-message-status"));
  if (el === undefined) throw new Error("no merge message status element");
  return el;
};
const status = () => statusEl().textContent ?? "";
const titleBox = (name = "Commit title") =>
  screen.getByRole("textbox", { name });
const bodyBox = (name = "Commit description") =>
  screen.getByRole("textbox", { name });
const region = (caption = "Commit message") =>
  screen.getByRole("group", { name: caption }).parentElement as HTMLElement;

function expectHeld(button: HTMLElement, reason: string) {
  expect(button).not.toHaveAttribute("disabled");
  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(button).toHaveAccessibleDescription(expect.stringContaining(reason));
}

/** Natively enabled AND not held by aria-disabled: either alone passes a
 *  confirm the other one blocks. */
function expectEnabled(button: HTMLElement) {
  expect(button).toBeEnabled();
  expect(button).not.toHaveAttribute("aria-disabled", "true");
}

afterEach(() => vi.restoreAllMocks());

describe("merge dialog: resting row", () => {
  it("shows the default title, its line count and Edit; an untouched confirm sends nothing", async () => {
    const { onConfirm, user } = setup({
      plan: squash({ title: TITLE, body: BODY }),
    });
    expect(screen.getByText(TITLE)).toBeInTheDocument();
    expect(screen.getByText("+5 lines")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit commit message" }),
    ).toBeInTheDocument();
    expectEnabled(confirm());
    await user.click(confirm());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(sent()).toEqual({});
  });

  it("counts the normalised body's lines", () => {
    const { rerender } = setup({ plan: squash({ title: "t", body: "one" }) });
    expect(screen.getByText("+1 line")).toBeInTheDocument();
    rerender({ plan: squash({ title: "t", body: "" }) });
    expect(screen.queryByText(/^\+\d+ lines?$/)).toBeNull();
    rerender({ plan: squash({ title: "t", body: "\n\n\na\n\nb\n" }) });
    expect(screen.getByText("+3 lines")).toBeInTheDocument();
  });

  it("keeps the edit-PR dialog's width at rest and after Edit", async () => {
    const { user } = setup({ plan: squash({ title: TITLE, body: BODY }) });
    expect(screen.getByRole("dialog")).toHaveClass("sm:max-w-lg");
    await pressEdit(user);
    expect(screen.getByRole("dialog")).toHaveClass("sm:max-w-lg");
  });

  // Shape only: jsdom has no layout, so the 600 px window is a live check.
  it("caps the dialog below the viewport and scrolls one body: the message, the delete option and a failure", async () => {
    const plan = squash({ title: TITLE, body: BODY });
    const stackNotice = "Merging this also merges #41.";
    const { user, rerender } = setup({ plan, stackNotice });
    await pressEdit(user);
    rerender({ plan, stackNotice, failure: "405 Method Not Allowed" });
    expect(screen.getByRole("dialog")).toHaveClass(
      "flex",
      "max-h-[85vh]",
      "flex-col",
    );
    const message = region();
    const scroller = message.parentElement as HTMLElement;
    expect(scroller).toHaveClass(
      "-mx-1",
      "-mt-1",
      "-mb-2",
      "min-h-0",
      "min-w-0",
      "flex-1",
      "overflow-y-auto",
      "px-1",
      "pt-1",
      "pb-2",
      "space-y-4",
    );
    // The message region keeps its focus host role but no longer scrolls.
    expect(message).toHaveAttribute("tabindex", "-1");
    expect(message).toHaveClass("ph-no-capture", "space-y-4", "outline-none");
    expect(message.className).not.toMatch(/overflow|flex-1|min-h-0|-my-1/);
    const alert = screen.getByRole("alert");
    const checkbox = screen.getByRole("checkbox");
    for (const inside of [titleBox(), checkbox, alert])
      expect(scroller).toContainElement(inside);
    expect(message).not.toContainElement(checkbox);
    expect(message).not.toContainElement(alert);
    // Resting order inside the scroller: message, delete option, failure.
    const follows = (a: Node, b: Node) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(message, checkbox)).toBe(true);
    expect(follows(checkbox, alert)).toBe(true);
    const describedBy = screen
      .getByRole("dialog")
      .getAttribute("aria-describedby");
    const description = document.getElementById(describedBy ?? "");
    expect(description).toHaveTextContent("merges feat/sync into main");
    for (const outside of [
      screen.getByRole("heading"),
      description as HTMLElement,
      screen.getByText(stackNotice),
      statusEl(),
      confirm(),
      screen.getByRole("button", { name: "Cancel" }),
    ])
      expect(scroller).not.toContainElement(outside);
    // No nested scroller: nothing in the failure caps its own height.
    for (const el of [alert, ...alert.querySelectorAll("*")])
      expect(el.getAttribute("class") ?? "").not.toMatch(/overflow|max-h/);
    expect(within(alert).getByText("405 Method Not Allowed")).toBeVisible();
  });

  it("scrolls a failure into view when it appears and when its text changes", () => {
    // jsdom implements no scrollIntoView.
    const targets: Element[] = [];
    const scroll = vi.fn(function (this: Element) {
      targets.push(this);
    });
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      value: scroll,
      configurable: true,
      writable: true,
    });
    try {
      const plan = squash({ title: TITLE, body: BODY });
      const { rerender } = setup({ plan });
      expect(scroll).not.toHaveBeenCalled();
      rerender({ plan, failure: "405 Method Not Allowed" });
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll).toHaveBeenLastCalledWith({ block: "nearest" });
      expect(targets[0]).toBe(screen.getByRole("alert"));
      rerender({ plan, failure: "405 Method Not Allowed", heldReason: "x" });
      expect(scroll).toHaveBeenCalledTimes(1);
      rerender({ plan, failure: "409 Conflict" });
      expect(scroll).toHaveBeenCalledTimes(2);
      expect(targets[1]).toBe(screen.getByRole("alert"));
    } finally {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  it("leaves a failure it mounted with where it is; one cleared and shown again scrolls", () => {
    const scroll = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      value: scroll,
      configurable: true,
      writable: true,
    });
    try {
      const plan = squash({ title: TITLE, body: BODY });
      const failure = "405 Method Not Allowed";
      // A reopen that keeps the failure: the body mounts with it.
      const { rerender } = setup({ plan, failure });
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(scroll).not.toHaveBeenCalled();
      // Cleared at a press, the same text again at its settle.
      rerender({ plan });
      expect(scroll).not.toHaveBeenCalled();
      rerender({ plan, failure });
      expect(scroll).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });
});

describe("merge dialog: editing", () => {
  it("opens prefilled fields in place, focused on Title, with no Reset", async () => {
    const { user } = setup({ plan: squash({ title: TITLE, body: BODY }) });
    await pressEdit(user);
    expect(titleBox()).toHaveValue(TITLE);
    expect(bodyBox()).toHaveValue(BODY);
    expect(titleBox()).toHaveFocus();
    expect(screen.queryByText("+5 lines")).toBeNull();
    expect(hasReset()).toBe(false);
    expect(
      screen.getByText("GitHub's default for a squash merge."),
    ).toBeInTheDocument();
  });

  it("a changed row shows Reset and the edited footer and is sent in its kind's slot", async () => {
    const { user, rerender } = setup({
      plan: squash({ title: TITLE, body: "b\r\n" }),
    });
    await pressEdit(user);
    await user.clear(titleBox());
    await user.type(titleBox(), "feat: x");
    expect(resetBtn()).toBeInTheDocument();
    expect(
      screen.getByText(
        "Edited. GitHub writes this message instead of its default.",
      ),
    ).toBeInTheDocument();
    expect(sent()).toEqual({ squashMessage: { title: "feat: x", body: "b" } });
    rerender({
      plan: ready([
        { kind: "merge", message: { title: TITLE, body: "" }, exact: true },
      ]),
    });
    await pressEdit(user);
    await user.type(titleBox(), "!");
    expect(sent()).toEqual({ mergeMessage: { title: `${TITLE}!`, body: "" } });
  });

  it("retyping the default after an edit leaves the row unchanged, for every sample", async () => {
    // [default body as the forge sends it, raw text typed back]: each
    // normalisation sample's rest after its first line, then whitespace the
    // normalisation drops.
    const samples: [string, string][] = [
      ["", ""],
      ["b", "\nb"],
      ["b", "\r\nb\r\n"],
      ["b", "\n\nb"],
      ["b", "\nb\n\n  \n"],
      [BODY, `${BODY}\n\n  `],
      [BODY, `\n\n${BODY}`],
    ];
    for (const [body, typed] of samples) {
      const label = JSON.stringify({ body, typed });
      const { user, unmount } = setup({
        plan: squash({ title: "t", body }),
      });
      await pressEdit(user);
      fireEvent.change(bodyBox(), { target: { value: "x" } });
      expect(sent(), label).toHaveProperty("squashMessage");
      fireEvent.change(bodyBox(), { target: { value: typed } });
      expect(hasReset(), label).toBe(false);
      expect(sent(), label).toEqual({});
      unmount();
    }
    const { user } = setup({ plan: squash({ title: TITLE, body: "" }) });
    await pressEdit(user);
    await user.type(titleBox(), "  ");
    expect(hasReset()).toBe(false);
    expect(sent()).toEqual({});
  });

  it("Reset restores the default, keeps focus in Title and announces it", async () => {
    const { user } = setup({ plan: squash({ title: TITLE, body: BODY }) });
    await pressEdit(user);
    await user.type(bodyBox(), " more");
    await user.click(resetBtn());
    expect(bodyBox()).toHaveValue(BODY);
    expect(hasReset()).toBe(false);
    expect(titleBox()).toHaveFocus();
    expect(status()).toBe("Message reset to the default");
    expect(sent()).toEqual({});
  });

  it("hints past 72 characters without holding the merge", async () => {
    const { user } = setup({ plan: squash({ title: "t", body: "" }) });
    await pressEdit(user);
    fireEvent.change(titleBox(), { target: { value: "a".repeat(72) } });
    expect(screen.queryByText(/^Title is \d+ characters/)).toBeNull();
    expect(
      screen.getByText(
        "Edited. GitHub writes this message instead of its default.",
      ),
    ).toBeInTheDocument();
    fireEvent.change(titleBox(), {
      target: { value: `  ${"a".repeat(72)}  ` },
    });
    expect(screen.queryByText(/^Title is \d+ characters/)).toBeNull();
    fireEvent.change(titleBox(), { target: { value: "a".repeat(73) } });
    expect(
      screen.getByText(
        "Title is 73 characters, over the 72-character guideline.",
      ),
    ).toBeInTheDocument();
    expect(status()).toBe("Title is over 72 characters");
    expectEnabled(confirm());
  });

  it("counts the title in code points, as the backend does", async () => {
    const emoji = String.fromCodePoint(0x1f600);
    const { user } = setup({ plan: squash({ title: "t", body: "" }) });
    await pressEdit(user);
    fireEvent.change(titleBox(), { target: { value: emoji.repeat(37) } });
    expect(screen.queryByText(/^Title is \d+ characters/)).toBeNull();
    expect(status()).toBe("");
    fireEvent.change(titleBox(), { target: { value: emoji.repeat(73) } });
    expect(
      screen.getByText(
        "Title is 73 characters, over the 72-character guideline.",
      ),
    ).toBeInTheDocument();
    expect(status()).toBe("Title is over 72 characters");
  });

  it("a Reset under a default title past 72 is announced, and the next edit brings the length line back", async () => {
    const { user } = setup({
      plan: squash({ title: "a".repeat(73), body: "" }),
    });
    await pressEdit(user);
    expect(status()).toBe("Title is over 72 characters");
    await user.type(bodyBox(), "x");
    await user.click(resetBtn());
    expect(status()).toBe("Message reset to the default");
    await user.type(bodyBox(), "y");
    expect(status()).toBe("Title is over 72 characters");
  });

  it("an emptied title holds the merge with a reason, and a title or Reset releases it", async () => {
    const { user, onConfirm } = setup({
      plan: squash({ title: TITLE, body: BODY }),
    });
    await pressEdit(user);
    await user.clear(titleBox());
    expectHeld(confirm(), HOLD);
    expect(titleBox()).toHaveAttribute("aria-invalid", "true");
    expect(titleBox()).toHaveAccessibleDescription(HOLD);
    expect(status()).toBe("The title is empty, so the merge is held");
    await user.click(confirm());
    titleBox().focus();
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(onConfirm).not.toHaveBeenCalled();
    await user.type(titleBox(), "x");
    expectEnabled(confirm());
    expect(titleBox()).toHaveFocus();
    await user.clear(titleBox());
    await user.click(resetBtn());
    expectEnabled(confirm());
  });

  it("a title that is only Rust whitespace holds, and U+FEFF is text", async () => {
    const nel = String.fromCharCode(0x85);
    const bom = String.fromCharCode(0xfeff);
    expect(normalizeTitle(`${nel} t ${nel}`)).toBe("t");
    expect(normalizeTitle(`${bom}t`)).toBe(`${bom}t`);
    expect(normalizeBody(`b${nel}`)).toBe("b");
    expect(normalizeBody(`b${bom}`)).toBe(`b${bom}`);
    const { user } = setup({ plan: squash({ title: TITLE, body: BODY }) });
    await pressEdit(user);
    fireEvent.change(titleBox(), { target: { value: nel } });
    expectHeld(confirm(), HOLD);
  });

  it("a second Reset with no edit between is announced again", async () => {
    const { user } = setup({
      host: "GitLab",
      plan: ready([
        { kind: "squash", message: { title: "S", body: "" }, exact: true },
        { kind: "merge", message: { title: "M", body: "" }, exact: true },
      ]),
    });
    await pressEdit(user, "Edit squash commit message");
    await user.type(titleBox("Squash commit title"), "!");
    await pressEdit(user, "Edit merge commit message");
    await user.type(titleBox("Merge commit title"), "!");
    await user.click(resetBtn("Reset to default, squash commit message"));
    const first = statusEl().firstElementChild;
    expect(first).toHaveTextContent("Message reset to the default");
    await user.click(resetBtn("Reset to default, merge commit message"));
    const second = statusEl().firstElementChild;
    expect(second).toHaveTextContent("Message reset to the default");
    expect(second).not.toBe(first);
  });
});

describe("merge dialog: Ctrl/Cmd+Enter", () => {
  it("merges from a field only, once per press, never while held", async () => {
    const prevented: boolean[] = [];
    const listener = (e: KeyboardEvent) => {
      if (e.key === "Enter") prevented.push(e.defaultPrevented);
    };
    window.addEventListener("keydown", listener);
    try {
      const plan = squash({ title: TITLE, body: BODY });
      const { user, onConfirm, rerender } = setup({ plan });
      await pressEdit(user);
      await user.keyboard("{Control>}{Enter}{/Control}");
      expect(onConfirm).toHaveBeenCalledTimes(1);
      await user.keyboard("{Enter}");
      expect(onConfirm).toHaveBeenCalledTimes(1);
      await user.keyboard("{Meta>}{Enter}{/Meta}");
      expect(onConfirm).toHaveBeenCalledTimes(2);
      bodyBox().focus();
      await user.keyboard("{Meta>}{Enter}{/Meta}");
      expect(onConfirm).toHaveBeenCalledTimes(3);
      await user.keyboard("{Control>}{Enter}{/Control}");
      expect(onConfirm).toHaveBeenCalledTimes(4);
      titleBox().focus();
      await user.keyboard("{Control>}{Enter>3/}{/Control}");
      expect(onConfirm).toHaveBeenCalledTimes(5);
      screen.getByRole("button", { name: "Cancel" }).focus();
      prevented.length = 0;
      await user.keyboard("{Control>}{Enter}{/Control}");
      expect(onConfirm).toHaveBeenCalledTimes(5);
      expect(prevented).toEqual([true]);
      rerender({ plan, pending: true });
      titleBox().focus();
      await user.keyboard("{Control>}{Enter}{/Control}");
      expect(onConfirm).toHaveBeenCalledTimes(5);
      rerender({ plan, heldReason: "You're offline." });
      titleBox().focus();
      await user.keyboard("{Control>}{Enter}{/Control}");
      expect(onConfirm).toHaveBeenCalledTimes(5);
    } finally {
      window.removeEventListener("keydown", listener);
    }
  });

  it("an IME's committing Enter (keyCode 229) neither merges nor reaches the app listener", async () => {
    vi.mocked(loadSettings).mockImplementation(async () =>
      structuredClone(DEFAULT_SETTINGS),
    );
    // user-event never sets keyCode, so a capture listener marks the chord's
    // own event the way a composing WebView does, and keeps it so its final
    // defaultPrevented is read after every listener ran. user-event defines
    // isComposing non-configurably, so that arm is driven by a hand-built
    // event below, which this listener leaves alone.
    const seen: KeyboardEvent[] = [];
    const compose = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.isComposing) return;
      Object.defineProperty(e, "keyCode", { value: 229 });
      seen.push(e);
    };
    window.addEventListener("keydown", compose, true);
    try {
      const onConfirm = vi.fn();
      const onCommit = vi.fn();
      const user = userEvent.setup();
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      render(
        <QueryClientProvider client={client}>
          <AppListener onCommit={onCommit} />
          <Harness
            plan={squash({ title: TITLE, body: BODY })}
            onConfirm={onConfirm}
          />
        </QueryClientProvider>,
      );
      await pressEdit(user);
      await user.keyboard("{Control>}{Enter}{/Control}");
      expect(onConfirm).not.toHaveBeenCalled();
      expect(onCommit).not.toHaveBeenCalled();
      expect(seen.map((e) => e.defaultPrevented)).toEqual([false]);
      // A composing Enter whose keyCode is already 13. It carries the modifier
      // flags of user-event's own chord press, so the platform modifier is
      // never spelled here.
      const init: KeyboardEventInit = {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        isComposing: true,
        bubbles: true,
        cancelable: true,
      };
      const [chord] = seen;
      for (const flag of Object.getOwnPropertyNames(KeyboardEvent.prototype))
        if (flag.endsWith("Key"))
          Object.assign(init, { [flag]: chord[flag as keyof KeyboardEvent] });
      const composing = new KeyboardEvent("keydown", init);
      expect(composing.keyCode).toBe(13);
      expect(eventToBinding(composing)).toBe("mod+enter");
      fireEvent(titleBox(), composing);
      expect(onConfirm).not.toHaveBeenCalled();
      expect(onCommit).not.toHaveBeenCalled();
      expect(composing.defaultPrevented).toBe(false);
    } finally {
      window.removeEventListener("keydown", compose, true);
    }
  });

  it("the confirm advertises the chord only while a field is open and nothing holds", async () => {
    const { user } = setup({ plan: squash({ title: TITLE, body: BODY }) });
    expect(confirm()).not.toHaveAttribute("title");
    await pressEdit(user);
    expect(confirm()).toHaveAttribute("title", SUBMIT_HINT);
    await user.clear(titleBox());
    expect(confirm()).not.toHaveAttribute("title", SUBMIT_HINT);
  });
});

describe("merge dialog: plan states", () => {
  it("each no-message reason shows its own line with no Edit", () => {
    const lines: [NoMergeMessageReason, string, string][] = [
      ["rebase", "GitHub", "Rebase and merge keeps each commit's own message"],
      ["fastForward", "Bitbucket", "A fast-forward moves the branch"],
      ["stacked", "GitHub", "A stacked merge can land several pull requests"],
      ["gitlabFastForward", "GitLab", "This project fast-forwards its merges"],
      [
        "alreadyMerged",
        "GitHub",
        "feat/sync is already part of main, so this merge writes no commit and there is no merge message to edit.",
      ],
    ];
    for (const [reason, host, line] of lines) {
      const { unmount } = setup({
        host,
        plan: ready([], reason),
        local: reason === "alreadyMerged",
      });
      expect(
        screen.queryByText(new RegExp(`^${line}`)),
        reason,
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /^Edit/ }),
        reason,
      ).toBeNull();
      expect(confirm(), reason).toBeEnabled();
      expect(confirm(), reason).not.toHaveAttribute("aria-disabled", "true");
      unmount();
    }
  });

  it("loading is busy in a region that survives the answer", () => {
    const { rerender } = setup({ plan: { state: "loading" } });
    expect(screen.getByText("Loading GitHub's default…")).toBeInTheDocument();
    const before = region();
    expect(before).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("button", { name: /^Edit/ })).toBeNull();
    expect(sent()).toEqual({});
    expectEnabled(confirm());
    expect(status()).toBe("");
    rerender({ plan: squash({ title: TITLE, body: BODY }) });
    expect(screen.getByText(TITLE)).toBeInTheDocument();
    expect(region()).toBe(before);
    expect(before).not.toHaveAttribute("aria-busy");
  });

  it("failed: Retry reads again and leaves focus on the region; a refetch that hides Retry rescues focus", async () => {
    const onRetry = vi.fn();
    const failed: MergeMessagePlan = { state: "failed", onRetry };
    const { user, rerender } = setup({ plan: failed });
    expect(screen.getByText(U1, { selector: "p" })).toBeInTheDocument();
    expectEnabled(confirm());
    const host = region();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(host);
    rerender({ plan: failed });
    screen.getByRole("button", { name: "Retry" }).focus();
    rerender({ plan: { state: "loading" } });
    expect(document.activeElement).toBe(host);
    rerender({ plan: squash({ title: TITLE, body: BODY }) });
    expect(document.activeElement).toBe(host);
  });

  it("announces a failed or offline read once, in the status element", () => {
    const failed: MergeMessagePlan = { state: "failed", onRetry: ignore };
    const { rerender } = setup({ plan: failed });
    expect(status()).toBe(U1);
    const node = statusEl().firstChild;
    // A fresh plan object, as the remote view builds one on every render.
    rerender({ plan: { state: "failed", onRetry: ignore } });
    expect(statusEl().firstChild).toBe(node);
    rerender({ plan: { state: "offline" } });
    expect(status()).toBe(O1);
    rerender({ plan: { state: "loading" } });
    expect(status()).toBe("");
  });

  it("offline says so with no Retry", () => {
    setup({ plan: { state: "offline" } });
    expect(screen.getByText(O1, { selector: "p > span" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("an unknown default opens blank; a body without a title holds", async () => {
    const { user } = setup({ plan: squash(null) });
    expect(screen.getByText("GitHub's default message")).toBeInTheDocument();
    await pressEdit(user);
    expect(titleBox()).toHaveValue("");
    expect(bodyBox()).toHaveValue("");
    const f4 = "Leave this blank and GitHub writes its default message.";
    expect(screen.getByText(f4)).toBeInTheDocument();
    expect(titleBox()).toHaveAccessibleDescription(f4);
    expectEnabled(confirm());
    expect(sent()).toEqual({});
    expect(status()).toBe("");
    await user.type(bodyBox(), "why");
    expectHeld(confirm(), HOLD);
    expect(titleBox()).toHaveAccessibleDescription(HOLD);
    await user.type(titleBox(), "what");
    expect(sent()).toEqual({ squashMessage: { title: "what", body: "why" } });
  });

  it("Bitbucket's draft is never shown as its default title", async () => {
    const draftTitle = "Merged in feat/x (pull request #7)";
    const { user } = setup({
      host: "Bitbucket",
      plan: squash({ title: draftTitle, body: "B" }, false),
    });
    expect(screen.getByText("Bitbucket's default message")).toBeInTheDocument();
    expect(screen.queryByText(draftTitle)).toBeNull();
    await pressEdit(user);
    expect(titleBox()).toHaveValue(draftTitle);
    expect(
      screen.getByText(
        "A draft in Bitbucket's default format. Leave it unchanged and Bitbucket writes its own default.",
      ),
    ).toBeInTheDocument();
    expect(sent()).toEqual({});
    await user.type(bodyBox(), "!");
    expect(sent()).toHaveProperty("squashMessage.body", "B!");
  });

  it("an unknown host opens its sentences with a capital", async () => {
    const first = setup({ host: UNKNOWN_HOST, plan: squash(null) });
    expect(screen.getByText("The host's default message")).toBeInTheDocument();
    first.unmount();
    const second = setup({
      host: UNKNOWN_HOST,
      plan: squash({ title: TITLE, body: BODY }),
    });
    await pressEdit(second.user);
    expect(
      screen.getByText("The host's default for a squash merge."),
    ).toBeInTheDocument();
    await second.user.type(titleBox(), "!");
    expect(
      screen.getByText(
        "Edited. The host writes this message instead of its default.",
      ),
    ).toBeInTheDocument();
  });

  it("loading, offline and no-message each hold one min-h-6 row", () => {
    const { rerender } = setup({ plan: { state: "loading" } });
    const text = screen.getByText("Loading GitHub's default…");
    const host = region();
    for (
      let el: HTMLElement | null = text;
      el !== null && el !== host;
      el = el.parentElement
    ) {
      expect(el).not.toHaveClass("sr-only");
    }
    const row = text.parentElement as HTMLElement;
    expect(row).toHaveClass("flex", "min-h-6", "items-center");
    expect(row.firstElementChild).toBe(text);
    const bar = text.nextElementSibling;
    expect(bar).toHaveAttribute("data-slot", "skeleton");
    expect(bar?.nextElementSibling).toBeNull();
    const group = screen.getByRole("group", { name: "Commit message" });
    expect(group.children).toHaveLength(2);
    expect(group.lastElementChild).toBe(row);
    expect(host).toHaveAttribute("aria-busy", "true");
    // The line's text sits in a min-w-0 item, so a long unbroken branch name
    // wraps inside the scroller instead of widening the row past it.
    const lineRow = (line: HTMLElement) => {
      expect(line.tagName).toBe("SPAN");
      expect(line).toHaveClass("min-w-0");
      const p = line.parentElement as HTMLElement;
      expect(p.tagName).toBe("P");
      expect(p.childElementCount).toBe(1);
      return p;
    };
    rerender({ plan: { state: "offline" } });
    expect(lineRow(screen.getByText(O1, { selector: "p > span" }))).toHaveClass(
      "flex",
      "min-h-6",
      "items-center",
    );
    rerender({ plan: ready([], "rebase") });
    expect(lineRow(screen.getByText(/^Rebase and merge keeps/))).toHaveClass(
      "flex",
      "min-h-6",
      "items-center",
    );
    rerender({ plan: ready([], "alreadyMerged") });
    expect(lineRow(screen.getByText(/is already part of main/))).toHaveClass(
      "flex",
      "min-h-6",
      "items-center",
    );
    rerender({ plan: ready([]) });
    const empty = screen.getByRole("group", {
      name: "Commit message",
    }).lastElementChild;
    expect(empty?.tagName).toBe("P");
    expect(empty).toHaveClass("flex", "min-h-6", "items-center");
  });
});

describe("merge dialog: a read that drops back after a ready plan", () => {
  const failed: MergeMessagePlan = { state: "failed", onRetry: ignore };

  for (const [name, fallback] of [
    ["loading", { state: "loading" }],
    ["failed", failed],
    ["offline", { state: "offline" }],
  ] as [string, MergeMessagePlan][]) {
    it(`${name}: the edited row stays and the confirm sends it`, async () => {
      const { user, rerender, onConfirm } = setup({
        plan: squash({ title: TITLE, body: BODY }),
      });
      await pressEdit(user);
      await user.type(titleBox(), "!");
      rerender({ plan: fallback });
      expect(titleBox()).toHaveValue(`${TITLE}!`);
      expect(screen.queryByText(U1)).toBeNull();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      expect(sent()).toEqual({
        squashMessage: { title: `${TITLE}!`, body: BODY },
      });
      await user.click(confirm());
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });
  }

  it("an emptied title still holds while the read is loading", async () => {
    const { user, rerender } = setup({
      plan: squash({ title: TITLE, body: BODY }),
    });
    await pressEdit(user);
    await user.clear(titleBox());
    rerender({ plan: { state: "loading" } });
    expectHeld(confirm(), HOLD);
  });

  it("a ready read whose default turned unknown keeps the hold, and Reset returns the last known default", async () => {
    const { user, rerender } = setup({
      plan: squash({ title: "S", body: "" }),
    });
    await pressEdit(user);
    await user.clear(titleBox());
    expectHeld(confirm(), HOLD);
    rerender({ plan: squash(null) });
    expectHeld(confirm(), HOLD);
    expect(titleBox()).toHaveValue("");
    expect(status()).toBe("The title is empty, so the merge is held");
    await user.click(resetBtn());
    expect(titleBox()).toHaveValue("S");
    expectEnabled(confirm());
    expect(sent()).toEqual({});
  });

  it("an untouched open row keeps its text when the default turns unknown", async () => {
    const { user, rerender } = setup({
      plan: squash({ title: "S", body: "B" }),
    });
    await pressEdit(user);
    rerender({ plan: squash(null) });
    expect(titleBox()).toHaveValue("S");
    expect(bodyBox()).toHaveValue("B");
    expect(hasReset()).toBe(false);
    expect(sent()).toEqual({});
  });

  it("keeps the same Title node and its focus across ready, loading, ready", async () => {
    const plan = squash({ title: TITLE, body: BODY });
    const { user, rerender } = setup({ plan });
    await pressEdit(user);
    const node = titleBox();
    expect(node).toHaveFocus();
    rerender({ plan: { state: "loading" } });
    expect(titleBox()).toBe(node);
    expect(node).toHaveFocus();
    rerender({ plan });
    expect(titleBox()).toBe(node);
    expect(node).toHaveFocus();
  });

  it("a newer default after the drop re-seeds an unchanged row and keeps a changed one", async () => {
    const two = (s: string, m: string) =>
      ready([
        { kind: "squash", message: { title: s, body: "" }, exact: true },
        { kind: "merge", message: { title: m, body: "" }, exact: true },
      ]);
    const { user, rerender } = setup({ host: "GitLab", plan: two("S", "M") });
    await pressEdit(user, "Edit squash commit message");
    await pressEdit(user, "Edit merge commit message");
    await user.type(titleBox("Squash commit title"), "!");
    rerender({ host: "GitLab", plan: { state: "loading" } });
    rerender({ host: "GitLab", plan: two("S2", "M2") });
    expect(titleBox("Squash commit title")).toHaveValue("S!");
    expect(titleBox("Merge commit title")).toHaveValue("M2");
    // The changed row's baseline moved to "S2", so typing back to "S" keeps
    // it changed instead of re-seeding it as an unchanged row.
    await user.type(titleBox("Squash commit title"), "{Backspace}");
    expect(titleBox("Squash commit title")).toHaveValue("S");
  });
});

describe("merge dialog: two commits", () => {
  const twoCommits = (s: string, m: string) =>
    ready([
      { kind: "squash", message: { title: s, body: "" }, exact: true },
      { kind: "merge", message: { title: m, body: "" }, exact: true },
    ]);
  const SQUASH_RESET = "Reset to default, squash commit message";
  const MERGE_RESET = "Reset to default, merge commit message";

  it("names each row's controls and sends only the edited row", async () => {
    const { user } = setup({ host: "GitLab", plan: twoCommits("S", "M") });
    expect(
      screen.getByRole("group", { name: "Squash commit" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: "Merge commit" }),
    ).toBeInTheDocument();
    await pressEdit(user, "Edit merge commit message");
    await user.type(titleBox("Merge commit title"), "!");
    expect(sent()).toEqual({ mergeMessage: { title: "M!", body: "" } });
    await pressEdit(user, "Edit squash commit message");
    await user.clear(titleBox("Squash commit title"));
    expect(resetBtn(SQUASH_RESET)).toBeInTheDocument();
    expect(resetBtn(MERGE_RESET)).toBeInTheDocument();
    expectHeld(
      confirm(),
      "Add a title to the squash commit message, or reset it to the default.",
    );
  });

  it("an open unchanged row follows a newer default; a changed row keeps its text", async () => {
    const { user, rerender } = setup({
      host: "GitLab",
      plan: twoCommits("S", "M"),
    });
    await pressEdit(user, "Edit squash commit message");
    await pressEdit(user, "Edit merge commit message");
    await user.type(titleBox("Squash commit title"), "!");
    rerender({ host: "GitLab", plan: twoCommits("S2", "M2") });
    expect(titleBox("Squash commit title")).toHaveValue("S!");
    expect(titleBox("Merge commit title")).toHaveValue("M2");
    expect(
      screen.getByText("GitLab's default for a merge commit."),
    ).toBeInTheDocument();
    expect(sent()).toEqual({ squashMessage: { title: "S!", body: "" } });
    await user.click(resetBtn(SQUASH_RESET));
    expect(titleBox("Squash commit title")).toHaveValue("S2");
  });

  it("a closed row shows the newer default", () => {
    const { rerender } = setup({ host: "GitLab", plan: twoCommits("S", "M") });
    rerender({ host: "GitLab", plan: twoCommits("S2", "M") });
    expect(screen.getByText("S2")).toBeInTheDocument();
    expect(screen.queryByText("S")).toBeNull();
  });

  it("a changed row keeps its touched field and its untouched field follows a newer default", async () => {
    const { user, rerender } = setup({
      plan: squash({ title: "S", body: "B" }),
    });
    await pressEdit(user);
    await user.type(titleBox(), "!");
    rerender({ plan: squash({ title: "S2", body: "B2" }) });
    expect(titleBox()).toHaveValue("S!");
    expect(bodyBox()).toHaveValue("B2");
    // The baseline moved to "S2", so typing back to "S" keeps the row changed.
    await user.type(titleBox(), "{Backspace}");
    expect(titleBox()).toHaveValue("S");
    expect(hasReset()).toBe(true);
    expect(sent()).toEqual({ squashMessage: { title: "S", body: "B2" } });
    await user.click(resetBtn());
    expect(titleBox()).toHaveValue("S2");
  });

  it("a title-only edit sends the newer default's body", async () => {
    const { user, rerender } = setup({
      plan: squash({ title: "S", body: "B" }),
    });
    await pressEdit(user);
    await user.type(titleBox(), "!");
    rerender({ plan: squash({ title: "S", body: "B2" }) });
    expect(bodyBox()).toHaveValue("B2");
    expect(titleBox()).toHaveValue("S!");
    expect(sent()).toEqual({ squashMessage: { title: "S!", body: "B2" } });
  });

  it("a body-only edit keeps its body and takes the newer default's title", async () => {
    const { user, rerender } = setup({
      plan: squash({ title: "S", body: "B" }),
    });
    await pressEdit(user);
    await user.type(bodyBox(), "!");
    rerender({ plan: squash({ title: "S2", body: "B2" }) });
    expect(titleBox()).toHaveValue("S2");
    expect(bodyBox()).toHaveValue("B!");
    expect(sent()).toEqual({ squashMessage: { title: "S2", body: "B!" } });
  });

  it("the failure says the edit is kept only while a row still differs from its default", async () => {
    const still = "Your edited message is still here.";
    const { user } = setup({
      host: "GitLab",
      plan: twoCommits("S", "M"),
      failure: "405 Method Not Allowed",
    });
    await pressEdit(user, "Edit squash commit message");
    await user.type(titleBox("Squash commit title"), "!");
    await pressEdit(user, "Edit merge commit message");
    await user.type(titleBox("Merge commit title"), "!");
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(still)).toBeVisible();
    await user.click(resetBtn(SQUASH_RESET));
    expect(within(alert).getByText(still)).toBeVisible();
    await user.click(resetBtn(MERGE_RESET));
    expect(within(alert).queryByText(still)).toBeNull();
    expect(within(alert).getByText("405 Method Not Allowed")).toBeVisible();
  });

  it("a newer default that makes the row unchanged lands Reset's focus on Title", async () => {
    const { user, rerender } = setup({
      plan: squash({ title: "S", body: "" }),
    });
    await pressEdit(user);
    await user.type(titleBox(), "2");
    resetBtn().focus();
    rerender({ plan: squash({ title: "S2", body: "" }) });
    expect(hasReset()).toBe(false);
    expect(titleBox()).toHaveValue("S2");
    expect(titleBox()).toHaveFocus();
  });

  it("a typed title stays the user's after a default that briefly equals it", async () => {
    const { user, rerender } = setup({
      plan: squash({ title: "S", body: "" }),
    });
    await pressEdit(user);
    await user.type(titleBox(), "2");
    rerender({ plan: squash({ title: "S2", body: "" }) });
    expect(hasReset()).toBe(false);
    expect(sent()).toEqual({});
    rerender({ plan: squash({ title: "S3", body: "" }) });
    expect(titleBox()).toHaveValue("S2");
    expect(hasReset()).toBe(true);
    expect(sent()).toEqual({ squashMessage: { title: "S2", body: "" } });
  });

  it("a typed body stays the user's after a default that briefly equals it", async () => {
    const { user, rerender } = setup({
      plan: squash({ title: "S", body: "B" }),
    });
    await pressEdit(user);
    await user.type(bodyBox(), "2");
    rerender({ plan: squash({ title: "S", body: "B2" }) });
    expect(hasReset()).toBe(false);
    expect(sent()).toEqual({});
    rerender({ plan: squash({ title: "S", body: "B3" }) });
    expect(bodyBox()).toHaveValue("B2");
    expect(hasReset()).toBe(true);
    expect(sent()).toEqual({ squashMessage: { title: "S", body: "B2" } });
  });

  it("a title typed back to its default follows the next default again", async () => {
    const { user, rerender } = setup({
      plan: squash({ title: "S", body: "" }),
    });
    await pressEdit(user);
    await user.type(titleBox(), "2");
    await user.type(titleBox(), "{Backspace}");
    expect(titleBox()).toHaveValue("S");
    rerender({ plan: squash({ title: "S3", body: "" }) });
    expect(titleBox()).toHaveValue("S3");
    expect(sent()).toEqual({});
  });

  it("a row the plan no longer lists is not sent, and waits out a plan that lists nothing", async () => {
    const { user, rerender } = setup({
      host: "GitLab",
      plan: twoCommits("S", "M"),
    });
    await pressEdit(user, "Edit squash commit message");
    await pressEdit(user, "Edit merge commit message");
    await user.type(titleBox("Merge commit title"), "!");
    await user.click(titleBox("Squash commit title"));
    rerender({ host: "GitLab", plan: squash({ title: "S", body: "" }) });
    expect(sent()).toEqual({});
    expect(titleBox()).toHaveFocus();
    rerender({ host: "GitLab", plan: twoCommits("S", "M") });
    // The merge row Edit opened comes back with its text, without pulling
    // focus, and is sent again.
    expect(titleBox("Squash commit title")).toHaveFocus();
    expect(titleBox("Merge commit title")).toHaveValue("M!");
    expect(sent()).toEqual({ mergeMessage: { title: "M!", body: "" } });
    rerender({ host: "GitLab", plan: { state: "loading" } });
    expect(rows().squash.title).toBe("S");
    rerender({ host: "GitLab", plan: ready([], "gitlabFastForward") });
    expect(rows().squash.title).toBe("S");
    rerender({ host: "GitLab", plan: twoCommits("S3", "M") });
    expect(titleBox("Squash commit title")).toHaveValue("S3");
  });
});

describe("merge dialog: confirm holds and targets", () => {
  it("auto-merge copy, and the auto-merge edited footer on an edited row", async () => {
    const { user } = setup({
      host: "GitLab",
      auto: true,
      plan: squash({ title: TITLE, body: "" }),
    });
    expect(
      screen.getByRole("heading", { name: "Auto-merge merge request #42?" }),
    ).toBeInTheDocument();
    await pressEdit(user);
    await user.type(titleBox(), "!");
    expect(
      screen.getByText(
        "Edited. GitLab writes this message when the pipeline passes and the merge lands.",
      ),
    ).toBeInTheDocument();
    expectEnabled(confirm("Enable auto-merge"));
  });

  // The dialog is presentational, so `pending` and `failure` are props here;
  // the deferred merge promise is driven by merge-message-remote.test.tsx.
  it("pending and host holds keep the confirm focusable with a reason; a failure keeps the edit", async () => {
    const plan = squash({ title: TITLE, body: BODY });
    const { user, rerender } = setup({ plan });
    await pressEdit(user);
    await user.type(titleBox(), "!");
    const button = confirm();
    button.focus();
    rerender({ plan, pending: true });
    const spinner = screen.getByRole("status", { name: "Loading" });
    expect(spinner).not.toBe(statusEl());
    expect(statusEl()).toHaveAttribute("role", "status");
    expect(button).toHaveFocus();
    expectHeld(button, ACT_PENDING_REASON);
    rerender({ plan, failure: "405 Method Not Allowed" });
    const alert = screen.getByRole("alert");
    const failureText = within(alert).getByText("405 Method Not Allowed");
    expect(failureText).toBeVisible();
    const stillHere = within(alert).getByText(
      "Your edited message is still here.",
    );
    expect(stillHere).toBeVisible();
    expect(failureText).not.toContainElement(stillHere);
    expect(titleBox()).toHaveValue(`${TITLE}!`);
    expectEnabled(button);
    expect(button).toHaveFocus();
    rerender({ plan, heldReason: "You're offline." });
    expectHeld(button, "You're offline.");
  });

  it("while the merge runs, the fields are read-only and every message control holds with the pending reason", async () => {
    const plan = ready([
      { kind: "squash", message: { title: "S", body: "B" }, exact: true },
      { kind: "merge", message: { title: "M", body: "" }, exact: true },
    ]);
    const onDeleteChange = vi.fn();
    const { user, rerender } = setup({ host: "GitLab", plan, onDeleteChange });
    await pressEdit(user, "Edit squash commit message");
    await user.type(titleBox("Squash commit title"), "!");
    const description = bodyBox("Squash commit description");
    description.focus();
    rerender({ host: "GitLab", plan, pending: true, onDeleteChange });
    // The pending hold keeps a focused field focused: readOnly, never disabled.
    expect(description).toHaveFocus();
    expect(description).toBeEnabled();
    expect(description).not.toHaveAttribute("disabled");
    expect(description).toHaveAttribute("readonly");
    const title = titleBox("Squash commit title");
    expect(title).toHaveAttribute("readonly");
    expect(title).toBeEnabled();
    await user.type(title, "x");
    expect(title).toHaveValue("S!");
    expect(title).toHaveFocus();
    await user.type(bodyBox("Squash commit description"), "y");
    expect(bodyBox("Squash commit description")).toHaveValue("B");
    const reset = resetBtn("Reset to default, squash commit message");
    expectHeld(reset, ACT_PENDING_REASON);
    await user.click(reset);
    expect(title).toHaveValue("S!");
    const edit = screen.getByRole("button", {
      name: "Edit merge commit message",
    });
    expectHeld(edit, ACT_PENDING_REASON);
    await user.click(edit);
    expect(
      screen.queryByRole("textbox", { name: "Merge commit title" }),
    ).toBeNull();
    const checkbox = screen.getByRole("checkbox");
    expectHeld(checkbox, ACT_PENDING_REASON);
    await user.click(checkbox);
    checkbox.focus();
    await user.keyboard(" ");
    expect(onDeleteChange).not.toHaveBeenCalled();
    expect(checkbox).not.toBeChecked();
    expect(sent()).toEqual({ squashMessage: { title: "S!", body: "B" } });
    rerender({
      host: "GitLab",
      plan,
      failure: "405 Method Not Allowed",
      onDeleteChange,
    });
    await user.type(title, "?");
    expect(title).toHaveValue("S!?");
    // Released, the same press reaches the handler.
    await user.click(screen.getByRole("checkbox"));
    expect(onDeleteChange).toHaveBeenCalledWith(true);
  });

  it("a failed read's Retry holds with the pending reason while the merge runs", async () => {
    const onRetry = vi.fn();
    const { user } = setup({
      plan: { state: "failed", onRetry },
      pending: true,
    });
    const retry = screen.getByRole("button", { name: "Retry" });
    expectHeld(retry, ACT_PENDING_REASON);
    await user.click(retry);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("local target: its title, no delete option, local footers and the host's hold", async () => {
    const { user } = setup({
      local: true,
      heldReason: "Approve the PR before merging",
      plan: squash({ title: "Local", body: "desc" }),
    });
    expect(
      screen.getByRole("heading", { name: "Merge local pull request?" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/in this repository\.$/)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
    await pressEdit(user);
    expect(
      screen.getByText("From the pull request's title and description."),
    ).toBeInTheDocument();
    await user.type(titleBox(), "!");
    expect(
      screen.getByText("Edited. The merge uses this message."),
    ).toBeInTheDocument();
    expectHeld(confirm(), "Approve the PR before merging");
  });

  it("remote target keeps the delete-branch rules", () => {
    const plan = squash({ title: TITLE, body: "" });
    const { rerender } = setup({ plan, headIsDefault: true });
    expect(screen.queryByRole("checkbox")).toBeNull();
    rerender({ plan, blocked: "rule" });
    expect(screen.getByRole("checkbox")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByText(/protected by a branch rule/)).toBeInTheDocument();
    rerender({ plan, blocked: "session", deleteChecked: true });
    const session = screen.getByRole("checkbox", {
      name: /^Delete feat\/sync on the remote after merging\s*— reserved for agent sessions$/,
    });
    expect(session).toHaveAttribute("aria-disabled", "true");
    expect(session).not.toBeChecked();
    expect(screen.queryByText(/protected by a branch rule/)).toBeNull();
  });
});

describe("merge message text", () => {
  it("normalises the shared samples the way the Rust side does", () => {
    // [title, rest after the title's line, expected body, expected text]
    const expected: [string, string, string, string][] = [
      ["t", "", "", "t"],
      ["t", "\nb", "b", "t\n\nb"],
      ["t", "\r\nb\r\n", "b", "t\n\nb"],
      ["t", "\n\nb", "b", "t\n\nb"],
      ["t", "\nb\n\n  \n", "b", "t\n\nb"],
      [
        "Merge branch 'feature/dark-mode' into 'main'",
        "\nAdd dark mode toggle\n\nCloses #1\n\nSee merge request theBGuy/gitdesktop-gitlab-demo!1",
        "Add dark mode toggle\n\nCloses #1\n\nSee merge request theBGuy/gitdesktop-gitlab-demo!1",
        "Merge branch 'feature/dark-mode' into 'main'\n\nAdd dark mode toggle\n\nCloses #1\n\nSee merge request theBGuy/gitdesktop-gitlab-demo!1",
      ],
    ];
    for (const [title, rest, body, text] of expected) {
      const label = JSON.stringify(rest);
      expect(normalizeBody(rest), label).toBe(body);
      expect(mergeMessageText({ title, body: rest }), label).toBe(text);
    }
    // CRLF converts before the leading newlines are stripped.
    expect(normalizeBody("\r\n\n\nb\r\nc \t\r\n")).toBe("b\nc");
  });

  it("builds the plan with data first, then failed, then paused", () => {
    const data: MergeMessageDefaults = { commits: [], reason: "rebase" };
    const onRetry = ignore;
    const plan = (read: Partial<Parameters<typeof mergeMessagePlan>[0]>) =>
      mergeMessagePlan({
        data: undefined,
        failed: false,
        paused: false,
        onRetry,
        ...read,
      }).state;
    expect(plan({ data, failed: true, paused: true })).toBe("ready");
    expect(plan({ failed: true, paused: true })).toBe("failed");
    expect(plan({ paused: true })).toBe("offline");
    expect(plan({})).toBe("loading");
  });
});
