import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleRun } from '../run.js';
import { createProgram } from '../../../cli.js';
import { loadDataset, type RunDeps } from '../../../orchestrator/index.js';
import type { Config } from '../../../types/config.js';
import type { Provider } from '../../../types/provider.js';

const CONFIG = `version: 1
provider:
  type: anthropic
  model: m
evals:
  - id: e1
    prompt: "Q: {{q}}"
    dataset:
      examples:
        - vars: { q: hi }
          expected: hi
    assertions:
      - type: exact-match
        value: hi
`;

function fakeProvider(output = 'hi'): Provider {
  return {
    complete: vi.fn(async () => ({ output, usage: { input_tokens: 1, output_tokens: 1 } })),
    estimateCost: () => ({ cost_usd: 0.01 }),
  };
}

// depsFactory that ignores real I/O — fake provider/cache/embedder, fixed clock, real loadDataset.
function fakeDepsFactory(): (config: Config, baseDir: string) => RunDeps {
  return (_config, baseDir) => ({
    resolveProvider: () => fakeProvider('hi'),
    embedder: { embed: async (t) => t.map(() => Float32Array.from([1, 0, 0])) },
    cache: { get: () => undefined, set: () => {}, clear: () => {}, close: () => {} },
    now: () => 1000,
    loadDataset,
    baseDir,
  });
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-run-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('handleRun (orchestrator wired)', () => {
  it('runs a config end-to-end and persists the RunResult (AC-12)', async () => {
    const cfgPath = path.join(tmpDir, 'plune.yaml');
    fs.writeFileSync(cfgPath, CONFIG);

    const result = await handleRun({ dryRun: false, configPath: cfgPath }, fakeDepsFactory());

    expect(result.schema).toBe(1);
    expect(result.summary).toMatchObject({ total: 1, passed: 1, failed: 0, errored: 0 });
    expect(result.evals[0]!.passed).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.plune', 'last-run.json'))).toBe(true);
  });

  it('dry-run estimates without calling the provider', async () => {
    const cfgPath = path.join(tmpDir, 'plune.yaml');
    fs.writeFileSync(cfgPath, CONFIG);
    const provider = fakeProvider('hi');
    const result = await handleRun({ dryRun: true, configPath: cfgPath }, (_c, baseDir) => ({
      resolveProvider: () => provider,
      embedder: { embed: async (t) => t.map(() => Float32Array.from([1, 0, 0])) },
      cache: { get: () => undefined, set: () => {}, clear: () => {}, close: () => {} },
      now: () => 1000,
      loadDataset,
      baseDir,
    }));
    expect(provider.complete).not.toHaveBeenCalled();
    expect(result.summary.total).toBe(1);
  });
});

describe('run command — config errors (exit 2)', () => {
  it('exits 2 when the --config file is missing', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as (code?: string | number | null | undefined) => never);
    await createProgram().parseAsync(['node', 'plune', 'run', '--config', path.join(tmpDir, 'missing.yaml')]);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('exits 2 on an invalid config', async () => {
    const cfgPath = path.join(tmpDir, 'bad.yaml');
    fs.writeFileSync(cfgPath, 'version: 1\nprovider:\n  type: unknown\n  model: ""\nevals: []\n');
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      stderr.push(typeof c === 'string' ? c : Buffer.from(c).toString());
      return true;
    });
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as (code?: string | number | null | undefined) => never);
    await createProgram().parseAsync(['node', 'plune', 'run', '--config', cfgPath]);
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(stderr.join('')).toContain('provider.type');
  });

  it('exits 2 on an unknown prompt variable (review fix: config error, not 1)', async () => {
    const cfgPath = path.join(tmpDir, 'badvar.yaml');
    fs.writeFileSync(
      cfgPath,
      'version: 1\nprovider:\n  type: anthropic\n  model: m\nevals:\n  - id: e1\n    prompt: "Hi {{nope}}"\n    dataset:\n      examples:\n        - vars: { q: hi }\n    assertions:\n      - type: exact-match\n        value: hi\n',
    );
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as (code?: string | number | null | undefined) => never);
    await createProgram().parseAsync(['node', 'plune', 'run', '--config', cfgPath]);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});
