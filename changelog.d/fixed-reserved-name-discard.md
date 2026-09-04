- Discarding a file whose name matches a Windows device (`nul`, `con`, `com1`,
  and friends) now removes it. When the Recycle Bin won't accept such a name,
  GitDesktop deletes the file directly.
