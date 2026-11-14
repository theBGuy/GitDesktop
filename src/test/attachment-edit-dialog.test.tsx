import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EditTitleBodyDialog,
  useEditTitleBody,
} from "@/features/conversations/EditTitleBodyDialog";
import { attachmentDiscard, attachmentStage } from "@/lib/attachments/api";
import type { AttachmentRefs } from "@/lib/attachments/references";
import {
  draftEntry,
  draftKeyFor,
  sweepOtherOwners,
} from "@/lib/attachments/store";
import {
  useAttachmentOwner,
  useDraftAttachments,
} from "@/lib/attachments/use-draft-attachments";
import { SUBMIT_HINT } from "@/lib/hotkeys/binding";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/attachments/api", () => ({
  attachmentStage: vi.fn(),
  attachmentDiscard: vi.fn(async () => undefined),
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
const KEY = draftKeyFor("issue-edit", `${REPO}#origin#7`);
const OTHER_KEY = draftKeyFor("issue-edit", `${REPO}#origin#8`);
const ATTACHING = "Wait for the image to finish attaching.";
const BODY_DROPPED =
  "The description wasn't saved because image-1.png didn't upload. Your other changes were saved. Save again to retry.";

let SESSION = "";
let sessionSeq = 0x300;

beforeEach(() => {
  sessionSeq += 1;
  SESSION = sessionSeq.toString(16).padStart(32, "0");
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  let n = 0;
  vi.mocked(attachmentStage).mockReset();
  vi.mocked(attachmentStage).mockImplementation(async (session) => {
    n += 1;
    return {
      session: session ?? SESSION,
      name: `image-${n}.png`,
      mime: "image/png",
      size: 2,
      width: 1,
      height: 1,
    };
  });
  vi.mocked(attachmentDiscard).mockClear();
  for (const t of [toast.success, toast.error, toast.warning]) {
    vi.mocked(t).mockClear();
  }
  let urls = 0;
  URL.createObjectURL = vi.fn(() => {
    urls += 1;
    return `blob:edit-${urls}`;
  });
  URL.revokeObjectURL = vi.fn();
});

afterEach(cleanup);

function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Save = (
  value: { title: string; body: string },
  refs: AttachmentRefs | undefined,
) => Promise<unknown>;

interface HarnessProps {
  save: Save;
  attach?: boolean;
  /** The item the dialog edits; another key is another item. */
  draftKey?: string;
  seedBody?: (stored: string) => string;
  onPartialSaved?: () => void;
  generating?: boolean;
  onGenerate?: () => void;
  expose: (edit: ReturnType<typeof useEditTitleBody>) => void;
}

function Harness({
  save,
  attach = true,
  draftKey = KEY,
  seedBody,
  onPartialSaved,
  generating,
  onGenerate,
  expose,
}: HarnessProps) {
  const edit = useEditTitleBody({
    onSave: (value, begin) => save(value, begin?.(value.body)),
    successToast: "Issue updated",
    attach: attach
      ? { draftKey, kind: "issue", seedBody, onPartialSaved }
      : undefined,
  });
  const owner = useAttachmentOwner("issue-edit", true);
  const handle = useDraftAttachments({
    draftKey,
    owner,
    gateReason: null,
    holdReason: null,
    writeDraft: (key, update) => {
      if (edit.ownsDraft(key))
        edit.form.setFieldValue("body", (prev) => update(prev));
    },
  });
  expose(edit);
  return (
    <EditTitleBodyDialog
      form={edit.form}
      open={edit.open}
      onOpenChange={edit.setOpen}
      title="Edit issue"
      description="Updates the issue."
      contentClassName={undefined}
      bodyTextareaClassName=""
      attachments={attach ? handle : undefined}
      generating={generating}
      onGenerate={onGenerate}
    />
  );
}

function mount(props: Omit<HarnessProps, "expose">) {
  let edit: ReturnType<typeof useEditTitleBody> | undefined;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = (p: Omit<HarnessProps, "expose">) => (
    <QueryClientProvider client={client}>
      <Harness
        {...p}
        expose={(e) => {
          edit = e;
        }}
      />
    </QueryClientProvider>
  );
  const view = render(ui(props));
  const open = (body = "Before") =>
    act(() => edit?.openEdit({ title: "Seven", body }));
  return {
    open,
    rerender: (p: Omit<HarnessProps, "expose">) => view.rerender(ui(p)),
    /** Unmounts the host, as selecting another kind of item does, and mounts a
     *  new instance of it (a new form and attachment owner). */
    remount: (p: Omit<HarnessProps, "expose">) => {
      view.rerender(
        <QueryClientProvider client={client}>{null}</QueryClientProvider>,
      );
      view.rerender(ui(p));
    },
  };
}

const desc = () =>
  screen.getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement;
const titleBox = () =>
  screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement;
// A running save's spinner prefixes its label ("Loading").
const saveButton = () =>
  screen.getByRole("button", { name: /^(Loading)?Save$/ });
const saveSpinner = () => within(saveButton()).queryByRole("status");
const dialog = () => screen.queryByRole("dialog");
const chipNames = () =>
  screen
    .queryAllByRole("button", { name: /^Remove image-/ })
    .map((b) => b.getAttribute("aria-label"));
const politeRegionText = () =>
  dialog()?.querySelector("form > span[aria-live='polite']")?.textContent ??
  null;
function reasonOf(el: Element): string {
  const ids = el.getAttribute("aria-describedby")?.split(" ") ?? [];
  return ids.map((id) => document.getElementById(id)?.textContent).join(" ");
}
const APPLYING = "Applying this change…";
const AI_DRAFT = "Wait for the AI draft to finish";
/** Save live: neither disabled nor held by a reason. */
function expectSaveLive() {
  expect(saveButton()).not.toBeDisabled();
  expect(saveButton()).not.toHaveAttribute("aria-disabled", "true");
}
/** Save held the reasoned way: focusable, aria-disabled, the reason read out. */
function expectSaveHeld(reason: string) {
  expect(saveButton()).not.toBeDisabled();
  expect(saveButton()).toHaveAttribute("aria-disabled", "true");
  expect(reasonOf(saveButton())).toBe(reason);
}

/** Stages `count` images; `last` is the name number the final one takes. */
async function stageImages(count: number, last = count) {
  const files = Array.from(
    { length: count },
    () => new File([new Uint8Array([1, 2])], "shot.png", { type: "image/png" }),
  );
  fireEvent.paste(desc(), {
    clipboardData: { files, types: ["Files"], getData: () => "" },
  });
  await waitFor(() => expect(desc().value).toContain(`](image-${last}.png)`));
}

/** mod+enter as a keyboard user presses it (the dialog accepts either modifier). */
const modEnter = () => userEvent.keyboard("{Control>}{Enter}{/Control}");

const partialLine = (name: string) =>
  `Saved, but ${name} didn't upload. It's still attached here. Save again to add it.`;

describe("edit dialog without attachments", () => {
  it("renders no Attach button, file input, chip list or warning region (AC12 control)", async () => {
    const { open } = mount({ save: vi.fn(), attach: false });
    await open();
    expect(desc()).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Attach image" })).toBeNull();
    expect(dialog()?.querySelector("input[type='file']")).toBeNull();
    expect(screen.queryByRole("list", { name: "Attached images" })).toBeNull();
    expect(dialog()?.querySelector("form > span[aria-live]")).toBeNull();
  });

  it("keeps a local host's save as before: a reopen during it is a fresh form that saves", async () => {
    const pending = deferred<unknown>();
    const save = vi.fn<Save>(() => pending.promise);
    const { open } = mount({ save, attach: false });
    await open();
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(saveButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialog()).toBeNull());
    await open("Fresh record");
    expect(desc().value).toBe("Fresh record");
    expect(saveButton()).not.toBeDisabled();
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await act(async () => pending.resolve(undefined));
    await waitFor(() => expect(dialog()).toBeNull());
  });

  it("holds a local host's Save with the AI-draft reason while a generation runs, so a plain Enter's click is refused", async () => {
    const save = vi.fn<Save>(async () => undefined);
    const { open } = mount({ save, attach: false, generating: true });
    await open();
    expectSaveHeld(AI_DRAFT);
    titleBox().focus();
    // The held Save refuses the implicit-submit click; submit() is never reached.
    await userEvent.keyboard("{Enter}");
    await act(async () => undefined);
    expect(save).not.toHaveBeenCalled();
  });

  it("describes a local host's live Save with the shortcut hint", async () => {
    const { open } = mount({ save: vi.fn(), attach: false });
    await open();
    expectSaveLive();
    expect(saveButton()).toHaveAccessibleDescription(SUBMIT_HINT);
  });

  it("gives a local host's running Save the AI-draft reason once a generation starts", async () => {
    const pending = deferred<unknown>();
    const save = vi.fn<Save>(() => pending.promise);
    const { open, rerender } = mount({ save, attach: false });
    await open();
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(saveButton()).toBeDisabled();
    rerender({ save, attach: false, generating: true });
    expectSaveHeld(AI_DRAFT);
    await act(async () => pending.resolve(undefined));
    await waitFor(() => expect(dialog()).toBeNull());
  });
});

describe("edit dialog outcomes", () => {
  it("sends the staged refs and closes on a clean save, ending the draft (AC13)", async () => {
    const save = vi.fn<Save>(async () => ({
      failedAttachments: [],
      body: null,
    }));
    const { open } = mount({ save });
    await open();
    expect(screen.getByRole("button", { name: "Attach image" })).toBeTruthy();
    await stageImages(1);
    fireEvent.click(saveButton());
    await waitFor(() => expect(dialog()).toBeNull());
    expect(save.mock.calls[0][1]).toEqual({
      session: SESSION,
      names: ["image-1.png"],
    });
    expect(toast.success).toHaveBeenCalledWith("Issue updated");
    expect(toast.warning).not.toHaveBeenCalled();
    expect(draftEntry(KEY)).toBeUndefined();
  });

  it("treats an old void edit outcome as a clean save (AC2)", async () => {
    const save = vi.fn<Save>(async () => undefined);
    const { open } = mount({ save });
    await open();
    fireEvent.click(saveButton());
    await waitFor(() => expect(dialog()).toBeNull());
    expect(toast.success).toHaveBeenCalledWith("Issue updated");
  });

  it("keeps the dialog, form and chips on an Err, focus inside the dialog after the settle (AC13)", async () => {
    const pending = deferred<unknown>();
    const save = vi.fn<Save>(() => pending.promise);
    const { open } = mount({ save });
    await open();
    await stageImages(1);
    fireEvent.change(titleBox(), { target: { value: "Typed title" } });
    const typed = desc().value;
    saveButton().focus();
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    // Focus leaves the form before the settle.
    (document.activeElement as HTMLElement | null)?.blur();
    await act(async () => pending.reject(new Error("edit refused")));
    await waitFor(expectSaveLive);
    expect(dialog()).not.toBeNull();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(titleBox().value).toBe("Typed title");
    expect(desc().value).toBe(typed);
    expect(chipNames()).toEqual(["Remove image-1.png"]);
    expect(draftEntry(KEY)?.images.map((i) => i.name)).toEqual(["image-1.png"]);
    expect(attachmentDiscard).not.toHaveBeenCalled();
    // Pins only that focus is in the dialog after the settle: jsdom passes this
    // with the hand-back removed, so the restore itself needs a live check.
    expect(document.activeElement).toBe(saveButton());
  });

  it("stays open on a partial save, re-seeds the body and shows the warning line (AC13-AC15)", async () => {
    const pending = deferred<unknown>();
    const save = vi.fn<Save>(() => pending.promise);
    const onPartialSaved = vi.fn();
    const { open } = mount({ save, onPartialSaved });
    await open("");
    await stageImages(2);
    fireEvent.change(titleBox(), { target: { value: "Typed title" } });
    desc().focus();
    desc().focus();
    await modEnter();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    // The description is held for the save, and Attach names the upload.
    expect(desc()).toBeDisabled();
    expect(reasonOf(screen.getByRole("button", { name: "Attach image" }))).toBe(
      "Uploading 2 images and saving…",
    );
    (document.activeElement as HTMLElement | null)?.blur();
    const returned = "Server text ![image](image-2.png)";
    await act(async () =>
      pending.resolve({ failedAttachments: ["image-2.png"], body: returned }),
    );
    await waitFor(() => expect(desc()).not.toBeDisabled());
    expect(dialog()).not.toBeNull();
    expect(desc().value).toBe(returned);
    expect(titleBox().value).toBe("Typed title");
    expect(chipNames()).toEqual(["Remove image-2.png"]);
    expect(politeRegionText()).toBe(partialLine("image-2.png"));
    // The visible line (aria-hidden) beside the polite region's copy.
    expect(screen.getAllByText(partialLine("image-2.png"))).toHaveLength(2);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(onPartialSaved).toHaveBeenCalledTimes(1);
    expect(attachmentDiscard).toHaveBeenCalledWith(SESSION, ["image-1.png"]);
    // Focus is in the dialog after the settle; jsdom cannot tell the hand-back
    // from its absence, so the restore itself needs a live check.
    expect(document.activeElement).toBe(desc());
    // The next description edit retires the line.
    fireEvent.change(desc(), { target: { value: `${returned} more` } });
    await waitFor(() => expect(politeRegionText()).toBe(""));
  });

  it("retires the warning line on a Title edit, the next save and a close (AC15)", async () => {
    const outcome = { failedAttachments: ["image-1.png"], body: "" };
    const first = deferred<unknown>();
    const save = vi.fn<Save>(() => first.promise);
    const { open } = mount({ save });
    await open("");
    await stageImages(1);
    fireEvent.click(saveButton());
    await act(async () =>
      first.resolve({ ...outcome, body: "![image](image-1.png)" }),
    );
    await waitFor(() =>
      expect(politeRegionText()).toBe(partialLine("image-1.png")),
    );
    fireEvent.change(titleBox(), { target: { value: "Retitled" } });
    await waitFor(() => expect(politeRegionText()).toBe(""));

    // A second partial brings it back; the next save clears it at its begin.
    const second = deferred<unknown>();
    save.mockReturnValueOnce(second.promise);
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1][1]?.names).toEqual(["image-1.png"]);
    await act(async () =>
      second.resolve({ ...outcome, body: "![image](image-1.png)" }),
    );
    await waitFor(() =>
      expect(politeRegionText()).toBe(partialLine("image-1.png")),
    );
    const third = deferred<unknown>();
    save.mockReturnValueOnce(third.promise);
    fireEvent.click(saveButton());
    await waitFor(() => expect(politeRegionText()).toBe(""));
    await act(async () =>
      third.resolve({ ...outcome, body: "![image](image-1.png)" }),
    );
    await waitFor(() =>
      expect(politeRegionText()).toBe(partialLine("image-1.png")),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(draftEntry(KEY)).toBeUndefined();
    await open();
    expect(politeRegionText()).toBe("");
    expect(chipNames()).toEqual([]);
  });

  it("appends a failed reference the returned body lacks, with its sent alt (AC14, defensive)", async () => {
    const pending = deferred<unknown>();
    const save = vi.fn<Save>(() => pending.promise);
    const { open } = mount({
      save,
      seedBody: (s) => s.replace(" Closes #3", ""),
    });
    await open("");
    await stageImages(1);
    fireEvent.change(desc(), {
      target: { value: "Look ![shot](image-1.png)" },
    });
    fireEvent.click(saveButton());
    await act(async () =>
      pending.resolve({
        failedAttachments: ["image-1.png"],
        body: "Saved Closes #3",
      }),
    );
    await waitFor(() =>
      expect(desc().value).toBe("Saved\n\n![shot](image-1.png)"),
    );
    expect(chipNames()).toEqual(["Remove image-1.png"]);
  });

  it("closes and warns when the read-back is absent (AC13 fallback)", async () => {
    const save = vi.fn<Save>(async () => ({
      failedAttachments: ["image-1.png"],
      body: null,
    }));
    const { open } = mount({ save });
    await open("");
    await stageImages(1);
    fireEvent.click(saveButton());
    await waitFor(() => expect(dialog()).toBeNull());
    expect(toast.warning).toHaveBeenCalledWith(
      "Issue updated, but image-1.png didn't upload. Edit the description to add it again.",
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(draftEntry(KEY)).toBeUndefined();
  });

  it("records a saved base only for an Err that says the other changes were saved (UR3)", async () => {
    const onPartialSaved = vi.fn();
    const save = vi.fn<Save>(async () => {
      throw { kind: "gh", message: BODY_DROPPED };
    });
    const { open } = mount({ save, onPartialSaved });
    await open();
    fireEvent.click(saveButton());
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(onPartialSaved).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error).mock.calls[0][0]).toBe(BODY_DROPPED);
    save.mockRejectedValueOnce({ kind: "gh", message: "HTTP 422: refused" });
    fireEvent.click(saveButton());
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2));
    expect(onPartialSaved).toHaveBeenCalledTimes(1);
    expect(dialog()).not.toBeNull();
  });
});

describe("edit dialog holds and late settles", () => {
  it("holds Save while an image attaches; mod+enter only notes it (AC17)", async () => {
    const stage = deferred<never>();
    const save = vi.fn<Save>(async () => undefined);
    const { open } = mount({ save });
    await open("");
    vi.mocked(attachmentStage).mockReturnValueOnce(stage.promise);
    fireEvent.paste(desc(), {
      clipboardData: {
        files: [
          new File([new Uint8Array([1])], "a.png", { type: "image/png" }),
        ],
        types: ["Files"],
        getData: () => "",
      },
    });
    await waitFor(() => expect(reasonOf(saveButton())).toBe(ATTACHING));
    desc().focus();
    await modEnter();
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(
        screen.getAllByRole("status").some((s) => s.textContent === ATTACHING),
      ).toBe(true),
    );
    expect(save).not.toHaveBeenCalled();
    // The store is module state: settle the stage so no later test inherits it.
    await act(async () => stage.reject(new Error("refused")));
    await waitFor(() => expect(reasonOf(saveButton())).toBe(""));
  });

  it("starts one save however often mod+enter or Enter is pressed while it runs", async () => {
    const pending = deferred<unknown>();
    const save = vi.fn<Save>(() => pending.promise);
    const { open } = mount({ save });
    await open("");
    await stageImages(1);
    desc().focus();
    await modEnter();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    // The description is held for the save, so the Title takes the presses.
    titleBox().focus();
    await modEnter();
    await userEvent.keyboard("{Enter}");
    await act(async () => undefined);
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () =>
      pending.resolve({ failedAttachments: [], body: null }),
    );
    await waitFor(() => expect(dialog()).toBeNull());
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("never submits on a held mod+enter's autorepeat", async () => {
    const save = vi.fn<Save>(async () => {
      throw new Error("edit refused");
    });
    const { open } = mount({ save });
    await open();
    titleBox().focus();
    // One press, then two autorepeat keydowns after the refused save settled.
    await userEvent.keyboard("{Control>}{Enter>3/}{/Control}");
    await act(async () => undefined);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("holds Save and mod+enter while a generation runs (AC30 direction 2)", async () => {
    const save = vi.fn<Save>(async () => undefined);
    const { open } = mount({ save, generating: true });
    await open();
    expectSaveHeld(AI_DRAFT);
    titleBox().focus();
    await modEnter();
    await act(async () => undefined);
    expect(save).not.toHaveBeenCalled();
    expect(reasonOf(screen.getByRole("button", { name: "Attach image" }))).toBe(
      AI_DRAFT,
    );
  });

  it("saves nothing while a generation runs: the held Save refuses a plain Enter, submit() a form submit", async () => {
    const save = vi.fn<Save>(async () => undefined);
    const { open } = mount({ save, generating: true });
    await open();
    expectSaveHeld(AI_DRAFT);
    titleBox().focus();
    // The held Save refuses the implicit-submit click; submit() is never reached.
    await userEvent.keyboard("{Enter}");
    await act(async () => undefined);
    const form = dialog()?.querySelector("form");
    if (!form) throw new Error("no form");
    // A direct form submit is what reaches submit()'s generating arm.
    fireEvent.submit(form);
    await act(async () => undefined);
    expect(save).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
  });

  it("lets a save that settles after a close neither re-seed nor reopen, and still toasts (AC19)", async () => {
    const pending = deferred<unknown>();
    const save = vi.fn<Save>(() => pending.promise);
    const onPartialSaved = vi.fn();
    const { open } = mount({ save, onPartialSaved });
    await open("");
    await stageImages(1);
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialog()).toBeNull());
    // The close leaves the posting draft to the settle.
    expect(draftEntry(KEY)?.posting).toEqual(["image-1.png"]);
    await act(async () =>
      pending.resolve({
        failedAttachments: ["image-1.png"],
        body: "![image](image-1.png)",
      }),
    );
    expect(dialog()).toBeNull();
    expect(onPartialSaved).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith(
      "Issue updated, but image-1.png didn't upload. Edit the description to add it again.",
    );
    expect(draftEntry(KEY)).toBeUndefined();
  });

  it("lets a save that settles after Edit opened on another item leave that item's fresh form alone (AC19)", async () => {
    const pending = deferred<unknown>();
    const save = vi.fn<Save>(() => pending.promise);
    const { open, rerender } = mount({ save });
    await open("");
    await stageImages(1);
    fireEvent.change(titleBox(), { target: { value: "Typed title" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialog()).toBeNull());
    rerender({ save, draftKey: OTHER_KEY });
    await open("Other item");
    expect(titleBox().value).toBe("Seven");
    expect(desc().value).toBe("Other item");
    expect(chipNames()).toEqual([]);
    expectSaveLive();
    await act(async () =>
      pending.resolve({
        failedAttachments: ["image-1.png"],
        body: "![image](image-1.png)",
      }),
    );
    expect(dialog()).not.toBeNull();
    expect(desc().value).toBe("Other item");
    expect(politeRegionText()).toBe("");
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(draftEntry(KEY)).toBeUndefined();
  });
});

describe("edit dialog reopened over its own save", () => {
  const cancel = () =>
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  /** Opens, types a title, stages one image and starts a save, then closes. */
  async function saveThenClose(save: Save) {
    const { open, rerender } = mount({ save, onPartialSaved });
    await open("");
    await stageImages(1);
    fireEvent.change(titleBox(), { target: { value: "Typed title" } });
    const typed = desc().value;
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    cancel();
    await waitFor(() => expect(dialog()).toBeNull());
    return { open, rerender, typed };
  }
  const onPartialSaved = vi.fn();
  beforeEach(() => onPartialSaved.mockClear());

  it("shows the running save's draft on a reopen, Save held with its reason, and the settle closes it", async () => {
    const pending = deferred<unknown>();
    const save = vi.fn<Save>(() => pending.promise);
    const { open, typed } = await saveThenClose(save);
    expect(save).toHaveBeenCalledTimes(1);
    await open("Stale record");
    expect(titleBox().value).toBe("Typed title");
    expect(desc().value).toBe(typed);
    expect(chipNames()).toEqual(["Remove image-1.png"]);
    expectSaveHeld(APPLYING);
    saveButton().focus();
    expect(document.activeElement).toBe(saveButton());
    fireEvent.click(saveButton());
    fireEvent.submit(dialog()?.querySelector("form") as HTMLFormElement);
    await act(async () => undefined);
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () =>
      pending.resolve({ failedAttachments: [], body: null }),
    );
    await waitFor(() => expect(dialog()).toBeNull());
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(draftEntry(KEY)).toBeUndefined();
  });

  it("shows a draft whose save failed while closed on the first reopen, ready to retry", async () => {
    const first = deferred<unknown>();
    const save = vi.fn<Save>(() => first.promise);
    const { open, typed } = await saveThenClose(save);
    await act(async () => first.reject({ kind: "gh", message: BODY_DROPPED }));
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(onPartialSaved).toHaveBeenCalledTimes(1);
    expect(attachmentDiscard).not.toHaveBeenCalled();
    await open("Stale record");
    expect(titleBox().value).toBe("Typed title");
    expect(desc().value).toBe(typed);
    expect(chipNames()).toEqual(["Remove image-1.png"]);
    expectSaveLive();
    save.mockRejectedValueOnce(new Error("edit refused"));
    fireEvent.click(saveButton());
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][1]).toEqual({
      session: SESSION,
      names: ["image-1.png"],
    });
    // A failure in view is not kept past the close.
    cancel();
    await waitFor(() => expect(dialog()).toBeNull());
    expect(draftEntry(KEY)).toBeUndefined();
    await open("Fresh record");
    expect(titleBox().value).toBe("Seven");
    expect(desc().value).toBe("Fresh record");
    expect(chipNames()).toEqual([]);
  });

  it("drops a draft whose save failed in view at the close, and reopens fresh", async () => {
    const pending = deferred<unknown>();
    const save = vi.fn<Save>(() => pending.promise);
    const { open } = mount({ save });
    await open("");
    await stageImages(1);
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await act(async () => pending.reject(new Error("edit refused")));
    await waitFor(expectSaveLive);
    cancel();
    await waitFor(() => expect(dialog()).toBeNull());
    expect(draftEntry(KEY)).toBeUndefined();
    await open("Fresh record");
    expect(desc().value).toBe("Fresh record");
    expect(chipNames()).toEqual([]);
  });

  it("keeps another item's running save in flight when an older save settles, so its failure while closed comes back whole", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const save = vi
      .fn<Save>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { open, rerender } = await saveThenClose(save);
    rerender({ save, onPartialSaved, draftKey: OTHER_KEY });
    await open("Other item");
    await stageImages(1, 2);
    fireEvent.change(titleBox(), { target: { value: "Other title" } });
    const typed = desc().value;
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await act(async () => first.resolve({ failedAttachments: [], body: null }));
    cancel();
    await waitFor(() => expect(dialog()).toBeNull());
    await act(async () => second.reject({ kind: "gh", message: BODY_DROPPED }));
    expect(draftEntry(OTHER_KEY)?.images.map((i) => i.name)).toEqual([
      "image-2.png",
    ]);
    await open("Stale record");
    expect(titleBox().value).toBe("Other title");
    expect(desc().value).toBe(typed);
    expect(chipNames()).toEqual(["Remove image-2.png"]);
    expectSaveLive();
    save.mockResolvedValueOnce({ failedAttachments: [], body: null });
    fireEvent.click(saveButton());
    await waitFor(() => expect(dialog()).toBeNull());
    expect(save.mock.calls[2][1]).toEqual({
      session: SESSION,
      names: ["image-2.png"],
    });
  });

  it("ends a draft kept by a failure while closed when Edit opens on another item", async () => {
    const first = deferred<unknown>();
    const save = vi.fn<Save>(() => first.promise);
    const { open, rerender } = await saveThenClose(save);
    await act(async () => first.reject(new Error("edit refused")));
    expect(draftEntry(KEY)?.images.map((i) => i.name)).toEqual(["image-1.png"]);
    rerender({ save, onPartialSaved, draftKey: OTHER_KEY });
    await open("Other item");
    expect(desc().value).toBe("Other item");
    expect(draftEntry(KEY)).toBeUndefined();
    await waitFor(() =>
      expect(attachmentDiscard).toHaveBeenCalledWith(SESSION, null),
    );
  });

  it("reopens fresh when a failure while closed finds its draft's images already ended", async () => {
    const first = deferred<unknown>();
    const save = vi.fn<Save>(() => first.promise);
    const { open } = await saveThenClose(save);
    // Another mount of the surface sweeps the closed draft; its end waits for
    // the post, and the failed settle discards the images.
    act(() => sweepOtherOwners("issue-edit", {}));
    await act(async () => first.reject({ kind: "gh", message: BODY_DROPPED }));
    expect(draftEntry(KEY)).toBeUndefined();
    await open("Fresh record");
    expect(titleBox().value).toBe("Seven");
    expect(desc().value).toBe("Fresh record");
    expect(chipNames()).toEqual([]);
    expectSaveLive();
  });

  it("keeps Save held on a reopen while that item's save runs after another item's save settled, and sends nothing more", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const save = vi
      .fn<Save>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { open, rerender } = await saveThenClose(save);
    rerender({ save, onPartialSaved, draftKey: OTHER_KEY });
    await open("Other item");
    await stageImages(1, 2);
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    cancel();
    await waitFor(() => expect(dialog()).toBeNull());
    await act(async () => first.resolve({ failedAttachments: [], body: null }));
    await open("Stale record");
    expect(desc().value).toContain("](image-2.png)");
    expectSaveHeld(APPLYING);
    expect(saveSpinner()).not.toBeNull();
    titleBox().focus();
    await modEnter();
    fireEvent.click(saveButton());
    fireEvent.submit(dialog()?.querySelector("form") as HTMLFormElement);
    await act(async () => undefined);
    expect(save).toHaveBeenCalledTimes(2);
    await act(async () =>
      second.resolve({ failedAttachments: [], body: null }),
    );
    await waitFor(() => expect(dialog()).toBeNull());
    expect(toast.success).toHaveBeenCalledTimes(2);
    expect(draftEntry(OTHER_KEY)).toBeUndefined();
  });

  it("keeps Save held in an open dialog while its item's save runs after another item's save settled", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const save = vi
      .fn<Save>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { open, rerender } = await saveThenClose(save);
    rerender({ save, onPartialSaved, draftKey: OTHER_KEY });
    await open("Other item");
    await stageImages(1, 2);
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await act(async () => first.resolve({ failedAttachments: [], body: null }));
    expect(dialog()).not.toBeNull();
    expectSaveHeld(APPLYING);
    titleBox().focus();
    await modEnter();
    await act(async () => undefined);
    expect(save).toHaveBeenCalledTimes(2);
    await act(async () =>
      second.resolve({ failedAttachments: [], body: null }),
    );
    await waitFor(() => expect(dialog()).toBeNull());
  });

  it("holds Save, but not the description, on a fresh form of an item whose older save runs", async () => {
    const pending = deferred<unknown>();
    const save = vi.fn<Save>(() => pending.promise);
    const { open, rerender } = await saveThenClose(save);
    rerender({ save, onPartialSaved, draftKey: OTHER_KEY });
    await open("Other item");
    cancel();
    await waitFor(() => expect(dialog()).toBeNull());
    rerender({ save, onPartialSaved });
    await open("Fresh record");
    expect(titleBox().value).toBe("Seven");
    expect(desc().value).toBe("Fresh record");
    expectSaveHeld(APPLYING);
    expect(saveSpinner()).not.toBeNull();
    expect(desc()).not.toBeDisabled();
    titleBox().focus();
    await modEnter();
    await act(async () => undefined);
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () =>
      pending.resolve({ failedAttachments: [], body: null }),
    );
    expect(dialog()).not.toBeNull();
    expectSaveLive();
    expect(saveSpinner()).toBeNull();
  });

  it("lets an older save landing after a host remount leave the new instance's draft and its images alone", async () => {
    const first = deferred<unknown>();
    const save = vi
      .fn<Save>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ failedAttachments: [], body: null });
    const { open, remount } = mount({ save });
    await open("");
    await stageImages(1);
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    cancel();
    await waitFor(() => expect(dialog()).toBeNull());
    remount({ save });
    await open("Fresh record");
    await stageImages(1, 2);
    expect(chipNames()).toEqual(["Remove image-2.png"]);
    await act(async () => first.resolve({ failedAttachments: [], body: null }));
    expect(chipNames()).toEqual(["Remove image-2.png"]);
    expect(draftEntry(KEY)?.images.map((i) => i.name)).toEqual(["image-2.png"]);
    expect(desc().value).toContain("](image-2.png)");
    fireEvent.click(saveButton());
    await waitFor(() => expect(dialog()).toBeNull());
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][1]).toEqual({
      session: SESSION,
      names: ["image-2.png"],
    });
  });

  it("ends a left draft's images when its save fails after Edit opened on another item", async () => {
    const first = deferred<unknown>();
    const save = vi.fn<Save>(() => first.promise);
    const { open, rerender } = await saveThenClose(save);
    rerender({ save, onPartialSaved, draftKey: OTHER_KEY });
    await open("Other item");
    await act(async () => first.reject(new Error("edit refused")));
    expect(draftEntry(KEY)).toBeUndefined();
    await waitFor(() =>
      expect(attachmentDiscard).toHaveBeenCalledWith(SESSION, null),
    );
  });

  it("ends a left draft's unreferenced images when its save lands after Edit opened on another item", async () => {
    const pending = deferred<unknown>();
    const save = vi.fn<Save>(() => pending.promise);
    const { open, rerender } = mount({ save });
    await open("");
    await stageImages(1);
    fireEvent.change(desc(), { target: { value: "No images" } });
    expect(draftEntry(KEY)?.images.map((i) => i.name)).toEqual(["image-1.png"]);
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][1]).toBeUndefined();
    cancel();
    await waitFor(() => expect(dialog()).toBeNull());
    rerender({ save, draftKey: OTHER_KEY });
    await open("Other item");
    await act(async () =>
      pending.resolve({ failedAttachments: [], body: null }),
    );
    expect(draftEntry(KEY)).toBeUndefined();
  });

  it("lets another item save while one item's save runs", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const save = vi
      .fn<Save>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { open, rerender } = await saveThenClose(save);
    rerender({ save, onPartialSaved, draftKey: OTHER_KEY });
    await open("Other item");
    expectSaveLive();
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await act(async () =>
      second.resolve({ failedAttachments: [], body: null }),
    );
    await waitFor(() => expect(dialog()).toBeNull());
    await act(async () => first.resolve({ failedAttachments: [], body: null }));
    expect(toast.success).toHaveBeenCalledTimes(2);
  });

  it("keeps another item's running save in flight when an older save fails, so its failure while closed comes back whole", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const save = vi
      .fn<Save>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { open, rerender } = await saveThenClose(save);
    rerender({ save, onPartialSaved, draftKey: OTHER_KEY });
    await open("Other item");
    await stageImages(1, 2);
    fireEvent.change(titleBox(), { target: { value: "Other title" } });
    const typed = desc().value;
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await act(async () => first.reject(new Error("edit refused")));
    expect(toast.error).toHaveBeenCalledTimes(1);
    expectSaveHeld(APPLYING);
    cancel();
    await waitFor(() => expect(dialog()).toBeNull());
    await act(async () => second.reject({ kind: "gh", message: BODY_DROPPED }));
    expect(toast.error).toHaveBeenCalledTimes(2);
    expect(draftEntry(OTHER_KEY)?.images.map((i) => i.name)).toEqual([
      "image-2.png",
    ]);
    await open("Stale record");
    expect(titleBox().value).toBe("Other title");
    expect(desc().value).toBe(typed);
    expect(chipNames()).toEqual(["Remove image-2.png"]);
    expectSaveLive();
    save.mockResolvedValueOnce({ failedAttachments: [], body: null });
    fireEvent.click(saveButton());
    await waitFor(() => expect(dialog()).toBeNull());
    expect(save.mock.calls[2][1]).toEqual({
      session: SESSION,
      names: ["image-2.png"],
    });
  });

  it("locks the description only while a save carrying images runs", async () => {
    const plain = deferred<unknown>();
    const save = vi.fn<Save>(() => plain.promise);
    const { open } = mount({ save });
    await open();
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expectSaveHeld(APPLYING);
    expect(desc()).not.toBeDisabled();
    await act(async () => plain.reject(new Error("edit refused")));
    await waitFor(expectSaveLive);
    await stageImages(1);
    const carrying = deferred<unknown>();
    save.mockReturnValueOnce(carrying.promise);
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(desc()).toBeDisabled();
    await act(async () => carrying.reject(new Error("edit refused")));
    await waitFor(() => expect(desc()).not.toBeDisabled());
  });
});
