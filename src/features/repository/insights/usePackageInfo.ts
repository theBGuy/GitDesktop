import { useQuery } from "@tanstack/react-query";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

export interface PackageInfo {
  description: string | null;
}

/** Ecosystems whose registries expose a JSON description we can fetch. */
const FETCHABLE = new Set(["npm", "cargo", "pypi", "pip"]);

// crates.io rejects requests without a User-Agent; harmless for the others.
const HEADERS = { "User-Agent": "GitDesktop" };

async function fetchJson(url: string): Promise<unknown> {
  const res = await tauriFetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object";
}

/** One string field off a registry object, else null. Registry responses are
 *  untrusted — including the JSON root, which needn't be an object at all — and
 *  a non-string value reaches JSX, where an object or array throws "Objects are
 *  not valid as a React child". */
function stringField(parent: unknown, key: string): string | null {
  if (!isRecord(parent)) return null;
  const value = parent[key];
  return typeof value === "string" ? value : null;
}

async function fetchPackageInfo(
  ecosystem: string,
  name: string,
): Promise<PackageInfo> {
  switch (ecosystem) {
    case "npm": {
      const j = await fetchJson(`https://registry.npmjs.org/${name}/latest`);
      return { description: stringField(j, "description") };
    }
    case "cargo": {
      const j = await fetchJson(`https://crates.io/api/v1/crates/${name}`);
      return {
        description: stringField(isRecord(j) ? j.crate : null, "description"),
      };
    }
    case "pypi":
    case "pip": {
      const j = await fetchJson(`https://pypi.org/pypi/${name}/json`);
      return {
        description: stringField(isRecord(j) ? j.info : null, "summary"),
      };
    }
    default:
      return { description: null };
  }
}

/**
 * Lazily fetches a dependency's one-line description from its package registry
 * (npm / crates.io / PyPI). Only runs when `enabled` — wire it to the hovercard's
 * open state so we don't fetch hundreds of packages eagerly.
 */
export function usePackageInfo(
  ecosystem: string,
  name: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["package-info", ecosystem, name] as const,
    queryFn: () => fetchPackageInfo(ecosystem, name),
    enabled: enabled && FETCHABLE.has(ecosystem),
    staleTime: 60 * 60_000, // descriptions are stable
    retry: false,
  });
}

export const canFetchPackageInfo = (ecosystem: string) =>
  FETCHABLE.has(ecosystem);
