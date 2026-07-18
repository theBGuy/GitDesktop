import { ArrowLeftIcon } from "@phosphor-icons/react";
import { useSelector } from "@tanstack/react-store";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { NavRail } from "@/components/NavRail";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { AutomationsSection } from "@/features/automations/AutomationsSection";
import { useAppForm } from "@/lib/form";
import { useSaveSettings, useSettings } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { useLatestRef } from "@/lib/use-latest-ref";
import { AboutSection } from "./AboutSection";
import { AccountsSection } from "./AccountsSection";
import { AiProviderSection } from "./AiProviderSection";
import { CommandsSection } from "./CommandsSection";
import { CompanionSection } from "./CompanionSection";
import { EditorSection } from "./EditorSection";
import { GeneralSection } from "./GeneralSection";
import {
  GitIdentitySection,
  GitSection,
  LineEndingsSection,
  RepoIdentitySection,
} from "./GitSection";
import { InstructionsSection } from "./InstructionsSection";
import { KeyboardSection } from "./KeyboardSection";
import { McpServersSection } from "./McpServersSection";
import { NotificationsSection } from "./NotificationsSection";
import { settingsFormOpts, toDraft } from "./settings-form";
import { TerminalSection } from "./TerminalSection";
import { UpdatesSection } from "./UpdatesSection";

// The Syntax panel pulls in the Shiki TextMate highlighter (@git-diff-view +
// @shikijs/core), which is heavy and only needed once this panel is visited.
// Loading it lazily keeps that whole chunk off the boot path — its render is
// already gated on `activePanel === "syntax"`, so the import fires on first
// visit, not on launch. `lazy` on the named export preserves the `form` prop's
// full type. The fallback is null: the panel renders instantly once loaded (tens
// of ms from local disk) and, like the other panels, shows no intermediate
// state before its data — a spinner would flash where nothing otherwise does.
const SyntaxSection = lazy(() =>
  import("./SyntaxSection").then((m) => ({ default: m.SyntaxSection })),
);

const PANELS = [
  { id: "general", label: "General" },
  { id: "ai", label: "AI" },
  { id: "commands", label: "Slash commands" },
  { id: "mcp-servers", label: "MCP servers" },
  { id: "automations", label: "Automations" },
  { id: "notifications", label: "Notifications" },
  { id: "companion", label: "Phone companion" },
  { id: "keyboard", label: "Keyboard" },
  { id: "accounts", label: "Accounts" },
  { id: "git", label: "Git" },
  { id: "syntax", label: "Syntax" },
  { id: "editor", label: "External editor" },
  { id: "terminal", label: "Terminal" },
  { id: "updates", label: "Updates" },
  { id: "about", label: "About" },
] as const;

type PanelId = (typeof PANELS)[number]["id"];

/** JSON with object keys sorted, so the dirty check is insensitive to key
 *  order. The Tauri store round-trips nested objects (e.g. an imported
 *  TextMate grammar) with reordered keys, which would otherwise leave the
 *  Save bar stuck on "unsaved changes" forever. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.keys(val as Record<string, unknown>)
            .sort()
            .map((k) => [k, (val as Record<string, unknown>)[k]]),
        )
      : val,
  );
}

/** Panels that only make sense when AI features are enabled. */
const AI_PANELS = new Set<PanelId>([
  "ai",
  "commands",
  "mcp-servers",
  "automations",
]);

export function SettingsScreen() {
  const closeSettings = useUiStore((s) => s.closeSettings);
  const settingsTarget = useUiStore((s) => s.settingsTarget);
  const clearSettingsTarget = useUiStore((s) => s.clearSettingsTarget);
  const repoPath = useUiStore((s) => s.repoPath);
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const [panel, setPanel] = useState<PanelId>(
    // Honor a deep-link target on first render (e.g. "Set up AI" → AI panel).
    (settingsTarget as PanelId | null) ?? "general",
  );
  const [confirmClose, setConfirmClose] = useState(false);
  const closeAfterSave = useRef(false);
  // The Automations panel edits its own draft (saved independently of the
  // settings form); track its dirtiness so closing Settings still guards it, and
  // hold its imperative save so "Save and close" persists it too.
  const [automationsDirty, setAutomationsDirty] = useState(false);
  const saveAutomationsRef = useRef<(() => void) | null>(null);

  // A deep-link fired while Settings is already open (no remount) still routes
  // to the requested section; consume the target so it doesn't re-fire.
  useEffect(() => {
    if (!settingsTarget) return;
    setPanel(settingsTarget as PanelId);
    clearSettingsTarget();
  }, [settingsTarget, clearSettingsTarget]);

  // Gating reflects SAVED settings (not the in-progress draft), so panels don't
  // vanish mid-edit while the user is still toggling "Hide AI features".
  const aiEnabled = !settings.data?.hideAi;
  const visiblePanels = useMemo(
    () => PANELS.filter((p) => aiEnabled || !AI_PANELS.has(p.id)),
    [aiEnabled],
  );
  // Keep a sensible active panel if the current one got hidden.
  const activePanel = visiblePanels.some((p) => p.id === panel)
    ? panel
    : "general";
  const railGroups = useMemo(
    () => [{ items: visiblePanels.map((p) => ({ id: p.id, label: p.label })) }],
    [visiblePanels],
  );

  const form = useAppForm({
    ...settingsFormOpts,
    onSubmit: async ({ value }) => {
      const current = settings.data;
      if (!current) return;
      await saveSettings.mutateAsync({ ...current, ...value });
      // keepDefaultValues everywhere we reset-with-values: otherwise reset
      // rewrites the form's defaultValues and the per-render options sync
      // (which still sees settingsFormOpts' static defaults) clobbers the
      // values right back on the next render.
      form.reset(value, { keepDefaultValues: true });
      toast.success("Settings saved");
      if (closeAfterSave.current) {
        closeAfterSave.current = false;
        closeSettings();
      }
    },
  });

  // Seed the form once settings arrive; afterwards the form is the source
  // of truth until Save or Discard.
  const seeded = useRef(false);
  useEffect(() => {
    if (settings.data && !seeded.current) {
      seeded.current = true;
      form.reset(toDraft(settings.data), { keepDefaultValues: true });
    }
  }, [settings.data, form]);

  // Dirty by value-equality against the persisted settings (not "has been
  // touched"), so typing and undoing leaves the screen clean. Stringify the
  // saved side once per settings change (the compiler caches it), then subscribe
  // to the derived BOOLEAN: the selector still stringifies the form values per
  // store change, but the component only re-renders when dirtiness FLIPS — not
  // on every keystroke across all 13 panels.
  const isSubmitting = useSelector(form.store, (s) => s.isSubmitting);
  const saved = settings.data ? toDraft(settings.data) : null;
  const savedStr = saved !== null ? stableStringify(saved) : null;
  const dirty = useSelector(
    form.store,
    (s) =>
      seeded.current &&
      savedStr !== null &&
      stableStringify(s.values) !== savedStr,
  );

  // Either the settings form or the Automations panel having unsaved edits
  // should guard closing the screen.
  const closeDirty = dirty || automationsDirty;

  function save(andClose: boolean) {
    // Persist the Automations panel's own draft alongside the settings form —
    // fire-and-forget, like the form save: the store write completes even as the
    // screen closes. Without this, "Save and close" would silently drop it.
    if (automationsDirty) saveAutomationsRef.current?.();
    closeAfterSave.current = andClose;
    form.handleSubmit();
  }

  function discard() {
    if (saved) form.reset(saved, { keepDefaultValues: true });
  }

  function requestClose() {
    if (closeDirty) setConfirmClose(true);
    else closeSettings();
  }

  // Esc closes settings (guarded). Base UI popups handle their own Esc and
  // mark the event consumed, so this only fires when nothing else claimed it.
  // The listener subscribes once; a latest-ref lets it read the current dirty
  // state without re-subscribing on every render.
  const dirtyRef = useLatestRef(closeDirty);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !e.defaultPrevented) {
        if (dirtyRef.current) setConfirmClose(true);
        else closeSettings();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeSettings]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back"
          onClick={requestClose}
        >
          <ArrowLeftIcon />
        </Button>
        <span className="text-sm font-medium">Settings</span>
      </header>

      {settings.isPending ? (
        <div className="mx-auto w-full max-w-2xl space-y-3 p-6">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <NavRail
            ariaLabel="Settings sections"
            groups={railGroups}
            activeId={activePanel}
            onSelect={(id) => setPanel(id as PanelId)}
            className="w-44 border-r p-2"
          />
          {/* overflow-hidden contains the panel's natural height (vendored Root is
              `relative`-only) so a tall settings panel can't leak a window scrollbar. */}
          <ScrollArea className="min-h-0 flex-1 overflow-hidden">
            <main className="mx-auto w-full max-w-2xl space-y-8 p-6">
              {activePanel === "general" && <GeneralSection form={form} />}
              {activePanel === "ai" && (
                <>
                  <AiProviderSection form={form} />
                  <InstructionsSection form={form} />
                </>
              )}
              {activePanel === "commands" && <CommandsSection form={form} />}
              {activePanel === "mcp-servers" && (
                <McpServersSection form={form} />
              )}
              {activePanel === "automations" && (
                <AutomationsSection
                  onDirtyChange={setAutomationsDirty}
                  onRegisterSave={(fn) => {
                    saveAutomationsRef.current = fn;
                  }}
                />
              )}
              {activePanel === "notifications" && (
                <NotificationsSection form={form} />
              )}
              {activePanel === "companion" && <CompanionSection />}
              {activePanel === "keyboard" && <KeyboardSection form={form} />}
              {activePanel === "accounts" && <AccountsSection />}
              {activePanel === "git" && (
                <>
                  <GitSection />
                  <LineEndingsSection />
                  <GitIdentitySection />
                  {repoPath && <RepoIdentitySection repoPath={repoPath} />}
                </>
              )}
              {activePanel === "syntax" && (
                <Suspense fallback={null}>
                  <SyntaxSection form={form} />
                </Suspense>
              )}
              {activePanel === "editor" && <EditorSection form={form} />}
              {activePanel === "terminal" && <TerminalSection form={form} />}
              {activePanel === "updates" && <UpdatesSection form={form} />}
              {activePanel === "about" && <AboutSection />}
            </main>
          </ScrollArea>
        </div>
      )}

      {dirty && (
        <footer
          role="status"
          className="flex shrink-0 items-center justify-between gap-3 border-t px-4 py-2.5"
        >
          <span className="text-xs text-muted-foreground">
            You have unsaved changes
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={discard}>
              Discard
            </Button>
            <Button
              size="sm"
              onClick={() => save(false)}
              disabled={isSubmitting}
            >
              {isSubmitting && <Spinner data-icon="inline-start" />}
              Save changes
            </Button>
          </div>
        </footer>
      )}

      <Dialog open={confirmClose} onOpenChange={setConfirmClose}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unsaved changes</DialogTitle>
            <DialogDescription>
              You have changes that haven't been saved yet.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmClose(false)}>
              Keep editing
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setConfirmClose(false);
                discard();
                closeSettings();
              }}
            >
              Discard and close
            </Button>
            <Button
              onClick={() => {
                setConfirmClose(false);
                save(true);
              }}
              disabled={isSubmitting}
            >
              {isSubmitting && <Spinner data-icon="inline-start" />}
              Save and close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
