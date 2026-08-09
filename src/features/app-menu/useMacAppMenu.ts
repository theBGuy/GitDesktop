import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useEffectEvent } from "react";
import { useOpenRepoByPath } from "@/features/repository/useOpenRepoByPath";
import { isMac } from "@/lib/hotkeys/binding";
import { dispatchAction } from "@/lib/hotkeys/hotkeys";
import type { ActionId } from "@/lib/hotkeys/registry";
import { type RecentRepo, repoDisplayName } from "@/lib/settings/api";
import { useSettings } from "@/lib/settings/queries";
import { invoke } from "@/lib/tauri/invoke";

/** The actions the macOS File/app menu can trigger. Menu payloads arrive from
 *  the native menu bar, so they're validated against this list before dispatch. */
const MENU_ACTIONS = [
  "new-repository",
  "add-local-repository",
  "clone-repository",
  "open-settings",
] as const satisfies readonly ActionId[];

/** How many recents the Open Recent submenu shows — the macOS convention is a
 *  short list, and the full one lives in the repo switcher. */
const MAX_RECENT_ITEMS = 10;

function isMenuAction(
  payload: unknown,
): payload is (typeof MENU_ACTIONS)[number] {
  return (
    typeof payload === "string" &&
    (MENU_ACTIONS as readonly string[]).includes(payload)
  );
}

/** The name of a path's parent folder; "" when the path has no parent. */
function parentFolder(path: string): string {
  const segments = path.split(/[/\\]+/).filter(Boolean);
  return segments.length > 1 ? segments[segments.length - 2] : "";
}

/** Menu rows for the recents list. Repos that share a display name are ALL
 *  suffixed with their parent folder — an unqualified twin next to a qualified
 *  one reads as the canonical entry. */
function toMenuEntries(repos: RecentRepo[]): { label: string; path: string }[] {
  const names = repos.map(repoDisplayName);
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return repos.map((repo, i) => {
    const name = names[i];
    const parent = (counts.get(name) ?? 0) > 1 ? parentFolder(repo.path) : "";
    return { label: parent ? `${name} — ${parent}` : name, path: repo.path };
  });
}

/**
 * Bridges the macOS application menu to the app: menu clicks run the same
 * actions as the command palette and hotkeys, and the recents list is pushed
 * into File → Open Recent whenever it changes. Mounted once, in App. Inert off
 * macOS — no other platform builds an app menu.
 */
export function useMacAppMenu() {
  const openByPath = useOpenRepoByPath();
  const settings = useSettings();
  const recentRepos = settings.data?.recentRepos;

  const onAction = useEffectEvent((payload: unknown) => {
    if (!isMenuAction(payload)) return;
    // A `false` return is acceptable silence: the owning surface may not be
    // mounted, exactly as when the action is missing from the palette.
    dispatchAction(payload);
  });

  const onOpenRecent = useEffectEvent((payload: unknown) => {
    if (typeof payload !== "string") return;
    void openByPath(payload, "recent");
  });

  useEffect(() => {
    if (!isMac) return;
    // `listen` subscribes asynchronously, so a StrictMode double-mount can tear
    // this effect down before the subscription exists — unlisten on arrival in
    // that case, since cleanup has nothing to unlisten yet.
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];
    const track = (pending: Promise<UnlistenFn>) => {
      pending
        .then((unlisten) => {
          if (cancelled) unlisten();
          else unlisteners.push(unlisten);
        })
        .catch(() => undefined);
    };
    track(listen("app-menu-action", (e) => onAction(e.payload)));
    track(listen("app-menu-open-recent", (e) => onOpenRecent(e.payload)));
    return () => {
      cancelled = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, []);

  useEffect(() => {
    if (!isMac || !recentRepos) return;
    const entries = toMenuEntries(recentRepos.slice(0, MAX_RECENT_ITEMS));
    invoke<void>("set_recent_repos_menu", { entries }).catch(() => {
      // Best-effort: a menu that's briefly out of date never surfaces to the user.
    });
  }, [recentRepos]);
}
