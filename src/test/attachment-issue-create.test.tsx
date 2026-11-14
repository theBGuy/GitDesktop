import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CreateIssueDialog,
  type CreateIssueHost,
} from "@/features/issues/CreateIssueDialog";
import { attachmentDiscard, attachmentStage } from "@/lib/attachments/api";
import { mintAttachmentOwner, sweepOtherOwners } from "@/lib/attachments/store";
import { forgeIssueCreate, ghIssueAddSubIssue } from "@/lib/git/api";
import { repoKeys } from "@/lib/git/queries";
import { type IssueInfo, remoteListFilterKey } from "@/lib/git/types";
import { ACT_PENDING_REASON } from "@/lib/offline-writes";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useErrorDialog } from "@/lib/stores/error-dialog";
import { useUiStore } from "@/lib/stores/ui";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
// The forge probe never answers, so no GitHub-only picker or gate reads it.
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeStatus: vi.fn(() => new Promise(() => undefined)),
  forgeIssueCreate: vi.fn(),
  ghIssueAddSubIssue: vi.fn(),
}));
const gate = vi.hoisted(() => ({ reason: null as string | null }));
vi.mock("@/lib/attachments/use-attachment-support", () => ({
  useAttachmentSupport: () => gate.reason,
}));
vi.mock("@/lib/attachments/api", () => ({
  attachmentStage: vi.fn(),
  attachmentDiscard: vi.fn(async () => undefined),
}));
// A generation is driven from the test: only its running flag matters here.
const gen = vi.hoisted(() => ({ generating: false }));
vi.mock("@/features/issues/useGenerateIssueDraft", () => ({
  useGenerateIssueDraft: () => ({
    generate: vi.fn(async () => undefined),
    cancel: vi.fn(),
    generating: gen.generating,
  }),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
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
const URL_12 = "https://github.com/owner/repo/issues/12";
const ATTACHING = "Wait for the image to finish attaching.";
const LIST_KEY = [
  ...repoKeys.issueList(REPO),
  "origin",
  "open",
  30,
  remoteListFilterKey(null),
];

let SESSION = "";
let sessionSeq = 0x200;
const selectIssue = vi.fn();

beforeEach(() => {
  sessionSeq += 1;
  SESSION = sessionSeq.toString(16).padStart(32, "0");
  gate.reason = null;
  gen.generating = false;
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(forgeIssueCreate).mockReset();
  vi.mocked(ghIssueAddSubIssue).mockReset();
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
  for (const t of [
    toast,
    toast.success,
    toast.error,
    toast.info,
    toast.warning,
  ])
    vi.mocked(t).mockClear();
  selectIssue.mockClear();
  useUiStore.setState({ repoPath: REPO, selectIssue });
  let urls = 0;
  URL.createObjectURL = vi.fn(() => {
    urls += 1;
    return `blob:create-${urls}`;
  });
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  // The store is module state: end every draft either host left, so no test
  // inherits another's entries.
  for (const host of ["issues-panel", "sub-issue"] as const)
    sweepOtherOwners("issue-create", mintAttachmentOwner(host));
});

/** Every toast of every tone this file can raise. */
const toastCount = () =>
  [toast, toast.success, toast.error, toast.info, toast.warning].reduce(
    (sum, t) => sum + vi.mocked(t).mock.calls.length,
    0,
  );

function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Draft = { title: string; body: string };
type Opener = {
  set: (open: boolean) => void;
  request: (draft: Draft | undefined) => void;
  repo: (path: string) => void;
};
type Details = (e: { currentTarget: { blur(): void } }) => void;

function Harness({
  host,
  opener,
  subIssueParentId,
}: {
  host: CreateIssueHost;
  opener: Opener;
  subIssueParentId?: string;
}) {
  const [open, setOpen] = useState(true);
  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  const [repo, setRepo] = useState(REPO);
  opener.set = setOpen;
  opener.request = setDraft;
  opener.repo = setRepo;
  return (
    <CreateIssueDialog
      repoPath={repo}
      lens="origin"
      open={open}
      onOpenChange={setOpen}
      host={host}
      subIssueParentId={subIssueParentId}
      initialDraft={draft}
    />
  );
}

function mount(
  dialogs: { host: CreateIssueHost; subIssueParentId?: string }[] = [
    { host: "issues-panel" },
  ],
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData<IssueInfo[]>(LIST_KEY, []);
  const openers = dialogs.map(
    () =>
      ({
        set: () => undefined,
        request: () => undefined,
        repo: () => undefined,
      }) as Opener,
  );
  const ui = (shown: boolean[]) => (
    <QueryClientProvider client={client}>
      {dialogs.map((d, i) =>
        shown[i] ? (
          <Harness
            key={`${d.host}-${i}`}
            host={d.host}
            opener={openers[i]}
            subIssueParentId={d.subIssueParentId}
          />
        ) : null,
      )}
    </QueryClientProvider>
  );
  const view = render(ui(dialogs.map(() => true)));
  return {
    client,
    openers,
    setOpen: (open: boolean, i = 0) => act(() => openers[i].set(open)),
    /** Reopen with an explicit draft request, as a duplicate or reference does. */
    reopenWith: (draft: Draft) =>
      act(() => {
        openers[0].request(draft);
        openers[0].set(true);
      }),
    /** Reopen with no request, as a plain open from the panel does. */
    reopenPlain: () =>
      act(() => {
        openers[0].request(undefined);
        openers[0].set(true);
      }),
    /** Switch the open repository, as the host's repo switch does. */
    switchRepo: (path: string) =>
      act(() => {
        useUiStore.setState({ repoPath: path });
        openers[0].repo(path);
      }),
    show: (shown: boolean[]) => view.rerender(ui(shown)),
    rerender: () => view.rerender(ui(dialogs.map(() => true))),
  };
}

const descriptions = () =>
  // Hidden included: with two modal dialogs open, the other one is aria-hidden.
  screen.getAllByRole("textbox", {
    name: "Description",
    hidden: true,
  }) as HTMLTextAreaElement[];
const desc = (i = 0) => descriptions()[i];
const title = () => screen.getAllByRole("textbox", { name: "Title" })[0];
const dialogOpen = () => screen.queryByRole("dialog") !== null;

function paste(target: Element, count: number) {
  const files = Array.from(
    { length: count },
    () => new File([new Uint8Array([1, 2])], "shot.png", { type: "image/png" }),
  );
  fireEvent.paste(target, {
    clipboardData: { files, types: ["Files"], getData: () => "" },
  });
}

async function stageImages(count: number, box = desc()) {
  paste(box, count);
  await waitFor(() => expect(box.value).toContain(`](image-${count}.png)`));
}

function reasonOf(el: Element) {
  return (el.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
}

const createButton = () => screen.getByRole("button", { name: "Create issue" });

/** Create is usable: a held Create is aria-disabled, never natively disabled. */
function expectCreateLive() {
  const button = createButton();
  expect(button).toBeEnabled();
  expect(button).not.toHaveAttribute("aria-disabled", "true");
}

async function fillTitle() {
  fireEvent.change(title(), { target: { value: "A new issue" } });
}

async function submit() {
  await fillTitle();
  fireEvent.click(createButton());
  await waitFor(() => expect(forgeIssueCreate).toHaveBeenCalled());
}

/** The staged names the dialog's own draft holds. */
function stagedNames(): string[] {
  const keyed = [...document.querySelectorAll("li")]
    .map((li) => li.textContent ?? "")
    .filter((t) => t.includes(".png"));
  return keyed;
}

describe("Create issue attachments", () => {
  it("sends refs in first-occurrence order as the ninth argument and opens a clean create (AC7, AC2, AC29 control)", async () => {
    const { client } = mount();
    await stageImages(2);
    const body = "B ![b](image-2.png) A ![a](image-1.png)";
    fireEvent.change(desc(), { target: { value: body } });
    vi.mocked(forgeIssueCreate).mockResolvedValue({ number: 12, url: URL_12 });
    await submit();
    expect(vi.mocked(forgeIssueCreate).mock.calls[0][8]).toEqual({
      session: SESSION,
      names: ["image-2.png", "image-1.png"],
    });
    await waitFor(() => expect(dialogOpen()).toBe(false));
    expect(toast.success).toHaveBeenCalledWith(
      "Opened issue #12",
      expect.objectContaining({ description: URL_12 }),
    );
    expect(toastCount()).toBe(1);
    expect(selectIssue).toHaveBeenCalledWith({ kind: "remote", id: "12" });
    expect(
      client.getQueryData<IssueInfo[]>(LIST_KEY)?.map((r) => r.number),
    ).toEqual([12]);
  });

  it("holds the submit while an image is still attaching", async () => {
    mount();
    const stage = deferred<Awaited<ReturnType<typeof attachmentStage>>>();
    vi.mocked(attachmentStage).mockReturnValueOnce(stage.promise);
    await fillTitle();
    paste(desc(), 1);
    await waitFor(() => expect(reasonOf(createButton())).toContain(ATTACHING));
    fireEvent.click(createButton());
    fireEvent.submit(title().closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(
        screen.getAllByRole("status").some((s) => s.textContent === ATTACHING),
      ).toBe(true),
    );
    expect(forgeIssueCreate).not.toHaveBeenCalled();
    await act(async () =>
      stage.resolve({
        session: SESSION,
        name: "image-1.png",
        mime: "image/png",
        size: 2,
        width: 1,
        height: 1,
      }),
    );
    await waitFor(() => expect(desc().value).toContain("](image-1.png)"));
    expect(reasonOf(createButton())).not.toContain(ATTACHING);
  });

  it("shows the gate reason on Attach when attaching is closed", async () => {
    gate.reason = "Attaching images isn't available here.";
    mount();
    const attach = screen.getByRole("button", { name: "Attach image" });
    expect(reasonOf(attach)).toContain(gate.reason);
  });

  it("keeps the text and every chip when nothing was created (AC8 Err control)", async () => {
    mount();
    await stageImages(1);
    const body = desc().value;
    vi.mocked(attachmentDiscard).mockClear();
    vi.mocked(forgeIssueCreate).mockRejectedValue(new Error("create refused"));
    await submit();
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toastCount()).toBe(1);
    expect(dialogOpen()).toBe(true);
    expect(desc().value).toBe(body);
    await waitFor(expectCreateLive);
    expect(stagedNames().some((t) => t.includes("image-1.png"))).toBe(true);
    expect(attachmentDiscard).not.toHaveBeenCalled();
  });

  it("heads the toast with the app's nothing-was-created line over gh's transport text", async () => {
    mount();
    await stageImages(1);
    const body = desc().value;
    const headline =
      "Nothing was created because image-1.png didn't upload. Try again.";
    vi.mocked(forgeIssueCreate).mockRejectedValue({
      kind: "gh",
      message: `${headline}\nPost "https://uploads.github.com/": dial tcp 140.82.112.6:443: i/o timeout`,
    });
    await submit();
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(vi.mocked(toast.error).mock.calls[0][0]).toBe(headline);
    expect(dialogOpen()).toBe(true);
    expect(desc().value).toBe(body);
    expect(stagedNames().some((t) => t.includes("image-1.png"))).toBe(true);
  });

  it("closes and warns once when an image didn't upload, discarding the session", async () => {
    mount();
    await stageImages(1);
    vi.mocked(attachmentDiscard).mockClear();
    vi.mocked(forgeIssueCreate).mockResolvedValue({
      number: 12,
      url: URL_12,
      failedAttachments: ["image-1.png"],
      followupError: null,
    });
    await submit();
    await waitFor(() => expect(dialogOpen()).toBe(false));
    expect(toast.warning).toHaveBeenCalledWith(
      "Issue created, but image-1.png didn't upload. Edit the description to add it again.",
      expect.objectContaining({ description: URL_12 }),
    );
    expect(toastCount()).toBe(1);
    await waitFor(() =>
      expect(attachmentDiscard).toHaveBeenCalledWith(SESSION, null),
    );
    expect(selectIssue).toHaveBeenCalledWith({ kind: "remote", id: "12" });
  });

  it("warns once with the reason under Details when the follow-up step failed", async () => {
    mount();
    const reason = "could not add assignee\ncould not set milestone";
    vi.mocked(forgeIssueCreate).mockResolvedValue({
      number: 12,
      url: URL_12,
      failedAttachments: [],
      followupError: reason,
    });
    await submit();
    await waitFor(() => expect(dialogOpen()).toBe(false));
    expect(toast.warning).toHaveBeenCalledTimes(1);
    const [msg, opts] = vi.mocked(toast.warning).mock.calls[0];
    expect(msg).toBe(
      "Issue created, but some of its details weren't applied. Check its labels, assignees, milestone and type.",
    );
    expect(opts).toMatchObject({
      duration: 10000,
      action: { label: "View" },
      cancel: { label: "Details" },
    });
    useErrorDialog.setState({ presentation: null });
    const details = (opts as unknown as { cancel: { onClick: Details } })
      .cancel;
    details.onClick({ currentTarget: { blur: () => undefined } });
    expect(useErrorDialog.getState().presentation?.fullText).toBe(
      ["Some of its details weren't applied", reason].join("\n"),
    );
    expect(toastCount()).toBe(1);
    expect(selectIssue).toHaveBeenCalledTimes(1);
  });

  it("puts the follow-up and image warnings into the one link-failure toast", async () => {
    mount([{ host: "sub-issue", subIssueParentId: "I_parent" }]);
    await stageImages(3);
    vi.mocked(ghIssueAddSubIssue).mockRejectedValue(new Error("link refused"));
    vi.mocked(forgeIssueCreate).mockResolvedValue({
      number: 12,
      url: URL_12,
      failedAttachments: ["image-1.png", "image-2.png", "image-3.png"],
      followupError: "milestone refused",
    });
    fireEvent.change(title(), { target: { value: "A new issue" } });
    fireEvent.click(screen.getByRole("button", { name: "Create sub-issue" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    const [msg, opts] = vi.mocked(toast.error).mock.calls[0];
    expect(String(msg)).toMatch(
      /^Created issue #12, but linking as a sub-issue failed: /,
    );
    expect(opts?.description).toBe(
      "Issue created, but some of its details weren't applied. Check its labels, assignees, milestone and type. Also, 3 images didn't upload. Edit the description to add them again.",
    );
    expect(toastCount()).toBe(1);
    expect(selectIssue).not.toHaveBeenCalled();
  });

  it("reports an issue whose number couldn't be read as created, with no #0 anywhere (AC29)", async () => {
    const { client } = mount();
    vi.mocked(forgeIssueCreate).mockResolvedValue({
      number: 0,
      url: "",
      failedAttachments: [],
      followupError: null,
    });
    await submit();
    await waitFor(() => expect(dialogOpen()).toBe(false));
    expect(toast.success).toHaveBeenCalledWith(
      "Opened issue",
      expect.objectContaining({ action: undefined }),
    );
    expect(toastCount()).toBe(1);
    expect(selectIssue).not.toHaveBeenCalled();
    expect(client.getQueryData<IssueInfo[]>(LIST_KEY)).toEqual([]);
  });

  it("warns once with no number when an unknown-number create carries a follow-up reason (AC29)", async () => {
    const { client } = mount();
    vi.mocked(forgeIssueCreate).mockResolvedValue({
      number: 0,
      url: "",
      failedAttachments: [],
      followupError: "number unreadable",
    });
    await submit();
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    expect(toastCount()).toBe(1);
    const all = [toast, toast.success, toast.error, toast.info, toast.warning]
      .flatMap((t) => vi.mocked(t).mock.calls)
      .map((c) => JSON.stringify(c[0]) + JSON.stringify(c[1] ?? {}));
    expect(all.some((s) => s.includes("#0"))).toBe(false);
    expect(selectIssue).not.toHaveBeenCalled();
    expect(client.getQueryData<IssueInfo[]>(LIST_KEY)).toEqual([]);
  });
});

describe("Create issue attachment lifecycle", () => {
  it("ends the session when the dialog is cancelled", async () => {
    const { setOpen } = mount();
    await stageImages(1);
    vi.mocked(attachmentDiscard).mockClear();
    setOpen(false);
    await waitFor(() =>
      expect(attachmentDiscard).toHaveBeenCalledWith(SESSION, null),
    );
  });

  it("keeps the images across a close while a create is in flight, then ends them at the settle", async () => {
    const { setOpen } = mount();
    await stageImages(1);
    vi.mocked(attachmentDiscard).mockClear();
    const create = deferred<{ number: number; url: string }>();
    vi.mocked(forgeIssueCreate).mockReturnValue(create.promise);
    await submit();
    setOpen(false);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(attachmentDiscard).not.toHaveBeenCalled();
    await act(async () => create.resolve({ number: 12, url: URL_12 }));
    await waitFor(() => expect(attachmentDiscard).toHaveBeenCalledTimes(1));
  });

  /** Create, close, and let the create fail while the dialog is closed. */
  async function failWhileClosed() {
    const harness = mount();
    await stageImages(1);
    vi.mocked(attachmentDiscard).mockClear();
    const create = deferred<{ number: number; url: string }>();
    vi.mocked(forgeIssueCreate).mockReturnValue(create.promise);
    await submit();
    harness.setOpen(false);
    await act(async () => create.reject(new Error("create refused")));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(attachmentDiscard).not.toHaveBeenCalled();
    return harness;
  }

  it("shows a draft whose create failed while closed on the first reopen, ready to retry", async () => {
    const { setOpen } = await failWhileClosed();
    const body = "](image-1.png)";
    setOpen(true);
    await waitFor(() => expect(desc().value).toContain(body));
    expect(title()).toHaveValue("A new issue");
    expect(stagedNames().some((t) => t.includes("image-1.png"))).toBe(true);
    expect(attachmentDiscard).not.toHaveBeenCalled();
    await waitFor(expectCreateLive);
    expect(toastCount()).toBe(1);
    vi.mocked(forgeIssueCreate).mockResolvedValue({ number: 12, url: URL_12 });
    fireEvent.click(createButton());
    await waitFor(() => expect(forgeIssueCreate).toHaveBeenCalledTimes(2));
    expect(vi.mocked(forgeIssueCreate).mock.calls[1]).toContain("A new issue");
    await waitFor(() => expect(dialogOpen()).toBe(false));
  });

  it("ends a re-shown failed draft at its next close, and the open after it is blank", async () => {
    const { setOpen } = await failWhileClosed();
    setOpen(true);
    await waitFor(() => expect(desc().value).toContain("](image-1.png)"));
    setOpen(false);
    await waitFor(() =>
      expect(attachmentDiscard).toHaveBeenCalledWith(SESSION, null),
    );
    setOpen(true);
    await waitFor(() => expect(desc().value).toBe(""));
    expect(title()).toHaveValue("");
    expect(stagedNames()).toEqual([]);
  });

  it("lets an explicit request outrank a failed-while-closed draft, and consume it", async () => {
    const { setOpen, reopenWith, reopenPlain } = await failWhileClosed();
    reopenWith({ title: "Requested", body: "Asked for" });
    await waitFor(() => expect(desc().value).toBe("Asked for"));
    expect(title()).toHaveValue("Requested");
    setOpen(false);
    reopenPlain();
    await waitFor(() => expect(desc().value).toBe(""));
    expect(title()).toHaveValue("");
  });

  it("never brings a failed-while-closed draft into another repository, nor back", async () => {
    const { setOpen, switchRepo } = await failWhileClosed();
    switchRepo("C:/other");
    setOpen(true);
    await waitFor(() => expect(dialogOpen()).toBe(true));
    await waitFor(() => expect(desc().value).toBe(""));
    expect(title()).toHaveValue("");
    setOpen(false);
    switchRepo(REPO);
    setOpen(true);
    await waitFor(() => expect(desc().value).toBe(""));
    expect(title()).toHaveValue("");
  });

  it("brings back no draft when a reseed replaced it before its create failed while closed", async () => {
    const { setOpen, reopenWith, reopenPlain } = mount();
    fireEvent.change(desc(), { target: { value: "First draft" } });
    const create = deferred<{ number: number; url: string }>();
    vi.mocked(forgeIssueCreate).mockReturnValue(create.promise);
    await submit();
    setOpen(false);
    reopenWith({ title: "Requested", body: "Asked for" });
    await waitFor(() => expect(desc().value).toBe("Asked for"));
    setOpen(false);
    await act(async () => create.reject(new Error("create refused")));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    reopenPlain();
    await waitFor(() => expect(desc().value).toBe(""));
    expect(title()).toHaveValue("");
  });

  it("holds Attach with the uploading text when reseeded over a running create", async () => {
    const { setOpen, reopenWith } = mount();
    await stageImages(1);
    const create = deferred<{ number: number; url: string }>();
    vi.mocked(forgeIssueCreate).mockReturnValue(create.promise);
    await submit();
    setOpen(false);
    // A reseed clears isSubmitting, so only the posting arm holds Attach here.
    reopenWith({ title: "", body: "" });
    const attach = await screen.findByRole("button", { name: "Attach image" });
    expect(reasonOf(attach)).toContain("Uploading 1 image and creating…");
    await act(async () => create.resolve({ number: 12, url: URL_12 }));
  });

  it("ends the images at the close that follows a failed create (no latch)", async () => {
    const { setOpen } = mount();
    await stageImages(1);
    vi.mocked(forgeIssueCreate).mockRejectedValue(new Error("create refused"));
    await submit();
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    await waitFor(expectCreateLive);
    vi.mocked(attachmentDiscard).mockClear();
    setOpen(false);
    await waitFor(() =>
      expect(attachmentDiscard).toHaveBeenCalledWith(SESSION, null),
    );
    setOpen(true);
    await waitFor(() => expect(desc().value).toBe(""));
    expect(stagedNames()).toEqual([]);
  });

  it("keeps the images with a draft a running generation keeps", async () => {
    const { setOpen, rerender } = mount();
    await stageImages(1);
    vi.mocked(attachmentDiscard).mockClear();
    gen.generating = true;
    rerender();
    setOpen(false);
    setOpen(true);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(attachmentDiscard).not.toHaveBeenCalled();
    expect(desc().value).toContain("](image-1.png)");
    expect(stagedNames().some((t) => t.includes("image-1.png"))).toBe(true);
  });

  it("never ends the other host's draft, and a new instance of the same host ends the earlier one's", async () => {
    const { setOpen, show } = mount([
      { host: "issues-panel" },
      { host: "sub-issue", subIssueParentId: "I_parent" },
    ]);
    await stageImages(1, desc(1));
    const subSession = SESSION;
    vi.mocked(attachmentDiscard).mockClear();
    // Closing the panel's dialog leaves the sub-issue draft alone.
    setOpen(false, 0);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(attachmentDiscard).not.toHaveBeenCalled();
    // Remounting the panel host sweeps only its own earlier instances.
    show([false, true]);
    show([true, true]);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(attachmentDiscard).not.toHaveBeenCalled();
    expect(descriptions().some((d) => d.value.includes("](image-1.png)"))).toBe(
      true,
    );
    // A second instance of the sub-issue host ends the first's entry.
    show([true, false]);
    show([true, true]);
    await waitFor(() =>
      expect(attachmentDiscard).toHaveBeenCalledWith(subSession, null),
    );
  });

  it("lets a create that settles after a reseed neither end the new draft nor close the dialog (AC11)", async () => {
    const { setOpen, reopenWith } = mount();
    await stageImages(1);
    const create = deferred<{ number: number; url: string }>();
    vi.mocked(forgeIssueCreate).mockReturnValue(create.promise);
    await submit();
    setOpen(false);
    // Only an explicit request reseeds over a running create.
    reopenWith({ title: "", body: "" });
    await waitFor(() => expect(desc().value).toBe(""));
    await act(async () => create.resolve({ number: 12, url: URL_12 }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(dialogOpen()).toBe(true);
    // The new draft stages and keeps its image past the old create's settle.
    sessionSeq += 1;
    SESSION = sessionSeq.toString(16).padStart(32, "0");
    vi.mocked(attachmentDiscard).mockClear();
    await stageImages(2);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(attachmentDiscard).not.toHaveBeenCalledWith(SESSION, null);
    expect(desc().value).toContain("](image-2.png)");
  });

  it("lets an image-less create that settles after a reopen leave the new draft's images alone", async () => {
    const { setOpen, reopenWith } = mount();
    fireEvent.change(desc(), { target: { value: "No image here" } });
    const create = deferred<{ number: number; url: string }>();
    vi.mocked(forgeIssueCreate).mockReturnValue(create.promise);
    await submit();
    setOpen(false);
    reopenWith({ title: "", body: "" });
    await waitFor(() => expect(desc().value).toBe(""));
    await stageImages(1);
    vi.mocked(attachmentDiscard).mockClear();
    await act(async () => create.resolve({ number: 12, url: URL_12 }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(attachmentDiscard).not.toHaveBeenCalledWith(SESSION, null);
    expect(stagedNames().some((s) => s.includes("image-1.png"))).toBe(true);
  });
});

describe("Create issue reopen during a create", () => {
  const BODY = "Steps to reproduce";

  async function createThenReopen() {
    const harness = mount();
    fireEvent.change(desc(), { target: { value: BODY } });
    const create = deferred<{ number: number; url: string }>();
    vi.mocked(forgeIssueCreate).mockReturnValue(create.promise);
    await submit();
    harness.setOpen(false);
    return { ...harness, create };
  }

  it("keeps the in-flight draft and holds Create, then closes once on success", async () => {
    const { setOpen, create } = await createThenReopen();
    setOpen(true);
    await waitFor(() => expect(dialogOpen()).toBe(true));
    expect(title()).toHaveValue("A new issue");
    expect(desc().value).toBe(BODY);
    // The running create's spinner joins the button's name.
    const held = screen.getByRole("button", { name: /Create issue$/ });
    expect(held).toHaveAttribute("aria-disabled", "true");
    expect(reasonOf(held)).toContain(ACT_PENDING_REASON);
    expect(forgeIssueCreate).toHaveBeenCalledTimes(1);
    await act(async () => create.resolve({ number: 12, url: URL_12 }));
    await waitFor(() => expect(dialogOpen()).toBe(false));
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toastCount()).toBe(1);
  });

  it("keeps the dialog and the draft when that create then fails, with Create live again", async () => {
    const { setOpen, create } = await createThenReopen();
    setOpen(true);
    await waitFor(() => expect(desc().value).toBe(BODY));
    await act(async () => create.reject(new Error("create refused")));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    await waitFor(expectCreateLive);
    expect(dialogOpen()).toBe(true);
    expect(title()).toHaveValue("A new issue");
    expect(desc().value).toBe(BODY);
    expect(forgeIssueCreate).toHaveBeenCalledTimes(1);
  });

  it("drops that draft at the close after its create failed in view, and reopens blank", async () => {
    const { setOpen, create } = await createThenReopen();
    setOpen(true);
    await waitFor(() => expect(desc().value).toBe(BODY));
    await act(async () => create.reject(new Error("create refused")));
    await waitFor(expectCreateLive);
    setOpen(false);
    setOpen(true);
    await waitFor(() => expect(desc().value).toBe(""));
    expect(title()).toHaveValue("");
  });

  it("starts nothing from a direct form submit or a click on the held Create", async () => {
    const { setOpen, create } = await createThenReopen();
    setOpen(true);
    await waitFor(() => expect(desc().value).toBe(BODY));
    fireEvent.click(screen.getByRole("button", { name: /Create issue$/ }));
    fireEvent.submit(title().closest("form") as HTMLFormElement);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(forgeIssueCreate).toHaveBeenCalledTimes(1);
    await act(async () => create.resolve({ number: 12, url: URL_12 }));
  });

  it("still shows an explicitly requested draft when reopened during a create", async () => {
    const { reopenWith, create } = await createThenReopen();
    reopenWith({ title: "Duplicate of #3", body: "Copied body" });
    await waitFor(() => expect(desc().value).toBe("Copied body"));
    expect(title()).toHaveValue("Duplicate of #3");
    await act(async () => create.resolve({ number: 12, url: URL_12 }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(dialogOpen()).toBe(true);
  });
});
