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
});

// --- Pricing override (ADR-PRV04) ---

const modelPriceSchema = z.object({
  input_per_1k_usd: z.number().nonnegative(),
  output_per_1k_usd: z.number().nonnegative(),
});

const pricingSchema = z.record(modelPriceSchema);

// --- Dataset ---

const datasetRowSchema = z.object({
  vars: z.record(z.union([z.string(), z.number(), z.boolean()])),
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
  schema: z.record(z.unknown()),
  extract: z.enum(['auto', 'strict']).optional(),
});

const llmJudgeAssertionSchema = z.object({
  type: z.literal('llm-judge'),
  criteria: z.string().min(1),
  provider: providerConfigSchema.partial().optional(),
  pass_threshold: z.number().min(0).max(1).optional(),
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

const assertionConfigSchema = z.discriminatedUnion('type', [
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
]);

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
    evals: z.array(evalConfigSchema).min(1),
  })
  .strict();

export type PluneConfig = z.infer<typeof pluneConfigSchema>;

