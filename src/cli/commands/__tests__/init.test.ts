import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// The wizard is interactive (covered by wizard.test.ts). Here we simulate it creating plune.yaml
// so initCommand's template-scaffolding behavior can be tested in isolation.
vi.mock('../../../config/init/wizard.js', () => ({
  runInitWizard: vi.fn(),
}));

import * as wizardModule from '../../../config/init/wizard.js';
import { initCommand } from '../init.js';
import { createProgram } from '../../../cli.js';
import { NonTtyError } from '../../../config/errors.js';
import { loadConfig } from '../../../config/loader.js';
import { getAssertion } from '../../../assertions/registry.js';
import type { AssertionKind, DatasetRow } from '../../../types/config.js';

function wizardWritesYaml(cwd: string): void {
  fs.writeFileSync(path.join(cwd, 'plune.yaml'), 'version: 1\n# wizard output\n');
}

let tmp: string;
/** Everything the command wrote, so the closing lines can be read rather than guessed at. */
let printed: string[];
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-init-'));
  vi.clearAllMocks();
  vi.mocked(wizardModule.runInitWizard).mockImplementation(async (cwd: string) => {
    wizardWritesYaml(cwd);
  });
  printed = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
    printed.push(typeof c === 'string' ? c : Buffer.from(c).toString());
    return true;
  });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('initCommand', () => {
  it('ends by naming the next three commands, in order', async () => {
    // It used to end at "Created .env.example." — complete, and a dead end for anyone who does not
    // already know what comes next.
    await initCommand({ cwd: tmp, force: false, yes: true });

    const out = printed.join('');
    const run = out.indexOf('plune run');
    const login = out.indexOf('plune login');
    const sync = out.indexOf('plune sync');
    expect(run).toBeGreaterThan(-1);
    expect(login).toBeGreaterThan(run);
    expect(sync).toBeGreaterThan(login);
  });

  it('says the first step needs no account, because that is the product boundary', async () => {
    // Everything before the cloud commands runs locally, with no account and no network
    // beyond the model provider. Leading with the platform would make the product look like it
    // requires a sign-up it does not.
    await initCommand({ cwd: tmp, force: false, yes: true });
    expect(printed.join('')).toMatch(/no account or platform token needed/i);
  });

  it('names what the first run needs: the provider key, where it goes, and the mock (#246)', async () => {
    // The first run calls the model, so "nothing needed" was untrue: it stopped on a missing key.
    await initCommand({ cwd: tmp, force: false, yes: true });
    const out = printed.join('');
    expect(out).toContain('ANTHROPIC_API_KEY');
    expect(out).toContain('.env.example');
    expect(out).toContain('PLUNE_MOCK_PROVIDER=1');
    // The variable the hint names is one the scaffolded .env.example really holds.
    expect(fs.readFileSync(path.join(tmp, '.env.example'), 'utf8')).toContain('ANTHROPIC_API_KEY=');
  });

  it.each([
    ['openai', 'OPENAI_API_KEY'],
    ['openrouter', 'OPENROUTER_API_KEY'],
  ])('names the key of the provider the wizard wrote: %s (#246)', async (type, keyVar) => {
    vi.mocked(wizardModule.runInitWizard).mockImplementation(async (cwd: string) => {
      fs.writeFileSync(
        path.join(cwd, 'plune.yaml'),
        `version: 1
provider:
  type: ${type}
  model: m
`,
      );
    });
    await initCommand({ cwd: tmp, force: false });
    const out = printed.join('');
    expect(out).toContain(`put ${keyVar} in .env`);
    expect(out).not.toContain('ANTHROPIC_API_KEY');
    expect(fs.readFileSync(path.join(tmp, '.env.example'), 'utf8')).toContain(`${keyVar}=`);
  });

  it('falls back to a general wording when the provider cannot be told', async () => {
    // The mocked wizard's default output has no provider block.
    await initCommand({ cwd: tmp, force: false });
    const out = printed.join('');
    expect(out).toContain("put your provider's key in .env");
    expect(out).not.toContain('ANTHROPIC_API_KEY');
  });

  it('scaffolds an eval that passes when the model gives its own dataset expected answers (#246)', async () => {
    await initCommand({ cwd: tmp, force: false, yes: true });
    const config = await loadConfig({ cwd: tmp, env: {} });
    const rows = fs
      .readFileSync(path.join(tmp, 'datasets', 'example.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as DatasetRow);
    expect(rows.length).toBeGreaterThan(0);
    const assertions = config.evals[0]!.assertions!;
    for (const row of rows) {
      for (const a of assertions) {
        const { type, ...params } = a as { type: AssertionKind } & Record<string, unknown>;
        const ask = (output: string) =>
          getAssertion(type).run({ output, vars: row.vars, row, params });
        // The expected answer, as a model might phrase it, passes; an unrelated answer does not.
        expect((await ask(`It is ${row.expected}.`)).passed).toBe(true);
        expect((await ask('mock response')).passed).toBe(false);
      }
    }
  });

  it('prints the steps after the files, not before them', async () => {
    // The order a person reads it in: what was created, then what to do with it.
    await initCommand({ cwd: tmp, force: false, yes: true });
    const out = printed.join('');
    expect(out.indexOf('.env.example')).toBeLessThan(out.indexOf('Next:'));
  });

  it('runs the wizard then scaffolds the example dataset and .env.example (AC-T03.1)', async () => {
    await initCommand({ cwd: tmp, force: false });
    expect(vi.mocked(wizardModule.runInitWizard)).toHaveBeenCalledWith(tmp);
    expect(fs.existsSync(path.join(tmp, 'plune.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'datasets', 'example.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, '.env.example'))).toBe(true);
  });

  it('writes .env.example with placeholders, never a populated .env (AC-T03.4, NFR-5)', async () => {
    await initCommand({ cwd: tmp, force: false });
    expect(fs.existsSync(path.join(tmp, '.env'))).toBe(false);
    expect(fs.readFileSync(path.join(tmp, '.env.example'), 'utf8')).toContain(
      'YOUR_ANTHROPIC_API_KEY_HERE',
    );
  });

  it('skips an existing template file without --force, leaving it intact (AC-T03.2)', async () => {
    fs.mkdirSync(path.join(tmp, 'datasets'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'datasets', 'example.jsonl'), 'PRE-EXISTING');
    await initCommand({ cwd: tmp, force: false });
    expect(fs.readFileSync(path.join(tmp, 'datasets', 'example.jsonl'), 'utf8')).toBe(
      'PRE-EXISTING',
    );
  });

  it('overwrites existing template files with --force (AC-T03.3)', async () => {
    fs.writeFileSync(path.join(tmp, '.env.example'), 'PRE-EXISTING');
    await initCommand({ cwd: tmp, force: true });
    expect(fs.readFileSync(path.join(tmp, '.env.example'), 'utf8')).not.toBe('PRE-EXISTING');
  });
});

describe('initCommand --yes (non-interactive, T009b)', () => {
  it('skips the wizard and scaffolds a default plune.yaml + templates', async () => {
    await initCommand({ cwd: tmp, force: false, yes: true });
    expect(vi.mocked(wizardModule.runInitWizard)).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmp, 'plune.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'datasets', 'example.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, '.env.example'))).toBe(true);
    // The default config (not the mocked wizard output) was written.
    const yaml = fs.readFileSync(path.join(tmp, 'plune.yaml'), 'utf8');
    expect(yaml).toContain('version: 1');
    expect(yaml).toContain('datasets/example.jsonl');
  });

  it('works without a TTY (the whole point of --yes)', async () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
      writable: true,
    });
    await expect(initCommand({ cwd: tmp, force: false, yes: true })).resolves.toBeUndefined();
    Object.defineProperty(process.stdin, 'isTTY', {
      value: undefined,
      configurable: true,
      writable: true,
    });
  });
});

describe('init command (CLI wiring)', () => {
  it('exits 1 with a message when the terminal is not a TTY (AC-T03.6)', async () => {
    vi.mocked(wizardModule.runInitWizard).mockRejectedValueOnce(new NonTtyError());
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array): boolean => {
      stderr.push(typeof c === 'string' ? c : Buffer.from(c).toString());
      return true;
    });
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as (code?: string | number | null | undefined) => never);

    await createProgram().parseAsync(['node', 'plune', 'init']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderr.join('')).toContain('TTY');
  });
});
