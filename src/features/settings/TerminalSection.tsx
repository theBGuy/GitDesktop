import { WarningCircleIcon } from "@phosphor-icons/react";
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
import { isWindows, type Platform, platform } from "@/lib/hotkeys/binding";
import { settingsFormOpts } from "./settings-form";

const DEFAULT = "__default__";
const CUSTOM = "__custom__";
const CUSTOM_COMMAND = "__custom_command__";

// The default terminal is platform-specific, so its label can't be hardcoded.
const DEFAULT_LABELS: Record<Platform, string> = {
  windows: "Default (Command Prompt)",
  mac: "Default (Terminal)",
  linux: "Default terminal",
};
const DEFAULT_LABEL = DEFAULT_LABELS[platform];

const CUSTOM_PLACEHOLDERS: Record<Platform, string> = {
  windows: "C:\\path\\to\\terminal.exe",
  mac: "/Applications/iTerm.app",
  linux: "/usr/bin/alacritty",
};
const CUSTOM_PLACEHOLDER = CUSTOM_PLACEHOLDERS[platform];

// A representative shell-free command per platform, showing the {path} token.
const CUSTOM_COMMAND_PLACEHOLDERS: Record<Platform, string> = {
  windows: "wt -d {path}",
  mac: "wezterm start --cwd {path}",
  linux: "tmux new-window -c {path}",
};
const CUSTOM_COMMAND_PLACEHOLDER = CUSTOM_COMMAND_PLACEHOLDERS[platform];

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
    const terminalCommand = useSelector(
      form.store,
      (s) => s.values.terminalCommand,
    );

    const terminals = detected.data ?? [];
    const matched = terminals.find((t) => t.id === terminal);
    const isCustom = terminal === "custom";
    const isCustomCommand = terminal === "custom-command";
    const selectValue = isCustomCommand
      ? CUSTOM_COMMAND
      : terminal === ""
        ? DEFAULT
        : isCustom
          ? CUSTOM
          : (matched?.id ?? CUSTOM);
    const showCustom = selectValue === CUSTOM;
    const showCustomCommand = selectValue === CUSTOM_COMMAND;
    // Non-blocking hint: a template without {path} still runs (it starts in the
    // repo directory), but the user probably meant to reference the repo.
    const missingPathToken =
      showCustomCommand &&
      terminalCommand.trim() !== "" &&
      !terminalCommand.includes("{path}");

    // Base UI's Select.Value renders the raw value unless given value→label items
    const selectItems: Record<string, string> = {
      [DEFAULT]: DEFAULT_LABEL,
      [CUSTOM]: "Custom…",
      [CUSTOM_COMMAND]: "Custom command…",
      ...Object.fromEntries(terminals.map((t) => [t.id, t.name])),
    };

    // Only ever writes `terminal`/`terminalPath`, leaving `terminalCommand`
    // untouched — so switching between modes preserves the other mode's value.
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
                // Flip the mode only; keep terminalPath (and terminalCommand)
                // so switching back and forth doesn't wipe the other value.
                if (!isCustom) form.setFieldValue("terminal", "custom");
              } else if (value === CUSTOM_COMMAND) {
                if (!isCustomCommand)
                  form.setFieldValue("terminal", "custom-command");
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
              <SelectItem value={CUSTOM_COMMAND}>Custom command…</SelectItem>
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
        {showCustomCommand && (
          <div className="space-y-2">
            <Label htmlFor="custom-terminal-command">Command</Label>
            <Input
              id="custom-terminal-command"
              className="font-mono"
              placeholder={CUSTOM_COMMAND_PLACEHOLDER}
              autoComplete="off"
              spellCheck={false}
              value={terminalCommand}
              onChange={(e) =>
                form.setFieldValue("terminalCommand", e.target.value)
              }
            />
            <p className="text-xs text-muted-foreground">
              Runs without a shell.{" "}
              <code className="font-mono">{"{path}"}</code> is replaced with the
              repository path; when omitted, the command starts in the
              repository directory. Use it for multiplexers, wrappers, or a
              terminal that isn't auto-detected.
            </p>
            {missingPathToken && (
              <p
                role="status"
                className="flex items-center gap-1 text-xs text-warning"
              >
                <WarningCircleIcon className="size-3.5 shrink-0" />
                No <code className="font-mono">{"{path}"}</code> in the command
                — it will start in the repository directory without receiving
                the path as an argument.
              </p>
            )}
          </div>
        )}
      </section>
    );
  },
});
