import { useSaveSettings, useSettings } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { useEffectiveSyntax } from "@/lib/syntax/queries";
import { diffLang, fileExt } from "./diff-lang";
import { LanguagePicker } from "./LanguagePicker";

/**
 * The live language control in the diff toolbar. Shows the language this file
 * is highlighted as (the effective config, including any repo-shared mapping)
 * and lets the user set a personal override for the extension — saved
 * immediately, so every diff of that extension re-highlights at once.
 */
export function DiffLanguagePicker({
  filePath,
  open,
  onOpenChange,
}: {
  filePath: string;
  /** Controlled popover state, forwarded straight through: the diff toolbar owns
   *  it so the `change-diff-language` palette action can open a trigger its
   *  container query has hidden. Omit for uncontrolled behavior. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const repoPath = useUiStore((s) => s.repoPath);
  const effective = useEffectiveSyntax(repoPath);
  const ext = fileExt(filePath);

  // Nothing to map for files without an extension (dotfiles, Makefile, …).
  if (!ext || !settings.data) return null;

  const current = diffLang(filePath, effective.syntaxMap) ?? "";

  function setLang(lang: string) {
    if (!settings.data) return;
    saveSettings.mutate({
      ...settings.data,
      syntaxMap: { ...settings.data.syntaxMap, [ext]: lang },
    });
  }

  function clearLang() {
    if (!settings.data) return;
    const next = { ...settings.data.syntaxMap };
    delete next[ext];
    saveSettings.mutate({ ...settings.data, syntaxMap: next });
  }

  return (
    <LanguagePicker
      value={current}
      onValueChange={setLang}
      customLanguages={effective.customLanguages}
      autoLabel="Auto-detect"
      onClear={clearLang}
      triggerClassName="text-muted-foreground"
      open={open}
      onOpenChange={onOpenChange}
    />
  );
}
