- An AI review that hits its time limit now keeps what the reviewer already wrote.
  The findings stay on screen (including for Codex, which delivers its answer in
  one piece at the end) and are saved with the pull request, labelled **Timed
  out — partial output kept**, so they're still there after a restart. Kept output
  also gets its own row under **Previous reviews**, where it can be read, copied or
  cleared like any other record, and an automated review that runs out of time
  keeps its output the same way. Kept output is never treated as a finished review:
  it doesn't feed the next run's context and doesn't count as coverage for
  automated reviews.
