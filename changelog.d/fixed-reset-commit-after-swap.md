- Reset to _origin/…_ on the branch you're on checks the branch once more just
  before it updates your files: if another Git process committed on it after
  the reset moved it, the reset stops with your files as they were and that
  commit kept, and the toast says where the branch points now when it can tell.
