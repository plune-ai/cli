// plune-ai/cli#49 — `plune run --dry-run` only prices the run, and never goes to the network. It
// still built its provider the way a real run does, and the provider's constructor asks for a key:
// `Missing ANTHROPIC_API_KEY`, exit 2, from a command whose whole point is to cost nothing.
//
// Everything here is the real thing — real deps (no depsFactory), no provider key in the
// environment, no mock provider — because the bug lives exactly where a fake would have stood in.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleRun } from '../run.js';
import { handleReport } from '../report.js';
import { createProgram } from '../../../cli.js';
import { exitCodeFor } from '../../../orchestrator/index.js';
import { PRICE_TABLE } from '../../../providers/prices.js';
import { renderMarkdown } from '../../../reporters/index.js';
import type { RunResult } from '../../../types/results.js';

/** One row, prompt `Tell me about cheese` (20 characters → 5 estimated input tokens), max_tokens 1024. */
function config(provider: string, model: string, extra = ''): string {
  return `version: 1
provider:
  type: ${provider}
  model: ${model}
${extra}evals:
  - id: e1
    prompt: "Tell me about {{topic}}"
    dataset:
      examples:
        - vars: { topic: cheese }
    assertions:
      - type: contains
        value: cheese
`;
}

const INPUT_TOKENS = 5;
const OUTPUT_TOKENS = 1024;

let tmpDir: string;
let cfgPath: string;

function writeConfig(yaml: string): string {
  cfgPath = path.join(tmpDir, 'plune.yaml');
  fs.writeFileSync(cfgPath, yaml);
  return cfgPath;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-dry-run-'));
  // "No key" has to mean no key on a developer's machine too: blank is what the providers call absent.
  for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY']) {
    vi.stubEnv(name, '');
  }
  vi.stubEnv('PLUNE_MOCK_PROVIDER', '');
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('handleRun --dry-run with no provider key', () => {
  it.each([
    ['anthropic', 'claude-3-5-haiku-latest'],
    ['openai', 'gpt-4o-mini'],
  ])('estimates a %s run from the built-in table for %s', async (provider, model) => {
    const price = PRICE_TABLE[model]!;
    const result = await handleRun({
      dryRun: true,
      configPath: writeConfig(config(provider, model)),
    });

    expect(result.summary.errored).toBe(0);
    expect(result.summary.total).toBe(1);
    expect(result.summary.cost_usd).toBeCloseTo(
      (INPUT_TOKENS / 1000) * price.input_per_1k_usd +
        (OUTPUT_TOKENS / 1000) * price.output_per_1k_usd,
      10,
    );
  });

  it('estimates from the config pricing when it names the model', async () => {
    const pricing = `pricing:
  my-model:
    input_per_1k_usd: 1
    output_per_1k_usd: 2
`;
    const result = await handleRun({
      dryRun: true,
      configPath: writeConfig(config('openai', 'my-model', pricing)),
    });

    expect(result.summary.cost_usd).toBeCloseTo(
      (INPUT_TOKENS / 1000) * 1 + (OUTPUT_TOKENS / 1000) * 2,
      10,
    );
  });

  it('prices an eval that overrides the model by the model it overrides to', async () => {
    const yaml = config('openai', 'gpt-4o-mini').replace(
      '  - id: e1\n',
      '  - id: e1\n    provider:\n      model: gpt-4o\n',
    );
    const result = await handleRun({ dryRun: true, configPath: writeConfig(yaml) });

    const price = PRICE_TABLE['gpt-4o']!;
    expect(result.summary.cost_usd).toBeCloseTo(
      (INPUT_TOKENS / 1000) * price.input_per_1k_usd +
        (OUTPUT_TOKENS / 1000) * price.output_per_1k_usd,
      10,
    );
  });

  it('still asks for the key when the run is real', async () => {
    // The guard the dry run stepped around is still there for the run that spends money.
    await expect(
      handleRun({ dryRun: false, configPath: writeConfig(config('openai', 'gpt-4o-mini')) }),
    ).rejects.toThrow(/OPENAI_API_KEY/);
  });
});

// plune-ai/cli#244 — a dry run ran no assertion, and "every assertion of an empty list passed" made
// each row a pass: `1 passed`, `PASS e1`, and that result saved over the last measured run, so
// `plune report` then said `All evals passed.` A dry run gives a price and no verdict, and it is
// not the last run.
describe('handleRun --dry-run gives no verdict and saves nothing', () => {
  const lastRun = (): string => path.join(tmpDir, '.plune', 'last-run.json');

  it('counts no row as passed, failed or errored, and marks the result as a dry run', async () => {
    const result = await handleRun({
      dryRun: true,
      configPath: writeConfig(config('openai', 'gpt-4o-mini')),
    });

    expect(result.dry_run).toBe(true);
    expect(result.summary).toMatchObject({
      total: 1,
      passed: 0,
      failed: 0,
      errored: 0,
      blocked: 0,
      skipped: 1,
    });
    expect(result.evals[0]!.passed).toBe(false);
    expect(result.evals[0]!.rows[0]).toMatchObject({
      output: null,
      assertions: [],
      inconclusive: 'skipped',
    });
    expect(exitCodeFor(result)).toBe(0);
  });

  it('writes no file into a folder with no earlier run', async () => {
    await handleRun({ dryRun: true, configPath: writeConfig(config('openai', 'gpt-4o-mini')) });

    expect(fs.existsSync(lastRun())).toBe(false);
    // Not the saved run and not a cache file either: `.plune` holds nothing.
    const dir = path.dirname(lastRun());
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });

  it('leaves the last measured run byte for byte as it was, and plune report still shows it', async () => {
    const configPath = writeConfig(config('openai', 'gpt-4o-mini'));
    // A measured run on the built-in mock: it answers "mock response", the eval wants "cheese".
    vi.stubEnv('PLUNE_MOCK_PROVIDER', '1');
    const measured = await handleRun({ dryRun: false, configPath });
    vi.stubEnv('PLUNE_MOCK_PROVIDER', '');
    expect(measured.summary).toMatchObject({ passed: 0, failed: 1 });
    const before = fs.readFileSync(lastRun());

    await handleRun({ dryRun: true, configPath });

    expect(fs.readFileSync(lastRun()).equals(before)).toBe(true);
    expect(handleReport({ cwd: tmpDir }).summary).toMatchObject({ passed: 0, failed: 1 });
    expect(renderMarkdown(handleReport({ cwd: tmpDir }))).not.toContain('All evals passed.');
  });
});

describe('plune run --dry-run through the real parser', () => {
  it('exits clean and prints the estimate, with no key anywhere', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array): boolean => {
      stdout.push(typeof c === 'string' ? c : Buffer.from(c).toString());
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array): boolean => {
      stderr.push(typeof c === 'string' ? c : Buffer.from(c).toString());
      return true;
    });
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as (code?: string | number | null | undefined) => never);

    await createProgram().parseAsync([
      'node',
      'plune',
      'run',
      '--dry-run',
      '--config',
      writeConfig(config('anthropic', 'claude-3-5-haiku-latest')),
    ]);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderr.join('')).not.toContain('ANTHROPIC_API_KEY');
    // The price of the real model, not the mock's zero.
    const price = PRICE_TABLE['claude-3-5-haiku-latest']!;
    const cost =
      (INPUT_TOKENS / 1000) * price.input_per_1k_usd +
      (OUTPUT_TOKENS / 1000) * price.output_per_1k_usd;
    expect(stdout.join('')).toContain(`$${cost.toFixed(4)}`);
  });

  // plune-ai/cli#244 — what each format prints for a dry run: a price, and no word of a verdict.
  /** `plune run --dry-run --no-color <args>` on the one-row config: stdout, and the exit code it ended with. */
  async function dryRun(...args: string[]): Promise<{ stdout: string; code: number }> {
    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array): boolean => {
      stdout.push(typeof c === 'string' ? c : Buffer.from(c).toString());
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let exited: number | undefined;
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exited ??= code ?? 0;
    }) as (code?: string | number | null | undefined) => never);
    process.exitCode = undefined;
    await createProgram().parseAsync([
      'node',
      'plune',
      '--no-color',
      'run',
      '--dry-run',
      '--config',
      writeConfig(config('anthropic', 'claude-3-5-haiku-latest')),
      ...args,
    ]);
    const code = exited ?? (process.exitCode as number | undefined) ?? 0;
    process.exitCode = undefined;
    return { stdout: stdout.join(''), code };
  }
  const price = PRICE_TABLE['claude-3-5-haiku-latest']!;
  const COST = (
    (INPUT_TOKENS / 1000) * price.input_per_1k_usd +
    (OUTPUT_TOKENS / 1000) * price.output_per_1k_usd
  ).toFixed(4);

  it('the console says the row was priced, with no verdict, and the exit code is 0', async () => {
    const r = await dryRun();

    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      `Plune dry run\n1 row(s) priced, none measured · estimated $${COST}\n\nPRICED e1\n  1 row(s) priced\n`,
    );
    expect(r.stdout).not.toMatch(/PASS|FAIL|passed|failed|errored/);
  });

  it('--format json marks the dry run and counts the row as neither passed, failed nor errored', async () => {
    const r = await dryRun('--format', 'json');

    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout) as RunResult;
    expect(json.dry_run).toBe(true);
    expect(json.summary).toMatchObject({
      total: 1,
      passed: 0,
      failed: 0,
      errored: 0,
      blocked: 0,
      skipped: 1,
    });
    expect(json.evals.map((ev) => ev.passed)).toEqual([false]);
    expect(json.evals[0]!.rows.map((row) => row.inconclusive)).toEqual(['skipped']);
  });

  it('--format markdown says the row was priced, and never "All evals passed."', async () => {
    const r = await dryRun('--format', 'markdown');

    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      [
        '# Plune dry run',
        '',
        'Nothing was measured: the rows were priced, not run.',
        '',
        '| Metric | Value |',
        '| --- | --- |',
        '| Rows priced | 1 |',
        `| Estimated cost (USD) | ${COST} |`,
        '',
      ].join('\n'),
    );
    expect(r.stdout).not.toMatch(/All evals passed|Passed|Failed|Errored/);
  });
});
