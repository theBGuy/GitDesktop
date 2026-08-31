import { SparkleIcon } from "@phosphor-icons/react";
import { useSelector } from "@tanstack/react-store";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useEffectEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { required, useAppForm } from "@/lib/form";
import {
  useBbWorkspaces,
  useGhPublishOwners,
  usePublishRepo,
} from "@/lib/git/queries";
import { useGenerateChord } from "@/lib/hotkeys/useGenerateChord";
import { useAiEnabled } from "@/lib/settings/queries";
import { toastError } from "@/lib/toast";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import { useGenerateRepoDescription } from "../repo-settings/useGenerateRepoDescription";

/** Bitbucket repo slugs must start alphanumeric, then allow dot/underscore/hyphen.
 *  A blank name is caught by the `required` validator, so don't double-flag it. */
const BB_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function bbSlugWarning(value: string): string | null {
  const name = value.trim();
  if (!name || BB_SLUG_RE.test(name)) return null;
  return "Only letters, numbers, and . _ - are allowed, starting with a letter or number.";
}

/** With the owner picker active the name is just the repository name: a slash
 *  means the old typed owner/name form, and a leading dash reads as a gh flag —
 *  a composed `owner/-x` slips past the backend's own leading-dash refusal. */
function ghNameWarning(value: string): string | null {
  if (value.includes("/")) {
    return "Choose the owner above instead of typing owner/name.";
  }
  if (value.trim().startsWith("-")) {
    return "A repository name can't start with a dash.";
  }
  return null;
}

/** Provider-specific inline hints on Name; GitLab's namespace needs none. */
const NAME_WARNINGS: Record<
  "github" | "gitlab" | "bitbucket",
  ((value: string) => string | null) | undefined
> = {
  github: ghNameWarning,
  gitlab: undefined,
  bitbucket: bbSlugWarning,
};

/** A field label with a muted second line — carries the reason a picker (and
 *  with it Publish) is disabled, which a disabled control can't hold itself. */
function StackedLabel({ label, hint }: { label: string; hint: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span>{label}</span>
      <span className="font-normal text-muted-foreground">{hint}</span>
    </span>
  );
}

/** Space/comma-separated text → GitHub's lowercase, deduped, capped topic list.
 *  Mirrors GeneralSettingsSection's parser (GitHub normalizes topics the same). */
function parseTopics(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((t) => t.toLowerCase().replace(/[^a-z0-9-]/g, ""))
        .filter(Boolean),
    ),
  ].slice(0, 20);
}

export function PublishDialog({
  repoPath,
  provider,
  defaultName,
  open,
  onOpenChange,
}: {
  repoPath: string;
  /** Chosen explicitly by the caller — an unpublished repo has no remote to
   *  detect a provider from. */
  provider: "github" | "gitlab" | "bitbucket";
  defaultName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const publish = usePublishRepo(repoPath);
  const aiEnabled = useAiEnabled();
  const descGen = useGenerateRepoDescription(repoPath);
  const isGitLab = provider === "gitlab";
  const isBitbucket = provider === "bitbucket";
  const isGitHub = provider === "github";
  const remoteLabel = isBitbucket
    ? "Bitbucket"
    : isGitLab
      ? "GitLab"
      : "GitHub";

  // Bitbucket creates the repo under a workspace; only workspaces the viewer can
  // administer can receive a new repo, so default to the first of those (else the
  // first workspace at all). Only fetched when the Bitbucket dialog is open.
  const workspaces = useBbWorkspaces(open && isBitbucket);
  const defaultWorkspace =
    workspaces.data?.find((w) => w.administrator)?.slug ??
    workspaces.data?.[0]?.slug ??
    "";
  // value ≠ label isn't a risk here (slug is both), but the Base UI Select still
  // needs an items map to render the closed trigger. The map can't carry the
  // order — an all-digit slug would sort to the front — so pass it separately.
  const workspaceSlugs = (workspaces.data ?? []).map((w) => w.slug);
  const workspaceItems = Object.fromEntries(workspaceSlugs.map((s) => [s, s]));

  // GitHub creates the repo under an owner — your account or an org. Only fetched
  // when the GitHub dialog is open. The typed `owner/name` fallback engages only
  // when the listing NEVER loaded: react-query keeps `data` across a failed
  // background refetch, and stale owners beat yanking the picker mid-edit.
  const owners = useGhPublishOwners(open && isGitHub);
  const ghPickerActive = isGitHub && !(owners.isError && !owners.data);
  const ownerLogins = owners.data
    ? [owners.data.viewer, ...owners.data.orgs.map((o) => o.login)]
    : [];
  const ownerItems = Object.fromEntries(ownerLogins.map((l) => [l, l]));
  // Orgs whose member policy (or the viewer's role) forbids creation are shown
  // disabled with the reason as row text — a 403 after submit explains nothing.
  const blockedOrgs = (owners.data?.orgs ?? []).filter((o) => !o.canCreate);
  const disabledOwners = new Set(blockedOrgs.map((o) => o.login));
  const ownerAnnotations = Object.fromEntries(
    blockedOrgs.map((o) => [
      o.login,
      <span className="shrink-0 text-[11px] text-muted-foreground">
        Can't create repositories
      </span>,
    ]),
  );

  const form = useAppForm({
    defaultValues: {
      name: defaultName,
      description: "",
      homepage: "",
      topics: "",
      workspace: "",
      owner: "",
      isPrivate: true,
    },
    onSubmit: async ({ value }) => {
      const name = value.name.trim();
      // The publish backend takes `owner/repo` in `name`; compose it only for an
      // org — the viewer's own login publishes under the bare name.
      const target =
        ghPickerActive && value.owner && value.owner !== owners.data?.viewer
          ? `${value.owner}/${name}`
          : name;
      try {
        const url = await publish.mutateAsync({
          provider,
          name: target,
          isPrivate: value.isPrivate,
          description: value.description,
          homepage: value.homepage.trim(),
          topics: parseTopics(value.topics),
          workspace: isBitbucket ? value.workspace : undefined,
        });
        toast.success(`Published ${target}`, {
          description: url,
          action: { label: "View", onClick: () => openUrl(url) },
        });
        onOpenChange(false);
      } catch (e) {
        toastError(e);
      }
    },
  });

  // The live name drives the AI grounding (the repo isn't published yet).
  const nameVal = useSelector(form.store, (s) => s.values.name);
  const workspaceVal = useSelector(form.store, (s) => s.values.workspace);
  const ownerVal = useSelector(form.store, (s) => s.values.owner);
  // Bitbucket-only submit gate: a valid slug and a chosen workspace. The name's
  // `warning` hint already explains a bad slug inline; a missing workspace can't
  // happen once the picker seeds, but guard it so submit never fires half-formed.
  const bbBlocked =
    isBitbucket &&
    (bbSlugWarning(nameVal) !== null || nameVal.trim() === "" || !workspaceVal);
  // With the picker active the owner comes from it, so a name carrying its own
  // owner or a leading dash can't be composed; the name's `warning` says which.
  const ghBlocked =
    ghPickerActive && (ghNameWarning(nameVal) !== null || !ownerVal);
  // GitHub's hints presume the picker — without a listing at all, typed
  // `owner/name` is the only way to reach an org, so the hints go with it.
  const nameWarning =
    isGitHub && !ghPickerActive ? undefined : NAME_WARNINGS[provider];

  const seedOnOpen = useEffectEvent(() =>
    form.reset({
      name: defaultName,
      description: "",
      homepage: "",
      topics: "",
      workspace: "",
      owner: "",
      isPrivate: true,
    }),
  );
  useSeedOnOpen(open, seedOnOpen);

  // Workspaces load after the dialog opens, so seed the picker once they arrive
  // (and only while the field is still empty — never stomp a user's pick).
  const seedWorkspace = useEffectEvent((slug: string) => {
    if (!form.state.values.workspace && slug) {
      form.setFieldValue("workspace", slug);
    }
  });
  useEffect(() => {
    if (open && isBitbucket) seedWorkspace(defaultWorkspace);
  }, [open, isBitbucket, defaultWorkspace]);

  // Owners load after the dialog opens; same seed-once-empty rule as workspaces.
  const defaultOwner = owners.data?.viewer ?? "";
  const seedOwner = useEffectEvent((login: string) => {
    if (!form.state.values.owner && login) {
      form.setFieldValue("owner", login);
    }
  });
  useEffect(() => {
    if (open && isGitHub) seedOwner(defaultOwner);
  }, [open, isGitHub, defaultOwner]);

  // Shared by the Generate button and the generate chord below.
  function runGenerate() {
    descGen.generate({
      repoName: nameVal.trim() || defaultName,
      onResult: ({ description, topics }) => {
        if (description) {
          form.setFieldValue("description", description);
        }
        // Bitbucket has no topics field — drop that arm.
        if (!isBitbucket && topics.length) {
          form.setFieldValue("topics", topics.join(" "));
        }
      },
    });
  }
  // This dialog opens from the header over any tab, including Changes where the
  // global generate-commit-message action is live — so the chord is swallowed
  // here whether or not it can generate. Mounted on DialogContent, not the
  // <form>: the X close button is a form SIBLING inside the Popup.
  const generateChord = useGenerateChord({
    enabled: aiEnabled && !descGen.generating,
    run: runGenerate,
  });

  const githubScope = ghPickerActive ? (
    <>It's created under the selected owner.</>
  ) : (
    <>
      Use <span className="font-mono">owner/name</span> to publish under an
      organization.
    </>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] flex-col"
        onKeyDown={generateChord.onKeyDown}
      >
        <form
          className="flex min-h-0 flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Publish to {remoteLabel}</DialogTitle>
            <DialogDescription>
              Creates a{" "}
              {isBitbucket
                ? "Bitbucket repository"
                : isGitLab
                  ? "GitLab project"
                  : "GitHub repository"}
              , adds it as <span className="font-mono">origin</span>, and pushes
              the current branch.{" "}
              {isBitbucket ? (
                <>It's created under the selected workspace.</>
              ) : isGitLab ? (
                <>It lands in your namespace (groups aren't supported yet).</>
              ) : (
                githubScope
              )}
            </DialogDescription>
          </DialogHeader>
          {/* Fields scroll; header and submit footer stay pinned. */}
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            {/* GitHub creates the repo under an owner — pick it first. */}
            {ghPickerActive && (
              <form.AppField name="owner">
                {(field) => (
                  <field.SelectField
                    label={
                      owners.isPending ? (
                        <StackedLabel
                          label="Owner"
                          hint="Loading your account and organizations…"
                        />
                      ) : (
                        "Owner"
                      )
                    }
                    items={ownerItems}
                    order={ownerLogins}
                    disabled={owners.isPending || !owners.data}
                    disabledItems={disabledOwners}
                    annotations={ownerAnnotations}
                  />
                )}
              </form.AppField>
            )}
            {/* Bitbucket creates the repo under a workspace — pick it first. */}
            {isBitbucket && (
              <form.AppField name="workspace">
                {(field) => (
                  <field.SelectField
                    label={
                      workspaces.isPending ? (
                        <StackedLabel
                          label="Workspace"
                          hint="Loading your workspaces…"
                        />
                      ) : (
                        "Workspace"
                      )
                    }
                    items={workspaceItems}
                    order={workspaceSlugs}
                    disabled={workspaces.isPending || !workspaces.data?.length}
                  />
                )}
              </form.AppField>
            )}
            <form.AppField
              name="name"
              validators={{ onChange: ({ value }) => required(value) }}
            >
              {(field) => (
                <field.TextField
                  label={
                    isBitbucket ? (
                      <StackedLabel
                        label="Name"
                        hint="Becomes the repository URL slug on Bitbucket"
                      />
                    ) : (
                      "Name"
                    )
                  }
                  placeholder="my-project"
                  warning={nameWarning}
                />
              )}
            </form.AppField>

            {aiEnabled && (
              <div className="flex justify-end">
                {descGen.generating ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="text-muted-foreground"
                    onClick={descGen.cancel}
                  >
                    <Spinner data-icon="inline-start" />
                    Cancel
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={runGenerate}
                    title={
                      isBitbucket
                        ? `Suggest a description from the README with AI${generateChord.hint}`
                        : `Suggest a description + topics from the README with AI${generateChord.hint}`
                    }
                  >
                    <SparkleIcon data-icon="inline-start" />
                    {isBitbucket
                      ? "Generate description"
                      : "Generate description & topics"}
                  </Button>
                )}
              </div>
            )}

            <form.AppField name="description">
              {(field) => (
                <field.TextField
                  label="Description (optional)"
                  placeholder="What is this project?"
                />
              )}
            </form.AppField>
            {/* Bitbucket has no topics — hide the field there. */}
            {!isBitbucket && (
              <form.AppField name="topics">
                {(field) => (
                  <field.TextField
                    label="Topics (optional, separate with spaces)"
                    placeholder="react typescript cli"
                  />
                )}
              </form.AppField>
            )}
            {/* GitLab projects have no homepage field — the arm drops it.
                Bitbucket keeps it but calls it "Website". */}
            {!isGitLab && (
              <form.AppField name="homepage">
                {(field) => (
                  <field.TextField
                    label={
                      isBitbucket ? "Website (optional)" : "Homepage (optional)"
                    }
                    placeholder="https://…"
                  />
                )}
              </form.AppField>
            )}
          </div>

          <DialogFooter className="sm:items-center">
            <form.AppField name="isPrivate">
              {(field) => (
                <field.CheckboxField
                  label="Keep this code private"
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
              <form.SubmitButton
                disabled={descGen.generating || bbBlocked || ghBlocked}
              >
                Publish
              </form.SubmitButton>
            </form.AppForm>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
