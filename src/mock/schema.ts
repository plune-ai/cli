// The stub file: what a local stub server answers for one case. It lives in a file of its own next to the
// case, YAML or JSON, and is read whole and validated before a server takes it.
//
// Deliberately not in the format: regular expressions in a path, matching on headers or on the query string,
// answers computed from the request, delays on a normal answer, binary bodies, and any state beyond the order
// of the stubs and `times`.

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

export const stubSchema = z.strictObject({
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
  // How many requests the stub answers; a used-up stub lets the next matching one answer.
  times: z
    .union([z.literal('always'), z.literal('once'), z.number().int().positive()])
    .default('always'),
  response: responseSchema,
});

export const stubFileSchema = z.strictObject({
  version: z.literal(STUB_FILE_VERSION),
  stubs: z.array(stubSchema),
});

export type Stub = z.output<typeof stubSchema>;
export type StubInput = z.input<typeof stubSchema>;
export type StubResponse = Stub['response'];
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
