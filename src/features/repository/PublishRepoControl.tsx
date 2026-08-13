import { CaretDownIcon, UploadSimpleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useForgeStatus, usePublishTargets } from "@/lib/git/queries";
import { useUiStore } from "@/lib/stores/ui";
import { PublishDialog } from "./PublishDialog";

type PublishProviderId = "github" | "gitlab" | "bitbucket";

export interface PublishProvider {
  id: PublishProviderId;
  label: string;
}

/**
 * The READY publish providers for an origin-less repo, in a stable GitHub →
 * GitLab → Bitbucket order. `enabled` gates the underlying targets probe (and
 * yields `[]` when false) — pass `false` whenever the caller's branch can't
 * publish so the probe doesn't run. Hooks are called unconditionally so this is
 * safe to invoke at the top level regardless of `enabled`.
 */
export function usePublishProviders(
  repoPath: string,
  enabled: boolean,
): PublishProvider[] {
  const gh = useForgeStatus(repoPath);
  const targets = usePublishTargets(repoPath, enabled);
  if (!enabled) return [];

  // GitHub stays eligible off the (warm) CLI status while the explicit probe is
  // still in flight, matching the pre-generalized behavior — avoids a flash of
  // disabled for the common GitHub case.
  const ghCliReady = Boolean(gh.data?.installed && gh.data?.authenticated);
  const ready: Array<PublishProvider & { ready: boolean | undefined }> = [
    {
      id: "github",
      label: "GitHub",
      ready: ghCliReady || targets.data?.github,
    },
    { id: "gitlab", label: "GitLab", ready: targets.data?.gitlab },
    { id: "bitbucket", label: "Bitbucket", ready: targets.data?.bitbucket },
  ];
  return ready.filter((p) => p.ready).map(({ id, label }) => ({ id, label }));
}

/**
 * The single "Publish repository…" affordance shared by the sync bar
 * (SyncControls) and the tab empty states (ForgeNotReady), so the two can't
 * drift. Renders a plain button when exactly one provider can publish, a caret
 * DropdownMenu when 2+ can, and — only when `disabledTitle` is supplied — a
 * disabled button (wrapped in a `<span title>`, since `title` on a natively
 * disabled Button never shows) when none can. Owns the publish dialog itself.
 */
export function PublishRepoControl({
  repoPath,
  providers,
  disabledTitle,
}: {
  repoPath: string;
  providers: PublishProvider[];
  disabledTitle?: string;
}) {
  const repoName = useUiStore((s) => s.repoName);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishProvider, setPublishProvider] =
    useState<PublishProviderId>("github");

  function openPublish(provider: PublishProviderId) {
    setPublishProvider(provider);
    setPublishOpen(true);
  }

  const soleTarget = providers[0];

  return (
    <>
      {providers.length >= 2 ? (
        // Multiple CLIs/accounts are ready: the button becomes a provider choice.
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
            <UploadSimpleIcon data-icon="inline-start" />
            Publish repository…
            <CaretDownIcon data-icon="inline-end" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {providers.map((p) => (
              <DropdownMenuItem key={p.id} onClick={() => openPublish(p.id)}>
                Publish to {p.label}…
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : soleTarget ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => openPublish(soleTarget.id)}
          title={`Create a ${soleTarget.label} repository and push this one`}
        >
          <UploadSimpleIcon data-icon="inline-start" />
          Publish repository…
        </Button>
      ) : disabledTitle ? (
        <DisabledReasonButton
          variant="outline"
          size="sm"
          disabled
          reason={disabledTitle}
        >
          <UploadSimpleIcon data-icon="inline-start" />
          Publish repository…
        </DisabledReasonButton>
      ) : null}
      <PublishDialog
        repoPath={repoPath}
        provider={publishProvider}
        defaultName={repoName ?? ""}
        open={publishOpen}
        onOpenChange={setPublishOpen}
      />
    </>
  );
}
