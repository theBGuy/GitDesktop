- A plain or force push started from the sync bar is refused when the checkout
  has moved off the branch it was pressed on before the push starts (a switch
  in a terminal, or by an agent): nothing is pushed and a notice says so;
  **Publish branch**, once you confirm its prompt, still publishes the branch
  the prompt named. A force push also stops when the branch's tip is no longer
  the one its confirm dialog opened on. In a repository whose `push.default`
  is `matching`, or whose remote has push refspecs of its own, a force push
  from the sync bar is refused with the reason, since it could rewrite other
  branches too.
