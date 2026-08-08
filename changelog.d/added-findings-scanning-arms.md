- **Code scanning and secret scanning in the Findings tab.** The tab now lists a
  GitHub repo's open code scanning alerts (grouped by rule) and secret scanning alerts
  (grouped by kind, each with a validity chip for the leaked credential) next to its
  Dependabot alerts and security advisories, and a Dependabot alert's detail spells out
  a base-metric table per CVSS version the advisory carries, its CWEs, its references
  as labeled links, and whether the vulnerable package is a direct or transitive
  dependency. A category the repository hasn't switched on says so and, with repo-admin
  access, offers **Open security settings** to turn it on.
