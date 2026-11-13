import { z } from 'zod';

/**
 * Input shapes of the tools, mirrored from the platform's contracts (`src/contracts/mission.ts`,
 * `mission-strategy.ts`, `review-item.ts`, `cairn-ingest.ts`, `api-endpoint.ts`). Mirrored, not imported: the platform
 * depends on this package, not the other way round. The platform validates every body again, so a drift here shows up
 * as its 400 with the field named — never as a write the caller did not mean.
 */

/** Objects one call takes. */
export const BATCH_MAX = 100;

const isHttp = (s: string): boolean => {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

const httpLink = (what: string, max: number) =>
  z.string().trim().min(1, `${what} is empty`).max(max).refine(isHttp, `${what} must be an http or https address`);

export const id = (what: string) => z.string().min(1).describe(what);

export const dryRun = z
  .boolean()
  .optional()
  .describe('true: answer what would be sent, and send nothing');

// --- Missions (#2188) ---------------------------------------------------------------------------

export const MISSION_STATES = ['draft', 'active', 'done'] as const;
export const MISSION_DOCUMENTATION = ['unknown', 'provided', 'none'] as const;
export const MISSION_LINK_KINDS = ['url', 'openapi', 'repo', 'ticket'] as const;

const missionName = z.string().trim().min(1, 'a mission needs a name').max(200);
const missionSummary = z.string().trim().max(2_000).describe('What the product is, in 3-5 sentences');
const missionUrl = httpLink('url', 2_048).nullable().describe('Where the product runs; null takes it off');

export const missionFields = {
  name: missionName,
  summary: missionSummary.optional(),
  url: missionUrl.optional(),
  state: z.enum(MISSION_STATES).optional(),
  documentation: z
    .enum(MISSION_DOCUMENTATION)
    .optional()
    .describe('Is there documentation: provided (it is among the sources), none, or unknown'),
};

const sourceTitle = z.string().trim().min(1).max(200);
const sourceVersion = z.string().trim().min(1).max(200).describe('A commit, a tag, a revision, an ETag');

export const linkSource = z.strictObject({
  missionId: id('The mission'),
  kind: z.enum(MISSION_LINK_KINDS),
  ref: httpLink('ref', 2_048).describe('The link'),
  title: sourceTitle.optional(),
  version: sourceVersion.optional(),
  dry_run: dryRun,
});

export const fileSource = z.strictObject({
  missionId: id('The mission'),
  kind: z.literal('file'),
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/\.(txt|md|markdown|json)$/i, 'a source file is .txt, .md, .markdown or .json')
    .describe('The file name; its extension sets the type'),
  text: z.string().max(1_048_576).describe('The whole text of the file, UTF-8, at most 1 MiB'),
  title: sourceTitle.optional(),
  version: sourceVersion.optional(),
  dry_run: dryRun,
});

// --- Questions (#2189) --------------------------------------------------------------------------

export const ACCESS_KINDS = ['openapi', 'repo', 'staging', 'har'] as const;
const questionText = z.string().trim().min(1).max(2_000);

export const questionInput = z.strictObject({
  template: z
    .enum(['plain', 'access'])
    .describe('plain: a question with up to three options; access: ask for an API description, the code, a staging host or a HAR file'),
  text: questionText,
  missionId: z.string().min(1).optional(),
  options: z
    .array(z.string().trim().min(1).max(200))
    .min(1)
    .max(3)
    .refine((o) => new Set(o).size === o.length, { message: 'no two options are the same' })
    .optional()
    .describe('plain only: what the person may pick from'),
  access: z
    .array(z.enum(ACCESS_KINDS))
    .min(1)
    .max(ACCESS_KINDS.length)
    .refine((a) => new Set(a).size === a.length, { message: 'an access kind is named once' })
    .optional()
    .describe('access only: what you ask to be given'),
  dry_run: dryRun,
});

// --- Strategy (#2190) ---------------------------------------------------------------------------

export const STRATEGY_SOURCE_KINDS = ['mission-source', 'doc-section', 'screen', 'endpoint', 'requirement', 'url'] as const;
export const TEST_LEVELS = ['component', 'component-integration', 'system', 'system-integration', 'acceptance'] as const;
export const QUALITY_CHARACTERISTICS = [
  'functional-suitability',
  'performance-efficiency',
  'compatibility',
  'interaction-capability',
  'reliability',
  'security',
  'maintainability',
  'flexibility',
  'safety',
] as const;
export const TEST_TECHNIQUES = [
  'equivalence-partitioning',
  'boundary-value',
  'decision-table',
  'state-transition',
  'statement',
  'branch',
  'error-guessing',
  'exploratory',
  'checklist',
] as const;
export const RISK_SCALE = ['low', 'medium', 'high'] as const;

const itemFields = {
  text: z.string().trim().min(1).max(1_000).describe('Markdown'),
  source: z
    .strictObject({ kind: z.enum(STRATEGY_SOURCE_KINDS), ref: z.string().trim().min(1).max(300) })
    .optional()
    .describe('Where it was read'),
  assumption: z.literal(true).optional().describe('You assumed it: a person confirms'),
  waitingOn: z.string().min(1).optional().describe('The id of an open question of this mission it waits for'),
};
const strategyItem = z.strictObject(itemFields);
const items = z.array(strategyItem).min(1).max(25);
const unique = <T extends string>(values: readonly [T, ...T[]]) =>
  z
    .array(z.enum(values))
    .min(1)
    .refine((a) => new Set(a).size === a.length, { message: 'named once' });
const linkIds = z
  .array(z.string().min(1))
  .max(50)
  .refine((a) => new Set(a).size === a.length, { message: 'an id is named once' });
const share = z.number().int().min(0).max(100);

export const strategyContent = z.strictObject({
  objectives: items,
  scope: z.strictObject({ in: items, out: items.describe('What is deliberately not tested, and why') }),
  approach: items,
  profile: z.strictObject({
    levels: unique(TEST_LEVELS),
    characteristics: unique(QUALITY_CHARACTERISTICS),
    techniques: unique(TEST_TECHNIQUES),
    split: z
      .strictObject({ api: share, ui: share, manual: share })
      .refine((s) => s.api + s.ui + s.manual === 100, { message: 'the split of api, ui and manual adds up to 100' }),
    notes: items,
  }),
  risks: z
    .array(
      z.strictObject({
        ...itemFields,
        likelihood: z.enum(RISK_SCALE),
        impact: z.enum(RISK_SCALE),
        caseIds: linkIds.optional(),
        requirementIds: linkIds.optional(),
      }),
    )
    .min(1)
    .max(50),
  entryCriteria: items,
  exitCriteria: items,
});

// --- Case proposals (ingest) ----------------------------------------------------------

export const SOURCE_REF_KINDS = ['url', 'openapi-operation', 'requirement', 'pasted-text'] as const;

export const proposedCase = z.strictObject({
  title: z.string().trim().min(1).max(300),
  steps: z.array(z.string().trim().min(1).max(400)).min(1).max(20),
  expected: z.string().trim().min(1).max(2_000),
  execution: z.enum(['auto', 'manual']).optional().describe('auto: can be automated; manual (default): stays with a person'),
  technique: z.string().min(1).max(32).optional(),
  priority: z.string().min(1).optional(),
  source: z
    .strictObject({ kind: z.enum(SOURCE_REF_KINDS), value: z.string().min(1).max(100) })
    .optional()
    .describe('What you read to design it'),
  rationale: z.string().min(1).max(400).optional().describe('Why the case is worth having'),
});

// --- Cases from pasted text ---------------------------------------------

/** The platform's bounds of a run (`POST /v1/projects/:id/case-generations`). */
export const CASE_GENERATION_TITLE_MAX = 300;
export const CASE_GENERATION_MAX_CASES = 12;
export const CASE_GENERATION_DEFAULT_CASES = 8;
/** Checked by the platform, not here: its 422 (`ticket_too_empty`, `text_too_long`) is what the caller gets back. */
export const CASE_GENERATION_MIN_WORDS = 20;
export const CASE_GENERATION_TEXT_MAX = 12_000;

/** The body of the start, pasted text only: a Jira ticket by its key is a person's to start, from the dashboard. */
export const caseGenerationBody = {
  input: z.strictObject({
    kind: z.literal('pasted-text'),
    text: z
      .string()
      .describe(`The requirement, story or ticket text, at least ${CASE_GENERATION_MIN_WORDS} words and at most ${CASE_GENERATION_TEXT_MAX} characters`),
    title: z.string().trim().max(CASE_GENERATION_TITLE_MAX).optional(),
  }),
  maxCases: z
    .number()
    .int()
    .min(1)
    .max(CASE_GENERATION_MAX_CASES)
    .optional()
    .describe(`How many proposals at most; ${CASE_GENERATION_DEFAULT_CASES} when left out`),
  language: z.string().trim().min(2).max(35).optional().describe("The cases' language; the project's AI language when left out"),
  confirmDuplicates: z
    .boolean()
    .optional()
    .describe('true: go ahead although cases or proposals from this text exist (the platform answers 409 duplicate_source first)'),
};

// --- API catalog proposals (#2192) --------------------------------------------------------------

export const API_METHODS = ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH', 'TRACE'] as const;

export const proposedEndpoint = z.strictObject({
  method: z.enum(API_METHODS),
  path: z
    .string()
    .min(1)
    .max(512)
    .regex(/^\/[^?#\s]*$/, 'a path template starts with / and has no query')
    .describe('A template: /users/{id}, never /users/42'),
  source: z.enum(['spec', 'code', 'traffic']),
  trust: z.enum(['confirmed', 'derived']).optional(),
  summary: z.string().trim().min(1).max(500).optional(),
  auth: z.array(z.string().trim().min(1).max(100)).max(10).optional(),
  environment: z.string().trim().min(1).max(100).optional(),
  seenAt: z.string().optional().describe('ISO 8601 date and time with an offset'),
});

// --- Review queue ---------------------------------------------------------------------------------

export const REVIEW_STATES = ['pending', 'changes_requested', 'approved', 'rejected'] as const;
/** Every kind of the queue except `question`, which has a tool of its own. */
export const REVIEW_KINDS = ['result', 'proposal', 'discovered', 'endpoint', 'strategy', 'report', 'memory_rule'] as const;
export const REJECTION_CATEGORIES = ['duplicate', 'incorrect', 'out-of-scope', 'low-value', 'not-testable', 'other'] as const;

// --- Outputs --------------------------------------------------------------------------------------

/** A platform object as it came back: the fields named are the ones a caller branches on; the rest pass through. */
export const entity = z.looseObject({ id: z.string().optional() });

export const plannedRequest = z.object({
  method: z.string(),
  path: z.string(),
  query: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
});

/** One write: what came back, or what would have been sent. */
export const writeOutput = z.object({
  dryRun: z.boolean(),
  request: plannedRequest.optional(),
  result: entity.optional(),
});

/** A strategy proposal: a dry run says whether the platform checked it (true) or it was only planned (false), and the findings. */
export const strategyOutput = writeOutput.extend({ checked: z.boolean().optional(), findings: z.array(z.unknown()).optional() });

/** A batch: how many were asked for, how many the platform applied, and each one's answer. */
export const batchOutput = z.object({
  dryRun: z.boolean(),
  requested: z.number().int(),
  applied: z.number().int(),
  requests: z.array(plannedRequest).optional(),
  results: z
    .array(
      z.object({
        ok: z.boolean(),
        status: z.number().int().optional(),
        id: z.string().optional(),
        error: z.string().optional(),
        code: z.string().optional(),
      }),
    )
    .optional(),
  report: z.looseObject({}).optional(),
});

export const bulkPreview = z.looseObject({
  total: z.number().int(),
  confirm: z.string(),
  expiresInSeconds: z.number().int(),
});
