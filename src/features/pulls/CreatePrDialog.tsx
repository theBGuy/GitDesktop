import { Popover } from "@base-ui/react/popover";
import {
  ArrowSquareOutIcon,
  SparkleIcon,
  TagIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { DIALOG_SCROLL } from "@/components/dialog-scroll";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { LabelChip } from "@/features/conversations/Thread";
import { useFinishAndSurface } from "@/features/conversations/useAiStream";
import { AssigneesPopover } from "@/features/issues/IssueMetaPickers";
import { REVIEWER_NOTES_MARKER } from "@/lib/ai/notes-context";
import { track } from "@/lib/analytics";
import { triggerAutomations } from "@/lib/automations/runner";
import { required, useAppForm } from "@/lib/form";
import * as api from "@/lib/git/api";
import {
  forgeFeatureReady,
  useAddRemote,
  useBranchAhead,
  useCreatePr,
  useDefaultBranch,
  useForgeStatus,
  usePrsForBranch,
  useRepoLabels,
  useRepoStatus,
} from "@/lib/git/queries";
import {
  type ForgeUserRef,
  type PrInfo,
  providerLabel,
  type RemoteLens,
} from "@/lib/git/types";
import { SUBMIT_HINT } from "@/lib/hotkeys/binding";
import { useGenerateChord } from "@/lib/hotkeys/useGenerateChord";
import { useJiraLink } from "@/lib/jira/queries";
import {
  applyRepoLens,
  useLensGate,
  useRemoteSlug,
} from "@/lib/repo-lens/queries";
import { deleteReviewNote } from "@/lib/review-notes/store";
import { useAiEnabled, useSettings } from "@/lib/settings/queries";
import { repoNameFromPath } from "@/lib/stores/notifications";
import {
  consumeLastFailed,
  markPrCreated,
  type PrCreate,
  prCreatePhase,
  prCreateStartedAt,
  settlePrCreate,
  startPrCreate,
  usePrCreates,
} from "@/lib/stores/pr-create";
import { armPrCreateHandOff } from "@/lib/stores/pr-create-handoff";
import { useUiStore } from "@/lib/stores/ui";
import { errorMessage } from "@/lib/tauri/invoke";
import { toastError, toastErrorWithNote } from "@/lib/toast";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import { cn } from "@/lib/utils";
import { LinkedIssuesField } from "./LinkedIssuesField";
import { ReviewerNotesField } from "./ReviewerNotesField";
import { ReviewersPopover } from "./ReviewersPopover";
import { useBranchPickerOptions } from "./useBranchPickerOptions";
import { useGeneratePrDescription } from "./useGeneratePrDescription";
import {
  composeBodyWithJiraRefs,
  composeBodyWithRefs,
  useJiraMentionChips,
  useLinkedIssueChips,
} from "./useLinkedIssueChips";

/** The hint for label names the model proposed that the repo doesn't have:
 *  `Suggested label "x" isn't a repo label.`, plural `"a", "b" and "c"`.
 *  Callers pass at least one name. */
function droppedLabelsHint(names: string[]): string {
  const quoted = names.map((n) => `"${n}"`);
  if (quoted.length === 1)
    return `Suggested label ${quoted[0]} isn't a repo label.`;
  const list = `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
  return `Suggested labels ${list} aren't repo labels.`;
}

/** Why the submit is held, per lane phase: the lane now survives the forge's
 *  answer for the seconds the list takes to catch up, and a reopen in that
 *  window must read as "it's done" rather than "still going". */
const LANE_HINT: {
  [P in PrCreate["phase"]]: (lane: Extract<PrCreate, { phase: P }>) => string;
} = {
  creating: (lane) =>
    `A ${lane.noun} for this branch is already being created.`,
  created: (lane) =>
    `A ${lane.noun} for this branch was just created — #${lane.number}.`,
};

function laneHintFor(lane: PrCreate): string {
  return lane.phase === "created"
    ? LANE_HINT.created(lane)
    : LANE_HINT.creating(lane);
}

/** The open PR a create into `base` would duplicate. The probe already keys on the
 *  head, so only the base and the lens rule remain: the origin path skips
 *  cross-repository rows for the same reason ComparePanel does — an origin-pinned
 *  probe can only reach them via a contributor's same-named fork branch — while on
 *  the upstream lens your own fork→parent duplicate IS cross-repository (that arm
 *  reports the flag false for every row today, so the qualifier guards the future). */
function duplicateOf(
  prs: PrInfo[] | undefined,
  base: string,
  lens: RemoteLens,
): PrInfo | undefined {
  return (prs ?? []).find(
    (p) =>
      p.baseRefName === base && (lens === "upstream" || !p.crossRepository),
  );
}

export function CreatePrDialog({
  repoPath,
  defaultBase,
  defaultHead,
  open,
  onOpenChange,
}: {
  repoPath: string;
  /** Seeds the base ("into") branch; defaults to the repo's default branch. */
  defaultBase?: string;
  /** Seeds the head ("merge") branch; defaults to the current branch. */
  defaultHead?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const status = useRepoStatus(repoPath);
  const defaultBranch = useDefaultBranch(repoPath);
  const createPr = useCreatePr(repoPath);
  const forge = useForgeStatus(repoPath);
  const queryClient = useQueryClient();

  // Fork PR-create: on a GitHub fork (upstream remote present) the dialog offers an
  // explicit "Create in" target — the parent (lens "upstream") or the fork
  // ("origin"); hidden entirely otherwise. Default = parent, matching what gh's
  // implicit auto-resolution used to pick for the common contribution flow.
  const lensGate = useLensGate(repoPath);
  const [target, setTarget] = useState<RemoteLens>("upstream");
  // Resolved slugs label the two target buttons and the success toast; only
  // fetched while the picker is shown.
  const forkSlug = useRemoteSlug(repoPath, "origin", lensGate && open);
  const upstreamSlug = useRemoteSlug(repoPath, "upstream", lensGate && open);
  const targetIsParent = lensGate && target === "upstream";
  // The effective lens for this create — always "origin" when the gate is off.
  const createLens: RemoteLens = targetIsParent ? "upstream" : "origin";
  const targetSlug = targetIsParent ? upstreamSlug : forkSlug;

  // Fork without an `upstream` remote (plain `git clone`): the lens gate is off and
  // the pinned origin path would silently open the PR on the fork. When the persisted
  // fork provenance says this GitHub repo IS a fork with a known parent, offer to add
  // the remote so the parent-target path returns.
  const settings = useSettings();
  const isGithub = forge.data?.provider === "github";
  const forkRecord = settings.data?.recentRepos.find(
    (r) => r.path === repoPath,
  );
  const forkParent = forkRecord?.forkParent ?? null;
  // Only when: GitHub, the lens gate is OFF (no upstream remote), settings have
  // loaded (no flash), the repo is a fork, AND the parent slug is known. A fork
  // whose parent is unreadable renders nothing rather than a broken hint.
  const canOfferUpstream =
    isGithub &&
    !lensGate &&
    settings.isSuccess &&
    forkRecord?.isFork === true &&
    forkParent !== null;
  const addRemote = useAddRemote(repoPath);
  // Awaited rather than per-call callbacks: this dialog can close (Esc, ✕,
  // backdrop) mid-write, and react-query drops those once the observer has no
  // listeners. On success the broad invalidation refreshes remotes →
  // `useLensGate` flips true → the "Create in" picker appears (default Parent).
  async function addUpstreamRemote() {
    if (!forkParent) return;
    // Derive the host — on GitHub Enterprise `isGithub` still holds, and a
    // hardcoded github.com would add a wrong-host remote that fails later.
    const ghHost = forge.data?.host || "github.com";
    try {
      await addRemote.mutateAsync({
        name: "upstream",
        url: `https://${ghHost}/${forkParent}.git`,
      });
    } catch (e) {
      toastError(e);
    }
  }

  // Create-TIME reviewers stay Bitbucket-only: `forge_pr_create` rejects a reviewer
  // list for GitHub/GitLab. The `mrReviewers` capability covers all three but only
  // for EDITING reviewers on an existing PR, so scope the create dialog explicitly.
  // Targeting the parent rejects reviewers/labels/assignees backend-side, so those
  // pickers are hidden on that path (never offered as dead controls).
  const canPickReviewers =
    !targetIsParent &&
    forge.data?.provider === "bitbucket" &&
    forgeFeatureReady(forge.data, "mrReviewers");
  // Labels + assignees are GitHub/GitLab; a repo is exactly one provider, so
  // these and the Bitbucket create-time reviewers picker are mutually exclusive.
  const canPickLabels =
    !targetIsParent && forgeFeatureReady(forge.data, "mrLabels");
  const canPickAssignees =
    !targetIsParent && forgeFeatureReady(forge.data, "mrAssignees");
  const [reviewers, setReviewers] = useState<ForgeUserRef[]>([]);
  const [labels, setLabels] = useState<Set<string>>(new Set());
  const [assignees, setAssignees] = useState<ForgeUserRef[]>([]);
  // Label names a FINISHED generation proposed that the repo doesn't have — only
  // ever set from the resolved draft, since a mid-stream chunk can hold a
  // half-streamed name that would flash as a mismatch.
  const [droppedLabels, setDroppedLabels] = useState<string[]>([]);

  // Linked issues: repo issues referenced on create (extraction-seeded, AI-proposed
  // or manual). They become `Closes #N`/`Relates to #N` body LINES, not create-
  // mutation params — so unlike labels they work on the PARENT path too. Gated only
  // on a usable tracker, not `aiEnabled` (Hide-AI still shows the cluster).
  const canLinkIssues = !!forge.data && forgeFeatureReady(forge.data, "issues");
  // Bitbucket repos have no native tracker (`canLinkIssues` is false), so a
  // LINKED Jira project drives a mention-only cluster instead. Mutually exclusive
  // with the native cluster — only ever one in the dialog.
  const jiraLink = useJiraLink(repoPath);
  const canJiraMention =
    !canLinkIssues && forge.data?.provider === "bitbucket" && !!jiraLink.data;
  // Group-label ids: these fields wrap trigger-style widgets (segmented buttons
  // and popover triggers) that carry their own aria-label, so the visible field
  // label names the surrounding group via aria-labelledby rather than htmlFor.
  const createInGroupId = useId();
  const creatingHintId = useId();
  const reviewersGroupId = useId();
  const assigneesGroupId = useId();
  // Labels come from whichever repo the PR targets (parent's own labels when
  // creating upstream). The picker is hidden on the parent path anyway, but the
  // AI-description prompt still reads this list, so keep it lens-correct.
  const repoLabels = useRepoLabels(repoPath, open, createLens);
  const isGitLab = forge.data?.provider === "gitlab";
  const remoteLabel = providerLabel(forge.data?.provider);
  const prNoun = isGitLab ? "merge request" : "pull request";
  const { generate, cancel, generating } = useGeneratePrDescription(repoPath);
  const aiEnabled = useAiEnabled();
  // Closing mid-generation never cancels the run: it finishes into the retained
  // form state, and this surfaces the result while the dialog is away. Both
  // hosts pass a plain open setter, so `onOpenChange(true)` reopens.
  const surface = useFinishAndSurface(repoPath, open, {
    cancel,
    generating,
    close: () => onOpenChange(false),
    readyTitle: isGitLab
      ? "Merge request description ready"
      : "Pull request description ready",
    readyDescription: "It's waiting in the dialog.",
    reopen: () => onOpenChange(true),
  });
  const aiDescriptionRef = useRef(false);
  // Whether THIS mount has seeded, so the skip below can tell a reopen (form
  // state may hold a draft the user typed) from a fresh mount (it cannot).
  const seededRef = useRef(false);
  // Which repo the retained draft belongs to — the repo whose seed last wrote
  // the form. The dialog is retained across a repo switch (the host re-renders
  // it with a new `repoPath`), so this is what tells a reopen here from a
  // reopen holding the previous repo's draft. Both sides are the ui store's own
  // string, so `===` is the identity test.
  const draftRepoRef = useRef<string | null>(null);
  // Counts drafts, not opens: bumped only where the seed actually resets the
  // form, so a reopen that skips the seed keeps the number its submit captured.
  const seedGenRef = useRef(0);

  const currentName = status.data?.branch?.name ?? null;
  // Branch options with per-branch worktree chips; drops the app-internal
  // `gd/session/*` branches (submitting one would even PUSH it) and archived
  // branches, the same rules as BranchSwitcher. `keep` retains the seeded
  // defaults even if archived, so the head/base defaults stay selectable.
  const { names, items, annotations } = useBranchPickerOptions(repoPath, open, [
    currentName,
    defaultHead,
    defaultBase,
    defaultBranch.data,
  ]);

  // Base options for the parent target: fetch `upstream` (like
  // useUpdateFromUpstream), then read the local upstream refs and the parent's
  // default branch. A failed fetch still yields whatever upstream refs are
  // already local, so the picker stays usable — the error surfaces inline.
  const parentBranches = useQuery({
    queryKey: ["repo", repoPath, "create-pr-parent-branches"] as const,
    queryFn: async () => {
      let fetchError: string | null = null;
      try {
        await api.gitFetchRemote(repoPath, "upstream");
      } catch (e) {
        // Keep going with the refs already on disk; report the fetch failure.
        fetchError = errorMessage(e);
      }
      const remoteBranches = await api.gitRemoteBranches(repoPath);
      const upstreamNames = remoteBranches
        .filter((b) => b.remote === "upstream")
        .map((b) => b.name);
      let defaultBase = "";
      try {
        defaultBase = await api.gitRemoteDefaultBranch(repoPath, "upstream");
      } catch {
        // Fall back to the first upstream ref below; the picker stays usable.
      }
      return { names: upstreamNames, defaultBase, fetchError };
    },
    enabled: open && targetIsParent,
    staleTime: 30_000,
  });
  const parentNames = parentBranches.data?.names ?? [];
  const parentItems = Object.fromEntries(parentNames.map((n) => [n, n]));
  const parentFetchError = parentBranches.data?.fetchError ?? null;
  const parentBase = parentBranches.data?.defaultBase || parentNames[0] || "";

  const baseItems = targetIsParent ? parentItems : items;
  const baseAnnotations = targetIsParent ? undefined : annotations;
  const baseLoading = targetIsParent && parentBranches.isPending;

  const form = useAppForm({
    defaultValues: {
      head: "",
      base: "",
      title: "",
      body: "",
      // Seed from the setting so a user who defaults new PRs to draft opens
      // pre-ticked; undefined-safe. The reset() on open re-applies it.
      draft: settings.data?.createPrsAsDraft ?? false,
      notes: "",
    },
    validators: {
      // Same branch on both sides proposes nothing — gate the submit. On the
      // parent target the base is an `upstream/<name>` ref, so a local head that
      // merely shares the parent branch's *name* is still a distinct ref and is
      // allowed; the real ref-identity check lives in `sameBranch` below.
      onChange: ({ value }) =>
        !targetIsParent && value.head === value.base
          ? "Pick two different branches."
          : undefined,
    },
    onSubmit: async ({ value }) => {
      // This submit belongs to the repo it fired in: the form's options are
      // re-applied every render, so `repoPath` here is pinned to that repo while
      // the retained dialog goes on serving whichever one is on screen. Every
      // write to GLOBAL state past an await asks this first.
      const stillHere = () => useUiStore.getState().repoPath === repoPath;
      const submitGen = seedGenRef.current;
      // The probe speaks only for duplicates it has FRESHLY seen: a submit during
      // its first fetch, or on a page cached before the PR was opened on the forge,
      // would push a head the forge then refuses. One awaited re-check closes that
      // window and lands in the probe's own cache, so the View offer appears with
      // the refusal. Freezing the identity controls for the submit is what keeps
      // the await from moving the target; the guards below are the backstop.
      if (!probeFresh) {
        // `cancelRefetch: false` joins an in-flight fetch instead of restarting it.
        const recheck = await branchPrs.refetch({ cancelRefetch: false });
        // This await is the flow's only pre-create window, and the hosts feed
        // this dialog the store's repoPath in place: a repo switch across it
        // retargets both observers, so the verdict below would describe the new
        // repo and the create would open there. Abort before the lane claim, so
        // an aborted submit owns nothing. Silent — the user navigated away.
        if (useUiStore.getState().repoPath !== repoPath) return;
        // The head select stays live across the await and is a probe KEY axis, so
        // changing it retargets the observer and `recheck` then describes a head
        // this submit isn't creating. `form.state` is a live getter on the stable
        // form, unlike the render-snapshot `head`. Like a probe error, a moved
        // head drops the verdict rather than refusing: the forge is the duplicate
        // authority and the lane guard below still covers in-app attempts.
        const sameHead = form.state.values.head === value.head;
        const duplicate =
          recheck.isError || !sameHead
            ? undefined
            : duplicateOf(recheck.data, value.base, createLens);
        if (duplicate) {
          toast.error(
            `A ${prNoun} for this branch already exists — #${duplicate.number}.`,
            {
              description: duplicate.url,
              action: { label: "View", onClick: () => openUrl(duplicate.url) },
            },
          );
          return;
        }
      }
      // Fire-time admission, claimed before the create's first await: the push
      // plus the forge call runs for minutes and the user can dismiss the dialog
      // the moment it starts, so a second attempt on the same head would queue
      // on the repo lock and then open a duplicate PR.
      const refusal = startPrCreate(repoPath, value.head, value.base, {
        // The trimmed spelling is what the mutation sends below, so the strip
        // shows the title the PR will actually carry.
        title: value.title.trim(),
        draft: value.draft,
        lens: createLens,
        noun: prNoun,
      });
      if (refusal) {
        toast.error(refusal);
        return;
      }
      let outcome: "success" | "error" = "error";
      // Hoisted so the `finally` can arm the hand-off for a PR that exists even
      // when a step after it threw.
      let created: { number: number; url: string } | null = null;
      try {
        // Append the linked-issue chips as their exact keyword lines via the shared
        // composer (the single ref-block composition used by every create/edit save
        // path) — the forge does the real linking/auto-closing on merge. On a
        // Bitbucket repo with a Jira link the mention chips compose `Relates to KEY`
        // lines instead (the two clusters are mutually exclusive).
        const finalBody =
          canJiraMention && jiraChips.length > 0
            ? composeBodyWithJiraRefs(value.body, jiraChips)
            : composeBodyWithRefs(value.body, linkedIssues);
        const { number, url } = await createPr.mutateAsync({
          base: value.base,
          // Head stays a bare LOCAL branch name either way: the backend pushes it
          // to origin and composes the `owner:branch` head ref itself on the
          // upstream path. Org-owned forks aren't supported by `gh pr create`
          // ("Using an organization as the <user> is currently not supported",
          // cli/cli#10093) — we don't pre-gate; gh's own error surfaces via
          // toastError below.
          head: value.head,
          title: value.title.trim(),
          body: finalBody,
          draft: value.draft,
          // Targets the fork ("origin") or its parent ("upstream"); the parent path
          // rejects reviewers/labels/assignees backend-side, so those keys are
          // omitted there.
          lens: createLens,
          // Bitbucket-only; omit the key otherwise (GitHub/GitLab byte-identical).
          // An empty selection also omits it, preserving server-side default reviewers.
          ...(canPickReviewers && reviewers.length > 0
            ? { reviewers: reviewers.map((r) => r.id) }
            : {}),
          // GitHub/GitLab only; omit the key (and for empty selections) so the
          // backend leaves create behavior untouched.
          ...(canPickLabels && labels.size > 0 ? { labels: [...labels] } : {}),
          ...(canPickAssignees && assignees.length > 0
            ? { assignees: assignees.map((a) => a.id) }
            : {}),
        });
        outcome = "success";
        created = { number, url };
        // Flip here, arm in the `finally`: the lane outlives the forge's answer,
        // so the strip needs the number now, while the steps below still run.
        markPrCreated(repoPath, value.head, { number, url });
        const notes = value.notes.trim();
        track({
          name: "pull_request_created",
          properties: {
            is_draft: value.draft,
            has_ai_description: aiDescriptionRef.current,
            has_review_notes: notes.length > 0,
          },
        });
        // Reviewer notes are an AI-only surface (the field renders only when AI
        // is enabled), so the whole post + consume is gated on `aiEnabled` —
        // Hide-AI must post nothing and consume no deposit (no behavior change).
        if (aiEnabled) {
          // Post the author's reviewer notes as the FIRST comment, BEFORE the review
          // fires — the automated review reads the conversation, so ordering is the
          // whole point. `asBot: false` (the user's own content). Its own try/catch:
          // a failed post must not abort the create — the review still gets the notes
          // via the `reviewNotes` event below.
          if (notes) {
            try {
              await api.forgePrComment(
                repoPath,
                number,
                `${REVIEWER_NOTES_MARKER}\n\n${notes}`,
                false,
                createLens,
              );
              // Mirror runner.ts's post-comment invalidation: narrow to this
              // PR's own key family under the lens it landed on.
              await queryClient.invalidateQueries({
                queryKey: ["repo", repoPath, "pr", createLens, number],
              });
            } catch {
              // Fires wherever the user is by then, so it names the repo it
              // belongs to when that isn't the one on screen.
              toast.error("PR created — posting reviewer notes failed.", {
                description: stillHere()
                  ? undefined
                  : `In ${repoNameFromPath(repoPath)}`,
              });
            }
          }
          // Consume the deposit regardless of whether the comment posted — the
          // create itself consumed the note. Best-effort; app-data, not the PR.
          void deleteReviewNote(repoPath, value.head).catch(() => undefined);
        }
        // Creating on the parent means the PR lives under the upstream lens — flip
        // the persisted lens so the PRs tab shows it (no-op when already "upstream").
        // The disk write and the cache write are this repo's own and land whatever
        // is on screen; the interaction epoch and the selection clears are GLOBAL,
        // so off-screen they would cancel the live repo's in-flight navigation and
        // drop its selected pull request instead. Noted before the apply, as
        // `useSetRepoLens` does: a settling navigation would otherwise land its
        // lens over this one.
        if (createLens === "upstream") {
          const live = stillHere();
          if (live) useUiStore.getState().noteUserInteraction();
          applyRepoLens(queryClient, repoPath, "upstream", {
            clearSelections: live,
            persist: true,
          });
        }
        // Where it landed: the target slug for a fork contribution, else the
        // repository itself once this settles somewhere the user no longer is.
        // The slug arm is the narrow one — both remote reads behind it are gated
        // on the fork lens, so a plain repo never resolves one.
        const landedIn =
          targetSlug || (stillHere() ? null : repoNameFromPath(repoPath));
        toast.success(
          `Opened ${prNoun} #${number}${landedIn ? ` in ${landedIn}` : ""}`,
          {
            description: url,
            action: { label: "View", onClick: () => openUrl(url) },
          },
        );
        // This dialog is panel-hosted under <Activity>, so the success path must
        // only close — never setRepoTab/selectPr, which would conceal this panel
        // mid-close and defer the close and unmount until it is next shown. Want
        // navigation? Hoist it to RepositoryView first, like CreateLocalPrDialog.
        // `open` is the host's ONE state across repos (a switch already closed
        // this dialog), so a close landing off-screen would shut whatever the
        // user has open where they are now. The generation is what `stillHere`
        // cannot see: a round trip away and back reseeds the form in THIS repo,
        // and closing then would shut the dialog holding that newer draft.
        if (stillHere() && seedGenRef.current === submitGen)
          onOpenChange(false);
        // Draft gate: a draft PR fires no review unless the user opted into reviewing
        // drafts. A gated-out draft is NOT a lost review — an in-app Mark-ready fires
        // pr-open directly, and an EXTERNAL ready flip rides the catch-up poller's
        // 14-day window. Don't "fix" this by dropping the gate.
        const reviewDraftPrs = settings.data?.reviewDraftPrs ?? false;
        if (!value.draft || reviewDraftPrs) {
          triggerAutomations({
            kind: "pr-open",
            repoPath,
            base: value.base,
            head: value.head,
            // `ahead` (git log) is newest-first, so the head is the first entry.
            headSha: ahead[0]?.hash,
            title: value.title.trim(),
            body: finalBody,
            commitSubjects: ahead.map((c) => c.subject),
            target: { type: "remote", number },
            reviewNotes: notes || undefined,
          });
        }
      } catch (e) {
        // Name the branch when the CREATE is what failed: two creates can be
        // stacked, and a bare forge error doesn't say which one died. A throw
        // from a step after the PR exists keeps the bare toast — that PR was
        // created, whatever followed it. Unconditional, guard or no guard: the
        // failure happened, so a landing in another repo names the one it
        // belongs to rather than going unsaid.
        const away = stillHere() ? null : repoNameFromPath(repoPath);
        if (outcome === "error")
          toastErrorWithNote(
            e,
            away
              ? `In ${away}, the ${prNoun} for ${value.head} wasn't created.`
              : `The ${prNoun} for ${value.head} wasn't created.`,
          );
        else if (away) toastErrorWithNote(e, `In ${away}`);
        else toastError(e);
      } finally {
        // The lane is also the duplicate-create admission guard, so the watcher
        // arms only once this flow's last step is done — armed at the forge's
        // answer, a fast list refetch could settle it mid-continuation and a
        // remounted dialog would re-arm Create over a PR that already exists.
        // Armed with the entry's OWN startedAt: a fresh clock read would let
        // this watcher settle a later create that re-claimed the head.
        if (outcome === "error") {
          // "error" latches to protect the retained draft, so it has to still
          // have one: a seed for another repo, or this mount moving on to
          // another head, already destroyed it, and latching over that strands
          // an entry the next open for this pair would spend on nothing.
          // "release" frees the lane and leaves other mounts' latches standing.
          const draftAlive =
            draftRepoRef.current === repoPath &&
            form.state.values.head === value.head;
          settlePrCreate(
            repoPath,
            value.head,
            draftAlive ? "error" : "release",
          );
        } else if (created) {
          const startedAt = prCreateStartedAt(repoPath, value.head);
          if (startedAt !== null)
            armPrCreateHandOff(queryClient, {
              repoPath,
              head: value.head,
              lens: createLens,
              number: created.number,
              startedAt,
            });
        }
      }
    },
  });

  // Seed branches each time the dialog opens: head = current branch, base =
  // the default branch (or, when you're already on it, the first other branch).
  // keepDefaultValues: otherwise the per-render options sync clobbers the
  // seeded values back to empty on an untouched form.
  const seedOnOpen = useEffectEvent(() => {
    const h = defaultHead ?? currentName ?? names[0] ?? "";
    // What the form is holding, which is what the retire below is keyed on. On
    // a fresh mount the form holds its defaults, so this is just `h`.
    const retained = form.state.values.head || h;
    // A generation still streaming — or one that settled while the dialog was
    // closed — and a create still RUNNING in the background, or one that failed
    // while closed, all leave everything the user typed in form state, and this
    // reset would blank it on reopen. A lane in the `created` phase is the
    // opposite case: the PR shipped, so the submitted draft must not come back.
    // The draft's identity is the RETAINED form head, not this open's default:
    // the user may have submitted a head that differs from the branch they are
    // on now. The `||` short-circuit is deliberate — while a create is in flight
    // the failed-create latch stays unconsumed, so a reopen after a later
    // failure still preserves the draft. Both lane arms are gated on the draft
    // being THIS repo's: keyed on a head retained from the repo the user just
    // left, they would read this repo's lane and spend its latch whenever the
    // two repos share a branch name. `shouldSkipSeed` stays ungated — it owns
    // its own repo check, and a foreign open has to reach it to retire the AI
    // draft this seed is about to destroy.
    if (seededRef.current) {
      if (
        surface.shouldSkipSeed(generating) ||
        (draftRepoRef.current === repoPath &&
          (prCreatePhase(repoPath, retained) === "creating" ||
            consumeLastFailed(repoPath, retained)))
      )
        return;
    }
    // The reset below destroys the draft this mount was holding, so the latch
    // waiting on it goes with it — keyed to that draft's OWN repo, which is how
    // a latch stops outliving a repo switch. Keyed rather than blanket so the
    // Compare tab's mount keeps its own waiting latch, which holds while its
    // head differs from this one; on a shared head the two are one key and this
    // spends it, as they always have.
    consumeLastFailed(draftRepoRef.current ?? repoPath, retained);
    seededRef.current = true;
    draftRepoRef.current = repoPath;
    seedGenRef.current += 1;
    aiDescriptionRef.current = false;
    setReviewers([]);
    setLabels(new Set());
    setDroppedLabels([]);
    setAssignees([]);
    // Reset the linked-issue chips (and their dismissed/probed refs) — the create
    // dialog opens with no seeded body refs; extraction/AI seeding repopulates.
    resetLinkedIssues([]);
    // Same for the Jira mention cluster (Bitbucket + linked project).
    resetJiraChips([]);
    // Reset the target to the default (parent) every open, so a prior fork/parent
    // choice doesn't leak into the next PR.
    setTarget("upstream");
    const fallbackBase =
      defaultBranch.data && defaultBranch.data !== h
        ? defaultBranch.data
        : (names.find((n) => n !== h) ?? "");
    form.reset(
      {
        head: h,
        // Seed the LOCAL (fork) base first; the base-reconcile effect below
        // swaps in the parent's default branch when the parent target is active
        // (and its branches have loaded). A ComparePanel-seeded `defaultBase` is
        // a local branch, so it only applies to the fork target.
        base: defaultBase ?? fallbackBase,
        title: "",
        body: "",
        // Seed each open from the setting so the draft default reflects the current
        // preference, not a prior open's toggle.
        draft: settings.data?.createPrsAsDraft ?? false,
        // Cleared on open; ReviewerNotesField re-seeds from the head branch's
        // deposit (if any) once its query resolves.
        notes: "",
      },
      { keepDefaultValues: true },
    );
  });
  useSeedOnOpen(open, seedOnOpen);

  // Live head/base drive the "N commits" hint, AI generation, and submit gate.
  const head = useSelector(form.store, (s) => s.values.head);
  const base = useSelector(form.store, (s) => s.values.base);
  // Live notes feed the AI-description prompt (so a generated description can
  // reflect the reviewer notes) and the ReviewerNotesField's seeding provenance.
  const notes = useSelector(form.store, (s) => s.values.notes);
  const isSubmitting = useSelector(form.store, (s) => s.isSubmitting);
  // Why the identity controls freeze: they pick what the create targets, and the
  // push plus the forge call can run for minutes, so the picker reads as dead
  // without a reason. Null when idle, which is what re-enables the controls.
  const identityLockReason = isSubmitting
    ? `Creating the ${prNoun} — the target is locked until it finishes.`
    : null;
  // Survives this dialog closing, unlike `isSubmitting` — a create dismissed
  // mid-flight still owns the head branch until it settles, which is now the
  // whole catch-up window after the forge answers. The entry, not just a
  // boolean, so the hint below can name the number it already has.
  const lane = usePrCreates(repoPath).find((c) => c.head === head);
  // The RE-ENTRY case only. This submit claims the lane synchronously, so the
  // flag is also true during the user's own create — which `isSubmitting`
  // already covers, and where a "someone else is creating this" refusal would
  // be nonsense under a spinning button.
  const creatingElsewhere = lane !== undefined && !isSubmitting;
  const laneHint = lane && !isSubmitting ? laneHintFor(lane) : null;

  // Fork-side fallback base, mirroring the seed logic (default branch, else first
  // non-head) — reused when reconciling back from the parent target.
  const forkFallbackBase = useEffectEvent(() => {
    const h = form.state.values.head;
    return defaultBranch.data && defaultBranch.data !== h
      ? defaultBranch.data
      : (names.find((n) => n !== h) ?? "");
  });
  // Reconcile the base when the target changes (or the parent's branches arrive):
  // re-seed ONLY when the current base isn't a valid option for the active target, so
  // a user-picked base survives a target toggle where it still fits — this never
  // fights the user's own edit.
  useEffect(() => {
    if (!open) return;
    if (targetIsParent) {
      // Wait for the parent refs before touching the base — otherwise we'd clear
      // it to "" mid-fetch and lose the seed.
      if (parentBranches.isPending) return;
      if (!base || !parentNames.includes(base)) {
        form.setFieldValue("base", parentBase);
      }
    } else if (base && !names.includes(base)) {
      // Back on the fork target: re-seed only when the current value (e.g. a
      // parent branch that isn't a local one) no longer fits.
      form.setFieldValue("base", defaultBase ?? forkFallbackBase());
    }
  }, [
    open,
    targetIsParent,
    parentBranches.isPending,
    parentBase,
    base,
    parentNames,
    names,
    defaultBase,
    form,
  ]);
  // The base ref to compare against: on the parent target the picked base is a bare
  // upstream branch name, so qualify it `upstream/<base>` — otherwise
  // `git log main..head` resolves against a *local* `main`, a stale proxy for the
  // parent's branch. While the parent fetch is in flight `base` is still the
  // fork-seeded local name and `upstream/<name>` may not exist yet → yield null so
  // the compare query stays idle rather than erroring.
  const compareBaseRef =
    targetIsParent && parentBranches.isPending
      ? null
      : base
        ? targetIsParent
          ? `upstream/${base}`
          : base
        : null;
  const comparison = useBranchAhead(repoPath, compareBaseRef, head || null);
  const ahead = comparison.data ?? [];
  // A head equal to the parent's base name is still a distinct ref (local branch
  // vs. `upstream/<name>`), so only treat identical refs as "same branch".
  const sameBranch = compareBaseRef !== null && compareBaseRef === head;
  const nothingToMerge = sameBranch || ahead.length === 0;

  // Duplicate probe: an open PR from this head against the chosen target already
  // exists. Probe with the target's lens ("upstream" composes owner:branch
  // Rust-side; pass the BARE head).
  const branchPrs = usePrsForBranch(repoPath, head || null, open, createLens);
  const existingPr = duplicateOf(branchPrs.data, base, createLens);
  // Read here rather than in the submit handler, so the staleness that decides
  // whether submit re-checks is a tracked render input and refreshes on the
  // observer's own stale timer.
  const probeFresh = branchPrs.isSuccess && !branchPrs.isStale;

  // The one submit gate, shared by the button, the mod+enter chord, and the
  // form's native submit: Enter must submit exactly when the button would.
  // The `existingPr` arm blocks on whatever rows the probe last RESOLVED — stale
  // rows included, until their refetch clears them; a probe still awaiting its
  // first result never holds submit, and the handler re-checks the head once
  // before claiming the lane when freshness has lapsed. The gate itself stays
  // zero-latency.
  const submitBlocked =
    generating ||
    nothingToMerge ||
    baseLoading ||
    isSubmitting ||
    creatingElsewhere ||
    Boolean(existingPr);

  // Linked-issue chip cluster — extraction seeding, AI union, candidate ranking and
  // the chip mutations live in the shared hook. Gated on a usable tracker AND the
  // dialog being open; the parent target reads the parent's issues (createLens).
  const {
    chips: linkedIssues,
    resetWith: resetLinkedIssues,
    toggleKeyword: toggleIssueKeyword,
    remove: removeIssue,
    pick: pickIssue,
    buildCandidates: buildIssueCandidates,
    upsertFromDraft: upsertAiIssues,
  } = useLinkedIssueChips({
    repoPath,
    lens: createLens,
    enabled: open && canLinkIssues,
    headBranch: head || null,
    commitSubjects: ahead.map((c) => c.subject),
  });

  // Jira mention chips — the Bitbucket-only sibling cluster; composes
  // `Relates to KEY` lines, no keyword toggle.
  const {
    chips: jiraChips,
    resetWith: resetJiraChips,
    remove: removeJiraChip,
    pick: pickJiraChip,
    buildCandidates: buildJiraCandidates,
    upsertFromDraft: upsertAiJira,
  } = useJiraMentionChips({
    repoPath,
    enabled: open && canJiraMention,
    headBranch: head || null,
    commitSubjects: ahead.map((c) => c.subject),
    link: jiraLink.data ?? null,
  });

  function toggleLabel(name: string, on: boolean) {
    setLabels((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  }

  const selectedChips = (repoLabels.data ?? []).filter((l) =>
    labels.has(l.name),
  );

  // AI title+description generation — shared by the Generate button and the
  // dialog-local generate chord.
  function runGenerate() {
    setDroppedLabels([]);
    // Grounded issue candidates the model may link: current chips pinned first,
    // then the highest-scoring OPEN issues, capped at 8 (the hook records the set
    // it fed so `upsertAiIssues` can resolve an AI-proposed number's title/state).
    const issueCandidates = buildIssueCandidates();
    // Grounded Jira mention candidates (Bitbucket + linked project). Empty unless
    // the Jira cluster is active; mutually exclusive with `issueCandidates`.
    const jiraCandidates = canJiraMention ? buildJiraCandidates() : undefined;
    // The returned promise resolves with the COMPLETE draft (null on bail/abort/
    // error), which is what keeps the dropped-label hint off mid-stream partials.
    generate(
      base,
      head,
      ahead.map((c) => c.subject),
      (d) => {
        form.setFieldValue("title", d.title);
        form.setFieldValue("body", d.body);
        // Flagged on delivery, not on start: a run that writes nothing (bailed,
        // failed, aborted before the first chunk) leaves a hand-typed
        // description, and the reopen may skip the seed that would reset this.
        if (d.body.trim()) aiDescriptionRef.current = true;
        // Additive: union the model's (already repo-validated) labels with the
        // user's manual picks, never replace.
        setLabels((prev) => new Set([...prev, ...d.labels]));
        // Union the model's proposed issue links into the chip cluster (the hook
        // owns the relate-default / dismissed-set / AI-flag rules).
        upsertAiIssues({ closes: d.closes, relates: d.relates });
        // Union the model's proposed Jira mentions into the mention cluster.
        upsertAiJira({ jiraMentions: d.jiraMentions });
      },
      // Provider-aware prompt copy (MR/merge-request noun, markdown flavor);
      // null host → base GitHub wording.
      forge.data?.provider ?? undefined,
      // Existing repo labels (name + stated purpose) the model may propose from;
      // empty ⇒ no labels proposed.
      repoLabels.data?.map((l) => ({
        name: l.name,
        description: l.description,
      })) ?? [],
      // Author's reviewer notes — reflected into the generated description.
      notes.trim() || undefined,
      // Grounded issue candidates — empty ⇒ prompt's issue-reference ban intact.
      issueCandidates,
      // Grounded Jira mention candidates — empty/undefined ⇒ no Jira variant.
      jiraCandidates,
    ).then(
      (final) => {
        if (final) setDroppedLabels(final.droppedLabels);
        surface.noteRunSettled(final !== null);
      },
      // Two-arm, never a trailing .catch: a settle must be reported exactly
      // once, and a throw in the arm above must not report a second time.
      () => surface.noteRunSettled(false),
    );
  }
  // Context-sensitive reuse of the `generate-commit-message` binding while this
  // dialog is open. `run` is undefined with AI off — no Generate surface, so
  // the chord falls through instead of being swallowed for nothing.
  const generateChord = useGenerateChord({
    enabled: !generating && !nothingToMerge,
    run: aiEnabled ? runGenerate : undefined,
  });
  const generateHint = generateChord.hint;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] flex-col sm:max-w-2xl"
        // mod+enter submits from anywhere in the dialog. Captured on DialogContent
        // (the Popup), not the <form>: the X close button renders as a SIBLING of
        // the form inside the Popup, so a chord pressed with focus on X would bypass
        // a form-level handler and reach the global mod+enter action. ALWAYS swallow
        // the chord here; submit only under the same gates as the SubmitButton
        // (handleSubmit then enforces the field validators).
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            if (!submitBlocked) form.handleSubmit();
            return;
          }
          // The generate chord runs this dialog's own Generate while it's open.
          // While that Generate exists the chord is swallowed whenever it may
          // fire, enabled or not (the hook mirrors the global listener's own
          // guards), so no commit message is written behind the dialog. With
          // Hide-AI on there's no Generate here at all and the chord falls
          // through instead — harmless, because the same flag leaves
          // CommitBox's global handler DISABLED (the listener only ever runs an
          // enabled one), and off the Changes tab CommitBox is unmounted and
          // registers nothing.
          generateChord.onKeyDown(e);
        }}
      >
        <form
          className="flex min-h-0 min-w-0 flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (submitBlocked) return;
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Create {prNoun}</DialogTitle>
            <DialogDescription>
              Pushes <span className="font-mono">{head || "…"}</span> and opens
              a {prNoun} into <span className="font-mono">{base || "…"}</span>{" "}
              on {targetSlug ?? remoteLabel}.
            </DialogDescription>
          </DialogHeader>

          {/* Fields scroll; the header and submit footer stay pinned so a long
              body can't push the dialog off-screen. */}
          <div className={cn(DIALOG_SCROLL, "min-h-0 flex-1 space-y-4")}>
            {/* Fork PR-create: choose the repo the PR opens against. Hidden unless
                this is a GitHub fork with an upstream remote. Default = parent. */}
            {lensGate && (
              <div className="space-y-1.5">
                <Label id={createInGroupId}>Create in</Label>
                <div
                  className="flex items-center gap-1"
                  role="group"
                  aria-labelledby={createInGroupId}
                >
                  {(
                    [
                      {
                        value: "upstream",
                        label: "Parent",
                        slug: upstreamSlug,
                      },
                      { value: "origin", label: "Fork", slug: forkSlug },
                    ] as const
                  ).map((b) => (
                    <DisabledReasonButton
                      key={b.value}
                      type="button"
                      variant={target === b.value ? "secondary" : "ghost"}
                      size="xs"
                      aria-pressed={target === b.value}
                      title={b.slug ?? undefined}
                      // Frozen while a submit runs: this and the head select are
                      // the create's identity axes, and a submit awaits before it
                      // claims its lane, so a mid-flight change would retarget
                      // the duplicate probe away from what is being created.
                      disabled={isSubmitting}
                      reason={identityLockReason}
                      onClick={() => setTarget(b.value)}
                    >
                      {b.label}
                      {b.slug ? (
                        <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">
                          {b.slug}
                        </span>
                      ) : null}
                    </DisabledReasonButton>
                  ))}
                </div>
              </div>
            )}

            {/* Fork without an `upstream` remote: offer to add it. Mutually exclusive
                with the picker above (`canOfferUpstream` requires the gate OFF). */}
            {canOfferUpstream && (
              <div className="space-y-1.5 rounded-none bg-muted/40 p-2.5 ring-1 ring-foreground/10">
                <p className="text-xs text-muted-foreground">
                  This repository is a fork of{" "}
                  <span className="font-mono text-foreground/80">
                    {forkParent}
                  </span>
                  . Add an upstream remote to open pull requests against{" "}
                  <span className="font-mono text-foreground/80">
                    {forkParent}
                  </span>
                  .
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={addRemote.isPending}
                  onClick={() => void addUpstreamRemote()}
                >
                  {addRemote.isPending
                    ? "Adding upstream remote…"
                    : "Add upstream remote"}
                </Button>
              </div>
            )}

            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-initial">
                <form.AppField name="head">
                  {(field) => (
                    <field.SelectField
                      label="Merge"
                      items={items}
                      annotations={annotations}
                      // Frozen while a submit runs — see the "Create in" picker.
                      disabled={isSubmitting}
                      sizeToContent
                    />
                  )}
                </form.AppField>
              </div>
              <span className="shrink-0 pb-2 text-xs text-muted-foreground">
                into
              </span>
              <div className="min-w-0 flex-initial">
                <form.AppField name="base">
                  {(field) => (
                    <field.SelectField
                      label="Base"
                      items={baseLoading ? {} : baseItems}
                      annotations={baseAnnotations}
                      disabled={baseLoading}
                      sizeToContent
                    />
                  )}
                </form.AppField>
              </div>
            </div>
            <div className="space-y-0.5">
              <p className="font-mono text-xs wrap-break-word text-foreground/80">
                {head || "…"} <span className="text-muted-foreground">→</span>{" "}
                {targetIsParent && base ? `upstream/${base}` : base || "…"}
              </p>
              {baseLoading ? (
                <p className="text-xs text-muted-foreground">
                  Fetching upstream branches…
                </p>
              ) : parentFetchError ? (
                // Fetch failed but local upstream refs (if any) still populate the
                // picker — surface the error inline, keep the control usable.
                <p className="text-xs text-warning">
                  Couldn't fetch upstream: {parentFetchError}
                </p>
              ) : sameBranch ? (
                <p className="text-xs text-warning">
                  Pick two different branches.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {ahead.length} commit{ahead.length === 1 ? "" : "s"} to merge.
                </p>
              )}
              {targetIsParent && (
                <p className="text-xs text-muted-foreground">
                  Labels and assignees can be added on{" "}
                  {upstreamSlug ?? remoteLabel} after opening.
                </p>
              )}
            </div>

            {existingPr && (
              // An open PR from this head against the chosen target already
              // exists — offer to view it instead of allowing a duplicate.
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full cursor-pointer"
                onClick={() => openUrl(existingPr.url)}
                title={existingPr.title}
              >
                <ArrowSquareOutIcon data-icon="inline-start" />
                View {prNoun} #{existingPr.number}
                {existingPr.isDraft ? " (draft)" : ""}
              </Button>
            )}

            {canPickReviewers && (
              <div
                className="space-y-1.5"
                role="group"
                aria-labelledby={reviewersGroupId}
              >
                <Label id={reviewersGroupId}>Reviewers</Label>
                <ReviewersPopover
                  repoPath={repoPath}
                  number={null}
                  enabled={open && canPickReviewers}
                  value={reviewers}
                  lens="origin"
                  onChange={setReviewers}
                />
              </div>
            )}

            {canPickLabels && (
              <div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Popover.Root>
                    <Popover.Trigger
                      render={
                        <Button
                          variant="outline"
                          size="xs"
                          aria-label="Add labels"
                        />
                      }
                    >
                      <TagIcon data-icon="inline-start" />
                      Labels
                    </Popover.Trigger>
                    {/* Bare on purpose: this component's body renders above
                        DialogContent's PanelPortalReset, so a
                        usePanelPortalContainer() call here returns the panel
                        container and the popup would land behind the dialog
                        backdrop. (Pickers rendered as children inside the
                        dialog read undefined.) */}
                    <Popover.Portal>
                      <Popover.Positioner
                        align="start"
                        sideOffset={4}
                        className="isolate z-50"
                      >
                        <Popover.Popup className="w-60 rounded-none bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10">
                          <p className="px-1 pb-1.5 text-xs font-medium">
                            Labels
                          </p>
                          {(repoLabels.data ?? []).length === 0 && (
                            <p className="px-1 py-1 text-xs text-muted-foreground">
                              {repoLabels.isPending
                                ? "Loading labels…"
                                : repoLabels.isError
                                  ? "Couldn't load labels."
                                  : "This repository has no labels."}
                            </p>
                          )}
                          {(repoLabels.data ?? []).map((label) => (
                            <label
                              key={label.name}
                              className="flex cursor-pointer items-center gap-2 px-1 py-1.5 text-xs hover:bg-muted/60"
                            >
                              <Checkbox
                                checked={labels.has(label.name)}
                                onCheckedChange={(v) =>
                                  toggleLabel(label.name, v === true)
                                }
                              />
                              <span
                                aria-hidden
                                className="size-2 shrink-0 rounded-full"
                                style={{ backgroundColor: `#${label.color}` }}
                              />
                              <span
                                className="flex-1 truncate"
                                title={label.name}
                              >
                                {label.name}
                              </span>
                            </label>
                          ))}
                        </Popover.Popup>
                      </Popover.Positioner>
                    </Popover.Portal>
                  </Popover.Root>
                  {selectedChips.map((label) => (
                    <LabelChip key={label.name} label={label} />
                  ))}
                </div>
                {/* Mounted unconditionally: assistive tech announces a
                    role="status" only when the region was already in the DOM
                    before its text arrived. `empty:mt-0` keeps the silent
                    state from reserving space under the row. */}
                <p
                  role="status"
                  className="mt-1.5 text-xs text-muted-foreground empty:mt-0"
                >
                  {droppedLabels.length > 0
                    ? droppedLabelsHint(droppedLabels)
                    : ""}
                </p>
              </div>
            )}

            {canPickAssignees && (
              <div
                className="space-y-1.5"
                role="group"
                aria-labelledby={assigneesGroupId}
              >
                <Label id={assigneesGroupId}>Assignees</Label>
                <AssigneesPopover
                  repoPath={repoPath}
                  enabled={open}
                  value={assignees}
                  lens="origin"
                  onChange={setAssignees}
                />
              </div>
            )}

            <form.AppField
              name="title"
              validators={{ onChange: ({ value }) => required(value) }}
            >
              {(field) => (
                <field.TextField
                  label="Title"
                  placeholder="Summarize the change"
                />
              )}
            </form.AppField>
            <form.AppField name="body">
              {(field) => (
                <field.MarkdownField
                  label="Description"
                  placeholder="Describe what changed and why"
                  rows={7}
                  textareaClassName="ph-no-capture max-h-72 min-h-24 resize-y font-mono"
                  actions={
                    !aiEnabled ? undefined : generating ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={cancel}
                      >
                        <XIcon data-icon="inline-start" />
                        Cancel
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        disabled={nothingToMerge}
                        onClick={runGenerate}
                        // The chord is only offered while it would do something —
                        // a disabled Generate's shortcut is dead too.
                        title={
                          !nothingToMerge
                            ? `Generate the title and description with AI${generateHint}`
                            : "Generate the title and description with AI"
                        }
                      >
                        <SparkleIcon data-icon="inline-start" />
                        Generate
                      </Button>
                    )
                  }
                />
              )}
            </form.AppField>

            {/* Linked issues: non-AI surface (shown under Hide-AI too), gated on a
                usable tracker. Chips stay interactive while generating — the stream
                union only adds/annotates. On a Bitbucket repo with a linked Jira
                project the mention-only variant renders in this SAME slot. */}
            {canLinkIssues ? (
              <LinkedIssuesField
                repoPath={repoPath}
                lens={createLens}
                chips={linkedIssues}
                onToggleKeyword={toggleIssueKeyword}
                onRemove={removeIssue}
                onPick={pickIssue}
                disabled={generating}
              />
            ) : canJiraMention ? (
              <LinkedIssuesField
                variant="jira"
                repoPath={repoPath}
                link={jiraLink.data ?? null}
                jiraChips={jiraChips}
                onRemove={removeJiraChip}
                onPick={pickJiraChip}
                disabled={generating}
              />
            ) : null}

            {/* Collapsed "Notes for reviewers": deposit-seeded author context,
                posted as the PR's first comment and fed to the AI review. AI-only. */}
            {aiEnabled && (
              <form.AppField name="notes">
                {(field) => (
                  <ReviewerNotesField
                    repoPath={repoPath}
                    head={head || null}
                    field={field}
                  />
                )}
              </form.AppField>
            )}
          </div>

          <DialogFooter className="sm:items-center">
            {laneHint && (
              // Why the submit is disabled. It lives here rather than in the
              // scrollable body so it can't scroll out of view, and the button
              // points `aria-describedby` at it.
              <p
                id={creatingHintId}
                className="basis-full text-xs text-warning"
              >
                {laneHint}
              </p>
            )}
            <form.AppField name="draft">
              {(field) => (
                <field.CheckboxField
                  label="Create as draft"
                  className="mr-auto flex cursor-pointer items-center gap-2 text-xs text-muted-foreground"
                />
              )}
            </form.AppField>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <form.AppForm>
              <form.Subscribe selector={(s) => s.values.draft}>
                {(draft) => (
                  <form.SubmitButton
                    disabled={submitBlocked}
                    aria-describedby={laneHint ? creatingHintId : undefined}
                    title={SUBMIT_HINT}
                  >
                    {draft ? "Create draft" : `Create ${prNoun}`}
                  </form.SubmitButton>
                )}
              </form.Subscribe>
            </form.AppForm>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
