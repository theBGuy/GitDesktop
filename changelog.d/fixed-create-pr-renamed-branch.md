- **Create pull request** on a branch renamed in this clone that still tracks
  its old name on `origin`, when that name isn't `origin`'s default branch,
  finds a pull request already open from the old name into the same base and
  shows it. When there is none, and the old name isn't the base either, it
  stops before pushing and says how to publish the branch under its own name.
  In the branch menu, such a branch with no pull request of its own shows the
  pull request chip of the name it tracks, and the menu item that opens it.
