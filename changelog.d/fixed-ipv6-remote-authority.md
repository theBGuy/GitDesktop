- Remotes hosted at a bracketed IPv6 address, like
  `https://[2001:db8::1]:8443/group/repo`, are recognized as the host they name, so
  provider detection, credential handling, and the reconnect commands see the real host.
