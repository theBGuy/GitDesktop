import {
  CopyIcon,
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
import { buildAiCommentBody } from "@/lib/ai/comment-branding";
import { useAvailableModels } from "@/lib/ai/models";
import {
  defaultModelForProvider,
  PROVIDER_LABELS,
  PROVIDERS_REQUIRING_KEY,
} from "@/lib/ai/providers";
import type { AiProviderId, ReviewMode } from "@/lib/ai/types";
import { track } from "@/lib/analytics";
import { copyText } from "@/lib/clipboard";
import { quickTransition } from "@/lib/motion";
import { useExternalReviews, useReviewHistory } from "@/lib/pulls/queries";
import type { PersistedReview } from "@/lib/pulls/reviews-history";
import { useSecretPreview, useSettings } from "@/lib/settings/queries";
import {
  type ReviewContext,
  type ReviewTarget,
  useReviewRun,
} from "@/lib/stores/reviews";
import { useUiStore } from "@/lib/stores/ui";
import { formatRelativeTime } from "@/lib/time";
import { ReviewHistory } from "./ReviewHistory";

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

export function PrReviewPanel({
  context,
  prKind,
  prRef,
  prNoun = "PR",
  onPost,
  posting,
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
}) {
  const settings = useSettings();
  const repoName = useUiStore((s) => s.repoName) ?? "";
  // The review run is keyed by repo + PR so it survives this panel unmounting;
  // memoized so its identity is stable across the panel's many re-renders.
  const target = useMemo<ReviewTarget>(
    () => ({
      kind: prKind,
      repoPath: context.repoPath,
      repoName,
      ref: prRef,
    }),
    [prKind, context.repoPath, repoName, prRef],
  );
  const {
    generate,
    cancel,
    reset,
    generating,
    text,
    status,
    mode,
    model,
    deltaState,
    truncatedCoverage,
    phase,
    error,
  } = useReviewRun(target);

  // Prior reviews for this PR, used for the per-mode context banner. Read-only —
  // never creates a record, so a first-ever review is unaffected.
  const history = useReviewHistory(context.repoPath, prKind, prRef);
  const latestByMode = useMemo(() => {
    const out: Partial<Record<ReviewMode, PersistedReview>> = {};
    // The list is newest-first, so the first hit per mode is the latest. Skip
    // empty-text records (trimmed to nothing) — the run feeds them no context,
    // so the banner shouldn't claim it'll "build on" them.
    for (const r of history.data ?? []) {
      if (r.text.trim() && out[r.mode] == null) out[r.mode] = r;
    }
    return out;
  }, [history.data]);
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

  const globalReviewAi = settings.data?.reviewAi;
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
  const available = useAvailableModels(
    reviewAi ?? {
      provider,
      model: "",
      ollamaBaseUrl: "",
      openaiCompatibleBaseUrl: "",
    },
    Boolean(keyPreview.data),
  );
  const models = available.data?.models ?? [];

  function updateReview(patch: Partial<NonNullable<typeof reviewAi>>) {
    if (!reviewAi) return;
    setReviewOverride({ ...reviewAi, ...patch });
  }

  function run(mode: ReviewMode) {
    if (!reviewAi) return;
    generate(reviewAi, mode, context, ignoredModes.has(mode), ignoreExternal);
    const model = reviewAi.model.toLowerCase();
    const model_tier =
      model.includes("haiku") ||
      model.includes("mini") ||
      model.includes("flash")
        ? "fast"
        : model.includes("opus") ||
            model.includes("gpt-4o") ||
            model.includes("sonnet-4")
          ? "powerful"
          : reviewAi.provider === "ollama"
            ? "local"
            : "balanced";
    track({
      name: "ai_review_triggered",
      properties: { provider: reviewAi.provider, model_tier },
    });
  }

  async function post() {
    if (!onPost || !text.trim() || posting) return;
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
        <div className="grid grid-cols-2 gap-2">
          <Select
            value={provider}
            onValueChange={(v) => {
              if (!v || !reviewAi) return;
              const next = v as AiProviderId;
              modelMemory.current[provider] = reviewAi.model;
              updateReview({
                provider: next,
                model: modelMemory.current[next] ?? defaultModelForProvider(next),
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
              placeholder={defaultModelForProvider(provider) || "Account default"}
            />
            <ComboboxContent>
              <ComboboxEmpty>Uses the typed id as-is</ComboboxEmpty>
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
              <code className="font-mono">
                {cliKind === "copilot"
                  ? "copilot login"
                  : cliKind === "codex"
                    ? "codex login"
                    : cliKind === "opencode"
                      ? "opencode auth login"
                      : "claude login"}
              </code>{" "}
              in a terminal.
            </p>
          )}
        <div className="flex flex-wrap items-center gap-2">
          <AnimatePresence mode="wait" initial={false}>
            {generating ? (
              <m.div
                key="cancel"
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={quickTransition}
              >
                <Button variant="outline" size="sm" onClick={cancel}>
                  <XIcon data-icon="inline-start" />
                  Cancel
                </Button>
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
                <Button size="sm" onClick={() => run("general")}>
                  <SparkleIcon data-icon="inline-start" />
                  Review
                </Button>
                <Button
                  variant="outline"
                  size="sm"
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
            <Button variant="ghost" size="sm" disabled={posting} onClick={post}>
              {posting && <Spinner data-icon="inline-start" />}
              Post as comment
            </Button>
          )}
        </div>
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
                {ignored
                  ? `Next ${label} starts fresh, ignoring your previous one.`
                  : `Next ${label} builds on your last (${formatRelativeTime(
                      new Date(prior.finishedAt).toISOString(),
                    )}).`}
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
        {(cliKind === "claude" ||
          cliKind === "opencode" ||
          cliKind === "copilot") && (
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
        {/* The last run saw a truncated diff with no tools to compensate. A
            tool-capable CLI (not codex) with repo-aware OFF can be upgraded in
            place; an HTTP provider (null cliKind) gets an informational hint
            only. Codex (already repo-aware) and an already-agentic run set the
            flag false, so they never reach here — but the guards hold anyway. */}
        {truncatedCoverage &&
          !generating &&
          cliKind !== "codex" &&
          !reviewAi?.cliRepoAware && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              <WarningIcon className="size-3 shrink-0" />
              {cliKind === "claude" ||
              cliKind === "opencode" ||
              cliKind === "copilot" ? (
                <>
                  <span className="min-w-0">
                    This review saw a truncated diff — agentic review lets it
                    read the full changes.
                  </span>
                  <button
                    type="button"
                    className="cursor-pointer underline-offset-2 hover:underline"
                    onClick={() => updateReview({ cliRepoAware: true })}
                  >
                    Enable agentic review
                  </button>
                </>
              ) : (
                <span className="min-w-0">
                  This review saw a truncated diff. A CLI agent review model can
                  explore the full PR.
                </span>
              )}
            </div>
          )}
        <ReviewHistory
          repoPath={context.repoPath}
          prKind={prKind}
          prRef={prRef}
        />
      </div>

      {/* ph-no-capture: AI review output quotes the user's code — block from replay. */}
      <ScrollArea className="ph-no-capture min-h-0 flex-1">
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
            <Markdown>{text}</Markdown>
          ) : generating ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3" />
              {status || "Starting review…"}
            </p>
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
