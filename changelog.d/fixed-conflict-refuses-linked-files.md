- The conflict editor and **Resolve with AI** refuse a conflicted file that is
  reached through a symbolic link or junction, so the file the link points to
  stays out of AI prompts and isn't overwritten by an accept. A conflicted
  symbolic link still resolves with **Accept all current** or **Accept all
  incoming**, which replace the link itself.
