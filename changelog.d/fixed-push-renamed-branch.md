- Push now understands a branch whose remote branch has a different name (after
  a rename, or a checkout from someone else's branch): the sync bar's **Push** opens
  a menu to pick the destination, either the branch it tracks or publishing under
  the new name and tracking that. When Git refuses such a push anyway, the message
  says exactly why and what to do.
