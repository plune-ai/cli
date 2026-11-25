// The stub file: what a local stub server answers for one case. It lives in a file of its own next to the
// case, YAML or JSON, and is read whole and validated before a server takes it.
//
// Deliberately not in the format: regular expressions in a path, matching on headers or on the query string,
// answers computed from the request, delays on a normal answer, binary bodies, a body of one's own for the
// 429 and 500 failures (a plain `response` with that status does it), and any state beyond the order of the
// stubs, `times` and `failure.first`.

import * as fs from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';

export const STUB_FILE_VERSION = 1;

// One server-sent event: a string is the `data:` line as written, an object adds an `event:` line. `data`
// that is not a string is sent as JSON.
const sseChunkSchema = z.union([
  z.string(),
  z.strictObject({ event: z.string().min(1).optional(), data: z.unknown() }),
]);

const responseSchema = z
  .strictObject({
    status: z.number().int().min(200).max(599).default(200),
    headers: z.record(z.string(), z.string()).default({}),
    json: z.unknown().optional(),
    text: z.string().optional(),
    sse: z.array(sseChunkSchema).optional(),
  })
  .superRefine((r, ctx) => {
    const bodies = (['json', 'text', 'sse'] as const).filter((k) => r[k] !== undefined);
    if (bodies.length > 1)
      ctx.addIssue({
        code: 'custom',
        message: `give one body, not ${bodies.join(' and ')}`,
        path: [bodies[1]!],
      });
  });

// With `first: N` the failure happens on the first N calls of the stub and its `response` answers after
// that; without it, on every call.
const first = z.number().int().positive().optional();

const failureSchema = z.discriminatedUnion('type', [
  // The request is read and never answered, until the client gives up or the scope closes.
  z.strictObject({ type: z.literal('timeout'), first }),
  // The connection is reset once the request is read; no response at all.
  z.strictObject({ type: z.literal('reset'), first }),
  z.strictObject({
    type: z.literal('http_429'),
    first,
    retry_after_seconds: z.number().int().min(0).default(1),
  }),
  z.strictObject({ type: z.literal('http_500'), first }),
  // The stub's `response`, complete and correct, at this many bytes per second.
  z.strictObject({ type: z.literal('slow_stream'), first, bytes_per_sec: z.number().positive() }),
  // The first half of the bytes of `response.json`. `full` declares the length of the whole body and closes
  // the connection after the half, as when a provider's connection drops: the client's read of the body
  // fails. `cut` declares the length of the half, as when something in between cut the body and re-framed
  // it: the response arrives whole and only parsing it fails.
  z.strictObject({
    type: z.literal('truncated_json'),
    first,
    content_length: z.enum(['full', 'cut']).default('full'),
  }),
]);

export const stubSchema = z
  .strictObject({
    method: z
      .string()
      .min(1)
      .default('POST')
      .transform((m) => m.toUpperCase()),
    // Exact, or with wildcards: `*` stands for any characters inside one path segment, `**` for anything,
    // slashes included. The query string takes no part in the match.
    path: z.string().startsWith('/', 'must start with "/"'),
    // A JSON subset of the request body: every key given here must be in the request with a matching value,
    // other keys of the request are ignored. Arrays match whole: same length, each item by the same rule.
    body: z.unknown().optional(),
    // How many requests the stub answers, failures included; a used-up stub lets the next matching one
    // answer.
    times: z
      .union([z.literal('always'), z.literal('once'), z.number().int().positive()])
      .default('always'),
    response: responseSchema.optional(),
    failure: failureSchema.optional(),
  })
  .superRefine((stub, ctx) => {
    const { response, failure } = stub;
    const need = (message: string, ...path: string[]): void =>
      ctx.addIssue({ code: 'custom', message, path: ['response', ...path] });
    if (failure === undefined) {
      if (response === undefined) need('give a response or a failure');
    } else if (failure.type === 'truncated_json') {
      if (response?.json === undefined) need('truncated_json cuts this body: give it', 'json');
    } else if (response === undefined) {
      if (failure.type === 'slow_stream') need('slow_stream sends this response slowly: give it');
      else if (failure.first !== undefined)
        need(`after the first ${failure.first} failed calls this response answers: give it`);
    }
  });

export const stubFileSchema = z.strictObject({
  version: z.literal(STUB_FILE_VERSION),
  stubs: z.array(stubSchema),
});

export type Stub = z.output<typeof stubSchema>;
export type StubInput = z.input<typeof stubSchema>;
export type StubResponse = NonNullable<Stub['response']>;
export type StubFailure = NonNullable<Stub['failure']>;
export type StubFile = z.output<typeof stubFileSchema>;

export class StubFileError extends Error {
  readonly code = 'STUB_FILE_ERROR' as const;
  /** One line per bad field, `path.to.field: what is wrong`. */
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(issues.length > 0 ? `${message}\n${issues.map((i) => `  ${i}`).join('\n')}` : message);
    this.name = 'StubFileError';
    this.issues = issues;
  }
}

export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}

/** Validates the text of a stub file. YAML is a superset of JSON, so one parser reads both. */
export function parseStubFile(text: string, file = 'stub file'): StubFile {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new StubFileError(`Cannot parse ${file}: ${(err as Error).message}`);
  }
  const result = stubFileSchema.safeParse(raw);
  if (!result.success) throw new StubFileError(`Invalid ${file}`, formatIssues(result.error));
  return result.data;
}

export async function loadStubFile(file: string): Promise<StubFile> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    throw new StubFileError(`Cannot read stub file: ${file}`);
  }
  return parseStubFile(text, file);
}
