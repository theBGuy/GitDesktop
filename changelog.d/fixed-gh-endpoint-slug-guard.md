- GitHub API calls aimed at the open repository refuse a slug
  that isn't plain `owner/repo`, so a crafted remote URL can't
  retarget them at a different repository.
