import {
  ArrowClockwiseIcon,
  CaretLeftIcon,
  ClockCounterClockwiseIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "sonner";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  useGlCreateHook,
  useGlDeleteHook,
  useGlHookEvents,
  useGlHooks,
  useGlResendHookEvent,
  useGlTestHook,
  useGlUpdateHook,
} from "@/lib/git/queries";
import type { GitLabHook, GitLabHookDelivery } from "@/lib/git/types";
import { parseableDate } from "@/lib/time";
import { toastError } from "@/lib/toast";
import { AsyncListBody, DeliveryPayload, InlineConfirm } from "./parts";

/** GitLab's per-hook event flags, in display order (no "send everything" —
 *  GitLab models events as independent booleans). */
const GL_EVENTS: { id: string; label: string }[] = [
  { id: "push_events", label: "Push" },
  { id: "tag_push_events", label: "Tag push" },
  { id: "issues_events", label: "Issues" },
  { id: "merge_requests_events", label: "Merge requests" },
  { id: "note_events", label: "Comments" },
  { id: "pipeline_events", label: "Pipelines" },
  { id: "job_events", label: "Jobs" },
  { id: "wiki_page_events", label: "Wiki pages" },
  { id: "releases_events", label: "Releases" },
  { id: "deployment_events", label: "Deployments" },
];

function eventsSummary(events: string[]): string {
  if (events.length === 0) return "No events";
  const labels = events.map(
    (e) => GL_EVENTS.find((c) => c.id === e)?.label ?? e,
  );
  if (labels.length <= 3) return labels.join(", ");
  return `${labels.slice(0, 3).join(", ")} +${labels.length - 3}`;
}

/** The GitLab counterpart of the GitHub Webhooks section: hook CRUD, a test
 *  fire, and the delivery log with payloads + per-event resend. */
export function GitLabWebhooksSection({
  repoPath,
  open,
}: {
  repoPath: string;
  open: boolean;
}) {
  const hooks = useGlHooks(repoPath, open);
  const deleteHook = useGlDeleteHook(repoPath);
  const testHook = useGlTestHook(repoPath);
  // null = list; "new" = create form; a hook = edit form.
  const [editing, setEditing] = useState<GitLabHook | "new" | null>(null);
  const [viewingEvents, setViewingEvents] = useState<GitLabHook | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  // Awaited, not per-call callbacks: this subtree unmounts when the dialog
  // closes or the rail crossfades to another section, and react-query drops
  // per-call callbacks on unmount — the outcome would never reach the user.
  async function handleDelete(hookId: string) {
    try {
      await deleteHook.mutateAsync(hookId);
      toast.success("Webhook deleted");
      setConfirming(null);
    } catch (e) {
      toastError(e);
    }
  }

  async function handleTest(hookId: string) {
    try {
      await testHook.mutateAsync({ hookId, trigger: "push_events" });
      toast.success("Test event sent");
    } catch (e) {
      toastError(e);
    }
  }

  if (viewingEvents) {
    return (
      <HookDeliveries
        repoPath={repoPath}
        hook={viewingEvents}
        onBack={() => setViewingEvents(null)}
      />
    );
  }

  if (editing) {
    return (
      <HookForm
        repoPath={repoPath}
        hook={editing === "new" ? null : editing}
        onDone={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Webhooks GitLab fires for this project's events.
        </p>
        <Button size="sm" onClick={() => setEditing("new")}>
          <PlusIcon data-icon="inline-start" />
          Add webhook
        </Button>
      </div>

      <AsyncListBody
        loading={hooks.isPending}
        error={hooks.error}
        empty={hooks.data?.length === 0}
        emptyLabel="No webhooks yet."
        skeletonClassName="h-14 w-full"
        errorTitle="Couldn't load webhooks."
        errorHint="Managing webhooks needs the Maintainer role."
      >
        {hooks.data?.map((h) => (
          <div key={h.id} className="rounded-md border p-2 text-xs">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono font-medium" title={h.url}>
                  {h.url}
                </p>
                <p className="mt-0.5 text-muted-foreground">
                  {eventsSummary(h.events)}
                  {parseableDate(h.createdAt) && (
                    <>
                      {" · added "}
                      <RelativeTime date={h.createdAt} />
                    </>
                  )}
                </p>
              </div>
              {h.alertStatus !== "executable" && (
                <Badge
                  variant="destructive"
                  title="GitLab disabled this hook after repeated failures — check the deliveries, then save it again to re-enable."
                >
                  disabled
                </Badge>
              )}
              {confirming === h.id ? (
                <InlineConfirm
                  prompt="Delete?"
                  actLabel="Delete"
                  pending={deleteHook.isPending}
                  onCancel={() => setConfirming(null)}
                  onAct={() => handleDelete(h.id)}
                />
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Send a test push event"
                    disabled={testHook.isPending}
                    onClick={() => handleTest(h.id)}
                  >
                    <ArrowClockwiseIcon />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Recent deliveries"
                    onClick={() => setViewingEvents(h)}
                  >
                    <ClockCounterClockwiseIcon />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Edit"
                    onClick={() => setEditing(h)}
                  >
                    <PencilSimpleIcon />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground hover:text-destructive"
                    title="Delete"
                    onClick={() => setConfirming(h.id)}
                  >
                    <TrashIcon />
                  </Button>
                </>
              )}
            </div>
          </div>
        ))}
      </AsyncListBody>
    </div>
  );
}

function HookForm({
  repoPath,
  hook,
  onDone,
}: {
  repoPath: string;
  hook: GitLabHook | null;
  onDone: () => void;
}) {
  const create = useGlCreateHook(repoPath);
  const update = useGlUpdateHook(repoPath);
  const [url, setUrl] = useState(hook?.url ?? "");
  const [token, setToken] = useState("");
  const [sslVerify, setSslVerify] = useState(
    hook?.enableSslVerification ?? true,
  );
  const [events, setEvents] = useState<string[]>(
    hook?.events ?? ["push_events"],
  );

  const pending = create.isPending || update.isPending;
  const urlValid =
    url.trim().startsWith("https://") || url.trim().startsWith("http://");
  const canSave = urlValid && events.length > 0 && !pending;
  const warning = !url.trim()
    ? null
    : !urlValid
      ? "The payload URL must start with http:// or https://."
      : events.length === 0
        ? "Select at least one event."
        : null;

  function toggleEvent(id: string, on: boolean) {
    setEvents((prev) => (on ? [...prev, id] : prev.filter((e) => e !== id)));
  }

  async function save() {
    const input = {
      url: url.trim(),
      // Blank leaves an existing secret unchanged (GitLab never returns it).
      token: token.trim() ? token.trim() : null,
      enableSslVerification: sslVerify,
      events,
    };
    try {
      if (hook) await update.mutateAsync({ hookId: hook.id, input });
      else await create.mutateAsync(input);
      toast.success(hook ? "Webhook updated" : "Webhook created");
      onDone();
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className="min-w-0 space-y-3">
      <Button size="sm" variant="ghost" onClick={onDone}>
        <CaretLeftIcon data-icon="inline-start" />
        Back to webhooks
      </Button>
      <div className="space-y-3 rounded-md border p-3">
        <div className="space-y-1.5">
          <Label htmlFor="gl-hook-url">Payload URL</Label>
          <Input
            id="gl-hook-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/hook"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="gl-hook-token">Secret token</Label>
          <Input
            id="gl-hook-token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={hook ? "(unchanged)" : "(optional)"}
            autoComplete="off"
          />
          <p className="text-[11px] text-muted-foreground">
            Sent as the X-Gitlab-Token header so the endpoint can verify the
            sender.
          </p>
        </div>
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="gl-hook-ssl" className="text-xs">
            Verify the endpoint's SSL certificate
          </Label>
          <Switch
            id="gl-hook-ssl"
            checked={sslVerify}
            onCheckedChange={setSslVerify}
          />
        </div>
        <div className="space-y-1.5">
          <p className="text-xs font-medium">Trigger events</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {GL_EVENTS.map((e) => (
              <Label
                key={e.id}
                className="flex items-center gap-1.5 text-xs font-normal"
              >
                <Checkbox
                  checked={events.includes(e.id)}
                  onCheckedChange={(v) => toggleEvent(e.id, v === true)}
                />
                {e.label}
              </Label>
            ))}
          </div>
        </div>
        {warning && <p className="text-[11px] text-warning">{warning}</p>}
        <div className="flex items-center justify-end gap-2 border-t pt-3">
          <Button variant="outline" size="sm" onClick={onDone}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSave} onClick={save}>
            {pending && <Spinner data-icon="inline-start" />}
            {hook ? "Save changes" : "Create webhook"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function HookDeliveries({
  repoPath,
  hook,
  onBack,
}: {
  repoPath: string;
  hook: GitLabHook;
  onBack: () => void;
}) {
  const events = useGlHookEvents(repoPath, hook.id);
  const resend = useGlResendHookEvent(repoPath, hook.id);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function handleResend(eventId: string) {
    try {
      await resend.mutateAsync(eventId);
      toast.success("Delivery re-sent");
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <CaretLeftIcon data-icon="inline-start" />
          Back to webhooks
        </Button>
        <p
          className="min-w-0 truncate font-mono text-[11px] text-muted-foreground"
          title={hook.url}
        >
          {hook.url}
        </p>
      </div>

      <AsyncListBody
        loading={events.isPending}
        error={events.error}
        empty={events.data?.length === 0}
        emptyLabel="No deliveries recorded yet — send a test event."
        skeletonClassName="h-10 w-full"
        errorTitle="Couldn't load the delivery log."
      >
        {events.data?.map((d) => (
          <DeliveryRow
            key={d.id}
            delivery={d}
            expanded={expanded === d.id}
            onToggle={() => setExpanded(expanded === d.id ? null : d.id)}
            resending={resend.isPending}
            onResend={() => handleResend(d.id)}
          />
        ))}
      </AsyncListBody>
    </div>
  );
}

function DeliveryRow({
  delivery,
  expanded,
  onToggle,
  resending,
  onResend,
}: {
  delivery: GitLabHookDelivery;
  expanded: boolean;
  onToggle: () => void;
  resending: boolean;
  onResend: () => void;
}) {
  const ok =
    delivery.responseStatus.startsWith("2") ||
    delivery.responseStatus.startsWith("3");
  const showDeliveryTime =
    !!delivery.createdAt && parseableDate(delivery.createdAt);
  return (
    <div className="rounded-md border text-xs">
      <div className="flex items-center gap-2 p-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
          onClick={onToggle}
          aria-expanded={expanded}
        >
          <Badge variant={ok ? "secondary" : "destructive"}>
            {delivery.responseStatus || "—"}
          </Badge>
          <span className="truncate font-mono">{delivery.trigger}</span>
          <span className="ml-auto shrink-0 text-muted-foreground">
            {/* The "·" belongs to the pair, not to the duration — it renders
                only when both sides do, so neither one alone leaves it hanging. */}
            {delivery.duration > 0 ? `${delivery.duration.toFixed(2)}s` : ""}
            {delivery.duration > 0 && showDeliveryTime ? " · " : ""}
            {showDeliveryTime ? (
              <RelativeTime date={delivery.createdAt} />
            ) : null}
          </span>
        </button>
        <Button
          size="sm"
          variant="ghost"
          title="Re-send this delivery"
          disabled={resending}
          onClick={onResend}
        >
          <ArrowClockwiseIcon />
        </Button>
      </div>
      {expanded && (
        <div className="space-y-2 border-t p-2">
          <DeliveryPayload
            label="Request payload"
            body={delivery.requestPayload}
          />
          <DeliveryPayload label="Response" body={delivery.responsePayload} />
        </div>
      )}
    </div>
  );
}
