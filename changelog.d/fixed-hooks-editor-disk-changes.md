- **Git hooks** catch up with a hook that changes on disk while it's open the
  next time GitDesktop reads it (when you select it, after you save, enable or
  disable a hook, or when you switch back to the app): an unedited script shows
  the new text, an edited one keeps your edit with a **Reload** option, and
  **Save** waits until a newly selected hook's script has loaded. **Save**,
  **Disable** and **Enable** stop with a notice when the terminal push guard was
  added or removed since the list loaded, and a hook whose script can't be read
  when you select it says why and offers **Retry**.
