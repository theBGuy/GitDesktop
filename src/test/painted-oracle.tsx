// Matrix A's DOM oracle, shared by the two hosts that list commit comments
// beside a diff pane (the PR commit drill-in and History's commit view): after
// every transition each resolved comment shows EXACTLY ONCE, inline in an
// anchor row of the visible slot or in the comment list. Each host file mocks
// its own modules and hands `defineOracleSuite` a mount for its view.
import {
  defaultScheduler,
  notifyManager,
  type QueryClient,
} from "@tanstack/react-query";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useSyncExternalStore } from "react";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { HOLD_BOUND_MS } from "@/features/diff/diff-pane-slots";
import { positionFromLine } from "@/features/pulls/CommitComments";
import { TabPanel } from "@/features/repository/TabPanel";
import type { CommitCommentOut } from "@/lib/git/types";
import {
  type AppSettings,
  loadSettings,
  saveSettingsPatch,
} from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";

/** One file of the commit: its patch section, both versions and the hunks
 *  `git diff -w` gives for them (git 2.51.1; "" for none). */
export interface OracleFile {
  path: string;
  old: string;
  next: string;
  patch: string;
  hunks: string;
}

export interface MountOpts {
  hide: boolean;
  files: OracleFile[];
  comments: CommitCommentOut[];
  canComment?: boolean;
  /** The diff read: answers, never answers, or fails. */
  diff?: "ok" | "pending" | "error";
  /** The whole-file reads: "fail" keeps the pane hunk-only, so the cap and
   *  the mega-line placeholder apply. */
  reads?: "ok" | "fail";
  /** The forge, where a host serves either; only GitHub walks a comment's
   *  `position` against the forge's patch. */
  forge?: "github" | "gitlab";
}

export interface OracleHost {
  name: string;
  mount(opts: MountOpts): QueryClient;
  /** Holds the diff chunk's load until the returned release runs. */
  holdChunk(): () => void;
  /** Makes the GitHub patch a `position` is walked against fail its next
   *  read, then refetches it: the cache keeps the answer it had. */
  failPatchRefetch(client: QueryClient): Promise<void>;
  /** False where the file list itself comes from the diff read (the PR
   *  drill-in): a failed read then lists no file and mounts no list. */
  listsWithoutDiff: boolean;
}

// Read by each host file's module mocks (hoisted factories can't import this).
type OracleGlobals = {
  __paintedOracleBoom?: string | null;
  __paintedOracleGrammar?: Promise<boolean>;
};
const g = globalThis as OracleGlobals;
/** While set, a comment body containing it throws when rendered inside a
 *  diff pane slot, so the renderer's error fallback replaces the rows. */
export const setBoom = (body: string | null) => {
  g.__paintedOracleBoom = body;
};
/** While set, a built-in grammar's load waits on it (its diff never settles). */
export const setGrammarHold = (hold: Promise<boolean> | undefined) => {
  g.__paintedOracleGrammar = hold;
};

const header = (path: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`;
const added = (path: string) =>
  `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n`;

export const OLD_SHA = "a".repeat(40);
/** Non-zero hex, so the oid-width guard never reads a zero run. */
export const COMMIT = "abcdef0123".repeat(4);

// A re-indent of f's body plus a content edit, and its real `-w` hunk.
const OLD =
  "function f() {\n  line 1\n  line 2\n  line 3\n  line 4\n  line 5\n  line 6\n}\nfunction g() {\n  line 7\n  line 8\n  line 9\n  line 10\n  line 11\n  line 12\n  line 13\n  line 14\n}\n";
const NEW =
  "function f() {\n    line 1\n    line 2\n    line 3\n    line 4\n    line 5\n    line 6\n}\nfunction g() {\n  line 7\n  line 8\n  line 9\n  line 10\n  line ELEVEN\n  line 12\n  line 13\n  line 14\n}\n";
const MIXED_HUNKS =
  "@@ -1,17 +1,17 @@\n function f() {\n" +
  "-  line 1\n-  line 2\n-  line 3\n-  line 4\n-  line 5\n-  line 6\n" +
  "+    line 1\n+    line 2\n+    line 3\n+    line 4\n+    line 5\n+    line 6\n" +
  " }\n function g() {\n   line 7\n   line 8\n   line 9\n   line 10\n" +
  "-  line 11\n+  line ELEVEN\n   line 12\n   line 13\n   line 14\n";
const WS_HUNKS =
  "@@ -11,7 +11,7 @@ function g() {\n   line 8\n   line 9\n   line 10\n-  line 11\n+  line ELEVEN\n   line 12\n   line 13\n   line 14\n";
export const mixed = (path: string): OracleFile => ({
  path,
  old: OLD,
  next: NEW,
  patch: header(path) + MIXED_HUNKS,
  hunks: WS_HUNKS,
});
// Only f's re-indent: its `-w` diff has no hunk.
const WSO_OLD =
  "function f() {\n  line 1\n  line 2\n  line 3\n  line 4\n  line 5\n  line 6\n}\nfunction g() {\n  line 7\n}\n";
export const wsOnly = (path: string): OracleFile => ({
  path,
  old: WSO_OLD,
  next: WSO_OLD.replace(/^ {2}line ([1-6])$/gm, "    line $1"),
  patch:
    header(path) +
    "@@ -1,10 +1,10 @@\n function f() {\n" +
    "-  line 1\n-  line 2\n-  line 3\n-  line 4\n-  line 5\n-  line 6\n" +
    "+    line 1\n+    line 2\n+    line 3\n+    line 4\n+    line 5\n+    line 6\n" +
    " }\n function g() {\n   line 7\n",
  hunks: "",
});
const L300 = Array.from({ length: 300 }, (_, i) => `l${i + 1}\n`).join("");
// Past the pane's 200-line cap: a hunk-only diff draws its first lines.
export const long = (path: string): OracleFile => ({
  path,
  old: "",
  next: L300,
  patch: `${added(path)}@@ -0,0 +1,300 @@\n${L300.replace(/^/gm, "+").slice(0, -1)}`,
  hunks: "",
});
// A minified-looking first line: the pane shows a placeholder, no rows.
export const mega = (path: string): OracleFile => ({
  path,
  old: "",
  next: `${"x".repeat(20_001)}\nshort\n`,
  patch: `${added(path)}@@ -0,0 +1,2 @@\n+${"x".repeat(20_001)}\n+short\n`,
  hunks: "",
});
// A generated-looking first line over 300 lines: Show diff anyway lifts the
// placeholder onto the capped rows, and Show full diff draws the rest.
const MEGA_L300 = `${"x".repeat(20_001)}\n${L300.slice(L300.indexOf("\n") + 1)}`;
export const megaLong = (path: string): OracleFile => ({
  path,
  old: "",
  next: MEGA_L300,
  patch: `${added(path)}@@ -0,0 +1,300 @@\n${MEGA_L300.replace(/^/gm, "+").slice(0, -1)}`,
  hunks: "",
});
export const markdown = (path: string): OracleFile => ({
  path,
  old: "a\nb\nc\n",
  next: "a\nB\nc\n",
  patch: `${header(path)}@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n`,
  hunks: "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n",
});

export const comment = (
  path: string,
  line: number,
  body: string,
): CommitCommentOut => ({
  id: `${path}:${line}`,
  author: "Ada",
  body,
  createdAt: "2026-11-01T10:00:00Z",
  viewerDidAuthor: true,
  path,
  line,
  startLine: null,
  position: null,
});

/** A GitHub comment that carries only its `position` in `file`'s patch. */
export const positioned = (
  file: OracleFile,
  line: number,
  body: string,
): CommitCommentOut => ({
  ...comment(file.path, line, body),
  line: null,
  position: positionFromLine(file.patch, line),
});

/** The settings this test's disk holds; a save writes through to them. */
export function settingsOnDisk(hide: boolean): AppSettings {
  let disk: AppSettings = { ...DEFAULT_SETTINGS, diffHideWhitespace: hide };
  vi.mocked(loadSettings).mockImplementation(async () => disk);
  vi.mocked(saveSettingsPatch).mockImplementation(async (patch) => {
    disk = { ...disk, ...patch } as AppSettings;
    return disk;
  });
  return disk;
}

/** Another window's write: the settings re-read changes, no in-window
 *  control and no probe ran. */
export async function flipOutside(client: QueryClient, hide: boolean) {
  const next = { ...DEFAULT_SETTINGS, diffHideWhitespace: hide };
  vi.mocked(loadSettings).mockImplementation(async () => next);
  act(() => client.setQueryData(settingsKeys.settings, next));
  await settle();
}

export const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => undefined);
};

const PREPARING = '[class*="clip-path:inset(50%)"]';
const LIST = '[aria-label="Commit comments"]';
export const newLine = (n: number) =>
  [...document.querySelectorAll(`span[data-line-new-num="${n}"]`)].find(
    (el) => el.closest(PREPARING) === null,
  ) ?? null;

/** The labels of the diff panes outside the preparing slot. */
const shownPanes = () =>
  [...document.querySelectorAll("[aria-label^='Diff of ']")]
    .filter((el) => el.closest(PREPARING) === null)
    .map((el) => el.getAttribute("aria-label"));
/** The new-side line whose row an inline copy of `body` sits under, null
 *  when it shows no inline copy. */
const anchorLine = (body: string) => {
  const hit = copies(body).find((el) => el.closest("[data-diff-anchor]"));
  let row = hit?.closest("tr")?.previousElementSibling ?? null;
  for (; row !== null; row = row.previousElementSibling) {
    const num = row.querySelector("span[data-line-new-num]");
    if (num) return Number(num.getAttribute("data-line-new-num"));
  }
  return null;
};

/** Where each copy of a comment shows outside the preparing slot: its body
 *  text, or an open editor holding it. */
function copies(body: string): HTMLElement[] {
  const editors = [
    ...document.querySelectorAll<HTMLTextAreaElement>("textarea"),
  ].filter((t) => t.value.includes(body));
  return [...screen.queryAllByText(body), ...editors].filter(
    (el) => el.closest(PREPARING) === null,
  );
}

/** Matrix A's oracle: null when every body shows exactly once, inline or
 *  listed; otherwise what broke. */
export function placedOnce(bodies: readonly string[]): string | null {
  for (const body of bodies) {
    const hits = copies(body);
    if (hits.length !== 1) return `"${body}" shown ${hits.length} times`;
    const el = hits[0];
    if (el.closest("[data-diff-anchor]") === null && el.closest(LIST) === null)
      return `"${body}" neither inline nor listed`;
  }
  return null;
}

export function placeOf(body: string): "inline" | "listed" | "absent" {
  const el = copies(body)[0];
  if (el === undefined) return "absent";
  return el.closest("[data-diff-anchor]") !== null ? "inline" : "listed";
}

/** The note after a listed row's `path:line` label, "" for none; null when
 *  the list holds no such label. */
export function listNote(label: string): string | null {
  const p = [
    ...(document.querySelector(LIST)?.querySelectorAll("p") ?? []),
  ].find((el) => el.textContent?.startsWith(label) === true);
  return p ? (p.textContent ?? "").slice(label.length) : null;
}

/** Asserts the oracle now, naming the state it ran in. */
export function expectOnce(state: string, bodies: readonly string[]) {
  expect(`${state}: ${placedOnce(bodies) ?? "once"}`).toBe(`${state}: once`);
}

/**
 * Records every oracle break still on screen once a task's microtasks have
 * drained: a browser paints only between tasks, so a state a later microtask
 * of the same task replaces is never seen.
 */
export function watchPainted(bodies: readonly string[]) {
  const painted: string[] = [];
  let disposed = false;
  const observer = new MutationObserver(() => {
    if (disposed || placedOnce(bodies) === null) return;
    let hops = 0;
    const atTaskEnd = () => {
      if (disposed) return;
      if (++hops < 2000) {
        queueMicrotask(atTaskEnd);
        return;
      }
      const bad = placedOnce(bodies);
      if (bad !== null) painted.push(bad);
    };
    queueMicrotask(atTaskEnd);
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });
  // A test that fails before its own stop() still detaches the observer, and
  // the samples it already queued drop out.
  const stop = () => {
    disposed = true;
    observer.disconnect();
  };
  onTestFinished(stop);
  return { painted, stop };
}

const EDITED = " and more";
/** Opens the listed comment's edit and types into it. */
async function openListedEdit(body: string) {
  const user = userEvent.setup();
  const row = (await screen.findByText(body)).closest(LIST) as HTMLElement;
  expect(row).not.toBeNull();
  await user.click(
    within(row).getByRole("button", { name: "Comment actions" }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
  const editor = await screen.findByRole("textbox", { name: "Edit comment" });
  await user.type(editor, EDITED);
  return user;
}
const editorText = () =>
  screen.queryByRole<HTMLTextAreaElement>("textbox", { name: "Edit comment" })
    ?.value ?? null;

const pickFile = (path: string) => {
  const row =
    document.querySelector<HTMLElement>(`[data-path="${path}"]`) ??
    screen
      .getAllByRole("button")
      .find((b) => b.textContent?.startsWith(path) === true);
  if (!row) throw new Error(`no rail row for ${path}`);
  fireEvent.click(row);
};
const expandUntil = async (line: number) => {
  for (let i = 0; i < 6 && newLine(line) === null; i++) {
    const gap = [
      ...document.querySelectorAll<HTMLElement>('[title^="Expand"]'),
    ].find((el) => el.closest(PREPARING) === null);
    if (!gap) break;
    fireEvent.click(gap);
    await settle();
  }
};
const markdownToggle = (name: "Raw" | "Preview") =>
  within(screen.getByRole("group", { name: "Markdown view" })).getByRole(
    "button",
    { name },
  );
const ARM = "Only whitespace changed in this file";
/** Stretches the switch hold's 400 ms bound, so a held state outlives a
 *  slow jsdom rebuild; returns the restore. */
function stretchHoldBound() {
  const real = window.setTimeout.bind(window);
  const spy = vi
    .spyOn(window, "setTimeout")
    .mockImplementation(((fn: () => void, ms?: number) =>
      real(fn, ms === HOLD_BOUND_MS ? 60_000 : ms)) as typeof setTimeout);
  return () => spy.mockRestore();
}
const LONG_WAIT = { timeout: 10_000 };

export function defineOracleSuite(host: OracleHost) {
  const F = "On line 4 of f";
  const F14 = "On line 14 of f";
  const G = "On line 4 of g";
  const LATE = "On a late line";
  const TOP = "On line 2";

  describe(`${host.name}: each resolved comment shows exactly once (matrix A)`, () => {
    // First in the file: the diff chunk loads once per module graph.
    it("lists every comment while the diff chunk's Suspense fallback is up", async () => {
      const release = host.holdChunk();
      // A failed assertion before the release below still frees the chunk
      // for the rest of the file; a second resolve is a no-op.
      onTestFinished(release);
      host.mount({
        hide: false,
        files: [mixed("f.txt")],
        comments: [comment("f.txt", 4, F)],
      });
      await screen.findByText(F, undefined, LONG_WAIT);
      await settle();
      expect(document.querySelector("span[data-line-new-num]")).toBeNull();
      expect(screen.queryByText("Loading the diff…")).not.toBeNull();
      expectOnce("Suspense fallback", [F]);
      expect(placeOf(F)).toBe("listed");
      const watch = watchPainted([F]);
      await act(async () => release());
      await waitFor(() => expect(newLine(4)).not.toBeNull(), LONG_WAIT);
      await settle();
      watch.stop();
      expectOnce("rows after the chunk", [F]);
      expect(placeOf(F)).toBe("inline");
      expect(watch.painted).toEqual([]);
    }, 30_000);

    it("lists every comment while the diff read is pending", async () => {
      host.mount({
        hide: false,
        diff: "pending",
        files: [mixed("f.txt")],
        comments: [comment("f.txt", 4, F)],
      });
      await screen.findByText(F, undefined, LONG_WAIT);
      await settle();
      expectOnce("pending read", [F]);
      expect(placeOf(F)).toBe("listed");
    }, 30_000);

    it("lists every comment when the diff read fails", async () => {
      host.mount({
        hide: false,
        diff: "error",
        files: [mixed("f.txt")],
        comments: [comment("f.txt", 4, F)],
      });
      if (!host.listsWithoutDiff) {
        // No file is listed: the read that failed is the file list itself.
        await screen.findByText(
          "Could not load this commit's changes",
          undefined,
          LONG_WAIT,
        );
        await settle();
        expect(placeOf(F)).toBe("absent");
        expect(document.querySelector(LIST)).toBeNull();
        return;
      }
      await screen.findByText(F, undefined, LONG_WAIT);
      // The failed file's slot shows (its report then reaches the list).
      await waitFor(
        () =>
          expect(
            screen
              .queryAllByText("Could not load diff for this file")
              .some((el) => el.closest(PREPARING) === null),
          ).toBe(true),
        LONG_WAIT,
      );
      await settle();
      expectOnce("read error", [F]);
      expect(placeOf(F)).toBe("listed");
      // Nothing was read to judge the line against: no note.
      expect(listNote("f.txt:4")).toBe("");
    }, 30_000);

    it("lists every comment once the renderer's error fallback replaces the rows", async () => {
      setBoom(F);
      try {
        host.mount({
          hide: false,
          files: [mixed("f.txt")],
          comments: [comment("f.txt", 4, F)],
        });
        await screen.findByText(
          "This file's diff couldn't be displayed.",
          undefined,
          LONG_WAIT,
        );
        await settle();
        expectOnce("error fallback", [F]);
        expect(placeOf(F)).toBe("listed");
      } finally {
        setBoom(null);
      }
    }, 30_000);

    it("draws a comment inline once its row mounts, and lists the one no row draws", async () => {
      host.mount({
        hide: true,
        files: [mixed("f.txt")],
        comments: [comment("f.txt", 4, F), comment("f.txt", 14, F14)],
      });
      await waitFor(() => expect(newLine(14)).not.toBeNull(), LONG_WAIT);
      await settle();
      expectOnce("-w rows", [F, F14]);
      expect(placeOf(F14)).toBe("inline");
      expect(placeOf(F)).toBe("listed");
    }, 30_000);

    it("lists a line past the cap, then draws it once Show full diff mounts it", async () => {
      host.mount({
        hide: false,
        reads: "fail",
        files: [long("n.txt")],
        comments: [comment("n.txt", 250, LATE)],
      });
      await waitFor(() => expect(newLine(150)).not.toBeNull(), LONG_WAIT);
      await screen.findByText(LATE);
      await settle();
      expectOnce("past the cap", [LATE]);
      expect(placeOf(LATE)).toBe("listed");
      const watch = watchPainted([LATE]);
      fireEvent.click(screen.getByRole("button", { name: "Show full diff" }));
      await waitFor(() => expect(newLine(250)).not.toBeNull(), LONG_WAIT);
      await settle();
      watch.stop();
      expectOnce("after Show full diff", [LATE]);
      expect(placeOf(LATE)).toBe("inline");
      expect(watch.painted).toEqual([]);
    }, 30_000);

    it("lists a comment under the mega-line placeholder, then draws it after Show diff anyway", async () => {
      host.mount({
        hide: false,
        reads: "fail",
        files: [mega("m.txt")],
        comments: [comment("m.txt", 2, TOP)],
      });
      await screen.findByRole(
        "button",
        { name: "Show diff anyway" },
        LONG_WAIT,
      );
      await screen.findByText(TOP);
      await settle();
      expectOnce("mega-line placeholder", [TOP]);
      expect(placeOf(TOP)).toBe("listed");
      fireEvent.click(screen.getByRole("button", { name: "Show diff anyway" }));
      await waitFor(() => expect(newLine(2)).not.toBeNull(), LONG_WAIT);
      await settle();
      expectOnce("after Show diff anyway", [TOP]);
      expect(placeOf(TOP)).toBe("inline");
    }, 30_000);

    it("names each control a line past the cap of a generated-looking file still needs", async () => {
      host.mount({
        hide: false,
        reads: "fail",
        files: [megaLong("m.txt")],
        comments: [comment("m.txt", 250, LATE)],
      });
      await screen.findByRole(
        "button",
        { name: "Show diff anyway" },
        LONG_WAIT,
      );
      await screen.findByText(LATE);
      await settle();
      expectOnce("mega-line placeholder over the cap", [LATE]);
      expect(listNote("m.txt:250")).toBe(
        " · inline after Show diff anyway, then Show full diff",
      );
      fireEvent.click(screen.getByRole("button", { name: "Show diff anyway" }));
      await waitFor(() => expect(newLine(150)).not.toBeNull(), LONG_WAIT);
      await settle();
      expectOnce("capped rows after Show diff anyway", [LATE]);
      expect(listNote("m.txt:250")).toBe(" · inline after Show full diff");
      fireEvent.click(screen.getByRole("button", { name: "Show full diff" }));
      await waitFor(() => expect(newLine(250)).not.toBeNull(), LONG_WAIT);
      await settle();
      expectOnce("after Show full diff", [LATE]);
      expect(placeOf(LATE)).toBe("inline");
    }, 30_000);

    it("keeps a position-only comment once when a refetch of its patch fails over the cached one", async () => {
      const f = mixed("f.txt");
      const client = host.mount({
        hide: false,
        forge: "github",
        files: [f],
        // Position 10 counted by hand from MIXED_HUNKS' first line: new line 4
        // ("    line 3"), independent of the walk the app decodes it with.
        comments: [{ ...positioned(f, 4, F), position: 10 }],
      });
      await waitFor(() => expect(placeOf(F)).toBe("inline"), LONG_WAIT);
      await settle();
      expectOnce("rows", [F]);
      expect(anchorLine(F)).toBe(4);
      const watch = watchPainted([F]);
      // Observers hear the failed refetch inside its act, not a task later.
      notifyManager.setScheduler((notify) => notify());
      try {
        await host.failPatchRefetch(client);
      } finally {
        notifyManager.setScheduler(defaultScheduler);
      }
      await settle();
      watch.stop();
      expectOnce("refetch failed over the cached patch", [F]);
      expect(placeOf(F)).toBe("inline");
      expect(anchorLine(F)).toBe(4);
      expect(watch.painted).toEqual([]);
    }, 30_000);

    it("lists a comment while Markdown Preview is up, and draws it again on Raw", async () => {
      host.mount({
        hide: false,
        files: [markdown("n.md")],
        comments: [comment("n.md", 2, TOP)],
      });
      await waitFor(() => expect(newLine(2)).not.toBeNull(), LONG_WAIT);
      await settle();
      expectOnce("Raw", [TOP]);
      expect(placeOf(TOP)).toBe("inline");
      const watch = watchPainted([TOP]);
      fireEvent.click(markdownToggle("Preview"));
      await waitFor(() => expect(newLine(2)).toBeNull());
      await settle();
      expectOnce("Preview", [TOP]);
      expect(placeOf(TOP)).toBe("listed");
      fireEvent.click(markdownToggle("Raw"));
      await waitFor(() => expect(newLine(2)).not.toBeNull(), LONG_WAIT);
      await settle();
      watch.stop();
      expectOnce("Raw again", [TOP]);
      expect(placeOf(TOP)).toBe("inline");
      expect(watch.painted).toEqual([]);
    }, 30_000);

    it("names Raw and Show full diff for a line past the cap while Preview is up", async () => {
      host.mount({
        hide: false,
        files: [long("n.md")],
        comments: [comment("n.md", 250, LATE)],
      });
      await waitFor(() => expect(newLine(150)).not.toBeNull(), LONG_WAIT);
      await screen.findByText(LATE);
      fireEvent.click(screen.getByRole("button", { name: "Show full diff" }));
      await waitFor(() => expect(newLine(250)).not.toBeNull(), LONG_WAIT);
      await settle();
      expect(placeOf(LATE)).toBe("inline");
      fireEvent.click(markdownToggle("Preview"));
      await waitFor(() => expect(newLine(250)).toBeNull(), LONG_WAIT);
      await settle();
      expectOnce("Preview of a long file", [LATE]);
      expect(listNote("n.md:250")).toBe(
        " · inline in Raw, then Show full diff",
      );
      // Raw draws fresh rows, capped again.
      fireEvent.click(markdownToggle("Raw"));
      await waitFor(() => expect(newLine(150)).not.toBeNull(), LONG_WAIT);
      await settle();
      expectOnce("Raw again", [LATE]);
      expect(listNote("n.md:250")).toBe(" · inline after Show full diff");
    }, 30_000);

    it("drops exactly the first named step on each press over a generated-looking Markdown file", async () => {
      // The whole-file reads answer, so Preview is offered; a mega line never
      // takes content mode, so the placeholder and the cap still apply.
      host.mount({
        hide: false,
        files: [megaLong("m.md")],
        comments: [comment("m.md", 250, LATE)],
      });
      await screen.findByRole(
        "button",
        { name: "Show diff anyway" },
        LONG_WAIT,
      );
      await screen.findByText(LATE);
      fireEvent.click(markdownToggle("Preview"));
      await waitFor(
        () =>
          expect(
            screen.queryByRole("button", { name: "Show diff anyway" }),
          ).toBeNull(),
        LONG_WAIT,
      );
      await settle();
      expectOnce("Preview over the mega line and the cap", [LATE]);
      expect(listNote("m.md:250")).toBe(
        " · inline in Raw, then Show diff anyway, then Show full diff",
      );
      // Each press leaves the steps after the one it took.
      fireEvent.click(markdownToggle("Raw"));
      await screen.findByRole(
        "button",
        { name: "Show diff anyway" },
        LONG_WAIT,
      );
      await settle();
      expectOnce("Raw: the mega-line placeholder", [LATE]);
      expect(listNote("m.md:250")).toBe(
        " · inline after Show diff anyway, then Show full diff",
      );
      fireEvent.click(screen.getByRole("button", { name: "Show diff anyway" }));
      await waitFor(() => expect(newLine(150)).not.toBeNull(), LONG_WAIT);
      await settle();
      expectOnce("capped rows", [LATE]);
      expect(listNote("m.md:250")).toBe(" · inline after Show full diff");
      fireEvent.click(screen.getByRole("button", { name: "Show full diff" }));
      await waitFor(() => expect(newLine(250)).not.toBeNull(), LONG_WAIT);
      await settle();
      expectOnce("after Show full diff", [LATE]);
      expect(placeOf(LATE)).toBe("inline");
    }, 30_000);

    it("lists a comment under the whitespace-only arm", async () => {
      host.mount({
        hide: true,
        files: [wsOnly("f.txt")],
        comments: [comment("f.txt", 4, F)],
      });
      await screen.findByText(ARM, undefined, LONG_WAIT);
      await screen.findByText(F);
      await settle();
      expectOnce("whitespace-only arm", [F]);
      expect(placeOf(F)).toBe("listed");
    }, 30_000);

    it("draws a -w gap line's comment inline once its gap is expanded", async () => {
      host.mount({
        hide: true,
        files: [mixed("f.txt")],
        comments: [comment("f.txt", 4, F)],
      });
      await waitFor(() => expect(newLine(14)).not.toBeNull(), LONG_WAIT);
      await settle();
      expectOnce("-w rows", [F]);
      expect(placeOf(F)).toBe("listed");
      const watch = watchPainted([F]);
      await expandUntil(4);
      expect(newLine(4)).not.toBeNull();
      await settle();
      watch.stop();
      expectOnce("expanded gap", [F]);
      expect(placeOf(F)).toBe("inline");
      expect(watch.painted).toEqual([]);
    }, 30_000);

    it("keeps each comment once while a held slot's rows change mid file-switch", async () => {
      host.mount({
        hide: false,
        files: [mixed("f.txt"), mixed("g.zig")],
        comments: [comment("f.txt", 4, F), comment("g.zig", 4, G)],
      });
      await waitFor(() => expect(newLine(4)).not.toBeNull(), LONG_WAIT);
      await settle();
      expectOnce("f shown", [F, G]);
      expect(placeOf(F)).toBe("inline");
      let release: (ok: boolean) => void = () => undefined;
      const unstretch = stretchHoldBound();
      setGrammarHold(
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
      );
      try {
        const watch = watchPainted([F, G]);
        pickFile("g.zig");
        await settle();
        // g.zig's rows wait for their grammar: f.txt stays painted, held.
        expect(document.querySelector(PREPARING)).not.toBeNull();
        expectOnce("held f, g preparing", [F, G]);
        // Another window turns Hide whitespace on: the held f's rows rebuild
        // to its -w view, which draws no line 4.
        await flipOutside(lastClient(host), true);
        await waitFor(() => expect(newLine(4)).toBeNull(), LONG_WAIT);
        await settle();
        // Still held: g.zig prepares behind the rebuilt f.
        expect(document.querySelector(PREPARING)).not.toBeNull();
        expect(placeOf(F)).toBe("listed");
        expectOnce("held f rebuilt", [F, G]);
        await act(async () => release(false));
        await waitFor(() =>
          expect(document.querySelector(PREPARING)).toBeNull(),
        );
        await settle();
        watch.stop();
        expectOnce("g shown", [F, G]);
        expect(watch.painted).toEqual([]);
      } finally {
        setGrammarHold(undefined);
        unstretch();
      }
    }, 30_000);

    it("keeps each comment once while a re-read changes a held slot's rows mid file-switch", async () => {
      const f = mixed("f.txt");
      const client = host.mount({
        hide: false,
        files: [f, mixed("g.zig")],
        comments: [comment("f.txt", 4, F), comment("g.zig", 4, G)],
      });
      await waitFor(() => expect(newLine(4)).not.toBeNull(), LONG_WAIT);
      await settle();
      expect(placeOf(F)).toBe("inline");
      let release: (ok: boolean) => void = () => undefined;
      const unstretch = stretchHoldBound();
      setGrammarHold(
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
      );
      try {
        const watch = watchPainted([F, G]);
        pickFile("g.zig");
        await settle();
        expect(document.querySelector(PREPARING)).not.toBeNull();
        expectOnce("held f, g preparing", [F, G]);
        // A re-read answers f with only its last hunk's lines: the held f's
        // rows lose line 4.
        f.patch = f.patch.slice(0, f.patch.indexOf("@@ ")) + f.hunks;
        await act(() => client.invalidateQueries());
        await waitFor(() => expect(newLine(4)).toBeNull(), LONG_WAIT);
        await settle();
        expect(document.querySelector(PREPARING)).not.toBeNull();
        expect(placeOf(F)).toBe("listed");
        expectOnce("held f re-read", [F, G]);
        await act(async () => release(false));
        await waitFor(() =>
          expect(document.querySelector(PREPARING)).toBeNull(),
        );
        await settle();
        watch.stop();
        expectOnce("g shown", [F, G]);
        expect(watch.painted).toEqual([]);
      } finally {
        setGrammarHold(undefined);
        unstretch();
      }
    }, 30_000);

    it("keeps each comment once when the setting flips elsewhere with a line composer open", async () => {
      host.mount({
        hide: false,
        canComment: true,
        files: [mixed("f.txt")],
        comments: [comment("f.txt", 4, F)],
      });
      await waitFor(() => expect(newLine(4)).not.toBeNull(), LONG_WAIT);
      await screen.findByText(F);
      await settle();
      const num = newLine(14)?.closest(".diff-line-num") as HTMLElement;
      fireEvent.mouseOver(num);
      fireEvent.mouseDown(
        num.closest("tr")?.querySelector(".diff-add-widget") as HTMLElement,
      );
      const composer = await screen.findByRole("textbox", {
        name: /^Comment on Line 14/,
      });
      const watch = watchPainted([F]);
      await flipOutside(lastClient(host), true);
      expectOnce("flip under an open composer", [F]);
      fireEvent.click(
        within(
          composer.closest("[data-diff-line-widget]") as HTMLElement,
        ).getByRole("button", { name: "Cancel" }),
      );
      await waitFor(() => expect(newLine(4)).toBeNull(), LONG_WAIT);
      await settle();
      watch.stop();
      expectOnce("-w view after the composer closes", [F]);
      expect(placeOf(F)).toBe("listed");
      expect(watch.painted).toEqual([]);
    }, 30_000);

    it("keeps a listed edit once, and its text, when the setting flips elsewhere", async () => {
      host.mount({
        hide: true,
        files: [mixed("f.txt")],
        comments: [comment("f.txt", 4, F)],
      });
      await waitFor(() => expect(newLine(14)).not.toBeNull(), LONG_WAIT);
      await screen.findByText(F);
      await settle();
      const user = await openListedEdit(F);
      const watch = watchPainted([F]);
      await flipOutside(lastClient(host), false);
      await waitFor(() => expect(newLine(4)).not.toBeNull(), LONG_WAIT);
      await settle();
      expect(editorText()).toBe(`${F}${EDITED}`);
      expectOnce("listed edit after the flip", [F]);
      expect(placeOf(F)).toBe("listed");
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(placeOf(F)).toBe("inline"));
      watch.stop();
      expectOnce("edit closed", [F]);
      expect(watch.painted).toEqual([]);
    }, 30_000);
  });

  describe(`${host.name}: a listed edit survives a hide and show`, () => {
    it("keeps the edit's row listed, once, and its text", async () => {
      host.mount({
        hide: true,
        files: [mixed("f.txt")],
        comments: [comment("f.txt", 4, F)],
      });
      await waitFor(() => expect(newLine(14)).not.toBeNull(), LONG_WAIT);
      await screen.findByText(F);
      await settle();
      await openListedEdit(F);
      // Its line is drawn now: only the pin keeps the row in the list.
      await flipOutside(lastClient(host), false);
      await waitFor(() => expect(newLine(4)).not.toBeNull(), LONG_WAIT);
      await settle();
      expectOnce("listed edit over a drawn line", [F]);
      try {
        act(() => setViewShown(false));
        await settle();
        const watch = watchPainted([F]);
        // A tab switch is a store write, outside act like any other.
        setViewShown(true);
        await settle();
        await act(() => new Promise((done) => setTimeout(done, 0)));
        await settle();
        watch.stop();
        expect(editorText()).toBe(`${F}${EDITED}`);
        expectOnce("shown again", [F]);
        expect(placeOf(F)).toBe("listed");
        expect(watch.painted).toEqual([]);
      } finally {
        act(() => setViewShown(true));
      }
    }, 30_000);
  });

  describe(`${host.name}: a listed edit survives every row-changing control`, () => {
    /** Opens the edit, runs the control, and checks the edit and the oracle. */
    async function sweep(body: string, press: () => Promise<void>) {
      await openListedEdit(body);
      const watch = watchPainted([body]);
      await press();
      await settle();
      watch.stop();
      expect(editorText()).toBe(`${body}${EDITED}`);
      expectOnce("after the control", [body]);
      expect(watch.painted).toEqual([]);
    }

    it("Show full diff", async () => {
      host.mount({
        hide: false,
        reads: "fail",
        files: [long("n.txt")],
        comments: [comment("n.txt", 250, LATE)],
      });
      await waitFor(() => expect(newLine(150)).not.toBeNull(), LONG_WAIT);
      await screen.findByText(LATE);
      await sweep(LATE, async () => {
        fireEvent.click(screen.getByRole("button", { name: "Show full diff" }));
        await waitFor(() => expect(newLine(250)).not.toBeNull(), LONG_WAIT);
      });
    }, 30_000);

    it("Show diff anyway", async () => {
      host.mount({
        hide: false,
        reads: "fail",
        files: [mega("m.txt")],
        comments: [comment("m.txt", 2, TOP)],
      });
      await screen.findByRole(
        "button",
        { name: "Show diff anyway" },
        LONG_WAIT,
      );
      await screen.findByText(TOP);
      await sweep(TOP, async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Show diff anyway" }),
        );
        await waitFor(() => expect(newLine(2)).not.toBeNull(), LONG_WAIT);
      });
    }, 30_000);

    it("Raw", async () => {
      host.mount({
        hide: false,
        files: [markdown("n.md")],
        comments: [comment("n.md", 2, TOP)],
      });
      await waitFor(() => expect(newLine(2)).not.toBeNull(), LONG_WAIT);
      fireEvent.click(markdownToggle("Preview"));
      await waitFor(() => expect(newLine(2)).toBeNull());
      await settle();
      await sweep(TOP, async () => {
        fireEvent.click(markdownToggle("Raw"));
        await waitFor(() => expect(newLine(2)).not.toBeNull(), LONG_WAIT);
      });
    }, 30_000);

    it("gap expand", async () => {
      host.mount({
        hide: true,
        files: [mixed("f.txt")],
        comments: [comment("f.txt", 4, F)],
      });
      await waitFor(() => expect(newLine(14)).not.toBeNull(), LONG_WAIT);
      await screen.findByText(F);
      await settle();
      await sweep(F, async () => {
        await expandUntil(4);
        expect(newLine(4)).not.toBeNull();
      });
    }, 30_000);

    it("file pick", async () => {
      host.mount({
        hide: true,
        files: [mixed("f.txt"), mixed("g.zig")],
        comments: [comment("f.txt", 4, F)],
      });
      await waitFor(() => expect(newLine(14)).not.toBeNull(), LONG_WAIT);
      await screen.findByText(F);
      await settle();
      await sweep(F, async () => {
        pickFile("g.zig");
        // g.zig's pane is the one shown, outside the preparing slot.
        await waitFor(
          () => expect(shownPanes()).toEqual(["Diff of g.zig"]),
          LONG_WAIT,
        );
      });
    }, 30_000);

    it("the whitespace flip", async () => {
      host.mount({
        hide: true,
        files: [mixed("f.txt")],
        comments: [comment("f.txt", 4, F)],
      });
      await waitFor(() => expect(newLine(14)).not.toBeNull(), LONG_WAIT);
      await screen.findByText(F);
      await settle();
      await sweep(F, async () => {
        const show = screen
          .getAllByRole("button", { name: "Show whitespace" })
          .find((b) => b.closest(PREPARING) === null);
        expect(show).toBeDefined();
        fireEvent.click(show as HTMLElement);
        await waitFor(() => expect(newLine(4)).not.toBeNull(), LONG_WAIT);
      });
    }, 30_000);
  });
}

let viewShown = true;
const shownListeners = new Set<() => void>();
const subscribeShown = (onChange: () => void) => {
  shownListeners.add(onChange);
  return () => {
    shownListeners.delete(onChange);
  };
};
/** Shows or hides each host's view as a tab switch does: a store write. */
export function setViewShown(shown: boolean) {
  viewShown = shown;
  for (const onChange of [...shownListeners]) onChange();
}
/** Each host renders its view inside this: a repository tab's panel. */
export function OracleFrame({ children }: { children: ReactNode }) {
  const shown = useSyncExternalStore(subscribeShown, () => viewShown);
  return <TabPanel active={shown}>{children}</TabPanel>;
}

const clients = new WeakMap<OracleHost, QueryClient>();
/** Hosts record the client of their last mount here. */
export const recordClient = (host: OracleHost, client: QueryClient) => {
  clients.set(host, client);
  return client;
};
const lastClient = (host: OracleHost): QueryClient => {
  const c = clients.get(host);
  if (!c) throw new Error("no mounted client");
  return c;
};
