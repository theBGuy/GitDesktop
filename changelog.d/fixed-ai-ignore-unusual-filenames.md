- **Files with unusual names survive diff parsing.** git escapes a non-ASCII path
  like `café.txt` when it writes a diff, and GitDesktop skipped those files when
  splitting a combined diff into per-file sections — so such a file showed no
  diff in a pull-request or commit view, and was dropped from the diff sent for
  an AI review or a generated description rather than being weighed against your
  ignore patterns.
