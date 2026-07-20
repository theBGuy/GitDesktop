- **Dedicated security-audit model.** Give AI security audits their own provider and model,
  separate from the general review model — e.g. a stronger model for audits and a faster one
  for everyday reviews. Toggle **Use a different model for security audits** under the review
  model in Settings → AI; left off, audits keep using the review model exactly as before. The
  choice applies to both automated audits and the **Security audit** button on a PR (an
  in-panel model pick still overrides both for that one run).
