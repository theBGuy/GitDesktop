- A reference that is both typed in a pull request description and picked as a
  linked-issue chip is written once when the app can tell the typed one says as
  much on a plain line of its own. A chip set to close the issue still adds its
  `Closes` line when the description only relates to it, and a closing line you
  typed (`Closes #12`, `Fixes #12` and the like) is never dropped or downgraded:
  a line the forge shows as code or hides doesn't count as typed, and editing a
  description that ends with both a closing and a relating line for the same
  issue keeps the closing one.
