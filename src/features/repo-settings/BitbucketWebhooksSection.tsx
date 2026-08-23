import {
  CaretLeftIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  useBbCreateHook,
  useBbDeleteHook,
  useBbHooks,
  useBbUpdateHook,
} from "@/lib/git/queries";
import type { BitbucketHook } from "@/lib/git/types";
import { toastError } from "@/lib/toast";
import { AsyncListBody, InlineConfirm } from "./parts";

/** Bitbucket's webhook events, curated to the ones people wire, in display
 *  order. */
const BB_EVENTS: { id: string; label: string }[] = [
  { id: "repo:push", label: "Push" },
  { id: "pullrequest:created", label: "PR created" },
  { id: "pullrequest:updated", label: "PR updated" },
  { id: "pullrequest:approved", label: "PR approved" },
  { id: "pullrequest:unapproved", label: "PR approval removed" },
  { id: "pullrequest:changes_request_created", label: "Changes requested" },
  { id: "pullrequest:fulfilled", label: "PR merged" },
  { id: "pullrequest:rejected", label: "PR declined" },
  { id: "pullrequest:comment_created", label: "PR comment" },
  { id: "repo:commit_comment_created", label: "Commit comment" },
];

function eventsSummary(events: string[]): string {
  if (events.length === 0) return "No events";
  const labels = events.map(
    (e) => BB_EVENTS.find((c) => c.id === e)?.label ?? e,
  );
  if (labels.length <= 3) return labels.join(", ");
  return `${labels.slice(0, 3).join(", ")} +${labels.length - 3}`;
}

/** The Bitbucket counterpart of the webhooks section: hook CRUD only —
 *  Bitbucket has no delivery-log API, so there's no deliveries view. */
export function BitbucketWebhooksSection({
  repoPath,
  open,
}: {
  repoPath: string;
  open: boolean;
}) {
  const hooks = useBbHooks(repoPath, open);
  const deleteHook = useBbDeleteHook(repoPath);
  // null = list; "new" = create form; a hook = edit form.
  const [editing, setEditing] = useState<BitbucketHook | "new" | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  // Awaited, not per-call callbacks: this subtree unmounts when the dialog
  // closes or the rail crossfades to another section, and react-query drops
  // per-call callbacks on unmount — the outcome would never reach the user.
  async function handleDelete(uuid: string) {
    try {
      await deleteHook.mutateAsync(uuid);
      toast.success("Webhook deleted");
      setConfirming(null);
    } catch (e) {
      toastError(e);
    }
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
          Webhooks Bitbucket fires for this repository's events.
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
        errorHint="Managing webhooks needs admin on this repository."
      >
        {hooks.data?.map((h) => (
          <div key={h.uuid} className="rounded-md border p-2 text-xs">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono font-medium" title={h.url}>
                  {h.url}
                </p>
                <p className="mt-0.5 text-muted-foreground">
                  {h.description ? `${h.description} · ` : ""}
                  {eventsSummary(h.events)}
                </p>
              </div>
              {!h.active && (
                <Badge variant="secondary" title="This webhook is inactive.">
                  inactive
                </Badge>
              )}
              {confirming === h.uuid ? (
                <InlineConfirm
                  prompt="Delete?"
                  actLabel="Delete"
                  pending={deleteHook.isPending}
                  onCancel={() => setConfirming(null)}
                  onAct={() => handleDelete(h.uuid)}
                />
              ) : (
                <>
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
                    onClick={() => setConfirming(h.uuid)}
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
  hook: BitbucketHook | null;
  onDone: () => void;
}) {
  const create = useBbCreateHook(repoPath);
  const update = useBbUpdateHook(repoPath);
  const [url, setUrl] = useState(hook?.url ?? "");
  const [description, setDescription] = useState(hook?.description ?? "");
  const [active, setActive] = useState(hook?.active ?? true);
  const [skipCertVerification, setSkipCertVerification] = useState(
    hook?.skipCertVerification ?? false,
  );
  const [events, setEvents] = useState<string[]>(hook?.events ?? ["repo:push"]);

  const pending = create.isPending || update.isPending;
  const urlValid =
    url.trim().startsWith("https://") || url.trim().startsWith("http://");
  const canSave = urlValid && events.length > 0 && !pending;
  const warning =
    events.length === 0
      ? "Select at least one event."
      : !urlValid
        ? "The payload URL must start with http:// or https://."
        : null;

  function toggleEvent(id: string, on: boolean) {
    setEvents((prev) => (on ? [...prev, id] : prev.filter((e) => e !== id)));
  }

  async function save() {
    // Bitbucket requires the FULL shape on a PUT (a partial 400s), so create
    // and update send identical inputs.
    const input = {
      url: url.trim(),
      description: description.trim(),
      active,
      events,
      skipCertVerification,
    };
    try {
      if (hook) await update.mutateAsync({ uuid: hook.uuid, input });
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
          <Label htmlFor="bb-hook-url">Payload URL</Label>
          <Input
            id="bb-hook-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/hook"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bb-hook-description">Description</Label>
          <Input
            id="bb-hook-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this webhook is for"
            autoComplete="off"
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="bb-hook-active" className="text-xs">
            Active
          </Label>
          <Switch
            id="bb-hook-active"
            checked={active}
            onCheckedChange={setActive}
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="bb-hook-skip-cert" className="text-xs">
            Skip certificate verification
          </Label>
          <Switch
            id="bb-hook-skip-cert"
            checked={skipCertVerification}
            onCheckedChange={setSkipCertVerification}
          />
        </div>
        {skipCertVerification && (
          <p className="text-[11px] text-warning">
            TLS certificate verification will be skipped for deliveries —
            payloads could be intercepted. Only enable for a trusted endpoint
            you control.
          </p>
        )}
        <div className="space-y-1.5">
          <p className="text-xs font-medium">Trigger events</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {BB_EVENTS.map((e) => (
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
