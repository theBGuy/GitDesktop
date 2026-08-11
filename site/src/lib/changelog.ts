// ?raw so Vite inlines the file at transform time: a node:fs read would
// resolve import.meta.url against the bundled prerender chunk, not this file.
import raw from "../../../CHANGELOG.md?raw";

// Build-time parse of the repo-root CHANGELOG.md, per the fragment contract
// (changelog.d/README.md): `## [x.y.z] - date`, `### ` categories, `- `
// bullets with 2-space continuations (blank lines don't close a bullet);
// inline bold/italic/code + http(s)
// links, any other [label](target) collapsed to its label (the relative
// links target the gitignored docs/ tree). Fail-open — unknown lines render
// as prose, never throw: a throw would kill the production Pages build on a
// release-day push, which no PR site gate fronts.

export interface ReleaseCategory {
  name: string;
  /** Rendered HTML, one entry per bullet. */
  bullets: string[];
}

export interface Release {
  version: string;
  /** ISO date from the section heading (yyyy-mm-dd). */
  date: string;
  /** GitHub compare view from the Keep a Changelog link refs, when it is one. */
  compareUrl?: string;
  releaseUrl: string;
  /** Rendered HTML paragraphs of pre-category prose (0.1.0's preface). */
  intro: string[];
  categories: ReleaseCategory[];
}

const REPO = "https://github.com/theBGuy/GitDesktop";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderText(seg: string): string {
  let html = escapeHtml(seg);
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2">$1</a>',
  );
  // Runs after the http pass, so only non-http link syntax remains to collapse.
  html = html.replace(/\[([^\]]+)\]\([^)\s]*\)/g, "$1");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return html;
}

function renderSpans(seg: string): string {
  return seg
    .split(/(`[^`]+`)/)
    .map((s) =>
      s.startsWith("`") && s.endsWith("`") && s.length > 2
        ? `<code>${escapeHtml(s.slice(1, -1))}</code>`
        : renderText(s),
    )
    .join("");
}

// Bold first, then code inside it: bullets like "**`gh` required.**" nest a
// code span within the bold pair, so splitting on code first would break the
// pair apart. The file has no literal `**` inside code spans to confuse this.
function renderInline(md: string): string {
  return md
    .split(/(\*\*.+?\*\*)/)
    .map((s) =>
      s.startsWith("**") && s.endsWith("**") && s.length > 4
        ? `<strong>${renderSpans(s.slice(2, -2))}</strong>`
        : renderSpans(s),
    )
    .join("");
}

export function getChangelog(): Release[] {
  const lines = raw.split(/\r?\n/);

  const refs = new Map<string, string>();
  for (const line of lines) {
    const m = line.match(/^\[([^\]]+)\]:\s+(\S+)\s*$/);
    if (m) refs.set(m[1], m[2]);
  }

  const releases: Release[] = [];
  let release: Release | null = null;
  let category: ReleaseCategory | null = null;
  let bullet: string | null = null;
  let para: string | null = null;

  const flushPara = () => {
    if (para !== null && release) release.intro.push(renderInline(para));
    para = null;
  };
  // A blank line closes only a paragraph: the fragment validator accepts blank
  // lines inside a bullet body, so an indented continuation may follow one and
  // must rejoin its still-open bullet.
  const flush = () => {
    if (bullet !== null && category)
      category.bullets.push(renderInline(bullet));
    bullet = null;
    flushPara();
  };

  for (const line of lines) {
    const h2 = line.match(/^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?/);
    if (h2) {
      flush();
      category = null;
      // Any heading without a recognized date is skipped. Unreleased (empty on
      // master between releases, unshipped either way) is the standing case; a
      // malformed hand-edited date drops its section rather than mis-attaching
      // its bullets to the previous release.
      if (!h2[2]) {
        release = null;
        continue;
      }
      const ref = refs.get(h2[1]);
      release = {
        version: h2[1],
        date: h2[2],
        compareUrl: ref?.includes("/compare/") ? ref : undefined,
        releaseUrl: `${REPO}/releases/tag/v${h2[1]}`,
        intro: [],
        categories: [],
      };
      releases.push(release);
      continue;
    }
    if (!release) continue;

    const h3 = line.match(/^### (.+)$/);
    if (h3) {
      flush();
      category = { name: h3[1].trim(), bullets: [] };
      release.categories.push(category);
      continue;
    }
    if (/^\[[^\]]+\]:/.test(line)) continue;
    if (line.startsWith("- ")) {
      flush();
      if (!category) {
        category = { name: "", bullets: [] };
        release.categories.push(category);
      }
      bullet = line.slice(2);
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      continue;
    }
    if (/^\s/.test(line) && bullet !== null) {
      bullet += ` ${line.trim()}`;
      continue;
    }
    para = para === null ? line.trim() : `${para} ${line.trim()}`;
  }
  flush();

  return releases;
}
