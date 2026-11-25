// Matrix A's table: the forge whitespace reducer feeding DiffContent, over
// (setting, the view already painted, an editor open in the diff), asserting
// which arm paints. Expectations come from the rules, not the reducer: the
// setting picks the forge rows, the -w rows or (no -w hunk) the
// whitespace-only arm; an open editor keeps a painted view of the same forge
// text instead.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DiffContent } from "@/features/diff/DiffSurface";
import {
  proveForgeSides,
  reduceForgeWhitespace,
  WHITESPACE_INITIAL,
  type WhitespaceInputs,
  type WhitespaceState,
  whitespaceReadsKey,
} from "@/features/diff/forge-whitespace";
import type { FileDiff } from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { stubCanvas } from "./canvas-stub";
import { mixed, type OracleFile, wsOnly } from "./painted-oracle";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/use-container-width", () => ({
  useContainerWidth: () => [() => undefined, null],
}));

beforeAll(stubCanvas);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

type Arm = "forge rows" | "-w rows" | "whitespace-only arm";
type Prior = "never painted" | "forge painted" | "-w painted";
const ARM = "Only whitespace changed in this file";
const b64 = (text: string) => Buffer.from(text).toString("base64");

function inputs(
  fx: OracleFile,
  hide: boolean,
  editorOpen: boolean,
): WhitespaceInputs {
  const plain: FileDiff = {
    filePath: fx.path,
    text: fx.patch,
    isBinary: false,
    isTruncated: false,
  };
  const readsKey = whitespaceReadsKey({
    repo: "/repo",
    sourceKey: "origin",
    oldRev: "A",
    oldPath: fx.path,
    newRev: "B",
    path: fx.path,
  });
  const proof = proveForgeSides(readsKey, fx.patch, b64(fx.old), b64(fx.next));
  expect(proof).not.toBeNull();
  return {
    identity: `/repo\0commit\0${fx.path}`,
    hide,
    plain,
    placeholder: false,
    revs: { state: "ready", oldRev: "A", newRev: "B", sourceKey: "origin" },
    readsKey,
    oldSide: { kind: "ready", bytes: null },
    newSide: { kind: "ready", bytes: null },
    budget: 1 << 20,
    proof,
    hunks: { kind: "ready", readsKey, hunks: fx.hunks, isBinary: false },
    editorOpen,
  };
}
// The reducer only checks the sides are usable; their bytes are the proof's.
const withSides = (i: WhitespaceInputs, fx: OracleFile): WhitespaceInputs => ({
  ...i,
  oldSide: {
    kind: "ready",
    bytes: { base64: b64(fx.old), mime: null, tooLarge: false, size: 1 },
  },
  newSide: {
    kind: "ready",
    bytes: { base64: b64(fx.next), mime: null, tooLarge: false, size: 1 },
  },
});

const target = (fx: OracleFile, hide: boolean): Arm =>
  !hide ? "forge rows" : fx.hunks === "" ? "whitespace-only arm" : "-w rows";

function priorState(fx: OracleFile, prior: Prior): WhitespaceState {
  if (prior === "never painted") return WHITESPACE_INITIAL;
  const hide = prior === "-w painted";
  return reduceForgeWhitespace(
    WHITESPACE_INITIAL,
    withSides(inputs(fx, hide, false), fx),
  ).state;
}

function expected(
  fx: OracleFile,
  prior: Prior,
  hide: boolean,
  editor: boolean,
) {
  const want = target(fx, hide);
  if (!editor || prior === "never painted") return want;
  return target(fx, prior === "-w painted");
}

async function paintedArm(data: FileDiff | undefined, hide: boolean) {
  const settings = { ...DEFAULT_SETTINGS, diffHideWhitespace: hide };
  vi.mocked(loadSettings).mockResolvedValue(settings);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, settings);
  render(
    <QueryClientProvider client={client}>
      <DiffContent
        filePath="f.txt"
        data={data}
        isPending={false}
        isError={false}
        forgePatch={{ source: { lens: "origin" } }}
      />
    </QueryClientProvider>,
  );
  const line = (n: number) =>
    document.querySelector(`span[data-line-new-num="${n}"]`);
  let arm: Arm | null = null;
  await waitFor(() => {
    if (screen.queryByText(ARM) !== null) arm = "whitespace-only arm";
    else if (line(2) !== null) arm = "forge rows";
    else if (line(11) !== null) arm = "-w rows";
    expect(arm).not.toBeNull();
  });
  return arm;
}

const FIXTURES: [string, OracleFile][] = [
  ["a -w view with hunks", mixed("f.txt")],
  ["a whitespace-only -w view", wsOnly("f.txt")],
];
const PRIORS: Prior[] = ["never painted", "forge painted", "-w painted"];
const ROWS = FIXTURES.flatMap(([kind, fx]) =>
  PRIORS.flatMap((prior) =>
    [false, true].flatMap((hide) =>
      [false, true].map((editor) => ({ kind, fx, prior, hide, editor })),
    ),
  ),
);

describe("the reducer x DiffContent table (setting, painted view, editor)", () => {
  it.each(ROWS)(
    "$kind, $prior, hide=$hide, editor open=$editor",
    async ({ fx, prior, hide, editor }) => {
      const { view } = reduceForgeWhitespace(
        priorState(fx, prior),
        withSides(inputs(fx, hide, editor), fx),
      );
      expect(view.pending).toBe(false);
      expect(await paintedArm(view.data, hide)).toBe(
        expected(fx, prior, hide, editor),
      );
    },
  );
});
