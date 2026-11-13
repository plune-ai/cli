// `--config` of the oauth suite as a user passes it: through the program of the CLI, not by calling the handler. The
// program also has a global `-c, --config <path>` (the plune.yaml of `plune run`), and commander gives a `--config`
// after a subcommand to the global option when both are declared; the handler must still get the file.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../../cli.js';
import type { McpConformanceReport } from '../../result.js';
import { authFixture, CLIENT_ID, type AuthFixture } from './auth-fixture.js';

const dir = mkdtempSync(join(tmpdir(), 'plune-oauth-config-cli-'));
const open: AuthFixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const f of open.splice(0)) await f.close();
});

async function runCli(args: string[]) {
  let out = '';
  let err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(
    (s: string | Uint8Array) => ((out += String(s)), true),
  );
  vi.spyOn(process.stderr, 'write').mockImplementation(
    (s: string | Uint8Array) => ((err += String(s)), true),
  );
  await createProgram().parseAsync(['node', 'plune', 'mcp', 'conformance', ...args]);
  const code = process.exitCode;
  vi.restoreAllMocks();
  return { code, out, err };
}

describe('CLI · mcp conformance · oauth --config through the program', () => {
  it('a --config file with an unknown key is refused (exit 2), not silently left unread', async () => {
    const path = join(dir, 'bad.yaml');
    writeFileSync(path, 'bogus: 1\n');
    const s = await authFixture({});
    open.push(s);
    const r = await runCli(['--url', s.url, '--suite', 'oauth', '--config', path]);
    expect(r.err).toContain('unknown key "bogus"');
    expect(r.code).toBe(2);
  });

  it('a --config file is read: the registration of the file is the one the run names', async () => {
    const path = join(dir, 'good.json');
    writeFileSync(
      path,
      JSON.stringify({
        registration: { method: 'preregistered', clientId: CLIENT_ID },
        redirectUri: 'http://127.0.0.1:8765/callback',
      }),
    );
    const s = await authFixture({});
    open.push(s);
    const r = await runCli([
      '--url',
      s.url,
      '--suite',
      'oauth',
      '--protocol-version',
      '2026-07-28',
      '--config',
      path,
      '--format',
      'json',
      '--check',
      'oauth-requires-auth',
    ]);
    const report = JSON.parse(r.out) as McpConformanceReport;
    expect(report.matrix).toEqual({ revision: '2026-07-28', registration: 'preregistered' });
  });
});

describe('CLI · mcp conformance · --config help · says what the file may be', () => {
  it('names YAML as well as JSON, as the loader accepts both', () => {
    const conformance = createProgram()
      .commands.find((c) => c.name() === 'mcp')!
      .commands.find((c) => c.name() === 'conformance')!;
    const text = conformance.options.find((o) => o.long === '--config')!.description;
    expect(text).toMatch(/JSON file, or a YAML file/);
    expect(text).toMatch(/\.yaml/);
    expect(text).not.toMatch(/^The oauth suite: a JSON file of/);
  });
});
