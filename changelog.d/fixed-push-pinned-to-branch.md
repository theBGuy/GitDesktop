- A push started from the sync bar only ever sends the branch it was pressed
  on. When the checkout changes before a plain or force push starts (a switch
  in a terminal, or by an agent), nothing is pushed and a notice says so; a
  publish you confirmed still publishes the branch its prompt named. A
  confirmed force push also stops when the branch's tip changed after you
  confirmed it.
