- Background PR sync checks each GitHub host's session once per minute rather
  than once per repository, and keeps syncing repositories on every signed-in
  host even when an account on another host needs attention. Repositories whose
  remote uses an SSH host alias, such as `github.com-work`, are still checked
  one by one.
