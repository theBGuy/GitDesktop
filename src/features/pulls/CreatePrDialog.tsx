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
import { AssigneesPopover } from "@/features/issues/IssueMetaPickers";
import { REVIEWER_NOTES_MARKER } from "@/lib/ai/notes-context";
import { track } from "@/lib/analytics";
import { triggerAutomations } from "@/lib/automations/runner";
import { required, useAppForm } from "@/lib/form";
import * as api from "@/lib/git/api";
import {
  forgeFeatureReady,
  useAddRemote,
  useCompareBranches,
  useCreatePr,
  useDefaultBranch,
  useForgeStatus,
  usePrsForBranch,
  useRepoLabels,
  useRepoStatus,
} from "@/lib/git/queries";
import {
  type ForgeUserRef,
  providerLabel,
  type RemoteLens,
} from "@/lib/git/types";
import { eventToBinding, formatBinding } from "@/lib/hotkeys/binding";
import { useEffectiveBindings } from "@/lib/hotkeys/hotkeys";
import { useJiraLink } from "@/lib/jira/queries";
import {
  useLensGate,
  useRemoteSlug,
  useSetRepoLens,
} from "@/lib/repo-lens/queries";
import { deleteReviewNote } from "@/lib/review-notes/store";
import { useAiEnabled, useSettings } from "@/lib/settings/queries";
import { toastError } from "@/lib/toast";
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

/** Platform-correct submit hint (Cmd+Enter on macOS, Ctrl+Enter else) — never a
 *  literal modifier (house platform-mod-key rule). */
const SUBMIT_HINT = formatBinding("mod+enter");

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
  const setRepoLens = useSetRepoLens(repoPath);
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
  function addUpstreamRemote() {
    if (!forkParent) return;
    // Derive the host — on GitHub Enterprise `isGithub` still holds, and a
    // hardcoded github.com would add a wrong-host remote that fails later.
    const ghHost = forge.data?.host || "github.com";
    addRemote.mutate(
      { name: "upstream", url: `https://${ghHost}/${forkParent}.git` },
      {
        // On success the broad invalidation refreshes remotes → `useLensGate` flips
        // true → the "Create in" picker appears (default Parent).
        onError: (e) => toastError(e),
      },
    );
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
  const aiDescriptionRef = useRef(false);

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
        fetchError = e instanceof Error ? e.message : String(e);
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
              toast.error("PR created — posting reviewer notes failed.");
            }
          }
          // Consume the deposit regardless of whether the comment posted — the
          // create itself consumed the note. Best-effort; app-data, not the PR.
          void deleteReviewNote(repoPath, value.head).catch(() => undefined);
        }
        // Creating on the parent means the PR lives under the upstream lens — flip
        // the persisted lens so the PRs tab shows it (no-op when already "upstream").
        if (createLens === "upstream") setRepoLens("upstream");
        // Name the target repo in the toast so "Opened PR #N in owner/repo" is
        // unambiguous for a fork contribution.
        const where = targetSlug ? ` in ${targetSlug}` : "";
        toast.success(`Opened ${prNoun} #${number}${where}`, {
          description: url,
          action: { label: "View", onClick: () => openUrl(url) },
        });
        // This dialog is panel-hosted under <Activity>, so the success path must
        // only close — never setRepoTab/selectPr (a hidden Activity subtree would
        // defer the close and strand the dialog). Want navigation? Hoist it to
        // RepositoryView first, like CreateLocalPrDialog.
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
        toastError(e);
      }
    },
  });

  // Seed branches each time the dialog opens: head = current branch, base =
  // the default branch (or, when you're already on it, the first other branch).
  // keepDefaultValues: otherwise the per-render options sync clobbers the
  // seeded values back to empty on an untouched form.
  const seedOnOpen = useEffectEvent(() => {
    aiDescriptionRef.current = false;
    setReviewers([]);
    setLabels(new Set());
    setAssignees([]);
    // Reset the linked-issue chips (and their dismissed/probed refs) — the create
    // dialog opens with no seeded body refs; extraction/AI seeding repopulates.
    resetLinkedIssues([]);
    // Same for the Jira mention cluster (Bitbucket + linked project).
    resetJiraChips([]);
    // Reset the target to the default (parent) every open, so a prior fork/parent
    // choice doesn't leak into the next PR.
    setTarget("upstream");
    const h = defaultHead ?? currentName ?? names[0] ?? "";
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
  useEffect(() => {
    if (open) seedOnOpen();
  }, [open]);

  // Live head/base drive the "N commits" hint, AI generation, and submit gate.
  const head = useSelector(form.store, (s) => s.values.head);
  const base = useSelector(form.store, (s) => s.values.base);
  // Live notes feed the AI-description prompt (so a generated description can
  // reflect the reviewer notes) and the ReviewerNotesField's seeding provenance.
  const notes = useSelector(form.store, (s) => s.values.notes);

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
  const comparison = useCompareBranches(repoPath, compareBaseRef, head || null);
  const ahead = comparison.data?.ahead ?? [];
  // A head equal to the parent's base name is still a distinct ref (local branch
  // vs. `upstream/<name>`), so only treat identical refs as "same branch".
  const sameBranch = compareBaseRef !== null && compareBaseRef === head;
  const nothingToMerge = sameBranch || ahead.length === 0;

  // Duplicate probe: an open PR from this head against the chosen target already
  // exists. Probe with the target's lens ("upstream" composes owner:branch
  // Rust-side; pass the BARE head). The origin path skips cross-repository rows for
  // the same reason ComparePanel does — an origin-pinned probe can only reach them
  // via a contributor's same-named fork branch. The upstream lens keeps them,
  // because there your own fork→parent duplicate IS cross-repository; that arm
  // reports the flag false for every row today, so the qualifier guards the future.
  const branchPrs = usePrsForBranch(repoPath, head || null, open, createLens);
  const existingPr = (branchPrs.data ?? []).find(
    (p) =>
      p.baseRefName === base &&
      (createLens === "upstream" || !p.crossRepository),
  );

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
    aiDescriptionRef.current = true;
    // Grounded issue candidates the model may link: current chips pinned first,
    // then the highest-scoring OPEN issues, capped at 8 (the hook records the set
    // it fed so `upsertAiIssues` can resolve an AI-proposed number's title/state).
    const issueCandidates = buildIssueCandidates();
    // Grounded Jira mention candidates (Bitbucket + linked project). Empty unless
    // the Jira cluster is active; mutually exclusive with `issueCandidates`.
    const jiraCandidates = canJiraMention ? buildJiraCandidates() : undefined;
    generate(
      base,
      head,
      ahead.map((c) => c.subject),
      (d) => {
        form.setFieldValue("title", d.title);
        form.setFieldValue("body", d.body);
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
    );
  }
  // Context-sensitive reuse of the `generate-commit-message` binding while this
  // dialog is open — never a hardcoded chord. null = explicitly unbound.
  const generateBinding =
    useEffectiveBindings().get("generate-commit-message") ?? null;
  const generateHint = generateBinding
    ? ` (${formatBinding(generateBinding)})`
    : "";

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
            if (
              !(
                generating ||
                nothingToMerge ||
                baseLoading ||
                Boolean(existingPr)
              )
            ) {
              form.handleSubmit();
            }
            return;
          }
          // The generate-commit-message chord runs this dialog's own Generate while
          // it's open — only when AI is on and the chord is bound. ALWAYS swallow it
          // so it can't reach the global listener and generate a commit message
          // behind the dialog; run Generate only when its button would be enabled.
          // While generating we swallow but DON'T cancel — an accidental repeat must
          // never abort an in-flight generation.
          if (
            aiEnabled &&
            generateBinding !== null &&
            eventToBinding(e) === generateBinding
          ) {
            e.preventDefault();
            if (!generating && !nothingToMerge) runGenerate();
          }
        }}
      >
        <form
          className="flex min-h-0 min-w-0 flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
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
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
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
                    <Button
                      key={b.value}
                      type="button"
                      variant={target === b.value ? "secondary" : "ghost"}
                      size="xs"
                      aria-pressed={target === b.value}
                      title={b.slug ?? undefined}
                      onClick={() => setTarget(b.value)}
                    >
                      {b.label}
                      {b.slug ? (
                        <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">
                          {b.slug}
                        </span>
                      ) : null}
                    </Button>
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
                  onClick={addUpstreamRemote}
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
                            <span className="flex-1 truncate">
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
                        title={`Generate the title and description with AI${generateHint}`}
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
                    disabled={
                      generating ||
                      nothingToMerge ||
                      baseLoading ||
                      Boolean(existingPr)
                    }
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
