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
 * yields `{ providers: [], settled: true }` when false) — pass `false`
 * whenever the caller's branch can't publish so the probe doesn't run. Hooks
 * are called unconditionally so this is safe to invoke at the top level
 * regardless of `enabled`. `settled` is false until both probes have answered
 * (data or error): an empty list before then means "not known yet", never
 * "nobody signed in".
 */
export function usePublishProviders(
  repoPath: string,
  enabled: boolean,
): { providers: PublishProvider[]; settled: boolean } {
  const gh = useForgeStatus(repoPath);
  const targets = usePublishTargets(repoPath, enabled);
  if (!enabled) return { providers: [], settled: true };
  const settled =
    (gh.data !== undefined || gh.isError) &&
    (targets.data !== undefined || targets.isError);

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
  return {
    providers: ready
      .filter((p) => p.ready)
      .map(({ id, label }) => ({ id, label })),
    settled,
  };
}

/**
 * The single "Publish repository…" affordance shared by the sync bar
 * (SyncControls) and the tab empty states (ForgeNotReady), so the two can't
 * drift. Renders a plain button when exactly one provider can publish, a caret
 * DropdownMenu when 2+ can, and — only when `disabledTitle` is supplied — a
 * disabled button carrying it as its reason when none can. The single and
 * disabled arms share one DisabledReasonButton node, so focus survives a
 * disabled → single settle; the dropdown arm is its own trigger and remounts.
 * `reserveCaret` gives every arm the dropdown's width (an invisible caret where
 * no real one shows), for a host whose neighbours must not move.
 * Owns the publish dialog itself.
 */
export function PublishRepoControl({
  repoPath,
  providers,
  disabledTitle,
  reserveCaret = false,
}: {
  repoPath: string;
  providers: PublishProvider[];
  disabledTitle?: string;
  reserveCaret?: boolean;
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
  // `data-icon="inline-end"` keeps the size's trailing-icon padding, so the
  // placeholder matches the real caret's footprint exactly.
  const caretSpace = reserveCaret ? (
    <CaretDownIcon data-icon="inline-end" aria-hidden className="invisible" />
  ) : null;

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
      ) : soleTarget || disabledTitle ? (
        <DisabledReasonButton
          variant="outline"
          size="sm"
          disabled={!soleTarget}
          reason={soleTarget ? undefined : disabledTitle}
          onClick={() => soleTarget && openPublish(soleTarget.id)}
          title={
            soleTarget
              ? `Create a ${soleTarget.label} repository and push this one`
              : undefined
          }
        >
          <UploadSimpleIcon data-icon="inline-start" />
          Publish repository…
          {caretSpace}
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
