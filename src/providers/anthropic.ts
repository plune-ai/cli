// Anthropic provider adapter (ADR-PRV01). I/O edge: the only network in this file is the SDK call.

import Anthropic from '@anthropic-ai/sdk';
import type {
  Provider,
  CompletionRequest,
  CompletionResponse,
  CostEstimate,
  AgentMessage,
  StepRequest,
  StepResponse,
} from '../types/provider.js';
import type { ProviderConfig, PricingMap } from '../types/config.js';
import { withRetry } from './retry.js';
import { resolveCostEntry, type Usage } from './cost.js';
import { AuthError, normalizeProviderError } from './errors.js';

const ENV_VAR = 'ANTHROPIC_API_KEY';
const DEFAULT_MAX_RETRIES = 2;

const STOP: Record<string, string> = {
  tool_use: 'tool_calls',
  end_turn: 'stop',
  max_tokens: 'length',
};

/**
 * Model ids (by prefix) that still take `temperature` under the API version the SDK sends. Every
 * other model, current or new, rejects sampling parameters or takes only their default, so it gets
 * none and a new model needs no change here. Limit: the list holds the ids Anthropic's docs name as
 * accepting it; a new model that still takes it would need adding.
 */
const TAKES_TEMPERATURE = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
  'claude-opus-4-1',
  'claude-opus-4-0',
  'claude-sonnet-4-0',
  'claude-opus-4-2025',
  'claude-sonnet-4-2025',
  'claude-3',
];

// Models already warned about in this run (the process), so the warning shows once, not per row or eval.
const warnedNoTemperature = new Set<string>();

/** The request's `temperature` if the model takes one; a configured value it would refuse is dropped, and said once. */
export function temperatureFor(model: string, temperature: number | undefined): { temperature?: number } {
  if (temperature === undefined) return {};
  if (TAKES_TEMPERATURE.some((prefix) => model.startsWith(prefix))) return { temperature };
  if (!warnedNoTemperature.has(model)) {
    warnedNoTemperature.add(model);
    process.stderr.write(
      `warning: ${model} does not take a temperature; the configured temperature ${temperature} is not sent\n`,
    );
  }
  return {};
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The history on the Messages wire: calls as `tool_use` blocks, their answers as `tool_result` blocks of one user turn. */
export function toAnthropicMessages(messages: AgentMessage[]): Anthropic.MessageParam[] {
  return messages.map((m): Anthropic.MessageParam => {
    if (m.role === 'user') return { role: 'user', content: m.content };
    if (m.role === 'tool')
      return {
        role: 'user',
        content: m.results.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.id,
          content: r.content,
          is_error: r.is_error,
        })),
      };
    return {
      role: 'assistant',
      content: [
        ...(m.text !== '' ? [{ type: 'text' as const, text: m.text }] : []),
        ...m.tool_calls.map((c) => ({
          type: 'tool_use' as const,
          id: c.id,
          name: c.name,
          input: isObject(c.args) ? c.args : {},
        })),
      ],
    };
  });
}

export function makeAnthropicProvider(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv,
  pricing?: PricingMap,
): Provider {
  const apiKey = env[ENV_VAR];
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new AuthError(
      `Missing ${ENV_VAR}. Set it in your environment to use the anthropic provider.`,
      ENV_VAR,
    );
  }

  // maxRetries: 0 — our own withRetry owns retry; never let the SDK double-retry (ADR-PRV03).
  const client = new Anthropic({
    apiKey,
    maxRetries: 0,
    ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
  });
  const maxRetries = config.max_retries ?? DEFAULT_MAX_RETRIES;

  return {
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      try {
        const res = await withRetry(
          () =>
            client.messages.create({
              model: req.model,
              max_tokens: req.max_tokens,
              ...temperatureFor(req.model, req.temperature),
              messages: [{ role: 'user', content: req.prompt_resolved }],
            }),
          { max_retries: maxRetries },
        );

        const output = res.content
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('');
        return {
          output,
          usage: {
            input_tokens: res.usage.input_tokens,
            output_tokens: res.usage.output_tokens,
          },
          ...(res.stop_reason === 'max_tokens'
            ? { finish_reason: 'length' }
            : res.stop_reason !== null && res.stop_reason !== undefined
              ? { finish_reason: res.stop_reason }
              : {}),
        };
      } catch (err) {
        throw normalizeProviderError(err, apiKey, ENV_VAR);
      }
    },

    async respond(req: StepRequest): Promise<StepResponse> {
      try {
        const res = await withRetry(
          () =>
            client.messages.create({
              model: req.model,
              max_tokens: req.max_tokens,
              ...temperatureFor(req.model, req.temperature),
              messages: toAnthropicMessages(req.messages),
              tools: req.tools.map((t) => ({
                name: t.name,
                ...(t.description !== undefined ? { description: t.description } : {}),
                input_schema: { ...t.input_schema, type: 'object' as const },
              })),
            }),
          { max_retries: maxRetries },
        );
        const stop = res.stop_reason ?? undefined;
        return {
          text: res.content.map((block) => (block.type === 'text' ? block.text : '')).join(''),
          tool_calls: res.content.flatMap((block) =>
            block.type === 'tool_use'
              ? [{ id: block.id, name: block.name, args: block.input }]
              : [],
          ),
          usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens },
          ...(stop !== undefined ? { finish_reason: STOP[stop] ?? stop } : {}),
        };
      } catch (err) {
        throw normalizeProviderError(err, apiKey, ENV_VAR);
      }
    },

    estimateCost(usage: Usage, reportedCostUsd?: number): CostEstimate {
      // Anthropic does not report cost → reportedCostUsd is undefined here; resolveCost estimates.
      return resolveCostEntry(usage, config.model, reportedCostUsd, pricing);
    },
  };
}
