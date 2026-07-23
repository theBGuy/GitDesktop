- An automation review claim left behind by a crashed or outdated app instance no
  longer blocks that pull request's review for other instances — a stale claim is
  reclaimed after 30 minutes instead of waiting for the 30-day sweep. The
  missed-review catch-up now works per review mode, so a failed general review is
  retried even when the security audit already ran.
