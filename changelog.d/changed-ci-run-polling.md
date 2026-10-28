- Watching CI runs uses far fewer API requests. Older runs are checked at a
  gentler pace on every forge, and on GitHub one request now covers every run
  on a pull request's head, with job details loading only where they're shown.
