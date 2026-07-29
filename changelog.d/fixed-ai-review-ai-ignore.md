- Your **AI ignore patterns** are now honored by AI reviews — the ones you start
  from the PR panel and the automated ones alike, including the "changes since
  your last review" delta they build on — where the whole diff previously
  reached the provider. The prompt states how many files were held back rather
  than passing the diff off as complete, and if every changed file is excluded,
  nothing is sent at all. As everywhere else, a model that reads your repository
  itself isn't limited by these patterns — that's what **Agentic review** on a
  pull request turns on.
