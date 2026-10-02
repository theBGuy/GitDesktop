import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { LabeledGroup } from "@/components/form/labeled-group";
import { SelectClipText } from "@/components/select-clip-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { clipTitleFromText } from "@/lib/clip-title";
import {
  useBranches,
  useDisablePages,
  useEnablePages,
  usePages,
  useUpdatePages,
} from "@/lib/git/queries";
import type { PagesInfo } from "@/lib/git/types";
import { toastError } from "@/lib/toast";
import { useOnline } from "@/lib/use-online";
import {
  HeldSwitch,
  heldSwitchReason,
  InlineConfirm,
  OFFLINE_WRITE_REASON,
  RemoteFormSection,
  useConfirmSwapFocus,
} from "./parts";
import {
  type PendingSent,
  reconcileTouched,
  stampSent,
  type TouchedEdit,
} from "./touched-draft";

const PATHS = ["/", "/docs"];

/** The enabled form's editable fields, as its draft keys them. */
type PagesField = "branch" | "path" | "cname";

/** Labels for the source select — without them Base UI shows the raw value
 *  ("workflow") in the trigger; the popup renders from this map too, so the two
 *  can never drift. The branch/path selects label each option as itself. */
const MODE_ITEMS: Record<string, string> = {
  branch: "Deploy from a branch",
  workflow: "GitHub Actions",
};

export function PagesSection({
  repoPath,
  open,
}: {
  repoPath: string;
  open: boolean;
}) {
  const pages = usePages(repoPath, open);

  return (
    <RemoteFormSection
      query={pages}
      noun="Pages settings"
      skeleton={
        <div className="min-w-0 space-y-3">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      }
      errorTitle="Couldn't load Pages."
      errorHint="If this is a permissions error, managing Pages needs repo-admin access."
    >
      {(data) =>
        // `null` is a loaded answer: Pages isn't enabled.
        data ? (
          <PagesEnabled
            key={repoPath}
            repoPath={repoPath}
            pages={data}
            dataUpdatedAt={pages.dataUpdatedAt}
            isError={pages.isError}
          />
        ) : (
          <PagesDisabled repoPath={repoPath} />
        )
      }
    </RemoteFormSection>
  );
}

function PagesDisabled({ repoPath }: { repoPath: string }) {
  const branches = useBranches(repoPath);
  const enable = useEnablePages(repoPath);
  const online = useOnline();
  const [mode, setMode] = useState<"branch" | "workflow">("branch");
  const [branch, setBranch] = useState("");
  const [path, setPath] = useState("/");

  // Drop agent-session branches (`gd/session/*`) — they're app-internal. No source
  // is configured yet here (the branch state starts empty), so nothing to keep.
  const branchNames = (branches.data ?? [])
    .map((b) => b.name)
    .filter((n) => !n.startsWith("gd/session/"));
  const canEnable = (mode === "workflow" || !!branch) && !enable.isPending;

  // Awaited, not per-call callbacks: react-query drops those when this subtree
  // unmounts mid-flight — closing the dialog or switching the rail's section —
  // so the outcome would never reach the user.
  async function handleEnable() {
    try {
      await enable.mutateAsync({
        buildType: mode === "workflow" ? "workflow" : "legacy",
        branch: mode === "branch" ? branch : null,
        path: mode === "branch" ? path : null,
      });
      toast.success("GitHub Pages enabled");
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className="min-w-0 space-y-3">
      <p className="text-xs text-muted-foreground">
        GitHub Pages isn't enabled. Choose a source to publish your site.
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="pages-mode">Source</Label>
        <Select
          items={MODE_ITEMS}
          value={mode}
          onValueChange={(v) => v && setMode(v as "branch" | "workflow")}
        >
          <SelectTrigger id="pages-mode" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(MODE_ITEMS).map(([m, label]) => (
              <SelectItem key={m} value={m}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {mode === "branch" && (
        <div className="flex gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="pages-branch">Branch</Label>
            <Select value={branch} onValueChange={(v) => v && setBranch(v)}>
              <SelectTrigger id="pages-branch" className="w-44">
                <SelectValue
                  placeholder="Pick a branch"
                  onMouseEnter={clipTitleFromText}
                />
              </SelectTrigger>
              <SelectContent>
                {branchNames.map((b) => (
                  <SelectItem key={b} value={b}>
                    <SelectClipText>{b}</SelectClipText>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pages-path">Folder</Label>
            <Select value={path} onValueChange={(v) => v && setPath(v)}>
              <SelectTrigger id="pages-path" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PATHS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
      <DisabledReasonButton
        size="sm"
        disabled={!canEnable || !online}
        reason={online ? undefined : OFFLINE_WRITE_REASON}
        onClick={handleEnable}
      >
        {enable.isPending && <Spinner data-icon="inline-start" />}
        Enable Pages
      </DisabledReasonButton>
    </div>
  );
}

function PagesEnabled({
  repoPath,
  pages,
  dataUpdatedAt,
  isError,
}: {
  repoPath: string;
  pages: PagesInfo;
  /** When `pages` last loaded; a failed refetch doesn't advance it. */
  dataUpdatedAt: number;
  /** The read's last fetch failed; stays set through a refetch until one lands. */
  isError: boolean;
}) {
  const branches = useBranches(repoPath);
  const update = useUpdatePages(repoPath);
  const disable = useDisablePages(repoPath);
  const online = useOnline();
  const offlineReason = online ? undefined : OFFLINE_WRITE_REASON;
  const swapFocus = useConfirmSwapFocus();
  // An absent field shows the server's value. Touched fields retire per
  // `reconcileTouched` — never on the save itself, so a save whose refetch
  // failed keeps its values on screen.
  const [edit, setEdit] = useState<TouchedEdit<PagesField, string> | null>(
    null,
  );
  const [pending, setPending] = useState<PendingSent<
    PagesField,
    string
  > | null>(null);
  const server: Record<PagesField, string> = {
    branch: pages.sourceBranch,
    path: pages.sourcePath || "/",
    cname: pages.cname,
  };
  const reconciled = reconcileTouched({
    edit,
    server,
    pending,
    dataUpdatedAt,
    isError,
  });
  if (reconciled.edit !== edit) setEdit(reconciled.edit);
  if (reconciled.pending !== pending) setPending(reconciled.pending);
  const setField = (field: PagesField, value: string) =>
    setEdit((e) => ({ ...e, [field]: value }));
  const setBranch = (value: string) => setField("branch", value);
  const setPath = (value: string) => setField("path", value);
  const setCname = (value: string) => setField("cname", value);
  function markSent(at: number, sent: TouchedEdit<PagesField, string>) {
    setPending((p) => stampSent(p, at, sent));
  }
  const branch = edit?.branch ?? server.branch;
  const path = edit?.path ?? server.path;
  const cname = edit?.cname ?? server.cname;
  const [confirmingDisable, setConfirmingDisable] = useState(false);

  const isWorkflow = pages.buildType === "workflow";
  // Keep the currently-configured Pages source branch selectable even if it isn't
  // local or matches the filter; drop agent-session branches (`gd/session/*`) —
  // they're app-internal.
  const branchNames = (() => {
    const filtered = (branches.data ?? [])
      .map((b) => b.name)
      .filter((n) => !n.startsWith("gd/session/"));
    return pages.sourceBranch && !filtered.includes(pages.sourceBranch)
      ? [pages.sourceBranch, ...filtered]
      : filtered;
  })();
  const sourceChanged = branch !== server.branch || path !== server.path;
  // HTTPS can only be enforced once GitHub has issued the TLS certificate for a
  // custom domain. Without a custom domain (default *.github.io) there's no
  // certificate object at all and HTTPS is always available, so never gate on it.
  const certReady = !pages.cname || pages.httpsCertificateState === "approved";
  const certFailed =
    pages.httpsCertificateState === "errored" ||
    pages.httpsCertificateState === "bad_authz";
  const httpsHeld = (() => {
    switch (true) {
      case !certReady && certFailed:
        return "HTTPS certificate provisioning failed — check the domain's DNS configuration";
      case !certReady:
        return "Waiting for the HTTPS certificate to be issued for this domain";
      default:
        return offlineReason;
    }
  })();

  async function handleUpdateSource() {
    const at = dataUpdatedAt;
    try {
      await update.mutateAsync({ buildType: "legacy", branch, path });
      markSent(at, { branch, path });
      toast.success("Source updated");
    } catch (e) {
      toastError(e);
    }
  }

  async function handleSaveDomain() {
    const at = dataUpdatedAt;
    try {
      await update.mutateAsync({ cname });
      markSent(at, { cname });
      toast.success(cname ? "Domain saved" : "Domain removed");
    } catch (e) {
      toastError(e);
    }
  }

  async function handleHttpsEnforced(v: boolean) {
    try {
      await update.mutateAsync({ httpsEnforced: v });
      toast.success("Updated");
    } catch (e) {
      toastError(e);
    }
  }

  async function handleDisable() {
    try {
      await disable.mutateAsync(undefined);
      toast.success("GitHub Pages disabled");
      setConfirmingDisable(false);
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex items-center justify-between gap-2 rounded-md border p-3">
        <div className="min-w-0">
          {pages.htmlUrl ? (
            <button
              type="button"
              className="flex cursor-pointer items-center gap-1 truncate text-xs font-medium hover:underline"
              onClick={() => openUrl(pages.htmlUrl)}
            >
              {pages.htmlUrl}
              <ArrowSquareOutIcon className="size-3 shrink-0" />
            </button>
          ) : (
            <p className="text-xs text-muted-foreground">Not built yet.</p>
          )}
          <p className="text-[11px] text-muted-foreground">
            {isWorkflow ? "Built with GitHub Actions" : "Deploy from a branch"}
          </p>
        </div>
        {pages.status && (
          <Badge
            variant={pages.status === "errored" ? "destructive" : "secondary"}
          >
            {pages.status}
          </Badge>
        )}
      </div>

      {!isWorkflow && (
        <LabeledGroup label="Source" className="space-y-1.5">
          <div className="flex items-end gap-2">
            <Select value={branch} onValueChange={(v) => v && setBranch(v)}>
              <SelectTrigger className="w-44">
                <SelectValue
                  placeholder="Branch"
                  onMouseEnter={clipTitleFromText}
                />
              </SelectTrigger>
              <SelectContent>
                {branchNames.map((b) => (
                  <SelectItem key={b} value={b}>
                    <SelectClipText>{b}</SelectClipText>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={path} onValueChange={(v) => v && setPath(v)}>
              <SelectTrigger className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PATHS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <DisabledReasonButton
              size="sm"
              variant="outline"
              disabled={
                !sourceChanged || !branch || update.isPending || !online
              }
              reason={offlineReason}
              onClick={handleUpdateSource}
            >
              Update
            </DisabledReasonButton>
          </div>
        </LabeledGroup>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="pages-cname">Custom domain</Label>
        <div className="flex items-end gap-2">
          <Input
            id="pages-cname"
            value={cname}
            onChange={(e) => setCname(e.target.value)}
            placeholder="www.example.com"
            className="max-w-xs font-mono"
            autoComplete="off"
            spellCheck={false}
          />
          <DisabledReasonButton
            size="sm"
            variant="outline"
            disabled={cname === pages.cname || update.isPending || !online}
            reason={offlineReason}
            onClick={handleSaveDomain}
          >
            Save
          </DisabledReasonButton>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Point your DNS at GitHub Pages, then add the domain here.
        </p>
      </div>

      <label
        className="flex cursor-pointer items-center justify-between gap-3 text-xs"
        title={heldSwitchReason(httpsHeld, update.isPending)}
      >
        <span>
          Enforce HTTPS
          {!certReady && (
            <span className="ml-1 text-[11px] text-muted-foreground">
              {certFailed
                ? "(certificate provisioning failed)"
                : "(available once the certificate is ready)"}
            </span>
          )}
        </span>
        <HeldSwitch
          checked={pages.httpsEnforced}
          heldReason={httpsHeld}
          saving={update.isPending}
          inLabel
          onCheckedChange={handleHttpsEnforced}
        />
      </label>

      <div className="flex items-center justify-end gap-2 border-t pt-3">
        {confirmingDisable ? (
          <InlineConfirm
            prompt="Take the site down?"
            promptClassName="mr-auto text-xs"
            actLabel="Disable Pages"
            pending={disable.isPending}
            heldReason={offlineReason}
            swapFocusRef={swapFocus()}
            onCancel={() => setConfirmingDisable(false)}
            onAct={handleDisable}
          />
        ) : (
          <Button
            ref={swapFocus()}
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirmingDisable(true)}
          >
            Disable Pages
          </Button>
        )}
      </div>
    </div>
  );
}
