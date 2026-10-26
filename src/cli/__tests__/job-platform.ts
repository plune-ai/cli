import { z } from 'zod';

/**
 * The platform's job queue as a fake that judges every body the way the real one does, for the commands that report
 * into it (`sync`, `ingest`). Not a test file: the command tests share it.
 *
 * The contract as plune-ai/plune has it on master (758cf1ad): `src/contracts/job.ts` and `src/contracts/job-states.ts`,
 * copied because the CLI does not depend on the platform. Before cli#139 the fake server took whatever the CLI sent,
 * so a body the real one answers 400 passed.
 */
const count = z.number().int().nonnegative().max(2_147_483_647);
const cursor = z.string().min(1).max(2000).nullable();
const subjectId = z.string().min(1).max(200).optional();
const attempt = z.number().int().positive().max(2_147_483_647).optional();
const JOB_STATES = ['in_progress', 'action_needed', 'paused', 'blocked', 'completed', 'failed', 'cancelled'] as const;
const STOPPED: readonly string[] = ['action_needed', 'paused', 'blocked', 'failed'];
const jobCreateSchema = z.strictObject({
  kind: z.string().trim().min(1).max(64),
  subjectId,
  subjectName: z.string().trim().min(1).max(200).optional(),
  progress: z
    .strictObject({ done: count, total: count.min(1) })
    .refine((p) => p.done <= p.total)
    .optional(),
  cursor: cursor.unwrap().optional(),
});
// `subjectId` (#1279): what the job works on, learnt after it opened — taken while the job names none.
const jobProgressReportSchema = z
  .strictObject({ done: count.nullable(), total: count.min(1).nullable(), cursor: cursor.optional(), attempt, subjectId })
  .refine((p) => (p.done === null) === (p.total === null))
  .refine((p) => p.done === null || p.total === null || p.done <= p.total);
const jobStateReportSchema = z
  .strictObject({
    state: z.enum(JOB_STATES),
    reason: z.string().trim().min(1).max(2000).optional(),
    cursor: cursor.optional(),
    attempt,
  })
  .refine((b) => b.state === 'cancelled' || STOPPED.includes(b.state) === (b.reason !== undefined));
/** The producer's routes as `src/server/jobs/v1-routes.ts` mounts them, each with the schema it judges the body by. */
const ROUTES: Record<string, z.ZodType> = {
  'POST /v1/jobs': jobCreateSchema,
  'PATCH /v1/jobs/:id/progress': jobProgressReportSchema,
  'PATCH /v1/jobs/:id/state': jobStateReportSchema,
};

export type JobCall = { url: string; method: string; body: unknown; status?: number };

/** The jobs routes as the platform answers them: 400 for a body its schema refuses, 404 for a route it does not have. */
export function platformJobs(call: JobCall): Response {
  const route = `${call.method} ${new URL(call.url).pathname.replace(/^\/v1\/jobs\/[^/]+/, '/v1/jobs/:id')}`;
  const schema = ROUTES[route];
  if (schema === undefined) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  const parsed = schema.safeParse(call.body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: `validation failed — ${parsed.error.message}` }), { status: 400 });
  }
  return new Response(JSON.stringify({ id: 'job_1' }), { status: route === 'POST /v1/jobs' ? 201 : 200 });
}

/**
 * Routes /v1/jobs to `jobs`, everything else to the command's own upload answering `upload`. Every call is kept in
 * order, and each job call keeps the status it got.
 */
export function jobsFetch(
  jobs: (c: JobCall) => Response | Promise<Response>,
  upload: { status: number; body: unknown },
): { fn: typeof fetch; calls: JobCall[] } {
  const calls: JobCall[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: JobCall = {
      url: String(url),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    if (!call.url.includes('/v1/jobs')) return new Response(JSON.stringify(upload.body), { status: upload.status });
    const res = await jobs(call);
    call.status = res.status;
    return res;
  }) as typeof fetch;
  return { fn, calls };
}

export const jobCalls = (calls: JobCall[]): JobCall[] => calls.filter((c) => c.url.includes('/v1/jobs'));
/** Each job call as `status METHOD url`: what the platform took, in order. */
export const jobRoutes = (calls: JobCall[]): string[] => jobCalls(calls).map((c) => `${c.status} ${c.method} ${c.url}`);
