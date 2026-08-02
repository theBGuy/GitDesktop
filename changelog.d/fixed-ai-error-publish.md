- A failed AI run no longer passes its error text off as a result: an outage or a
  usage limit that interrupts a review never gets posted to your PR, and one that
  interrupts a generation never lands in the commit-message or other drafts.
  Failed reviews land in **Activity & notifications** with the reason (automated
  ones with a one-click re-run), and posting a review that stopped part-way asks
  first.
