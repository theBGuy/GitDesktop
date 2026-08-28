import { CaretDownIcon } from "@phosphor-icons/react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
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
  useRunHookManager,
  useSetHookEnabled,
  useWriteHook,
} from "@/lib/git/queries";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
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
  const runHookManager = useRunHookManager(repoPath);

  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
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

  function save() {
    if (!entry) return;
    writeHook.mutate(
      { name: entry.name, content: draft },
      {
        onSuccess: () => toast.success(`Saved the ${entry.name} hook`),
        onError: toastError,
      },
    );
  }

  function toggle(enabled: boolean) {
    if (!entry) return;
    setEnabled.mutate(
      { name: entry.name, enabled },
      {
        onSuccess: () =>
          toast.success(`${enabled ? "Enabled" : "Disabled"} ${entry.name}`),
        onError: toastError,
      },
    );
  }

  function doDelete() {
    if (!entry) return;
    deleteHook.mutate(entry.name, {
      onSuccess: () => {
        toast.success(`Deleted ${entry.name}`);
        setSelected(null);
      },
      onError: toastError,
    });
  }

  function runManager(action: "install" | "update") {
    const manager = hooks.data?.manager;
    if (!manager) return;
    setManagerOutput(null);
    runHookManager.mutate(
      { manager, action },
      {
        onSuccess: (out) => {
          setManagerOutput(out || "Done.");
          toast.success(
            `${manager} ${action === "install" ? "installed" : "updated"}`,
          );
        },
        onError: toastError,
      },
    );
  }

  // Arrow keys walk the hook list, mirroring the app's other lists.
  const onHooksKeyDown = listKeyboardNav({
    items: entries,
    activeIndex: entries.findIndex((e) => e.name === selected),
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
                  disabled={runHookManager.isPending}
                  onClick={() => runManager("install")}
                >
                  Install hooks
                </Button>
              )}
              {manager === "pre-commit" && (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={runHookManager.isPending}
                  onClick={() => runManager("update")}
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
              <div className="space-y-0.5" onKeyDown={onHooksKeyDown}>
                {entries.map((e) => (
                  <button
                    key={e.name}
                    type="button"
                    data-hook={e.name}
                    onClick={() => setSelected(e.name)}
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
                      onClick={save}
                      disabled={!canSave || writeHook.isPending}
                    >
                      {entry.state === "inactive" ? "Create hook" : "Save"}
                    </Button>
                    {entry.state === "active" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => toggle(false)}
                        disabled={setEnabled.isPending}
                      >
                        Disable
                      </Button>
                    )}
                    {entry.state === "disabled" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => toggle(true)}
                        disabled={setEnabled.isPending}
                      >
                        Enable
                      </Button>
                    )}
                    <span className="flex-1" />
                    {entry.state !== "inactive" &&
                      (confirmDelete ? (
                        <>
                          <span className="text-xs text-muted-foreground">
                            Recycle bin?
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setConfirmDelete(false)}
                          >
                            Cancel
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={doDelete}
                            disabled={deleteHook.isPending}
                          >
                            Delete
                          </Button>
                        </>
                      ) : (
                        <Button
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
