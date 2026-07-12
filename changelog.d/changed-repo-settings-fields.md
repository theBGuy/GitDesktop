- **Repository settings: friendlier Description and Topics fields.** In *Settings →
  General*, the **Description** is now a multi-line box so a long "About" wraps
  instead of clipping mid-word (GitHub and GitLab; Bitbucket already did). **Topics**
  are now removable chips with an inline add-box: type a topic and press **Enter** or
  comma to add it. On GitHub, each token is normalized to a valid topic as you add it and
  the chip shows exactly what will be saved — so `C++` becomes `c` and `React_Native`
  becomes `react-native`, and pasted or space-separated text lands as clean chips instead
  of being silently mangled on save; the field caps at 20 with a live count. On
  GitLab, topics keep their case and spaces, so "React Native" stays one topic. Chips are
  fully keyboard-navigable — arrow between them, remove the focused one with Enter or its
  ✕, and Backspace in an empty add-box removes the last one.
