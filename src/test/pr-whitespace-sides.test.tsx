import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  proveForgeSides,
  WHITESPACE_SHOWN_NOTE,
} from "@/features/diff/forge-whitespace";
import {
  type ForgeWhitespaceRevs,
  useForgeWhitespaceDiff,
} from "@/features/diff/use-forge-whitespace-diff";
import {
  type FileBytes,
  gitDiffBytesIgnoringWhitespace,
  gitFileBase64,
} from "@/lib/git/api";
import type { FileDiff } from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";

vi.mock("@/lib/git/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/git/api")>();
  return {
    ...actual,
    gitFileBase64: vi.fn(),
    gitDiffBytesIgnoringWhitespace: vi.fn(),
  };
});
vi.mock("@/features/diff/forge-whitespace", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/diff/forge-whitespace")>();
  return { ...actual, proveForgeSides: vi.fn(actual.proveForgeSides) };
});
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);
const OLD = "a\n  b\nc\n";
const NEW = "A\n    b\nc\n";
const TEXT =
  "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n" +
  "@@ -1,3 +1,3 @@\n-a\n-  b\n+A\n+    b\n c\n";
const PLAIN: FileDiff = {
  filePath: "f.txt",
  text: TEXT,
  isBinary: false,
  isTruncated: false,
};
const REVS: ForgeWhitespaceRevs = {
  state: "ready",
  oldRev: OLD_SHA,
  newRev: NEW_SHA,
  source: "local",
};
// One byte past the 300,000-byte budget.
const BIG = `${"x".repeat(300_000)}\n`;
const bytes = (text: string, size: number | null = text.length): FileBytes => ({
  base64: Buffer.from(text).toString("base64"),
  mime: null,
  tooLarge: false,
  size,
});

function mount(
  newSide: FileBytes,
  over: { plain?: FileDiff; oldSide?: FileBytes; hunks?: string } = {},
) {
  const settings = { ...DEFAULT_SETTINGS, diffHideWhitespace: true };
  vi.mocked(loadSettings).mockResolvedValue(settings);
  vi.mocked(gitFileBase64).mockImplementation(async (_repo, rev) =>
    rev === OLD_SHA ? (over.oldSide ?? bytes(OLD)) : newSide,
  );
  vi.mocked(gitDiffBytesIgnoringWhitespace).mockResolvedValue({
    hunks: over.hunks ?? "@@ -1 +1 @@\n-a\n+A\n",
    isBinary: false,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, settings);
  return renderHook(
    () =>
      useForgeWhitespaceDiff({
        plain: over.plain ?? PLAIN,
        placeholder: false,
        repo: "/repo",
        entity: "origin\u0000 7",
        path: "f.txt",
        revs: REVS,
        root: null,
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
}

// The proof decodes the sides, so a proof never run is a decode never run.
describe("a forge-patch slot's byte budget is decided before any decode", () => {
  it("an in-budget pair is decoded, proven and read with -w", async () => {
    const hook = mount(bytes(NEW));
    await waitFor(() =>
      expect(hook.result.current.data?.whitespaceHidden).toBe(true),
    );
    expect(proveForgeSides).toHaveBeenCalled();
    hook.unmount();
  });

  for (const [name, side] of [
    ["by its size field", bytes(BIG)],
    ["by its base64 length when the size is unknown", bytes(BIG, null)],
  ] as const)
    it(`an over-budget side ${name} is never decoded or proven, and draws the size note`, async () => {
      const hook = mount(side);
      await waitFor(() =>
        expect(hook.result.current.note).toBe(
          WHITESPACE_SHOWN_NOTE("tooLarge"),
        ),
      );
      expect(hook.result.current.pending).toBe(false);
      expect(hook.result.current.data?.text).toBe(TEXT);
      expect(hook.result.current.data?.whitespaceHidden).toBe(false);
      expect(gitFileBase64).toHaveBeenCalledTimes(2);
      expect(proveForgeSides).not.toHaveBeenCalled();
      expect(gitDiffBytesIgnoringWhitespace).not.toHaveBeenCalled();
      hook.unmount();
    });
});

// The -w command reads the sides' raw bytes, so the proof reads the
// byte-order mark the bytes open with, which the text decoder strips.
describe("a forge-patch slot proves a side's byte-order mark as its bytes hold it", () => {
  const BOM = String.fromCharCode(0xfeff);
  const section = (hunk: string): FileDiff => ({
    ...PLAIN,
    text: `diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n${hunk}`,
  });

  it("a mark both sides keep proves through line-1 context and draws the -w view", async () => {
    const hook = mount(bytes(`${BOM}x\n    y\n`), {
      plain: section(`@@ -1,2 +1,2 @@\n ${BOM}x\n-  y\n+    y\n`),
      oldSide: bytes(`${BOM}x\n  y\n`),
      hunks: "",
    });
    await waitFor(() =>
      expect(hook.result.current.data?.whitespaceHidden).toBe(true),
    );
    expect(hook.result.current.data?.whitespaceOnly).toBe(true);
    expect(hook.result.current.note).toBeUndefined();
    hook.unmount();
  });

  it("a mark the patch removes, over sides that both lack it, is a mismatch, never whitespace-only", async () => {
    const plain = section(`@@ -1,2 +1,2 @@\n-${BOM}x\n+x\n y\n`);
    const hook = mount(bytes("x\ny\n"), {
      plain,
      oldSide: bytes("x\ny\n"),
      hunks: "",
    });
    await waitFor(() =>
      expect(hook.result.current.note).toBe(WHITESPACE_SHOWN_NOTE("mismatch")),
    );
    expect(hook.result.current.data?.text).toBe(plain.text);
    expect(hook.result.current.data?.whitespaceHidden).toBe(false);
    expect(gitDiffBytesIgnoringWhitespace).not.toHaveBeenCalled();
    hook.unmount();
  });
});

// The patch is decoded lossily, so a replacement character in it may stand for
// any invalid bytes: a pair whose real change is one invalid byte for another
// must never read as the patch's own, or `-w` over it calls it whitespace-only.
// A change the decode keeps visible still proves.
describe("a lossy decode never proves a change it hides", () => {
  const REPLACEMENT = String.fromCharCode(0xfffd);
  const section = (hunk: string): FileDiff => ({
    ...PLAIN,
    text: `diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n${hunk}`,
  });
  // A patch changing byte FF to FE on line 1, as the lossy decode prints it.
  const plain = section(
    `@@ -1,2 +1,2 @@\n-x${REPLACEMENT}\n+x${REPLACEMENT}\n y\n`,
  );
  const raw = (b: number[]): FileBytes => ({
    base64: Buffer.from(b).toString("base64"),
    mime: null,
    tooLarge: false,
    size: b.length,
  });

  for (const [name, side] of [
    // Raced sides that both hold the FF version.
    ["sides whose bytes aren't UTF-8", raw([0x78, 0xff, 0x0a, 0x79, 0x0a])],
    // Valid sides holding a real replacement character where the patch's is lossy.
    [
      "valid sides holding a replacement character",
      bytes(`x${REPLACEMENT}\ny\n`),
    ],
  ] as const)
    it(`${name} are a mismatch, never whitespace-only`, async () => {
      const hook = mount(side, { plain, oldSide: side, hunks: "" });
      await waitFor(() =>
        expect(hook.result.current.note).toBe(
          WHITESPACE_SHOWN_NOTE("mismatch"),
        ),
      );
      expect(hook.result.current.data?.text).toBe(plain.text);
      expect(hook.result.current.data?.whitespaceHidden).toBe(false);
      expect(gitDiffBytesIgnoringWhitespace).not.toHaveBeenCalled();
      hook.unmount();
    });

  // A raced pair: the patch leaves line 3 alone, the sides differ there in an
  // invalid byte both decode to U+FFFD.
  it("sides differing in an invalid byte on a line the patch leaves alone are a mismatch", async () => {
    const plain = section("@@ -1 +1 @@\n-c\n+C\n");
    const hook = mount(raw([0x43, 0x0a, 0x79, 0x0a, 0x78, 0xfe, 0x0a]), {
      plain,
      oldSide: raw([0x63, 0x0a, 0x79, 0x0a, 0x78, 0xff, 0x0a]),
      hunks: "",
    });
    await waitFor(() =>
      expect(hook.result.current.note).toBe(WHITESPACE_SHOWN_NOTE("mismatch")),
    );
    expect(hook.result.current.data?.text).toBe(plain.text);
    expect(hook.result.current.data?.whitespaceHidden).toBe(false);
    expect(gitDiffBytesIgnoringWhitespace).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("a Latin-1 re-indent proves and reads as whitespace-only", async () => {
    const caf = [0x63, 0x61, 0x66, 0xe9];
    const hook = mount(raw([0x20, 0x20, ...caf, 0x0a, 0x79, 0x0a]), {
      plain: section(
        `@@ -1,2 +1,2 @@\n-caf${REPLACEMENT}\n+  caf${REPLACEMENT}\n y\n`,
      ),
      oldSide: raw([...caf, 0x0a, 0x79, 0x0a]),
      hunks: "",
    });
    await waitFor(() =>
      expect(hook.result.current.data?.whitespaceHidden).toBe(true),
    );
    expect(hook.result.current.data?.whitespaceOnly).toBe(true);
    expect(hook.result.current.note).toBeUndefined();
    hook.unmount();
  });

  it("a Latin-1 line whose change stays visible proves and draws the -w view", async () => {
    const change = `-caf${REPLACEMENT}\n+Caf${REPLACEMENT}\n`;
    const hook = mount(raw([0x43, 0x61, 0x66, 0xe9, 0x0a, 0x79, 0x0a]), {
      plain: section(`@@ -1,2 +1,2 @@\n${change} y\n`),
      oldSide: raw([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x79, 0x0a]),
      hunks: `@@ -1 +1 @@\n${change}`,
    });
    await waitFor(() =>
      expect(hook.result.current.data?.whitespaceHidden).toBe(true),
    );
    expect(hook.result.current.note).toBeUndefined();
    expect(gitDiffBytesIgnoringWhitespace).toHaveBeenCalledTimes(1);
    hook.unmount();
  });
});
