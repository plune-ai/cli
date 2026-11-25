// Judge contract (ADR-SR01). A pure type — the orchestrator builds an implementation (wrapping a
// provider.complete at temperature 0, accumulating cost) and injects it via AssertionContext.judge.
// LLM-backed assertions (llm-judge, RAGAS) call `ask` instead of importing a provider directly.

/** What a decision judge is asked: does `output`, the answer to `input`, meet `criteria`? */
export interface DecisionQuestion {
  criteria: string;
  output: string;
  input?: string;
}

/** A decision judge's answer: the probability of "yes", and the exact model version that gave it. */
export interface DecisionAnswer {
  probability: number;
  model: string;
}

export interface Judge {
  /** Ask the judge LLM a prompt and return its raw text response. */
  ask(prompt: string): Promise<string>;
  /**
   * Only a decision model has it (the experimental `jev` judge of an `llm-judge` check): the probability, 0 to 1,
   * that the answer meets the criteria. Such a judge gives no reason, and its `ask` throws.
   */
  decide?(question: DecisionQuestion): Promise<DecisionAnswer>;
}
