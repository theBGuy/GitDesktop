- Discard all is atomic: nothing can slip into the repository mid-discard, so
  work you stage while one runs gets a labeled busy notice instead of being
  destroyed by the discard's reset.
