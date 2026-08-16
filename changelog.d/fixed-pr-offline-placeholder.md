- A pull request that won't load now opens with a plain explanation: which host
  it couldn't be loaded from, with the underlying error kept beneath it. Starting
  up offline reads as a connection problem rather than a pull request that has
  gone missing, and **Retry** shows that it's working while the read is in flight.
