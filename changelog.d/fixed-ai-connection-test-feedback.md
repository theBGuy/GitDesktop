- **AI failures explain themselves.** A failed **Test connection**, generation, or AI
  review now shows the provider's own reason (e.g. "Invalid Auth key.", a quota
  message, or Ollama's "model not found") instead of a bare "Bad Request", and the
  connection-test result clears whenever what it tested changes — key saved or
  removed, provider or model switched, allowed hosts edited — so a setup you just
  fixed no longer looks broken.
