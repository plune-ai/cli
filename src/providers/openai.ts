// OpenAI provider adapter + OpenAI-compatible factory (ADR-PRV01).
// The factory is reused by the OpenRouter provider (same wire protocol, different base URL).

import OpenAI from 'openai';
import type {
  Provider,
  CompletionRequest,
  CompletionResponse,
  CostEstimate,
  AgentMessage,
  StepRequest,
  StepResponse,
  ToolCall,
} from '../types/provider.js';
import type { ProviderConfig, PricingMap } from '../types/config.js';
import { withRetry } from './retry.js';
import { resolveCostEntry, type Usage } from './cost.js';
import { AuthError, normalizeProviderError } from './errors.js';

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/**
 * The history on the Chat Completions wire: calls as `tool_calls` with JSON-string arguments, each answer a message of
 * role `tool`. The wire has no error flag on a tool message; the answer's own text says it failed.
 */
export function toOpenAiMessages(messages: AgentMessage[]): ChatMessage[] {
  return messages.flatMap((m): ChatMessage[] => {
    if (m.role === 'user') return [{ role: 'user', content: m.content }];
    if (m.role === 'tool')
      return m.results.map((r) => ({ role: 'tool', tool_call_id: r.id, content: r.content }));
    return [
      {
        role: 'assistant',
        content: m.text === '' ? null : m.text,
        ...(m.tool_calls.length > 0
          ? {
              tool_calls: m.tool_calls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: {
                  name: c.name,
                  arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {}),
                },
              })),
            }
          : {}),
      },
    ];
  });
}

/** `arguments` arrives as a string of JSON that may not parse, or may not be an object; then it is kept as sent. */
export function parseToolArguments(id: string, name: string, raw: string): ToolCall {
  try {
    const args: unknown = JSON.parse(raw === '' ? '{}' : raw);
    if (typeof args === 'object' && args !== null && !Array.isArray(args)) return { id, name, args };
  } catch {
    // kept as sent, below
  }
  return { id, name, args: raw, args_invalid: true };
}

const DEFAULT_MAX_RETRIES = 2;

export interface OpenAiCompatibleOptions {
  config: ProviderConfig;
  env: NodeJS.ProcessEnv;
  // `| undefined` is explicit so callers may forward an optional pricing arg under
  // exactOptionalPropertyTypes without conditional spreads.
  pricing?: PricingMap | undefined;
  /** Env var holding the API key (e.g. OPENAI_API_KEY, OPENROUTER_API_KEY). */
  apiKeyEnv: string;
  /** Override the API base URL for OpenAI-compatible providers (e.g. OpenRouter). */
  baseURL?: string;
  /**
   * Ask the endpoint to report the call's actual cost (OpenRouter `usage:{include:true}`), then
   * surface it as `CompletionResponse.cost_usd` (ADR-PRC02). Only OpenRouter supports this — the
   * direct OpenAI provider leaves it off so it never sends a non-standard `usage` body.
   */
  reportsCost?: boolean;
  /**
   * Send the output limit as `max_completion_tokens` (the direct OpenAI provider: newer OpenAI models refuse
   * `max_tokens`). Off, it goes as `max_tokens`, which OpenAI-compatible endpoints such as OpenRouter take.
   */
  maxCompletionTokens?: boolean;
}

/** Build a Provider backed by the OpenAI SDK against any OpenAI-compatible endpoint. */
export function makeOpenAiCompatibleProvider(opts: OpenAiCompatibleOptions): Provider {
  const { config, env, pricing, apiKeyEnv, baseURL, reportsCost, maxCompletionTokens } = opts;

  const apiKey = env[apiKeyEnv];
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new AuthError(
      `Missing ${apiKeyEnv}. Set it in your environment to use the ${config.type} provider.`,
      apiKeyEnv,
    );
  }

  const client = new OpenAI({
    apiKey,
    maxRetries: 0, // our own withRetry owns retry (ADR-PRV03)
    ...(baseURL !== undefined ? { baseURL } : {}),
    ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
  });
  const maxRetries = config.max_retries ?? DEFAULT_MAX_RETRIES;

  return {
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      try {
        const res = await withRetry(
          () =>
            client.chat.completions.create({
              model: req.model,
              ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
              ...(maxCompletionTokens
                ? { max_completion_tokens: req.max_tokens }
                : { max_tokens: req.max_tokens }),
              messages: [{ role: 'user', content: req.prompt_resolved }],
              // OpenRouter extension: ask it to include the call's actual cost in `usage` (ADR-PRC02).
              ...(reportsCost ? { usage: { include: true } } : {}),
            }),
          { max_retries: maxRetries },
        );

        // OpenRouter returns `usage.cost` (USD) — not in the OpenAI SDK type, hence the narrow cast.
        const reportedCost = reportsCost
          ? (res.usage as { cost?: number } | undefined)?.cost
          : undefined;

        // OpenRouter can answer 200 with an error inside the choice; surface it as finish_reason.
        const choice = res.choices[0] as ({ error?: unknown } & (typeof res.choices)[number]) | undefined;
        const finish = choice?.error !== undefined ? 'error' : choice?.finish_reason;
        return {
          output: choice?.message?.content ?? '',
          ...(typeof finish === 'string' ? { finish_reason: finish } : {}),
          usage: {
            input_tokens: res.usage?.prompt_tokens ?? 0,
            output_tokens: res.usage?.completion_tokens ?? 0,
          },
          ...(typeof reportedCost === 'number' ? { cost_usd: reportedCost } : {}),
        };
      } catch (err) {
        throw normalizeProviderError(err, apiKey, apiKeyEnv);
      }
    },

    async respond(req: StepRequest): Promise<StepResponse> {
      try {
        const res = await withRetry(
          () =>
            client.chat.completions.create({
              model: req.model,
              ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
              ...(maxCompletionTokens
                ? { max_completion_tokens: req.max_tokens }
                : { max_tokens: req.max_tokens }),
              messages: toOpenAiMessages(req.messages),
              tools: req.tools.map((t) => ({
                type: 'function' as const,
                function: {
                  name: t.name,
                  ...(t.description !== undefined ? { description: t.description } : {}),
                  parameters: t.input_schema,
                },
              })),
              ...(reportsCost ? { usage: { include: true } } : {}),
            }),
          { max_retries: maxRetries },
        );
        const reportedCost = reportsCost
          ? (res.usage as { cost?: number } | undefined)?.cost
          : undefined;
        const choice = res.choices[0] as ({ error?: unknown } & (typeof res.choices)[number]) | undefined;
        const finish = choice?.error !== undefined ? 'error' : choice?.finish_reason;
        return {
          text: choice?.message?.content ?? '',
          tool_calls: (choice?.message?.tool_calls ?? []).flatMap((c) =>
            c.type === 'function' ? [parseToolArguments(c.id, c.function.name, c.function.arguments)] : [],
          ),
          usage: {
            input_tokens: res.usage?.prompt_tokens ?? 0,
            output_tokens: res.usage?.completion_tokens ?? 0,
          },
          ...(typeof finish === 'string' ? { finish_reason: finish } : {}),
          ...(typeof reportedCost === 'number' ? { cost_usd: reportedCost } : {}),
        };
      } catch (err) {
        throw normalizeProviderError(err, apiKey, apiKeyEnv);
      }
    },

    estimateCost(usage: Usage, reportedCostUsd?: number): CostEstimate {
      return resolveCostEntry(usage, config.model, reportedCostUsd, pricing);
    },
  };
}

/** The first-party OpenAI provider. */
export function makeOpenAiProvider(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv,
  pricing?: PricingMap,
): Provider {
  return makeOpenAiCompatibleProvider({
    config,
    env,
    pricing,
    apiKeyEnv: 'OPENAI_API_KEY',
    maxCompletionTokens: true,
  });
}
