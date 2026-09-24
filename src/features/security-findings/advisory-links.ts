// Advisory identifiers arrive as forge data, so a link is built only from an id
// that matches its grammar in full; anything else gets no link at all. The
// built URLs are https literals around a validated token, so they skip the
// `httpUrl()` scheme guard; the one forge URL passed in arrives already guarded.

const CWE_ID = /^CWE-(\d+)$/;
// The full lowercase-alphanumeric alphabet, wider than GitHub's published
// Crockford subset: a too-strict class would silently un-link valid ids, and
// every character it admits is still a safe URL path segment.
const GHSA_ID = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
const CVE_ID = /^CVE-\d{4}-\d{4,}$/;

/** MITRE's definition page for a `CWE-<n>` id, or null. */
export function cweUrl(id: string): string | null {
  const match = CWE_ID.exec(id);
  return match
    ? `https://cwe.mitre.org/data/definitions/${match[1]}.html`
    : null;
}

/** The global GitHub Advisory Database page for a GHSA id, or null. */
export function ghsaUrl(id: string): string | null {
  return GHSA_ID.test(id) ? `https://github.com/advisories/${id}` : null;
}

/** NVD's detail page for a CVE id, or null. */
export function cveUrl(id: string): string | null {
  return CVE_ID.test(id) ? `https://nvd.nist.gov/vuln/detail/${id}` : null;
}

/** A repository advisory's GHSA link: its own page when it has one, since a
 *  draft or unpublished advisory has no global-database page. `htmlUrl` must be
 *  the caller's `httpUrl()`-guarded value or `""`, which keeps every return an
 *  http(s) target. The grammar still gates the link, even with a page URL. */
export function repoAdvisoryGhsaUrl(
  ghsaId: string,
  htmlUrl: string,
): string | null {
  const global = ghsaUrl(ghsaId);
  return global ? htmlUrl || global : null;
}
