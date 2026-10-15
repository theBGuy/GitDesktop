- Push now understands a branch whose remote branch has a different name (after
  a rename, or a checkout from someone else's branch): the sync bar's **Push**
  opens a menu to push to the branch it tracks or to publish under its own name
  and track that. When Git knows the tracked branch is the remote's default
  branch, only the publish option appears. When Git refuses such a push anyway,
  the message says why and what to do.
