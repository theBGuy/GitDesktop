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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EditTitleBodyDialog,
  useEditTitleBody,
} from "@/features/conversations/EditTitleBodyDialog";
import { attachmentDiscard, attachmentStage } from "@/lib/attachments/api";
import { draftKeyFor } from "@/lib/attachments/store";
import {
  useAttachmentOwner,
  useDraftAttachments,
} from "@/lib/attachments/use-draft-attachments";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";

// A dialog's container chord handlers hear a nested modal's keys too (React
// bubbles across portals): mod+enter and the generate chord pressed in the
// attachment lightbox must not submit or generate in the dialog under it.

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/attachments/api", () => ({
  attachmentStage: vi.fn(),
  attachmentDiscard: vi.fn(async () => undefined),
}));

const KEY = draftKeyFor("issue-edit", "C:/repo#origin#7");

beforeEach(() => {
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(attachmentStage).mockImplementation(async (session) => ({
    session: session ?? "0".repeat(31).concat("1"),
    name: "image-1.png",
    mime: "image/png",
    size: 2,
    width: 1,
    height: 1,
  }));
  vi.mocked(attachmentDiscard).mockClear();
  URL.createObjectURL = vi.fn(() => "blob:nested-1");
  URL.revokeObjectURL = vi.fn();
});

afterEach(cleanup);

function Harness({
  save,
  onGenerate,
  expose,
}: {
  save: () => Promise<unknown>;
  onGenerate: () => void;
  expose: (edit: ReturnType<typeof useEditTitleBody>) => void;
}) {
  const edit = useEditTitleBody({
    onSave: () => save(),
    successToast: "Issue updated",
    attach: { draftKey: KEY, kind: "issue" },
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
      attachments={handle}
      onGenerate={onGenerate}
    />
  );
}

async function openLightbox() {
  const save = vi.fn(async () => undefined);
  const onGenerate = vi.fn();
  let edit: ReturnType<typeof useEditTitleBody> | undefined;
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <Harness
        save={save}
        onGenerate={onGenerate}
        expose={(e) => {
          edit = e;
        }}
      />
    </QueryClientProvider>,
  );
  act(() => edit?.openEdit({ title: "Seven", body: "Before" }));
  const desc = screen.getByRole("textbox", { name: "Description" });
  fireEvent.paste(desc, {
    clipboardData: {
      files: [new File([new Uint8Array([1, 2])], "shot.png")],
      types: ["Files"],
      getData: () => "",
    },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Preview image-1.png" }),
  );
  await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(2));
  const [parent, lightbox] = screen.getAllByRole("dialog");
  act(() => lightbox.focus());
  expect(lightbox.contains(document.activeElement)).toBe(true);
  return { save, onGenerate, parent, lightbox };
}

describe("the dialog's submit chord is exactly mod+enter", () => {
  it("Ctrl+Shift+Enter over a valid form does not submit; Ctrl+Enter submits once", async () => {
    const save = vi.fn(async () => undefined);
    let edit: ReturnType<typeof useEditTitleBody> | undefined;
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <Harness
          save={save}
          onGenerate={vi.fn()}
          expose={(e) => {
            edit = e;
          }}
        />
      </QueryClientProvider>,
    );
    act(() => edit?.openEdit({ title: "Seven", body: "Before" }));
    act(() => screen.getByRole("textbox", { name: "Title" }).focus());
    await userEvent.keyboard("{Control>}{Shift>}{Enter}{/Shift}{/Control}");
    expect(save).not.toHaveBeenCalled();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  });
});

describe("a nested lightbox's chords stay out of the dialog under it", () => {
  it("mod+enter in the lightbox does not submit; in the dialog's field it does", async () => {
    const { save } = await openLightbox();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(save).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
    act(() => screen.getByRole("textbox", { name: "Title" }).focus());
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  });

  it("the generate chord in the lightbox does not start the dialog's generator", async () => {
    const { onGenerate } = await openLightbox();
    await userEvent.keyboard("{Control>}g{/Control}");
    expect(onGenerate).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
    act(() => screen.getByRole("textbox", { name: "Title" }).focus());
    await userEvent.keyboard("{Control>}g{/Control}");
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });
});
