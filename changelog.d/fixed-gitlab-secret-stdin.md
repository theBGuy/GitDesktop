- GitLab CI/CD variable values — including variables passed when running a
  pipeline manually — and webhook secret tokens now reach glab over stdin instead
  of the command line, keeping them out of the system process table.
