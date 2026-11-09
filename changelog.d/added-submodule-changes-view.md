- **Submodule changes you can read.** A changed submodule is tagged in Changes
  with what changed (commit changed, modified files, untracked files). Selecting
  it lists the commits the submodule moved across, and its unstaged row lists the
  uncommitted files inside. **Open submodule** opens it as its own repository, and
  so does a double-click on the row. A stash can't save a submodule's commit or
  the files inside it, so its row stays out of **Stash change**; **Discard all**
  and **Stash all** say when a submodule's own commits and files will stay in
  place and warn when a repository that replaced a tracked file would be lost.
