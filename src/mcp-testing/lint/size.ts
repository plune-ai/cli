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

/**
 * How much a `tools/list` answer costs a model on every request, estimated without a tokenizer: each tool's JSON as
 * the client receives it (outputSchema and annotations included), through `estimateTokens`, summed.
 */
export function toolListSize(tools: readonly ListedTool[]): ToolListSize {
  const { charsPerToken } = LINT_THRESHOLDS.size;
  const sizes = tools.map((t) => ({ name: t.name, tokens: estimateTokens(JSON.stringify(t)) }));
  let largest: ToolListSize['largest'];
  for (const s of sizes) if (largest === undefined || s.tokens > largest.tokens) largest = s;
  return {
    totalTokens: sizes.reduce((sum, s) => sum + s.tokens, 0),
    tools: sizes,
    largest,
    method: `ceil(JSON.stringify(tool).length / ${charsPerToken}) per tool, summed`,
  };
}
