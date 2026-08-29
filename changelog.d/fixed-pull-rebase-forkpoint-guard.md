- **Pull with rebase** now looks ahead for commits that an upstream rewrite would
  take off your branch, names them, and asks whether to keep them (replayed on top
  of the new upstream tip) or drop them. A drop is recorded in **Operation
  history**; rebase pulls with nothing at risk run as they always have, with no
  prompt.
