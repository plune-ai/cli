import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('@clack/prompts');

import * as clack from '@clack/prompts';
import { runInitWizard } from '../../init/wizard.js';
import { NonTtyError } from '../../errors.js';

const CANCEL_SYMBOL = Symbol('clack-cancel');

function setupDefaultMocks() {
  vi.mocked(clack.intro).mockImplementation(() => undefined);
  vi.mocked(clack.outro).mockImplementation(() => undefined);
  vi.mocked(clack.cancel).mockImplementation(() => undefined);
  vi.mocked(clack.isCancel).mockReturnValue(false);
  vi.mocked(clack.spinner).mockReturnValue({
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as ReturnType<typeof clack.spinner>);
  vi.mocked(clack.select).mockResolvedValue('anthropic');
  vi.mocked(clack.text)
    .mockResolvedValueOnce('claude-3-opus')  // model
    .mockResolvedValueOnce('data/evals.jsonl');  // dataset
  vi.mocked(clack.confirm).mockResolvedValue(true);
}

let tmpDir: string;
let exitSpy: MockInstance<[code?: string | number | null | undefined], never>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-wizard-'));
  exitSpy = vi
    .spyOn(process, 'exit')
    .mockImplementation((() => {}) as (code?: string | number | null | undefined) => never);
  // Simulate a TTY so the isTTY guard doesn't fire in tests
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true, writable: true });
  setupDefaultMocks();
});

afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true, writable: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetAllMocks();    // clears unconsumed mockResolvedValueOnce queues
  vi.restoreAllMocks();  // restores process.exit spy to original
});

describe('runInitWizard', () => {
  it('writes a valid plune.yaml when no existing file', async () => {
    await runInitWizard(tmpDir);

    const filePath = path.join(tmpDir, 'plune.yaml');
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('version: 1');
    expect(content).toContain('anthropic');
    expect(content).toContain('claude-3-opus');
    expect(content).toContain('data/evals.jsonl');
  });

  it('calls intro and outro', async () => {
    await runInitWizard(tmpDir);
    expect(vi.mocked(clack.intro)).toHaveBeenCalledOnce();
    expect(vi.mocked(clack.outro)).toHaveBeenCalledOnce();
  });

  it('writes explanatory comments into plune.yaml (AC-T03.5)', async () => {
    await runInitWizard(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, 'plune.yaml'), 'utf8');
    // At least one comment line explaining a field, plus the data itself.
    expect(content).toMatch(/^#/m);
    expect(content).toContain('provider');
    expect(content).toContain('version: 1');
  });

  describe('file already exists', () => {
    beforeEach(() => {
      const existing = path.join(tmpDir, 'plune.yaml');
      fs.writeFileSync(existing, 'version: 1\n# old content');
    });

    it('asks for confirm before overwriting', async () => {
      vi.mocked(clack.confirm).mockResolvedValue(true);
      await runInitWizard(tmpDir);
      expect(vi.mocked(clack.confirm)).toHaveBeenCalledOnce();
    });

    it('does not overwrite when user declines', async () => {
      vi.mocked(clack.confirm).mockResolvedValue(false);
      await runInitWizard(tmpDir);
      const content = fs.readFileSync(path.join(tmpDir, 'plune.yaml'), 'utf8');
      expect(content).toContain('# old content');
    });

    it('overwrites when user confirms', async () => {
      vi.mocked(clack.confirm).mockResolvedValue(true);
      await runInitWizard(tmpDir);
      const content = fs.readFileSync(path.join(tmpDir, 'plune.yaml'), 'utf8');
      expect(content).not.toContain('# old content');
      expect(content).toContain('version: 1');
    });
  });

  describe('Ctrl+C (cancel) handling', () => {
    it('exits gracefully when provider select is cancelled', async () => {
      vi.mocked(clack.select).mockResolvedValue(CANCEL_SYMBOL as unknown as string);
      vi.mocked(clack.isCancel).mockReturnValue(true);

      await runInitWizard(tmpDir);

      expect(vi.mocked(clack.cancel)).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('does not write plune.yaml when cancelled', async () => {
      vi.mocked(clack.select).mockResolvedValue(CANCEL_SYMBOL as unknown as string);
      vi.mocked(clack.isCancel).mockReturnValue(true);

      await runInitWizard(tmpDir);

      expect(fs.existsSync(path.join(tmpDir, 'plune.yaml'))).toBe(false);
    });
  });

  describe('branch coverage (inherited TB-2)', () => {
    it('throws NonTtyError when stdin is not a TTY', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: false,
        configurable: true,
        writable: true,
      });
      await expect(runInitWizard(tmpDir)).rejects.toBeInstanceOf(NonTtyError);
      expect(fs.existsSync(path.join(tmpDir, 'plune.yaml'))).toBe(false);
    });

    it('uses the gpt default branch when openai is chosen', async () => {
      vi.mocked(clack.select).mockResolvedValue('openai');
      await runInitWizard(tmpDir);
      expect(fs.readFileSync(path.join(tmpDir, 'plune.yaml'), 'utf8')).toContain('openai');
    });

    it('exits when the model prompt is cancelled', async () => {
      vi.mocked(clack.isCancel).mockImplementation((v): v is symbol => v === CANCEL_SYMBOL);
      vi.mocked(clack.text).mockReset();
      vi.mocked(clack.text).mockResolvedValueOnce(CANCEL_SYMBOL as unknown as string);
      await runInitWizard(tmpDir);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(fs.existsSync(path.join(tmpDir, 'plune.yaml'))).toBe(false);
    });

    it('exits when the dataset prompt is cancelled', async () => {
      vi.mocked(clack.isCancel).mockImplementation((v): v is symbol => v === CANCEL_SYMBOL);
      vi.mocked(clack.text).mockReset();
      vi.mocked(clack.text)
        .mockResolvedValueOnce('claude-3-opus')
        .mockResolvedValueOnce(CANCEL_SYMBOL as unknown as string);
      await runInitWizard(tmpDir);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(fs.existsSync(path.join(tmpDir, 'plune.yaml'))).toBe(false);
    });

    it('exits when the overwrite confirm is cancelled', async () => {
      fs.writeFileSync(path.join(tmpDir, 'plune.yaml'), 'version: 1\n# keep me');
      vi.mocked(clack.isCancel).mockImplementation((v): v is symbol => v === CANCEL_SYMBOL);
      vi.mocked(clack.confirm).mockResolvedValue(CANCEL_SYMBOL as unknown as boolean);
      await runInitWizard(tmpDir);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(fs.readFileSync(path.join(tmpDir, 'plune.yaml'), 'utf8')).toContain('# keep me');
    });
  });
});
