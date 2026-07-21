import { SparkleIcon } from "@phosphor-icons/react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
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
import {
  DEFAULT_INTERPRETER,
  type Interpreter,
  INTERPRETERS,
  interpreterForExt,
  type TaskDef,
  type TaskSource,
} from "@/lib/scripts/types";
import { useAiConfigured, useAiEnabled } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { cn } from "@/lib/utils";
import { useGenerateScript } from "./useGenerateScript";

// CodeMirror is heavy; lazy-load it so its chunk stays off the boot path and only
// loads when the task editor first opens (same as the git-hooks editor).
const CodeEditor = lazy(() =>
  import("@/components/code-editor").then((m) => ({ default: m.CodeEditor })),
);

const INTERPRETER_LABELS: Record<string, string> = Object.fromEntries(
  INTERPRETERS.map((i) => [i.id, i.label]),
);

/** Make a picked absolute path relative to the repo root when it's inside it, so a
 *  task like `scripts/release.mjs` works in any repo that has it. Outside the repo,
 *  keep the absolute path (it's machine-specific). Windows paths compare
 *  case-insensitively; store forward slashes either way. */
function toRepoRelative(picked: string, repoRoot: string | null): string {
  const norm = (p: string) => p.replace(/\\/g, "/");
  const p = norm(picked);
  if (!repoRoot) return p;
  const root = norm(repoRoot).replace(/\/+$/, "");
  return p.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    ? p.slice(root.length + 1)
    : p;
}

/**
 * Create or edit a task. The parent owns open state + persistence: `onSave`
 * receives the full task (with a stable id) and `onDelete` its id. A task's script
 * is either an **existing file** in the repo (run in place) or an **inline** body;
 * inline bodies can be AI-generated. Definitions are app-data only — never repo
 * content.
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
  const repoPath = useUiStore((s) => s.repoPath);
  const openSettings = useUiStore((s) => s.openSettings);
  const aiEnabled = useAiEnabled();
  const aiConfigured = useAiConfigured();
  const scriptGen = useGenerateScript(repoPath ?? "");

  const [name, setName] = useState("");
  const [interpreter, setInterpreter] =
    useState<Interpreter>(DEFAULT_INTERPRETER);
  const [sourceKind, setSourceKind] = useState<TaskSource["kind"]>("file");
  const [path, setPath] = useState("");
  const [body, setBody] = useState("");
  const [args, setArgs] = useState("");
  const [describe, setDescribe] = useState("");
  const [confirmBeforeRun, setConfirmBeforeRun] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Seed the fields when a task (or "new") opens. Keyed on the dialog opening so
  // reopening the same task re-seeds from the saved value, discarding stray edits.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      seededFor.current = null;
      return;
    }
    const key = editing?.id ?? "new";
    if (seededFor.current === key) return;
    seededFor.current = key;
    setName(editing?.name ?? "");
    setInterpreter(editing?.interpreter ?? DEFAULT_INTERPRETER);
    setSourceKind(editing?.source.kind ?? "file");
    setPath(editing?.source.kind === "file" ? editing.source.path : "");
    setBody(editing?.source.kind === "inline" ? editing.source.body : "");
    setArgs(editing?.args ?? "");
    setDescribe("");
    setConfirmBeforeRun(editing?.confirmBeforeRun ?? true);
    setConfirmDelete(false);
  }, [open, editing]);

  const trimmedName = name.trim();
  const canSave =
    trimmedName !== "" &&
    (sourceKind === "file" ? path.trim() !== "" : body.trim() !== "");

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

  function save() {
    if (!canSave) return;
    const source: TaskSource =
      sourceKind === "file"
        ? { kind: "file", path: path.trim() }
        : { kind: "inline", body };
    onSave({
      id: editing?.id ?? crypto.randomUUID(),
      name: trimmedName,
      interpreter,
      source,
      args: args.trim(),
      confirmBeforeRun,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit task" : "New task"}</DialogTitle>
          <DialogDescription>
            A saved script you can run from here without a terminal. Point it at an
            existing script in the repo, or write one inline. Either way it runs in
            the repository's folder.
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
              <SelectTrigger id="task-interpreter" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INTERPRETERS.map((i) => (
                  <SelectItem key={i.id} value={i.id}>
                    <span className="flex flex-col">
                      <span>{i.label}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {i.hint}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Source: an existing file, or an inline body. */}
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
              Relative to the repository root — runs the live file, so edits to it
              take effect on the next run.
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label>Script</Label>
              {aiEnabled &&
                (scriptGen.generating ? (
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
                ) : !aiConfigured ? (
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
                ) : null)}
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

            <div className="h-56 overflow-hidden rounded-md border">
              <Suspense fallback={<Skeleton className="h-full w-full" />}>
                <CodeEditor value={body} onChange={setBody} />
              </Suspense>
            </div>
            <p className="text-xs text-muted-foreground">
              A one-liner like{" "}
              <span className="font-mono">node scripts/release.mjs</span> or
              several lines with pipes and{" "}
              <span className="font-mono">&amp;&amp;</span>.
            </p>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="task-args">
            Arguments{" "}
            <span className="font-normal text-muted-foreground">(optional)</span>
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
            Passed to the script after its path. Quote values with spaces, e.g.{" "}
            <span className="font-mono">--message "two words"</span>.
          </p>
        </div>

        <label className="flex items-center gap-2 text-xs">
          <Switch
            checked={confirmBeforeRun}
            onCheckedChange={setConfirmBeforeRun}
          />
          <span>Ask for confirmation before running</span>
        </label>

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={save} disabled={!canSave}>
            {editing ? "Save" : "Create task"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <span className="flex-1" />
          {editing &&
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
                  onClick={() => onDelete(editing.id)}
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
