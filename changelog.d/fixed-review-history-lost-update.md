- Fixed a rare lost update in stored AI review history: when two changes to a
  PR's reviews landed at nearly the same time — for example an automated review
  finishing while you edit or delete another review's text — one change could
  silently overwrite the other. Overlapping writes are now serialized so neither
  is dropped.
