- Fixed cloning, fetching, pulling, and pushing **private Bitbucket** repositories
  over HTTPS failing with `could not read Password for '…@bitbucket.org': terminal
  prompts disabled` on macOS and Linux. GitDesktop now hands your stored Bitbucket
  API token to git's credential store over STDIN (never placed on the command line),
  so operations authenticate without a prompt wherever git has a credential helper —
  the system keychain on macOS, Git Credential Manager on Windows, or a configured
  helper on Linux. Cloning over SSH was unaffected.
