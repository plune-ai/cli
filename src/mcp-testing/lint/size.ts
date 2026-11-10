import { LINT_THRESHOLDS } from './thresholds.js';
import type { ListedTool } from './types.js';

export interface ToolListSize {
  /** Estimated tokens of the whole list: the sum over its tools. */
  totalTokens: number;
  tools: { name: string; tokens: number }[];
  /** The biggest tool by name, so a report can say what to shorten first; undefined for an empty list. */
  largest: { name: string; tokens: number } | undefined;
  method: string;
}

/** Estimated tokens of a JSON text: its characters divided by `charsPerToken`, rounded up. See the error noted there. */
export const estimateTokens = (json: string): number => Math.ceil(json.length / LINT_THRESHOLDS.size.charsPerToken);

/** What JSON.stringify leaves out of an object; in an array it writes null for them instead. */
const skipped = (v: unknown) => v === undefined || typeof v === 'function' || typeof v === 'symbol';

/**
 * The text JSON.stringify gives for a JSON value (what JSON.parse returns), written with a stack of its own instead of
 * the call stack: JSON.stringify throws past a few thousand levels, and a server chooses how deep its data nests.
 */
export function jsonText(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  const out: string[] = [];
  // What is left to write, last first: a literal piece of text, or a value.
  const todo: ({ text: string } | { value: unknown })[] = [{ value }];
  for (let step = todo.pop(); step !== undefined; step = todo.pop()) {
    if ('text' in step) out.push(step.text);
    else if (typeof step.value !== 'object' || step.value === null) out.push(JSON.stringify(step.value) ?? 'null');
    else {
      const array = Array.isArray(step.value);
      const entries = Object.entries(step.value).filter(([, v]) => array || !skipped(v));
      const parts: typeof todo = [{ text: array ? '[' : '{' }];
      entries.forEach(([key, v], i) => {
        const sep = i === 0 ? '' : ',';
        parts.push({ text: array ? sep : `${sep}${JSON.stringify(key)}:` }, { value: v });
      });
      parts.push({ text: array ? ']' : '}' });
      for (const part of parts.reverse()) todo.push(part);
    }
  }
  return out.join('');
}

/**
 * How much a `tools/list` answer costs a model on every request, estimated without a tokenizer: each tool's JSON as
 * the client receives it (outputSchema and annotations included), through `estimateTokens`, summed.
 */
export function toolListSize(tools: readonly ListedTool[]): ToolListSize {
  const { charsPerToken } = LINT_THRESHOLDS.size;
  const sizes = tools.map((t) => ({ name: t.name, tokens: estimateTokens(jsonText(t) ?? '') }));
  let largest: ToolListSize['largest'];
  for (const s of sizes) if (largest === undefined || s.tokens > largest.tokens) largest = s;
  return {
    totalTokens: sizes.reduce((sum, s) => sum + s.tokens, 0),
    tools: sizes,
    largest,
    method: `ceil(JSON.stringify(tool).length / ${charsPerToken}) per tool, summed`,
  };
}
