// A tool-call assertion reads the transcript of an eval with `mcp`; anywhere else it could only ever be unmeasured,
// so the config is refused before any provider is built or any model called.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pluneConfigSchema } from '../schema.js';
import { ConfigValidationError } from '../errors.js';
import { handleRun } from '../../cli/commands/run.js';
import { createProgram } from '../../cli.js';
import type { RunDeps } from '../../orchestrator/index.js';

const base = {
  version: 1,
  provider: { type: 'anthropic', model: 'm' },
  mcp: { servers: { fx: { command: 'node' } } },
};
const plainEval = (assertions: unknown[]) => ({
  id: 'plain',
  prompt: 'p',
  dataset: { examples: [{ vars: {} }] },
  assertions,
});

const issues = (config: unknown): string[] => {
  const r = pluneConfigSchema.safeParse(config);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('CLI · config · tool-call assertions', () => {
  it('CLI · config · tool-call assertions · accepted on an eval with mcp, refused on one without (AC-9)', () => {
    const agentic = {
      ...plainEval([{ type: 'tool-called', tool: 'echo' }]),
      id: 'agentic',
      mcp: { server: 'fx' },
    };
    expect(issues({ ...base, evals: [agentic] })).toEqual([]);
    expect(issues({ ...base, evals: [plainEval([{ type: 'contains', value: 'x' }])] })).toEqual([]);
    expect(
      issues({
        ...base,
        evals: [
          agentic,
          plainEval([
            { type: 'contains', value: 'x' },
            { type: 'tool-called', tool: 'echo' },
          ]),
        ],
      }),
    ).toEqual([
      'evals.1.assertions.1.type: "tool-called" reads the tool calls of an eval with mcp, and eval "plain" has no mcp block',
    ]);
  });

  it('CLI · config · tool-call assertions · one in defaults.assertions is refused for each eval without mcp (AC-9)', () => {
    const agentic = { ...plainEval([]), id: 'agentic', mcp: { server: 'fx' } };
    expect(
      issues({
        ...base,
        defaults: { assertions: [{ type: 'no-tool-errors' }] },
        evals: [agentic, plainEval([])],
      }),
    ).toEqual([
      'defaults.assertions.0.type: "no-tool-errors" reads the tool calls of an eval with mcp, and eval "plain" has no mcp block',
    ]);
  });
});

describe('CLI · config · tool-call assertions · plune run', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-tool-assert-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const yaml = `version: 1
provider: { type: anthropic, model: m }
evals:
  - id: plain
    prompt: hi
    dataset: { examples: [ { vars: {} } ] }
    assertions:
      - type: tool-not-called
        tool: delete
`;

  it('CLI · config · tool-call assertions · plune run stops with exit 2 before any provider or model call (AC-9)', async () => {
    const cfg = path.join(dir, 'plune.yaml');
    fs.writeFileSync(cfg, yaml);
    const resolveProvider = vi.fn();
    const factory = vi.fn((): RunDeps => ({ resolveProvider }) as unknown as RunDeps);
    const err = await handleRun({ dryRun: false, configPath: cfg }, factory).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigValidationError);
    expect(factory).not.toHaveBeenCalled();
    expect(resolveProvider).not.toHaveBeenCalled();

    const stderr: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      stderr.push(String(c));
      return true;
    });
    let code: number | undefined;
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
      code ??= c ?? 0;
    }) as (c?: string | number | null) => never);
    process.exitCode = undefined;
    await createProgram().parseAsync(['node', 'plune', 'run', '--config', cfg]);
    code ??= process.exitCode as number | undefined;
    process.exitCode = undefined;
    expect(code).toBe(2);
    expect(stderr.join('')).toMatch(
      /evals\.0\.assertions\.0\.type: "tool-not-called" reads the tool calls/,
    );
  });
});
