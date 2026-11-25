import { CaretDownIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type KeyboardEvent,
  lazy,
  Suspense,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import {
  InlineConfirm,
  ignoreHeldEnter,
  useConfirmSwapFocus,
} from "@/components/confirm-swap-focus";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { LazyPanelFallback } from "@/components/lazy-panel-fallback";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { awaitFocusRelease } from "@/lib/await-focus-release";
import { presentError } from "@/lib/error-summary";
import { focusIsLost } from "@/lib/focus-lost";
import {
  type HookDeleteOutcome,
  type HookWriteOutcome,
  openWithDefault,
} from "@/lib/git/api";
import {
  hookContentKey,
  useDeleteHook,
  useHookContent,
  useHooks,
  useInstallHookManager,
  useSetHookEnabled,
  useUpdateHookManager,
  useWriteHook,
} from "@/lib/git/queries";
import type { HookEntry } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { ACT_PENDING_REASON } from "@/lib/offline-writes";
import { useConfirm } from "@/lib/stores/confirm";
import { refuseIfSwitched } from "@/lib/stores/notifications";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { HOOK_TEMPLATES } from "./templates";

// CodeMirror is heavy; lazy-load it so its chunk stays off the boot path and
// only loads when the hooks dialog first opens. The dialog chrome (header,
// hook list) renders instantly; a skeleton fills the editor area meanwhile.
const CodeEditor = lazy(() =>
  import("@/components/code-editor").then((m) => ({ default: m.CodeEditor })),
);

const DEFAULT_HOOK = "#!/bin/sh\n\n";

const MANAGED_GUARD_LEAD =
  "This pre-push hook is the terminal push guard GitDesktop installed to stop git push for branches marked Keep local.";

/** What Save, Disable and Delete ask first on the managed guard. The app's own
 *  push refusal doesn't read the hook, so it holds whatever these write. */
const MANAGED_CONFIRM: Record<
  "save" | "disable" | "delete",
  {
    title: string;
    body: string;
    confirmLabel: string;
    confirmVariant: "default" | "destructive";
  }
> = {
  save: {
    title: "Save your edit to the terminal push guard?",
    body: `${MANAGED_GUARD_LEAD} Saving replaces its script with your edit, so terminal pushes of those branches are stopped only if your edit keeps the guard's check.`,
    confirmLabel: "Save",
    confirmVariant: "default",
  },
  disable: {
    title: "Disable the terminal push guard?",
    body: `${MANAGED_GUARD_LEAD} While it is disabled, git push in a terminal can publish those branches. GitDesktop still refuses to push them itself.`,
    confirmLabel: "Disable",
    confirmVariant: "destructive",
  },
  delete: {
    title: "Delete the terminal push guard?",
    body: `${MANAGED_GUARD_LEAD} Deleting it moves the file to the recycle bin, and git push in a terminal can then publish those branches. GitDesktop still refuses to push them itself, and you can install the guard again from a kept-local branch's menu.`,
    confirmLabel: "Delete",
    confirmVariant: "destructive",
  },
};

/** One toggle per state, so the focused button survives its own flip. */
const TOGGLE: Record<
  HookEntry["state"],
  { label: string; enable: boolean } | null
> = {
  active: { label: "Disable", enable: false },
  disabled: { label: "Enable", enable: true },
  inactive: null,
};

const SAVE_RUNNING_HELD = "A save is already running.";
const SCRIPT_EMPTY_HELD = "The script is empty.";
const NO_CHANGES_HELD = "No changes to save.";
const TOGGLE_RUNNING_HELD = "A hook change is already running.";
const SCRIPT_LOADING_HELD = "This hook's script is still loading.";
const SCRIPT_UNREADABLE_HELD = "This hook's script couldn't be read.";

type HookWriteVerb = "deleted" | "saved" | "disabled" | "enabled";

/** The one refusal notice for a write whose hook's managed state moved. */
const hookChangedNotice = (name: string, verb: HookWriteVerb) =>
  `${name} changed since this list loaded — nothing was ${verb}.`;

/** The disk text the editor last took in for one repository's hook. */
type HookSeed = {
  repo: string;
  name: string;
  text: string;
  replaced: string | null;
  /** Minted per selection only; every later seed of that selection keeps it. */
  session: object;
};

const changedOnDiskLine = (name: string) =>
  `${name} changed on disk while you were editing. Reload replaces your edit with the script on disk.`;

export function HooksDialog({
  repoPath,
  open,
  onOpenChange,
}: {
  repoPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const hooks = useHooks(repoPath);
  const writeHook = useWriteHook(repoPath);
  const setEnabled = useSetHookEnabled(repoPath);
  const deleteHook = useDeleteHook(repoPath);
  const installHookManager = useInstallHookManager(repoPath);
  const updateHookManager = useUpdateHookManager(repoPath);
  const managerRunning =
    installHookManager.isPending || updateHookManager.isPending;

  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const swapFocus = useConfirmSwapFocus();
  const listRef = useRef<HTMLDivElement>(null);
  // The row that last held focus, which the roving tab stop follows so focus
  // and the stop never part (a delete leaves focus on an unselected row).
  const [focusedHook, setFocusedHook] = useState<string | null>(null);
  // A delete clears the selection, unmounting the pane that held focus; the
  // deleted hook stays listed (inactive), so its row takes focus at that commit.
  // Every selection change spends the pending row, landed or not, and it lands
  // only on unclaimed focus: a Tab away during the write keeps its target.
  // A managed delete asks the shared confirm first, which can still be closing
  // (focus inside it, returned to the unmounted Delete… afterwards) when the
  // delete lands: the landing then waits, up to a deadline, until focus leaves
  // that dialog.
  const selectedRef = useRef(selected);
  const pendingFocusRow = useRef<string | null>(null);
  useLayoutEffect(() => {
    selectedRef.current = selected;
    const name = pendingFocusRow.current;
    pendingFocusRow.current = null;
    if (selected !== null || name === null) return;
    const row = () =>
      listRef.current?.querySelector<HTMLElement>(
        `[data-hook="${CSS.escape(name)}"]`,
      );
    // Unclaimed: nothing focused, or this dialog's popup itself.
    const unclaimed = (active: Element | null) =>
      active === null ||
      active === document.body ||
      active === listRef.current?.closest('[role="dialog"]');
    const outside = (active: Element | null) =>
      active !== null &&
      !unclaimed(active) &&
      listRef.current?.closest('[role="dialog"]')?.contains(active) === false;
    if (unclaimed(document.activeElement)) {
      row()?.focus();
      return;
    }
    if (!outside(document.activeElement)) return;
    return awaitFocusRelease({
      held: () => outside(document.activeElement),
      aborted: () => selectedRef.current !== null,
      onRelease: () => {
        if (unclaimed(document.activeElement)) row()?.focus();
      },
    });
  }, [selected]);
  const [managerOutput, setManagerOutput] = useState<string | null>(null);
  const content = useHookContent(repoPath, selected);

  const entries = hooks.data?.entries ?? [];
  const entry = entries.find((e) => e.name === selected) ?? null;
  // The inline swap is for an unmanaged hook only: a re-read that turns the
  // entry managed drops it, so a later flip back can't revive it unpressed.
  if (confirmDelete && entry?.managed) setConfirmDelete(false);
  const templates = HOOK_TEMPLATES.filter((t) => t.hook === selected);
  const manager = hooks.data?.manager ?? null;
  const managerConfig = hooks.data?.managerConfig ?? null;
  // pre-commit/lefthook define hooks in a config file; husky edits real files.
  const configManager = manager === "pre-commit" || manager === "lefthook";
  const configName =
    managerConfig?.split(/[\\/]/).filter(Boolean).pop() ?? managerConfig;

  // The script on disk (falling back to git's sample, then a bare shebang for a
  // brand-new hook), and the disk text the editor last took in for the hook it
  // shows. Keyed on repo and name: the dialog survives a repo switch, and a
  // draft is never compared against another repository's file.
  const base = content.data ?? DEFAULT_HOOK;
  // `replaced` is the disk text this dialog's own Save overwrote, still shown
  // until the save's re-read arrives; it never reads as a change on disk.
  const [seed, setSeed] = useState<HookSeed | null>(null);
  const seedMatches =
    seed !== null && seed.repo === repoPath && seed.name === selected;
  // The disk text a kept edit was last weighed against, bound to the seed it
  // arrived under: whatever moves the seed's text mints a new seed and so
  // retires it. While it holds, a draft back at the seed text is still the
  // user's, never an untouched one an arrival may replace.
  const [conflict, setConflict] = useState<{
    seed: HookSeed;
    text: string;
  } | null>(null);
  const conflictHeld = conflict !== null && conflict.seed === seed;

  // A selected hook whose script read failed before it seeded. Kept through
  // its own retry, which clears the query's error while it runs, so the
  // failed state stays in place instead of flashing the previous draft.
  const [readFailure, setReadFailure] = useState<{
    repo: string;
    name: string;
    error: unknown;
  } | null>(null);
  if (
    content.isError &&
    selected !== null &&
    !seedMatches &&
    (readFailure === null ||
      readFailure.error !== content.error ||
      readFailure.repo !== repoPath ||
      readFailure.name !== selected)
  )
    setReadFailure({ repo: repoPath, name: selected, error: content.error });

  // What a hook (or repository) not seeded yet takes from its script. Taken
  // during render when the read is already cached, so no frame paints the
  // loading hold between two cached hooks; the effect below takes later reads.
  const freshSeed = (repo: string, name: string, text: string) => {
    setSeed({ repo, name, text, replaced: null, session: {} });
    setDraft(text);
    setConfirmDelete(false);
    setReadFailure(null);
  };
  if (selected !== null && content.isSuccess && !seedMatches)
    freshSeed(repoPath, selected, base);
  const failure =
    !seedMatches &&
    readFailure !== null &&
    readFailure.repo === repoPath &&
    readFailure.name === selected
      ? readFailure
      : null;
  const readFailed = failure !== null;

  // A data-arrival seed: a later read of the seeded hook replaces only an
  // untouched draft, and an edit is kept (the line below offers Reload). Reads
  // the draft at arrival, so typing never re-runs it. Every arrival for the
  // seeded hook retires `replaced`, and only a kept edit records a conflict.
  const takeContent = useEffectEvent(
    (repo: string, name: string, text: string) => {
      if (seed === null || seed.repo !== repo || seed.name !== name) {
        freshSeed(repo, name, text);
        return;
      }
      const kept = seed.replaced === null ? seed : { ...seed, replaced: null };
      // Untouched: the draft is the latest disk text the dialog took in, which
      // is the held conflict's text while one holds.
      const untouched = conflictHeld
        ? draft === conflict.text
        : draft === seed.text;
      if (seed.text === text) {
        if (untouched) setDraft(text);
        if (kept !== seed) setSeed(kept);
        setConflict(null);
        return;
      }
      if (untouched) setDraft(text);
      if (untouched || draft === text) {
        setSeed({ ...kept, text });
        setConflict(null);
        return;
      }
      if (kept !== seed) setSeed(kept);
      if (kept !== conflict?.seed || conflict.text !== text)
        setConflict({ seed: kept, text });
    },
  );
  // Runs on every successful read of the selected hook: a re-read answering
  // the cached bytes keeps `data`'s reference, so only `dataUpdatedAt` moves.
  // A hook or repository not seeded yet is taken during render above.
  // biome-ignore lint/correctness/useExhaustiveDependencies: dataUpdatedAt re-runs the arrival on a same-bytes re-read
  useEffect(() => {
    if (selected === null) {
      setSeed(null);
      return;
    }
    if (content.isSuccess)
      takeContent(repoPath, selected, content.data ?? DEFAULT_HOOK);
  }, [
    repoPath,
    selected,
    content.isSuccess,
    content.data,
    content.dataUpdatedAt,
  ]);

  // Hidden once the hook is gone from disk: the read then answers the sample or
  // nothing, which isn't a change to the user's file. A draft at the seed text
  // shows it only under a held conflict: before the arrival effect runs, that
  // draft is an untouched one the effect is about to replace.
  const changedOnDisk =
    seedMatches &&
    entry?.state !== "inactive" &&
    typeof content.data === "string" &&
    base !== seed.text &&
    base !== seed.replaced &&
    (draft !== seed.text || conflictHeld) &&
    draft !== base;
  const reload = () => {
    setDraft(base);
    setSeed((s) => (s === null ? s : { ...s, text: base, replaced: null }));
  };

  // Reload and Retry pressed with Enter unmount under the key and focus lands
  // in the editor, so the held key's repeats are dropped there (in the capture
  // phase, ahead of CodeMirror's own listener) until it is released.
  const landingEnterHeld = useRef(false);
  const armLandingEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.repeat) landingEnterHeld.current = true;
  };
  const dropHeldLandingEnter = (e: KeyboardEvent) => {
    if (!e.repeat) landingEnterHeld.current = false;
    if (!landingEnterHeld.current || e.key !== "Enter") return;
    e.preventDefault();
    e.stopPropagation();
  };

  // The line's Reload and the failed read's Retry unmount with them (and a
  // disk change converging with the draft hides the line under focus), so a
  // lost focus lands on the editor's input, else the selected row. Focus
  // anywhere else stays where it is.
  const editorBoxRef = useRef<HTMLDivElement>(null);
  const lineShown = useRef(false);
  const failureShown = useRef(false);
  useLayoutEffect(() => {
    const was = { line: lineShown.current, failure: failureShown.current };
    lineShown.current = changedOnDisk;
    failureShown.current = readFailed;
    if (!open) return;
    const left = (was.line && !changedOnDisk) || (was.failure && !readFailed);
    if (!left) return;
    const popup = listRef.current?.closest('[role="dialog"]');
    if (document.activeElement !== popup && !focusIsLost()) return;
    const input = editorBoxRef.current?.querySelector<HTMLElement>(
      '[contenteditable="true"], textarea',
    );
    const name = selectedRef.current;
    const row =
      name === null
        ? null
        : listRef.current?.querySelector<HTMLElement>(
            `[data-hook="${CSS.escape(name)}"]`,
          );
    (input ?? row)?.focus();
  }, [changedOnDisk, readFailed, open]);

  // Until the save's re-read lands, the disk holds what that Save wrote, not
  // the cached text it replaced.
  const diskText =
    seedMatches && seed.replaced !== null && base === seed.replaced
      ? seed.text
      : base;
  const dirty = draft !== diskText;
  const isBlank = draft.trim() === "";
  const noShebang = !isBlank && !draft.startsWith("#!");
  // Until the selected hook seeds, the draft may still be the previous hook's,
  // so everything that writes or replaces it holds.
  const seedHeld = (() => {
    switch (true) {
      case readFailed:
        return SCRIPT_UNREADABLE_HELD;
      case !seedMatches:
        return SCRIPT_LOADING_HELD;
      default:
        return null;
    }
  })();
  const saveHeld = (() => {
    switch (true) {
      case seedHeld !== null:
        return seedHeld;
      case writeHook.isPending:
        return SAVE_RUNNING_HELD;
      case isBlank:
        return SCRIPT_EMPTY_HELD;
      case !dirty && entry?.state !== "inactive":
        return NO_CHANGES_HELD;
      default:
        return null;
    }
  })();
  const toggleOf = entry === null ? null : TOGGLE[entry.state];
  const toggleHeld = setEnabled.isPending ? TOGGLE_RUNNING_HELD : seedHeld;

  // The managed guard's writes ask first. Each handler captures what it writes
  // before the ask, so a list re-read under the open prompt can't change it.
  // While an ask is pending the dialog refuses dismissal: an Escape landing
  // before the shared confirm takes focus would otherwise close it under the
  // prompt. Per-ask token, so a superseded ask can't clear its successor's.
  const promptPending = useRef<object | null>(null);
  const confirmManaged = async (action: keyof typeof MANAGED_CONFIRM) => {
    const token = {};
    promptPending.current = token;
    try {
      return await useConfirm.getState().ask(MANAGED_CONFIRM[action]);
    } finally {
      if (promptPending.current === token) promptPending.current = null;
    }
  };
  const onDialogOpenChange = (next: boolean) => {
    if (!next && promptPending.current !== null) return;
    onOpenChange(next);
  };

  // Save and the toggle carry the managed state the list showed at the press;
  // a hook that changed since comes back unwritten, and the list re-reads.
  async function save() {
    if (!entry) return;
    const firedIn = repoPath;
    const name = entry.name;
    const script = draft;
    const pressed = seed;
    const pressBase = base;
    const expectedManaged = entry.managed === true;
    if (entry.managed && !(await confirmManaged("save"))) return;
    let outcome: HookWriteOutcome;
    try {
      outcome = await writeHook.mutateAsync({
        name,
        content: script,
        expectedManaged,
      });
    } catch (e) {
      toastError(e);
      return;
    }
    if (outcome.status === "managedChanged") {
      await writeRefused(name, firedIn, "saved");
      return;
    }
    // The bytes sent become the editor's disk text, and the cached text they
    // replaced never reads as a change on disk. Only over the press's text and
    // selection; after a re-selection or a Reload, the re-read converges.
    const cached =
      queryClient.getQueryData<string | null>(hookContentKey(firedIn, name)) ??
      DEFAULT_HOOK;
    // A cache moved to anything but the press's text is a change on disk, never
    // the text this Save replaced: that falls back to the one cached at the press.
    const replaced =
      pressed !== null && cached === pressed.text ? cached : pressBase;
    if (stillIn(firedIn))
      setSeed((s) =>
        s !== null &&
        pressed !== null &&
        s.session === pressed.session &&
        s.text === pressed.text
          ? { ...s, text: script, replaced }
          : s,
      );
    toast.success(`Saved the ${name} hook`);
  }

  async function toggle(enabled: boolean) {
    if (!entry) return;
    const firedIn = repoPath;
    const name = entry.name;
    const expectedManaged = entry.managed === true;
    if (!enabled && entry.managed && !(await confirmManaged("disable"))) return;
    let outcome: HookWriteOutcome;
    try {
      outcome = await setEnabled.mutateAsync({
        name,
        enabled,
        expectedManaged,
      });
    } catch (e) {
      toastError(e);
      return;
    }
    if (outcome.status === "managedChanged") {
      await writeRefused(name, firedIn, enabled ? "enabled" : "disabled");
      return;
    }
    toast.success(`${enabled ? "Enabled" : "Disabled"} ${name}`);
  }

  async function writeRefused(
    name: string,
    firedIn: string,
    verb: HookWriteVerb,
  ) {
    const what = `nothing was ${verb}`;
    if (refuseIfSwitched(firedIn, what)) return;
    await hooks.refetch();
    if (refuseIfSwitched(firedIn, what)) return;
    toast.info(hookChangedNotice(name, verb));
  }

  // The dialog survives a repo switch (RepositoryView is one instance), so a
  // continuation writes its state only while the repo it fired in is live.
  const stillIn = (firedIn: string) =>
    useUiStore.getState().repoPath === firedIn;

  // One confirm, never the inline swap as well.
  async function deleteManaged() {
    if (!entry) return;
    const name = entry.name;
    if (!(await confirmManaged("delete"))) return;
    await doDelete(name, true);
  }

  // The delete carries the managed state the user confirmed against; a hook
  // that changed since comes back undeleted.
  async function doDelete(name: string, expectedManaged: boolean) {
    const firedIn = repoPath;
    let outcome: HookDeleteOutcome;
    try {
      outcome = await deleteHook.mutateAsync({ name, expectedManaged });
    } catch (e) {
      pendingFocusRow.current = null;
      toastError(e);
      return;
    }
    if (outcome.status === "managedChanged") {
      await managedChanged(name, firedIn, outcome.managed);
      return;
    }
    toast.success(`Deleted ${name}`);
    if (stillIn(firedIn)) {
      if (selectedRef.current === name) pendingFocusRow.current = name;
      setSelected((cur) => (cur === name ? null : cur));
    }
  }

  // A hook that became the guard is asked about from a layout effect, never
  // from this continuation: react-query's re-render dropping the inline swap
  // can land after an ask made here, leaving the prompt to return focus to a
  // removed node. The effect runs in the commit where the swap handed focus
  // to Delete….
  const pendingDeleteAsk = useRef<{ name: string; firedIn: string } | null>(
    null,
  );
  const [deleteAskSeq, setDeleteAskSeq] = useState(0);

  async function managedChanged(
    name: string,
    firedIn: string,
    managed: boolean,
  ) {
    if (refuseIfSwitched(firedIn, "nothing was deleted")) return;
    await hooks.refetch();
    if (refuseIfSwitched(firedIn, "nothing was deleted")) return;
    if (!managed) {
      toast.info(hookChangedNotice(name, "deleted"));
      return;
    }
    pendingDeleteAsk.current = { name, firedIn };
    setConfirmDelete(false);
    setDeleteAskSeq((n) => n + 1);
  }

  // Asks only while the dialog is open on that hook and the re-read still
  // lists it: otherwise the prompt would open over whatever the user moved on
  // to, or ask about a file that is already gone.
  const askManagedDelete = useEffectEvent(() => {
    const ask = pendingDeleteAsk.current;
    pendingDeleteAsk.current = null;
    if (ask === null) return;
    if (refuseIfSwitched(ask.firedIn, "nothing was deleted")) return;
    if (
      !open ||
      selected !== ask.name ||
      entry === null ||
      entry.state === "inactive"
    ) {
      toast.info(hookChangedNotice(ask.name, "deleted"));
      return;
    }
    void (async () => {
      if (!(await confirmManaged("delete"))) return;
      await doDelete(ask.name, true);
    })();
  });
  useLayoutEffect(() => {
    if (deleteAskSeq === 0) return;
    askManagedDelete();
  }, [deleteAskSeq]);

  async function runManager(action: "install" | "update") {
    const manager = hooks.data?.manager;
    if (!manager) return;
    const firedIn = repoPath;
    setManagerOutput(null);
    const run = action === "install" ? installHookManager : updateHookManager;
    let out: string;
    try {
      out = await run.mutateAsync(manager);
    } catch (e) {
      toastError(e);
      return;
    }
    if (stillIn(firedIn)) setManagerOutput(out || "Done.");
    toast.success(
      `${manager} ${action === "install" ? "installed" : "updated"}`,
    );
  }

  // Arrow keys walk the hook list, mirroring the app's other lists.
  const selectedIndex = entries.findIndex((e) => e.name === selected);
  // Roving tab stop: the row that last held focus while it is listed, else the
  // selected hook, else the first, so the list is one Tab.
  const focusedIndex = entries.findIndex((e) => e.name === focusedHook);
  const tabStop = focusedIndex >= 0 ? focusedIndex : Math.max(selectedIndex, 0);
  // Arrows step from that same row: keys only arrive while a row holds focus,
  // and a delete clears the selection without moving it.
  const onHooksKeyDown = listKeyboardNav({
    items: entries,
    activeIndex: focusedIndex >= 0 ? focusedIndex : selectedIndex,
    onActivate: (e) => setSelected(e.name),
    rowKey: (e) => e.name,
    rowAttr: "data-hook",
  });

  return (
    <Dialog open={open} onOpenChange={onDialogOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Git hooks</DialogTitle>
          <DialogDescription>
            Scripts git runs around commits, merges, and pushes. They live in
            this repo's hooks directory and run locally — they aren't committed
            or shared. Each needs an executable script (a{" "}
            <span className="font-mono">#!/bin/sh</span> shebang).
          </DialogDescription>
        </DialogHeader>

        {manager ? (
          <div className="space-y-2 rounded-md border bg-muted/40 px-3 py-2 text-xs">
            <p>
              Hooks are managed by{" "}
              <span className="font-medium">{manager}</span>
              {configName && (
                <>
                  {" via "}
                  <span className="font-mono">{configName}</span>
                </>
              )}
              {manager === "husky"
                ? " — these files live in .husky and are committed to the repo, so edits show in your working tree."
                : " — hooks are defined there, not in the editor below."}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {managerConfig && (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() =>
                    openWithDefault(managerConfig).catch(toastError)
                  }
                >
                  {manager === "husky" ? "Open .husky" : "Open config"}
                </Button>
              )}
              {configManager && (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={managerRunning}
                  onClick={() => void runManager("install")}
                >
                  Install hooks
                </Button>
              )}
              {manager === "pre-commit" && (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={managerRunning}
                  onClick={() => void runManager("update")}
                >
                  Update
                </Button>
              )}
            </div>
            {managerOutput && (
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-background p-2 font-mono text-[11px]">
                {managerOutput}
              </pre>
            )}
          </div>
        ) : (
          hooks.data?.customHooksPath && (
            <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              Hooks run from{" "}
              <span className="font-mono">{hooks.data?.hooksPath}</span>{" "}
              (core.hooksPath).
            </p>
          )
        )}

        {hooks.isPending ? (
          <Skeleton className="h-96 w-full" />
        ) : (
          <div className="flex h-112 gap-3">
            <ScrollArea className="w-52 shrink-0 border-r pr-2">
              <div
                ref={listRef}
                role="listbox"
                aria-label="Git hooks"
                className="space-y-0.5"
                onKeyDown={onHooksKeyDown}
              >
                {entries.map((e, i) => (
                  <button
                    key={e.name}
                    type="button"
                    data-hook={e.name}
                    role="option"
                    aria-selected={selected === e.name}
                    tabIndex={i === tabStop ? 0 : -1}
                    onFocus={() => setFocusedHook(e.name)}
                    onClick={(ev) => {
                      // WebKit doesn't focus a clicked button; the tab stop
                      // follows focus, so the click takes it explicitly.
                      ev.currentTarget.focus();
                      setSelected(e.name);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs",
                      selected === e.name
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-muted/60",
                    )}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-mono">{e.name}</span>
                      {e.managed && (
                        <span className="text-[10px] text-muted-foreground">
                          Managed by GitDesktop
                        </span>
                      )}
                    </span>
                    {e.state === "active" && (
                      <span className="shrink-0 text-[10px] text-success">
                        Active
                      </span>
                    )}
                    {e.state === "disabled" && (
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        Off
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </ScrollArea>

            <div className="flex min-w-0 flex-1 flex-col">
              {entry === null ? (
                <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
                  Select a hook to view or edit it.
                </div>
              ) : (
                <>
                  <div className="mb-2 flex items-center gap-2">
                    <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                      {entry.description}
                    </p>
                    {templates.length > 0 && (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <DisabledReasonButton
                              variant="outline"
                              size="xs"
                              disabled={seedHeld !== null}
                              reason={seedHeld}
                            >
                              Templates
                              <CaretDownIcon data-icon="inline-end" />
                            </DisabledReasonButton>
                          }
                        />
                        <DropdownMenuContent align="end" className="w-80">
                          {templates.map((t) => (
                            <DropdownMenuItem
                              key={t.id}
                              onClick={() => setDraft(t.body)}
                              className="flex flex-col items-start gap-0.5 whitespace-normal py-2"
                            >
                              <span className="font-medium">{t.name}</span>
                              <span className="text-xs text-muted-foreground">
                                {t.description}
                              </span>
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                  {failure !== null ? (
                    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
                      <div
                        role="alert"
                        className="flex max-w-md flex-col items-center gap-1 text-center text-xs"
                      >
                        <p className="text-foreground">{`Couldn't read ${entry.name}.`}</p>
                        <p>{presentError(failure.error).summary}</p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="cursor-pointer"
                        aria-busy={content.isFetching || undefined}
                        onKeyDown={armLandingEnter}
                        onClick={() => void content.refetch()}
                      >
                        {content.isFetching ? "Retrying…" : "Retry"}
                      </Button>
                    </div>
                  ) : (
                    <div className="relative min-h-0 flex-1">
                      <div
                        ref={editorBoxRef}
                        className="absolute inset-0"
                        onKeyDownCapture={dropHeldLandingEnter}
                        onKeyUpCapture={() => {
                          landingEnterHeld.current = false;
                        }}
                      >
                        <Suspense
                          fallback={
                            <LazyPanelFallback
                              name="the hook editor"
                              className="p-0"
                              rows={["h-full w-full"]}
                            />
                          }
                        >
                          <CodeEditor
                            value={draft}
                            onChange={setDraft}
                            readOnly={!seedMatches}
                          />
                        </Suspense>
                      </div>
                    </div>
                  )}
                  {/* The status stays mounted so the line's appearance is
                      announced; Reload sits outside it. */}
                  <div
                    className={cn(
                      "flex items-center gap-2 text-xs",
                      changedOnDisk && "mt-1.5",
                    )}
                  >
                    <p role="status" className="min-w-0 flex-1 text-warning">
                      {changedOnDisk ? changedOnDiskLine(entry.name) : null}
                    </p>
                    {changedOnDisk && (
                      <Button
                        variant="outline"
                        size="xs"
                        onKeyDown={armLandingEnter}
                        onClick={reload}
                      >
                        Reload
                      </Button>
                    )}
                  </div>
                  {noShebang && !readFailed && (
                    <p className="mt-1.5 text-xs text-warning">
                      No shebang line (e.g.{" "}
                      <span className="font-mono">#!/bin/sh</span>) — git may
                      not run this hook.
                    </p>
                  )}
                  <div className="mt-2 flex items-center gap-2">
                    <DisabledReasonButton
                      size="sm"
                      onClick={() => void save()}
                      onKeyDown={ignoreHeldEnter}
                      disabled={saveHeld !== null}
                      reason={saveHeld}
                    >
                      {entry.state === "inactive" ? "Create hook" : "Save"}
                    </DisabledReasonButton>
                    {toggleOf && (
                      <DisabledReasonButton
                        variant="outline"
                        size="sm"
                        onClick={() => void toggle(toggleOf.enable)}
                        onKeyDown={ignoreHeldEnter}
                        disabled={toggleHeld !== null}
                        reason={toggleHeld}
                      >
                        {toggleOf.label}
                      </DisabledReasonButton>
                    )}
                    <span className="flex-1" />
                    {/* A re-read that turns the entry managed under an open swap
                        drops it (above) and puts Delete… back, which asks the
                        guard's own confirm. */}
                    {entry.state !== "inactive" &&
                      (confirmDelete && !entry.managed ? (
                        <InlineConfirm
                          prompt="Recycle bin?"
                          promptClassName="text-xs"
                          actLabel="Delete"
                          pending={deleteHook.isPending}
                          swapFocusRef={swapFocus()}
                          onCancel={() => setConfirmDelete(false)}
                          onAct={() =>
                            void doDelete(entry.name, entry.managed === true)
                          }
                        />
                      ) : (
                        <DisabledReasonButton
                          ref={swapFocus()}
                          variant="ghost"
                          size="sm"
                          // Held like the inline act button, so a delete still
                          // running can't be joined by a second one.
                          disabled={deleteHook.isPending}
                          reason={ACT_PENDING_REASON}
                          onClick={() =>
                            entry.managed
                              ? void deleteManaged()
                              : setConfirmDelete(true)
                          }
                        >
                          Delete…
                        </DisabledReasonButton>
                      ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
