// T008 — PLUNE_MOCK_PROVIDER=1 makes the real buildRealDeps() resolve a deterministic mock
// provider instead of a network-backed one (ADR-S10-04). This is what lets the e2e suite run a
// real binary end-to-end with no API key and no HTTP.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleRun, isMockMode } from '../run.js';

const CONFIG = `version: 1
provider:
  type: anthropic
  model: m
evals:
  - id: e1
    prompt: "anything"
    dataset:
      examples:
        - vars: {}
    assertions:
      - type: contains
        value: mock
`;

describe('isMockMode', () => {
  it('is true only when PLUNE_MOCK_PROVIDER === "1"', () => {
    expect(isMockMode({ PLUNE_MOCK_PROVIDER: '1' })).toBe(true);
    expect(isMockMode({ PLUNE_MOCK_PROVIDER: '0' })).toBe(false);
    expect(isMockMode({})).toBe(false);
  });
});

describe('handleRun with PLUNE_MOCK_PROVIDER=1 (real deps, no network/key)', () => {
  let tmpDir: string;
  let saved: string | undefined;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-mock-'));
    saved = process.env['PLUNE_MOCK_PROVIDER'];
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (saved === undefined) delete process.env['PLUNE_MOCK_PROVIDER'];
    else process.env['PLUNE_MOCK_PROVIDER'] = saved;
  });

  it('produces the deterministic mock output with no provider key (AC-T07.3)', async () => {
    process.env['PLUNE_MOCK_PROVIDER'] = '1';
    const cfg = path.join(tmpDir, 'plune.yaml');
    fs.writeFileSync(cfg, CONFIG);

    // No depsFactory → exercises the REAL buildRealDeps() mock interception.
    const result = await handleRun({ dryRun: false, configPath: cfg });

    expect(result.summary.errored).toBe(0);
    expect(result.evals[0]!.rows[0]!.output).toBe('mock response');
    expect(result.evals[0]!.passed).toBe(true);
  });
});
