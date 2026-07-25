import pkg from "../../../package.json";

// Build-time release facts, so version, date, and direct download links exist
// as real text in the served HTML — crawlers and no-JS visitors saw literally
// nothing before this (the spans ship empty and are filled client-side).
//
// Two layers, both of which the client script still corrects at runtime:
//   1. A live fetch of the latest release at BUILD time (exact tag, date, and
//      asset names). Guarded by a timeout and a catch so a rate-limited or
//      offline build (CI, Cloudflare) never fails — it falls back to…
//   2. …the root package.json version (the same field tauri.conf.json reads,
//      so it IS the released version) with NO asset list — consumers gate
//      direct asset links and version text on `live` (falling back to the
//      releases page / empty text), because a guessed link 404s whenever a
//      version bump lands before its release is published.
//
// Baked data goes stale between a release and the next site deploy — closed
// by .github/workflows/site-rebuild.yml (deploy hook on release publish).

const REPO = "theBGuy/GitDesktop";

export interface ReleaseInfo {
  /** e.g. "v0.5.2" */
  tag: string;
  /** e.g. "0.5.2" */
  version: string;
  /** null when the build-time fetch didn't run (fallback path). */
  publishedAt: Date | null;
  /** Asset file names, .sig files excluded. */
  assets: string[];
  /** True when this came from the live API rather than the fallback. */
  live: boolean;
}

function fallback(): ReleaseInfo {
  const v = pkg.version;
  return {
    tag: `v${v}`,
    version: v,
    publishedAt: null,
    // Deliberately empty — never guess asset names. release:prepare bumps
    // package.json BEFORE the release is published, so a fabricated
    // `releases/download/v<next>/…` link would 404 for every no-JS visitor
    // of a build that raced that window. An empty list makes assetBySuffix
    // return null and the download page fall back to the releases index.
    assets: [],
    live: false,
  };
}

async function fetchLatest(): Promise<ReleaseInfo> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return fallback();
    const rel = await res.json();
    if (typeof rel?.tag_name !== "string" || !Array.isArray(rel?.assets)) {
      return fallback();
    }
    return {
      tag: rel.tag_name,
      version: rel.tag_name.replace(/^v/, ""),
      publishedAt: rel.published_at ? new Date(rel.published_at) : null,
      assets: rel.assets
        .map((a: { name?: string }) => a?.name ?? "")
        .filter((n: string) => n && !n.endsWith(".sig")),
      live: true,
    };
  } catch {
    return fallback();
  }
}

// One fetch per build, shared by every page that bakes release facts.
let cached: Promise<ReleaseInfo> | null = null;

export function getLatestRelease(): Promise<ReleaseInfo> {
  cached ??= fetchLatest();
  return cached;
}

/** Direct download URL for the asset matching a suffix, or null. */
export function assetBySuffix(rel: ReleaseInfo, suffix: string): string | null {
  const name = rel.assets.find((n) => n.endsWith(suffix));
  return name
    ? `https://github.com/${REPO}/releases/download/${rel.tag}/${name}`
    : null;
}

/** "July 23, 2026" — UTC-pinned like the blog dates. */
export function formatReleaseDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
