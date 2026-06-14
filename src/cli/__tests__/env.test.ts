import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadEnv } from '../env.js';

// loadEnv mutates process.env — snapshot/restore the keys we touch so tests stay isolated.
const TOUCHED = ['PLUNE_TEST_FRESH_KEY', 'PLUNE_TEST_EXISTING_KEY'];
const saved: Record<string, string | undefined> = {};

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-env-'));
  for (const k of TOUCHED) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('loadEnv', () => {
  it('loads variables from <configDir>/.env into process.env (AC-T02.1)', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'PLUNE_TEST_FRESH_KEY=from_dotenv\n');
    loadEnv(tmpDir);
    expect(process.env['PLUNE_TEST_FRESH_KEY']).toBe('from_dotenv');
  });

  it('does NOT override an already-set process.env variable (AC-T02.2)', () => {
    process.env['PLUNE_TEST_EXISTING_KEY'] = 'preset';
    fs.writeFileSync(path.join(tmpDir, '.env'), 'PLUNE_TEST_EXISTING_KEY=from_dotenv\n');
    loadEnv(tmpDir);
    expect(process.env['PLUNE_TEST_EXISTING_KEY']).toBe('preset');
  });

  it('does not throw when .env is absent (AC-T02.3)', () => {
    expect(() => loadEnv(tmpDir)).not.toThrow();
  });
});
