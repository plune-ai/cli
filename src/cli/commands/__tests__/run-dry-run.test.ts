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
import { createProgram } from '../../../cli.js';
import { PRICE_TABLE } from '../../../providers/prices.js';

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
});
