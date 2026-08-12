- Pushes GitDesktop makes on your behalf (PR/MR creation, repository publish, tag
  push) now validate the branch or tag name up front and only ever touch that
  exact ref on the remote, and the same tag rules guard creating, editing, and
  deleting releases on GitHub and GitLab.
