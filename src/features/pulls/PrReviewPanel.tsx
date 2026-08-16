import {
  ClockIcon,
  CopyIcon,
  NotePencilIcon,
  RobotIcon,
  ShieldCheckIcon,
  SparkleIcon,
  WarningIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, m } from "motion/react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ElapsedTime } from "@/components/elapsed-time";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { Markdown } from "@/components/ui/markdown";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { detectAgentCli, providerKind } from "@/lib/ai/agent";
import { LOGIN_COMMAND } from "@/lib/ai/cli-client";
import { buildAiCommentBody } from "@/lib/ai/comment-branding";
import { useAvailableModels } from "@/lib/ai/models";
import {
  defaultModelForProvider,
  PROVIDER_LABELS,
  PROVIDERS_REQUIRING_KEY,
} from "@/lib/ai/providers";
import type { AiProviderId, ReviewMode } from "@/lib/ai/types";
import { copyText } from "@/lib/clipboard";
import { quickTransition } from "@/lib/motion";
import {
  useExternalReviews,
  useReviewerNotes,
  useReviewHistory,
} from "@/lib/pulls/queries";
import {
  getLatestPartialReview,
  type PersistedReview,
  partialReviewReason,
  reviewPartialKey,
} from "@/lib/pulls/reviews-history";
import { useSecretPreview, useSettings } from "@/lib/settings/queries";
import { useConfirm } from "@/lib/stores/confirm";
import {
  type ReviewContext,
  type ReviewTarget,
  useReviewRun,
} from "@/lib/stores/reviews";
import { useUiStore } from "@/lib/stores/ui";
import { formatDuration, validEpochMs } from "@/lib/time";
import { ReviewHistory } from "./ReviewHistory";
import { ThoughtsDisclosure } from "./ThoughtsDisclosure";

/** Pre-run note shown when a re-run's "changes since" delta couldn't be used. */
const DELTA_NOTE: Partial<Record<string, string>> = {
  rewritten:
    "History was rewritten since the last review — re-reviewing the full diff.",
  indeterminate:
    "Previous version not available locally — re-reviewing the full diff.",
  "head-unchanged":
    "Head unchanged; the base branch may have moved — re-reviewing the full diff.",
};

const PROVIDER_IDS = Object.keys(PROVIDER_LABELS) as AiProviderId[];

/** A stored review's findings text. The plugin-store JSON is untrusted (a
 *  hand-edited `pr-reviews.json` reaches here verbatim), so a non-string `text` reads
 *  as no text instead of throwing mid-render. */
const reviewText = (r: PersistedReview): string =>
  typeof r.text === "string" ? r.text : "";

export function PrReviewPanel({
  context,
  prKind,
  prRef,
  prNoun = "PR",
  onPost,
  posting,
  stale = false,
}: {
  context: ReviewContext;
  /** Whether this PR is a GitHub PR or a local-only one. */
  prKind: "remote" | "local";
  /** Remote PR number (as a string) or local PR id — identifies the run. */
  prRef: string;
  /** The change-request noun for idle copy ("PR" / "merge request"). Defaults to
   *  "PR" (local PRs / commit reviews). */
  prNoun?: string;
  onPost?: (body: string, opts?: { asBot?: boolean }) => void | Promise<void>;
  posting?: boolean;
  /** The caller is still rendering a previously selected PR, so `context` describes
   *  that one while the run would persist under this `prRef` — holds the run. */
  stale?: boolean;
}) {
  const settings = useSettings();
  const repoName = useUiStore((s) => s.repoName) ?? "";
  // The review run is keyed by repo + lens + PR so it survives this panel
  // unmounting; memoized so its identity is stable across the panel's many
  // re-renders.
  const target = useMemo<ReviewTarget>(
    () => ({
      kind: prKind,
      repoPath: context.repoPath,
      repoName,
      lens: context.lens,
      ref: prRef,
    }),
    [prKind, context.repoPath, repoName, context.lens, prRef],
  );
  const {
    generate,
    cancel,
    reset,
    dismissQueued,
    queuedMode,
    generating,
    text,
    status,
    mode,
    model,
    deltaState,
    truncatedCoverage,
    phase,
    error,
    thoughts,
    startedAt,
    endedAt,
  } = useReviewRun(target);

  // Prior reviews for this PR, used for the per-mode context banner. Read-only —
  // never creates a record, so a first-ever review is unaffected.
  const history = useReviewHistory(
    context.repoPath,
    context.lens,
    prKind,
    prRef,
  );
  const latestByMode = useMemo(() => {
    const out: Partial<Record<ReviewMode, PersistedReview>> = {};
    // The list is newest-first, so the first hit per mode is the latest. Skip
    // empty-text records (trimmed to nothing) — the run feeds them no context,
    // so the banner shouldn't claim it'll "build on" them.
    for (const r of history.data ?? []) {
      if (reviewText(r).trim() && out[r.mode] == null) out[r.mode] = r;
    }
    return out;
  }, [history.data]);
  // The output a failed/timed-out run left behind. The live run store is memory-only,
  // so this is the only copy after a restart; it's shown solely when nothing newer
  // completed, so a finished review always wins the surface.
  const partialRun = useQuery({
    queryKey: reviewPartialKey(context.repoPath, context.lens, prKind, prRef),
    queryFn: () =>
      getLatestPartialReview(context.repoPath, context.lens, prKind, prRef),
  });
  const keptPartial = useMemo(() => {
    const record = partialRun.data;
    // History pending (undefined) withholds it rather than guessing: showing kept
    // output that a since-completed review supersedes, then yanking it, reads as a flash.
    if (
      !record ||
      !reviewText(record).trim() ||
      !validEpochMs(record.finishedAt) ||
      !history.data
    )
      return undefined;
    return record.finishedAt > (history.data[0]?.finishedAt ?? 0)
      ? record
      : undefined;
  }, [partialRun.data, history.data]);
  // Which modes the next run should ignore the prior review for — derived from
  // the clicked button's mode, never the shared store entry (avoids mislabeling).
  const [ignoredModes, setIgnoredModes] = useState<Set<ReviewMode>>(new Set());
  function toggleIgnore(m: ReviewMode) {
    setIgnoredModes((cur) => {
      const next = new Set(cur);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      return next;
    });
  }

  // Third-party AI reviews (Copilot/CodeRabbit/…) posted on this remote PR, for
  // the "build on external reviews" banner. The run re-fetches them itself; this
  // only drives the banner + the opt-out. Remote PRs only.
  const external = useExternalReviews(context.repoPath, prKind, prRef);
  const externalReviewers = external.data?.reviewers ?? [];
  const externalCount = external.data?.items.length ?? 0;
  const [ignoreExternal, setIgnoreExternal] = useState(false);

  // The author's "Notes for reviewers" on this remote PR (author-gated in the
  // resolver). The run re-resolves them itself; this only drives the row + its
  // per-run opt-out. No notes (or a local/Bitbucket PR) ⇒ the row stays hidden.
  const notes = useReviewerNotes(context.repoPath, prKind, prRef);
  const hasNotes = Boolean(notes.data?.reviewNotes?.trim());
  const [ignoreNotes, setIgnoreNotes] = useState(false);

  const globalReviewAi = settings.data?.reviewAi;
  // Optional dedicated config for security audits (Settings → AI). When set and
  // no in-panel override is active, the Security-audit button runs it; the
  // general Review button always uses `globalReviewAi`.
  const securityReviewAi = settings.data?.securityReviewAi;
  // The provider/model picked in this panel is a per-run OVERRIDE — it changes
  // the model used for THIS review without rewriting the global default (set in
  // Settings → AI). Resets to the default when the panel remounts (e.g. a
  // different PR), so a one-off model choice never leaks into every future review.
  const [reviewOverride, setReviewOverride] = useState<NonNullable<
    typeof globalReviewAi
  > | null>(null);
  // Remembers the model picked for each provider across in-panel provider
  // switches (like Settings → AI's `modelMemory`), so flipping provider to
  // compare and back doesn't discard a choice. A ref, so it resets on remount
  // alongside `reviewOverride` — a one-off choice never leaks past this panel.
  const modelMemory = useRef<Partial<Record<AiProviderId, string>>>({});
  const reviewAi = reviewOverride ?? globalReviewAi;
  const provider = reviewAi?.provider ?? "anthropic";
  const needsKey = PROVIDERS_REQUIRING_KEY.includes(provider);
  const keyPreview = useSecretPreview(provider);
  const cliKind = providerKind(provider);
  const cliDetect = useQuery({
    queryKey: ["agent-detect", provider, reviewAi?.cliPath ?? ""],
    queryFn: () => detectAgentCli(cliKind!, reviewAi?.cliPath),
    enabled: Boolean(cliKind),
    staleTime: 60_000,
  });
  // Viewing a PR expresses no model-config intent, so the provider catalog is
  // fetched only once the user reaches the picker — sticky, so the list stays put
  // for the rest of the panel's life.
  const [modelsWanted, setModelsWanted] = useState(false);
  const available = useAvailableModels(
    reviewAi ?? {
      provider,
      model: "",
      ollamaBaseUrl: "",
      openaiCompatibleBaseUrl: "",
    },
    Boolean(keyPreview.data),
    undefined,
    { enabled: modelsWanted },
  );
  const models = available.data?.models ?? [];

  // Readiness signaling for the DEDICATED security model. The Security-audit
  // button routes to `securityReviewAi` exactly when there's no in-panel override
  // and one is configured (`securityPathActive` — the same condition that shows
  // the "Security audits use …" hint) — so when that config needs a key / CLI the
  // user hasn't set up, warn about IT specifically instead of letting the audit
  // die into the generic error state. Two distinct trigger cases:
  //  • `providerDiffers` — the security provider differs from the picker's active
  //    one, so it may need its OWN key or CLI (all three warnings apply).
  //  • `cliPathDiffers` — SAME provider (a CLI one) but a different `cliPath`, so
  //    the audit could point at a missing/unauthed binary the picker's warnings
  //    (keyed off the picker's path) never see (only the CLI warnings apply — a
  //    shared provider shares its key, so no key warning here).
  // When neither holds, the picker's own warnings above already cover the case, so
  // nothing extra renders. Hooks run every render (React rules); the render gates +
  // query `enabled` keep them cheap when the security path doesn't apply.
  const securityPathActive = !reviewOverride && Boolean(securityReviewAi);
  const secProvider = securityReviewAi?.provider ?? "anthropic";
  const secCliKind = providerKind(secProvider);
  const providerDiffers =
    securityPathActive && securityReviewAi?.provider !== provider;
  const cliPathDiffers =
    securityPathActive &&
    !providerDiffers &&
    Boolean(secCliKind) &&
    (securityReviewAi?.cliPath ?? "") !== (reviewAi?.cliPath ?? "");
  const secNeedsKey = PROVIDERS_REQUIRING_KEY.includes(secProvider);
  // Dedupes to the picker's own useSecretPreview(provider) at :174 when the
  // security path doesn't apply or shares the provider (same provider-keyed cache
  // entry, zero extra fetch); read only under `providerDiffers`, where the
  // argument is `secProvider`.
  const secKeyPreview = useSecretPreview(
    providerDiffers ? secProvider : provider,
  );
  const secCliDetect = useQuery({
    queryKey: ["agent-detect", secProvider, securityReviewAi?.cliPath ?? ""],
    queryFn: () => detectAgentCli(secCliKind!, securityReviewAi?.cliPath),
    enabled: Boolean(secCliKind) && (providerDiffers || cliPathDiffers),
    staleTime: 60_000,
  });

  function updateReview(patch: Partial<NonNullable<typeof reviewAi>>) {
    if (!reviewAi) return;
    setReviewOverride({ ...reviewAi, ...patch });
  }

  function run(mode: ReviewMode) {
    if (stale) return;
    // An explicit in-panel pick wins for BOTH buttons; untouched, a security
    // audit uses the dedicated `securityReviewAi` when configured, and every
    // other mode uses the global review model.
    const effective =
      reviewOverride ??
      (mode === "security" && securityReviewAi
        ? securityReviewAi
        : globalReviewAi);
    if (!effective) return;
    // `ai_review_triggered` is emitted in startReview when the run actually begins
    // (so it counts a drained queued run and skips a dismissed one), not here.
    generate(effective, mode, context, {
      ignorePrior: ignoredModes.has(mode),
      ignoreExternal,
      // Only suppress the notes while the toggle is actually ON SCREEN: the row
      // hides when the query refetches into an error/empty result, and a stale
      // `ignoreNotes` would then keep skipping them with no affordance to undo.
      ignoreNotes: ignoreNotes && hasNotes,
    });
  }

  async function post() {
    if (!onPost || !text.trim() || posting || stale) return;
    // A failed OR cancelled run keeps whatever streamed before it stopped, and that
    // partial text stays postable — publishing an unfinished review is consequential,
    // so confirm first, naming which way the run ended.
    if (phase === "error" || phase === "cancelled") {
      const ok = await useConfirm.getState().ask({
        title: "Post partial review?",
        body:
          phase === "cancelled"
            ? "This run was cancelled before it finished, so the text may be incomplete. Post it as a comment anyway?"
            : "This run failed before completing, so the text may be incomplete. Post it as a comment anyway?",
        confirmLabel: "Post anyway",
      });
      if (!ok) return;
    }
    const label = mode === "security" ? "security audit" : "review";
    const body = buildAiCommentBody({
      kind: label,
      model: model || reviewAi?.model || "model",
      automated: false,
      text,
    });
    try {
      await onPost(body, { asBot: true });
      reset();
      toast.success("Review posted to the conversation");
    } catch {
      // The caller surfaces the error; keep the text so it isn't lost.
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 border-b p-3">
        {/* DOM capture, not Base UI event props. Pointer-down is load-bearing:
            WebKit doesn't focus buttons on click, and the Select moves focus into
            a portalled popup outside this container. */}
        <div
          className="grid grid-cols-2 gap-2"
          onFocusCapture={() => setModelsWanted(true)}
          onPointerDownCapture={() => setModelsWanted(true)}
        >
          <Select
            items={PROVIDER_LABELS}
            value={provider}
            onValueChange={(v) => {
              if (!v || !reviewAi) return;
              const next = v as AiProviderId;
              modelMemory.current[provider] = reviewAi.model;
              updateReview({
                provider: next,
                model:
                  modelMemory.current[next] ?? defaultModelForProvider(next),
              });
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROVIDER_IDS.map((id) => (
                <SelectItem key={id} value={id}>
                  {PROVIDER_LABELS[id]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Combobox
            items={models}
            inputValue={reviewAi?.model ?? ""}
            onInputValueChange={(v) => updateReview({ model: v })}
            value={
              reviewAi && models.includes(reviewAi.model)
                ? reviewAi.model
                : null
            }
            onValueChange={(v) => v && updateReview({ model: v })}
            openOnInputClick
          >
            <ComboboxInput
              className="w-full"
              placeholder={
                defaultModelForProvider(provider) || "Account default"
              }
            />
            <ComboboxContent>
              {/* `isFetching`, never `isPending` — a catalog that was never
                  requested must not read as loading. */}
              <ComboboxEmpty>
                {available.isFetching
                  ? "Loading models…"
                  : "Uses the typed id as-is"}
              </ComboboxEmpty>
              <ComboboxList>
                {(item: string) => (
                  <ComboboxItem key={item} value={item}>
                    <span className="truncate font-mono">{item}</span>
                  </ComboboxItem>
                )}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
        </div>
        {reviewOverride && (
          <p className="text-xs text-muted-foreground">
            Model set for this review only — the default lives in Settings → AI.
          </p>
        )}
        {!reviewOverride &&
          securityReviewAi &&
          globalReviewAi &&
          (securityReviewAi.provider !== globalReviewAi.provider ||
            securityReviewAi.model !== globalReviewAi.model) && (
            <p className="text-xs text-muted-foreground">
              Security audits use {PROVIDER_LABELS[securityReviewAi.provider]} ·{" "}
              {securityReviewAi.model || "default model"} — set in Settings →
              AI.
            </p>
          )}
        {needsKey && !keyPreview.data && (
          <p className="text-xs text-warning">
            No {PROVIDER_LABELS[provider]} API key saved — add one in Settings
            to run a review.
          </p>
        )}
        {cliKind && cliDetect.data && !cliDetect.data.found && (
          <p className="text-xs text-warning">
            {PROVIDER_LABELS[provider]} not found — install it or set its path
            in Settings.
          </p>
        )}
        {cliKind &&
          cliDetect.data?.found &&
          cliDetect.data.authed === "notAuthed" && (
            <p className="text-xs text-warning">
              {PROVIDER_LABELS[provider]} is installed but not signed in — run{" "}
              <code className="font-mono">{LOGIN_COMMAND[cliKind]}</code> in a
              terminal.
            </p>
          )}
        {providerDiffers && secNeedsKey && !secKeyPreview.data && (
          <p className="text-xs text-warning">
            No {PROVIDER_LABELS[secProvider]} API key saved — add one in
            Settings to run a security audit.
          </p>
        )}
        {(providerDiffers || cliPathDiffers) &&
          secCliKind &&
          secCliDetect.data &&
          !secCliDetect.data.found && (
            <p className="text-xs text-warning">
              {PROVIDER_LABELS[secProvider]} not found — install it or set its
              path in Settings; security audits use it.
            </p>
          )}
        {(providerDiffers || cliPathDiffers) &&
          secCliKind &&
          secCliDetect.data?.found &&
          secCliDetect.data.authed === "notAuthed" && (
            <p className="text-xs text-warning">
              {PROVIDER_LABELS[secProvider]} is installed but not signed in —
              run <code className="font-mono">{LOGIN_COMMAND[secCliKind]}</code>{" "}
              in a terminal to run a security audit.
            </p>
          )}
        <div className="flex flex-wrap items-center gap-2">
          <AnimatePresence mode="wait" initial={false}>
            {generating ? (
              <m.div
                key="cancel"
                className="flex flex-wrap items-center gap-2"
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={quickTransition}
              >
                <Button variant="outline" size="sm" onClick={cancel}>
                  <XIcon data-icon="inline-start" />
                  Cancel
                </Button>
                {/* Queued runs have no startedAt yet — Cancel shows alone until
                    the run is actually running. */}
                {startedAt != null && (
                  <ElapsedTime
                    since={startedAt}
                    className="text-xs text-muted-foreground"
                  />
                )}
                {/* Queue the OTHER mode to run next — one output surface, so it
                    starts when this run finishes. Hidden once something's queued
                    (only two modes exist). */}
                {!queuedMode && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={stale}
                    onClick={() =>
                      run(mode === "security" ? "general" : "security")
                    }
                  >
                    {mode === "security" ? (
                      <SparkleIcon data-icon="inline-start" />
                    ) : (
                      <ShieldCheckIcon data-icon="inline-start" />
                    )}
                    Queue {mode === "security" ? "review" : "security audit"}
                  </Button>
                )}
              </m.div>
            ) : (
              <m.div
                key="run"
                className="flex items-center gap-2"
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={quickTransition}
              >
                <Button
                  size="sm"
                  disabled={stale}
                  onClick={() => run("general")}
                >
                  <SparkleIcon data-icon="inline-start" />
                  Review
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={stale}
                  onClick={() => run("security")}
                >
                  <ShieldCheckIcon data-icon="inline-start" />
                  Security audit
                </Button>
              </m.div>
            )}
          </AnimatePresence>
          {text.trim() && !generating && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => copyText(text, "Review copied")}
            >
              <CopyIcon data-icon="inline-start" />
              Copy
            </Button>
          )}
          {onPost && text.trim() && !generating && (
            <Button
              variant="ghost"
              size="sm"
              disabled={posting || stale}
              onClick={post}
            >
              {posting && <Spinner data-icon="inline-start" />}
              Post as comment
            </Button>
          )}
          {phase === "done" &&
            text.trim() &&
            !generating &&
            startedAt != null &&
            endedAt != null &&
            endedAt > startedAt && (
              <span className="text-xs text-muted-foreground">
                took {formatDuration(endedAt - startedAt)}
              </span>
            )}
        </div>
        {queuedMode && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <ClockIcon className="size-3 shrink-0" />
            <span className="min-w-0">
              {queuedMode === "security" ? "Security audit" : "Review"} queued —
              runs when the {mode === "security" ? "security audit" : "review"}{" "}
              finishes.
            </span>
            <button
              type="button"
              className="cursor-pointer underline-offset-2 hover:underline"
              onClick={dismissQueued}
            >
              Dismiss
            </button>
          </div>
        )}
        {(["general", "security"] as ReviewMode[]).map((m) => {
          const prior = latestByMode[m];
          if (!prior) return null;
          const ignored = ignoredModes.has(m);
          const label = m === "security" ? "security audit" : "review";
          return (
            <div
              key={m}
              className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground"
            >
              <SparkleIcon className="size-3 shrink-0" />
              <span className="min-w-0">
                {ignored ? (
                  `Next ${label} starts fresh, ignoring your previous one.`
                ) : validEpochMs(prior.finishedAt) ? (
                  <>
                    {`Next ${label} builds on your last (`}
                    <RelativeTime
                      date={new Date(prior.finishedAt).toISOString()}
                    />
                    {")."}
                  </>
                ) : (
                  // A corrupt persisted stamp would throw in `toISOString` —
                  // drop the parenthetical, never the sentence.
                  `Next ${label} builds on your last.`
                )}
              </span>
              <button
                type="button"
                aria-pressed={ignored}
                disabled={generating}
                className="cursor-pointer underline-offset-2 hover:underline disabled:opacity-50"
                onClick={() => toggleIgnore(m)}
              >
                {ignored ? "Use previous review" : "Ignore previous review"}
              </button>
            </div>
          );
        })}
        {hasNotes && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <NotePencilIcon className="size-3 shrink-0" />
            <span className="min-w-0">
              {ignoreNotes
                ? "Ignoring the author's notes for reviewers."
                : "Next review reads the author's notes for reviewers."}
            </span>
            <button
              type="button"
              aria-pressed={ignoreNotes}
              disabled={generating}
              className="cursor-pointer underline-offset-2 hover:underline disabled:opacity-50"
              onClick={() => setIgnoreNotes((v) => !v)}
            >
              {ignoreNotes ? "Use author notes" : "Ignore author notes"}
            </button>
          </div>
        )}
        {externalCount > 0 && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <RobotIcon className="size-3 shrink-0" />
            <span className="min-w-0">
              {ignoreExternal
                ? `Ignoring ${externalCount} finding${externalCount === 1 ? "" : "s"} from ${externalReviewers.join(", ")}.`
                : `Next review weighs ${externalCount} finding${externalCount === 1 ? "" : "s"} from ${externalReviewers.join(", ")} as context.`}
            </span>
            <button
              type="button"
              aria-pressed={ignoreExternal}
              disabled={generating}
              className="cursor-pointer underline-offset-2 hover:underline disabled:opacity-50"
              onClick={() => setIgnoreExternal((v) => !v)}
            >
              {ignoreExternal
                ? "Use external reviews"
                : "Ignore external reviews"}
            </button>
          </div>
        )}
        {cliKind !== "codex" && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              size="sm"
              checked={Boolean(reviewAi?.cliRepoAware)}
              onCheckedChange={(checked) =>
                updateReview({ cliRepoAware: checked })
              }
              disabled={generating}
            />
            Agentic review — read repo files and query the PR with GitDesktop
            tools (slower, deeper)
          </label>
        )}
        {cliKind === "codex" && (
          <p className="text-xs text-muted-foreground">
            Codex reads repo files for context (read-only sandbox).
          </p>
        )}
        {/* The last run saw a truncated diff with no tools to compensate. Every
            non-codex provider is now upgradable in place — the tool-capable CLIs
            (claude/opencode/copilot) and all HTTP providers (null cliKind) gain
            the same agentic explore capability. Codex (already repo-aware) and
            an already-agentic run set the flag false, so they never reach here —
            but the guards hold anyway. */}
        {truncatedCoverage &&
          !generating &&
          cliKind !== "codex" &&
          !reviewAi?.cliRepoAware && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              <WarningIcon className="size-3 shrink-0" />
              <span className="min-w-0">
                This review saw a truncated diff — agentic review lets it read
                the full changes.
              </span>
              <button
                type="button"
                className="cursor-pointer underline-offset-2 hover:underline"
                onClick={() => updateReview({ cliRepoAware: true })}
              >
                Enable agentic review
              </button>
            </div>
          )}
        <ReviewHistory
          repoPath={context.repoPath}
          lens={context.lens}
          prKind={prKind}
          prRef={prRef}
        />
      </div>

      {/* ph-no-capture: AI review output quotes the user's code — block from replay.
          overflow-hidden contains the content's natural height (vendored Root is
          `relative`-only) so long review output can't leak a window scrollbar. */}
      <ScrollArea className="ph-no-capture min-h-0 flex-1 overflow-hidden">
        <div className="p-4">
          {deltaState &&
            DELTA_NOTE[deltaState] &&
            (text.trim() || generating) && (
              <p className="mb-3 flex items-center gap-1.5 text-xs text-warning">
                <WarningIcon className="size-3.5 shrink-0" />
                {DELTA_NOTE[deltaState]}
              </p>
            )}
          {phase === "error" ? (
            <div className="space-y-2">
              <p className="flex items-start gap-1.5 text-xs text-destructive">
                <WarningIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {error || "The review failed. Check the model and try again."}
                </span>
              </p>
              {/* Keep any partial output that streamed before it failed. */}
              {text.trim() && <Markdown>{text}</Markdown>}
            </div>
          ) : text.trim() ? (
            <>
              <Markdown>{text}</Markdown>
              {thoughts.trim() && <ThoughtsDisclosure thoughts={thoughts} />}
            </>
          ) : generating ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3" />
              {status || "Starting review…"}
            </p>
          ) : keptPartial ? (
            <div className="space-y-2">
              <p className="flex items-start gap-1.5 text-xs text-warning">
                <ClockIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {partialReviewReason(keptPartial).timedOut
                    ? "Timed out"
                    : "Stopped early"}{" "}
                  — partial output kept. Run it again for a full review.
                </span>
              </p>
              <Markdown>{reviewText(keptPartial)}</Markdown>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Run a general review or a security audit of this {prNoun}'s
              changes with the selected model. The result appears here and isn't
              shared unless you post it.
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
