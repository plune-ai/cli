import { z } from 'zod';
import {
  BATCH_MAX,
  REJECTION_CATEGORIES,
  REVIEW_KINDS,
  REVIEW_STATES,
  MISSION_LINK_KINDS,
  batchOutput,
  bulkPreview,
  caseGenerationBody,
  dryRun,
  entity,
  id,
  missionFields,
  plannedRequest,
  proposedCase,
  proposedEndpoint,
  questionInput,
  strategyContent,
  writeOutput,
} from './schemas.js';

/**
 * The tool contract of Plune's agent surface (plune-ai/plune#1284, plune-ai/cli#146): names, task descriptions, input and
 * output schemas, and which tools write. The MCP server (`plune mcp serve`) registers exactly these, and the platform's
 * built-in agent (plune-ai/plune#2202) imports them from `@plune-ai/cli/mcp-tools`, so the two paths cannot drift apart.
 *
 * `visibility`: `core` tools are listed to a client from the start; `discoverable` ones only after `plune_discover_tools`
 * names them (Qase's 17-of-41 rule, plune#1284 AC-01/AC-02). `endpoints` is what the tool calls on the platform, the
 * signature the no-duplicates check reads.
 */
export type ToolVisibility = 'core' | 'discoverable';

export interface PluneToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly input: z.ZodObject;
  readonly output: z.ZodObject;
  /** Needs a token with the `write` scope; refused for a `read` token. */
  readonly write: boolean;
  readonly visibility: ToolVisibility;
  readonly endpoints: readonly string[];
}

/** What a client sees before it asks for more (plune#1284 AC-01). */
export const MAX_VISIBLE_TOOLS = 20;

const define = <T extends PluneToolDefinition>(tool: T): T => tool;

const listPage = {
  limit: z.number().int().min(1).max(BATCH_MAX).optional(),
  cursor: z.string().min(1).optional().describe('nextCursor of the previous page'),
};

const missionId = id('The mission id');
const projectId = z.string().min(1).optional().describe('The project; the one the server was started with when left out');

export const PLUNE_TOOLS = [
  define({
    name: 'plune_project_context',
    title: 'Project context',
    description:
      'Start here: learn the project you are working in with one call — its projects, the suite tree, how many test cases it has, its testing missions, and how much waits in the review queue.',
    input: z.strictObject({}),
    output: z.object({
      projectId: z.string().nullable(),
      projects: z.array(entity),
      suites: z.array(entity),
      cases: z.object({ total: z.number().int() }),
      missions: z.array(entity),
      reviewQueue: z.object({ pending: z.number().int(), more: z.boolean() }),
    }),
    write: false,
    visibility: 'core',
    endpoints: ['GET /v1/projects', 'GET /v1/suites', 'GET /v1/test-cases', 'GET /v1/missions', 'GET /v1/review-items'],
  }),
  define({
    name: 'plune_get',
    title: 'Read one object',
    description:
      'Read one test case, run or review queue entry in full when you already hold its id — steps, state, history fields and everything the platform keeps on it.',
    input: z.strictObject({ kind: z.enum(['test-case', 'run', 'review-item']), id: id('Its id') }),
    output: z.object({ kind: z.string(), item: entity }),
    write: false,
    visibility: 'core',
    endpoints: ['GET /v1/test-cases/:id', 'GET /v1/runs/:id', 'GET /v1/review-items/:id'],
  }),
  define({
    name: 'plune_cases_search',
    title: 'Find test cases',
    description:
      'Find test cases of the project by filter — suite, state, tag, priority, text and the other filters of the case list — one page at a time, with the total and how many match.',
    input: z.strictObject({
      filters: z
        .record(z.string(), z.union([z.string(), z.array(z.string())]))
        .optional()
        .describe('Query filters of GET /v1/test-cases: a list is OR inside one key, keys are AND-ed (e.g. {"suiteId": "s1", "tag": ["smoke"]})'),
      ...listPage,
    }),
    output: z.object({
      testCases: z.array(entity),
      total: z.number().int().optional(),
      matching: z.number().int().optional(),
      nextCursor: z.string().nullable(),
    }),
    write: false,
    visibility: 'core',
    endpoints: ['GET /v1/test-cases?filters'],
  }),
  define({
    name: 'plune_review_list',
    title: 'Read the review queue',
    description:
      'See what waits for a decision in the review queue — proposed cases, discovered tests, endpoints, strategies, reports — narrowed by state and kind, newest first, one page at a time.',
    input: z.strictObject({
      state: z.enum(REVIEW_STATES).optional(),
      kinds: z.array(z.enum(REVIEW_KINDS)).min(1).optional().describe('Questions are read with the question tool'),
      ...listPage,
    }),
    output: z.object({ items: z.array(entity), nextCursor: z.string().nullable() }),
    write: false,
    visibility: 'core',
    endpoints: ['GET /v1/review-items'],
  }),
  define({
    name: 'plune_review_decide',
    title: 'Decide queue entries',
    description:
      'Approve or reject up to 100 review queue entries in one decision. The first call changes nothing and returns a preview with a confirm value; repeat the same call with confirm to apply it. An entry skipped as policy_refused was refused by the review policy of the project (for example, the person who proposed it cannot approve it): do not retry it — it needs another reviewer; its detail says why.',
    input: z.strictObject({
      itemIds: z
        .array(z.string().min(1))
        .min(1)
        .max(BATCH_MAX)
        .refine((a) => new Set(a).size === a.length, { message: 'an id is named once' }),
      verdict: z.enum(['approved', 'rejected']),
      rejectionCategory: z.enum(REJECTION_CATEGORIES).optional().describe('Required to reject'),
      note: z.string().trim().min(1).max(2_000).optional().describe('Why — required to reject'),
      confirm: z.string().min(1).optional().describe('The confirm value of the preview'),
    }),
    output: z.object({
      requested: z.number().int(),
      applied: z.number().int(),
      preview: bulkPreview.optional(),
      report: z.looseObject({}).optional(),
    }),
    write: true,
    visibility: 'core',
    endpoints: ['POST /v1/review-items/decisions'],
  }),
  define({
    name: 'plune_case_propose',
    title: 'Propose test cases',
    description:
      'Propose up to 100 new test cases for a person to review: they land in the review queue as proposals and become cases only when someone approves them. Nothing is created silently.',
    input: z.strictObject({
      target: z.string().trim().min(1).max(2_048).describe('What the cases test: the product address, or the mission name'),
      cases: z.array(proposedCase).min(1).max(BATCH_MAX),
      dry_run: dryRun,
    }),
    output: batchOutput,
    write: true,
    visibility: 'core',
    endpoints: ['POST /v1/ingest/cairn'],
  }),
  define({
    name: 'plune_cases_generate',
    title: 'Generate cases from pasted text',
    description:
      "Generate test case proposals from pasted text — a requirement, a user story, the text of a ticket — with the project's AI. It spends the project's AI budget. The proposals land in the review queue and nothing becomes a case until a person approves it. The run is queued: keep its id and poll it with plune_cases_generation_get until it is done. A Jira ticket by its key is not taken here: paste its text.",
    input: z.strictObject({ projectId, ...caseGenerationBody, dry_run: dryRun }),
    output: writeOutput,
    write: true,
    visibility: 'core',
    endpoints: ['POST /v1/projects/:id/case-generations'],
  }),
  define({
    name: 'plune_cases_generation_get',
    title: 'Read a case generation',
    description:
      'Check where a run of cases from pasted text stands — queued, running, done, failed or cancelled — with how many proposals it made, how many it skipped, and what it cost.',
    input: z.strictObject({ projectId, generationId: id('The id the start answered with') }),
    output: z.object({ generation: entity }),
    write: false,
    visibility: 'core',
    endpoints: ['GET /v1/projects/:id/case-generations/:generationId'],
  }),
  define({
    name: 'plune_mission_create',
    title: 'Create a mission',
    description:
      'Create a testing mission for a product: its name, a short description of what the product is, where it runs, and whether documentation exists. It starts as a draft you fill in.',
    input: z.strictObject({ ...missionFields, dry_run: dryRun }),
    output: writeOutput,
    write: true,
    visibility: 'core',
    endpoints: ['POST /v1/missions'],
  }),
  define({
    name: 'plune_mission_get',
    title: 'Read a mission',
    description:
      'Read a testing mission with everything it holds — its brief, state, documentation answer and every source attached to it — before planning or continuing the work on it.',
    input: z.strictObject({ missionId }),
    output: z.object({ mission: entity }),
    write: false,
    visibility: 'core',
    endpoints: ['GET /v1/missions/:id'],
  }),
  define({
    name: 'plune_mission_update',
    title: 'Update a mission',
    description:
      'Change a testing mission: rename it, rewrite the brief, set or remove the address, answer whether documentation exists, or move it between draft, active and done.',
    input: z
      .strictObject({
        missionId,
        name: missionFields.name.optional(),
        summary: missionFields.summary,
        url: missionFields.url,
        state: missionFields.state,
        documentation: missionFields.documentation,
        dry_run: dryRun,
      })
      .refine((b) => ['name', 'summary', 'url', 'state', 'documentation'].some((k) => b[k as keyof typeof b] !== undefined), {
        message: 'nothing to change',
      }),
    output: writeOutput,
    write: true,
    visibility: 'core',
    endpoints: ['PATCH /v1/missions/:id'],
  }),
  define({
    name: 'plune_source_add',
    title: 'Add a source to a mission',
    description:
      'Attach something to read to a mission: a link (page, OpenAPI document, repository, ticket) or the text of a file of the project — Markdown, plain text or JSON, up to 1 MiB.',
    input: z
      .strictObject({
        missionId,
        kind: z.enum([...MISSION_LINK_KINDS, 'file']),
        ref: z.string().optional().describe('The link, for url, openapi, repo and ticket'),
        name: z.string().optional().describe('The file name, for file (.md, .markdown, .txt, .json)'),
        text: z.string().optional().describe('The file text, for file'),
        title: z.string().optional(),
        version: z.string().optional(),
        dry_run: dryRun,
      })
      .superRefine((b, ctx) => {
        if (b.kind === 'file' && (b.name === undefined || b.text === undefined))
          ctx.addIssue({ code: 'custom', message: 'a file source carries name and text' });
        if (b.kind !== 'file' && b.ref === undefined) ctx.addIssue({ code: 'custom', message: 'a link source carries ref' });
      }),
    output: writeOutput,
    write: true,
    visibility: 'core',
    endpoints: ['POST /v1/missions/:id/sources', 'POST /v1/missions/:id/files'],
  }),
  define({
    name: 'plune_question_ask',
    title: 'Ask a person',
    description:
      'Ask a person what you do not know instead of guessing: a plain question with up to three options, or a request for access to an API description, the code, staging or a HAR file.',
    input: questionInput.superRefine((b, ctx) => {
      if (b.template === 'plain' && b.access !== undefined) ctx.addIssue({ code: 'custom', message: 'access belongs to an access question' });
      if (b.template === 'access' && b.options !== undefined) ctx.addIssue({ code: 'custom', message: 'options belong to a plain question' });
      if (b.template === 'access' && b.access === undefined) ctx.addIssue({ code: 'custom', message: 'an access question names the access' });
    }),
    output: writeOutput,
    write: true,
    visibility: 'core',
    endpoints: ['POST /v1/review-items/questions'],
  }),
  define({
    name: 'plune_question_list',
    title: 'Read questions and answers',
    description:
      'Check the questions asked to people and the answers they gave — all of them or one mission\'s, waiting or answered — so the work continues from what a person actually said.',
    input: z.strictObject({ missionId: z.string().min(1).optional(), state: z.enum(REVIEW_STATES).optional(), ...listPage }),
    output: z.object({ questions: z.array(entity), nextCursor: z.string().nullable() }),
    write: false,
    visibility: 'core',
    endpoints: ['GET /v1/review-items?kind=question'],
  }),
  define({
    name: 'plune_strategy_propose',
    title: 'Propose a test strategy',
    description:
      'Propose a test strategy for a mission in ISTQB sections — objectives, scope in and out, approach, levels and techniques, risks, entry and exit criteria — for a person to accept.',
    input: z.strictObject({ missionId, content: strategyContent, dry_run: dryRun }),
    output: writeOutput,
    write: true,
    visibility: 'core',
    endpoints: ['POST /v1/missions/:id/strategy'],
  }),
  define({
    name: 'plune_report_request',
    title: 'Request the mission report',
    description:
      'Ask the platform to build the completion report of a mission from its own data and queue it for a person to approve; it needs an accepted strategy first.',
    input: z.strictObject({ missionId, dry_run: dryRun }),
    output: writeOutput,
    write: true,
    visibility: 'core',
    endpoints: ['POST /v1/missions/:id/report'],
  }),
  define({
    name: 'plune_discover_tools',
    title: 'Find more tools',
    description:
      'Look for a capability that is not in your tool list — editing cases, writing results, starting runs, cataloguing API endpoints, a raw API call — and switch the ones you need on for this session.',
    input: z.strictObject({
      query: z.string().trim().min(1).max(200).optional().describe('Words of the task, e.g. "write results"'),
      names: z.array(z.string().min(1)).min(1).max(MAX_VISIBLE_TOOLS).optional().describe('Tools to switch on'),
    }),
    output: z.object({
      revealed: z.array(z.string()),
      available: z.array(z.object({ name: z.string(), title: z.string(), description: z.string(), write: z.boolean() })),
      visible: z.array(z.string()),
    }),
    write: false,
    visibility: 'core',
    endpoints: ['LOCAL /discover'],
  }),
  define({
    name: 'plune_cases_update',
    title: 'Edit test cases',
    description:
      'Edit up to 100 existing test cases in one call — title, steps, expected result, priority, tags, suite — each applied on its own, with a count of how many were applied.',
    input: z.strictObject({
      cases: z
        .array(z.strictObject({ id: id('The case id'), changes: z.record(z.string(), z.unknown()).describe('Fields of PATCH /v1/test-cases/:id') }))
        .min(1)
        .max(BATCH_MAX),
      dry_run: dryRun,
    }),
    output: batchOutput,
    write: true,
    visibility: 'discoverable',
    endpoints: ['PATCH /v1/test-cases/:id'],
  }),
  define({
    name: 'plune_run_create',
    title: 'Start a run',
    description:
      'Start a test run on the platform to record results into — named, with its environment and the cases it covers — using the body of POST /v1/runs (schemaVersion 2).',
    input: z.strictObject({ run: z.record(z.string(), z.unknown()).describe('The body of POST /v1/runs'), dry_run: dryRun }),
    output: writeOutput,
    write: true,
    visibility: 'discoverable',
    endpoints: ['POST /v1/runs'],
  }),
  define({
    name: 'plune_results_write',
    title: 'Write results into a run',
    description:
      'Record up to 100 test results into an open run in one request — passed, failed, skipped, with their keys and evidence — and learn how many the platform accepted.',
    input: z.strictObject({
      runId: id('The run id'),
      results: z.array(z.record(z.string(), z.unknown())).min(1).max(BATCH_MAX).describe('Results as POST /v1/runs/:id/results takes them'),
      combination: z.number().int().min(0).optional(),
      configuration: z.record(z.string(), z.string()).optional(),
      dry_run: dryRun,
    }),
    output: batchOutput,
    write: true,
    visibility: 'discoverable',
    endpoints: ['POST /v1/runs/:id/results'],
  }),
  define({
    name: 'plune_endpoint_propose',
    title: 'Propose API endpoints',
    description:
      'Propose up to 100 API endpoints you found in a spec, the code or traffic for the project\'s API catalog; each waits in the review queue until a person approves it.',
    input: z.strictObject({ endpoints: z.array(proposedEndpoint).min(1).max(BATCH_MAX), dry_run: dryRun }),
    output: batchOutput,
    write: true,
    visibility: 'discoverable',
    endpoints: ['POST /v1/review-items/endpoints'],
  }),
  define({
    name: 'plune_api_request',
    title: 'Call the REST API directly',
    description:
      'Reach any Plune REST endpoint under /v1 that no other tool covers. Every guard still holds: a deletion is previewed first and needs confirm, and the platform refuses an agent what it refuses over HTTP.',
    input: z.strictObject({
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
      path: z.string().min(1).max(2_048).describe('A path under /v1, e.g. /v1/suites'),
      query: z.record(z.string(), z.string()).optional(),
      body: z.unknown().optional(),
      confirm: z.string().min(1).optional().describe('The confirm value of a preview'),
      dry_run: dryRun,
    }),
    output: z.object({
      status: z.number().int().optional(),
      body: z.unknown().optional(),
      dryRun: z.boolean().optional(),
      request: plannedRequest.optional(),
      preview: z
        .looseObject({ method: z.string(), path: z.string(), confirm: z.string(), expiresInSeconds: z.number().int() })
        .optional(),
    }),
    write: true,
    visibility: 'discoverable',
    endpoints: ['ANY /v1/*'],
  }),
] as const satisfies readonly PluneToolDefinition[];

export type PluneToolName = (typeof PLUNE_TOOLS)[number]['name'];

export const PLUNE_TOOL_NAMES: readonly PluneToolName[] = PLUNE_TOOLS.map((t) => t.name);

const BY_NAME: ReadonlyMap<string, PluneToolDefinition> = new Map(PLUNE_TOOLS.map((t) => [t.name, t]));

/** The definition of one tool; throws on a name the contract does not have. */
export function pluneTool(name: string): PluneToolDefinition {
  const tool = BY_NAME.get(name);
  if (tool === undefined) throw new Error(`unknown tool: ${name}`);
  return tool;
}

export function isPluneToolName(name: string): name is PluneToolName {
  return BY_NAME.has(name);
}

/** The tools a client is shown before it asks for more; without the writers for a `read` token. */
export function defaultVisibleTools(scope?: 'read' | 'write'): PluneToolName[] {
  return PLUNE_TOOLS.filter((t) => t.visibility === 'core' && !(scope === 'read' && t.write)).map((t) => t.name);
}
