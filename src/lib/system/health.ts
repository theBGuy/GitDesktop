import { useQuery } from "@tanstack/react-query";
import type { AuthStatus } from "@/lib/ai/agent";
import { invoke } from "@/lib/tauri/invoke";

/** One external CLI's detected status, mirroring the Rust `ToolStatus`. */
export interface ToolStatus {
  /** Stable id mapped to a label + install link ("git", "gh", …). */
  id: string;
  found: boolean;
  path: string | null;
  version: string | null;
  /** Login state for tools that have one; `unknown` doubles as "N/A" (git). */
  authed: AuthStatus;
}

export interface SystemInfo {
  os: string;
  osVersion: string;
  arch: string;
}

export interface SystemHealth {
  system: SystemInfo;
  tools: ToolStatus[];
}

/** The first dotted numeric run in a `--version` line — "2.45.1" out of
 *  "git version 2.45.1.windows.1". Distros and vendors wrap the number in their
 *  own prose and suffixes, so it's matched anywhere rather than anchored. */
const VERSION_TOKEN = /\d+(?:\.\d+)+/;

/** A CLI's version: the numbers that get compared, plus the token as printed. */
export interface CliVersion {
  major: number;
  minor: number;
  /** The matched token ("2.45.1"), shown back to the user verbatim. */
  token: string;
}

/** Reads a CLI's `--version` line. Shapes it must keep parsing:
 *  "git version 2.45.1.windows.1", "git version 2.39.5 (Apple Git-154)",
 *  "gh version 2.94.0 (2026-06-10)", "2.43.0-1ubuntu1.12". A line carrying no
 *  dotted number is null — "unknown", never "too old", so callers fail open. */
export function parseCliVersion(line: string | null): CliVersion | null {
  const token = line?.match(VERSION_TOKEN)?.[0];
  if (!token) return null;
  const [major = 0, minor = 0] = token.split(".").map(Number);
  return { major, minor, token };
}

/** Whether a parsed version is at least `major.minor`. */
function atLeast(version: CliVersion, major: number, minor: number): boolean {
  return (
    version.major > major || (version.major === major && version.minor >= minor)
  );
}

/** The oldest version of one CLI that still supports the features GitDesktop
 *  drives through it, with the sentence shown when it falls short. */
interface CliFloor {
  major: number;
  minor: number;
  warning: (version: CliVersion) => string;
}

/** Floors for the CLIs whose shortfall breaks a user-visible feature; every
 *  other tool id has none. gh's `--json` field list (api/query_builder.go)
 *  gains `issueType` at v2.94.0 and lacks it through v2.93.0 (cli/cli tags);
 *  git gained `merge-tree --write-tree` in 2.38 and the `rev-parse
 *  --path-format` behind the worktree-stable repo identity in 2.31 (git
 *  release notes). */
const CLI_FLOORS: Record<string, CliFloor> = {
  gh: {
    major: 2,
    minor: 94,
    warning: (version) =>
      `Opening issues needs GitHub CLI 2.94 or newer (you have ${version.token}).`,
  },
  git: {
    major: 2,
    minor: 38,
    // The worktree-split clause reaches only the versions it applies to:
    // 2.31–2.37 lose the merge preview alone.
    warning: (version) =>
      atLeast(version, 2, 31)
        ? `Merge previews need Git 2.38 or newer (you have ${version.token}).`
        : `Merge previews need Git 2.38 or newer — and below 2.31, per-repo data can split across worktrees (you have ${version.token}).`,
  },
};

/** The warning for a tool older than a feature needs, or null when it's at or
 *  above its floor, has no floor, or reports a version we can't parse. */
export function cliFloorWarning(
  id: string,
  version: string | null,
): string | null {
  const floor = CLI_FLOORS[id];
  const parsed = parseCliVersion(version);
  if (!floor || !parsed) return null;
  return atLeast(parsed, floor.major, floor.minor)
    ? null
    : floor.warning(parsed);
}

/** OS/app diagnostics + the status of the CLIs GitDesktop shells out to, for
 *  the Settings → About screen. Detection runs concurrently in Rust. */
export function useSystemHealth() {
  return useQuery({
    queryKey: ["system-health"] as const,
    queryFn: () => invoke<SystemHealth>("system_health"),
    staleTime: 30_000,
  });
}
