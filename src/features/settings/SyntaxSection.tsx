import {
  PencilSimpleIcon,
  PlusIcon,
  UploadSimpleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useSelector } from "@tanstack/react-store";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { toast } from "sonner";
import { LabeledGroup } from "@/components/form/labeled-group";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { LanguagePicker } from "@/features/diff/LanguagePicker";
import {
  type ImportedGrammar,
  type ImportResult,
  importGrammar,
} from "@/features/diff/lang-import";
import { supportedLanguages, toLangId } from "@/features/diff/syntax";
import { withForm } from "@/lib/form";
import { readTextFile } from "@/lib/git/api";
import type { CustomLanguage } from "@/lib/settings/api";
import { useUiStore } from "@/lib/stores/ui";
import { useSaveSharedSyntax, useSharedSyntax } from "@/lib/syntax/queries";
import { EMPTY_SYNTAX, type SyntaxConfig } from "@/lib/syntax/store";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { settingsFormOpts } from "./settings-form";

const EMPTY_LANG: CustomLanguage = {
  id: "",
  name: "",
  keywords: "",
  lineComment: "",
  blockCommentStart: "",
  blockCommentEnd: "",
  stringDelimiters: "\"'`",
  caseInsensitive: false,
};

function uniqueId(base: string, taken: string[]): string {
  const root = base || "lang";
  const set = new Set(taken);
  if (!set.has(root)) return root;
  let n = 2;
  while (set.has(`${root}-${n}`)) n += 1;
  return `${root}-${n}`;
}

/** One labelled import slot in the custom-language dialog. */
function ImportSlot({
  kind,
  hint,
  fileName,
  onChoose,
}: {
  kind: string;
  hint: string;
  fileName?: string;
  onChoose: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded border bg-muted/30 p-2.5">
      <p className="truncate font-mono text-[11px]" title={fileName ?? kind}>
        {fileName ? `✓ ${fileName}` : kind}
      </p>
      <p className="text-[11px] text-muted-foreground">{hint}</p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-0.5 w-full"
        onClick={onChoose}
      >
        <UploadSimpleIcon /> {fileName ? "Replace…" : "Choose file…"}
      </Button>
    </div>
  );
}

/** Add/edit dialog for one custom grammar; mounted with a key so each open
 *  starts from fresh local state. Can import comments/strings/keywords from a
 *  VSCode language-configuration.json or *.tmLanguage.json. */
function CustomLanguageDialog({
  initial,
  existingIds,
  onSave,
  onClose,
}: {
  initial: CustomLanguage | null;
  existingIds: string[];
  onSave: (lang: CustomLanguage) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<CustomLanguage>(initial ?? EMPTY_LANG);
  // Filenames imported into each slot, for inline confirmation.
  const [imported, setImported] = useState<{ lc?: string; tm?: string }>({});
  const set = <K extends keyof CustomLanguage>(
    key: K,
    value: CustomLanguage[K],
  ) => setDraft((d) => ({ ...d, [key]: value }));

  const name = draft.name.trim();
  const builtinClash =
    !initial && supportedLanguages().includes(toLangId(name));

  // Pick one VSCode file, extract what we can, and merge it into the draft
  // (each import only fills the fields it found, so the slots accumulate).
  async function importFile() {
    try {
      const picked = await openDialog({
        multiple: false,
        filters: [{ name: "VSCode language config", extensions: ["json"] }],
      });
      if (typeof picked !== "string") return;
      const result: ImportResult | null = importGrammar(
        await readTextFile(picked),
      );
      if (!result) {
        toast.error("Couldn't read a grammar from that file");
        return;
      }
      setDraft((d) => ({
        ...d,
        ...result.fields,
        ...(result.grammar ? { tmGrammar: result.grammar } : {}),
      }));
      const fileName = picked.split(/[\\/]/).pop() ?? picked;
      const slot = result.kind === "tmLanguage" ? "tm" : "lc";
      setImported((p) => ({ ...p, [slot]: fileName }));
      if (result.grammar) {
        toast.success(`Loaded TextMate grammar from ${fileName}`);
      } else {
        const filled: ImportedGrammar = result.fields;
        toast.success(
          `Imported ${Object.keys(filled).join(", ")} from ${fileName}`,
        );
      }
    } catch (e) {
      toastError(e);
    }
  }

  function save() {
    if (!name) return;
    const id =
      initial?.id ||
      uniqueId(
        toLangId(name),
        existingIds.filter((x) => x !== initial?.id),
      );
    onSave({ ...draft, name, id });
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {initial ? "Edit custom language" : "New custom language"}
          </DialogTitle>
          <DialogDescription>
            A lightweight grammar for diff highlighting — keywords, comments,
            strings, and numbers. Import from a VSCode file or fill it in by
            hand.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-2 rounded border border-dashed p-3">
            <p className="text-xs font-medium">
              Import from VSCode language files
            </p>
            <p className="text-[11px] text-muted-foreground">
              Each fills the fields below — import either, or both to combine.
              Edit anything afterward.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <ImportSlot
                kind="language-configuration.json"
                hint="comments & strings"
                fileName={imported.lc}
                onChoose={importFile}
              />
              <ImportSlot
                kind=".tmLanguage.json"
                hint="keywords, comments & strings"
                fileName={imported.tm}
                onChoose={importFile}
              />
            </div>
          </div>

          {draft.tmGrammar && (
            <div className="flex items-center justify-between gap-3 rounded border border-success/30 bg-success/10 px-3 py-2 text-xs">
              <span className="text-success">
                ✓ Full TextMate grammar loaded — rendered with Shiki (VSCode
                fidelity). The fields below are ignored while it's loaded.
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="shrink-0"
                onClick={() => set("tmGrammar", undefined)}
              >
                Remove grammar
              </Button>
            </div>
          )}

          <div
            className={cn(
              "grid gap-x-8 gap-y-5 sm:grid-cols-2",
              draft.tmGrammar && "opacity-50",
            )}
          >
            {/* Left: identity + the long keyword list */}
            <div className="flex flex-col gap-5">
              <div className="space-y-2">
                <Label htmlFor="cl-name">Name</Label>
                <Input
                  id="cl-name"
                  autoFocus
                  value={draft.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder="Nip"
                />
                {builtinClash && (
                  <p className="text-xs text-warning">
                    A built-in language is already called “{toLangId(name)}”.
                    Saving will override it everywhere.
                  </p>
                )}
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-2">
                <Label htmlFor="cl-keywords">Keywords</Label>
                <Textarea
                  id="cl-keywords"
                  value={draft.keywords}
                  onChange={(e) => set("keywords", e.target.value)}
                  placeholder="fn let const if else return match while …"
                  className="min-h-32 flex-1 font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  Separated by spaces, commas, or new lines.
                </p>
              </div>
            </div>

            {/* Right: comments, strings, options */}
            <div className="flex flex-col gap-5">
              <LabeledGroup label="Comments">
                <div className="grid grid-cols-3 gap-2">
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="cl-line"
                      className="text-[11px] font-normal text-muted-foreground"
                    >
                      Line
                    </Label>
                    <Input
                      id="cl-line"
                      value={draft.lineComment}
                      onChange={(e) => set("lineComment", e.target.value)}
                      placeholder="//"
                      className="font-mono"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="cl-block-start"
                      className="text-[11px] font-normal text-muted-foreground"
                    >
                      Block start
                    </Label>
                    <Input
                      id="cl-block-start"
                      value={draft.blockCommentStart}
                      onChange={(e) => set("blockCommentStart", e.target.value)}
                      placeholder="/*"
                      className="font-mono"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="cl-block-end"
                      className="text-[11px] font-normal text-muted-foreground"
                    >
                      Block end
                    </Label>
                    <Input
                      id="cl-block-end"
                      value={draft.blockCommentEnd}
                      onChange={(e) => set("blockCommentEnd", e.target.value)}
                      placeholder="*/"
                      className="font-mono"
                    />
                  </div>
                </div>
              </LabeledGroup>

              <div className="space-y-2">
                <Label htmlFor="cl-strings">String delimiters</Label>
                <Input
                  id="cl-strings"
                  value={draft.stringDelimiters}
                  onChange={(e) => set("stringDelimiters", e.target.value)}
                  placeholder={"\"'`"}
                  className="w-40 font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  Each character starts and ends a string.
                </p>
              </div>

              <label className="flex cursor-pointer items-center gap-2 text-xs">
                <Switch
                  checked={draft.caseInsensitive}
                  onCheckedChange={(checked) => set("caseInsensitive", checked)}
                />
                Match keywords case-insensitively
              </label>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!name}>
            {initial ? "Save language" : "Add language"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export const SyntaxSection = withForm({
  ...settingsFormOpts,
  render: function SyntaxSectionRender({ form }) {
    const repoPath = useUiStore((s) => s.repoPath);
    const repoName = useUiStore((s) => s.repoName);
    const [scope, setScope] = useState<"global" | "repo">("global");
    const activeScope: "global" | "repo" = repoPath ? scope : "global";

    // Personal scope rides the Settings draft + Save bar (like every other
    // setting); the shared repo file saves immediately (it's a committed file,
    // same as branch-rules sharing).
    const globalMap = useSelector(form.store, (s) => s.values.syntaxMap);
    const globalLangs = useSelector(
      form.store,
      (s) => s.values.customLanguages,
    );
    const sharedSyntax = useSharedSyntax(repoPath);
    const saveShared = useSaveSharedSyntax(repoPath ?? "");

    const [newExt, setNewExt] = useState("");
    const [newLang, setNewLang] = useState("");
    const [editing, setEditing] = useState<CustomLanguage | "new" | null>(null);

    const config: SyntaxConfig =
      activeScope === "repo"
        ? (sharedSyntax.data ?? EMPTY_SYNTAX)
        : { syntaxMap: globalMap ?? {}, customLanguages: globalLangs ?? [] };
    const { syntaxMap, customLanguages } = config;

    // The mapping picker can reference a language from EITHER scope — the diff
    // renderer already merges both at highlight time (useEffectiveSyntax), so a
    // language defined under "Just me" should still be pickable in the repo
    // scope (and vice-versa). Edit/delete stays scope-aware (the list below only
    // shows the active scope's own languages).
    const otherLangs =
      activeScope === "repo"
        ? (globalLangs ?? [])
        : (sharedSyntax.data?.customLanguages ?? []);
    const allLangs = (() => {
      const byId = new Map<string, CustomLanguage>();
      for (const l of otherLangs) byId.set(l.id, l);
      for (const l of customLanguages) byId.set(l.id, l); // active scope wins
      return [...byId.values()];
    })();
    const ownIds = new Set(customLanguages.map((c) => c.id));

    function update(next: SyntaxConfig) {
      if (activeScope === "repo") {
        if (repoPath) saveShared.mutate(next, { onError: toastError });
      } else {
        form.setFieldValue("syntaxMap", next.syntaxMap);
        form.setFieldValue("customLanguages", next.customLanguages);
      }
    }
    const setMap = (m: Record<string, string>) =>
      update({ ...config, syntaxMap: m });
    const setCustom = (c: CustomLanguage[]) =>
      update({ ...config, customLanguages: c });

    // Setting a mapping to a language borrowed from the OTHER scope copies that
    // language's definition into the active scope, so the mapping is self-
    // contained: the repo's .gitdesktop/syntax.json then carries every language
    // its mappings reference (teammates can resolve them), and personal mappings
    // stay portable across repos.
    function applyMapping(ext: string, langId: string) {
      const borrowed = allLangs.find(
        (c) => c.id === langId && !ownIds.has(c.id),
      );
      update({
        syntaxMap: { ...syntaxMap, [ext]: langId },
        customLanguages: borrowed
          ? [...customLanguages, borrowed]
          : customLanguages,
      });
    }

    const entries = Object.entries(syntaxMap).sort(([a], [b]) =>
      a.localeCompare(b),
    );

    function addMapping() {
      const ext = newExt.trim().toLowerCase().replace(/^\.+/, "");
      if (!ext || !newLang) return;
      applyMapping(ext, newLang);
      setNewExt("");
      setNewLang("");
    }

    function removeMapping(ext: string) {
      const next = { ...syntaxMap };
      delete next[ext];
      setMap(next);
    }

    function saveLang(lang: CustomLanguage) {
      const exists = customLanguages.some((c) => c.id === lang.id);
      setCustom(
        exists
          ? customLanguages.map((c) => (c.id === lang.id ? lang : c))
          : [...customLanguages, lang],
      );
      setEditing(null);
    }

    function removeLang(id: string) {
      const next = Object.fromEntries(
        Object.entries(syntaxMap).filter(([, v]) => v !== id),
      );
      update({
        syntaxMap: next,
        customLanguages: customLanguages.filter((c) => c.id !== id),
      });
    }

    return (
      <section className="space-y-6">
        <div>
          <h2 className="text-sm font-medium">Syntax highlighting</h2>
          <p className="text-xs text-muted-foreground">
            Map a file extension to a language for diff highlighting — handy for
            wrapper extensions (a <code className="font-mono">.dbj</code> that's
            really JavaScript) or formats the diff viewer doesn't know yet. You
            can also set this per file from the diff toolbar.
          </p>
        </div>

        {repoPath && (
          <div className="space-y-1.5">
            <div className="inline-flex rounded-md border p-0.5 text-xs">
              <button
                type="button"
                aria-pressed={activeScope === "global"}
                className={cn(
                  "rounded px-2.5 py-1",
                  activeScope === "global"
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setScope("global")}
              >
                Just me
              </button>
              <button
                type="button"
                aria-pressed={activeScope === "repo"}
                className={cn(
                  "rounded px-2.5 py-1",
                  activeScope === "repo"
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setScope("repo")}
              >
                This repository
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              {activeScope === "repo"
                ? `Saved to ${repoName ?? "the repo"}'s .gitdesktop/syntax.json — commit it to share with your team. Your personal settings win on conflict.`
                : "Applies to every repository you open, just for you."}
            </p>
          </div>
        )}

        <div className="space-y-3">
          <h3 className="text-xs font-medium text-muted-foreground">
            Extension mappings
          </h3>
          {entries.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No mappings yet. Add one below.
            </p>
          )}
          <div className="space-y-2">
            {entries.map(([ext, lang]) => (
              <div key={ext} className="flex items-center gap-2">
                <code className="w-24 shrink-0 rounded bg-muted px-2 py-1 font-mono text-xs">
                  .{ext}
                </code>
                <span className="text-muted-foreground">→</span>
                <LanguagePicker
                  value={lang}
                  onValueChange={(l) => applyMapping(ext, l)}
                  customLanguages={allLangs}
                  triggerClassName="w-44"
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove .${ext} mapping`}
                  className="ml-auto"
                  onClick={() => removeMapping(ext)}
                >
                  <XIcon />
                </Button>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2 border-t pt-3">
            <Input
              value={newExt}
              onChange={(e) => setNewExt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addMapping();
                }
              }}
              placeholder="dbj"
              aria-label="File extension"
              className="w-24 font-mono"
            />
            <span className="text-muted-foreground">→</span>
            <LanguagePicker
              value={newLang}
              onValueChange={setNewLang}
              customLanguages={allLangs}
              autoLabel="Pick a language"
              onClear={() => setNewLang("")}
              triggerClassName="w-44"
            />
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              disabled={!newExt.trim() || !newLang}
              onClick={addMapping}
            >
              <PlusIcon /> Add
            </Button>
          </div>
        </div>

        <div className="space-y-3 border-t pt-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium text-muted-foreground">
              Custom languages
            </h3>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditing("new")}
            >
              <PlusIcon /> Add custom language
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Define a minimal grammar for a language the viewer doesn't support
            (import one from a VSCode grammar), then map an extension to it
            above.
          </p>
          {customLanguages.length > 0 && (
            <div className="space-y-2">
              {customLanguages.map((cl) => (
                <div
                  key={cl.id}
                  className="flex items-center gap-2 rounded border px-3 py-2"
                >
                  <span className="font-medium">{cl.name}</span>
                  <code className="font-mono text-xs text-muted-foreground">
                    {cl.id}
                  </code>
                  <div className="ml-auto flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Edit ${cl.name}`}
                      onClick={() => setEditing(cl)}
                    >
                      <PencilSimpleIcon />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${cl.name}`}
                      onClick={() => removeLang(cl.id)}
                    >
                      <XIcon />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {editing !== null && (
          <CustomLanguageDialog
            key={editing === "new" ? "new" : editing.id}
            initial={editing === "new" ? null : editing}
            existingIds={customLanguages.map((c) => c.id)}
            onSave={saveLang}
            onClose={() => setEditing(null)}
          />
        )}
      </section>
    );
  },
});
