// `plune run` with an `mcp` block: what the command does with it before any MCP server or model is involved. The
// spawn and fetch of this process are watched, so a dry run that starts a server or opens a connection fails here.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnCalls } = vi.hoisted(() => ({ spawnCalls: [] as string[] }));

// Every way a child process starts, counted and then passed on.
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  const watch = <F extends (...args: never[]) => unknown>(name: string, fn: F): F =>
    ((...args: never[]) => {
      spawnCalls.push(name);
      return fn(...args);
    }) as F;
  return {
    ...real,
    default: real,
    spawn: watch('spawn', real.spawn),
    spawnSync: watch('spawnSync', real.spawnSync),
    exec: watch('exec', real.exec),
    execFile: watch('execFile', real.execFile),
    execFileSync: watch('execFileSync', real.execFileSync),
    execSync: watch('execSync', real.execSync),
    fork: watch('fork', real.fork),
  };
});

import { handleRun } from '../../cli/commands/run.js';
import { createProgram } from '../../cli.js';
import { ConfigValidationError } from '../errors.js';
import type { RunDeps } from '../../orchestrator/index.js';

let dir: string;
let cfgPath: string;
let fetchSpy: ReturnType<typeof vi.fn>;

const config = (mcp: string, evalMcp = '    mcp: { server: everything }\n'): string => `version: 1
provider:
  type: anthropic
  model: claude-3-5-haiku-latest
${mcp}evals:
  - id: agent-eval
    prompt: "Tell me about {{topic}}"
    dataset:
      examples:
        - vars: { topic: cheese }
    assertions:
      - type: contains
        value: cheese
${evalMcp}`;

const stdioServer = (env = ''): string => `mcp:
  servers:
    everything:
      command: npx
      args: ["-y", "@modelcontextprotocol/server-everything"]
${env}`;

function write(yaml: string): string {
  cfgPath = path.join(dir, 'plune.yaml');
  fs.writeFileSync(cfgPath, yaml);
  return cfgPath;
}

interface Outcome {
  stdout: string;
  stderr: string;
  /** The code `process.exit` was called with, or `process.exitCode` when it was not. */
  code: number | undefined;
}

async function plune(...args: string[]): Promise<Outcome> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const text = (c: string | Uint8Array) => (typeof c === 'string' ? c : Buffer.from(c).toString());
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
    stdout.push(text(c));
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
    stderr.push(text(c));
    return true;
  });
  let exited: number | undefined;
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exited ??= code ?? 0;
  }) as (code?: string | number | null | undefined) => never);
  process.exitCode = undefined;
  try {
    await createProgram().parseAsync(['node', 'plune', 'run', ...args]);
  } finally {
    out.mockRestore();
    err.mockRestore();
    exit.mockRestore();
  }
  const code = exited ?? (process.exitCode as number | undefined);
  process.exitCode = undefined;
  return { stdout: stdout.join(''), stderr: stderr.join(''), code };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-mcp-run-'));
  for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'])
    vi.stubEnv(name, '');
  vi.stubEnv('PLUNE_MOCK_PROVIDER', '');
  spawnCalls.length = 0;
  fetchSpy = vi.fn(() => Promise.reject(new Error('no network in this test')));
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CLI · config · mcp block · plune run', () => {
  it('CLI · config · mcp block · run --dry-run checks the block and starts no process and opens no connection (AC-9)', async () => {
    const r = await plune('--dry-run', '--config', write(config(stdioServer())));
    // The one line a dry run of an agentic eval prints: what its estimate leaves out. No warning.
    expect(r.stderr).toMatch(/^dry run: .*tool schemas and tool results are not counted\n$/);
    expect(r.code ?? 0).toBe(0);
    expect(spawnCalls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('CLI · config · mcp block · an eval naming a server that does not exist stops with exit 2 before any model call (AC-3)', async () => {
    const yaml = config(stdioServer(), '    mcp: { server: evrything }\n');
    const resolveProvider = vi.fn();
    const factory = vi.fn((): RunDeps => ({ resolveProvider }) as unknown as RunDeps);
    const err = await handleRun({ dryRun: false, configPath: write(yaml) }, factory).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigValidationError);
    expect(factory).not.toHaveBeenCalled();
    expect(resolveProvider).not.toHaveBeenCalled();

    const r = await plune('--dry-run', '--config', write(yaml));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/evals\.0\.mcp\.server: .*"agent-eval".*"evrything"/);
  });

  it('CLI · config · mcp block · an unset ${VAR} is exit 2 that names it; a set value reaches neither the error, last-run.json nor --format json (AC-6)', async () => {
    const secret = 'sk-live-run-secret-0123456789';
    vi.stubEnv('MCP_RUN_TOKEN', secret);
    // The value is really set: "not in the output" would prove nothing otherwise.
    expect(process.env['MCP_RUN_TOKEN']).toBe(secret);
    const yaml = config(
      stdioServer(
        '      env:\n        API_TOKEN: "${MCP_RUN_TOKEN}"\n        OTHER: "${MCP_RUN_TOKEN}-${MCP_RUN_MISSING}"\n',
      ),
    );

    const failed = await plune('--dry-run', '--format', 'json', '--config', write(yaml));
    expect(failed.code).toBe(2);
    expect(failed.stderr).toMatch(/mcp\.servers\.everything\.env\.OTHER: .*MCP_RUN_MISSING/);
    expect(failed.stderr + failed.stdout).not.toContain(secret);

    vi.stubEnv('MCP_RUN_MISSING', 'present');
    const ok = await plune('--dry-run', '--format', 'json', '--config', write(yaml));
    expect(ok.code ?? 0).toBe(0);
    expect(JSON.parse(ok.stdout)).toHaveProperty('config_hash');
    expect(ok.stdout + ok.stderr).not.toContain(secret);
    expect(fs.readFileSync(path.join(dir, '.plune', 'last-run.json'), 'utf8')).not.toContain(
      secret,
    );
  });

  it('CLI · config · mcp block · config_hash is the same for two values of one ${VAR} (AC-7)', async () => {
    const yaml = write(config(stdioServer('      env:\n        API_TOKEN: "${MCP_HASH_TOKEN}"\n')));
    vi.stubEnv('MCP_HASH_TOKEN', 'first-value-aaaaaaaa');
    const first = await handleRun({ dryRun: true, configPath: yaml });
    vi.stubEnv('MCP_HASH_TOKEN', 'second-value-bbbbbbbb');
    const second = await handleRun({ dryRun: true, configPath: yaml });
    expect(first.config_hash).toBe(second.config_hash);
  });

  it('CLI · config · mcp block · a literal Authorization header is a warning on stderr and leaves the exit code alone (AC-8)', async () => {
    const remote = (headers: string) => `mcp:
  servers:
    everything:
      url: https://example.com/mcp
${headers}`;
    const quiet = await plune('--dry-run', '--config', write(config(remote(''))));
    const loud = await plune(
      '--dry-run',
      '--config',
      write(
        config(remote('      headers:\n        Authorization: "Bearer literal-token-in-file"\n')),
      ),
    );
    expect(quiet.stderr).not.toMatch(/warning/);
    expect(loud.stderr).toMatch(/warning: .*mcp\.servers\.everything\.headers\.Authorization/);
    expect(loud.stderr).not.toContain('literal-token-in-file');
    expect(loud.code).toBe(quiet.code);
    expect(spawnCalls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
