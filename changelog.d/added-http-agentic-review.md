- **Agentic review now works with API review models.** Beyond the CLI agents, turning on
  **Agentic review** with an HTTP/API model (Anthropic, OpenAI, OpenAI-compatible,
  OpenRouter, or Ollama) gives it a native read-only tool loop: it pulls the full PR diff
  past the prompt budget, reads any file at any ref, searches the repo, and runs history
  — reporting what it explores live in the status line. There's no review workspace
  to prepare, so these reviews start instantly, and it's read-only end to end. Each tool
  step is an extra model call (slower and pricier), and small local models that can't do
  tool calling fail with a clear message to turn agentic off or pick another model.
