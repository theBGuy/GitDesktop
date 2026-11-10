import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { RunWorkflowDialog } from "@/features/actions/RunWorkflowDialog";
import {
  type DispatchProbe,
  isDispatchInputsError,
  type WorkflowInput,
} from "@/lib/github/actions";
import { invoke } from "@/lib/tauri/invoke";
import { unmockedCommands } from "./setup";

// The actions module calls its own invoke wrappers internally, so the seam is the
// shared invoke rather than the module's exports; the predicate is stubbed so the
// test pins the dialog's branch, not the predicate's copy match.
vi.mock("@/lib/tauri/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri/invoke")>()),
  invoke: vi.fn(),
}));
vi.mock("@/lib/github/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github/actions")>()),
  isDispatchInputsError: vi.fn(() => false),
}));
let provider = "github";
vi.mock("@/lib/git/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/queries")>()),
  useForgeStatus: () => ({
    data: { provider },
    error: null,
    isPending: false,
    isError: false,
    isPaused: false,
    isFetching: false,
    isPlaceholderData: false,
    refetch: () => Promise.resolve(),
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

const REPO = "C:/repos/demo";
const CI = {
  id: 1,
  name: "CI",
  path: ".github/workflows/ci.yml",
  state: "active",
};
const DEPLOY = {
  id: 2,
  name: "Deploy",
  path: ".github/workflows/deploy.yml",
  state: "active",
};
const stray: string[] = [];

afterAll(() => {
  expect(unmockedCommands).toEqual([]);
  expect(stray).toEqual([]);
});

const input = (
  name: string,
  type: WorkflowInput["type"],
  extra: Partial<WorkflowInput> = {},
): WorkflowInput => ({
  name,
  type,
  description: null,
  default: null,
  required: false,
  options: [],
  ...extra,
});
const declared = (inputs: WorkflowInput[] | null): DispatchProbe => ({
  declared: true,
  inputs,
});

type ProbeAnswer = Record<string, DispatchProbe> | Error | "pending";
let workflows = [CI];
/** The probe's answer per ref; a ref missing here rejects. */
let probes: Record<string, ProbeAnswer>;
let dispatchError: unknown = null;

beforeEach(() => {
  stray.length = 0;
  provider = "github";
  workflows = [CI];
  probes = {};
  dispatchError = null;
  vi.mocked(isDispatchInputsError).mockReturnValue(false);
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    switch (cmd) {
      case "gh_workflow_list":
        return workflows;
      case "gh_workflow_dispatchable": {
        const answer = probes[(args as { gitRef: string }).gitRef];
        if (answer === "pending") return new Promise(() => undefined);
        if (answer === undefined || answer instanceof Error)
          throw answer ?? new Error("probe failed");
        return answer;
      }
      case "forge_ci_dispatch":
        if (dispatchError) throw dispatchError;
        return undefined;
      default:
        stray.push(cmd);
        return undefined;
    }
  });
});
afterEach(() => vi.mocked(invoke).mockReset());

const probeCalls = (ref?: string) =>
  vi
    .mocked(invoke)
    .mock.calls.filter(
      ([cmd, args]) =>
        cmd === "gh_workflow_dispatchable" &&
        (ref === undefined || (args as { gitRef: string }).gitRef === ref),
    ).length;
const sent = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([cmd]) => cmd === "forge_ci_dispatch")
    .map(([, args]) => (args as { inputs: Record<string, string> }).inputs);

function renderDialog(defaultRef = "main") {
  const user = userEvent.setup();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <RunWorkflowDialog
        repoPath={REPO}
        open
        onOpenChange={() => undefined}
        defaultRef={defaultRef}
      />
    </QueryClientProvider>,
  );
  return user;
}

const status = () => screen.getByRole("status");
const group = () => screen.getByRole("group", { name: "Inputs" });
const runButton = () => screen.getByRole("button", { name: /^Run / });
const disclosure = () =>
  screen.getByRole("button", { name: /^Additional inputs/ });
const refField = () => screen.getByRole("textbox", { name: "Branch or tag" });
const field = (name: string) =>
  screen.getByLabelText(name, { selector: "input" });
const statusIs = (text: string) =>
  waitFor(() => expect(status()).toHaveTextContent(text), { timeout: 2000 });

/** Replaces the ref and waits out the dialog's debounce. */
async function typeRef(user: ReturnType<typeof userEvent.setup>, ref: string) {
  await user.clear(refField());
  if (ref) await user.type(refField(), ref);
}

const UNREAD_MAIN =
  "Couldn't read this workflow's inputs at main; add them by name.";

describe("RunWorkflowDialog input arms", () => {
  it("fallback arms: empty ref with nothing held never probes", async () => {
    renderDialog("");
    await screen.findByRole("group", { name: "Inputs" });
    expect(status()).toHaveTextContent(
      "Enter a branch or tag to read this workflow's inputs.",
    );
    expect(disclosure()).toHaveAttribute("aria-expanded", "true");
    expect(group().querySelector("[aria-busy]")).toBeNull();
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Workflow" }),
      ).toHaveTextContent("CI"),
    );
    expect(runButton()).toHaveAccessibleDescription("Enter a branch or tag");
    expect(probeCalls()).toBe(0);
  });

  it("fallback arms: empty ref after a landing keeps the dirty field", async () => {
    probes.main = {
      "1": declared([input("version", "string", { required: true })]),
    };
    const user = renderDialog();
    await waitFor(() => expect(field("version")).toBeInTheDocument());
    await user.type(field("version"), "2.0");
    await typeRef(user, "");
    await statusIs("Enter a branch or tag to read this workflow's inputs.");
    expect(field("version")).toHaveValue("2.0");
    expect(runButton()).toHaveAccessibleDescription("Enter a branch or tag");
  });

  it("fallback arms: pending shows the reading line, skeletons and an open disclosure", async () => {
    probes.main = "pending";
    renderDialog();
    await statusIs("Reading inputs…");
    const busy = group().querySelector("[aria-busy='true']");
    expect(busy?.querySelectorAll("[aria-hidden='true']")).toHaveLength(2);
    expect(disclosure()).toHaveAttribute("aria-expanded", "true");
  });

  it.each([
    ["a rejected probe", () => new Error("boom")],
    ["a map without the workflow", () => ({})],
    ["an unparsed schema", () => ({ "1": declared(null) })],
  ])("fallback arms: %s keeps free rows that dispatch", async (_, answer) => {
    probes.main = answer();
    const user = renderDialog();
    await statusIs(UNREAD_MAIN);
    expect(disclosure()).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("button", { name: "Add input" }));
    await user.type(screen.getByRole("textbox", { name: "Input name" }), "tag");
    await user.type(
      screen.getByRole("textbox", { name: "Value for tag" }),
      "v9",
    );
    await user.click(runButton());
    await waitFor(() => expect(sent()).toEqual([{ tag: "v9" }]));
  });

  it("fallback arms: an empty schema says the workflow declares no inputs", async () => {
    probes.main = { "1": declared([]) };
    renderDialog();
    await statusIs("This workflow declares no inputs.");
    expect(disclosure()).toHaveAttribute("aria-expanded", "true");
  });

  it("declared===false marking: the group hides and Run holds", async () => {
    probes.main = { "1": { declared: false, inputs: null } };
    const user = renderDialog();
    await waitFor(() =>
      expect(runButton()).toHaveAccessibleDescription(
        "This workflow has no manual trigger on this branch or tag",
      ),
    );
    expect(screen.queryByRole("group", { name: "Inputs" })).toBeNull();
    await user.click(screen.getByRole("combobox", { name: "Workflow" }));
    const row = await screen.findByRole("option", {
      name: "CI (no manual trigger)",
    });
    expect(row).toHaveAttribute("aria-disabled", "true");
  });

  it("held schema survives a failed re-read, and only a landed list replaces it", async () => {
    probes.main = {
      "1": declared([input("version", "string", { default: "1.0" })]),
    };
    probes.mai = new Error("no such ref");
    const user = renderDialog();
    await waitFor(() => expect(field("version")).toHaveValue("1.0"));
    await user.clear(field("version"));
    await user.type(field("version"), "2.0");
    const node = field("version");

    await typeRef(user, "mai");
    await statusIs(
      "Couldn't re-read inputs on mai; showing the last known inputs",
    );
    expect(field("version")).toBe(node);
    expect(field("version")).toHaveValue("2.0");

    await user.type(refField(), "n");
    await waitFor(() => expect(status()).toHaveTextContent(/^$/), {
      timeout: 2000,
    });
    expect(field("version")).toBe(node);
    expect(field("version")).toHaveValue("2.0");

    const rereads: Record<string, DispatchProbe>[] = [
      {},
      { "1": declared(null) },
    ];
    for (const answer of rereads) {
      probes.mai2 = answer;
      await typeRef(user, "mai2");
      await statusIs(
        "Couldn't re-read inputs on mai2; showing the last known inputs",
      );
      expect(field("version")).toHaveValue("2.0");
      await typeRef(user, "main");
      await waitFor(() => expect(status()).toHaveTextContent(/^$/), {
        timeout: 2000,
      });
    }

    probes.mai3 = { "1": declared([]) };
    await typeRef(user, "mai3");
    await statusIs("This workflow declares no inputs.");
    expect(
      screen.queryByLabelText("version", { selector: "input" }),
    ).toBeNull();
  });

  it("focus landing after re-seed: a dropped focused field lands on the group host", async () => {
    probes.main = {
      "1": declared([
        input("version", "string", { default: "1.0" }),
        input("keep", "string", { default: "a" }),
        input("extra", "string"),
      ]),
    };
    probes.dev = {
      "1": declared([
        input("version", "string", { default: "9.9" }),
        input("keep", "string", { default: "b" }),
      ]),
    };
    const user = renderDialog();
    await waitFor(() => expect(field("extra")).toBeInTheDocument());
    await user.clear(field("version"));
    await user.type(field("version"), "2.0");
    await typeRef(user, "dev");
    // Back into a field before the debounce settles, so the landing finds it focused.
    await user.click(field("extra"));
    await statusIs("Inputs updated for dev");
    expect(screen.queryByLabelText("extra", { selector: "input" })).toBeNull();
    expect(document.activeElement).toBe(group());
    expect(field("version")).toHaveValue("2.0");
    expect(field("keep")).toHaveValue("b");
  });

  it("schema landing absorbs a pre-typed row into its field, focus following", async () => {
    let land: (v: Record<string, DispatchProbe>) => void = () => undefined;
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "gh_workflow_list") return workflows;
      if (cmd === "gh_workflow_dispatchable")
        return new Promise((resolve) => {
          land = resolve;
        });
      stray.push(cmd);
      return undefined;
    });
    const user = renderDialog();
    await statusIs("Reading inputs…");
    await user.click(screen.getByRole("button", { name: "Add input" }));
    await user.type(
      screen.getByRole("textbox", { name: "Input name" }),
      "VERSION",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Value for VERSION" }),
      "3.1",
    );
    land({
      "1": declared([
        input("version", "string", { default: "1.0" }),
        input("env", "choice", { options: ["dev"] }),
      ]),
    });
    await waitFor(() => expect(field("version")).toHaveValue("3.1"));
    expect(screen.queryByRole("textbox", { name: "Input name" })).toBeNull();
    expect(field("version")).toHaveFocus();
  });

  it("schema landing keeps the disclosure open while focus is inside it", async () => {
    let land: (v: Record<string, DispatchProbe>) => void = () => undefined;
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "gh_workflow_list") return workflows;
      if (cmd === "gh_workflow_dispatchable")
        return new Promise((resolve) => {
          land = resolve;
        });
      stray.push(cmd);
      return undefined;
    });
    renderDialog();
    await statusIs("Reading inputs…");
    const add = screen.getByRole("button", { name: "Add input" });
    add.focus();
    land({ "1": declared([input("version", "string")]) });
    await waitFor(() => expect(field("version")).toBeInTheDocument());
    expect(disclosure()).toHaveAttribute("aria-expanded", "true");
    expect(add).toHaveFocus();
  });

  it("schema landing leaves a row the field can't hold, and Run holds", async () => {
    let land: (v: Record<string, DispatchProbe>) => void = () => undefined;
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "gh_workflow_list") return workflows;
      if (cmd === "gh_workflow_dispatchable")
        return new Promise((resolve) => {
          land = resolve;
        });
      stray.push(cmd);
      return undefined;
    });
    const user = renderDialog();
    await statusIs("Reading inputs…");
    await user.click(screen.getByRole("button", { name: "Add input" }));
    await user.type(screen.getByRole("textbox", { name: "Input name" }), "env");
    await user.type(
      screen.getByRole("textbox", { name: "Value for env" }),
      "qa",
    );
    land({ "1": declared([input("env", "choice", { options: ["dev"] })]) });
    await waitFor(() =>
      expect(runButton()).toHaveAccessibleDescription(
        "'env' is already an input above",
      ),
    );
    expect(screen.getByRole("textbox", { name: "Input name" })).toHaveValue(
      "env",
    );
    expect(disclosure()).toHaveAttribute("aria-expanded", "true");
  });

  it("workflow change re-seeds every field while rows and the disclosure persist", async () => {
    workflows = [CI, DEPLOY];
    probes.main = {
      "1": declared([input("version", "string", { default: "1.0" })]),
      "2": declared([input("version", "string", { default: "5.0" })]),
    };
    const user = renderDialog();
    await waitFor(() => expect(field("version")).toHaveValue("1.0"));
    await user.clear(field("version"));
    await user.type(field("version"), "edited");
    await user.click(disclosure());
    await user.click(screen.getByRole("button", { name: "Add input" }));
    await user.type(screen.getByRole("textbox", { name: "Input name" }), "x");
    await user.click(screen.getByRole("combobox", { name: "Workflow" }));
    await user.click(await screen.findByRole("option", { name: "Deploy" }));
    await waitFor(() => expect(field("version")).toHaveValue("5.0"));
    expect(screen.getByRole("textbox", { name: "Input name" })).toHaveValue(
      "x",
    );
    expect(disclosure()).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("combobox", { name: "Workflow" }));
    await user.click(await screen.findByRole("option", { name: "CI" }));
    await waitFor(() => expect(field("version")).toHaveValue("1.0"));
  });

  it("a failed dispatch for which isDispatchInputsError is true re-probes while open", async () => {
    probes.main = {
      "1": declared([input("version", "string", { default: "1.0" })]),
    };
    vi.mocked(isDispatchInputsError).mockReturnValue(true);
    dispatchError = { kind: "gh", message: "rejected" };
    const user = renderDialog();
    await waitFor(() => expect(field("version")).toHaveValue("1.0"));
    expect(probeCalls("main")).toBe(1);
    await user.clear(field("version"));
    await user.type(field("version"), "2.0");
    probes.main = {
      "1": declared([
        input("version", "string", { default: "1.5" }),
        input("added", "string", { default: "new" }),
      ]),
    };
    await user.click(runButton());
    await waitFor(() => expect(probeCalls("main")).toBe(2));
    await waitFor(() => expect(field("added")).toHaveValue("new"));
    expect(field("version")).toHaveValue("2.0");
    expect(vi.mocked(isDispatchInputsError)).toHaveBeenCalledWith(
      dispatchError,
    );
  });

  it("a failed dispatch for which isDispatchInputsError is false keeps the verdict", async () => {
    probes.main = { "1": declared([input("version", "string")]) };
    dispatchError = { kind: "gh", message: "other" };
    const user = renderDialog();
    await waitFor(() => expect(field("version")).toBeInTheDocument());
    await user.click(runButton());
    await waitFor(() => expect(sent()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(probeCalls("main")).toBe(1);
  });

  it("a failed refetch over a held schema shows the stale line, keeping the fields", async () => {
    probes.main = {
      "1": declared([input("version", "string", { default: "1.0" })]),
    };
    vi.mocked(isDispatchInputsError).mockReturnValue(true);
    dispatchError = { kind: "gh", message: "rejected" };
    const user = renderDialog();
    await waitFor(() => expect(field("version")).toHaveValue("1.0"));
    await user.clear(field("version"));
    await user.type(field("version"), "2.0");
    probes.main = new Error("gh failed");
    await user.click(runButton());
    await statusIs(
      "Couldn't re-read inputs on main; showing the last known inputs",
    );
    expect(probeCalls("main")).toBe(2);
    expect(field("version")).toHaveValue("2.0");
  });

  it("an empty landing that drops the focused field keeps the update note", async () => {
    probes.main = { "1": declared([input("version", "string")]) };
    probes.dev = { "1": declared([]) };
    const user = renderDialog();
    await waitFor(() => expect(field("version")).toBeInTheDocument());
    const host = group();
    await typeRef(user, "dev");
    await user.click(field("version"));
    await statusIs("Inputs updated for dev. This workflow declares no inputs.");
    expect(document.activeElement).toBe(host);
  });

  it("a refusal landing under a focused field lands focus on the surviving host", async () => {
    probes.main = { "1": declared([input("version", "string")]) };
    probes.dev = { "1": { declared: false, inputs: null } };
    const user = renderDialog();
    await waitFor(() => expect(field("version")).toBeInTheDocument());
    const host = group();
    await typeRef(user, "dev");
    await user.click(field("version"));
    await waitFor(
      () =>
        expect(runButton()).toHaveAccessibleDescription(
          "This workflow has no manual trigger on this branch or tag",
        ),
      { timeout: 2000 },
    );
    expect(screen.queryByRole("group", { name: "Inputs" })).toBeNull();
    expect(document.activeElement).toBe(host);
  });

  it("list arm: removing the last row keeps the disclosure open on Add input", async () => {
    let land: (v: Record<string, DispatchProbe>) => void = () => undefined;
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "gh_workflow_list") return workflows;
      if (cmd === "gh_workflow_dispatchable")
        return new Promise((resolve) => {
          land = resolve;
        });
      stray.push(cmd);
      return undefined;
    });
    const user = renderDialog();
    await statusIs("Reading inputs…");
    await user.click(screen.getByRole("button", { name: "Add input" }));
    await user.type(screen.getByRole("textbox", { name: "Input name" }), "x");
    land({ "1": declared([input("version", "string")]) });
    await waitFor(() => expect(field("version")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Remove input x" }));
    expect(disclosure()).toHaveAttribute("aria-expanded", "true");
    const add = screen.getByRole("button", { name: "Add input" });
    expect(add).toBeVisible();
    expect(add).toHaveFocus();
  });

  it("a reopen over a cached probe re-seeds the held schema without a reading arm", async () => {
    probes.main = {
      "1": declared([input("version", "string", { default: "1.0" })]),
    };
    const user = userEvent.setup();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const ui = (open: boolean) => (
      <QueryClientProvider client={client}>
        <RunWorkflowDialog
          repoPath={REPO}
          open={open}
          onOpenChange={() => undefined}
          defaultRef="main"
        />
      </QueryClientProvider>
    );
    const { rerender } = render(ui(true));
    await waitFor(() => expect(field("version")).toHaveValue("1.0"));
    await user.clear(field("version"));
    await user.type(field("version"), "2.0");
    rerender(ui(false));
    await waitFor(() =>
      expect(
        screen.queryByLabelText("version", { selector: "input" }),
      ).toBeNull(),
    );
    rerender(ui(true));
    expect(screen.queryByText("Reading inputs…")).toBeNull();
    await waitFor(() => expect(field("version")).toHaveValue("1.0"));
    expect(screen.queryByText("Reading inputs…")).toBeNull();
    expect(group().querySelector("[aria-busy]")).toBeNull();
    expect(disclosure()).toHaveAttribute("aria-expanded", "false");
    expect(probeCalls("main")).toBe(1);
  });

  it("free rows: removing focuses the next row, else the previous, else Add input", async () => {
    probes.main = {};
    const user = renderDialog();
    await statusIs(UNREAD_MAIN);
    const add = screen.getByRole("button", { name: "Add input" });
    for (const k of ["a", "b", "c"]) {
      await user.click(add);
      const names = screen.getAllByRole("textbox", { name: "Input name" });
      await user.type(names[names.length - 1], k);
    }
    expect(disclosure()).toHaveAccessibleName("Additional inputs, 3");
    await user.click(screen.getByRole("button", { name: "Remove input b" }));
    expect(
      screen.getAllByRole("textbox", { name: "Input name" })[1],
    ).toHaveFocus();
    expect(
      screen.getAllByRole("textbox", { name: "Input name" })[1],
    ).toHaveValue("c");
    await user.click(screen.getByRole("button", { name: "Remove input c" }));
    expect(screen.getByRole("textbox", { name: "Input name" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Remove input a" }));
    expect(screen.getByRole("button", { name: "Add input" })).toHaveFocus();
  });

  it("Add input lands focus on the new row's name field", async () => {
    probes.main = {};
    const user = renderDialog();
    await statusIs(UNREAD_MAIN);
    const add = screen.getByRole("button", { name: "Add input" });
    await user.click(add);
    await user.type(screen.getByRole("textbox", { name: "Input name" }), "a");
    await user.click(add);
    const names = screen.getAllByRole("textbox", { name: "Input name" });
    expect(names).toHaveLength(2);
    expect(names[1]).toHaveFocus();
  });

  it("Add variable lands focus on the new row's name field", async () => {
    provider = "gitlab";
    const user = renderDialog();
    await user.click(
      await screen.findByRole("button", { name: "Add variable" }),
    );
    expect(
      screen.getByRole("textbox", { name: "Variable name" }),
    ).toHaveFocus();
  });

  it("pipeline providers keep the Variables group, gaining row names", async () => {
    provider = "gitlab";
    const user = renderDialog();
    const variables = await screen.findByRole("group", {
      name: "Variables (optional)",
    });
    expect(variables).toHaveTextContent(
      "Add CI/CD variables to pass to the pipeline.",
    );
    expect(screen.queryByRole("button", { name: /^Additional/ })).toBeNull();
    const add = screen.getByRole("button", { name: "Add variable" });
    await user.click(add);
    await user.click(add);
    const names = screen.getAllByRole("textbox", { name: "Variable name" });
    await user.type(names[0], "K");
    expect(
      screen.getByRole("textbox", { name: "Value for K" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Value for new variable" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove variable K" }));
    expect(
      screen.getByRole("textbox", { name: "Variable name" }),
    ).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Remove variable" }));
    expect(add).toHaveFocus();
    expect(probeCalls()).toBe(0);
  });
});
