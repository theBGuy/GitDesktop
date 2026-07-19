import {
  GitBranchIcon,
  GitPullRequestIcon,
  PlayCircleIcon,
  RobotIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { navigate, type Tab, useRoute } from "../lib/router";

// Shared chrome: a sticky top bar (repo/connection) and a bottom tab nav. Both
// are keyboard-operable; the bottom nav uses roving links with ≥44px targets.

/** Sticky top bar: the shared repo name (left) and a quiet connection dot
 *  (right). `connected` false renders a muted/offline indicator with text. */
export function TopBar({
  title,
  subtitle,
  connected,
}: {
  title: string;
  subtitle?: string;
  connected: boolean;
}) {
  return (
    <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-foreground">
          {title}
        </p>
        {subtitle ? (
          <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
        ) : null}
      </div>
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

const TABS: { tab: Tab; label: string; icon: ReactNode; hash: string }[] = [
  {
    tab: "status",
    label: "Status",
    icon: <GitBranchIcon size={22} />,
    hash: "#status",
  },
  {
    tab: "prs",
    label: "PRs",
    icon: <GitPullRequestIcon size={22} />,
    hash: "#prs",
  },
  { tab: "ci", label: "CI", icon: <PlayCircleIcon size={22} />, hash: "#ci" },
  {
    tab: "agents",
    label: "Agents",
    icon: <RobotIcon size={22} />,
    hash: "#agents",
  },
];

/** Bottom tab nav. Each tab is a real link (Tab-focusable); the active tab is
 *  marked with `aria-current`. Left/Right arrows move between tabs (roving). */
export function BottomNav() {
  const route = useRoute();

  function onKeyDown(e: React.KeyboardEvent, index: number) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const dir = e.key === "ArrowRight" ? 1 : -1;
    const next = (index + dir + TABS.length) % TABS.length;
    navigate(TABS[next].hash);
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
        const active = route.tab === t.tab && !route.isPairing;
        return (
          <a
            key={t.tab}
            href={t.hash}
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
