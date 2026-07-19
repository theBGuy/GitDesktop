import {
  CaretUpDownIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  PlayCircleIcon,
  RobotIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { navigate, repoHash, type Tab, useRoute } from "../lib/router";

// Shared chrome: a sticky top bar (repo/connection) and a bottom tab nav. Both
// are keyboard-operable; the bottom nav uses roving links with ≥44px targets.

/** Sticky top bar: the selected repo name (left, a tap-to-switch trigger) and a
 *  quiet connection dot (right). `connected` false renders a muted/offline
 *  indicator with text. When `onSwitchRepo` is provided the title is a real
 *  button (chevron affordance, ≥44px target, "Switch repository" label);
 *  otherwise it's plain text (e.g. on the picker itself). */
export function TopBar({
  title,
  onSwitchRepo,
  connected,
}: {
  title: string;
  onSwitchRepo?: () => void;
  connected: boolean;
}) {
  return (
    <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-background/95 px-4 py-1.5 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      {onSwitchRepo ? (
        <button
          type="button"
          onClick={onSwitchRepo}
          aria-label="Switch repository"
          className="-mx-2 flex min-h-11 min-w-0 items-center gap-1.5 rounded px-2 text-left"
        >
          <span className="truncate text-sm font-semibold text-foreground">
            {title}
          </span>
          <CaretUpDownIcon
            size={16}
            className="shrink-0 text-muted-foreground"
            aria-hidden
          />
        </button>
      ) : (
        <p className="min-w-0 truncate py-2.5 text-sm font-semibold text-foreground">
          {title}
        </p>
      )}
      <span
        className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
        title={connected ? "Connected" : "Not connected"}
      >
        <span
          aria-hidden
          className={`h-2 w-2 rounded-full ${connected ? "bg-success" : "bg-muted-foreground"}`}
        />
        {connected ? "Live" : "Offline"}
      </span>
    </header>
  );
}

const TABS: { tab: Tab; label: string; icon: ReactNode }[] = [
  { tab: "status", label: "Status", icon: <GitBranchIcon size={22} /> },
  { tab: "prs", label: "PRs", icon: <GitPullRequestIcon size={22} /> },
  { tab: "ci", label: "CI", icon: <PlayCircleIcon size={22} /> },
  { tab: "agents", label: "Agents", icon: <RobotIcon size={22} /> },
];

/** Build a tab's hash for the current repo scope. With a repoId the tabs are
 *  scoped (`#r/{repoId}/{tab}`); without one (picker / mid-redirect) they fall
 *  back to the legacy hash, which the shell resolves to a scoped route. */
function tabHash(tab: Tab, repoId: string | null): string {
  return repoId ? repoHash(repoId, tab) : `#${tab}`;
}

/** Bottom tab nav. Each tab is a real link (Tab-focusable) scoped to the selected
 *  repo; the active tab is marked with `aria-current`. Left/Right arrows move
 *  between tabs (roving). No tab is active on the picker (`#repos`) — it isn't a
 *  tab. */
export function BottomNav({ repoId }: { repoId: string | null }) {
  const route = useRoute();
  // Only highlight a tab when a repo tab is actually showing — not on the picker
  // or the pairing takeover (both set `route.tab` to its default `status`).
  const tabActive = !route.isPairing && !route.isRepos;

  function onKeyDown(e: React.KeyboardEvent, index: number) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const dir = e.key === "ArrowRight" ? 1 : -1;
    const next = (index + dir + TABS.length) % TABS.length;
    navigate(tabHash(TABS[next].tab, repoId));
    // Canonical roving-tablist behavior: DOM focus follows the arrow selection.
    const links = e.currentTarget.closest("nav")?.querySelectorAll("a");
    links?.[next]?.focus();
  }

  return (
    <nav
      className="sticky bottom-0 z-10 grid grid-cols-4 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 pb-[env(safe-area-inset-bottom)]"
      aria-label="Sections"
    >
      {TABS.map((t, i) => {
        const active = tabActive && route.tab === t.tab;
        return (
          <a
            key={t.tab}
            href={tabHash(t.tab, repoId)}
            aria-current={active ? "page" : undefined}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`flex min-h-14 flex-col items-center justify-center gap-1 text-xs font-medium ${
              active ? "text-primary" : "text-muted-foreground"
            }`}
          >
            {t.icon}
            {t.label}
          </a>
        );
      })}
    </nav>
  );
}
