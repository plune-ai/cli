// T003 — the public programmatic API barrel (src/index.ts). Consumers do `import { run } from
// '@plune-ai/cli'`. This must work WITHOUT pulling in commander/dotenv (bundle-level guarantee is
// verified in the e2e bundle-analysis, AC-T06.3); here we verify the runtime contract.

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from '../index.js';
import { loadDataset, type RunDeps } from '../orchestrator/index.js';
import type { Config } from '../types/config.js';
import type { Provider } from '../types/provider.js';

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

// Injected fake deps so the public-API contract test never touches network/disk caches.
function fakeDeps(): (c: Config, baseDir: string) => RunDeps {
  return (_c, baseDir) => ({
    resolveProvider: (): Provider => ({
      complete: vi.fn(async () => ({ output: 'hi', usage: { input_tokens: 1, output_tokens: 1 } })),
      estimateCost: () => ({ cost_usd: 0 }),
    }),
    embedder: { embed: async (t) => t.map(() => Float32Array.from([1, 0, 0])) },
    cache: { get: () => undefined, set: () => {}, clear: () => {}, close: () => {} },
    now: () => 1000,
    loadDataset,
    baseDir,
  });
}

describe('public API barrel (src/index.ts)', () => {
  it('exports run() as a function (AC-T06.1)', () => {
    expect(typeof run).toBe('function');
  });

  it('run() executes a config and returns a RunResult (AC-T06.2)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-pub-'));
    try {
      const cfg = path.join(tmp, 'plune.yaml');
      fs.writeFileSync(cfg, CONFIG);
      const result = await run({ dryRun: false, configPath: cfg }, fakeDeps());
      expect(result.schemaVersion).toBe(1);
      expect(result.summary).toMatchObject({ total: 1, passed: 1 });
      expect(Array.isArray(result.evals)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
