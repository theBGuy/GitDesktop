import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
import type { DispatchProbe, WorkflowInput } from "@/lib/github/actions";
import { invoke } from "@/lib/tauri/invoke";
import { unmockedCommands } from "./setup";

// The actions module calls its own invoke wrappers internally, so the seam is the
// shared invoke rather than the module's exports.
vi.mock("@/lib/tauri/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri/invoke")>()),
  invoke: vi.fn(),
}));
vi.mock("@/lib/git/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/queries")>()),
  useForgeStatus: () => ({
    data: { provider: "github" },
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
const WORKFLOWS = [
  { id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" },
];
/** Commands the stub below didn't expect. */
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

let schema: WorkflowInput[];

beforeEach(() => {
  stray.length = 0;
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    switch (cmd) {
      case "gh_workflow_list":
        return WORKFLOWS;
      case "gh_workflow_dispatchable":
        return {
          "1": { declared: true, inputs: schema },
        } satisfies Record<string, DispatchProbe>;
      case "forge_ci_dispatch":
        return undefined;
      default:
        stray.push(cmd);
        return undefined;
    }
  });
});
afterEach(() => vi.mocked(invoke).mockReset());

/** The inputs record of every dispatch the dialog sent. */
const sent = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([cmd]) => cmd === "forge_ci_dispatch")
    .map(([, args]) => (args as { inputs: Record<string, string> }).inputs);

async function renderDialog(inputs: WorkflowInput[]) {
  schema = inputs;
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
        defaultRef="main"
      />
    </QueryClientProvider>,
  );
  // The fields paint once the probe lands.
  await screen.findByRole("group", { name: "Inputs" });
  if (inputs.length > 0) {
    await waitFor(() =>
      expect(document.querySelectorAll("[data-dispatch-field]").length).toBe(
        inputs.length,
      ),
    );
  }
  return user;
}

const runButton = () => screen.getByRole("button", { name: "Run workflow" });
const disclosure = () =>
  screen.getByRole("button", { name: /^Additional inputs/ });
const field = (name: string) =>
  screen.getByLabelText(name, { selector: "input" });

async function choose(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  option: string,
) {
  await user.click(screen.getByRole("combobox", { name }));
  await user.click(await screen.findByRole("option", { name: option }));
}

describe("RunWorkflowDialog typed fields", () => {
  it("renders labelled fields in file order with required markers and descriptions", async () => {
    await renderDialog([
      input("version", "string", {
        required: true,
        description: "Release line\n  second line",
      }),
      input("env", "environment"),
      input("count", "number", { default: "010" }),
    ]);
    const names = [...document.querySelectorAll("[data-dispatch-field]")].map(
      (el) => el.getAttribute("data-dispatch-field"),
    );
    expect(names).toEqual([
      "string:version",
      "environment:env",
      "number:count",
    ]);
    const version = field("version");
    expect(version).toHaveAttribute("aria-required", "true");
    expect(version).toHaveAccessibleDescription("Release line second line");
    const desc = document.getElementById(
      version.getAttribute("aria-describedby") ?? "",
    );
    expect(desc).toHaveClass("whitespace-pre-line");
    expect(desc?.textContent).toBe("Release line\n  second line");
    expect(screen.getByText("(required)")).toBeInTheDocument();
    expect(field("env")).toHaveAttribute("placeholder", "Environment name");
    expect(field("env")).not.toHaveAttribute("aria-required");
    expect(field("count")).toHaveAttribute("inputmode", "decimal");
    expect(field("count")).not.toHaveAttribute("type", "number");
  });

  it("required hold: a blank required string holds Run", async () => {
    const user = await renderDialog([
      input("version", "string", { required: true }),
    ]);
    expect(runButton()).toHaveAccessibleDescription(
      "Enter a value for 'version'",
    );
    await user.type(field("version"), "   ");
    expect(runButton()).toHaveAccessibleDescription(
      "Enter a value for 'version'",
    );
    await user.type(field("version"), "1");
    expect(runButton()).not.toHaveAccessibleDescription(
      "Enter a value for 'version'",
    );
  });

  it("required hold: a required choice without a default holds Run", async () => {
    const user = await renderDialog([
      input("env", "choice", { required: true, options: ["dev", "prod"] }),
    ]);
    const trigger = screen.getByRole("combobox", { name: "env" });
    expect(trigger).toHaveTextContent("Choose…");
    expect(trigger).toHaveAttribute("aria-required", "true");
    expect(runButton()).toHaveAccessibleDescription("Choose a value for 'env'");
    await choose(user, "env", "prod");
    expect(screen.getByRole("combobox", { name: "env" })).toHaveTextContent(
      "prod",
    );
    await user.click(runButton());
    await waitFor(() => expect(sent()).toEqual([{ env: "prod" }]));
  });

  it("choice default outside options shows Choose… and holds when required", async () => {
    await renderDialog([
      input("env", "choice", {
        required: true,
        default: "staging",
        options: ["dev", "prod"],
      }),
    ]);
    expect(screen.getByRole("combobox", { name: "env" })).toHaveTextContent(
      "Choose…",
    );
    expect(runButton()).toHaveAccessibleDescription("Choose a value for 'env'");
  });

  it("choice options: duplicates collapse, (none) only without a default", async () => {
    const user = await renderDialog([
      input("dup", "choice", { options: ["a", "a", "b"] }),
      input("picked", "choice", { default: "b", options: ["a", "b"] }),
    ]);
    await user.click(screen.getByRole("combobox", { name: "dup" }));
    let list = await screen.findByRole("listbox");
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["(none)", "a", "b"]);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(screen.getByRole("combobox", { name: "picked" })).toHaveTextContent(
      "b",
    );
    await user.click(screen.getByRole("combobox", { name: "picked" }));
    list = await screen.findByRole("listbox");
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["a", "b"]);
  });

  it("boolean encoding: always sent as true/false, toggling flips", async () => {
    const user = await renderDialog([
      input("on", "boolean", { default: "true" }),
      input("off", "boolean"),
      input("odd", "boolean", { default: "yes" }),
    ]);
    const on = screen.getByRole("checkbox", { name: "on" });
    expect(on).toBeChecked();
    expect(on).not.toHaveAttribute("aria-required");
    expect(screen.queryByText("(required)")).toBeNull();
    await user.click(runButton());
    await waitFor(() =>
      expect(sent()).toEqual([{ on: "true", off: "false", odd: "false" }]),
    );
    await user.click(screen.getByRole("checkbox", { name: "off" }));
    await user.click(screen.getByRole("checkbox", { name: "on" }));
    await user.click(runButton());
    await waitFor(() =>
      expect(sent()[1]).toEqual({ on: "false", off: "true", odd: "false" }),
    );
  });

  it("omit-vs-empty rule: cleared default sends '', untouched empties and (none) are omitted", async () => {
    const user = await renderDialog([
      input("version", "string", { default: "v1" }),
      input("note", "string"),
      input("tier", "choice", { options: ["a", "b"] }),
      input("count", "number", { default: "010" }),
    ]);
    expect(screen.getByRole("combobox", { name: "tier" })).toHaveTextContent(
      "(none)",
    );
    await user.clear(field("version"));
    await user.click(runButton());
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toEqual({ version: "", count: "010" });
    expect("note" in sent()[0]).toBe(false);
    expect("tier" in sent()[0]).toBe(false);
  });

  it("number warning: non-numeric text warns but never holds", async () => {
    const user = await renderDialog([input("count", "number")]);
    await user.type(field("count"), "abc");
    const warning = screen.getByText("Enter a number");
    expect(warning).toHaveClass("text-xs", "text-warning");
    expect(field("count")).toHaveAccessibleDescription("Enter a number");
    expect(runButton()).toBeEnabled();
    await user.clear(field("count"));
    await user.type(field("count"), "1.10");
    expect(screen.queryByText("Enter a number")).toBeNull();
  });

  it("duplicate hold: a row repeating a declared name, and two rows sharing one", async () => {
    const user = await renderDialog([input("Version", "string")]);
    expect(disclosure()).toHaveAttribute("aria-expanded", "false");
    await user.click(disclosure());
    await user.click(screen.getByRole("button", { name: "Add input" }));
    await user.type(
      screen.getByRole("textbox", { name: "Input name" }),
      "version",
    );
    expect(runButton()).toHaveAccessibleDescription(
      "'Version' is already an input above",
    );
    await user.clear(screen.getByRole("textbox", { name: "Input name" }));
    await user.type(screen.getByRole("textbox", { name: "Input name" }), "env");
    await user.click(screen.getByRole("button", { name: "Add input" }));
    const names = screen.getAllByRole("textbox", { name: "Input name" });
    await user.type(names[1], " ENV ");
    expect(runButton()).toHaveAccessibleDescription("'env' is listed twice");
    expect(disclosure()).toHaveAccessibleName("Additional inputs, 2");
    await user.click(runButton());
    expect(sent()).toEqual([]);
  });

  it("caps: 25 filled inputs send, 26 hold, an oversized payload holds", async () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        input(`in${i}`, "string", { default: "x" }),
      );
    let user = await renderDialog(many(25));
    expect(runButton()).toBeEnabled();
    await user.click(runButton());
    await waitFor(() => expect(Object.keys(sent()[0])).toHaveLength(25));
    cleanup();

    user = await renderDialog(many(26));
    expect(runButton()).toHaveAccessibleDescription(
      "Too many inputs (26 of 25)",
    );
    cleanup();

    const big = "y".repeat(65_600);
    await renderDialog([input("blob", "string", { default: big })]);
    const length = JSON.stringify({ blob: big }).length;
    expect(runButton()).toHaveAccessibleDescription(
      `Inputs too long (${length.toLocaleString()} of ${(65_535).toLocaleString()} characters)`,
    );
  });

  it("keyboard: tab order runs workflow, ref, fields, disclosure, rows, Add input, Cancel, Run", async () => {
    const user = await renderDialog([
      input("version", "string"),
      input("env", "choice", { required: true, options: ["dev"] }),
      input("flag", "boolean"),
    ]);
    await user.click(disclosure());
    await user.click(screen.getByRole("button", { name: "Add input" }));
    const workflow = screen.getByRole("combobox", { name: "Workflow" });
    workflow.focus();
    const order = [
      screen.getByRole("textbox", { name: "Branch or tag" }),
      field("version"),
      screen.getByRole("combobox", { name: "env" }),
      screen.getByRole("checkbox", { name: "flag" }),
      disclosure(),
      screen.getByRole("textbox", { name: "Input name" }),
      screen.getByRole("textbox", { name: "Value for new input" }),
      screen.getByRole("button", { name: "Remove input" }),
      screen.getByRole("button", { name: "Add input" }),
      screen.getByRole("button", { name: "Cancel" }),
      runButton(),
    ];
    expect(screen.getByRole("combobox", { name: "env" })).toHaveAttribute(
      "aria-required",
      "true",
    );
    for (const el of order) {
      await user.tab();
      expect(el).toHaveFocus();
    }
  });
});
