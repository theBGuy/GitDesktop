import { ArrowLeftIcon } from "@phosphor-icons/react";
import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { Markdown } from "@/components/markdown/markdown";
import { NavRail } from "@/components/NavRail";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatBinding, secondaryClickLabel } from "@/lib/hotkeys/binding";
import { useEffectiveBindings } from "@/lib/hotkeys/hotkeys";
import { ACTIONS, type ActionId } from "@/lib/hotkeys/registry";
import { useAiEnabled } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { GUIDE_SECTIONS } from "./content";

const BINDING_TOKEN = /\{\{(kbd|key):([a-z0-9+-]+)\}\}/g;
const AI_BLOCK = /\{\{ai\}\}[\s\S]*?\{\{\/ai\}\}/g;
const AI_MARKER = /\{\{\/?ai\}\}/g;
// {{secondaryclick}} → the platform's word for a context-menu click; the capital
// form {{Secondaryclick}} is sentence-initial and gets its first letter uppercased.
const SECONDARY_CLICK_TOKEN = /\{\{(s|S)econdaryclick\}\}/g;

// Actions that are palette-only by design (`defaultBinding: null`), so an unset
// binding reads as "palette" — the chip idiom — rather than "unbound" (which
// should mean the user deliberately cleared a real default).
const PALETTE_ONLY: Set<string> = new Set(
  ACTIONS.filter((a) => a.defaultBinding === null).map((a) => a.id),
);

/**
 * Resolve a guide body for display: first gate AI passages on `aiEnabled` (strip
 * the marked block when AI is hidden, else drop just the markers), then swap each
 * shortcut token for the live, platform-formatted binding — so the guide always
 * shows the right keys (⌘ vs Ctrl) and reflects the user's rebindings.
 */
function resolveBody(
  md: string,
  aiEnabled: boolean,
  bindings: Map<ActionId, string | null>,
): string {
  const gated = aiEnabled
    ? md.replace(AI_MARKER, "")
    : md.replace(AI_BLOCK, "");
  const withSecondary = gated.replace(
    SECONDARY_CLICK_TOKEN,
    (_match, initial) =>
      initial === "S"
        ? secondaryClickLabel.charAt(0).toUpperCase() +
          secondaryClickLabel.slice(1)
        : secondaryClickLabel,
  );
  return withSecondary.replace(BINDING_TOKEN, (_match, kind, ref) => {
    if (kind === "key") return formatBinding(ref);
    const binding = bindings.get(ref as ActionId);
    if (binding) return formatBinding(binding);
    // No live binding: distinguish a deliberately palette-only action from one
    // the user cleared. A palette-only action never had a key to lose, so
    // "unbound from the palette" reads wrong — say "palette" (the chip idiom).
    return PALETTE_ONLY.has(ref) ? "palette" : "unbound";
  });
}

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
