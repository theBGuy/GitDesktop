import { PlusIcon, SparkleIcon, XIcon } from "@phosphor-icons/react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { clipTitle } from "@/lib/clip-title";
import { isMac, isWindows } from "@/lib/hotkeys/binding";
import {
  useDetectedInterpreters,
  useResolvedInterpreter,
} from "@/lib/scripts/interpreters";
import {
  type ArgDoc,
  availableInterpreters,
  DEFAULT_INTERPRETER,
  INTERPRETERS,
  type Interpreter,
  interpreterForExt,
  type TaskDef,
  type TaskSource,
} from "@/lib/scripts/types";
import { useAiConfigured, useAiEnabled } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { useRetained } from "@/lib/use-retained";
import { cn } from "@/lib/utils";
import { useAnalyzeScript } from "./useAnalyzeScript";
import { useGenerateScript } from "./useGenerateScript";

// CodeMirror is heavy; lazy-load it so its chunk stays off the boot path and only
// loads when the task editor first opens (same as the git-hooks editor).
const CodeEditor = lazy(() =>
  import("@/components/code-editor").then((m) => ({ default: m.CodeEditor })),
);

const INTERPRETER_LABELS: Record<string, string> = Object.fromEntries(
  INTERPRETERS.map((i) => [i.id, i.label]),
);

/** An arg-doc row in the editor: the doc plus a dialog-local key, so removing a
 *  row can't re-key its neighbours' inputs (index keys would). Stripped on save. */
type ArgDocRow = ArgDoc & { key: string };

const toRows = (docs: ArgDoc[]): ArgDocRow[] =>
  docs.map((d) => ({ ...d, key: crypto.randomUUID() }));

/** Make a picked absolute path relative to the repo root when it's inside it, so a
 *  task like `scripts/release.mjs` works in any repo that has it. Outside the repo,
 *  keep the absolute path (it's machine-specific). Windows and macOS paths
 *  compare case-insensitively; store forward slashes either way. */
function toRepoRelative(picked: string, repoRoot: string | null): string {
  const norm = (p: string) => p.replace(/\\/g, "/");
  const p = norm(picked);
  if (!repoRoot) return p;
  const root = norm(repoRoot).replace(/\/+$/, "");
  // Windows and macOS default to case-insensitive filesystems; Linux is
  // case-sensitive, so folding the prefix there could wrongly relativize a
  // sibling directory that differs only in case.
  const fold = (s: string) => (isWindows || isMac ? s.toLowerCase() : s);
  return fold(p).startsWith(`${fold(root)}/`) ? p.slice(root.length + 1) : p;
}

/**
 * Create or edit a task. The parent owns open state + persistence: `onSave`
 * receives the full task (with a stable id) and `onDelete` its id. A task's script
 * is either an **existing file** in the repo (run in place) or an **inline** body;
 * inline bodies can be AI-generated, and **Analyze with AI** documents either kind
 * (name, description, accepted arguments) from the script itself. Definitions are
 * app-data only — never repo content.
 */
export function TaskDialog({
  task,
  open,
  onOpenChange,
  onSave,
  onDelete,
}: {
  /** An existing task to edit, `"new"` to create, or null when closed. */
  task: TaskDef | "new" | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (task: TaskDef) => void;
  onDelete: (id: string) => void;
}) {
  const editing = task !== "new" && task !== null ? task : null;
  const shownTask = useRetained(task);
  const shownEditing =
    shownTask !== "new" && shownTask !== null ? shownTask : null;
  const repoPath = useUiStore((s) => s.repoPath);
  const openSettings = useUiStore((s) => s.openSettings);
  const aiEnabled = useAiEnabled();
  const aiConfigured = useAiConfigured();
  const scriptGen = useGenerateScript(repoPath ?? "");
  const scriptAnalyze = useAnalyzeScript(repoPath ?? "");
  // Which interpreters are actually installed — shown per-option so you can see
  // what a task can run with, and warned about when the chosen one is missing.
  const detected = useDetectedInterpreters();
  const options = availableInterpreters();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [interpreter, setInterpreter] =
    useState<Interpreter>(DEFAULT_INTERPRETER);
  const [sourceKind, setSourceKind] = useState<TaskSource["kind"]>("file");
  const [path, setPath] = useState("");
  const [body, setBody] = useState("");
  const [args, setArgs] = useState("");
  const [argDocs, setArgDocs] = useState<ArgDocRow[]>([]);
  const [describe, setDescribe] = useState("");
  const [confirmBeforeRun, setConfirmBeforeRun] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // The cheap `detected` pass above only checks PATH + known install dirs, so it
  // misses nvm/fnm-managed binaries when the app was launched from Finder/Dock
  // (launchd's minimal PATH). For the SELECTED interpreter, confirm the way an
  // actual run resolves it (login shell) before warning.
  const cheapSelectedPath = detected.data?.get(interpreter)?.path ?? null;
  const cheapMissed = detected.isSuccess && cheapSelectedPath === null;
  // Only confirm off Windows — there `resolve_named` reduces to the same
  // `find_executable` the cheap pass already ran (no login-shell probe), so a
  // confirm can never change the outcome. And only while the editor is open (the
  // dialog stays mounted across close, so `open` keeps a stale selection from
  // probing) and the cheap pass missed — so we never spawn a shell we don't need.
  const needsConfirm = open && !isWindows && cheapMissed;
  const confirmed = useResolvedInterpreter(interpreter, needsConfirm);
  // Authoritative path for the selected interpreter: cheap hit, else the confirm.
  const selectedPath = cheapSelectedPath ?? confirmed.data ?? null;
  const selectedResolving = needsConfirm && confirmed.isLoading;
  // Missing = the cheap pass found nothing AND either we're not confirming
  // (Windows / dialog closed → cheap detection is authoritative) or the
  // login-shell confirm also came back empty. While a confirm is in flight it is
  // not yet "missing" — that window is `selectedResolving` instead.
  const selectedMissing =
    cheapMissed &&
    (needsConfirm ? confirmed.isSuccess && confirmed.data == null : true);

  // Seed the fields when a task (or "new") opens. Keyed on the dialog opening so
  // reopening the same task re-seeds from the saved value, discarding stray edits.
  const seededFor = useRef<string | null>(null);
  const cancelGenerate = scriptGen.cancel;
  const cancelAnalyze = scriptAnalyze.cancel;
  useEffect(() => {
    if (!open) {
      seededFor.current = null;
      // Abort any in-flight Generate/Analyze: this component instance stays
      // mounted across open/close (only the Dialog hides), so a stream left
      // running would resolve into whichever task is opened NEXT — its
      // callbacks write through the same state setters.
      cancelGenerate();
      cancelAnalyze();
      return;
    }
    const key = editing?.id ?? "new";
    if (seededFor.current === key) return;
    seededFor.current = key;
    setName(editing?.name ?? "");
    setDescription(editing?.description ?? "");
    setInterpreter(editing?.interpreter ?? DEFAULT_INTERPRETER);
    setSourceKind(editing?.source.kind ?? "file");
    setPath(editing?.source.kind === "file" ? editing.source.path : "");
    setBody(editing?.source.kind === "inline" ? editing.source.body : "");
    setArgs(editing?.args ?? "");
    setArgDocs(toRows(editing?.argDocs ?? []));
    setDescribe("");
    setConfirmBeforeRun(editing?.confirmBeforeRun ?? true);
    setConfirmDelete(false);
  }, [open, editing, cancelGenerate, cancelAnalyze]);

  const trimmedName = name.trim();
  // Saving mid-stream would persist a half-written script, so an in-flight
  // generate/analyze blocks it just like an empty name does.
  const canSave =
    trimmedName !== "" &&
    (sourceKind === "file" ? path.trim() !== "" : body.trim() !== "") &&
    !scriptGen.generating &&
    !scriptAnalyze.analyzing;
  const canAnalyze =
    sourceKind === "file" ? path.trim() !== "" : body.trim() !== "";

  async function choose() {
    const picked = await openDialog({
      title: "Choose a script to run",
      defaultPath: repoPath ?? undefined,
    });
    if (typeof picked !== "string") return;
    setPath(toRepoRelative(picked, repoPath));
    // Pre-select the interpreter from the extension (still overridable).
    const guess = interpreterForExt(picked);
    if (guess) setInterpreter(guess);
  }

  function runAnalyze() {
    scriptAnalyze.analyze({
      interpreter,
      ...(sourceKind === "file" ? { path: path.trim() } : { body }),
      onResult: (r) => {
        // Fill what the analysis produced; leave anything it couldn't derive
        // untouched (and never clear hand-written docs on an empty result).
        if (r.name) setName(r.name);
        if (r.description) setDescription(r.description);
        if (r.argDocs.length > 0) setArgDocs(toRows(r.argDocs));
      },
    });
  }

  function updateRow(key: string, patch: Partial<ArgDoc>) {
    setArgDocs((rows) =>
      rows.map((r) => (r.key === key ? { ...r, ...patch } : r)),
    );
  }

  function save() {
    if (!canSave) return;
    const source: TaskSource =
      sourceKind === "file"
        ? { kind: "file", path: path.trim() }
        : { kind: "inline", body };
    onSave({
      id: editing?.id ?? crypto.randomUUID(),
      name: trimmedName,
      description: description.trim(),
      interpreter,
      source,
      args: args.trim(),
      argDocs: argDocs
        .filter((r) => r.arg.trim() !== "")
        .map(({ arg, description: d }) => ({
          arg: arg.trim(),
          description: d,
        })),
      confirmBeforeRun,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{shownEditing ? "Edit task" : "New task"}</DialogTitle>
          <DialogDescription>
            A saved script you can run from here without a terminal. Point it at
            an existing script in the repo, or write one inline. Either way it
            runs in the repository's folder.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-[1fr_auto] gap-3">
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="task-name">Name</Label>
            <Input
              id="task-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Release"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-interpreter">Run with</Label>
            <Select
              items={INTERPRETER_LABELS}
              value={interpreter}
              onValueChange={(v) => v && setInterpreter(v as Interpreter)}
            >
              <SelectTrigger id="task-interpreter" className="w-48">
                <SelectValue />
              </SelectTrigger>
              {/* Wider than the trigger: the popup defaults to the trigger's
                  width (w-(--anchor-width)) and hard-clips overflow, which cut
                  the detected interpreter paths mid-character. 320px gives the
                  paths room; anything longer still ellipsizes inside the span
                  (max-w-64) with the clipped-title tooltip. */}
              <SelectContent className="w-80">
                {options.map((i) => {
                  // The selected interpreter reflects the login-shell confirm (what
                  // a run actually resolves); others stay on cheap PATH detection.
                  const isSelected = i.id === interpreter;
                  const found = isSelected
                    ? selectedPath
                    : (detected.data?.get(i.id)?.path ?? null);
                  const missing = isSelected
                    ? selectedMissing
                    : detected.isSuccess &&
                      (detected.data?.get(i.id)?.path ?? null) === null;
                  return (
                    <SelectItem key={i.id} value={i.id}>
                      <span className="flex flex-col">
                        <span className="flex items-center gap-1.5">
                          {i.label}
                          {missing && (
                            <span className="text-[10px] text-muted-foreground">
                              · not detected
                            </span>
                          )}
                        </span>
                        {found ? (
                          <span
                            className="max-w-64 truncate font-mono text-[10px] text-muted-foreground"
                            onMouseEnter={clipTitle(found)}
                          >
                            {found}
                          </span>
                        ) : isSelected && selectedResolving ? (
                          <span className="text-[11px] text-muted-foreground">
                            Checking your shell…
                          </span>
                        ) : (
                          <span className="text-[11px] text-muted-foreground">
                            {i.hint}
                          </span>
                        )}
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
        </div>

        {selectedResolving && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Spinner className="size-3" />
            Checking your shell for{" "}
            {INTERPRETER_LABELS[interpreter] ?? interpreter}…
          </p>
        )}
        {selectedMissing && (
          <p className="text-xs text-warning">
            {INTERPRETER_LABELS[interpreter] ?? interpreter} isn't installed, or
            GitDesktop can't find it — install it, or make sure it's on your
            shell's PATH.
          </p>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="task-description">
            Description{" "}
            <span className="font-normal text-muted-foreground">
              (optional)
            </span>
          </Label>
          <Input
            id="task-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What running this does, in a sentence"
            autoComplete="off"
          />
        </div>

        {/* Source: an existing file, or an inline body — with the AI analyzer
            alongside, since it documents whichever source is active. */}
        <div className="flex items-center justify-between gap-2">
          <div className="inline-flex w-fit rounded-md border p-0.5 text-xs">
            {(
              [
                ["file", "Existing file"],
                ["inline", "Inline script"],
              ] as const
            ).map(([kind, label]) => (
              <button
                key={kind}
                type="button"
                onClick={() => setSourceKind(kind)}
                className={cn(
                  "rounded px-2.5 py-1 transition-colors",
                  sourceKind === kind
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {aiEnabled &&
            aiConfigured &&
            (scriptAnalyze.analyzing ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="text-muted-foreground"
                onClick={scriptAnalyze.cancel}
              >
                <Spinner data-icon="inline-start" />
                Analyzing…
              </Button>
            ) : (
              <DisabledReasonButton
                type="button"
                variant="ghost"
                size="xs"
                className="text-muted-foreground"
                disabled={!canAnalyze}
                reason={
                  sourceKind === "file"
                    ? "Choose a script file first"
                    : "Write or generate a script first"
                }
                title="Read the script and fill in the name, description, and documented arguments"
                onClick={runAnalyze}
              >
                <SparkleIcon data-icon="inline-start" />
                Analyze with AI
              </DisabledReasonButton>
            ))}
        </div>

        {sourceKind === "file" ? (
          <div className="space-y-1.5">
            <Label htmlFor="task-path">Script file</Label>
            <div className="flex gap-2">
              <Input
                id="task-path"
                className="flex-1 font-mono"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="scripts/release.mjs"
                autoComplete="off"
                spellCheck={false}
              />
              <Button type="button" variant="outline" onClick={choose}>
                Choose…
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Relative to the repository root — runs the live file, so edits to
              it take effect on the next run.
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label>Script</Label>
              {aiEnabled &&
                !aiConfigured &&
                (scriptGen.generating ? null : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="text-muted-foreground"
                    title="Connect an AI provider to generate scripts"
                    onClick={() => {
                      onOpenChange(false);
                      openSettings("ai");
                    }}
                  >
                    <SparkleIcon data-icon="inline-start" />
                    Set up AI to generate
                  </Button>
                ))}
              {aiEnabled && aiConfigured && scriptGen.generating && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="text-muted-foreground"
                  onClick={scriptGen.cancel}
                >
                  <Spinner data-icon="inline-start" />
                  Generating…
                </Button>
              )}
            </div>

            {aiEnabled && aiConfigured && !scriptGen.generating && (
              <div className="flex gap-2">
                <Input
                  value={describe}
                  onChange={(e) => setDescribe(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      scriptGen.generate({
                        description: describe,
                        interpreter,
                        onBody: setBody,
                      });
                    }
                  }}
                  placeholder="Describe what the script should do…"
                  autoComplete="off"
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={describe.trim() === ""}
                  onClick={() =>
                    scriptGen.generate({
                      description: describe,
                      interpreter,
                      onBody: setBody,
                    })
                  }
                >
                  <SparkleIcon data-icon="inline-start" />
                  Generate
                </Button>
              </div>
            )}

            <div className="h-48 overflow-hidden rounded-md border">
              <Suspense fallback={<Skeleton className="h-full w-full" />}>
                <CodeEditor value={body} onChange={setBody} />
              </Suspense>
            </div>
            <p className="text-xs text-muted-foreground">
              The script's contents, run by the selected interpreter — shell
              commands for PowerShell or bash, JavaScript for Node, and so on.
            </p>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="task-args">
            Arguments{" "}
            <span className="font-normal text-muted-foreground">
              (optional)
            </span>
          </Label>
          <Input
            id="task-args"
            className="font-mono"
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            placeholder="--preview"
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">
            The default arguments; a run that asks for confirmation can adjust
            them per run. Quote values with spaces, e.g.{" "}
            <span className="font-mono">--message "two words"</span>.
          </p>
        </div>

        <div
          role="group"
          aria-labelledby="task-argdocs-label"
          className="space-y-1.5"
        >
          <Label id="task-argdocs-label">
            Documented arguments{" "}
            <span className="font-normal text-muted-foreground">
              (optional — shown as a reference when running)
            </span>
          </Label>
          {argDocs.map((row, index) => (
            <div key={row.key} className="flex gap-2">
              <Input
                className="w-40 font-mono"
                value={row.arg}
                onChange={(e) => updateRow(row.key, { arg: e.target.value })}
                placeholder="--flag"
                autoComplete="off"
                spellCheck={false}
                aria-label={`Argument ${index + 1}`}
              />
              <Input
                className="min-w-0 flex-1"
                value={row.description}
                onChange={(e) =>
                  updateRow(row.key, { description: e.target.value })
                }
                placeholder="What it does"
                autoComplete="off"
                aria-label={`Argument ${index + 1} description`}
              />
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="shrink-0 self-center text-muted-foreground"
                onClick={() =>
                  setArgDocs((rows) => rows.filter((r) => r.key !== row.key))
                }
                title={`Remove ${row.arg.trim() || "this argument"}`}
                aria-label={`Remove argument ${index + 1}`}
              >
                <XIcon />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            onClick={() =>
              setArgDocs((rows) => [
                ...rows,
                { key: crypto.randomUUID(), arg: "", description: "" },
              ])
            }
          >
            <PlusIcon data-icon="inline-start" />
            Add argument
          </Button>
        </div>

        <label className="flex items-center gap-2 text-xs">
          <Switch
            checked={confirmBeforeRun}
            onCheckedChange={setConfirmBeforeRun}
          />
          <span>Ask for confirmation before running</span>
        </label>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            // The label rides the retained task, so the dispatch carries the
            // liveness: after close `save()` would write under an unmatched id
            // and still toast "Saved".
            onClick={() => {
              if (task === null) return;
              save();
            }}
            disabled={!canSave}
          >
            {shownEditing ? "Save" : "Create task"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <span className="flex-1" />
          {shownEditing &&
            (confirmDelete ? (
              <>
                <span className="text-xs text-muted-foreground">Delete?</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmDelete(false)}
                >
                  Keep
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    if (editing) onDelete(editing.id);
                  }}
                >
                  Delete
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirmDelete(true)}
              >
                Delete…
              </Button>
            ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
