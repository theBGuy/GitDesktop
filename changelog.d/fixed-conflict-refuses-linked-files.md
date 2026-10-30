- The conflict editor and **Resolve with AI** refuse a conflicted file that is
  reached through a symbolic link or junction, so the file the link points to
  stays out of AI prompts and isn't overwritten by an accept. **Accept all
  current** and **Accept all incoming** still resolve a conflicted symbolic link
  by replacing or removing the link itself (a Windows folder link stays refused).
