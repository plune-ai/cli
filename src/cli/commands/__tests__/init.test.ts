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

function wizardWritesYaml(cwd: string): void {
  fs.writeFileSync(path.join(cwd, 'plune.yaml'), 'version: 1\n# wizard output\n');
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-init-'));
  vi.clearAllMocks();
  vi.mocked(wizardModule.runInitWizard).mockImplementation(async (cwd: string) => {
    wizardWritesYaml(cwd);
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('initCommand', () => {
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
    expect(fs.readFileSync(path.join(tmp, 'datasets', 'example.jsonl'), 'utf8')).toBe('PRE-EXISTING');
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
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true, writable: true });
    await expect(initCommand({ cwd: tmp, force: false, yes: true })).resolves.toBeUndefined();
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true, writable: true });
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
