import { useQuery } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
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
import { detectTerminals } from "@/lib/git/api";
import { isMac, isWindows } from "@/lib/hotkeys/binding";
import { settingsFormOpts } from "./settings-form";

const DEFAULT = "__default__";
const CUSTOM = "__custom__";

// The default terminal is platform-specific, so its label can't be hardcoded.
const DEFAULT_LABEL = isWindows
  ? "Default (Command Prompt)"
  : isMac
    ? "Default (Terminal)"
    : "Default terminal";
const CUSTOM_PLACEHOLDER = isWindows
  ? "C:\\path\\to\\terminal.exe"
  : isMac
    ? "/Applications/iTerm.app"
    : "/usr/bin/alacritty";

export const TerminalSection = withForm({
  ...settingsFormOpts,
  render: function TerminalSectionRender({ form }) {
    const detected = useQuery({
      queryKey: ["detected-terminals"],
      queryFn: detectTerminals,
      staleTime: 5 * 60 * 1000,
    });

    const terminal = useSelector(form.store, (s) => s.values.terminal);
    const terminalPath = useSelector(form.store, (s) => s.values.terminalPath);

    const terminals = detected.data ?? [];
    const matched = terminals.find((t) => t.id === terminal);
    const isCustom = terminal === "custom";
    const selectValue =
      terminal === "" ? DEFAULT : isCustom ? CUSTOM : (matched?.id ?? CUSTOM);
    const showCustom = selectValue === CUSTOM;

    // Base UI's Select.Value renders the raw value unless given value→label items
    const selectItems: Record<string, string> = {
      [DEFAULT]: DEFAULT_LABEL,
      [CUSTOM]: "Custom…",
      ...Object.fromEntries(terminals.map((t) => [t.id, t.name])),
    };

    function setTerminal(kind: string, path: string) {
      form.setFieldValue("terminal", kind);
      form.setFieldValue("terminalPath", path);
    }

    async function choose() {
      const picked = await openDialog({
        title: "Choose a terminal program",
        // Windows programs are .exe/.cmd/.bat; macOS terminals are `.app`
        // bundles and Linux ones are bare binaries, so don't filter there.
        filters: isWindows
          ? [{ name: "Programs", extensions: ["exe", "cmd", "bat"] }]
          : undefined,
      });
      if (picked) setTerminal("custom", picked);
    }

    return (
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-medium">Terminal</h2>
          <p className="text-xs text-muted-foreground">
            Used by "Open in terminal" in the repository menu. Installed
            terminals are detected automatically.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="terminal-select">Application</Label>
          <Select
            items={selectItems}
            value={selectValue}
            onValueChange={(value) => {
              if (value === DEFAULT) {
                setTerminal("", "");
              } else if (value === CUSTOM) {
                if (!isCustom) form.setFieldValue("terminal", "custom");
              } else if (value) {
                const t = terminals.find((x) => x.id === value);
                if (t) setTerminal(t.id, t.path);
              }
            }}
          >
            <SelectTrigger id="terminal-select" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT}>{DEFAULT_LABEL}</SelectItem>
              {terminals.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM}>Custom…</SelectItem>
            </SelectContent>
          </Select>
          {detected.isPending && (
            <p className="text-xs text-muted-foreground">
              Detecting terminals…
            </p>
          )}
          {!showCustom && matched && (
            <p className="truncate font-mono text-xs text-muted-foreground">
              {matched.path}
            </p>
          )}
        </div>
        {showCustom && (
          <div className="space-y-2">
            <Label htmlFor="custom-terminal">Program path</Label>
            <div className="flex gap-2">
              <Input
                id="custom-terminal"
                className="flex-1 font-mono"
                placeholder={CUSTOM_PLACEHOLDER}
                autoComplete="off"
                value={terminalPath}
                onChange={(e) => setTerminal("custom", e.target.value)}
              />
              <Button type="button" variant="outline" onClick={choose}>
                Choose…
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Launched in a new window at the repository folder.
            </p>
          </div>
        )}
      </section>
    );
  },
});
