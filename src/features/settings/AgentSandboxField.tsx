import { CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  buildCustomImage,
  type ContainerStatus,
  customImageStatus,
  prepareContainerSandbox,
  scaffoldCustomDockerfile,
} from "@/lib/ai/sandbox";
import { useContainerStatus } from "@/lib/ai/sandbox-queries";
import { toastError } from "@/lib/toast";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

type AgentId = "claude" | "codex" | "opencode" | "copilot";

/** Node base-image versions offered (current LTS first). */
const NODE_VERSIONS = ["24", "22", "20"];
/** Container-capable agents installed into the managed image. */
const IMAGE_AGENTS: { id: AgentId; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "opencode", label: "opencode" },
  { id: "copilot", label: "GitHub Copilot" },
];

/**
 * Opt-in control for running agent sessions inside a Docker/Podman container
 * (kernel-enforced filesystem confinement) instead of the host. When enabled it
 * also configures the managed image — the Node base version and which agent CLIs
 * to install — and offers Build / Rebuild (Rebuild pulls a fresh base + CLIs to
 * pick up updates). The image is stamped with its config so a stale one is
 * flagged for rebuild.
 */
export function AgentSandboxField({
  value,
  onChange,
  nodeVersion,
  onNodeVersion,
  providers,
  onProviders,
  repoPath,
}: {
  value: "worktree" | "container";
  onChange: (value: "worktree" | "container") => void;
  nodeVersion: string;
  onNodeVersion: (v: string) => void;
  providers: AgentId[];
  onProviders: (v: AgentId[]) => void;
  /** The open repo, for the per-repo custom-image row (null = no repo open). */
  repoPath: string | null;
}) {
  const enabled = value === "container";
  const status = useContainerStatus({ nodeVersion, providers, enabled });
  const queryClient = useQueryClient();
  const [building, setBuilding] = useState(false);

  async function buildImage(force: boolean) {
    setBuilding(true);
    try {
      await prepareContainerSandbox(nodeVersion, providers, force);
      toast.success(force ? "Agent image rebuilt" : "Agent image built");
      await queryClient.invalidateQueries({
        queryKey: ["agentContainerStatus"],
      });
    } catch (e) {
      toastError(e);
    } finally {
      setBuilding(false);
    }
  }

  const toggleProvider = (id: AgentId, on: boolean) => {
    const next = on
      ? Array.from(new Set([...providers, id]))
      : providers.filter((p) => p !== id);
    if (next.length === 0) return; // keep at least one agent in the image
    onProviders(next);
  };

  return (
    <div className="space-y-1.5">
      <label className="flex cursor-pointer items-center gap-2 text-xs">
        <Checkbox
          checked={enabled}
          onCheckedChange={(c) =>
            onChange(c === true ? "container" : "worktree")
          }
        />
        Run agent sessions in an isolated container
      </label>
      <p className="text-xs text-muted-foreground">
        Sessions normally run inside a throwaway git worktree only. Turn this on
        to also run each session inside an ephemeral Docker/Podman container, so
        the agent's file writes are confined to the worktree by the kernel — the
        strongest isolation. Applies to sessions started afterward; needs Docker
        or Podman installed, and each agent added to the image below.
      </p>
      {enabled && (
        <div className="space-y-2 pt-1">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
            <label className="flex items-center gap-1.5">
              <span className="text-muted-foreground">Node version</span>
              <Select
                value={nodeVersion}
                onValueChange={(v) => v && onNodeVersion(v)}
              >
                <SelectTrigger
                  size="sm"
                  aria-label="Node version"
                  className="w-auto"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NODE_VERSIONS.map((v) => (
                    <SelectItem key={v} value={v}>
                      {v === "24" ? `${v} (LTS)` : v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <div className="flex items-center gap-3">
              <span className="text-muted-foreground">Agents</span>
              {IMAGE_AGENTS.map((a) => {
                const on = providers.includes(a.id);
                return (
                  <label
                    key={a.id}
                    className="flex cursor-pointer items-center gap-1.5"
                  >
                    <Checkbox
                      checked={on}
                      // Can't uncheck the last remaining agent.
                      disabled={on && providers.length === 1}
                      onCheckedChange={(c) => toggleProvider(a.id, c === true)}
                    />
                    {a.label}
                  </label>
                );
              })}
            </div>
          </div>
          <StatusLine
            status={status.data}
            loading={status.isLoading}
            building={building}
            onBuild={buildImage}
          />
          {repoPath && (
            <CustomImageSection
              repoPath={repoPath}
              basePresent={!!status.data?.imagePresent}
            />
          )}
        </div>
      )}
    </div>
  );
}

function StatusLine({
  status,
  loading,
  building,
  onBuild,
}: {
  status: ContainerStatus | undefined;
  loading: boolean;
  building: boolean;
  onBuild: (force: boolean) => void;
}) {
  const buildBtn = (label: string, force: boolean) => (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={building}
      onClick={() => onBuild(force)}
      className="ml-2"
    >
      {building ? (
        <>
          <Spinner className="size-3" />
          {force ? "Rebuilding…" : "Building…"}
        </>
      ) : (
        label
      )}
    </Button>
  );

  if (loading) {
    return <Row tone="muted">Checking for Docker / Podman…</Row>;
  }
  if (!status || !status.runtime) {
    return (
      <Row tone="warn">
        No Docker or Podman found. Sessions still run on the host
        (worktree-confined — Codex via its own OS sandbox); container isolation
        needs Docker or Podman installed.
      </Row>
    );
  }
  if (!status.ready) {
    return (
      <Row tone="warn">
        {cap(status.runtime)} is installed but its engine isn't running. Start
        it, then reopen Settings.
      </Row>
    );
  }
  if (!status.imagePresent) {
    return (
      <Row tone="muted">
        {cap(status.runtime)} ready — build the agent image once.
        {buildBtn("Build image", false)}
      </Row>
    );
  }
  if (!status.imageMatches) {
    return (
      <Row tone="warn">
        The built image doesn't match this Node version / agent selection —
        rebuild to apply.
        {buildBtn("Rebuild", true)}
      </Row>
    );
  }
  return (
    <Row tone="ok">
      {cap(status.runtime)} ready, image built — new sessions run in a
      container.
      {buildBtn("Rebuild to update", true)}
    </Row>
  );
}

/** A status line: icon + text (never color alone). */
function Row({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "muted";
  children: React.ReactNode;
}) {
  const Icon = tone === "ok" ? CheckCircleIcon : WarningCircleIcon;
  // Success uses the app's green (matching the provider "Connected" line);
  // warnings stay full-contrast; informational lines are muted.
  const toneClass =
    tone === "ok"
      ? "text-success"
      : tone === "warn"
        ? "text-foreground"
        : "text-muted-foreground";
  return (
    <p className={`flex items-center gap-1.5 text-[11px] ${toneClass}`}>
      {tone !== "muted" && (
        <Icon weight="fill" className="size-3.5 shrink-0" aria-hidden />
      )}
      <span>{children}</span>
    </p>
  );
}

/** A compact `size="xs"` action button matching the base-image line's build buttons. */
function ActionButton({
  label,
  busyLabel,
  loading,
  disabled,
  onClick,
}: {
  label: string;
  busyLabel?: string;
  loading?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      className="ml-2 shrink-0"
      disabled={disabled}
      onClick={onClick}
    >
      {loading ? (
        <>
          <Spinner className="size-3" />
          {busyLabel ?? "Working…"}
        </>
      ) : (
        label
      )}
    </Button>
  );
}

/**
 * A per-repo custom-image status line, shown below the base-image line when the active repo
 * ships a `.gitdesktop/agent.Dockerfile`. Mirrors the `Row` idiom (icon + text, never color
 * alone). The build runs the Dockerfile's arbitrary commands, so it is gated behind a review
 * dialog — the confirm-to-build guard against an untrusted repo.
 */
function CustomImageSection({
  repoPath,
  basePresent,
}: {
  repoPath: string;
  /** Whether the managed base image is built — the custom image is `FROM` it, so a build
   *  can't run until it exists. Scaffolding/reviewing stays available regardless. */
  basePresent: boolean;
}) {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ["agentCustomImage", repoPath],
    queryFn: () => customImageStatus(repoPath),
    staleTime: 30_000,
  });
  const [busy, setBusy] = useState<"scaffold" | "build" | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["agentCustomImage", repoPath] });

  async function scaffold() {
    setBusy("scaffold");
    try {
      const created = await scaffoldCustomDockerfile(repoPath);
      toast.success(
        created
          ? "Added .gitdesktop/agent.Dockerfile — edit it to add tools, then build the image"
          : ".gitdesktop/agent.Dockerfile already exists",
      );
      await refresh();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  }

  async function build(force: boolean) {
    setBusy("build");
    try {
      // Pass the reviewed contents so the backend refuses to build if the file changed on
      // disk since the dialog opened (only ever build what the user actually saw).
      await buildCustomImage(repoPath, status.data?.dockerfile ?? "", force);
      toast.success(force ? "Custom image rebuilt" : "Custom image built");
      setReviewOpen(false);
      await refresh();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  }

  const data = status.data;
  if (!data) return null; // first load — the base line above already carries the state

  if (data.state === "none") {
    return (
      <Row tone="muted">
        This repo uses the base image. Add a custom Dockerfile to layer extra
        tools (e.g. Playwright) into its container sessions.
        <ActionButton
          label="Add custom tools…"
          busyLabel="Adding…"
          loading={busy === "scaffold"}
          disabled={busy !== null}
          onClick={scaffold}
        />
      </Row>
    );
  }

  const built = data.state === "built";
  const invalid = data.state === "invalid";
  const canBuild = !invalid; // "needsBuild" or "built"

  return (
    <>
      <Row tone={built ? "ok" : invalid ? "warn" : "muted"}>
        {invalid
          ? "This repo's .gitdesktop/agent.Dockerfile can't be used as-is — open it to see why."
          : built
            ? "Container sessions for this repo run in its custom image."
            : "This repo has a custom Dockerfile that isn't built yet."}
        <ActionButton
          label={
            invalid
              ? "View Dockerfile"
              : built
                ? "View / Rebuild…"
                : "Review & build…"
          }
          disabled={busy !== null}
          onClick={() => setReviewOpen(true)}
        />
      </Row>
      <ReviewDialog
        open={reviewOpen}
        onOpenChange={(o) => {
          if (busy !== "build") setReviewOpen(o);
        }}
        dockerfile={data.dockerfile ?? ""}
        error={data.error}
        canBuild={canBuild}
        basePresent={basePresent}
        built={built}
        building={busy === "build"}
        onBuild={() => build(built)}
      />
    </>
  );
}

/** The confirm-to-build review dialog: shows the Dockerfile (read-only) + a trust caution
 *  before running its build commands. The build action is omitted for an invalid file. */
function ReviewDialog({
  open,
  onOpenChange,
  dockerfile,
  error,
  canBuild,
  basePresent,
  built,
  building,
  onBuild,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dockerfile: string;
  error: string | null;
  canBuild: boolean;
  basePresent: boolean;
  built: boolean;
  building: boolean;
  onBuild: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {built ? "Rebuild custom agent image" : "Build custom agent image"}
          </DialogTitle>
          <DialogDescription>
            This builds a per-repo image from .gitdesktop/agent.Dockerfile and
            runs the commands in it. Only build repositories you trust.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p className="flex items-start gap-1.5 text-xs text-foreground">
            <WarningCircleIcon
              weight="fill"
              className="mt-0.5 size-3.5 shrink-0"
              aria-hidden
            />
            <span>{error}</span>
          </p>
        )}
        <pre className="max-h-72 overflow-auto whitespace-pre rounded-md border border-border bg-muted/50 p-3 font-mono text-[11px] leading-relaxed">
          {dockerfile}
        </pre>
        {canBuild && !basePresent && (
          <p className="flex items-start gap-1.5 text-xs text-foreground">
            <WarningCircleIcon
              weight="fill"
              className="mt-0.5 size-3.5 shrink-0"
              aria-hidden
            />
            <span>
              Build the base agent image first (the line above this one in
              Settings), then build this custom image.
            </span>
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={building}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          {canBuild && (
            <Button
              type="button"
              size="sm"
              disabled={building || !basePresent}
              onClick={onBuild}
            >
              {building ? (
                <>
                  <Spinner className="size-3" />
                  {built ? "Rebuilding…" : "Building…"}
                </>
              ) : built ? (
                "Rebuild (no cache)"
              ) : (
                "Build image"
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
