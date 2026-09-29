import { generateText, Output } from "ai";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { useAiStream } from "@/features/conversations/useAiStream";
import { resolveModel } from "@/lib/ai/client";
import { aiExcludePatterns } from "@/lib/ai/ignore";
import {
  buildPrLabelFallbackPrompt,
  buildPrPrompt,
  extractPrDraft,
  needsStructuredLabelPick,
} from "@/lib/ai/prompt";
import { isCliProvider } from "@/lib/ai/providers";
import type { AiSettings, PromptProvider } from "@/lib/ai/types";
import { gitBranchDiff, readRepoInstructions } from "@/lib/git/api";
import type { AppSettings } from "@/lib/settings/api";

/** Raw diff bytes requested from the backend; prompt budgeting trims further. */
const RAW_DIFF_MAX_BYTES = 200_000;

/** Most labels the structured pick may add. Enforced here rather than as a schema
 *  `maxItems`, which not every provider's structured-output mode accepts. */
const STRUCTURED_PICK_MAX_LABELS = 3;

/** The diff shape a supplier must yield — matches `buildPrPrompt`'s `files`. */
interface SuppliedDiff {
  text: string;
  truncated: boolean;
  files: { path: string; added: number; deleted: number; isBinary: boolean }[];
  /** Changed files the user's AI-ignore patterns hid. Every supplier applies the
   *  patterns; absent or `0` ⇒ nothing was hidden to disclose. */
  excludedFiles?: number;
}

/** A repo label the model may propose from — name plus its stated purpose. The
 *  description is threaded into the prompt; the parser validates on name only. */
interface AvailableLabel {
  name: string;
  description?: string | null;
}

/** A validated real issue the model may link (fed as a grounded candidate). The
 *  parser validates a proposed link's number against this set. */
interface IssueCandidate {
  number: number;
  title: string;
  state: string;
}

/** A mention-only Jira candidate from the repo's linked project (Bitbucket
 *  repos). The parser validates a proposed `Relates:` key against this set. */
interface JiraCandidate {
  key: string;
  summary: string;
  statusCategory: string;
}

/** The parsed draft streamed to `onUpdate` — title/body plus the validated
 *  labels, the model's proposed `Closes:` / `Relates:` issue numbers, and any
 *  validated linked-Jira mention keys. */
interface PrDraft {
  title: string;
  body: string;
  labels: string[];
  /** Label names the model proposed that the repo doesn't have. Only meaningful
   *  on the RESOLVED draft — a mid-stream chunk can hold a half-typed name. */
  droppedLabels: string[];
  closes: number[];
  relates: number[];
  jiraMentions: string[];
  /** RESOLVED draft only: labels the structured label pick added after the stream
   *  ended. No `onUpdate` carries them, so a caller that proposes labels merges
   *  these itself. */
  pickedLabels?: string[];
}

/** One structured-output call choosing labels for a finished draft, from its title
 *  and body only, on the model the draft was written with. The schema's enum keeps
 *  the answer inside the repo's set; names still validate case-insensitively into
 *  the repo's casing, as the text path does. Throws on any provider failure. */
async function pickLabelsStructured(
  ai: AiSettings,
  draft: { title: string; body: string },
  availableLabels: AvailableLabel[],
  abortSignal: AbortSignal,
): Promise<string[]> {
  const canonical = new Map<string, string>();
  for (const l of availableLabels) {
    const name = l.name.trim();
    if (name && !canonical.has(name.toLowerCase()))
      canonical.set(name.toLowerCase(), name);
  }
  const names = [...canonical.values()];
  if (names.length === 0) return [];
  const { system, prompt } = buildPrLabelFallbackPrompt({
    title: draft.title,
    body: draft.body,
    availableLabels,
  });
  const result = await generateText({
    model: await resolveModel(ai),
    system,
    prompt,
    abortSignal,
    output: Output.object({
      schema: z.object({ labels: z.array(z.enum(names)) }),
    }),
  });
  const picked: string[] = [];
  for (const raw of result.output.labels) {
    const match = canonical.get(raw.trim().toLowerCase());
    if (match && !picked.includes(match)) picked.push(match);
  }
  return picked.slice(0, STRUCTURED_PICK_MAX_LABELS);
}

/**
 * Streams an AI-written PR title + body from the branch diff and the commits
 * the PR would introduce. `onUpdate` fires with the parsed draft on each chunk.
 */
export function useGeneratePrDescription(repoPath: string) {
  const {
    generating: streaming,
    cancel: cancelStream,
    run,
  } = useAiStream(repoPath);
  // The structured label pick runs after the stream ends but belongs to the same
  // run: it keeps `generating` true, and Cancel reaches it, so no surface can start
  // a second run or settle this one while the pick is still out.
  const [pickingLabels, setPickingLabels] = useState(false);
  const pickAbortRef = useRef<AbortController | null>(null);
  const generating = streaming || pickingLabels;
  const cancel = useCallback(() => {
    cancelStream();
    pickAbortRef.current?.abort();
  }, [cancelStream]);

  /** Shared streaming core: gets the diff from `getDiff` (handed the loaded
   *  settings, so a supplier can honor the user's AI-ignore patterns), budgets
   *  it into a PR prompt, and streams the parsed title/body/labels draft to
   *  `onUpdate`. `availableLabels` are the repo's existing label names the model
   *  may propose from (validated in the parser — invented labels are dropped).
   *
   *  Resolves with the draft parsed from the COMPLETE response, or null when the
   *  run bailed, aborted, or errored — the only signal that tells a completed
   *  draft from the partial parses `onUpdate` sees mid-stream. A draft with no
   *  `Labels` line at all gets one best-effort structured label pick first
   *  (`needsStructuredLabelPick`); labels it finds ride ONLY the resolved draft's
   *  `pickedLabels`, never another `onUpdate` (which would re-send a title and body
   *  the user may have edited meanwhile), and any failure or cancel leaves the
   *  draft as the stream wrote it. */
  const runFromDiff = useCallback(
    async (
      getDiff: (settings: AppSettings) => Promise<SuppliedDiff>,
      base: string,
      head: string,
      commitSubjects: string[],
      onUpdate: (draft: PrDraft) => void,
      availableLabels: AvailableLabel[],
      provider?: PromptProvider,
      /** Author's "Notes for reviewers" — reflected into the description. */
      reviewNotes?: string,
      /** Validated real issues the model may link (grounded candidates). Empty ⇒
       *  no issue links proposed. */
      issueCandidates?: IssueCandidate[],
      /** Mention-only Jira candidates (Bitbucket repos with a linked project).
       *  Empty ⇒ no Jira mentions proposed. Mutually exclusive with
       *  `issueCandidates` — `buildPrPrompt` gives natives precedence. */
      jiraCandidates?: JiraCandidate[],
      /** Which set of changes the "nothing to describe" toasts name; the
       *  change-request noun follows `provider` (GitLab: merge request). */
      emptyScope: "branch-diff" | "change-request" = "branch-diff",
    ): Promise<PrDraft | null> => {
      const parse = (buffer: string) =>
        extractPrDraft(
          buffer,
          availableLabels.map((l) => l.name),
          (issueCandidates ?? []).map((c) => c.number),
          (jiraCandidates ?? []).map((c) => c.key),
        );
      // The settings this run loaded, so the label pick uses the same model.
      const loaded: { ai?: AiSettings } = {};
      const final = await run(
        async (settings) => {
          loaded.ai = settings.ai;
          const [diff, repoInstructions] = await Promise.all([
            getDiff(settings),
            readRepoInstructions(repoPath),
          ]);
          if (diff.files.length === 0) {
            const scope =
              emptyScope === "change-request"
                ? `in this ${provider === "gitlab" ? "merge request" : "pull request"}`
                : "between these branches";
            toast.error(
              (diff.excludedFiles ?? 0) > 0
                ? `All changes ${scope} match your AI ignore patterns — nothing to describe.`
                : `No changes ${scope} to describe.`,
            );
            return null;
          }
          return buildPrPrompt({
            diffText: diff.text,
            diffTruncated: diff.truncated,
            files: diff.files,
            excludedFiles: diff.excludedFiles,
            commitSubjects,
            baseBranch: base,
            headBranch: head,
            repoInstructions,
            globalInstructions: settings.globalInstructions,
            reviewNotes,
            availableLabels,
            issueCandidates,
            jiraCandidates,
            provider,
          });
        },
        { onChunk: (buffer) => onUpdate(parse(buffer)) },
      );
      if (final === null) return null;
      const draft = parse(final);
      const ai = loaded.ai;
      if (
        !ai ||
        !needsStructuredLabelPick(
          draft,
          availableLabels.map((l) => l.name),
          isCliProvider(ai.provider),
        )
      )
        return draft;
      // Raised before any await, so it batches with the stream's flag clearing
      // rather than leaving a render where `generating` reads false mid-run.
      const abort = new AbortController();
      pickAbortRef.current = abort;
      setPickingLabels(true);
      try {
        const labels = await pickLabelsStructured(
          ai,
          draft,
          availableLabels,
          abort.signal,
        );
        if (labels.length === 0 || abort.signal.aborted) return draft;
        return { ...draft, labels, pickedLabels: labels };
      } catch {
        return draft;
      } finally {
        if (pickAbortRef.current === abort) pickAbortRef.current = null;
        setPickingLabels(false);
      }
    },
    [repoPath, run],
  );

  /** Branch-diff path (Create dialogs + local PRs): resolves the diff from the
   *  local `base..head` refs. Head must exist locally. */
  const generate = useCallback(
    (
      base: string,
      head: string,
      commitSubjects: string[],
      onUpdate: (draft: PrDraft) => void,
      /** Target host — swaps the change-request noun + markdown flavor in the
       *  prompt. Omit (local PRs) to keep the base GitHub wording. */
      provider?: PromptProvider,
      /** The repo's existing labels (name + description) to propose from. Empty ⇒
       *  no labels proposed. Invented labels the model returns are dropped by the
       *  parser (which validates on name only). */
      availableLabels: AvailableLabel[] = [],
      /** Author's "Notes for reviewers" — reflected into the description. */
      reviewNotes?: string,
      /** Validated real issues the model may link (grounded candidates). */
      issueCandidates?: IssueCandidate[],
      /** Mention-only Jira candidates (Bitbucket + linked project). */
      jiraCandidates?: JiraCandidate[],
    ) =>
      runFromDiff(
        async (settings) => {
          const exclude = await aiExcludePatterns(
            repoPath,
            settings.aiIgnorePatterns,
          );
          return gitBranchDiff(
            repoPath,
            base,
            head,
            RAW_DIFF_MAX_BYTES,
            exclude,
          );
        },
        base,
        head,
        commitSubjects,
        onUpdate,
        availableLabels,
        provider,
        reviewNotes,
        issueCandidates,
        jiraCandidates,
      ),
    [repoPath, runFromDiff],
  );

  /** Explicit-supplier path (remote PRs): the caller provides the diff — e.g. an
   *  existing PR's own diff query — so it works even when the head branch isn't
   *  present locally (fork PRs, unfetched branches). The supplier is handed the
   *  loaded settings so it can apply the user's AI-ignore patterns itself. */
  const generateFromDiff = useCallback(
    (
      getDiff: (settings: AppSettings) => Promise<SuppliedDiff>,
      base: string,
      head: string,
      commitSubjects: string[],
      onUpdate: (draft: PrDraft) => void,
      provider?: PromptProvider,
      /** The repo's existing labels (name + description) to propose from. Empty ⇒
       *  no labels proposed. Invented labels the model returns are dropped by the
       *  parser (which validates on name only). */
      availableLabels: AvailableLabel[] = [],
      /** Author's "Notes for reviewers" — reflected into the description. */
      reviewNotes?: string,
      /** Validated real issues the model may link (grounded candidates). */
      issueCandidates?: IssueCandidate[],
      /** Mention-only Jira candidates (Bitbucket + linked project). */
      jiraCandidates?: JiraCandidate[],
    ) =>
      runFromDiff(
        getDiff,
        base,
        head,
        commitSubjects,
        onUpdate,
        availableLabels,
        provider,
        reviewNotes,
        issueCandidates,
        jiraCandidates,
        "change-request",
      ),
    [runFromDiff],
  );

  return { generate, generateFromDiff, cancel, generating };
}
