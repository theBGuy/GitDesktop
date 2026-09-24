- Partly finished work keeps the full error one click away. When an issue or
  pull request is created but a follow-up step fails (linking it to a project
  or parent issue, carrying over comments, posting reviewer notes), and when
  removing a worktree can't archive its branch or a promote stops after the
  folder is gone, the toast offers **Details** or **Copy** for the underlying
  error. A new issue that misses both its project and its parent link shows
  each reason under its own heading. Pushes, pulls, and fetches refused because
  no usable SSH key was offered now explain what to set up: add or load a key
  with access to that remote.
