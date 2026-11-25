// The stub file: what a local stub server answers for one case. It lives in a file of its own next to the
// case, YAML or JSON, and is read whole and validated before a server takes it.
//
// Deliberately not in the format: regular expressions in a path, matching on headers or on the query string,
// answers computed from the request, delays on a normal answer, binary bodies, a body of one's own for the
// 429 and 500 failures (a plain `response` with that status does it), and any state beyond the order of the
// stubs, `times` and `failure.first`. A file holds what JSON can hold and nothing else: a YAML tag, a number
// that is not finite and an alias that holds itself are refused.

import * as fs from 'node:fs/promises';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import { parseDocument } from 'yaml';
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
    // Checked with the checks Node runs when it sends them, so a bad one fails here and not at a request.
    headers: z
      .record(z.string(), z.string())
      .superRefine((headers, ctx) => {
        for (const [name, value] of Object.entries(headers)) {
          const check = (what: string, validate: () => void): void => {
            try {
              validate();
            } catch {
              ctx.addIssue({ code: 'custom', message: `not a valid header ${what}`, path: [name] });
            }
          };
          check('name', () => validateHeaderName(name));
          check('value', () => validateHeaderValue(name, value));
        }
      })
      .default({}),
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
// that; without it, on every call. `times` counts the failed calls too, so with `first` it has to be larger.
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
  // The stub's `response`, complete and correct, at this many bytes per second: a whole number, 1 or more.
  z.strictObject({ type: z.literal('slow_stream'), first, bytes_per_sec: z.number().int().min(1) }),
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
    // slashes included. The query string takes no part in the match, so a path holds none.
    path: z
      .string()
      .regex(/^\/[^?#\s]*$/, 'must start with "/" and hold no "?", "#" or whitespace'),
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
    } else if (failure.type !== 'slow_stream' && failure.first === undefined) {
      need(
        `${failure.type} happens on every call, so this response is never sent: remove it or give failure.first`,
      );
    }
    if (failure?.first !== undefined && stub.times !== 'always') {
      if ((stub.times === 'once' ? 1 : stub.times) <= failure.first)
        ctx.addIssue({
          code: 'custom',
          message: `the first ${failure.first} calls fail and count, so the response is never sent: give more than ${failure.first}, or leave it out`,
          path: ['times'],
        });
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

/**
 * Validates the text of a stub file. YAML is a superset of JSON, so one parser reads both. A parse error
 * gives the parser's code and the line and column, never the line itself: a stub file may hold a key.
 */
export function parseStubFile(text: string, file = 'stub file'): StubFile {
  // The core schema whatever version the file declares, and no tag beyond it: only plain JSON types come
  // out. An unknown tag is a warning to the parser and an error here.
  const doc = parseDocument(text, { schema: 'core', resolveKnownTags: false });
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem !== undefined) {
    const at = problem.linePos?.[0];
    throw new StubFileError(
      `Cannot parse ${file}: ${problem.code}${at === undefined ? '' : ` at line ${at.line}, column ${at.col}`}`,
    );
  }
  let raw: unknown;
  try {
    raw = doc.toJS();
    // Throws on an alias that holds itself; a number JSON would turn into null is refused the same way.
    JSON.stringify(raw, (_key, value: unknown) => {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('not finite');
      return value;
    });
  } catch {
    throw new StubFileError(
      `Cannot parse ${file}: it holds a value JSON cannot (an alias that holds itself, or a number that is not finite)`,
    );
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
