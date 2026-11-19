- On macOS and Linux, background jobs your shell startup files start while
  GitDesktop reads your login shell's PATH, or asks it where a tool is
  installed, now end when that read does. Jobs that detach themselves, or that
  a startup file starts with job control turned on, still carry on.
