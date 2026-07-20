- **Phone companion (experimental preview).** Share your repositories with your
  phone over your local network from **Settings → Phone companion**: pair a device by
  scanning a QR code and typing a PIN. Scanning opens a slim companion web app right
  in your phone's browser — pair with the PIN, then read a repo's **Status, pull
  requests, and CI** from your phone, read-only. Open a pull request for its overview,
  activity timeline, and review-thread conversation, and watch live **AI PR reviews and
  agent sessions** stream in as they happen. Your phone always sees the repository open
  on this desktop, and you can **share and unshare additional repositories** (from the
  panel or the command palette) to keep them reachable while you work in another —
  switching repos no longer cuts a phone watching a shared repository. The companion honors
  your **Hide AI features** setting — turn it on and the phone's Agents tab and live agent-run
  watching disappear too, matching the desktop. Off by default, with per-device tokens
  you can review and revoke at any time (even while sharing is off), and connected
  phones are disconnected the moment you stop sharing, unshare a repository, or revoke their
  device. While sharing is on, GitDesktop keeps your computer awake so a phone can keep
  watching unattended (the display may still sleep). The connection is served over HTTPS
  with a self-signed certificate GitDesktop generates — your phone shows a one-time
  certificate warning on first connect, and the pairing dialog shows the certificate's
  SHA-256 fingerprint so you can verify it.
