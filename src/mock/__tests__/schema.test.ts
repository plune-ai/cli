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
