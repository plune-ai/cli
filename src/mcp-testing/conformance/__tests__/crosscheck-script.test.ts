// The guards of scripts/conformance-crosscheck.mjs that keep third-party code away from the repository and from the
// user's secrets. The script itself installs packages and is not run here.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error a plain .mjs script, without types
import {
  exactRevision,
  exactVersion,
  folderProblem,
  minimalEnv,
  plan,
} from '../../../../scripts/conformance-crosscheck.mjs';

const repo = resolve(__dirname, '../../../..');
const fresh = () => mkdtempSync(join(tmpdir(), 'plune-crosscheck-'));

describe('CLI · mcp conformance · the cross-check script keeps the third-party run apart', () => {
  it('a child gets PATH and the folders npm needs, and none of the secrets of the caller', () => {
    const env = minimalEnv(
      {
        Path: 'p',
        HOME: 'h',
        API_TOKEN: 'secret-1',
        ANTHROPIC_API_KEY: 'secret-2',
        npm_config_token: 'secret-3',
      },
      { PORT: '1' },
    );
    expect(env).toEqual({ Path: 'p', HOME: 'h', PORT: '1' });
  });

  it('a version is accepted only exact: a range, a tag or a path is refused', () => {
    expect(exactVersion('0.1.16')).toBe(true);
    for (const v of ['^0.1.16', 'latest', '0.1', '1.2.3-alpha', '../x', '1.2.3 && x'])
      expect(exactVersion(v), v).toBe(false);
  });

  it('no process starts in the folder of the third-party packages, both sides check one revision, every checks.json is kept', () => {
    const dir = fresh();
    type Step = { cmd: string; args: string[]; cwd: string };
    const p = plan(dir, {
      cli: ['plune'],
      node: 'node',
      url: 'http://127.0.0.1:3001/mcp',
      revision: '2025-11-25',
      conformance: '0.1.16',
      everything: '2.3.0',
    }) as Record<string, Step> & { packages: string; work: string };
    const steps = ['install', 'server', 'ours', 'list', 'official'].map((k) => p[k] as Step);
    for (const s of steps) {
      const inside = relative(p.packages, s.cwd);
      expect(inside === '' || !inside.startsWith('..'), s.cwd).toBe(false);
      expect(s.cwd).toBe(p.work);
    }
    const after = (s: Step, flag: string) => s.args[s.args.indexOf(flag) + 1];
    expect(after(p['ours'] as Step, '--protocol-version')).toBe('2025-11-25');
    expect(after(p['official'] as Step, '--spec-version')).toBe('2025-11-25');
    expect(after(p['official'] as Step, '-o')).toBe(join(dir, 'official'));
    expect(after(p['install'] as Step, '--prefix')).toBe(p.packages);
    expect(exactRevision('2025-11-25')).toBe(true);
    for (const v of ['latest', '2025-11', '2025-11-25; x']) expect(exactRevision(v), v).toBe(false);
  });

  it('a folder in the repository, one that does not exist yet inside it, or one that is not empty is refused', () => {
    expect(folderProblem(join(repo, 'new-folder'), repo)).toContain('in the repository');
    expect(folderProblem(repo, repo)).toContain('in the repository');
    const full = fresh();
    writeFileSync(join(full, 'a'), '');
    expect(folderProblem(full, repo)).toContain('not empty');
    const empty = fresh();
    expect(folderProblem(empty, repo)).toBeUndefined();
    expect(folderProblem(join(empty, 'not', 'yet'), repo)).toBeUndefined();
  });
});
