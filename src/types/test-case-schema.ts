import { z } from 'zod';
import type { TestCase } from './results.js';

/**
 * Runtime validation for the TestCase contract — the JSON that `plune run import` emits
 * or that the platform accepts on `POST /v1/test-cases`.
 *
 * The canonical TypeScript shape is owned by `./results.ts` (`TEST_CASE_SCHEMA_VERSION: 2`).
 * This module is its zod mirror: the validator for anything that has to *ingest* that
 * output rather than produce it. `plune sync` validates the local case file with it
 * before uploading, and the Plune platform validates the same body on
 * `POST /v1/test-cases` — one schema, both ends.
 */

export const TEST_CASE_SCHEMA_VERSION: TestCase['schemaVersion'] = 2;

export const externalKeySchema = z.object({
  kind: z.enum(['playwright-id', 'path-title', 'allure-history', 'cairn-stable', 'eval-id', 'qase', 'testrail']),
  value: z.string().min(1),
});

export const manualStepSchema = z.object({
  action: z.string().min(1),
  expected: z.string().min(1).optional(),
});

const assertionResultRecordSchema = z.object({
  type: z.string().min(1),
  passed: z.boolean(),
  score: z.number().optional(),
  reason: z.string().optional(),
});

const manualCaseSchema = z.object({
  type: z.literal('manual'),
  steps: z.array(manualStepSchema).min(1),
  expected: z.string().min(1).optional(),
});

const automatedCaseSchema = z.object({
  type: z.literal('automated'),
  specRef: z.string().min(1),
});

const evalCaseSchema = z.object({
  type: z.literal('eval'),
  prompt: z.string().min(1),
  goldenSetId: z.string().min(1).optional(),
  assertions: z.array(assertionResultRecordSchema).min(1),
});

const testCaseBaseSchema = z.object({
  schemaVersion: z.literal(TEST_CASE_SCHEMA_VERSION),
  id: z.string().min(1),
  externalKeys: z.array(externalKeySchema).optional(),
  /** ADR 0045 / plune#1246 — optional, purely additive; schemaVersion stays 2. */
  is_flaky: z.boolean().optional(),
  /** ADR 0045 / plune#1246 — optional, purely additive; schemaVersion stays 2. */
  is_muted: z.boolean().optional(),
});

export const testCaseSchema = z.discriminatedUnion('type', [
  testCaseBaseSchema.merge(manualCaseSchema),
  testCaseBaseSchema.merge(automatedCaseSchema),
  testCaseBaseSchema.merge(evalCaseSchema),
]);

/** Parse + validate an unknown value as a TestCase. Throws ZodError on failure. */
export function parseTestCase(value: unknown) {
  return testCaseSchema.parse(value);
}