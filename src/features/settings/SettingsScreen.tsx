import { ArrowLeftIcon } from "@phosphor-icons/react";
import { useSelector } from "@tanstack/react-store";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { LazyPanelFallback } from "@/components/lazy-panel-fallback";
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
import {
  notificationsSignature,
  useNotificationsDraft,
} from "@/lib/notifications/matrix";
import { subscribeMcpRehome } from "@/lib/settings/api";
import { rehomeServerRepoKeys } from "@/lib/settings/mcp";
import { useSaveSettings, useSettings } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { toastComposedError } from "@/lib/toast";
import { useLatestRef } from "@/lib/use-latest-ref";
import { AboutSection } from "./AboutSection";
import { AccountsSection } from "./AccountsSection";
import { AiProviderSection } from "./AiProviderSection";
import { AppearanceSection } from "./AppearanceSection";
import { CommandsSection } from "./CommandsSection";
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
import {
  flushMcpSecretDeletes,
  flushMcpSecretSets,
} from "./mcp/flush-mcp-secrets";
import {
  type McpSecretsHandle,
  type McpStagedSecret,
  mcpSecretDeletes,
  mcpSetFailureHeadings,
  pruneStagedServer,
  settleStaged,
  stagedSetFlushPlan,
  stageMcpSecretSets,
} from "./mcp/secret-ops";
import { NotificationsSection } from "./NotificationsSection";
import { resetsAfterSave, stableStringify } from "./save-reset";
import { settingsFormOpts, toDraft } from "./settings-form";
import { TerminalSection } from "./TerminalSection";
import { UpdatesSection } from "./UpdatesSection";

// The Syntax panel pulls in the Shiki TextMate highlighter (@git-diff-view +
// @shikijs/core), which is heavy and only needed once this panel is visited.
// Loading it lazily keeps that whole chunk off the boot path — its render is
// already gated on `activePanel === "syntax"`, so the import fires on first
// visit, not on launch. `lazy` on the named export preserves the `form` prop's
// full type. The fallback mirrors the section's field geometry so the swap to
// the loaded panel doesn't shift layout.
const SyntaxSection = lazy(() =>
  import("./SyntaxSection").then((m) => ({ default: m.SyntaxSection })),
);

const PANELS = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "ai", label: "AI" },
  { id: "commands", label: "Slash commands" },
  { id: "mcp-servers", label: "MCP servers" },
  { id: "automations", label: "Automations" },
  { id: "notifications", label: "Notifications" },
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
  // Typed MCP secret values wait here until Save, in renderer memory only. It
  // lives on the screen, not the MCP section, so it outlives pane switches
  // exactly as the form draft does. The ref is the truth, written synchronously
  // by every writer through commitStaged, so a Save pressed right after a stage
  // sees it; the state only mirrors it for rendering.
  const stagedRef = useRef<McpStagedSecret[]>([]);
  const [stagedSecrets, setStagedSecrets] = useState<McpStagedSecret[]>([]);
  function commitStaged(next: McpStagedSecret[]) {
    stagedRef.current = next;
    setStagedSecrets(next);
  }
  // The mcpServers this form last saw saved: the delete diff only removes
  // secrets of servers it knew about, never one another window added.
  const mcpBaseline = useRef<unknown>(null);
  // Bumped by every Discard, so a Save can tell one ran during its write.
  const discards = useRef(0);
  const secretsDirty = stagedSecrets.length > 0;
  const secrets: McpSecretsHandle = {
    stage: (serverId, writes, liveSecretKeys) =>
      commitStaged(
        stageMcpSecretSets({
          staged: stagedRef.current,
          serverId,
          writes,
          liveSecretKeys,
        }),
      ),
    pruneServer: (serverId) =>
      commitStaged(pruneStagedServer(stagedRef.current, serverId)),
  };
  // Held for a whole Save, keychain flush included: the form's own isSubmitting
  // clears at the mid-save form.reset, which would let a second Save overlap.
  const saveLock = useRef(false);
  const [saveLocked, setSaveLocked] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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
      saveLock.current = true;
      setSaveLocked(true);
      try {
        // Press-time captures: a Discard during the awaits below rewrites both
        // the buffer and the baseline, and neither rewrite may reach this Save.
        const stagedAtPress = stagedRef.current;
        const baselineAtPress = mcpBaseline.current;
        const discardsAtPress = discards.current;
        const current = settings.data;
        if (!current) return;
        await saveSettings.mutateAsync({ ...current, ...value });
        // keepDefaultValues everywhere we reset-with-values: otherwise reset
        // rewrites the form's defaultValues and the per-render options sync
        // (which still sees settingsFormOpts' static defaults) clobbers the
        // values right back on the next render. An edit that landed during the
        // write skips the reset and stays dirty for the next Save; a Discard
        // during it put back pre-save values, so it resets as before.
        if (
          resetsAfterSave({
            discarded: discards.current !== discardsAtPress,
            current: form.state.values,
            written: value,
          })
        )
          form.reset(value, { keepDefaultValues: true });
        // Sets and deletes fire only after the committed write, from what this
        // form saw: a failed save writes nothing, a failed set stays staged, and
        // a failed delete orphans at worst.
        const plan = stagedSetFlushPlan({
          staged: stagedAtPress,
          committed: value.mcpServers,
        });
        const failed = await flushMcpSecretSets(plan.flush);
        const keep = [...failed.map((f) => f.entry), ...plan.retain];
        const next = settleStaged({
          current: stagedRef.current,
          pressed: stagedAtPress,
          keep,
        });
        commitStaged(next);
        const deletes = mcpSecretDeletes({
          baseline: baselineAtPress,
          saved: current.mcpServers,
          committed: value.mcpServers,
        });
        mcpBaseline.current = value.mcpServers;
        // Only failures still staged count: one a mid-flight Discard, prune or
        // re-type removed is no longer the user's to retry.
        const unstored = keep.filter((e) => next.includes(e)).length;
        const andClose = closeAfterSave.current;
        closeAfterSave.current = false;
        if (unstored > 0) {
          const title = `Settings saved, but ${unstored} secret value${unstored === 1 ? "" : "s"} couldn't be stored in your keychain. Save again to retry.`;
          // The keychain's own reason (a locked or missing keychain, a denied
          // prompt) rides Details; a value only retained has no error to show.
          const raised = failed.filter((f) => next.includes(f.entry));
          if (raised.length > 0)
            toastComposedError({
              title,
              errors: raised.map((f) => f.error),
              headings: mcpSetFailureHeadings({
                failures: raised,
                committed: value.mcpServers,
              }),
            });
          else toast.error(title);
        } else {
          toast.success("Settings saved");
          // The flush awaited above: close only if nothing changed meanwhile,
          // so an edit made during the save stays on screen with its Save bar.
          if (
            andClose &&
            mounted.current &&
            useUiStore.getState().view === "settings" &&
            stagedRef.current.length === 0 &&
            stableStringify(form.state.values) === stableStringify(value)
          )
            closeSettings();
        }
        flushMcpSecretDeletes(deletes);
      } finally {
        saveLock.current = false;
        setSaveLocked(false);
      }
    },
  });

  // Seed the form once settings arrive; afterwards the form is the source
  // of truth until Save or Discard.
  const seeded = useRef(false);
  useEffect(() => {
    if (settings.data && !seeded.current) {
      seeded.current = true;
      mcpBaseline.current = settings.data.mcpServers;
      form.reset(toDraft(settings.data), { keepDefaultValues: true });
    }
  }, [settings.data, form]);

  // A relocate re-homes the SAVED mcpServers keys; the draft gets the same move so
  // Save can't write the pre-relocate keys back and an untouched draft stays clean.
  // Field-scoped on purpose: a form reset would drop other sections' edits. The raw
  // draft goes in (the helper passes junk through) so no entry is dropped unasked.
  useEffect(
    () =>
      subscribeMcpRehome(({ oldPath, newKey }) => {
        const result = rehomeServerRepoKeys(
          form.state.values.mcpServers,
          oldPath,
          newKey,
        );
        if (result.changed) form.setFieldValue("mcpServers", result.servers);
      }),
    [form],
  );

  // Dirty by value-equality against the persisted settings (not "has been
  // touched"), so typing and undoing leaves the screen clean. Stringify the
  // saved side once per settings change (the compiler caches it), then subscribe
  // to the derived BOOLEAN: the selector still stringifies the form values per
  // store change, but the component only re-renders when dirtiness FLIPS — not
  // on every keystroke across all 13 panels.
  const isSubmitting = useSelector(form.store, (s) => s.isSubmitting);
  const saving = isSubmitting || saveLocked;
  const saved = settings.data ? toDraft(settings.data) : null;
  const savedStr = saved !== null ? stableStringify(saved) : null;
  const dirty = useSelector(
    form.store,
    (s) =>
      seeded.current &&
      savedStr !== null &&
      stableStringify(s.values) !== savedStr,
  );

  // Publish the notifications slice for the surfaces that reach the per-repo
  // dialog from OUTSIDE this form (the command palette): overrides are minted
  // against the SAVED matrix, so those routes have to refuse while a draft
  // disagrees. It lives here, not in the panel — the screen outlives every panel
  // switch, so Save and Discard from ANY panel move it, while a panel-level
  // publisher would freeze the moment its section unmounted. Same derived-string
  // shape as `dirty`, so a keystroke in another panel can't churn it, and
  // pre-seed publishes nothing: there is no draft to disagree with yet.
  const notificationsDraft = useSelector(form.store, (s) =>
    seeded.current ? notificationsSignature(s.values.notifications) : null,
  );
  const publishNotificationsDraft = useNotificationsDraft((s) => s.publish);
  useEffect(() => {
    if (notificationsDraft !== null)
      publishNotificationsDraft(notificationsDraft);
  }, [notificationsDraft, publishNotificationsDraft]);

  // Unsaved edits in the settings form, the Automations panel or the staged
  // MCP secrets should guard closing the screen.
  const closeDirty = dirty || automationsDirty || secretsDirty;

  function save(andClose: boolean) {
    if (saveLock.current) return;
    // Persist the Automations panel's own draft alongside the settings form —
    // fire-and-forget, like the form save: the store write completes even as the
    // screen closes. Without this, "Save and close" would silently drop it.
    if (automationsDirty) saveAutomationsRef.current?.();
    closeAfterSave.current = andClose;
    form.handleSubmit();
  }

  function discard() {
    discards.current += 1;
    commitStaged([]);
    mcpBaseline.current = settings.data?.mcpServers ?? null;
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
              {activePanel === "appearance" && <AppearanceSection />}
              {activePanel === "ai" && (
                <>
                  <AiProviderSection form={form} />
                  <InstructionsSection form={form} />
                </>
              )}
              {activePanel === "commands" && <CommandsSection form={form} />}
              {activePanel === "mcp-servers" && (
                <McpServersSection form={form} secrets={secrets} />
              )}
              {activePanel === "automations" && (
                <AutomationsSection
                  form={form}
                  onDirtyChange={setAutomationsDirty}
                  onRegisterSave={(fn) => {
                    saveAutomationsRef.current = fn;
                  }}
                />
              )}
              {activePanel === "notifications" && (
                <NotificationsSection form={form} />
              )}
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
                <Suspense
                  fallback={
                    <LazyPanelFallback
                      name="syntax settings"
                      className="gap-4 p-0"
                      rows={[
                        "h-5 w-36",
                        "h-4 w-2/3",
                        "h-9 w-full",
                        "h-9 w-full",
                        "h-24 w-full",
                      ]}
                    />
                  }
                >
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

      {(dirty || secretsDirty) && (
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
            <DisabledReasonButton
              size="sm"
              onClick={() => save(false)}
              disabled={saving}
              reason="Saving…"
            >
              {saving && <Spinner data-icon="inline-start" />}
              Save changes
            </DisabledReasonButton>
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
            <DisabledReasonButton
              onClick={() => {
                setConfirmClose(false);
                save(true);
              }}
              disabled={saving}
              reason="Saving…"
            >
              {saving && <Spinner data-icon="inline-start" />}
              Save and close
            </DisabledReasonButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
