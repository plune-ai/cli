import { z } from 'zod';

// --- Provider ---

const providerConfigSchema = z.object({
  type: z.enum(['anthropic', 'openai', 'openrouter']),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  concurrency: z.number().int().positive().optional(),
  timeout: z.number().int().positive().optional(),
  max_retries: z.number().int().min(0).optional(),
  // The values the OpenAI SDK's Chat Completions `reasoning_effort` accepts; only `openai` sends it.
  reasoning_effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
});

// --- Pricing override (ADR-PRV04) ---

const modelPriceSchema = z.object({
  input_per_1k_usd: z.number().nonnegative(),
  output_per_1k_usd: z.number().nonnegative(),
});

const pricingSchema = z.record(z.string(), modelPriceSchema);

// --- Dataset ---

const datasetRowSchema = z.object({
  vars: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  expected: z.string().optional(),
});

const datasetRefSchema = z.union([
  z.string().min(1),
  z.object({ examples: z.array(datasetRowSchema).min(1) }),
]);

// --- Assertion kinds (discriminated union — 10 types) ---

const exactMatchAssertionSchema = z.object({
  type: z.literal('exact-match'),
  value: z.string(),
  trim: z.boolean().optional(),
  ignore_case: z.boolean().optional(),
});

const containsAssertionSchema = z.object({
  type: z.literal('contains'),
  value: z.string(),
  ignore_case: z.boolean().optional(),
});

const containsAnyAssertionSchema = z.object({
  type: z.literal('contains-any'),
  values: z.array(z.string()).min(1),
  ignore_case: z.boolean().optional(),
});

const containsAllAssertionSchema = z.object({
  type: z.literal('contains-all'),
  values: z.array(z.string()).min(1),
  ignore_case: z.boolean().optional(),
});

const jsonSchemaAssertionSchema = z.object({
  type: z.literal('json-schema'),
  schema: z.record(z.string(), z.unknown()),
  extract: z.enum(['auto', 'strict']).optional(),
});

const llmJudgeAssertionSchema = z.object({
  type: z.literal('llm-judge'),
  criteria: z.string().min(1),
  provider: providerConfigSchema.partial().optional(),
  // The judge's score floor, not the eval's share of passing runs (that one is `evalRepeatsShape`).
  pass_threshold: z
    .number()
    .min(0, 'pass_threshold (llm-judge: minimum judge score) must be between 0 and 1')
    .max(1, 'pass_threshold (llm-judge: minimum judge score) must be between 0 and 1')
    .optional(),
});

const semanticSimilarityAssertionSchema = z.object({
  type: z.literal('semantic-similarity'),
  reference: z.string().min(1),
  threshold: z.number().min(0).max(1).optional(),
});

const faithfulnessAssertionSchema = z.object({
  type: z.literal('faithfulness'),
  context: z.string().min(1),
  threshold: z.number().min(0).max(1).optional(),
});

const answerRelevanceAssertionSchema = z.object({
  type: z.literal('answer-relevance'),
  question: z.string().min(1),
  threshold: z.number().min(0).max(1).optional(),
});

const contextPrecisionAssertionSchema = z.object({
  type: z.literal('context-precision'),
  context: z.string().min(1),
  question: z.string().min(1),
  threshold: z.number().min(0).max(1).optional(),
});

// --- Tool-call assertions: they read the transcript of an eval with `mcp` ---

const toolName = z.string().min(1);
const count = z.number().int().min(1);

const toolCallAssertionSchemas = [
  z.object({ type: z.literal('tool-called'), tool: toolName, min_count: count.optional() }),
  z.object({ type: z.literal('tool-not-called'), tool: toolName }),
  z.object({
    type: z.literal('tool-args'),
    tool: toolName,
    args: z.union([z.record(z.string(), z.unknown()), z.array(z.record(z.string(), z.unknown())).min(1)]),
    match: z.enum(['partial', 'exact', 'ignore']).optional(),
    min_count: count.optional(),
  }),
  z.object({
    type: z.literal('tool-order'),
    tools: z.array(toolName).min(1),
    strict: z.boolean().optional(),
  }),
  z.object({ type: z.literal('only-tools'), tools: z.array(toolName) }),
  z.object({ type: z.literal('first-tool'), tool: toolName }),
  z.object({ type: z.literal('no-tool-errors'), tool: toolName.optional() }),
  z
    .object({
      type: z.literal('tool-call-count'),
      tool: toolName.optional(),
      min: z.number().int().min(0).optional(),
      max: z.number().int().min(0).optional(),
    })
    .refine((a) => a.min !== undefined || a.max !== undefined, {
      message: 'tool-call-count needs min, max or both',
    })
    .refine((a) => a.min === undefined || a.max === undefined || a.min <= a.max, {
      message: 'tool-call-count: min is above max',
    }),
  z.object({ type: z.literal('no-repeated-call'), tool: toolName.optional() }),
  z.object({ type: z.literal('token-budget'), max: count }),
  z.object({ type: z.literal('tool-latency'), max_ms: z.number().positive(), tool: toolName.optional() }),
  z.object({
    type: z.literal('tool-result-size'),
    max_bytes: z.number().int().min(0),
    tool: toolName.optional(),
  }),
  z.object({
    type: z.literal('tool-result-schema'),
    schema: z.record(z.string(), z.unknown()),
    tool: toolName.optional(),
  }),
  z.object({ type: z.literal('no-destructive-tool') }),
] as const;

/** The types that need an eval with `mcp`: everywhere else there is no transcript for them to read. */
const TOOL_CALL_TYPES: ReadonlySet<string> = new Set(
  toolCallAssertionSchemas.map((s) => s.shape.type.value),
);

// Exported: part of the public API (see src/index.ts). The Plune platform validates the
// `assertions` array of a stored TestCase against this exact schema, so it must be the same
// object the runner uses — not a copy that can drift.
export const assertionConfigSchema = z.discriminatedUnion('type', [
  exactMatchAssertionSchema,
  containsAssertionSchema,
  containsAnyAssertionSchema,
  containsAllAssertionSchema,
  jsonSchemaAssertionSchema,
  llmJudgeAssertionSchema,
  semanticSimilarityAssertionSchema,
  faithfulnessAssertionSchema,
  answerRelevanceAssertionSchema,
  contextPrecisionAssertionSchema,
  ...toolCallAssertionSchemas,
]);

// --- Repeats: how many times each row runs, and the share of runs that must pass ---

/** Upper bound for `runs`: one typo in a config must not cost hundreds of runs per row. */
export const MAX_RUNS = 100;

const SHARE_MESSAGE =
  'pass_threshold (eval: share of runs that must pass) must be greater than 0 and at most 1';

// Accepted at the root and on each eval (the eval wins). Not the llm-judge `pass_threshold`.
const evalRepeatsShape = {
  runs: z.number().int().min(1).max(MAX_RUNS).optional(),
  pass_threshold: z.number().gt(0, SHARE_MESSAGE).max(1, SHARE_MESSAGE).optional(),
};

// --- MCP: the server an agentic eval talks to, and the limits that end its loop ---

// The longest a timer can wait; the connection core caps its durations at the same value.
const MAX_TIMER_MS = 2_147_483_647;
const limit = z.number().int().positive();

const mcpLimitsSchema = z
  .object({
    max_steps: limit.optional(),
    max_tool_calls: limit.optional(),
    max_total_tokens: limit.optional(),
    timeout_ms: limit.max(MAX_TIMER_MS).optional(),
    tool_timeout_ms: limit.max(MAX_TIMER_MS).optional(),
  })
  .strict();

const mcpServerSchema = z
  .object({
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict();

// The same two forms as the connection flags of `plune mcp`: a command (stdio) or a URL (HTTP).
const mcpServersSchema = z
  .record(z.string().min(1), mcpServerSchema)
  .superRefine((servers, ctx) => {
    for (const [name, server] of Object.entries(servers)) {
      const issue = (message: string) => ctx.addIssue({ code: 'custom', path: [name], message });
      const stdio = server.command !== undefined;
      const http = server.url !== undefined;
      if (stdio && http)
        issue(`server "${name}" has both command and url; give command (stdio) or url (HTTP), not both`);
      else if (!stdio && !http)
        issue(`server "${name}" needs command (a stdio server) or url (an HTTP server)`);
      else if (stdio && server.headers !== undefined)
        issue(`server "${name}": headers are for a server at url, not one started with command`);
      else if (http && (server.args ?? server.env ?? server.cwd) !== undefined)
        issue(`server "${name}": args, env and cwd are for a server started with command, not one at url`);
    }
  });

const mcpRootSchema = z
  .object({ servers: mcpServersSchema, limits: mcpLimitsSchema.optional() })
  .strict();

const evalMcpSchema = z
  .object({
    server: z.string().min(1),
    allowed_tools: z
      .array(z.string().min(1))
      .min(1, 'allowed_tools must name at least one tool; leave it out to allow every tool the server lists')
      .optional(),
    limits: mcpLimitsSchema.optional(),
  })
  .strict();

// --- EvalConfig ---

const evalConfigSchema = z
  .object({
    id: z.string().min(1).regex(/^[a-z0-9_-]+$/, 'id must be lowercase slug'),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    provider: providerConfigSchema.partial().optional(),
    prompt: z.string().optional(),
    prompt_file: z.string().optional(),
    dataset: datasetRefSchema,
    assertions: z.array(assertionConfigSchema),
    ...evalRepeatsShape,
    mcp: evalMcpSchema.optional(),
  })
  .refine(
    (data) => !(data.prompt !== undefined && data.prompt_file !== undefined),
    { message: 'prompt and prompt_file are mutually exclusive' }
  );

// --- Root config ---

export const pluneConfigSchema = z
  .object({
    version: z.literal(1),
    provider: providerConfigSchema,
    defaults: z
      .object({ assertions: z.array(assertionConfigSchema).optional() })
      .optional(),
    pricing: pricingSchema.optional(),
    ...evalRepeatsShape,
    // A CLI older than this block stops on it: the root is strict.
    mcp: mcpRootSchema.optional(),
    evals: z.array(evalConfigSchema).min(1),
  })
  .strict()
  .superRefine((config, ctx) => {
    config.evals.forEach((evalConfig, i) => {
      const server = evalConfig.mcp?.server;
      if (server === undefined) {
        // Refused here, before any model call: without `mcp` a tool-call assertion has nothing to measure.
        const misplaced = (assertions: { type: string }[], path: (string | number)[]) =>
          assertions.forEach((a, j) => {
            if (TOOL_CALL_TYPES.has(a.type))
              ctx.addIssue({
                code: 'custom',
                path: [...path, j, 'type'],
                message: `"${a.type}" reads the tool calls of an eval with mcp, and eval "${evalConfig.id}" has no mcp block`,
              });
          });
        misplaced(config.defaults?.assertions ?? [], ['defaults', 'assertions']);
        misplaced(evalConfig.assertions, ['evals', i, 'assertions']);
        return;
      }
      if (config.mcp?.servers[server] !== undefined) return;
      ctx.addIssue({
        code: 'custom',
        path: ['evals', i, 'mcp', 'server'],
        message: `eval "${evalConfig.id}" uses MCP server "${server}", which mcp.servers does not define`,
      });
    });
  });

export type PluneConfig = z.infer<typeof pluneConfigSchema>;

