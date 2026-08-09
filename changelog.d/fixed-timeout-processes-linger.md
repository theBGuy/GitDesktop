- On Windows, a Git operation that hits its time limit is now stopped together
  with the helper processes it started, instead of continuing to change the
  repository in the background after the app reported it as failed.