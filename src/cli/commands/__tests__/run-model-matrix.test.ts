// The real buildRealDeps() under the mock provider: a config that lists two models runs every eval on both,
// with no key and no network, and `plune diff` reads the result back cell by cell.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleRun } from '../run.js';
import { renderConsole } from '../../../reporters/console.js';
import { renderMarkdown } from '../../../reporters/markdown.js';
import { diffRuns } from '../../../diff/diff.js';

const CONFIG = (providers: string) => `version: 1
provider:
${providers}
evals:
  - id: greet
    runs: 3
    prompt: "anything"
    dataset:
      examples:
        - vars: {}
    assertions:
      - type: contains
        value: mock
  - id: strict
    prompt: "anything"
    dataset:
      examples:
        - vars: {}
    assertions:
      - type: contains
        value: never-said
`;
const TWO = '  - type: anthropic\n    model: m-a\n  - type: openai\n    model: m-b';
const ONE = '  type: anthropic\n  model: m-a';

describe('CLI · run · model matrix · mock provider through handleRun', () => {
  let dir: string;
  let saved: string | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-matrix-'));
    saved = process.env['PLUNE_MOCK_PROVIDER'];
    process.env['PLUNE_MOCK_PROVIDER'] = '1';
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env['PLUNE_MOCK_PROVIDER'];
    else process.env['PLUNE_MOCK_PROVIDER'] = saved;
  });
  const write = (providers: string) => {
    const f = path.join(dir, 'plune.yaml');
    fs.writeFileSync(f, CONFIG(providers));
    return f;
  };

  it('two models and two evals give four cells, a table in both reports, and a stable diff against itself', async () => {
    const result = await handleRun({ dryRun: false, configPath: write(TWO), noCache: true });
    expect(result.evals.map((e) => e.id)).toEqual(['greet@m-a', 'greet@m-b', 'strict@m-a', 'strict@m-b']);
    expect(renderConsole(result)).toMatch(/greet\s+PASS 3\/3 · \$[\d.]+/);
    expect(renderMarkdown(result)).toContain('| Eval | m-a | m-b |');
    const d = diffRuns(result, result);
    expect(d.summary).toMatchObject({ stablePasses: 2, preExistingFails: 2, regressions: 0 });
  });

  it('a one-element list produces the same ids and config hash as the object form', async () => {
    const asList = await handleRun({ dryRun: false, configPath: write('  - type: anthropic\n    model: m-a'), noCache: true });
    const asObject = await handleRun({ dryRun: false, configPath: write(ONE), noCache: true });
    expect(asList.evals.map((e) => e.id)).toEqual(['greet', 'strict']);
    expect(asList.config_hash).toBe(asObject.config_hash);
    const shape = (r: typeof asList) => r.evals.map((e) => [e.id, e.passed, e.measured, e.rows.map((x) => x.output)]);
    expect(shape(asList)).toEqual(shape(asObject));
  });

  it('warns on stderr about a judge without its own provider, without failing the run', async () => {
    const f = write(TWO);
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('type: contains\n        value: never-said', 'type: llm-judge\n        criteria: polite'));
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await handleRun({ dryRun: true, configPath: f, noCache: true });
      expect(err.mock.calls.map((c) => String(c[0])).join('')).toContain('each model judges its own answer');
    } finally {
      err.mockRestore();
    }
  });
});
