- Pulls and fetches keep the local tags a `fetch.pruneTags` configuration would
  prune, and repositories whose remote fetch writes outside the usual
  remote-tracking refs (mirror-style refspecs) pull the way plain `git pull`
  does.
