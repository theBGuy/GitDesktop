- Cancelling an agent turn and immediately sending a new prompt keeps the two
  turns apart: the cancelled turn keeps its own late output and saved transcript,
  and the new turn streams and checkpoints on its own.
