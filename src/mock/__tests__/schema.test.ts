import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadStubFile, parseStubFile, StubFileError } from '../schema.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plune-stubs-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const YAML_FILE = `
version: 1
stubs:
  - path: /v1/chat/completions
    body: { model: small }
    times: once
    response:
      json: { choices: [{ message: { role: assistant, content: Hello John Doe } }] }
  - method: get
    path: /v1/models/*
    response:
      status: 200
      headers: { x-request-id: r-1 }
      text: ok
  - path: /v1/messages
    times: 3
    response:
      sse:
        - event: message_start
          data: { type: message_start }
        - '[DONE]'
`;

function issuesOf(text: string): string[] {
  try {
    parseStubFile(text, 'case.stubs.yaml');
  } catch (err) {
    expect(err).toBeInstanceOf(StubFileError);
    return (err as StubFileError).issues;
  }
  throw new Error('the file was accepted');
}

describe('mock · stub file', () => {
  it('reads a YAML file and fills the defaults', async () => {
    const file = join(dir, 'case.stubs.yaml');
    await writeFile(file, YAML_FILE);
    const { version, stubs } = await loadStubFile(file);
    expect(version).toBe(1);
    expect(stubs.map((s) => [s.method, s.path, s.times])).toEqual([
      ['POST', '/v1/chat/completions', 'once'],
      ['GET', '/v1/models/*', 'always'],
      ['POST', '/v1/messages', 3],
    ]);
    expect(stubs[0]!.body).toEqual({ model: 'small' });
    expect(stubs[0]!.response).toMatchObject({ status: 200, headers: {} });
    expect(stubs[2]!.response.sse).toEqual([
      { event: 'message_start', data: { type: 'message_start' } },
      '[DONE]',
    ]);
  });

  it('reads the same format as JSON', async () => {
    const file = join(dir, 'case.stubs.json');
    await writeFile(
      file,
      JSON.stringify({ version: 1, stubs: [{ path: '/v1/x', response: { json: null } }] }),
    );
    const { stubs } = await loadStubFile(file);
    expect(stubs).toHaveLength(1);
    expect(stubs[0]!.response.json).toBeNull();
  });

  it('reports the path of every bad field', () => {
    const issues = issuesOf(`
version: 1
stubs:
  - path: /ok
    response: { json: {} }
  - path: no-slash
    times: 0
    response: { status: 99, json: {}, text: both }
  - path: /x
    respond: {}
`);
    const paths = issues.map((i) => i.slice(0, i.indexOf(':')));
    expect(paths).toEqual(
      expect.arrayContaining([
        'stubs.1.path',
        'stubs.1.times',
        'stubs.1.response.status',
        'stubs.2.response',
      ]),
    );
    expect(issues.find((i) => i.startsWith('stubs.2'))).toBeDefined();
    expect(issues.join('\n')).toMatch(/respond/);
  });

  it('refuses a missing or another version, and a file that is not a stub file', () => {
    expect(issuesOf('stubs: []')[0]).toMatch(/^version: /);
    expect(issuesOf('version: 2\nstubs: []')[0]).toMatch(/^version: /);
    expect(issuesOf('just text')[0]).toMatch(/^\(root\): /);
  });

  it('names the file in the message and lists the issues under it', () => {
    expect(() => parseStubFile('version: 1\nstubs: [{ path: 5 }]', 'a/case.stubs.yaml')).toThrow(
      /^Invalid a\/case\.stubs\.yaml\n {2}stubs\.0\.path: /,
    );
  });

  it('reports text that does not parse, and a file that is not there', async () => {
    expect(() => parseStubFile('version: [1', 'bad.yaml')).toThrow(/^Cannot parse bad\.yaml: /);
    const missing = join(dir, 'missing.stubs.yaml');
    await expect(loadStubFile(missing)).rejects.toThrow(`Cannot read stub file: ${missing}`);
    await expect(loadStubFile(missing)).rejects.toBeInstanceOf(StubFileError);
  });
});

describe('mock · stub file · failures', () => {
  const stubsOf = (failures: string) =>
    parseStubFile(`version: 1
stubs:
${failures}`).stubs.map((s) => s.failure);

  it('reads the six failure types and fills their defaults', () => {
    expect(
      stubsOf(`
  - { path: /a, failure: { type: timeout } }
  - { path: /b, failure: { type: reset, first: 1 }, response: { text: ok } }
  - { path: /c, failure: { type: http_429 } }
  - { path: /c, failure: { type: http_429, retry_after_seconds: 30 } }
  - { path: /d, failure: { type: http_500, first: 2 }, response: { json: {} } }
  - { path: /e, failure: { type: slow_stream, bytes_per_sec: 512 }, response: { sse: [a] } }
  - { path: /f, failure: { type: truncated_json }, response: { json: { a: 1 } } }
  - { path: /f, failure: { type: truncated_json, content_length: cut }, response: { json: [] } }
`),
    ).toEqual([
      { type: 'timeout' },
      { type: 'reset', first: 1 },
      { type: 'http_429', retry_after_seconds: 1 },
      { type: 'http_429', retry_after_seconds: 30 },
      { type: 'http_500', first: 2 },
      { type: 'slow_stream', bytes_per_sec: 512 },
      { type: 'truncated_json', content_length: 'full' },
      { type: 'truncated_json', content_length: 'cut' },
    ]);
  });

  it.each([
    [
      '{ path: /a, failure: { type: slow_stream }, response: { text: x } }',
      'stubs.0.failure.bytes_per_sec',
    ],
    [
      '{ path: /a, failure: { type: slow_stream, bytes_per_sec: 0 }, response: { text: x } }',
      'stubs.0.failure.bytes_per_sec',
    ],
    [
      '{ path: /a, failure: { type: http_429, retry_after_seconds: soon } }',
      'stubs.0.failure.retry_after_seconds',
    ],
    ['{ path: /a, failure: { type: http_503 } }', 'stubs.0.failure.type'],
    [
      '{ path: /a, failure: { type: timeout, first: 0 }, response: { text: x } }',
      'stubs.0.failure.first',
    ],
    ['{ path: /a, failure: { type: timeout, bytes_per_sec: 5 } }', 'stubs.0.failure'],
    [
      '{ path: /a, failure: { type: truncated_json, content_length: none }, response: { json: 1 } }',
      'stubs.0.failure.content_length',
    ],
    // What a failure needs from the response beside it.
    [
      '{ path: /a, failure: { type: truncated_json }, response: { text: x } }',
      'stubs.0.response.json',
    ],
    ['{ path: /a, failure: { type: truncated_json } }', 'stubs.0.response.json'],
    ['{ path: /a, failure: { type: slow_stream, bytes_per_sec: 5 } }', 'stubs.0.response'],
    ['{ path: /a, failure: { type: http_500, first: 2 } }', 'stubs.0.response'],
    ['{ path: /a }', 'stubs.0.response'],
    // A rate a timer can keep: whole bytes, one a second or more.
    [
      '{ path: /a, failure: { type: slow_stream, bytes_per_sec: 0.5 }, response: { text: x } }',
      'stubs.0.failure.bytes_per_sec',
    ],
    [
      '{ path: /a, failure: { type: slow_stream, bytes_per_sec: 1.5 }, response: { text: x } }',
      'stubs.0.failure.bytes_per_sec',
    ],
    [
      '{ path: /a, failure: { type: slow_stream, bytes_per_sec: 1e-7 }, response: { text: x } }',
      'stubs.0.failure.bytes_per_sec',
    ],
    // `times` counts the failed calls, so it has to leave room for the response after them.
    [
      '{ path: /a, times: 2, failure: { type: http_500, first: 3 }, response: { json: {} } }',
      'stubs.0.times',
    ],
    [
      '{ path: /a, times: 3, failure: { type: reset, first: 3 }, response: { json: {} } }',
      'stubs.0.times',
    ],
    [
      '{ path: /a, times: once, failure: { type: timeout, first: 1 }, response: { json: {} } }',
      'stubs.0.times',
    ],
    [
      '{ path: /a, times: 1, failure: { type: truncated_json, first: 1 }, response: { json: {} } }',
      'stubs.0.times',
    ],
    // A response beside a failure that happens on every call and has a body of its own would never go out.
    ['{ path: /a, failure: { type: timeout }, response: { text: x } }', 'stubs.0.response'],
    ['{ path: /a, failure: { type: reset }, response: { text: x } }', 'stubs.0.response'],
    ['{ path: /a, failure: { type: http_429 }, response: { text: x } }', 'stubs.0.response'],
    ['{ path: /a, failure: { type: http_500 }, response: { json: {} } }', 'stubs.0.response'],
    // A path is a path: the query string takes no part in a match, so it cannot be written into one.
    ['{ path: "/a?b=1", response: { text: x } }', 'stubs.0.path'],
    ['{ path: "/a#b", response: { text: x } }', 'stubs.0.path'],
    ['{ path: "/a b", response: { text: x } }', 'stubs.0.path'],
    ['{ path: "a/b", response: { text: x } }', 'stubs.0.path'],
    // Headers Node refuses to send.
    [
      '{ path: /a, response: { headers: { x-a: "v\\r\\nset-cookie: z=1" } } }',
      'stubs.0.response.headers.x-a',
    ],
    ['{ path: /a, response: { headers: { "bad name": v } } }', 'stubs.0.response.headers.bad name'],
  ])('refuses %s at %s', (stub, path) => {
    const issues = issuesOf(`version: 1
stubs:
  - ${stub}`);
    expect(issues.map((i) => i.slice(0, i.indexOf(':')))).toEqual([path]);
  });
});

describe('mock · stub file · only what JSON can hold', () => {
  const file = (json: string) => `version: 1
stubs:
  - path: /x
    response:
      json: ${json}
`;
  const jsonOf = (text: string) => parseStubFile(text).stubs[0]!.response!.json;

  it('keeps a retry stub whose `times` leaves room for the response', () => {
    const { stubs } = parseStubFile(`version: 1
stubs:
  - { path: /a, times: 2, failure: { type: reset, first: 1 }, response: { text: ok } }
  - { path: /a, failure: { type: http_500, first: 3 }, response: { text: ok } }
`);
    expect(stubs.map((s) => s.times)).toEqual([2, 'always']);
  });

  it.each([
    ['a binary tag', '!!binary aGVsbG8='],
    ['a set tag', '!!set { a, b }'],
    ['a tag of its own', '!secret value'],
    ['a tag of its own on a map', '!thing { a: 1 }'],
    ['infinity', '.inf'],
    ['not a number', '.nan'],
    ['a list that holds itself', '&a [*a]'],
  ])('refuses %s', (_, json) => {
    expect(() => parseStubFile(file(json), 'case.stubs.yaml')).toThrow(StubFileError);
  });

  it('reads plain values as JSON would, whatever version the file declares', () => {
    expect(jsonOf(file('{ a: [1, 2.5, true, null, text], b: { c: "1" } }'))).toEqual({
      a: [1, 2.5, true, null, 'text'],
      b: { c: '1' },
    });
    expect(jsonOf(`%YAML 1.1\n---\n${file('[2001-01-01, yes, 0o17]')}`)).toEqual([
      '2001-01-01',
      'yes',
      15,
    ]);
    // An anchor used twice is the same plain value twice.
    expect(jsonOf(file('[&m { a: 1 }, *m]'))).toEqual([{ a: 1 }, { a: 1 }]);
  });

  it('says where the text does not parse without printing the line', () => {
    const text = 'version: 1\nstubs:\n  - path: /x\n    key: [sk-SECRET-0123456789\n';
    let message = '';
    try {
      parseStubFile(text, 'bad.yaml');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^Cannot parse bad\.yaml: [A-Z_]+ at line \d+, column \d+$/);
    expect(message).not.toContain('SECRET');
    expect(() => parseStubFile(file('!secret sk-SECRET-0123456789'), 'bad.yaml')).toThrow(
      /^Cannot parse bad\.yaml: TAG_RESOLVE_FAILED at line 5, column 13$/,
    );
  });
});
