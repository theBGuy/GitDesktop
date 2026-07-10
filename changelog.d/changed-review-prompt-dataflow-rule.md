- AI code review now has to trace its data-flow claims: a statement like "X arrives as
  parameter Y, sliced to N" must point at a real call site or be left out — fewer fabricated
  parameter and slicing claims in review findings.
