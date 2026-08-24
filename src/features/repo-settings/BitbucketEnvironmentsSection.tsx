import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import {
  useBbEnvironments,
  useBbPipelinesConfig,
  useBbRepoSettings,
  useBbSetPipelinesEnabled,
} from "@/lib/git/queries";
import type { BbEnvironment } from "@/lib/git/types";
import { toastError } from "@/lib/toast";
import {
  PipelinesConfigErrorCard,
  PipelinesDisabledBanner,
} from "./BitbucketVariablesSection";
import { AsyncListBody } from "./parts";

/** Bitbucket deployment environments (read-only). Environments are created and
 *  managed on Bitbucket — there's no create/edit here — so this section just
 *  lists them (rank-sorted server-side) with a link out to manage on the web.
 *  Same pipelines-disabled banner as variables/schedules: deployments can't
 *  exist until pipelines are enabled. */
export function BitbucketEnvironmentsSection({
  repoPath,
  open,
}: {
  repoPath: string;
  open: boolean;
}) {
  const config = useBbPipelinesConfig(repoPath, open);
  const setEnabled = useBbSetPipelinesEnabled(repoPath);
  const enabled = config.data?.enabled ?? false;
  const environments = useBbEnvironments(repoPath, open && enabled);
  const settings = useBbRepoSettings(repoPath, open);
  const webUrl = settings.data?.webUrl;

  // Awaited, not per-call callbacks: this subtree unmounts when the dialog
  // closes or the rail crossfades to another section, and react-query drops
  // per-call callbacks on unmount — the outcome would never reach the user.
  async function handleEnablePipelines() {
    try {
      await setEnabled.mutateAsync(true);
      toast.success("Pipelines enabled");
    } catch (e) {
      toastError(e);
    }
  }

  if (config.isError && !config.data) {
    return <PipelinesConfigErrorCard error={config.error} />;
  }

  if (config.data && !enabled) {
    return (
      <PipelinesDisabledBanner
        pending={setEnabled.isPending}
        onEnable={handleEnablePipelines}
      />
    );
  }

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Deployment environments for Pipelines. Managed on Bitbucket.
        </p>
        {webUrl && (
          <button
            type="button"
            className="flex shrink-0 cursor-pointer items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
            onClick={() =>
              openUrl(
                `${webUrl}/admin/addon/admin/pipelines/deployment-settings`,
              )
            }
          >
            Manage on Bitbucket…
            <ArrowSquareOutIcon className="size-3 shrink-0" />
          </button>
        )}
      </div>

      <AsyncListBody
        loading={environments.isPending}
        error={environments.error}
        empty={environments.data?.length === 0}
        emptyLabel="No deployment environments."
        skeletonClassName="h-11 w-full"
        errorTitle="Couldn't load environments"
        errorHint="Viewing deployment environments needs admin on this repository."
      >
        {environments.data?.map((env) => (
          <EnvironmentRow key={env.uuid} environment={env} />
        ))}
      </AsyncListBody>
    </div>
  );
}

function EnvironmentRow({ environment }: { environment: BbEnvironment }) {
  const showType =
    environment.environmentType.length > 0 &&
    environment.environmentType !== environment.name;
  return (
    <div className="flex items-center gap-2 rounded-md border p-2 text-xs">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={environment.name}>
          {environment.name}
        </p>
        {showType && (
          <p className="mt-0.5 truncate text-muted-foreground">
            {environment.environmentType}
          </p>
        )}
      </div>
      {environment.hidden && (
        <span className="shrink-0 text-muted-foreground">Not yet used</span>
      )}
      {environment.adminOnly && (
        <span className="shrink-0 text-muted-foreground">
          Admin-only deploys
        </span>
      )}
    </div>
  );
}
