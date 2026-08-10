- **AI connection tests explain themselves.** A failed **Test connection** now shows
  the provider's own reason (e.g. "Invalid Auth key.") instead of a bare "Bad
  Request", the result clears when you save or remove a key so a fixed setup no
  longer looks broken, and a pasted key with stray whitespace is trimmed before
  testing — matching what Save stores.
