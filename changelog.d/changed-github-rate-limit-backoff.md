- When one of GitHub's API rate limits runs out, GitDesktop waits for it to
  reset instead of sending requests GitHub would refuse, and the rate-limit
  notice checks back as soon as GitHub says access resumes.
