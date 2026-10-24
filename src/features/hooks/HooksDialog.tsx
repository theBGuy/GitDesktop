import { CaretDownIcon } from "@phosphor-icons/react";
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import {
  InlineConfirm,
  useConfirmSwapFocus,
} from "@/components/confirm-swap-focus";
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
import { openWithDefault } from "@/lib/git/api";
import {
  useDeleteHook,
  useHookContent,
  useHooks,
  useInstallHookManager,
  useSetHookEnabled,
  useUpdateHookManager,
  useWriteHook,
} from "@/lib/git/queries";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
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

export function HooksDialog({
  repoPath,
  open,
  onOpenChange,
}: {
  repoPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
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
  const selectedRef = useRef(selected);
  const pendingFocusRow = useRef<string | null>(null);
  useLayoutEffect(() => {
    selectedRef.current = selected;
    const name = pendingFocusRow.current;
    pendingFocusRow.current = null;
    if (selected !== null || name === null) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-hook="${CSS.escape(name)}"]`)
      ?.focus();
  }, [selected]);
  const [managerOutput, setManagerOutput] = useState<string | null>(null);
  const content = useHookContent(repoPath, selected);

  const entries = hooks.data?.entries ?? [];
  const entry = entries.find((e) => e.name === selected) ?? null;
  const templates = HOOK_TEMPLATES.filter((t) => t.hook === selected);
  const manager = hooks.data?.manager ?? null;
  const managerConfig = hooks.data?.managerConfig ?? null;
  // pre-commit/lefthook define hooks in a config file; husky edits real files.
  const configManager = manager === "pre-commit" || manager === "lefthook";
  const configName =
    managerConfig?.split(/[\\/]/).filter(Boolean).pop() ?? managerConfig;

  // Seed the editor when a hook is selected and its content resolves (falling
  // back to git's sample, then a bare shebang for a brand-new hook).
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (selected === null) {
      seededFor.current = null;
      return;
    }
    if (seededFor.current !== selected && content.isSuccess) {
      seededFor.current = selected;
      setDraft(content.data ?? DEFAULT_HOOK);
      setConfirmDelete(false);
    }
  }, [selected, content.isSuccess, content.data]);

  const original = content.data ?? DEFAULT_HOOK;
  const dirty = draft !== original;
  const isBlank = draft.trim() === "";
  const noShebang = !isBlank && !draft.startsWith("#!");
  const canSave =
    entry !== null && !isBlank && (dirty || entry.state === "inactive");

  async function save() {
    if (!entry) return;
    const name = entry.name;
    try {
      await writeHook.mutateAsync({ name, content: draft });
    } catch (e) {
      toastError(e);
      return;
    }
    toast.success(`Saved the ${name} hook`);
  }

  async function toggle(enabled: boolean) {
    if (!entry) return;
    const name = entry.name;
    try {
      await setEnabled.mutateAsync({ name, enabled });
    } catch (e) {
      toastError(e);
      return;
    }
    toast.success(`${enabled ? "Enabled" : "Disabled"} ${name}`);
  }

  // The dialog survives a repo switch (RepositoryView is one instance), so a
  // continuation writes its state only while the repo it fired in is live.
  const stillIn = (firedIn: string) =>
    useUiStore.getState().repoPath === firedIn;

  async function doDelete() {
    if (!entry) return;
    const name = entry.name;
    const firedIn = repoPath;
    try {
      await deleteHook.mutateAsync(name);
    } catch (e) {
      pendingFocusRow.current = null;
      toastError(e);
      return;
    }
    toast.success(`Deleted ${name}`);
    if (stillIn(firedIn)) {
      if (selectedRef.current === name) pendingFocusRow.current = name;
      setSelected((cur) => (cur === name ? null : cur));
    }
  }

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
    <Dialog open={open} onOpenChange={onOpenChange}>
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
                    <span className="truncate font-mono">{e.name}</span>
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
                            <Button variant="outline" size="xs">
                              Templates
                              <CaretDownIcon data-icon="inline-end" />
                            </Button>
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
                  <div className="relative min-h-0 flex-1">
                    <div className="absolute inset-0">
                      <Suspense
                        fallback={
                          <LazyPanelFallback
                            name="the hook editor"
                            className="p-0"
                            rows={["h-full w-full"]}
                          />
                        }
                      >
                        <CodeEditor value={draft} onChange={setDraft} />
                      </Suspense>
                    </div>
                  </div>
                  {noShebang && (
                    <p className="mt-1.5 text-xs text-warning">
                      No shebang line (e.g.{" "}
                      <span className="font-mono">#!/bin/sh</span>) — git may
                      not run this hook.
                    </p>
                  )}
                  <div className="mt-2 flex items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => void save()}
                      disabled={!canSave || writeHook.isPending}
                    >
                      {entry.state === "inactive" ? "Create hook" : "Save"}
                    </Button>
                    {entry.state === "active" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void toggle(false)}
                        disabled={setEnabled.isPending}
                      >
                        Disable
                      </Button>
                    )}
                    {entry.state === "disabled" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void toggle(true)}
                        disabled={setEnabled.isPending}
                      >
                        Enable
                      </Button>
                    )}
                    <span className="flex-1" />
                    {entry.state !== "inactive" &&
                      (confirmDelete ? (
                        <InlineConfirm
                          prompt="Recycle bin?"
                          promptClassName="text-xs"
                          actLabel="Delete"
                          pending={deleteHook.isPending}
                          swapFocusRef={swapFocus()}
                          onCancel={() => setConfirmDelete(false)}
                          onAct={() => void doDelete()}
                        />
                      ) : (
                        <Button
                          ref={swapFocus()}
                          variant="ghost"
                          size="sm"
                          onClick={() => setConfirmDelete(true)}
                        >
                          Delete…
                        </Button>
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
