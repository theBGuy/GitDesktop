import {
  BookOpenIcon,
  CompassIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  GearIcon,
  GitForkIcon,
  QuestionIcon,
} from "@phosphor-icons/react";
import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/ui/button";
import { usePickAndOpenRepo } from "@/features/repository/useOpenRepoByPath";
import { useUpdateCheck } from "@/features/updates/useUpdateCheck";
import { formatBinding } from "@/lib/hotkeys/binding";
import { dispatchAction, useEffectiveBindings } from "@/lib/hotkeys/hotkeys";
import type { ActionId } from "@/lib/hotkeys/registry";
import {
  useAiEnabled,
  useSaveSettings,
  useSettings,
} from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { RecentRepoList } from "./RecentRepoList";

export function WelcomeScreen() {
  const openSettings = useUiStore((s) => s.openSettings);
  const openHelp = useUiStore((s) => s.openHelp);
  const openExplore = useUiStore((s) => s.openExplore);
  const pickAndOpen = usePickAndOpenRepo();
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const aiEnabled = useAiEnabled();
  const bindings = useEffectiveBindings();
  const updateAvailable = Boolean(useUpdateCheck().data);

  function dismissNudge() {
    if (settings.data) {
      saveSettings.mutate({ ...settings.data, seenGuideNudge: true });
    }
  }
  function openGuide() {
    dismissNudge();
    openHelp();
  }

  // The primary entry points, surfaced as a launcher: label on the left, the
  // live keyboard shortcut on the right (honours user remaps via bindings).
  const actions: {
    id: ActionId;
    label: string;
    icon: typeof FolderOpenIcon;
    variant: "default" | "outline";
    onClick: () => void;
  }[] = [
    {
      id: "add-local-repository",
      label: "Open repository",
      icon: FolderOpenIcon,
      variant: "default",
      onClick: pickAndOpen,
    },
    {
      id: "clone-repository",
      label: "Clone repository",
      icon: GitForkIcon,
      variant: "outline",
      onClick: () => dispatchAction("clone-repository"),
    },
    {
      id: "new-repository",
      label: "Create repository",
      icon: FolderPlusIcon,
      variant: "outline",
      onClick: () => dispatchAction("new-repository"),
    },
    {
      id: "open-explore",
      label: "Explore repositories",
      icon: CompassIcon,
      variant: "outline",
      onClick: openExplore,
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <BrandMark className="size-5" />
          <span className="text-sm font-medium">GitDesktop</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="User guide"
            title="User guide (F1)"
            onClick={openHelp}
          >
            <QuestionIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="relative"
            aria-label={
              updateAvailable ? "Settings — update available" : "Settings"
            }
            title={updateAvailable ? "Settings — update available" : "Settings"}
            onClick={() => openSettings()}
          >
            <GearIcon />
            {updateAvailable && (
              <span
                aria-hidden
                className="absolute top-1 right-1 size-1.5 rounded-full bg-primary ring-2 ring-background animate-in fade-in motion-reduce:animate-none"
              />
            )}
          </Button>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col justify-center gap-6 p-8">
        {settings.data && !settings.data.seenGuideNudge && (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border bg-muted/40 px-3 py-2">
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <BookOpenIcon className="size-4 shrink-0 text-foreground" />
              New to GitDesktop? The built-in guide walks through the whole
              workflow.
            </span>
            <span className="flex shrink-0 items-center gap-1">
              <Button size="xs" variant="ghost" onClick={dismissNudge}>
                Dismiss
              </Button>
              <Button size="xs" onClick={openGuide}>
                Open guide
              </Button>
            </span>
          </div>
        )}

        <div className="grid items-center gap-y-8 md:grid-cols-2">
          <div className="flex flex-col gap-6 md:pr-10">
            <div className="space-y-2">
              <h1 className="font-heading text-2xl font-semibold tracking-tight text-balance">
                The whole loop,
                <br className="hidden sm:block" /> one window.
              </h1>
              <p className="text-xs/relaxed text-muted-foreground">
                Open a repository to start reviewing, committing, and shipping
                {aiEnabled ? " — with AI in the loop when you want it." : "."}
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex flex-col gap-2">
                {actions.map(({ id, label, icon: Icon, variant, onClick }) => {
                  const binding = bindings.get(id);
                  return (
                    <Button
                      key={id}
                      variant={variant}
                      onClick={onClick}
                      className="w-full justify-between"
                    >
                      <span className="flex items-center gap-2">
                        <Icon className="size-4" />
                        {label}
                      </span>
                      {binding && (
                        <span className="text-[11px] tabular-nums opacity-60">
                          {formatBinding(binding)}
                        </span>
                      )}
                    </Button>
                  );
                })}
              </div>
              <p className="pt-1 text-[11px] text-muted-foreground">
                …or drag a repo folder anywhere onto the window.
              </p>
            </div>
          </div>

          <div className="self-stretch md:border-l md:border-border md:pl-10">
            <RecentRepoList />
          </div>
        </div>
      </main>
    </div>
  );
}
