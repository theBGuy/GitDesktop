- GitHub API calls refuse a repository slug carrying URL-template characters
  (`{`, `}`, `?`, `#`), so a crafted remote URL can't retarget them at a
  different repository.
