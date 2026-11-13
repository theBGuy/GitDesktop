import { ArrowLeftIcon } from "@phosphor-icons/react";
import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { Markdown } from "@/components/markdown/markdown";
import { NavRail } from "@/components/NavRail";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useEffectiveBindings } from "@/lib/hotkeys/hotkeys";
import { useAiEnabled } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { GUIDE_SECTIONS } from "./content";
import { resolveBody } from "./resolve-body";

export function HelpScreen() {
  const closeHelp = useUiStore((s) => s.closeHelp);
  const aiEnabled = useAiEnabled();
  const bindings = useEffectiveBindings();
  const [sectionId, setSectionId] = useState(GUIDE_SECTIONS[0].id);

  // Drop AI-only sections when "Hide AI features" is on.
  const sections = useMemo(
    () => GUIDE_SECTIONS.filter((s) => aiEnabled || !s.ai),
    [aiEnabled],
  );
  // Keep a valid selection if the current section just got hidden.
  const active = sections.find((s) => s.id === sectionId) ?? sections[0];
  const body = useMemo(
    () => resolveBody(active.body, aiEnabled, bindings),
    [active.body, aiEnabled, bindings],
  );
  const railGroups = useMemo(
    () => [{ items: sections.map((s) => ({ id: s.id, label: s.label })) }],
    [sections],
  );

  // Esc closes the guide. Guarded so Base UI popups (which mark the event
  // consumed) get first claim; an effect event reads the latest closeHelp.
  const onEscape = useEffectEvent(() => closeHelp());
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !e.defaultPrevented) onEscape();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back"
          onClick={closeHelp}
        >
          <ArrowLeftIcon />
        </Button>
        <span className="text-sm font-medium">User guide</span>
      </header>

      <div className="flex min-h-0 flex-1">
        <NavRail
          ariaLabel="Guide sections"
          groups={railGroups}
          activeId={active.id}
          onSelect={setSectionId}
          className="w-44 overflow-y-auto border-r p-2"
        />
        {/* key remounts the scroll area so a new section starts at the top.
            overflow-hidden contains the content's natural height (vendored Root
            is `relative`-only) so a long guide page can't leak a window scrollbar. */}
        <ScrollArea key={active.id} className="min-h-0 flex-1 overflow-hidden">
          <main className="mx-auto w-full max-w-2xl p-6">
            <Markdown>{body}</Markdown>
          </main>
        </ScrollArea>
      </div>
    </div>
  );
}
