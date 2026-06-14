import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Opt-in live suite (AC-9): a real end-to-end `plune run` against a live provider. Default CI skips
// it entirely (dynamic import keeps the SDK/model/native deps out of the skipped run). Run with
// PLUNE_LIVE=1 and a provider API key in the environment.
const LIVE = process.env.PLUNE_LIVE === '1';

describe.skipIf(!LIVE)('orchestrator live (PLUNE_LIVE=1)', () => {
  it('runs a real eval end-to-end → RunResult', async () => {
    const { handleRun } = await import('../../cli/commands/run.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-orch-live-'));
    const cfg = `version: 1
provider:
  type: anthropic
  model: claude-3-5-haiku-latest
evals:
  - id: greet
    prompt: "Say hello to {{name}}."
    dataset:
      examples:
        - vars: { name: World }
    assertions:
      - type: contains
        value: "hello"
        ignore_case: true
`;
    const cfgPath = path.join(dir, 'plune.yaml');
    fs.writeFileSync(cfgPath, cfg);

    const result = await handleRun({ dryRun: false, configPath: cfgPath });
    expect(result.summary.total).toBe(1);
    expect(result.evals[0]!.rows[0]!.output).toBeTruthy();
  });
});
