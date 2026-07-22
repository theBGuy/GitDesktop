import { useQuery } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { withForm } from "@/lib/form";
import { detectEditors } from "@/lib/git/api";
import { isWindows } from "@/lib/hotkeys/binding";
import { settingsFormOpts } from "./settings-form";

const CUSTOM = "__custom__";
const NONE = "__none__";
const CUSTOM_PLACEHOLDER = isWindows
  ? "C:\\path\\to\\editor.exe"
  : "/Applications/Visual Studio Code.app";

export const EditorSection = withForm({
  ...settingsFormOpts,
  render: function EditorSectionRender({ form }) {
    const detected = useQuery({
      queryKey: ["detected-editors"],
      queryFn: detectEditors,
      staleTime: 5 * 60 * 1000,
    });
    // "Custom…" picked while a detected editor is still set: reveal the path
    // input without changing the form values yet.
    const [forceCustom, setForceCustom] = useState(false);

    const externalEditor = useSelector(
      form.store,
      (s) => s.values.externalEditor,
    );

    const editors = detected.data ?? [];
    const matched = editors.find((e) => e.path === externalEditor);
    const selectValue = forceCustom
      ? CUSTOM
      : !externalEditor
        ? NONE
        : (matched?.path ?? CUSTOM);
    const showCustom = selectValue === CUSTOM;

    // Base UI's Select.Value renders the raw value unless given value→label items
    const selectItems: Record<string, string> = {
      [NONE]: "None",
      [CUSTOM]: "Custom…",
      ...Object.fromEntries(editors.map((e) => [e.path, e.name])),
    };

    function setEditor(path: string, name: string) {
      form.setFieldValue("externalEditor", path);
      form.setFieldValue("externalEditorName", name);
    }

    async function choose() {
      const picked = await openDialog({
        title: "Choose a program",
        // macOS editors are `.app` bundles and Linux ones are bare binaries;
        // only Windows uses .exe/.cmd/.bat, so don't filter elsewhere.
        filters: isWindows
          ? [{ name: "Programs", extensions: ["exe", "cmd", "bat"] }]
          : undefined,
      });
      if (picked) setEditor(picked, programLabel(picked));
    }

    return (
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-medium">External editor</h2>
          <p className="text-xs text-muted-foreground">
            Adds an "Open in …" entry to the file context menu. Installed
            editors are detected automatically.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="editor-select">Editor</Label>
          <Select
            items={selectItems}
            value={selectValue}
            onValueChange={(value) => {
              if (value === NONE) {
                setForceCustom(false);
                setEditor("", "");
              } else if (value === CUSTOM) {
                setForceCustom(true);
              } else if (value) {
                const editor = editors.find((e) => e.path === value);
                if (editor) {
                  setForceCustom(false);
                  setEditor(editor.path, editor.name);
                }
              }
            }}
          >
            <SelectTrigger id="editor-select" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>None</SelectItem>
              {editors.map((editor) => (
                <SelectItem key={editor.path} value={editor.path}>
                  {editor.name}
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM}>Custom…</SelectItem>
            </SelectContent>
          </Select>
          {detected.isPending && (
            <p className="text-xs text-muted-foreground">Detecting editors…</p>
          )}
          {!showCustom && matched && (
            <p className="truncate font-mono text-xs text-muted-foreground">
              {matched.path}
            </p>
          )}
        </div>
        {showCustom && (
          <div className="space-y-2">
            <Label htmlFor="external-editor">Program path</Label>
            <div className="flex gap-2">
              <Input
                id="external-editor"
                className="flex-1 font-mono"
                placeholder={CUSTOM_PLACEHOLDER}
                autoComplete="off"
                value={externalEditor}
                onChange={(e) =>
                  setEditor(e.target.value, programLabel(e.target.value))
                }
              />
              <Button type="button" variant="outline" onClick={choose}>
                Choose…
              </Button>
            </div>
          </div>
        )}
      </section>
    );
  },
});

/** "C:\\apps\\Code.exe" or "/Applications/Cursor.app" -> "Code"/"Cursor". */
function programLabel(program: string): string {
  const base = program.replaceAll("\\", "/").split("/").pop() ?? program;
  return base.replace(/\.(exe|cmd|bat|app)$/i, "") || "Custom";
}
