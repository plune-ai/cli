// Judge contract (ADR-SR01). A pure type — the orchestrator builds an implementation (wrapping a
// provider.complete at temperature 0, accumulating cost) and injects it via AssertionContext.judge.
// LLM-backed assertions (llm-judge, RAGAS) call `ask` instead of importing a provider directly.

export interface Judge {
  /** Ask the judge LLM a prompt and return its raw text response. */
  ask(prompt: string): Promise<string>;
}
