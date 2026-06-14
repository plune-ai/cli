// Shared scaffolding for LLM-backed assertions (ADR-SR02). Pure given an injected Judge.
// Each metric asks the judge for a JSON response and parses the shape it expects; a non-JSON or
// shape-less response throws (→ orchestrator maps the row to `error`, AC-10).

import type { Judge } from '../types/judge.js';
import { extractJson } from './json-extract.js';

/** Ask the judge and parse its response as JSON (auto-extracted); throw if unparseable. */
export async function askJson(judge: Judge, prompt: string): Promise<unknown> {
  const text = await judge.ask(prompt);
  const result = extractJson(text, 'auto');
  if (!result.ok) {
    throw new Error(`judge returned no parseable JSON (got: ${text.slice(0, 120)})`);
  }
  return result.value;
}

function asObject(judgment: unknown): Record<string, unknown> {
  if (typeof judgment !== 'object' || judgment === null) {
    throw new Error('judge response is not a JSON object');
  }
  return judgment as Record<string, unknown>;
}

/** Parse `{ score: number, reason?: string }` (llm-judge, context-precision). */
export function parseScored(judgment: unknown): { score: number; reason?: string } {
  const obj = asObject(judgment);
  const raw = obj['score'];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    // Non-finite (NaN/±Infinity) is unusable → fail loud (the judge can't be trusted, AC-10).
    throw new Error('judge response missing a finite numeric "score"');
  }
  // A finite but out-of-range score is a minor judge quirk → clamp to the documented 0..1 range.
  const score = Math.max(0, Math.min(1, raw));
  const reason = obj['reason'];
  return typeof reason === 'string' ? { score, reason } : { score };
}

/** Parse `{ statements: [{ faithful: boolean }] }` → the per-claim faithful flags (faithfulness). */
export function parseStatements(judgment: unknown): boolean[] {
  const arr = asObject(judgment)['statements'];
  if (!Array.isArray(arr)) {
    throw new Error('judge response missing "statements" array');
  }
  return arr.map(
    (s) => typeof s === 'object' && s !== null && (s as Record<string, unknown>)['faithful'] === true,
  );
}

/** Parse `{ questions: string[] }` (answer-relevance). */
export function parseQuestions(judgment: unknown): string[] {
  const arr = asObject(judgment)['questions'];
  if (!Array.isArray(arr)) {
    throw new Error('judge response missing "questions" array');
  }
  return arr.filter((q): q is string => typeof q === 'string');
}
