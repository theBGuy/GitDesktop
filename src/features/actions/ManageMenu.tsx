import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { forgeRepoUrl } from "@/lib/git/api";
import { type ForgeProvider, shownProviderLabel } from "@/lib/git/types";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { toastError } from "@/lib/toast";
import {
  ACTIONS_LINKS,
  type ActionsLink,
  linksFor,
  manageGroupLabel,
} from "./forge-actions-links";

/** Opens the clicked repo's page even if the user switched repos meanwhile:
 *  that repo's page is what was asked for, and nothing is written. */
async function openForgePage(repoPath: string, suffix: string) {
  try {
    const url = await forgeRepoUrl(repoPath);
    await openUrl(`${url}${suffix}`);
  } catch (e) {
    toastError(e);
  }
}

/** The forge's management pages (caches, deployments, runners, …), which have
 *  no usable API here: link-outs only. Renders once the provider is known, so
 *  a GitLab repo never flashes GitHub's rows. */
export function ManageMenu({
  repoPath,
  provider,
}: {
  repoPath: string;
  provider: ForgeProvider | null | undefined;
}) {
  const label = shownProviderLabel(provider);
  const rows = linksFor(provider);
  if (label === null || rows.length === 0) return null;
  const name = manageGroupLabel(label);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <DisabledReasonButton
            variant="outline"
            size="icon-sm"
            aria-label={name}
            title={name}
          />
        }
      >
        <ArrowSquareOutIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        {/* Base UI's GroupLabel must sit inside a group. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>{name}</DropdownMenuLabel>
          {rows.map((row) => (
            <DropdownMenuItem
              key={row.id}
              // onSelect never fires on a Base UI menu item; onClick does.
              onClick={() => void openForgePage(repoPath, row.suffix)}
              // Items activate on keydown with no repeat check, so a key still
              // held from opening the menu would pick the highlighted row.
              onKeyDown={(e) => {
                if (e.repeat && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  e.preventBaseUIHandler();
                }
              }}
            >
              <ArrowSquareOutIcon data-icon="inline-start" aria-hidden />
              {row.label}
              {row.muted && (
                <span className="ml-auto text-muted-foreground">
                  {row.muted}
                </span>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LinkPaletteAction({
  link,
  repoPath,
  enabled,
}: {
  link: ActionsLink;
  repoPath: string;
  enabled: boolean;
}) {
  useHotkeyAction(
    link.id,
    () => void openForgePage(repoPath, link.suffix),
    enabled,
  );
  return null;
}

/** One palette action per link row, mounted whatever the menu shows (an
 *  unmounted component registers nothing) and live only for the detected
 *  provider's rows. */
export function ManagePaletteActions({
  repoPath,
  provider,
  active,
}: {
  repoPath: string;
  provider: ForgeProvider | null | undefined;
  active: boolean;
}) {
  return ACTIONS_LINKS.map((link) => (
    <LinkPaletteAction
      key={link.id}
      link={link}
      repoPath={repoPath}
      enabled={active && provider === link.provider}
    />
  ));
}
