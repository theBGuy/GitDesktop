- Tags that arrive when Compare fetches a remote branch show in the Tags list
  right away. The fetch that follows **Add upstream remote** in the Compare
  picker runs when you reconnect if it failed offline, even if you picked
  another branch while it ran. When a picked remote branch isn't among your
  remote branches and its remote is still set up, Compare offers to fetch that
  remote beside **Pick another branch**, and says the branch was deleted on
  the remote once Compare's fetch confirms it. **Create pull request** waits
  whenever the comparison with a remote branch couldn't be refreshed.
