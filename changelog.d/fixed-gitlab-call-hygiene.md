- Self-managed GitLab reads follow the repository's instance or your glab
  default instance. Saved credentials take priority over environment tokens for
  another instance, while setups authenticated only by an environment token
  continue to work. Reconnecting to an instance signs in with that instance's
  own credentials, even when an environment token for another one is set.
