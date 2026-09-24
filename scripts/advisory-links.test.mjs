// Pins the grammar gate between forge-supplied advisory ids and the URLs the
// Findings detail opens. Ids are untrusted, so every link is built only from a
// full grammar match; anything else must return null and render as plain text.
//
// Imported through the shared src hooks (dynamic, so they are registered before
// the module links) to match the other `@/` suites. `advisory-links.ts` imports
// nothing, so this suite also runs in the no-install `guards` job and any import
// failure there is a real breakage.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { installSrcHooks } from "./lib/src-import-hooks.mjs";

const hooks = installSrcHooks();
after(() => hooks.deregister());

const { cveUrl, cweUrl, ghsaUrl, repoAdvisoryGhsaUrl } = await import(
  "@/features/security-findings/advisory-links"
);

test("a CWE id links to its MITRE definition page", () => {
  assert.equal(
    cweUrl("CWE-79"),
    "https://cwe.mitre.org/data/definitions/79.html",
  );
  assert.equal(
    cweUrl("CWE-1321"),
    "https://cwe.mitre.org/data/definitions/1321.html",
  );
});

test("a GHSA id links to the global advisory database", () => {
  assert.equal(
    ghsaUrl("GHSA-pj86-cfqh-vqx6"),
    "https://github.com/advisories/GHSA-pj86-cfqh-vqx6",
  );
  // Characters outside GitHub's Crockford subset are admitted on purpose.
  assert.equal(
    ghsaUrl("GHSA-0lio-aaaa-zzzz"),
    "https://github.com/advisories/GHSA-0lio-aaaa-zzzz",
  );
});

test("a CVE id links to its NVD detail page", () => {
  assert.equal(
    cveUrl("CVE-2024-4068"),
    "https://nvd.nist.gov/vuln/detail/CVE-2024-4068",
  );
  assert.equal(
    cveUrl("CVE-2021-1234567"),
    "https://nvd.nist.gov/vuln/detail/CVE-2021-1234567",
  );
});

test("CWE ids outside the grammar get no link", () => {
  for (const id of [
    "",
    "CWE-",
    "CWE",
    "cwe-79",
    "Cwe-79",
    "CWE-79a",
    "CWE--79",
    "CWE-7 9",
    " CWE-79",
    "CWE-79 ",
    "CWE-79\n",
    "CWE-79/../evil",
    "CWE-79?x=1",
    "CWE-79#frag",
    "NVD-CWE-Other",
    // Arabic-Indic digits, built from code points to keep this file ASCII.
    `CWE-${String.fromCharCode(0x661, 0x662)}`,
  ]) {
    assert.equal(cweUrl(id), null, JSON.stringify(id));
  }
});

test("GHSA ids outside the grammar get no link", () => {
  for (const id of [
    "",
    "GHSA",
    "GHSA-pj86-cfqh",
    "GHSA-pj86-cfqh-vqx",
    "GHSA-pj86-cfqh-vqx66",
    "GHSA-PJ86-CFQH-VQX6",
    "ghsa-pj86-cfqh-vqx6",
    "GHSA-pj86-cfQh-vqx6",
    "GHSA-pj86_cfqh-vqx6",
    " GHSA-pj86-cfqh-vqx6",
    "GHSA-pj86-cfqh-vqx6 ",
    "GHSA-pj86-cfqh-vqx6\n",
    "GHSA-pj86-cfqh-vqx6/../../evil",
    "GHSA-pj86-cfqh-vq/6",
  ]) {
    assert.equal(ghsaUrl(id), null, JSON.stringify(id));
  }
});

test("CVE ids outside the grammar get no link", () => {
  for (const id of [
    "",
    "CVE",
    "CVE-2024",
    "CVE-2024-",
    "CVE-2024-123",
    "CVE-24-4068",
    "cve-2024-4068",
    "CVE-2024-4068a",
    " CVE-2024-4068",
    "CVE-2024-4068 ",
    "CVE-2024-4068\n",
    "CVE-2024-4068/../evil",
  ]) {
    assert.equal(cveUrl(id), null, JSON.stringify(id));
  }
});

test("a repository advisory prefers its own page when the wire carried one", () => {
  const own =
    "https://github.com/expressjs/express/security/advisories/GHSA-pj86-cfqh-vqx6";
  assert.equal(repoAdvisoryGhsaUrl("GHSA-pj86-cfqh-vqx6", own), own);
});

// Scheme-guarding htmlUrl is the CALLER's contract: FindingDetailView passes
// `httpUrl(htmlUrl) ?? ""`, and that guard lives in a React module this
// installless suite can't load. What is pinned here is the module's half: the
// `""` a missing or rejected URL becomes means "no page", never an empty link.
test("a repository advisory without its own page falls back to the global database", () => {
  // Both a missing html_url (the Rust layer sends "") and a caller-rejected
  // one (e.g. `javascript:`, guarded to "") arrive as the empty string.
  assert.equal(
    repoAdvisoryGhsaUrl("GHSA-pj86-cfqh-vqx6", ""),
    "https://github.com/advisories/GHSA-pj86-cfqh-vqx6",
  );
});

test("a repository advisory id outside the grammar gets no link, even with its own page", () => {
  const own = "https://github.com/o/r/security/advisories/x";
  assert.equal(repoAdvisoryGhsaUrl("", own), null);
  assert.equal(repoAdvisoryGhsaUrl("GHSA-PJ86-CFQH-VQX6", own), null);
  assert.equal(repoAdvisoryGhsaUrl("", ""), null);
});
