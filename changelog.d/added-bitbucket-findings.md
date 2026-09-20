- **The Findings tab reads Bitbucket Code Insights.** On a Bitbucket repo the tab
  now lists the reports published against your branch's tip commit (falling back to
  the default branch, and saying so), a section per report with what it covers, its
  reporter, its result (Passed, Failed, Pending, or Unspecified when the tool posted
  none), its metrics, and its description. The report's annotations are the rows,
  worst severity first, each with what it reports and the file and line it points
  at; select one for its full text, and where the scanner attached a link, open the
  advisory or rule page it points to. Anything already writing Code Insights from
  your pipeline shows up here with no extra setup, and a commit with nothing
  published says so instead of reading clean.
