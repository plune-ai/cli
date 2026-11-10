import { isRecord, SCHEMA, TOOLS_PAGE, type RuleHit } from './rules.js';
import { estimateTokens } from './size.js';
import { LINT_THRESHOLDS } from './thresholds.js';
import type { CheckClass, CheckLevel, ListedTool } from './types.js';

/**
 * Rules over the answer of one live `tools/call` (`plune mcp lint --call`), beside the rules over the list. Their ids
 * start with `call-`. Like the list rules they read data only: the tool as listed and its result as sent.
 */
export interface CallRule {
  id: string;
  description: string;
  class: CheckClass;
  level: CheckLevel;
  fix: string;
  specRef: string;
  check(tool: ListedTool, result: unknown, context: CallContext): RuleHit[];
}

/** What a call rule needs from outside the module: a JSON Schema validator (the module itself imports nothing). */
export interface CallContext {
  /** Undefined when `value` is valid against `schema`; otherwise what is wrong, or why the schema does not compile. */
  validate(schema: Record<string, unknown>, value: unknown): string | undefined;
}

const T = LINT_THRESHOLDS;

/** The text blocks of a result's content. */
function texts(result: unknown): string[] {
  const content =
    isRecord(result) && Array.isArray(result.content) ? (result.content as unknown[]) : [];
  return content
    .filter(
      (c): c is { type: 'text'; text: string } =>
        isRecord(c) && c.type === 'text' && typeof c.text === 'string',
    )
    .map((c) => c.text);
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Equal as JSON values: the same keys and values, in any key order. */
function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => sameJson(x, b[i]))
    );
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length && keys.every((k) => k in b && sameJson(a[k], b[k]))
    );
  }
  return a === b;
}

const at = (tool: ListedTool) => ({ tool: tool.name });

export const CALL_RULES: readonly CallRule[] = [
  {
    id: 'call-result-large',
    description:
      'One call answers with more tokens than the limit; every such answer goes into the context of the model.',
    class: 'measure',
    level: 'warn',
    fix: 'Return less by default: a page with a cursor, a summary with the details behind another call, or fewer fields.',
    specRef: '',
    check: (tool, result) => {
      const tokens = estimateTokens(JSON.stringify(result) ?? '');
      if (tokens <= T.call.maxResultTokens) return [];
      return [
        {
          target: at(tool),
          message: `The answer to a call with {} costs about ${tokens} tokens.`,
          expected: `at most ${T.call.maxResultTokens} tokens`,
          actual: `${tokens} tokens (ceil(JSON.stringify(result).length / ${T.size.charsPerToken}))`,
        },
      ];
    },
  },
  {
    id: 'call-error-no-text',
    description: 'A call fails (isError) without a text that says what went wrong.',
    class: 'deterministic',
    level: 'warn',
    fix: 'Put what went wrong and what to do about it in a text block of the error result: the model reads it to try again.',
    specRef: TOOLS_PAGE,
    check: (tool, result) => {
      if (
        !isRecord(result) ||
        result.isError !== true ||
        texts(result).some((t) => t.trim() !== '')
      )
        return [];
      return [
        {
          target: at(tool),
          message: 'The call failed with no text the model can act on.',
          expected: 'isError with a text block',
          actual: 'isError with no text',
        },
      ];
    },
  },
  {
    id: 'call-structured-duplicates-text',
    description:
      'The text of a result is only the JSON of its structuredContent, so the same data is sent twice.',
    class: 'heuristic',
    level: 'info',
    fix: 'Clients that read structuredContent get the data twice. Keep the JSON text only for clients that need it, or make the text a short summary of the result.',
    specRef: '',
    check: (tool, result) => {
      if (!isRecord(result) || result.structuredContent === undefined) return [];
      const blocks = texts(result);
      if (
        blocks.length === 0 ||
        !blocks.every((t) => sameJson(parsed(t), result.structuredContent))
      )
        return [];
      return [
        {
          target: at(tool),
          message: 'The text content repeats structuredContent as JSON and says nothing more.',
          expected: 'a text that adds to structuredContent',
          actual: `${blocks.length} text block(s), each the JSON of structuredContent`,
        },
      ];
    },
  },
  {
    id: 'call-output-schema-mismatch',
    description:
      'A tool with an outputSchema answers without structuredContent, or with structuredContent the schema rejects.',
    class: 'deterministic',
    level: 'error',
    fix: 'Return structuredContent that matches the outputSchema the tool lists, or change the schema to what the tool returns.',
    specRef: `${SCHEMA}#tool-outputschema`,
    check: (tool, result, { validate }) => {
      if (!isRecord(tool.outputSchema) || !isRecord(result) || result.isError === true) return [];
      const wrong =
        result.structuredContent === undefined
          ? 'no structuredContent'
          : validate(tool.outputSchema, result.structuredContent);
      if (wrong === undefined) return [];
      return [
        {
          target: at(tool),
          message: 'The result does not match the output schema of the tool.',
          expected: 'structuredContent valid against outputSchema',
          actual: wrong,
        },
      ];
    },
  },
];
