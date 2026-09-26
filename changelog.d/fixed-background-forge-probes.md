- Background PR sync checks each GitLab instance's sign-in and your Bitbucket
  account once per minute rather than once per repository, so watching many
  GitLab or Bitbucket repositories starts fewer `glab` processes and sends
  fewer Bitbucket API requests.
