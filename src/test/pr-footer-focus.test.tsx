import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { afterAll, describe, expect, it } from "vitest";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { useFooterFocusSwap } from "@/features/pulls/RemotePrView";
import { unmockedCommands } from "./setup";

afterAll(() => expect(unmockedCommands).toEqual([]));

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Write = () => Promise<void> | "cancelled";

/** The two docked footers of RemotePrView around the exported hook, with the
 *  view's handler shape: ownership read at entry, armed right before the write,
 *  disarmed by its catch. The test drives the PR state the read would report. */
function Footers({
  entityKey,
  state,
  write,
}: {
  entityKey: string;
  state: "OPEN" | "CLOSED";
  write: Write;
}) {
  const openFooterRef = useRef<HTMLDivElement>(null);
  const reopenFooterRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const reopenRef = useRef<HTMLButtonElement>(null);
  const footerFocus = useFooterFocusSwap({
    entityKey,
    closeShown: state === "OPEN",
    reopenShown: state === "CLOSED",
    closeRef,
    reopenRef,
  });
  async function run(
    footer: HTMLDivElement | null,
    target: "close" | "reopen",
  ) {
    const ownsFocus = !!footer?.contains(document.activeElement);
    const started = write();
    if (started === "cancelled") return;
    if (ownsFocus) footerFocus.arm(target, entityKey);
    try {
      await started;
    } catch {
      footerFocus.disarm();
    }
  }
  return (
    <>
      <button type="button">Elsewhere</button>
      {state === "OPEN" && (
        <div ref={openFooterRef} data-testid="open-footer">
          <DisabledReasonButton
            ref={closeRef}
            onClick={() => void run(openFooterRef.current, "reopen")}
          >
            Close
          </DisabledReasonButton>
        </div>
      )}
      {state === "CLOSED" && (
        <div ref={reopenFooterRef} data-testid="closed-footer">
          <DisabledReasonButton
            ref={reopenRef}
            onClick={() => void run(reopenFooterRef.current, "close")}
          >
            Reopen
          </DisabledReasonButton>
        </div>
      )}
    </>
  );
}

const A = "C:/repos/demo#origin#7";
const B = "C:/repos/demo#origin#8";

function setup(state: "OPEN" | "CLOSED", write: Write, entityKey = A) {
  const view = render(
    <Footers entityKey={entityKey} state={state} write={write} />,
  );
  return {
    ...view,
    show: (next: "OPEN" | "CLOSED", key = entityKey) =>
      view.rerender(<Footers entityKey={key} state={next} write={write} />),
  };
}

const button = (name: string) => screen.getByRole("button", { name });

describe("useFooterFocusSwap", () => {
  it("a close fired from the footer lands on Reopen", async () => {
    const w = deferred();
    const { show } = setup("OPEN", () => w.promise);
    await userEvent.click(button("Close"));
    await act(async () => w.resolve());
    show("CLOSED");
    expect(document.activeElement).toBe(button("Reopen"));
  });

  it("a reopen fired from the footer lands on Close", async () => {
    const w = deferred();
    const { show } = setup("CLOSED", () => w.promise);
    await userEvent.click(button("Reopen"));
    await act(async () => w.resolve());
    show("OPEN");
    expect(document.activeElement).toBe(button("Close"));
  });

  it("the swap may land before the write settles", async () => {
    const w = deferred();
    const { show } = setup("OPEN", () => w.promise);
    await userEvent.click(button("Close"));
    show("CLOSED");
    expect(document.activeElement).toBe(button("Reopen"));
    await act(async () => w.resolve());
  });

  it("without the hook's landing, the swap strands focus on body (premise)", async () => {
    const { show } = setup("OPEN", () => "cancelled");
    await userEvent.click(button("Close"));
    expect(document.activeElement).toBe(button("Close"));
    show("CLOSED");
    expect(document.activeElement).toBe(document.body);
  });

  it("a failed write leaves focus on its button and disarms", async () => {
    const w = deferred();
    const { show } = setup("OPEN", () => w.promise);
    await userEvent.click(button("Close"));
    await act(async () => w.reject(new Error("boom")));
    expect(document.activeElement).toBe(button("Close"));
    // Someone else closes it later: nothing is armed any more.
    show("CLOSED");
    expect(document.activeElement).toBe(document.body);
  });

  it("a cancelled confirm never arms", async () => {
    const { show } = setup("OPEN", () => "cancelled");
    await userEvent.click(button("Close"));
    show("CLOSED");
    expect(document.activeElement).toBe(document.body);
  });

  it("a retry after a failure arms fresh", async () => {
    let attempt = 0;
    const first = deferred();
    const second = deferred();
    const { show } = setup("OPEN", () => {
      attempt += 1;
      return attempt === 1 ? first.promise : second.promise;
    });
    await userEvent.click(button("Close"));
    await act(async () => first.reject(new Error("boom")));
    await userEvent.click(button("Close"));
    await act(async () => second.resolve());
    show("CLOSED");
    expect(document.activeElement).toBe(button("Reopen"));
  });

  it("leaving the PR mid-flight lands nothing, there or back", async () => {
    const w = deferred();
    const { show } = setup("OPEN", () => w.promise);
    await userEvent.click(button("Close"));
    // The user moves to another PR, which shows closed.
    show("CLOSED", B);
    expect(document.activeElement).not.toBe(button("Reopen"));
    await act(async () => w.resolve());
    // Back on the original PR, now closed: the arm was dropped at the move.
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    show("OPEN", A);
    show("CLOSED", A);
    expect(document.activeElement).toBe(document.body);
  });

  it("a refetch swapping the footer with nothing armed moves nothing", () => {
    const { show } = setup("OPEN", () => "cancelled");
    show("CLOSED");
    expect(document.activeElement).toBe(document.body);
    show("OPEN");
    expect(document.activeElement).toBe(document.body);
  });

  it("focus the user moved elsewhere mid-flight stays there", async () => {
    const w = deferred();
    const { show } = setup("OPEN", () => w.promise);
    await userEvent.click(button("Close"));
    act(() => button("Elsewhere").focus());
    await act(async () => w.resolve());
    show("CLOSED");
    expect(document.activeElement).toBe(button("Elsewhere"));
  });

  // The view's two flags are never both true, so this pins the hook's contract
  // directly: an arm that finds its target already shown waits for a mount.
  it("lands only on a hidden-to-shown edge of the target footer", () => {
    let arm: ((target: "close" | "reopen", key: string) => void) | undefined;
    function Probe(props: { closeShown: boolean; reopenShown: boolean }) {
      const closeRef = useRef<HTMLButtonElement>(null);
      const reopenRef = useRef<HTMLButtonElement>(null);
      const footerFocus = useFooterFocusSwap({
        entityKey: A,
        ...props,
        closeRef,
        reopenRef,
      });
      arm = footerFocus.arm;
      return (
        <>
          <button ref={closeRef} type="button">
            Close
          </button>
          <button ref={reopenRef} type="button">
            Reopen
          </button>
        </>
      );
    }
    const { rerender } = render(<Probe closeShown reopenShown />);
    act(() => arm?.("reopen", A));
    rerender(<Probe closeShown={false} reopenShown />);
    expect(document.activeElement).toBe(document.body);
    rerender(<Probe closeShown={false} reopenShown={false} />);
    rerender(<Probe closeShown={false} reopenShown />);
    expect(document.activeElement).toBe(button("Reopen"));
  });

  it("a close fired with focus outside the footer never arms", async () => {
    const w = deferred();
    const { show } = setup("OPEN", () => w.promise);
    act(() => button("Elsewhere").focus());
    // A pointer-free activation (a palette or hotkey route) leaves focus where
    // it was.
    fireEvent.click(button("Close"));
    await act(async () => w.resolve());
    act(() => button("Elsewhere").blur());
    show("CLOSED");
    expect(document.activeElement).toBe(document.body);
  });
});
