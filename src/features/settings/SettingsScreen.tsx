import { ArrowLeftIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { repoOpenWatermark } from "@/features/repository/useOpenRepoByPath";
import { presentError } from "@/lib/error-summary";
import { useAppForm } from "@/lib/form";
import {
  notificationsSignature,
  useNotificationsDraft,
} from "@/lib/notifications/matrix";
import { type AppSettings, subscribeMcpRehome } from "@/lib/settings/api";
import { rehomeServerRepoKeys } from "@/lib/settings/mcp";
import {
  settingsKeys,
  useSaveSettings,
  useSettings,
} from "@/lib/settings/queries";
import { type ConfirmRequest, useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";
import { toastComposedError } from "@/lib/toast";
import { useLatestRef } from "@/lib/use-latest-ref";
import { useToastClearance } from "@/lib/use-toast-clearance";
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
import {
  discardActs,
  discardConfirmBody,
  resetsAfterSave,
  stableStringify,
} from "./save-reset";
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

/** A leave that runs later, stamped when it was requested: it runs only while
 *  the interaction epoch is unchanged and no newer repository open was claimed
 *  (`noNewerOpen`, a `repoOpenWatermark`), since a claim moves no epoch. */
type DeferredLeave = {
  run: () => void;
  epoch: number;
  noNewerOpen: () => boolean;
};

/** Focuses `panel`'s entry in the Settings rail under `root`, if both exist. */
function focusRailItem(root: HTMLElement | null, panel: string) {
  root
    ?.querySelector<HTMLElement>(`[data-rail-item="${CSS.escape(panel)}"]`)
    ?.focus({ preventScroll: true });
}

export function SettingsScreen() {
  const closeSettings = useUiStore((s) => s.closeSettings);
  const setSettingsLeaveGuard = useUiStore((s) => s.setSettingsLeaveGuard);
  const settingsTarget = useUiStore((s) => s.settingsTarget);
  const clearSettingsTarget = useUiStore((s) => s.clearSettingsTarget);
  const repoPath = useUiStore((s) => s.repoPath);
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const queryClient = useQueryClient();
  const rootRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLElement>(null);
  const [panel, setPanel] = useState<PanelId>(
    // Honor a deep-link target on first render (e.g. "Set up AI" → AI panel).
    (settingsTarget as PanelId | null) ?? "general",
  );
  const [confirmClose, setConfirmClose] = useState(false);
  const confirmCloseRef = useLatestRef(confirmClose);
  // The move the Unsaved changes dialog holds for its answer (null: Back/Esc,
  // whose move is closing Settings).
  const pendingLeave = useRef<(() => void) | null>(null);
  // The repository opens claimed when that move was asked about: a Save landing
  // under the prompt runs the move only while no newer open was claimed.
  const pendingLeaveNoNewerOpen = useRef<(() => boolean) | null>(null);
  // Where an in-flight Save continues ("Save and close"'s move, or one held
  // while it writes), with its request's stamps. Read live when the Save lands,
  // so a later move replaces it and Keep editing cancels it; dropped by every
  // Save's end.
  const leaveAfterSave = useRef<DeferredLeave | null>(null);
  // The Automations write the Save started or joined, which it waits for too.
  const automationsAtSave = useRef<Promise<boolean> | null>(null);
  // The Automations panel edits its own draft (saved independently of the
  // settings form); track its dirtiness so closing Settings still guards it, and
  // hold its imperative save and discard so the footer's Save and Discard (and
  // the close guard's) reach it too. Its in-flight write folds into `saving`.
  const [automationsDirty, setAutomationsDirty] = useState(false);
  const [automationsSaving, setAutomationsSaving] = useState(false);
  const saveAutomationsRef = useRef<
    ((opts?: { quiet?: boolean }) => Promise<boolean>) | null
  >(null);
  // The panel's in-flight write, read live; never starts one.
  const joinAutomationsRef = useRef<(() => Promise<boolean> | null) | null>(
    null,
  );
  const discardAutomationsRef = useRef<(() => void) | null>(null);
  const automationsDirtyRef = useLatestRef(automationsDirty);
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
  // Bumped by every confirmed Discard, so a Save can tell one ran during its
  // write.
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
  // This screen's own open Discard prompt. The prompt is app-scoped and global
  // hotkeys still navigate under a modal, so leaving Settings dismisses it here
  // rather than orphan a prompt for a form that no longer exists.
  const promptRef = useRef<ConfirmRequest | null>(null);
  useEffect(
    () => () => {
      if (useConfirm.getState().request === promptRef.current)
        promptRef.current?.resolve(false, false);
    },
    [],
  );

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
  // Read late (a deep link can move the panel while a prompt is open).
  const activePanelRef = useLatestRef(activePanel);

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
        const automationsSaved = automationsAtSave.current;
        automationsAtSave.current = null;
        const current = settings.data;
        if (!current) return;
        try {
          await saveSettings.mutateAsync({ ...current, ...value });
        } catch (e) {
          // Nothing below runs on a failed write: the draft, the staged secrets
          // and the stored ones all stay as they were, ready for another Save.
          toastComposedError({
            title: `Couldn't save settings: ${presentError(e).summary}`,
            description: "Your changes are still here. Save again to retry.",
            errors: [e],
          });
          return;
        }
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
          // Continue once every Automations write lands too (one started after
          // the press included; a failure already toasted, so it stays), to
          // wherever the move stands NOW: Save and close's, or one
          // `requestLeave` held while this Save was writing. Only if nothing
          // happened meanwhile: no edit (it stays on screen with its Save bar),
          // no prompt open (this screen's or an app-scoped one, such as the
          // footer Discard's), and no user action or repository open since the
          // move was requested, so this late resume retires nothing newer.
          if (
            leaveAfterSave.current !== null &&
            (await automationsLanded(automationsSaved))
          ) {
            const leave = leaveAfterSave.current;
            if (
              leave !== null &&
              mounted.current &&
              useUiStore.getState().view === "settings" &&
              useUiStore.getState().interactionEpoch === leave.epoch &&
              leave.noNewerOpen() &&
              !confirmCloseRef.current &&
              pendingLeave.current === null &&
              useConfirm.getState().request === null &&
              stagedRef.current.length === 0 &&
              !automationsDirtyRef.current &&
              stableStringify(form.state.values) === stableStringify(value)
            ) {
              leaveAfterSave.current = null;
              // Synchronously, or the guard would intercept the resumed move.
              setSettingsLeaveGuard(null);
              leave.run();
            }
          }
        }
        flushMcpSecretDeletes(deletes);
      } finally {
        // Every way out of a Save drops its move: a failed Save never leaves.
        leaveAfterSave.current = null;
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
  const saving = isSubmitting || saveLocked || automationsSaving;
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
  const closeDirtyRef = useLatestRef(closeDirty);
  // A move held for an inline Automations write alone (no Save running).
  const heldForAutomations = useRef<DeferredLeave | null>(null);

  // Waits out the given Automations write and any inline one still in flight
  // after it (one started meanwhile included); true iff each landed. Joins
  // through the panel's join-only handle, so it never starts or retries a write.
  async function automationsLanded(first: Promise<boolean> | null) {
    let ok = first === null || (await first);
    for (
      let next = joinAutomationsRef.current?.() ?? null;
      ok && next !== null;
      next = joinAutomationsRef.current?.() ?? null
    )
      ok = await next;
    return ok;
  }

  // The one leave route, for the guard's intercepts and Back/Esc (`move` null:
  // closing Settings), deciding from live values. An open prompt takes the move
  // as its held one, and unsaved edits ask, except during "Save and close",
  // where the move replaces where that save continues. With nothing unsaved but
  // a write in flight, the move waits silently and continues only if the writes
  // land and nothing happened since. A later move replaces any held one.
  function requestLeave(move: (() => void) | null) {
    heldForAutomations.current = null;
    // Back and Esc are user requests of their own, so they retire older
    // pending continuations; every other move's intercept already bumped.
    if (move === null) useUiStore.getState().noteUserInteraction();
    const run = move ?? closeSettings;
    // Both stamps after the bump above (or the intercept's), so neither counts
    // this request against itself.
    const epoch = useUiStore.getState().interactionEpoch;
    const noNewerOpen = repoOpenWatermark();
    if (confirmCloseRef.current) {
      pendingLeave.current = move;
      pendingLeaveNoNewerOpen.current = noNewerOpen;
      return;
    }
    if (
      closeDirtyRef.current &&
      !(saveLock.current && leaveAfterSave.current !== null)
    ) {
      pendingLeave.current = move;
      pendingLeaveNoNewerOpen.current = noNewerOpen;
      setConfirmClose(true);
      return;
    }
    if (saveLock.current) {
      // The Save's success arm reads this live once every write lands.
      leaveAfterSave.current = { run, epoch, noNewerOpen };
      return;
    }
    const inFlight = joinAutomationsRef.current?.() ?? null;
    if (inFlight !== null) {
      const held = { run, epoch, noNewerOpen };
      heldForAutomations.current = held;
      void automationsLanded(inFlight).then((ok) => {
        if (heldForAutomations.current !== held) return;
        heldForAutomations.current = null;
        // The Save's resume conditions, plus no Save started since.
        if (
          ok &&
          mounted.current &&
          useUiStore.getState().view === "settings" &&
          useUiStore.getState().interactionEpoch === held.epoch &&
          held.noNewerOpen() &&
          !confirmCloseRef.current &&
          pendingLeave.current === null &&
          useConfirm.getState().request === null &&
          !saveLock.current &&
          !automationsDirtyRef.current &&
          !unsavedNow()
        ) {
          setSettingsLeaveGuard(null);
          held.run();
        }
      });
      return;
    }
    setSettingsLeaveGuard(null);
    run();
  }
  const requestLeaveRef = useLatestRef(requestLeave);

  // Navigators that can leave Settings from elsewhere ask here first while
  // anything is unsaved or a save is writing (`requestLeave` decides between
  // prompt, hold and go). Nulled otherwise and at unmount, since a guard left
  // behind would hold every navigation.
  const guardOn = closeDirty || saving;
  useEffect(() => {
    if (!guardOn) return;
    setSettingsLeaveGuard((resume) => requestLeaveRef.current(resume));
    return () => setSettingsLeaveGuard(null);
  }, [guardOn, setSettingsLeaveGuard]);

  // A Save that lands under the open prompt leaves nothing to ask about: close
  // it and continue to the move it held (Back's being closing Settings). Not
  // while any write is still in flight: the Automations patch reads clean
  // before its write lands, and a failure must still find the draft on screen.
  // A repository open claimed since the move was asked about wins instead: the
  // prompt closes without the move, and the open proceeds on its own.
  useEffect(() => {
    if (closeDirty || saving || !confirmClose) return;
    const leave = pendingLeave.current ?? closeSettings;
    const noNewerOpen = pendingLeaveNoNewerOpen.current;
    pendingLeave.current = null;
    pendingLeaveNoNewerOpen.current = null;
    setConfirmClose(false);
    if (noNewerOpen !== null && !noNewerOpen()) return;
    // Synchronously, or the guard would intercept the resumed move.
    setSettingsLeaveGuard(null);
    leave();
  }, [closeDirty, saving, confirmClose, closeSettings, setSettingsLeaveGuard]);

  const footerVisible = dirty || secretsDirty;
  const footerVisibleRef = useLatestRef(footerVisible);
  useToastClearance(footerRef, footerVisible);

  // Whether anything is unsaved against the settings CACHE right now, which a
  // Save that just settled has already updated before this screen re-renders.
  function unsavedNow() {
    const fresh = queryClient.getQueryData<AppSettings>(settingsKeys.settings);
    return discardActs({
      current: form.state.values,
      fresh: fresh ? toDraft(fresh) : null,
      stagedCount: stagedRef.current.length,
    });
  }

  // Footer-unmount focus, in the commit that hides it: land on the rail entry
  // when the removed footer held focus (now on body) or a confirmed Discard aimed
  // there (focus may still sit in the closing prompt); a control the user moved
  // to keeps it. The aim is consumed on every footer flip.
  const pendingRailFocus = useRef(false);
  const footerWasVisible = useRef(false);
  useLayoutEffect(() => {
    const hid = footerWasVisible.current && !footerVisible;
    footerWasVisible.current = footerVisible;
    const aimed = pendingRailFocus.current;
    pendingRailFocus.current = false;
    if (!hid) return;
    const active = document.activeElement;
    if (aimed || active === null || active === document.body)
      focusRailItem(rootRef.current, activePanelRef.current);
  }, [footerVisible]);

  // For an answer that leaves the footer where it was (nothing in it left to
  // discard, or already gone), so no footer flip places focus: the frame
  // outlasts the dialog's close and lands before Base UI's later focus return.
  function focusRailAfterPrompt() {
    requestAnimationFrame(() =>
      focusRailItem(rootRef.current, activePanelRef.current),
    );
  }

  // `after` runs once the Save lands (null for the footer's plain Save).
  function save(after: (() => void) | null) {
    if (saveLock.current) return;
    // Persist the Automations panel's own draft alongside the settings form;
    // without this, "Save and close" would silently drop it. Called whenever
    // the panel registers a handle, never gated on `automationsDirty`: the
    // optimistic patch clears that while an inline save is still in flight, and
    // the handle joins that write so the continuation waits for it.
    automationsAtSave.current =
      saveAutomationsRef.current?.({ quiet: true }) ?? null;
    // Stamped at this press (already past the bump of the request it continues:
    // the intercept's, or Back's or Esc's own): the resume bumps when it runs at
    // settle, and runs only if no user action or repository open came since.
    leaveAfterSave.current = after && {
      run: after,
      epoch: useUiStore.getState().interactionEpoch,
      noNewerOpen: repoOpenWatermark(),
    };
    form.handleSubmit();
  }

  // A confirmed answer's reset, read from the cache at call time so a Save that
  // settled while the prompt was open is kept rather than undone.
  function applyDiscard() {
    const fresh = queryClient.getQueryData<AppSettings>(settingsKeys.settings);
    discards.current += 1;
    commitStaged([]);
    mcpBaseline.current = fresh?.mcpServers ?? null;
    if (fresh) form.reset(toDraft(fresh), { keepDefaultValues: true });
    if (automationsDirtyRef.current) discardAutomationsRef.current?.();
  }

  async function requestDiscard() {
    const answer = useConfirm.getState().ask({
      title: "Discard unsaved changes?",
      body: discardConfirmBody(stagedRef.current.length),
      confirmLabel: "Discard changes",
      confirmVariant: "destructive",
      scope: "app",
    });
    const mine = useConfirm.getState().request;
    promptRef.current = mine;
    const ok = await answer;
    if (promptRef.current === mine) promptRef.current = null;
    if (!ok) {
      // Base UI returns focus to Discard; when a clean Save took the footer away
      // meanwhile, land on the rail instead. A superseding prompt or a closed
      // screen keeps focus where it is.
      if (
        mounted.current &&
        useConfirm.getState().request === null &&
        !footerVisibleRef.current
      )
        focusRailAfterPrompt();
      return;
    }
    if (!mounted.current || useUiStore.getState().view !== "settings") return;
    if (!unsavedNow()) {
      if (automationsDirtyRef.current) discardAutomationsRef.current?.();
      focusRailAfterPrompt();
      return;
    }
    pendingRailFocus.current = true;
    applyDiscard();
  }

  // Esc closes settings through the same route as Back. Base UI popups handle
  // their own Esc and mark the event consumed, so this only fires when nothing
  // else claimed it. The listener subscribes once and reads the latest route.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !e.defaultPrevented)
        requestLeaveRef.current(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // The Unsaved changes answers, one dialog for Back, Esc and every intercepted
  // navigation: "…and close" continues to the held move, else closes Settings.
  function takePendingLeave() {
    const leave = pendingLeave.current ?? closeSettings;
    pendingLeave.current = null;
    return leave;
  }

  // Cancels the move, an in-flight "Save and close"'s included.
  function keepEditing() {
    pendingLeave.current = null;
    leaveAfterSave.current = null;
    setConfirmClose(false);
  }

  function discardAndLeave() {
    const leave = takePendingLeave();
    leaveAfterSave.current = null;
    setConfirmClose(false);
    applyDiscard();
    // Synchronously, or the guard would intercept the resumed move.
    setSettingsLeaveGuard(null);
    leave();
  }

  function saveAndLeave() {
    const leave = takePendingLeave();
    setConfirmClose(false);
    save(leave);
  }

  // A close that leaves focus nowhere lands it on the rail: a route that had
  // already moved focus (the palette) leaves Base UI's return nothing to land
  // on. That return runs from the popup's unmount, which is what fires
  // `onOpenChangeComplete(false)`, so the frame after it sees where it landed.
  function focusRailIfDropped() {
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (mounted.current && (active === null || active === document.body))
        focusRailItem(rootRef.current, activePanelRef.current);
    });
  }

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back"
          onClick={() => requestLeave(null)}
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
                  onSavingChange={setAutomationsSaving}
                  onRegisterJoin={(fn) => {
                    joinAutomationsRef.current = fn;
                  }}
                  onRegisterDiscard={(fn) => {
                    discardAutomationsRef.current = fn;
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

      {footerVisible && (
        <footer
          ref={footerRef}
          role="status"
          className="flex shrink-0 items-center justify-between gap-3 border-t px-4 py-2.5"
        >
          <span className="text-xs text-muted-foreground">
            You have unsaved changes
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={requestDiscard}>
              Discard
            </Button>
            <DisabledReasonButton
              size="sm"
              onClick={() => save(null)}
              disabled={saving}
              reason="Saving…"
            >
              {saving && <Spinner data-icon="inline-start" />}
              Save changes
            </DisabledReasonButton>
          </div>
        </footer>
      )}

      <Dialog
        open={confirmClose}
        onOpenChange={(open) => {
          // A backdrop click or Esc is Keep editing.
          if (!open) keepEditing();
          else setConfirmClose(true);
        }}
        onOpenChangeComplete={(open) => {
          if (!open) focusRailIfDropped();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unsaved changes</DialogTitle>
            <DialogDescription>
              You have changes that haven't been saved yet.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={keepEditing}>
              Keep editing
            </Button>
            <Button variant="outline" onClick={discardAndLeave}>
              Discard and close
            </Button>
            <DisabledReasonButton
              onClick={saveAndLeave}
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
