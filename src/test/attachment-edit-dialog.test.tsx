import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
import { draftEntry, draftKeyFor } from "@/lib/attachments/store";
import {
  useAttachmentOwner,
  useDraftAttachments,
} from "@/lib/attachments/use-draft-attachments";
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
  seedBody?: (stored: string) => string;
  onPartialSaved?: () => void;
  generating?: boolean;
  onGenerate?: () => void;
  expose: (edit: ReturnType<typeof useEditTitleBody>) => void;
}

function Harness({
  save,
  attach = true,
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
      ? { draftKey: KEY, kind: "issue", seedBody, onPartialSaved }
      : undefined,
  });
  const owner = useAttachmentOwner("issue-edit", true);
  const handle = useDraftAttachments({
    draftKey: KEY,
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
  };
}

const desc = () =>
  screen.getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement;
const titleBox = () =>
  screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: "Save" });
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

async function stageImages(count: number) {
  const files = Array.from(
    { length: count },
    () => new File([new Uint8Array([1, 2])], "shot.png", { type: "image/png" }),
  );
  fireEvent.paste(desc(), {
    clipboardData: { files, types: ["Files"], getData: () => "" },
  });
  await waitFor(() => expect(desc().value).toContain(`](image-${count}.png)`));
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
    // The browser drops focus from a control disabled under it.
    (document.activeElement as HTMLElement | null)?.blur();
    await act(async () => pending.reject(new Error("edit refused")));
    await waitFor(() => expect(saveButton()).not.toBeDisabled());
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
    expect(saveButton()).toBeDisabled();
    titleBox().focus();
    await modEnter();
    await act(async () => undefined);
    expect(save).not.toHaveBeenCalled();
    expect(reasonOf(screen.getByRole("button", { name: "Attach image" }))).toBe(
      "Wait for the AI draft to finish",
    );
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
    // The end waits for the settle.
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

  it("lets a save that settles after a reopen leave the newer session alone (AC19)", async () => {
    const pending = deferred<unknown>();
    const save = vi.fn<Save>(() => pending.promise);
    const { open } = mount({ save });
    await open("");
    await stageImages(1);
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialog()).toBeNull());
    await open("Reopened");
    // The reopened session can't stage into the draft still posting.
    expect(reasonOf(screen.getByRole("button", { name: "Attach image" }))).toBe(
      "Uploading 1 image and saving…",
    );
    await act(async () =>
      pending.resolve({
        failedAttachments: ["image-1.png"],
        body: "![image](image-1.png)",
      }),
    );
    expect(dialog()).not.toBeNull();
    expect(desc().value).toBe("Reopened");
    expect(politeRegionText()).toBe("");
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(draftEntry(KEY)).toBeUndefined();
  });
});
