import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { toast } from "sonner";
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
import { Switch } from "@/components/ui/switch";
import {
  useBranches,
  useDisablePages,
  useEnablePages,
  usePages,
  useUpdatePages,
} from "@/lib/git/queries";
import type { PagesInfo } from "@/lib/git/types";
import { toastError } from "@/lib/toast";
import { InlineConfirm } from "./parts";

const PATHS = ["/", "/docs"];

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

  if (pages.isLoading) {
    return (
      <div className="min-w-0 space-y-3">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }
  if (pages.isError) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
        <p className="font-medium text-destructive">Couldn't load Pages.</p>
        <p className="mt-1 text-muted-foreground">
          {pages.error instanceof Error
            ? pages.error.message
            : "This needs repo-admin access."}
        </p>
      </div>
    );
  }

  return pages.data ? (
    <PagesEnabled
      key={pages.dataUpdatedAt}
      repoPath={repoPath}
      pages={pages.data}
    />
  ) : (
    <PagesDisabled repoPath={repoPath} />
  );
}

function PagesDisabled({ repoPath }: { repoPath: string }) {
  const branches = useBranches(repoPath);
  const enable = useEnablePages(repoPath);
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
                <SelectValue placeholder="Pick a branch" />
              </SelectTrigger>
              <SelectContent>
                {branchNames.map((b) => (
                  <SelectItem key={b} value={b}>
                    <span className="block truncate">{b}</span>
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
      <Button size="sm" disabled={!canEnable} onClick={handleEnable}>
        {enable.isPending && <Spinner data-icon="inline-start" />}
        Enable Pages
      </Button>
    </div>
  );
}

function PagesEnabled({
  repoPath,
  pages,
}: {
  repoPath: string;
  pages: PagesInfo;
}) {
  const branches = useBranches(repoPath);
  const update = useUpdatePages(repoPath);
  const disable = useDisablePages(repoPath);
  const [branch, setBranch] = useState(pages.sourceBranch);
  const [path, setPath] = useState(pages.sourcePath || "/");
  const [cname, setCname] = useState(pages.cname);
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
  const sourceChanged =
    branch !== pages.sourceBranch || path !== (pages.sourcePath || "/");
  // HTTPS can only be enforced once GitHub has issued the TLS certificate for a
  // custom domain. Without a custom domain (default *.github.io) there's no
  // certificate object at all and HTTPS is always available, so never gate on it.
  const certReady = !pages.cname || pages.httpsCertificateState === "approved";
  const certFailed =
    pages.httpsCertificateState === "errored" ||
    pages.httpsCertificateState === "bad_authz";
  const httpsHint = certReady
    ? undefined
    : certFailed
      ? "HTTPS certificate provisioning failed — check the domain's DNS configuration"
      : "Waiting for the HTTPS certificate to be issued for this domain";

  async function handleUpdateSource() {
    try {
      await update.mutateAsync({ buildType: "legacy", branch, path });
      toast.success("Source updated");
    } catch (e) {
      toastError(e);
    }
  }

  async function handleSaveDomain() {
    try {
      await update.mutateAsync({ cname });
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
        <div className="space-y-1.5">
          <Label>Source</Label>
          <div className="flex items-end gap-2">
            <Select value={branch} onValueChange={(v) => v && setBranch(v)}>
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Branch" />
              </SelectTrigger>
              <SelectContent>
                {branchNames.map((b) => (
                  <SelectItem key={b} value={b}>
                    <span className="block truncate">{b}</span>
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
            <Button
              size="sm"
              variant="outline"
              disabled={!sourceChanged || !branch || update.isPending}
              onClick={handleUpdateSource}
            >
              Update
            </Button>
          </div>
        </div>
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
          <Button
            size="sm"
            variant="outline"
            disabled={cname === pages.cname || update.isPending}
            onClick={handleSaveDomain}
          >
            Save
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Point your DNS at GitHub Pages, then add the domain here.
        </p>
      </div>

      <label className="flex cursor-pointer items-center justify-between gap-3 text-xs">
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
        <span title={certReady ? undefined : httpsHint} className="inline-flex">
          <Switch
            checked={pages.httpsEnforced}
            disabled={update.isPending || !certReady}
            onCheckedChange={handleHttpsEnforced}
          />
        </span>
      </label>

      <div className="flex items-center justify-end gap-2 border-t pt-3">
        {confirmingDisable ? (
          <InlineConfirm
            prompt="Take the site down?"
            promptClassName="mr-auto text-xs"
            actLabel="Disable Pages"
            pending={disable.isPending}
            onCancel={() => setConfirmingDisable(false)}
            onAct={handleDisable}
          />
        ) : (
          <Button
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
