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

/**
 * How much a `tools/list` answer costs a model on every request, estimated without a tokenizer.
 * ponytail: an estimate (characters / charsPerToken); the token-budget work (tracker #2419) calibrates it against a
 * real tokenizer and replaces this function, and the lint keeps calling whatever it exports.
 */
export function toolListSize(tools: readonly ListedTool[]): ToolListSize {
  const { charsPerToken } = LINT_THRESHOLDS.size;
  const sizes = tools.map((t) => ({ name: t.name, tokens: Math.ceil(JSON.stringify(t).length / charsPerToken) }));
  let largest: ToolListSize['largest'];
  for (const s of sizes) if (largest === undefined || s.tokens > largest.tokens) largest = s;
  return {
    totalTokens: sizes.reduce((sum, s) => sum + s.tokens, 0),
    tools: sizes,
    largest,
    method: `ceil(JSON.stringify(tool).length / ${charsPerToken}) per tool, summed`,
  };
}
