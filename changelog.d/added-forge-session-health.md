- **In-app forge sign-in, reconnect & session health.** Sign in to GitHub (`gh`'s
  device-code flow) and GitLab (`glab --web`) without leaving the app — from the
  not-signed-in panels, **Settings → Accounts**, or the command palette; a terminal
  stays a fallback. GitDesktop now distinguishes an **expired or revoked session** from
  never-signed-in and passing network blips, badges the affected account with one-click
  **Reconnect**, and **warns before a token expires** — GitLab and GitHub personal
  access tokens, plus an optional Bitbucket token **expiry date** you supply. GitLab
  sign-in recommends the browser (OAuth) option, whose sessions renew themselves instead
  of forcing periodic re-login.
