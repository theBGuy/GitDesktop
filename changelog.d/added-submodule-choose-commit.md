- **Choose the commit a submodule points at.** **Choose commit…** on a submodule's
  row (or *Choose submodule commit…* in the command palette) lists a branch or
  tag's history, with message search and paste-a-commit-id. **Check out and stage**
  moves the submodule to the commit you pick and stages the new pointer together,
  so pinning a dependency to a release or rolling one back takes one step. It checks
  first whether the commit would overwrite local changes, leave commits behind, or
  isn't on a remote yet, and the checkout never overwrites local changes.
