- AI re-reviews now read long GitDesktop-posted PR comments (context briefs, triage
  summaries) in full when the review-context budget has room — previously every such comment
  was silently cut to 1,500 characters no matter how much budget was free, so a reviewer
  could be handed a numbered list that stopped after item 2. A comment that still has to be
  trimmed now says so explicitly in the prompt instead of trailing off in a bare ellipsis.
