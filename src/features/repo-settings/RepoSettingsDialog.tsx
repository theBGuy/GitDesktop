import {
  ArrowClockwiseIcon,
  BroadcastIcon,
  CaretLeftIcon,
  ClockCounterClockwiseIcon,
  CopyIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { type ComponentType, useState } from "react";
import { toast } from "sonner";
import { NavRail, type NavRailGroup } from "@/components/NavRail";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { copyText } from "@/lib/clipboard";
import {
  useCreateWebhook,
  useDeleteWebhook,
  useForgeStatus,
  usePingWebhook,
  useRedeliverWebhook,
  useTestWebhook,
  useUpdateWebhook,
  useWebhookDeliveries,
  useWebhookDelivery,
  useWebhooks,
} from "@/lib/git/queries";
import {
  type ForgeProvider,
  type HookDelivery,
  providerLabel,
  type Webhook,
  type WebhookInput,
} from "@/lib/git/types";
import {
  GenerateActionContext,
  useGenerateActionSink,
  useGenerateChord,
} from "@/lib/hotkeys/useGenerateChord";
import { quickTransition } from "@/lib/motion";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { BitbucketBranchRestrictionsSection } from "./BitbucketBranchRestrictionsSection";
import { BitbucketDefaultReviewersSection } from "./BitbucketDefaultReviewersSection";
import { BitbucketEnvironmentsSection } from "./BitbucketEnvironmentsSection";
import { BitbucketGeneralSection } from "./BitbucketGeneralSection";
import { BitbucketSchedulesSection } from "./BitbucketSchedulesSection";
import { BitbucketVariablesSection } from "./BitbucketVariablesSection";
import { BitbucketWebhooksSection } from "./BitbucketWebhooksSection";
import { CollaboratorsSection } from "./CollaboratorsSection";
import { DangerZone } from "./DangerZone";
import { FundingSection } from "./FundingSection";
import { GeneralSettingsSection } from "./GeneralSettingsSection";
import { GitLabGeneralSection } from "./GitLabGeneralSection";
import { GitLabMembersSection } from "./GitLabMembersSection";
import { GitLabProtectedBranchesSection } from "./GitLabProtectedBranchesSection";
import { GitLabVariablesSection } from "./GitLabVariablesSection";
import { GitLabWebhooksSection } from "./GitLabWebhooksSection";
import { PagesSection } from "./PagesSection";
import { AsyncListBody, DeliveryPayload, InlineConfirm } from "./parts";
import { RulesetsSection } from "./RulesetsSection";
import { SecretsSection } from "./SecretsSection";
import { SecuritySection } from "./SecuritySection";

// A curated set of the events people wire webhooks to, plus the "everything"
// option. Not GitHub's full ~30 — the long tail can be added later.
const COMMON_EVENTS: { id: string; label: string }[] = [
  { id: "push", label: "Push" },
  { id: "pull_request", label: "Pull requests" },
  { id: "pull_request_review", label: "PR reviews" },
  { id: "issues", label: "Issues" },
  { id: "issue_comment", label: "Issue comments" },
  { id: "release", label: "Releases" },
  { id: "create", label: "Branch/tag created" },
  { id: "delete", label: "Branch/tag deleted" },
  { id: "fork", label: "Forks" },
  { id: "workflow_run", label: "Workflow runs" },
  { id: "deployment", label: "Deployments" },
  { id: "discussion", label: "Discussions" },
];

/** Labels for the webhook content-type select — without them Base UI shows the
 *  raw value ("form") instead of the media type in the trigger; the popup renders
 *  from this map too, so the two can never drift. */
const CONTENT_TYPE_ITEMS: Record<string, string> = {
  json: "application/json",
  form: "application/x-www-form-urlencoded",
};

function eventsSummary(events: string[]): string {
  if (events.includes("*")) return "All events";
  if (events.length === 0) return "No events";
  const labels = events.map(
    (e) => COMMON_EVENTS.find((c) => c.id === e)?.label ?? e,
  );
  if (labels.length <= 3) return labels.join(", ");
  return `${labels.slice(0, 3).join(", ")} +${labels.length - 3}`;
}

export type SectionId =
  | "general"
  | "access"
  | "rules"
  | "security"
  | "pages"
  | "sponsor"
  | "secrets"
  | "schedules"
  | "environments"
  | "webhooks"
  | "danger";

interface SectionItem {
  id: SectionId;
  label: string;
}

/** The rail's grouped sections, mirroring GitHub's familiar settings buckets so
 *  the mental model stays intact while the headers keep the list scannable. */
const SECTION_GROUPS: { label: string; items: SectionItem[] }[] = [
  {
    label: "Repository",
    items: [
      { id: "general", label: "General" },
      { id: "access", label: "Access" },
    ],
  },
  {
    label: "Security",
    items: [
      { id: "rules", label: "Rules" },
      { id: "security", label: "Security" },
    ],
  },
  {
    label: "Publishing",
    items: [
      { id: "pages", label: "Pages" },
      { id: "sponsor", label: "Sponsor" },
    ],
  },
  {
    label: "Automation",
    items: [
      { id: "secrets", label: "Secrets" },
      { id: "webhooks", label: "Webhooks" },
    ],
  },
];

/** The rail's groups: the grouped sections, then the Danger zone set off on its own
 *  so the first screen isn't also the densest and delete-the-repo is a deliberate
 *  click. */
const RAIL_GROUPS: NavRailGroup[] = [
  ...SECTION_GROUPS,
  {
    separated: true,
    items: [{ id: "danger", label: "Danger zone", destructive: true }],
  },
];

/** The GitLab rail: the sections with a GitLab implementation. The GitHub-only
 *  buckets (Rulesets, Security, Pages, Sponsor) don't map onto GitLab's model
 *  and stay off this rail rather than rendering dead ends; GitLab's one
 *  variable store fills the Automation bucket alongside webhooks. */
const GITLAB_RAIL_GROUPS: NavRailGroup[] = [
  {
    label: "Project",
    items: [
      { id: "general", label: "General" },
      { id: "access", label: "Members" },
    ],
  },
  {
    label: "Repository",
    items: [{ id: "rules", label: "Protected branches" }],
  },
  {
    label: "Automation",
    items: [
      { id: "secrets", label: "Variables" },
      { id: "webhooks", label: "Webhooks" },
    ],
  },
  {
    separated: true,
    items: [{ id: "danger", label: "Danger zone", destructive: true }],
  },
];

/** The Bitbucket rail: the sections with a Bitbucket implementation. Bitbucket
 *  splits pipelines into their own bucket (variables + schedules), and has no
 *  GitHub-style rulesets/security/pages/sponsor surfaces. */
const BITBUCKET_RAIL_GROUPS: NavRailGroup[] = [
  {
    label: "Repository",
    items: [
      { id: "general", label: "General" },
      { id: "access", label: "Default reviewers" },
      { id: "rules", label: "Branch restrictions" },
    ],
  },
  {
    label: "Pipelines",
    items: [
      { id: "secrets", label: "Variables" },
      { id: "schedules", label: "Schedules" },
      { id: "environments", label: "Deployments" },
    ],
  },
  {
    label: "Automation",
    items: [{ id: "webhooks", label: "Webhooks" }],
  },
  {
    separated: true,
    items: [{ id: "danger", label: "Danger zone", destructive: true }],
  },
];

const PROVIDER_RAIL_GROUPS: Record<ForgeProvider, NavRailGroup[]> = {
  github: RAIL_GROUPS,
  gitlab: GITLAB_RAIL_GROUPS,
  bitbucket: BITBUCKET_RAIL_GROUPS,
};

/** The sections each provider's rail actually offers — a section remembered
 *  from another repo may not exist here. `null` = every section is valid. */
const PROVIDER_SECTIONS: Record<ForgeProvider, SectionId[] | null> = {
  github: null,
  gitlab: ["general", "access", "rules", "secrets", "webhooks", "danger"],
  bitbucket: [
    "general",
    "access",
    "rules",
    "secrets",
    "schedules",
    "environments",
    "webhooks",
    "danger",
  ],
};

/** The body each section renders, per provider. A missing provider entry is a
 *  section that provider doesn't have (GitHub-only rulesets / security / pages /
 *  sponsor, Bitbucket-only pipeline schedules + deployments) — it renders
 *  nothing rather than a dead end. "danger" is absent: DangerZone takes its own
 *  props and stays at the call site. */
const SECTION_BODIES: Record<
  Exclude<SectionId, "danger">,
  Partial<
    Record<ForgeProvider, ComponentType<{ repoPath: string; open: boolean }>>
  >
> = {
  general: {
    github: GeneralSettingsSection,
    gitlab: GitLabGeneralSection,
    bitbucket: BitbucketGeneralSection,
  },
  access: {
    github: CollaboratorsSection,
    gitlab: GitLabMembersSection,
    bitbucket: BitbucketDefaultReviewersSection,
  },
  rules: {
    github: RulesetsSection,
    gitlab: GitLabProtectedBranchesSection,
    bitbucket: BitbucketBranchRestrictionsSection,
  },
  security: { github: SecuritySection },
  pages: { github: PagesSection },
  sponsor: { github: FundingSection },
  secrets: {
    github: SecretsSection,
    gitlab: GitLabVariablesSection,
    bitbucket: BitbucketVariablesSection,
  },
  schedules: { bitbucket: BitbucketSchedulesSection },
  environments: { bitbucket: BitbucketEnvironmentsSection },
  webhooks: {
    github: WebhooksSection,
    gitlab: GitLabWebhooksSection,
    bitbucket: BitbucketWebhooksSection,
  },
};

export function RepoSettingsDialog({
  repoPath,
  open,
  onOpenChange,
  initialSection,
  subdueEntrance,
}: {
  repoPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Section to land on. An initializer is enough: the dialog mounts fresh on
   *  each open, so a later open with no request starts at "general" again. */
  initialSection?: SectionId;
  /** Skip the open animation. A caller that reaches this dialog through a
   *  Suspense fallback mounts a second Dialog root over one that already played
   *  the entrance, and only that caller wants the replay suppressed. */
  subdueEntrance?: boolean;
}) {
  const [section, setSection] = useState<SectionId>(
    initialSection ?? "general",
  );
  const reduceMotion = useReducedMotion();
  // The dialog is provider-aware: each provider gets the sections its API
  // supports, with the same rail + crossfade shell.
  const forge = useForgeStatus(repoPath);
  // An unrecognized (or not-yet-resolved) remote routes through gh, so GitHub
  // is the default rail — the same fallback `providerLabel` applies.
  const provider: ForgeProvider = forge.data?.provider ?? "github";
  const isGitLab = provider === "gitlab";
  const isBitbucket = provider === "bitbucket";
  const remoteLabel = providerLabel(provider);
  const allowedSections = PROVIDER_SECTIONS[provider];
  const activeSection =
    !allowedSections || allowedSections.includes(section) ? section : "general";
  const Body =
    activeSection === "danger"
      ? undefined
      : SECTION_BODIES[activeSection][provider];

  // The generate chord belongs to whichever section is showing a Generate
  // affordance — only the General sections have one, and they publish it here,
  // keyed by the section they mounted under so the crossfade's outgoing section
  // can't answer the chord (see `useGenerateActionSink`).
  // The swallow below is unconditional whatever the active section: this dialog
  // opens over any tab, including Changes where the global
  // generate-commit-message action is live, so a chord that leaked would write
  // a commit message behind the dialog. `enabled: true` is that swallow; the
  // published action's own gate decides whether anything actually runs.
  const generate = useGenerateActionSink(activeSection);
  const generateChord = useGenerateChord({
    enabled: true,
    run: generate.runPublished,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Fixed, calm height so switching sections never resizes the dialog; the
          body column scrolls (overflow-y-auto) so a long form / many webhooks
          stay contained while the rail stays put. Caps to 85vh on short screens. */}
      <DialogContent
        className={cn(
          "flex h-150 max-h-[85vh] flex-col sm:max-w-3xl",
          // tailwind-merge treats animate-in and animate-none as unrelated, so
          // neither class removes the other; `!` decides it on the cascade
          // rather than on which rule the stylesheet happens to emit last.
          subdueEntrance && "data-open:animate-none!",
        )}
        onKeyDown={generateChord.onKeyDown}
      >
        <DialogHeader>
          <DialogTitle>Repository settings</DialogTitle>
          <DialogDescription>
            Manage this {remoteLabel} {isGitLab ? "project's" : "repository's"}{" "}
            settings
            {isGitLab || isBitbucket ? "" : " and webhooks"}. Changes apply on{" "}
            {remoteLabel} immediately.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 min-w-0 flex-1 gap-4">
          <NavRail
            ariaLabel="Repository settings sections"
            groups={PROVIDER_RAIL_GROUPS[provider]}
            activeId={activeSection}
            onSelect={(id) => setSection(id as SectionId)}
            className="w-40 overflow-y-auto"
          />
          {/* Vertical-scroll only: overflow-y-auto alone lets overflow-x compute
              to `auto`, so the vertical scrollbar's width tips shrink-to-fit
              content into a phantom horizontal scrollbar. Clip x explicitly. */}
          <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto pr-1">
            {/* Crossfade the body on section change so the swap reads as one
                quiet refresh, not a hard cut. Opacity only (content is tall and
                scrolls); instant under reduced motion. */}
            <AnimatePresence mode="wait" initial={false}>
              <m.div
                key={activeSection}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={reduceMotion ? { duration: 0 } : quickTransition}
              >
                <GenerateActionContext value={generate.sink}>
                  {Body && <Body repoPath={repoPath} open={open} />}
                </GenerateActionContext>
                {activeSection === "danger" && (
                  <DangerZone
                    repoPath={repoPath}
                    open={open}
                    provider={provider}
                    onRepoDeleted={() => onOpenChange(false)}
                  />
                )}
              </m.div>
            </AnimatePresence>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function WebhooksSection({
  repoPath,
  open,
}: {
  repoPath: string;
  open: boolean;
}) {
  const hooks = useWebhooks(repoPath, open);
  // null = list view; a Webhook = editing it; "new" = the create form.
  const [editing, setEditing] = useState<Webhook | "new" | null>(null);
  const [deliveriesFor, setDeliveriesFor] = useState<Webhook | null>(null);

  if (deliveriesFor) {
    return (
      <DeliveriesView
        repoPath={repoPath}
        hook={deliveriesFor}
        onBack={() => setDeliveriesFor(null)}
      />
    );
  }

  if (editing) {
    return (
      <WebhookForm
        repoPath={repoPath}
        hook={editing === "new" ? null : editing}
        onDone={() => setEditing(null)}
      />
    );
  }

  return (
    // min-w-0: DialogContent is display:grid, so this grid item must be allowed
    // to shrink below its content (the long webhook URL) for truncate to work.
    <div className="min-w-0 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {hooks.data?.length
            ? `${hooks.data.length} webhook${hooks.data.length === 1 ? "" : "s"}`
            : "Send a POST to a URL when events happen in this repo."}
        </p>
        <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
          <PlusIcon data-icon="inline-start" />
          Add webhook
        </Button>
      </div>

      <AsyncListBody
        loading={hooks.isLoading}
        error={hooks.error}
        empty={hooks.data?.length === 0}
        emptyLabel="No webhooks yet."
        skeletonClassName="h-16 w-full"
        errorTitle="Couldn't load webhooks."
        errorScope="admin:repo_hook"
      >
        {hooks.data?.map((hook) => (
          <WebhookRow
            key={hook.id}
            repoPath={repoPath}
            hook={hook}
            onEdit={() => setEditing(hook)}
            onDeliveries={() => setDeliveriesFor(hook)}
          />
        ))}
      </AsyncListBody>
    </div>
  );
}

function WebhookRow({
  repoPath,
  hook,
  onEdit,
  onDeliveries,
}: {
  repoPath: string;
  hook: Webhook;
  onEdit: () => void;
  onDeliveries: () => void;
}) {
  const ping = usePingWebhook(repoPath);
  const test = useTestWebhook(repoPath);
  const del = useDeleteWebhook(repoPath);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const lastCode = hook.lastResponse.code;
  const lastTone =
    lastCode == null
      ? "text-muted-foreground"
      : lastCode >= 200 && lastCode < 300
        ? "text-success"
        : "text-destructive";
  const canTest = hook.events.includes("push") || hook.events.includes("*");

  // Awaited, not per-call callbacks: react-query drops those when this subtree
  // unmounts mid-flight — closing the dialog or switching the rail's section —
  // so the outcome would never reach the user.
  async function handleDelete() {
    try {
      await del.mutateAsync(hook.id);
      toast.success("Webhook removed");
    } catch (e) {
      toastError(e);
    }
  }

  async function handlePing() {
    try {
      await ping.mutateAsync(hook.id);
      toast.success("Ping sent");
    } catch (e) {
      toastError(e);
    }
  }

  async function handleTest() {
    try {
      await test.mutateAsync(hook.id);
      toast.success("Test event sent");
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className="rounded-md border p-3 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p
              className="min-w-0 flex-1 truncate font-mono"
              title={hook.config.url}
            >
              {hook.config.url}
            </p>
            <button
              type="button"
              className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
              title="Copy URL"
              onClick={() => copyText(hook.config.url, "Webhook URL copied")}
            >
              <CopyIcon className="size-3.5" />
            </button>
          </div>
          <p className="mt-1 text-muted-foreground">
            {eventsSummary(hook.events)} ·{" "}
            <span className={lastTone}>
              {lastCode == null
                ? "not yet delivered"
                : `last: ${lastCode} ${hook.lastResponse.status}`}
            </span>
          </p>
        </div>
        <Badge variant={hook.active ? "default" : "secondary"}>
          {hook.active ? "Active" : "Inactive"}
        </Badge>
      </div>

      <div className="mt-2 flex items-center justify-end gap-1">
        {confirmingDelete ? (
          <InlineConfirm
            prompt="Remove this webhook?"
            promptClassName="mr-auto"
            actLabel="Remove"
            pending={del.isPending}
            onCancel={() => setConfirmingDelete(false)}
            onAct={handleDelete}
          />
        ) : (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={ping.isPending}
              title="Send a ping event"
              onClick={handlePing}
            >
              <BroadcastIcon data-icon="inline-start" />
              Ping
            </Button>
            {canTest && (
              <Button
                size="sm"
                variant="ghost"
                disabled={test.isPending}
                title="Trigger a test push event"
                onClick={handleTest}
              >
                <ArrowClockwiseIcon data-icon="inline-start" />
                Test
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              title="Recent deliveries"
              onClick={onDeliveries}
            >
              <ClockCounterClockwiseIcon data-icon="inline-start" />
              Deliveries
            </Button>
            <Button size="sm" variant="ghost" onClick={onEdit}>
              <PencilSimpleIcon data-icon="inline-start" />
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setConfirmingDelete(true)}
            >
              <TrashIcon data-icon="inline-start" />
              Delete
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function DeliveriesView({
  repoPath,
  hook,
  onBack,
}: {
  repoPath: string;
  hook: Webhook;
  onBack: () => void;
}) {
  const deliveries = useWebhookDeliveries(repoPath, hook.id, true);

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <CaretLeftIcon />
          Back
        </button>
        <p
          className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-muted-foreground"
          title={hook.config.url}
        >
          {hook.config.url}
        </p>
      </div>

      {deliveries.isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      )}
      {deliveries.isError && (
        <p className="text-xs text-destructive">
          {deliveries.error instanceof Error
            ? deliveries.error.message
            : "Couldn't load deliveries."}
        </p>
      )}
      {deliveries.data?.length === 0 && (
        <p className="rounded-md border border-dashed py-8 text-center text-xs text-muted-foreground">
          No deliveries yet.
        </p>
      )}

      <div className="space-y-2">
        {deliveries.data?.map((d) => (
          <DeliveryRow
            key={d.id}
            repoPath={repoPath}
            hookId={hook.id}
            delivery={d}
          />
        ))}
      </div>
    </div>
  );
}

function DeliveryRow({
  repoPath,
  hookId,
  delivery,
}: {
  repoPath: string;
  hookId: number;
  delivery: HookDelivery;
}) {
  const [expanded, setExpanded] = useState(false);
  const detail = useWebhookDelivery(
    repoPath,
    hookId,
    expanded ? delivery.id : null,
  );
  const redeliver = useRedeliverWebhook(repoPath, hookId);

  const ok = delivery.statusCode >= 200 && delivery.statusCode < 300;
  const eventLabel = delivery.action
    ? `${delivery.event}.${delivery.action}`
    : delivery.event;

  async function handleRedeliver() {
    try {
      await redeliver.mutateAsync(delivery.id);
      toast.success("Redelivery queued");
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className="rounded-md border text-xs">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 p-2 text-left hover:bg-muted/40"
      >
        <span
          className={cn(
            "shrink-0 font-mono tabular-nums",
            ok ? "text-success" : "text-destructive",
          )}
        >
          {delivery.statusCode || "—"}
        </span>
        <span className="truncate font-medium">{eventLabel}</span>
        {delivery.redelivery && (
          <Badge variant="secondary" className="shrink-0">
            redelivered
          </Badge>
        )}
        <span className="ml-auto shrink-0 text-muted-foreground">
          {delivery.deliveredAt ? (
            <RelativeTime date={delivery.deliveredAt} />
          ) : null}
        </span>
      </button>

      {expanded && (
        <div className="space-y-2 border-t p-2">
          <div className="flex justify-end">
            <Button
              size="xs"
              variant="ghost"
              disabled={redeliver.isPending}
              onClick={handleRedeliver}
            >
              {redeliver.isPending ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <ArrowClockwiseIcon data-icon="inline-start" />
              )}
              Redeliver
            </Button>
          </div>
          {detail.isLoading && <Skeleton className="h-16 w-full" />}
          {detail.isError && (
            <p className="text-[11px] text-destructive">
              {detail.error instanceof Error
                ? detail.error.message
                : "Couldn't load the payload."}
            </p>
          )}
          {detail.data && (
            <>
              <DeliveryPayload
                label="Request payload"
                body={detail.data.requestPayload}
              />
              <DeliveryPayload
                label="Response body"
                body={detail.data.responsePayload}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function WebhookForm({
  repoPath,
  hook,
  onDone,
}: {
  repoPath: string;
  hook: Webhook | null;
  onDone: () => void;
}) {
  const create = useCreateWebhook(repoPath);
  const update = useUpdateWebhook(repoPath);
  const pending = create.isPending || update.isPending;

  const [url, setUrl] = useState(hook?.config.url ?? "");
  const [contentType, setContentType] = useState<"json" | "form">(
    hook?.config.contentType === "form" ? "form" : "json",
  );
  const [secret, setSecret] = useState("");
  const [verifySsl, setVerifySsl] = useState(
    hook ? hook.config.insecureSsl !== "1" : true,
  );
  const [allEvents, setAllEvents] = useState(
    hook ? hook.events.includes("*") : false,
  );
  const [events, setEvents] = useState<Set<string>>(
    new Set(hook ? hook.events.filter((e) => e !== "*") : ["push"]),
  );
  const [active, setActive] = useState(hook?.active ?? true);

  const hadSecret = hook?.config.secret != null;
  const urlValid = /^https?:\/\/.+/.test(url.trim());
  const eventsValid = allEvents || events.size > 0;

  function toggleEvent(id: string, on: boolean) {
    setEvents((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function submit() {
    const input: WebhookInput = {
      url: url.trim(),
      contentType,
      secret: secret.trim() || null,
      insecureSsl: !verifySsl,
      events: allEvents ? ["*"] : [...events],
      active,
    };
    try {
      if (hook) await update.mutateAsync({ id: hook.id, input });
      else await create.mutateAsync(input);
      toast.success(hook ? "Webhook updated" : "Webhook created");
      onDone();
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="hook-url">Payload URL</Label>
        <Input
          id="hook-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/webhook"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="hook-content-type">Content type</Label>
          <Select
            items={CONTENT_TYPE_ITEMS}
            value={contentType}
            onValueChange={(v) => setContentType(v as "json" | "form")}
          >
            <SelectTrigger id="hook-content-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(CONTENT_TYPE_ITEMS).map(([ct, label]) => (
                <SelectItem key={ct} value={ct}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="hook-secret">Secret</Label>
          <Input
            id="hook-secret"
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={hadSecret ? "•••••••• (set)" : "Optional"}
            autoComplete="off"
          />
          {hadSecret && (
            <p className="text-[11px] text-muted-foreground">
              Leave blank to keep the current secret.
            </p>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <Label>Events</Label>
        <label className="flex cursor-pointer items-center gap-2 text-xs">
          <Switch checked={allEvents} onCheckedChange={setAllEvents} />
          Send me everything
        </label>
        {!allEvents && (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 pt-1 sm:grid-cols-3">
            {COMMON_EVENTS.map((ev) => (
              <label
                key={ev.id}
                className="flex cursor-pointer items-center gap-2 text-xs"
              >
                <Checkbox
                  checked={events.has(ev.id)}
                  onCheckedChange={(c) => toggleEvent(ev.id, c === true)}
                />
                {ev.label}
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-4">
        <label className="flex cursor-pointer items-center gap-2 text-xs">
          <Switch checked={verifySsl} onCheckedChange={setVerifySsl} />
          Verify SSL certificate
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-xs">
          <Switch checked={active} onCheckedChange={setActive} />
          Active
        </label>
      </div>

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button variant="outline" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        {/* The vendored Button renders a native `disabled` (pointer-events:
            none), so a `title` on the button itself never shows — the
            disabled-reason hint rides a wrapping span. */}
        <span
          className={cn(
            "inline-flex",
            (!urlValid || !eventsValid) && "cursor-not-allowed",
          )}
          title={
            !urlValid
              ? "Enter a valid http(s) URL"
              : !eventsValid
                ? "Select at least one event"
                : undefined
          }
        >
          <Button
            disabled={pending || !urlValid || !eventsValid}
            onClick={submit}
          >
            {pending && <Spinner data-icon="inline-start" />}
            {hook ? "Save changes" : "Create webhook"}
          </Button>
        </span>
      </div>
    </div>
  );
}
