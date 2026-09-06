import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useRef, useState } from "react";
import { Markdown } from "@/components/markdown/markdown";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSaveSettings, useSettings } from "@/lib/settings/queries";
import changelogRaw from "../../../CHANGELOG.md?raw";

/** Pulls the CHANGELOG section for `version` (the `## [x.y.z]` block). */
function changelogSection(version: string): string {
  const lines = changelogRaw.split(/\r?\n/);
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`^##\\s*\\[${esc}\\]`);
  const start = lines.findIndex((l) => header.test(l));
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
}

/**
 * Shows the changelog once after the app updates to a new version (detected by
 * comparing the running version to the last one we showed). Silent on first
 * run and when the running version has no changelog section.
 */
export function WhatsNew() {
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState("");
  const [notes, setNotes] = useState("");
  const ranRef = useRef(false);

  useEffect(() => {
    const data = settings.data;
    if (!data || ranRef.current) return;
    ranRef.current = true;
    getVersion()
      .then((v) => {
        if (data.lastSeenVersion === v) return;
        // Don't pop the dialog on a brand-new install (no prior version seen).
        if (data.lastSeenVersion) {
          const section = changelogSection(v);
          if (section) {
            setVersion(v);
            setNotes(section);
            setOpen(true);
          }
        }
        saveSettings.mutate({ ...data, lastSeenVersion: v });
      })
      .catch(() => undefined);
  }, [settings.data, saveSettings.mutate]);

  if (!notes) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>What's new in v{version}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Markdown>{notes}</Markdown>
        </div>
        <DialogFooter>
          <Button onClick={() => setOpen(false)}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
