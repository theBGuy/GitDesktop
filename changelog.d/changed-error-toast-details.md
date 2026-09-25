- Partly finished work keeps the full error one click away. When an issue or
  pull request is created but a follow-up step fails (such as linking it to a
  project or parent issue, carrying over comments, or posting reviewer notes),
  and when removing a worktree can't archive its branch or a promote stops
  after the folder is gone, the toast offers **Details** or **Copy** for the
  underlying error, and so does a failure to start or re-run an automation. A
  new issue that misses both its project and its parent link shows each reason
  under its own heading. When the toast can also open what was created, its
  button names the site (**View on GitHub**, **View on GitLab**, **View in
  Jira**) and **Details** carries the same link, so reading the error never
  costs you the way there. Pushes, pulls, and other remote operations refused
  because no usable SSH key was offered now explain what to set up: add or load
  a key with access to that remote.
