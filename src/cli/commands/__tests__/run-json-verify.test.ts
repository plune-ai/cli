// A `json-verify` check through a whole run: the config is read from YAML, the model is a fake that answers by
// the question, and the exit code is the one `plune run` sets from the result.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleRun } from '../run.js';
import { ConfigValidationError } from '../../../config/errors.js';
import { exitCodeFor, loadDataset, type RunDeps } from '../../../orchestrator/index.js';
import type { Config } from '../../../types/config.js';

const config = (questions: string[], email = String.raw`@matchesRegex("^[^@ ]+@plune\.ai$")`): string => `version: 1
provider:
  type: anthropic
  model: m
evals:
  - id: profile
    prompt: "{{q}}"
    dataset:
      examples:
${questions.map((q) => `        - vars: { q: ${q} }`).join('\n')}
    assertions:
      - type: json-verify
        mode: contains
        expected:
          name: John Doe
          email: '${email}'
          roles: [admin]
`;

const ANSWERS: Record<string, string> = {
  good: 'Here it is:\n```json\n{"id": 7, "name": "John Doe", "email": "user@plune.ai", "roles": ["editor", "admin"]}\n```',
  bad: '{"name": "John Doe", "email": "user at plune.ai", "roles": ["editor"]}',
};

const complete = vi.fn(async (req: { prompt_resolved: string }) => ({
  output: ANSWERS[req.prompt_resolved]!,
  usage: { input_tokens: 1, output_tokens: 1 },
}));

const deps = (_config: Config, baseDir: string): RunDeps => ({
  resolveProvider: () => ({ complete, estimateCost: () => ({ cost_usd: 0 }) }),
  embedder: { embed: async (t) => t.map(() => Float32Array.from([1, 0, 0])) },
  cache: { get: () => undefined, set: () => {}, clear: () => {}, close: () => {} },
  now: () => 1000,
  loadDataset,
  baseDir,
});

let tmpDir: string;
const run = (yaml: string) => {
  const configPath = path.join(tmpDir, 'plune.yaml');
  fs.writeFileSync(configPath, yaml);
  return handleRun({ dryRun: false, configPath }, deps);
};
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-json-verify-'));
  complete.mockClear();
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CLI · run · json-verify in a run', () => {
  it('contains with a regex check passes on one answer and fails on another, and the run exits 1', async () => {
    const result = await run(config(['good', 'bad']));
    expect(result.summary).toMatchObject({ total: 2, passed: 1, failed: 1, errored: 0 });
    const [good, bad] = result.evals[0]!.rows;
    expect(good!.assertions).toEqual([{ type: 'json-verify', passed: true }]);
    expect(bad!.assertions).toEqual([
      {
        type: 'json-verify',
        passed: false,
        reason: [
          '2 mismatches',
          String.raw`    $.email: function not satisfied: @matchesRegex("^[^@ ]+@plune\.ai$")`,
          String.raw`      expected: "@matchesRegex(\"^[^@ ]+@plune\\.ai$\")"`,
          '      actual:   "user at plune.ai"',
          '    $.roles[0]: no match for an array element',
          '      expected: "admin"',
        ].join('\n'),
      },
    ]);
    expect(exitCodeFor(result)).toBe(1);
  });

  it('the run exits 0 when every answer matches', async () => {
    const result = await run(config(['good']));
    expect(result.summary).toMatchObject({ total: 1, passed: 1, failed: 0 });
    expect(exitCodeFor(result)).toBe(0);
  });

  it('an unknown check function stops the run as a config error before any model call', async () => {
    const err = await run(config(['good'], '@matchesRegexp("x")')).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigValidationError);
    expect((err as ConfigValidationError).issues.join('\n')).toMatch(
      /evals\.0\.assertions\.0\.expected: \$\.email: @matchesRegexp is not a check function \(known: /,
    );
    expect(complete).not.toHaveBeenCalled();
  });
});
