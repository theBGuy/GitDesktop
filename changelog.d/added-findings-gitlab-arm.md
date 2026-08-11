- **Findings on GitLab.** The **Findings** tab now works on GitLab repositories:
  it reads the newest completed pipeline for your branch (falling back to the
  default branch, and saying so) and lists its **SAST**, **secret detection**, and
  **code quality** findings — on every tier, Free included, where GitLab's own
  vulnerability report is Ultimate-only. Each finding opens with its severity,
  file and line, scanner, and identifiers, plus **View file on GitLab** at the
  scanned commit; every section says why it has nothing to show — scanning not set
  up, a report that isn't downloadable, expired artifacts, or a pipeline that
  hasn't finished — so an empty list only reads as clean when a report proved it.
